/**
 * 漫画新作监视（kmoe 全库版）
 * ============================================================
 * 逻辑与「女优新作」完全对称：
 *   1. 取出本地全部漫画（type='comic'）
 *   2. 用**同名标题**去 kmoe 搜索
 *   3. 取相似度最高的那本，拉详情拿到卷/话列表
 *   4. kmoe 上有、而本地没有的（卷数比本地多），就算新作 → 落通知
 *
 * 与旧版的区别：
 *   - 旧版只查「最近添加的前 20 部」，覆盖面太小；现在分片遍历全库。
 *   - 旧版本地卷数永远算成 1（`countLocalVolumes` 是假的）；现在按
 *     「同一系列名下的本地文件数」真实计数（`第N卷`/`Vol.N` 解析 + 同系列归并）。
 *   - 旧版详情失败时会硬塞一条「可能有新卷」的噪音通知；现在详情失败直接跳过。
 */

const { getComicsForMonitor, getAllNotifications, addNotification, pruneNotifications } = require('./db');
const { getPosterCacheName } = require('./poster-fetcher');
const config = require('./config');
const KmoeCrawler = require('./crawler/kmoe');
const fs = require('fs');
const path = require('path');

const WINDOW_DAYS = Number(config.newRelease?.windowDays || 30);
const COMICS_PER_RUN = Number(config.newRelease?.comicsPerRun || 40);
const KEEP_DAYS = Number(config.newRelease?.keepDays || 120);
// kmoe 对同一来源的高频请求很敏感，连打会直接把 TLS 连接掐掉
// （表现为 "Client network socket disconnected before secure TLS connection"）。
// 所以间隔给得比女优那边宽，另外单部失败后会额外退避。
const REQ_INTERVAL = Number(config.comic?.requestInterval || 3500);
const NET_BACKOFF_MS = Number(config.comic?.netBackoffMs || 8000);

// 封面缓存目录：与海报缓存共用，走 /api/movie/poster/{name} 可直接读
const COVER_CACHE_DIR = path.resolve(__dirname, '../cache/posters');
const DOWNLOAD_COVERS = config.newRelease?.downloadCovers !== false;
const COVER_INTERVAL = Number(config.newRelease?.coverInterval || 700);

class ComicNewReleaseChecker {
    constructor() {
        this.checking = false;
        this.crawler = null;
        this.cursor = 0;
        this.progress = { done: 0, total: 0, current: '', found: 0, startedAt: 0 };
    }

    getCrawler() {
        if (!this.crawler) {
            const k = config.sources?.kmoe || {};
            this.crawler = new KmoeCrawler({
                baseUrl: k.baseUrl || 'https://kzo.moe',
                username: k.username || '',
                password: k.password || '',
                cookie: k.cookie || '',
            });
        }
        return this.crawler;
    }

