/**
 * 女优新作监视（全库版）
 * ============================================================
 * 旧版只查「已关注（followed=1）」的女优，覆盖面太小。
 * 现在遍历**全部女优**，找出「最近一个月（默认 30 天）」的新作，落成通知。
 *
 * ★ 数据源的选择（踩过的坑，别改回去）：
 *   - javdb 的 `/search?q=女优名` 只有 番号/标题/封面，**没有发行日期**，
 *     标题里也不带日期 → 做不了「近一月」时间线，全部会变成「日期未知」。
 *   - javbus 的 `/star/{starId}` 每个条目都带真实发行日期（YYYY-MM-DD），
 *     而且默认按日期倒序 → 这才是新作监视该用的源。
 *   所以：主源 javbus，javdb 只作为 javbus 找不到 starId 时的兜底。
 *
 * 遍历策略：
 *   全库 1700+ 位女优，一人一次请求要跑很久。所以每轮只扫一个**分片**
 *   （ACTORS_PER_RUN 位），用 `cursor` 记住进度，下次接着往下扫，到尾回头。
 *
 * 幂等：同一位女优 + 同一个番号，只落一条通知。
 */

const {
    getActressesForMonitor,
    addNotification,
    getAllNotifications,
    pruneNotifications,
    getActressById,
} = require('./db');
const { searchJavBusByActress } = require('./crawler/javbus');
const { downloadPoster, getPosterCacheName } = require('./poster-fetcher');
const config = require('./config');
const path = require('path');
const fs = require('fs');

// ============ 可调参数 ============
const WINDOW_DAYS = Number(config.newRelease?.windowDays || 30);          // 「最近一个月」
const ACTORS_PER_RUN = Number(config.newRelease?.actressesPerRun || 60);  // 每轮扫多少位
const PAGES_PER_ACTOR = Number(config.newRelease?.pages || 2);            // 每位女优最多翻几页
const KEEP_DAYS = Number(config.newRelease?.keepDays || 120);             // 通知保留天数
const REQ_INTERVAL = Number(config.network?.requestInterval || 1200);     // 请求间隔
const COVER_INTERVAL = Number(config.newRelease?.coverInterval || 700);   // 封面下载间隔
const DOWNLOAD_COVERS = config.newRelease?.downloadCovers !== false;      // 是否落盘封面

// 封面缓存目录（与海报缓存同一个，走 /api/movie/poster/{name} 直接能读）
const COVER_CACHE_DIR = path.resolve(__dirname, '../cache/posters');

class NewReleaseChecker {
    constructor() {
        this.checking = false;
        this.cursor = 0;        // 分片游标（上次扫到第几位）
        this.progress = { done: 0, total: 0, current: '', found: 0, startedAt: 0 };
    }

    /** 近一个月窗口起点（毫秒） */
    windowStart() {
        return Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    }

