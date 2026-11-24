/**
 * utils/crawler/bangumi-book.js —— Bangumi 书籍条目（漫画 / 小说）刮削
 *
 * 为什么走 Bangumi：
 *   它是本机「设置 → 数据源」里已经启用、且**唯一同时覆盖漫画与小说**的源，
 *   条目上直接带作者 / 出版社 / 册数 / 简介 / 社区标签（漫画/恋爱/校园…），
 *   正好是「先把元数据补齐、再精准打标」所需要的原料。
 *
 * 关键实现：
 *   · 复用 crawler/base 的 Request ⇒ 自动走 config.network.proxyServer
 *     （实测 api.bgm.tv 直连超时、走 127.0.0.1:7892 秒通，旧 bgmRequest 没走代理，
 *       这是动漫库刮削不稳定的隐藏原因之一）
 *   · Bangumi 要求可识别 User-Agent，按官方规范声明
 *   · 条目类型 type=1（书籍），type=2 是动画，别混
 */

const { Request } = require('./base');
const config = require('../config');

const API = (config.sources?.bangumi?.apiBase || 'https://api.bgm.tv') + '/v0';
const UA = 'CinemaVault/1.0 (local movie library; +https://bgm.tv)';

class BangumiBookCrawler {
    constructor(options = {}) {
        this.request = new Request({
            timeout: options.timeout || 15000,
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            proxy: options.proxy
        });
    }

    async _json(res) {
        if (!res.ok) {
            let body = '';
            try { body = (await res.text()).slice(0, 200); } catch (e) { }
            throw new Error(`Bangumi HTTP ${res.status} ${body}`);
        }
        return res.json();
    }

    /** 可达性预检：代理没起/网络断了就立刻报错，别让批量任务空跑 200 次 */
    async checkReachable() {
        const res = await this.request.get(`${API}/subjects/2`);
        if (!res.ok) throw new Error(`Bangumi HTTP ${res.status}`);
        return true;
    }

    /** 搜索书籍条目（漫画/小说统一走 book） */
    async search(keyword, limit = 8) {
        const kw = String(keyword || '').trim();
        if (kw.length < 2) return [];
        /* ★ 不能用 request.post()：它按 form-urlencoded 发，Bangumi 只收 JSON，
         *   实测报 400「invalid character 'k' looking for beginning of value」（'k' 来自 keyword=）。 */
        const doPost = () => this.request._doFetch(`${API}/search/subjects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                keyword: kw,
                filter: { type: [1] }   // v0 的 filter 不接受 nsfw，带上会 400
            })
        });
        let res;
        try {
            res = await doPost();
        } catch (e) {
            await new Promise(r => setTimeout(r, 1500));   // 网络抖动重试一次
            res = await doPost();
        }
        const j = await this._json(res);
        return (j.data || []).slice(0, limit).map(x => ({
            id: x.id,
            title: x.name_cn || x.name,
            originalTitle: x.name,
            date: x.date || '',
            cover: (x.images && (x.images.large || x.images.common)) || '',
            score: x.score || (x.rating && x.rating.score) || 0,
            tags: (x.tags || []).slice(0, 12).map(t => t.name),
            summary: x.summary || ''
        }));
    }

    /** 条目详情：补作者 / 出版社 / 册数 / 完整标签 */
    async detail(id) {
        const res = await this.request.get(`${API}/subjects/${encodeURIComponent(id)}`);
        const j = await this._json(res);
        const box = {};
        for (const item of j.infobox || []) {
            if (!item || !item.key) continue;
            let v = item.value;
            if (Array.isArray(v)) v = v.map(x => (typeof x === 'object' ? (x.v || x.k || '') : x)).join(' / ');
            box[item.key] = String(v == null ? '' : v).trim();
        }
        // 标签按认可数排序，取前 12 个（社区标签质量比作者自填的强）
        const tags = (j.tags || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0))
            .map(t => t.name).filter(Boolean).slice(0, 12);
        return {
            id: j.id,
            title: j.name_cn || j.name,
            originalTitle: j.name || '',
            date: j.date || box['发售日'] || '',
            cover: (j.images && (j.images.large || j.images.common)) || '',
            score: (j.rating && j.rating.score) || 0,
            summary: j.summary || '',
            author: box['作者'] || box['原作'] || '',
            publisher: box['出版社'] || '',
            volumes: box['册数'] || '',
            magazine: box['连载杂志'] || '',
            tags,
            url: `https://bgm.tv/subject/${j.id}`
        };
    }
}