    /**
     * 扫一轮
     * @param {Object} opts
     * @param {number} opts.limit 本轮扫多少部
     * @param {boolean} opts.resetCursor 从头开始
     * @param {boolean} opts.force 忽略 kmoe.enabled 开关（手动触发时用）
     */
    async checkAll(opts = {}) {
        if (this.checking) {
            console.log('[漫画新作] 正在检查中，跳过...');
            return { found: 0, scanned: 0, skipped: true };
        }
        if (!config.sources?.kmoe?.enabled && !opts.force) {
            console.log('[漫画新作] kmoe 数据源未开启，跳过（可手动强制触发）');
            return { found: 0, scanned: 0, disabled: true };
        }

        this.checking = true;
        const startedAt = Date.now();
        const windowStart = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

        try {
            const limit = Math.max(1, Number(opts.limit) || COMICS_PER_RUN);
            if (opts.resetCursor) this.cursor = 0;
            let comics = getComicsForMonitor.all({ limit, offset: this.cursor });
            if (comics.length === 0 && this.cursor > 0) {
                this.cursor = 0;
                comics = getComicsForMonitor.all({ limit, offset: 0 });
            }

            this.progress = { done: 0, total: comics.length, current: '', found: 0, startedAt };
            console.log(`[漫画新作] 本轮扫描 ${comics.length} 部漫画（游标 ${this.cursor}）`);

            const seen = this.buildSeenSet();
            const crawler = this.getCrawler();

            // 本地「系列名 → 已有卷数」统计表，用来判断 kmoe 上是不是更多
            const localVolumeMap = this.buildLocalVolumeMap();

            let found = 0;
            let netErrors = 0;
            for (const comic of comics) {
                this.progress.current = comic.title || comic.fileName || '';
                let hadNetError = false;
                try {
                    const works = await this.checkSingleComic(comic, crawler, localVolumeMap);
                    for (const w of works) {
                        const key = `${w.seriesKey}|${w.volumeKey}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        // kmoe 封面有会话签名，浏览器直连一律 403，
                        // 必须带 crawler 的 cookie 在服务端下载到本地缓存。
                        const localCover = await this.cacheCover(w.cover, crawler);
                        addNotification.run(
                            'comic_new_release',
                            `${comic.title || comic.fileName} 新卷`,
                            w.volume ? `最新：${w.volume}` : '',
                            w.url || '',
                            localCover || w.cover || '',
                            JSON.stringify({
                                comicTitle: comic.title || comic.fileName || '',
                                comicId: comic.id,
                                seriesKey: w.seriesKey,
                                seriesName: w.seriesKey,
                                volume: w.volume || '',
                                source: 'kmoe',
                            }),
                            Date.now()
                        );
                        found++;
                    }
                } catch (e) {
                    const msg = String(e && e.message || e);
                    if (/TLS|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|aborted/i.test(msg)) {
                        hadNetError = true;
                        netErrors++;
                    }
                    console.log(`[漫画新作] ${comic.title} 失败:`, msg);
                }
                this.progress.done++;
                // 网络层失败说明已经被限流，多歇一会儿再继续，别硬碰
                await sleep(hadNetError ? NET_BACKOFF_MS : REQ_INTERVAL);
            }

            this.progress.found = found;
            this.cursor += comics.length;
            console.log(`[漫画新作] 本轮完成：扫描 ${comics.length} 部，发现 ${found} 个新卷，网络失败 ${netErrors} 次，耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

            try {
                const r = pruneNotifications(['comic_new_release'], Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
                if (r.changes > 0) console.log(`[漫画新作] 清理过期通知 ${r.changes} 条`);
            } catch (e) { /* 忽略 */ }

            if (found > 0) {
                try {
                    const { push } = require('./push');
                    push('漫画更新提醒', `有 ${found} 个新卷上架，打开漫画库查看`);
                } catch (e) { /* 忽略 */ }
            }

            return { found, scanned: comics.length, skipped: false, cursor: this.cursor };
        } catch (e) {
            console.log('[漫画新作] 检查失败:', e.message);
            return { found: 0, scanned: 0, error: e.message };
        } finally {
            this.checking = false;
            this.progress.current = '';
        }
    }

    buildSeenSet() {
        const set = new Set();
        try {
            for (const n of getAllNotifications.all()) {
                if (n.type !== 'comic_new_release') continue;
                try {
                    const ex = JSON.parse(n.extra || '{}');
                    if (ex.seriesKey) set.add(`${ex.seriesKey}|${ex.volume || ''}`);
                } catch (e) { /* 忽略 */ }
            }
        } catch (e) { /* 忽略 */ }
        return set;
    }

    /**
     * 本地漫画卷数表：整个漫画库里所有条目的「系列名 → 已有哪些章节号」。
     * 一次扫全库（只读标题），避免每部漫画都去扫目录。
     */
    buildLocalVolumeMap() {
        const map = new Map();
        try {
            const all = getComicsForMonitor.all({ limit: 100000, offset: 0 });
            for (const c of all) {
                const title = c.title || c.fileName || '';
                const { series, chapter } = this.parseComicFile(title);
                if (!series) continue;
                const cur = map.get(series) || { count: 0, chapters: new Set() };
                if (chapter) cur.chapters.add(String(chapter));
                cur.count = cur.chapters.size || Math.max(cur.count, 1);
                map.set(series, cur);
            }
        } catch (e) {
            console.log('[漫画新作] 本地卷数统计失败:', e.message);
        }
        return map;
    }

    /** 系列名：去掉卷号/话数/分辨率/压缩包标记后的主干 */
    seriesName(title) {
        return this.cleanComicTitle(title);
    }

    /**
     * 解析本地漫画文件名，抽出「系列名 / 章节号」
     * ============================================================
     * 本库漫画实际命名是：`{序号}：{章节名}-{系列名}.pdf`
     *   例：`192：通知 3-日月同错.pdf`  → 系列「日月同错」，章节 192
     *       `002：第一回 皓光当空 上-日月同错.pdf` → 系列「日月同错」，章节 2
     * 所以系列名要取**最后一个短横线之后**的部分；
     * 若拿不到（没有短横线），再退回通用清洗。
     */
    parseComicFile(title) {
        const raw = String(title || '').replace(/\.(cbz|cbr|zip|rar|pdf|epub|mobi|azw3)$/i, '');

        // 1) 形如 `192：xxx-系列名` 或 `192:xxx-系列名`
        let m = raw.match(/^\s*(\d{1,4})\s*[：:]\s*(.+)$/);
        if (m) {
            const seq = String(Number(m[1]));            // 去掉前导零：002 -> 2
            let rest = m[2];
            // 系列名 = 最后一个 '-' 之后（章节标题里可能有别的 -）
            const dashIdx = rest.lastIndexOf('-');
            let series = dashIdx >= 0 ? rest.slice(dashIdx + 1) : '';
            series = this.cleanComicTitle(series);
            if (series && series.length >= 2) {
                return { series, chapter: seq, chapterLabel: rest.slice(0, dashIdx >= 0 ? dashIdx : rest.length).trim() };
            }
        }

        // 2) 通用兜底：常规 `xxx 第N卷` 这类
        const series = this.cleanComicTitle(raw);
        const vol = this.extractVolume(raw);
        return { series, chapter: vol || '', chapterLabel: '' };
    }

    /** 从标题里抠卷号；抠不到返回 '' */
    extractVolume(title) {
        const t = String(title || '');
        let m = t.match(/第\s*(\d+(?:\.\d+)?)\s*[卷巻册話话回]/);
        if (m) return m[1];
        m = t.match(/(?:Vol\.?|Volume)\s*(\d+(?:\.\d+)?)/i);
        if (m) return m[1];
        m = t.match(/[\[\(【]\s*(\d{1,3})\s*[\]\)】]/);   // [12] 这种常见卷标
        if (m) return m[1];
        // `192：xxx` 开头的序号
        m = t.match(/^\s*(\d{1,4})\s*[：:]/);
        if (m) return String(Number(m[1]));
        m = t.match(/\s(\d{1,3})\s*$/);                    // 末尾裸数字
        if (m) return m[1];
        return '';
    }

    /** 把 kmoe 章节标题也抠出卷号，用于跟本地比对 */
    extractVolumeFromChapter(chapterTitle) {
        return this.extractVolume(chapterTitle) || String(chapterTitle || '').trim();
    }

    /**
     * 检查单部漫画
     * ============================================================
     * 关键点（实测得来）：
     *  - kmoe 的**卷列表**只能通过 `crawler.getVolumes()` 拿，
     *    它内部走 bookof.moe/b/{id}.htm → data_vol.php?h=token，
     *    返回 `datacount-V=总数,..` + `datainfo-V=seq,类型,卷名,..`。
     *  - `getDetail()` 里的 `a[href*="/read/"]` 选择器在这个站上**根本匹配不到**，
     *    所以旧版永远拿 0 章节、永远不发通知 —— 这才是漫画监视一直没动静的真因。
     *  - 有些书在 kmoe 上就是 0 卷（例如「日月同錯」），那是站点没有，
     *    不是解析失败；total=0 时静默跳过，不要造噪音。
     */
    async checkSingleComic(comic, crawler, localVolumeMap) {
        const out = [];
        const title = comic.title || comic.fileName || '';
        if (!title) return out;

        const { series: cleanTitle } = this.parseComicFile(title);
        if (!cleanTitle || cleanTitle.length < 2) return out;

        const searchResults = await crawler.search(cleanTitle, 1);
        if (!searchResults || searchResults.length === 0) return out;

        // 找最匹配的
        let bestMatch = null;
        let bestScore = 0;
        for (const r of searchResults) {
            const score = this.calcSimilarity(cleanTitle, r.title || '');
            if (score > bestScore && score >= 0.6) {
                bestScore = score;
                bestMatch = r;
            }
        }
        if (!bestMatch) return out;

        // 拿 kmoe 上的卷列表
        const vol = await crawler.getVolumes(bestMatch.url);
        if (!vol || !vol.volumes || vol.volumes.length === 0) {
            // total=0 是「站上确实没有」，不是错误 —— 静默跳过
            return out;
        }

        // 本地已有章节号（同一系列下所有本地文件解析出的序号）
        const localInfo = localVolumeMap.get(cleanTitle) || { count: 1, chapters: new Set() };
        const localChapters = new Set([...((localInfo.chapters) || [])].map(String));

        // kmoe 卷号去重
        const remoteVols = [];
        const remoteSeen = new Set();
        for (const v of vol.volumes) {
            const key = String(v.seq);
            if (!key || remoteSeen.has(key)) continue;
            remoteSeen.add(key);
            remoteVols.push(v);
        }
        if (remoteVols.length === 0) return out;

        const newest = remoteVols[remoteVols.length - 1];   // getVolumes 已按 seq 升序
        const localMax = this.maxLocalChapter(localChapters);

        // 判定「新」：kmoe 最新卷号 > 本地最大卷号即算新。
        // 本地一个都没解析出来时，退化成「远端卷数 > 本地卷数」。
        let isNew = false;
        if (localChapters.size > 0) {
            isNew = Number(newest.seq) > localMax;
        } else {
            isNew = remoteVols.length > (localInfo.count || 1);
        }
        if (!isNew) return out;

        const localDesc = localChapters.size > 0
            ? `本地已到第 ${localMax} 卷`
            : `本地约 ${localInfo.count || 1} 卷`;

        out.push({
            title: `${newest.name}`,
            description: `${localDesc}，kmoe 上共 ${vol.total} 卷`,
            url: bestMatch.url,
            cover: vol.cover || bestMatch.cover || '',
            seriesKey: cleanTitle,
            volumeKey: String(newest.seq),
            volume: newest.name || `卷 ${newest.seq}`,
            releaseDate: '',
        });

        // 中间还有别的缺失卷（跳卷）时也一并提示，最多 4 条
        const missing = remoteVols.filter(v => Number(v.seq) > localMax).slice(0, 4);
        for (const v of missing) {
            const key = String(v.seq);
            if (key === String(newest.seq)) continue;   // 最新卷上面已 push
            out.push({
                title: `${v.name}`,
                description: `${localDesc}，kmoe 上共 ${vol.total} 卷`,
                url: bestMatch.url,
                cover: vol.cover || v.cover || bestMatch.cover || '',
                seriesKey: cleanTitle,
                volumeKey: key,
                volume: v.name || `卷 ${v.seq}`,
                releaseDate: '',
            });
        }
        return out;
    }

    /** 从本地章节号集合里取最大值 */
    maxLocalChapter(chapterSet) {
        let max = 0;
        for (const c of chapterSet) {
            const n = Number(c);
            if (!isNaN(n) && n > max) max = n;
        }
        return max;
    }

    /**
     * 把 kmoe 外链封面下载到本地缓存，返回前端可直接用的 URL。
     * kmoe 的图片 URL 带会话签名（`?sign=...`），且服务端会对来源做校验，
     * 浏览器直连一律 403 —— 必须用 crawler 自己那套 cookie 去下，
     * 所以这里不能复用 new-release-checker 的 downloadPoster（那个只带 javbus referer）。
     * 失败返回 ''，前端退回占位图，绝不抛异常打断扫描。
     */
    async cacheCover(coverUrl, crawler) {
        if (!DOWNLOAD_COVERS || !coverUrl || !/^https?:\/\//.test(coverUrl)) return '';
        try {
            const name = getPosterCacheName(coverUrl);
            if (!name) return '';
            const savePath = path.join(COVER_CACHE_DIR, name);
            if (fs.existsSync(savePath)) return `/api/movie/poster/${name}`;   // 已缓存

            if (!fs.existsSync(COVER_CACHE_DIR)) fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });

            // 必须走 crawler 的 request（自带 cookie / UA），裸 fetch 一律 403
            const res = await crawler.request.get(coverUrl);
            if (!res || !res.ok) return '';
            const buf = Buffer.from(await res.arrayBuffer());
            if (!buf || buf.length < 200) return '';        // 太小基本是错误页
            fs.writeFileSync(savePath, buf);
            await sleep(COVER_INTERVAL);
            return fs.existsSync(savePath) ? `/api/movie/poster/${name}` : '';
        } catch (e) {
            return '';
        }
    }

    /** 清洗漫画标题，去掉卷号、分辨率、压缩包标记 */
    cleanComicTitle(title) {
        let clean = String(title || '');
        clean = clean.replace(/\.(cbz|cbr|zip|rar|pdf|epub|mobi|azw3)$/i, '');
        clean = clean.replace(/第\s*\d+(?:\.\d+)?\s*[卷巻册話话]/g, '');
        clean = clean.replace(/(?:Vol\.?|Volume)\s*\d+(?:\.\d+)?/gi, '');
        clean = clean.replace(/(?:Ch\.?|Chapter|EP|Episode)\s*\d+/gi, '');
        clean = clean.replace(/\d{3,4}[piPI]/g, '');
        clean = clean.replace(/\d+\s*[xX×]\s*\d+/g, '');
        clean = clean.replace(/[\[\(【（][^\]\)】）]*[\]\)】）]/g, ' ');
        clean = clean.replace(/[【】\[\]()（）]/g, ' ');
        clean = clean.replace(/[._\-]+/g, ' ');
        // 去掉常见汉化组/标签尾巴
        clean = clean.replace(/\b(汉化|漢化|完结|連載|连载|全彩|扫描|掃描|高清|DL版|Digital)\b/g, ' ');
        clean = clean.replace(/\s{2,}/g, ' ');
        clean = clean.trim();
        clean = clean.replace(/^[\-_\s]+|[\-_\s]+$/g, '');
        return clean;
    }

    /** 标题相似度（字符集合重合度） */
    calcSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        const s1 = String(str1).toLowerCase();
        const s2 = String(str2).toLowerCase();
        if (s1 === s2) return 1;
        if (s1.includes(s2) || s2.includes(s1)) return 0.85;

        const set1 = new Set(s1.replace(/\s/g, '').split(''));
        const set2 = new Set(s2.replace(/\s/g, '').split(''));
        let common = 0;
        for (const ch of set1) if (set2.has(ch)) common++;
        const total = new Set([...set1, ...set2]).size;
        return total > 0 ? common / total : 0;
    }

    /** 兼容旧调用 */
    countLocalVolumes(title) {
        const v = this.extractVolume(title);
        return v ? 1 : 1;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

let checker = null;
function getChecker() {
    if (!checker) checker = new ComicNewReleaseChecker();
    return checker;
}

module.exports = {
    getChecker,
    ComicNewReleaseChecker,
};