    /**
     * 扫一轮（分片）
     * @param {Object} opts
     * @param {number} opts.limit 本轮扫多少位
     * @param {boolean} opts.resetCursor 从头部开始
     * @param {number} opts.actressId 只扫指定女优
     */
    async checkAll(opts = {}) {
        if (this.checking) {
            console.log('[女优新作] 正在检查中，跳过...');
            return { found: 0, scanned: 0, skipped: true };
        }

        this.checking = true;
        const startedAt = Date.now();
        const windowStart = this.windowStart();

        try {
            let actresses;

            if (opts.actressId) {
                const one = getActressById.get(opts.actressId);
                actresses = one ? [one] : [];
            } else {
                const limit = Math.max(1, Number(opts.limit) || ACTORS_PER_RUN);
                if (opts.resetCursor) this.cursor = 0;
                actresses = getActressesForMonitor.all({ limit, offset: this.cursor });
                if (actresses.length === 0 && this.cursor > 0) {
                    this.cursor = 0;
                    actresses = getActressesForMonitor.all({ limit, offset: 0 });
                }
            }

            this.progress = {
                done: 0,
                total: actresses.length,
                current: '',
                found: 0,
                startedAt,
            };

            console.log(`[女优新作] 本轮扫描 ${actresses.length} 位女优（游标 ${this.cursor}），窗口近 ${WINDOW_DAYS} 天`);

            const seen = this.buildSeenSet();
            let found = 0;

            for (const actress of actresses) {
                this.progress.current = actress.name;
                try {
                    const works = await this.checkActressNewWorks(actress, windowStart, seen);
                    for (const w of works) {
                        seen.add(`${actress.name}|${String(w.num || '').toLowerCase()}`);
                        // 封面落盘：javbus 图片有防盗链，前端直接引外链会 401。
                        // 下载到 cache/posters 后走 /api/movie/poster/{name} 本地读取。
                        const localCover = await this.cacheCover(w.cover);
                        addNotification.run(
                            'new_release',
                            `${actress.name} 新作`,
                            // content 只放「补充信息」——番号在卡片标题位已展示，
                            // 这里再写一遍会变成 MIRD-754 · 番号: MIRD-754 的重复噪音。
                            w.releaseDate ? `发行日期：${w.releaseDate}` : '',
                            w.url || '',
                            localCover || w.cover || '',
                            JSON.stringify({
                                avid: w.num || '',
                                actress: actress.name,
                                actressId: actress.id,
                                actressAvatar: actress.avatar || '',
                                releaseDate: w.releaseDate || '',
                                dateSource: w.dateSource || 'unknown',
                                source: w.source || 'javbus',
                            }),
                            w.releaseTs || Date.now()
                        );
                        found++;
                    }
                } catch (e) {
                    console.log(`[女优新作] ${actress.name} 失败:`, e.message);
                }
                this.progress.done++;
                await sleep(REQ_INTERVAL);
            }

            this.progress.found = found;
            this.cursor += actresses.length;
            console.log(`[女优新作] 本轮完成：扫描 ${actresses.length} 位，找到 ${found} 部近一月新作，耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

            try {
                const r = pruneNotifications(['new_release'], Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
                if (r.changes > 0) console.log(`[女优新作] 清理过期通知 ${r.changes} 条`);
            } catch (e) { /* 忽略 */ }

            if (found > 0) {
                try {
                    const { push } = require('./push');
                    push('女优新作提醒', `发现 ${found} 部近一月新作，打开影库查看`);
                } catch (e) { /* 推送不可用不影响主流程 */ }
            }

            return { found, scanned: actresses.length, cursor: this.cursor };
        } catch (e) {
            console.log('[女优新作] 检查失败:', e.message);
            return { found: 0, scanned: 0, error: e.message };
        } finally {
            this.checking = false;
            this.progress.current = '';
        }
    }

    /**
     * 把外链封面下载到本地缓存，返回可直接给前端用的 URL。
     * 失败就返回 ''（前端会退回 emoji 占位），绝不抛异常打断扫描。
     */
    async cacheCover(coverUrl) {
        if (!DOWNLOAD_COVERS || !coverUrl || !/^https?:\/\//.test(coverUrl)) return '';
        try {
            const name = getPosterCacheName(coverUrl);
            if (!name) return '';
            const savePath = path.join(COVER_CACHE_DIR, name);
            if (fs.existsSync(savePath)) {
                return `/api/movie/poster/${name}`;   // 已缓存，不重复下载
            }
            if (!fs.existsSync(COVER_CACHE_DIR)) fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });
            await downloadPoster(coverUrl, savePath);
            await sleep(COVER_INTERVAL);
            return fs.existsSync(savePath) ? `/api/movie/poster/${name}` : '';
        } catch (e) {
            return '';
        }
    }

    /** 已有通知集合：`女优名|番号` */
    buildSeenSet() {        const set = new Set();
        try {
            for (const n of getAllNotifications.all()) {
                if (n.type !== 'new_release') continue;
                try {
                    const ex = JSON.parse(n.extra || '{}');
                    if (ex.actress && ex.avid) {
                        set.add(`${ex.actress}|${String(ex.avid).toLowerCase()}`);
                    }
                } catch (e) { /* 坏 extra 忽略 */ }
            }
        } catch (e) { /* 忽略 */ }
        return set;
    }

    /**
     * 查单个女优近一月的作品（javbus 主源，带真实日期）
     */
    async checkActressNewWorks(actress, windowStart, seen) {
        const results = await searchJavBusByActress(actress.name, {
            sinceTs: windowStart,
            maxPages: PAGES_PER_ACTOR,
        });

        if (!results.length) return [];

        const out = [];
        for (const r of results) {
            const num = String(r.num || '').trim();
            if (!num) continue;
            const key = num.toLowerCase();
            if (seen && seen.has(`${actress.name}|${key}`)) continue;

            out.push({
                num,
                title: r.title || num,
                cover: r.cover || '',
                url: r.url || '',
                releaseDate: r.releaseDate || '',
                releaseTs: r.releaseTs || Date.now(),
                dateSource: r.releaseDate ? 'javbus' : 'unknown',
                source: r.source || 'javbus',
            });
        }

        if (out.length) {
            console.log(`[女优新作] ${actress.name}: 近一月 ${out.length} 部`);
        }
        return out;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// 单例
let checker = null;
function getChecker() {
    if (!checker) checker = new NewReleaseChecker();
    return checker;
}

module.exports = {
    getChecker,
    NewReleaseChecker,
    WINDOW_DAYS,
};