/** 书名清洗：去掉卷号、译者括号、丛书前缀、z-library 噪声，得到可搜索的核心书名 */
function cleanBookTitle(title) {
    /* ★ 只能剥「已知文档扩展名」：书名里的小数点不是扩展名
     *   （`2.5次元的诱惑_01卷` 曾被 /\.[^.]+$/ 砍成 `2`，搜索直接报废） */
    let t = String(title || '').replace(/\.(pdf|epub|mobi|azw3|txt|cbz|cbr|zip|rar)$/i, '');
    /* ★★ 下划线分段取核心（真实事故）：
     *   `2.付费服务开始-1_全知读者视角漫画_20241020093017` 整串丢进搜索，
     *   会被开头 `2.` 和结尾 14 位时间戳带偏 —— 结果匹配到《101匹わんちゃん》小说化，
     *   把野崎まど、松本大洋这些不相干的作者/作品名写进了「全知读者视角」的标签里。
     *   规则：按下划线分段 → 丢掉纯数字/时间戳段 → 取最长的一段当书名。 */
    if (t.includes('_')) {
        const segs = t.split('_').map(x => x.trim()).filter(Boolean)
            .filter(x => !/^\d{8,}$/.test(x) && !/^\d+$/.test(x))
            // 段内也先剥「序号」「结尾章节号」再比长度，否则「付费服务开始-1」会靠长度胜出
            .map(x => x.replace(/^\d{1,4}[.、](?!\d)\s*/, '').replace(/[-_]\s*\d{1,4}\s*$/, '').trim())
            .filter(Boolean);
        if (segs.length) {
            /* 取哪个段：`章节名-1_系列名_时间戳` 要**系列名**（末段），
             * 而 `书名_01卷` 要**书名**（首段）—— 用「末段是不是卷次」来区分。 */
            const last = segs[segs.length - 1];
            const isVol = /^\d{1,3}\s*(卷|话|話|章)?$/.test(last);
            t = isVol || segs.length === 1 ? segs[0] : last;
        }
    }
    // ★ (?!\d) 是关键：`2.5次元的诱惑` 的 `2.` 不是序号，剥了就变成 `5次元的诱惑`
    t = t.replace(/^\d{1,4}[.、](?!\d)\s*/, ' ');  // 开头序号 2. / 49. / 101.
    t = t.replace(/[-_]\s*\d{1,4}\s*$/, ' ');       // 结尾 -1 / -3（章节号）
    t = t.replace(/[（(]\s*z-?lib(rary)?\s*[)）]/ig, ' ');
    t = t.replace(/[_ ]+\d{1,3}\s*(卷|话|話|章)?\s*$/g, ' ');       // 2.5次元的诱惑_01卷
    t = t.replace(/[_ ]+\d{1,4}\s*[-~]\s*\d{1,4}\s*$/g, ' ');       // _151-160（区间卷号）
    t = t.replace(/\s*話?\s*\d{1,4}\s*[-~]\s*\d{1,4}\s*$/g, ' ');    // 話176-180
    t = t.replace(/(?:[_ ]?\d{1,3}\s*卷)?\s*番外\s*$/g, ' ');          // _15卷番外 / 番外篇
    t = t.replace(/[_\-]+\s*$/g, ' ');                                // 上一步可能留下孤立下划线
    for (let i = 0; i < 3; i++) {                                    // 结尾 (北岛译) (全彩版)…
        const next = t.replace(/[（(][^（）()]{1,30}[)）]\s*$/g, '').trim();
        if (next === t) break;
        t = next;
    }
    t = t.replace(/^\[[^\]]{1,30}\]\s*/g, ' ');                      // 开头 [20世纪世界诗歌译丛]
    t = t.replace(/^\[[^\]]{1,30}\]\s*/g, ' ');
    t = t.replace(/[\[\]【】]/g, ' ').replace(/\s+/g, ' ').trim();
    return t;
}

module.exports = { BangumiBookCrawler, cleanBookTitle };