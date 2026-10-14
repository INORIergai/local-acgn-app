/**
 * 站点解析器 API（round36 批次B）
 * ------------------------------------------------------------------
 * 把 utils/media-sources/engine.js 的能力暴露给前端：
 *   /sources    源清单（tier / 状态灯 / 类型）
 *   /status     逐个探测可达性（10 分钟缓存）
 *   /search     多源并发搜索（单源失败不影响其它源）
 *   /episodes   取某部作品的剧集列表
 *   /resolve    抽真流地址（m3u8 / mp4）
 *   /stream     m3u8 代理（重写分片为同源地址，顺带补 Referer）
 *   /seg        分片 / mp4 字节流代理（支持 Range）
 *   /bt         BT 源搜索（只出磁力，不内置下载引擎）
 *   /refresh    订阅刷新（拉最新源定义到可写目录）
 *
 * ★ 为什么必须代理：解析出来的 m3u8 几乎都有 Referer / UA 校验，
 *   而浏览器 <video> 没法自定义请求头，Cookie 更是跨域带不上。
 *   所以流一律走同源代理，由服务端补头。
 *
 * ★ 安全：代理接口会带着用户的请求去访问任意 URL，必须挡住内网（SSRF）。
 */
const express = require('express');
const router = express.Router();
const engine = require('../utils/media-sources/engine');

// ==================================================================
// 并发控制：多源搜索时限制同时在跑的请求数，别把机器和站点一起打爆
// ==================================================================
async function pool(items, limit, worker) {
    const ret = new Array(items.length);
    let i = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (i < items.length) {
            const idx = i++;
            try { ret[idx] = await worker(items[idx], idx); }
            catch (e) { ret[idx] = null; }
        }
    });
    await Promise.all(runners);
    return ret;
}

// ==================================================================
// 源清单 / 状态
// ==================================================================
router.get('/sources', async (req, res) => {
    const list = engine.loadSources();
    const withStatus = req.query.status === '1';
    let st = {};
    if (withStatus) {
        const arr = await engine.statusMap(req.query.force === '1');
        arr.forEach((x) => { st[x.id] = x; });
    }
    res.json({
        code: 0,
        data: list.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            tier: s.tier,
            host: s.host,
            iconUrl: s.iconUrl,
            description: s.description,
            origin: s.origin,
            version: s.version,
            status: st[s.id] || null
        }))
    });
});

router.get('/status', async (req, res) => {
    const arr = await engine.statusMap(req.query.force === '1');
    res.json({ code: 0, data: arr });
});

// ==================================================================
// 搜索（Web 解析源）
// ==================================================================
router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ code: -1, msg: '请输入关键词', data: [] });

    const only = String(req.query.sources || '').split(',').filter(Boolean);
    const timeout = Math.min(30000, Math.max(5000, Number(req.query.timeout) || 15000));
    let list = engine.loadSources().filter((s) => s.kind === 'web');
    if (only.length) list = list.filter((s) => only.includes(s.id));

    const results = await pool(list, 6, async (s) => {
        const r = await engine.searchOn(s, q, { timeout });
        return {
            sourceId: s.id,
            sourceName: s.name,
            tier: s.tier,
            host: s.host,
            ok: !r.error,
            error: r.error || '',
            items: (r.items || []).slice(0, 30)
        };
    });
    const clean = results.filter(Boolean);
    res.json({ code: 0, data: clean, query: q });
});

// ==================================================================
// BT 搜索
// ==================================================================
router.get('/bt', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ code: -1, msg: '请输入关键词', data: [] });
    const list = engine.loadSources().filter((s) => s.kind === 'bt');
    const results = await pool(list, 4, async (s) => {
        const r = await engine.searchOn(s, q, { timeout: 15000 });
        return {
            sourceId: s.id,
            sourceName: s.name,
            ok: !r.error,
            error: r.error || '',
            items: (r.items || []).slice(0, 40)
        };
    });
    res.json({ code: 0, data: results.filter(Boolean), query: q });
});

// ==================================================================
// 剧集 / 解析
// ==================================================================
router.get('/episodes', async (req, res) => {
    const id = String(req.query.source || '');
    const url = String(req.query.url || '');
    const s = engine.getSource(id);
    if (!s) return res.json({ code: -1, msg: '未知源：' + id });
    if (!/^https?:\/\//i.test(url)) return res.json({ code: -1, msg: '地址不合法' });
    const r = await engine.episodesOf(s, url, { timeout: 15000 });
    res.json({ code: 0, data: { sourceId: id, sourceName: s.name, url, episodes: r.episodes, error: r.error || '' } });
});

// 播放上下文：resolve 出来的 Referer / UA / Cookie 要带到流代理里，
// 但 URL 上不好塞这些（还会被浏览器和日志看见）→ 存内存换成一次性 token。
const streamCtx = new Map();
const CTX_TTL = 2 * 60 * 60 * 1000;

function newToken(ctx) {
    const token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    streamCtx.set(token, { ...ctx, at: Date.now() });
    if (streamCtx.size > 300) {
        const now = Date.now();
        for (const [k, v] of streamCtx) if (now - v.at > CTX_TTL) streamCtx.delete(k);
    }
    return token;
}

router.get('/resolve', async (req, res) => {
    const id = String(req.query.source || '');
    const url = String(req.query.url || '');
    const s = engine.getSource(id);
    if (!s) return res.json({ code: -1, msg: '未知源：' + id });
    if (!/^https?:\/\//i.test(url)) return res.json({ code: -1, msg: '地址不合法' });

    // browser=0 → 只用静态正则（快，但多数现代站点抽不到）；默认失败时开浏览器兜底
    const r = await engine.resolveVideo(s, url, {
        timeout: 25000,
        browser: req.query.browser !== '0'
    });
    if (!r.url) return res.json({ code: -1, msg: r.error || '没解析到播放地址', via: r.via || '' });

    const token = newToken({ headers: r.headers || {}, cookie: r.cookie || '' });
    const isHls = /\.m3u8(\?|$)/i.test(r.url);
    const streamUrl = `/api/media-source/${isHls ? 'stream' : 'seg'}?token=${encodeURIComponent(token)}&u=${encodeURIComponent(r.url)}`;
    res.json({
        code: 0,
        data: {
            url: r.url,
            streamUrl,
            kind: isHls ? 'hls' : 'mp4',
            sourceId: id,
            sourceName: s.name,
            from: r.from || url,
            via: r.via || 'regex'
        }
    });
});

// ==================================================================
// 流代理
// ==================================================================
function hostBlocked(u) {
    let host = '';
    try { host = new URL(u).hostname; } catch (e) { return true; }
    if (!host) return true;
    const h = host.toLowerCase();
    if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
    if (/^127\./.test(h)) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;   // link-local / 云元数据
    if (/^0\./.test(h)) return true;
    if (/\.local$/.test(h) || /\.internal$/.test(h)) return true;
    return false;
}

function ctxOf(token) {
    const c = streamCtx.get(String(token || ''));
    if (!c) return null;
    if (Date.now() - c.at > CTX_TTL) { streamCtx.delete(token); return null; }
    return c;
}

/** m3u8：把分片和 KEY/MAP 的地址全部改写成走 /seg 的同源地址 */
router.get('/stream', async (req, res) => {
    const u = String(req.query.u || '');
    if (!/^https?:\/\//i.test(u)) return res.status(400).json({ code: -1, msg: '地址不合法' });
    if (hostBlocked(u)) return res.status(400).json({ code: -1, msg: '拒绝代理内网地址' });

    const ctx = ctxOf(req.query.token) || {};
    const r = await engine.grab(u, {
        timeout: 15000,
        headers: ctx.headers || {},
        cookie: ctx.cookie || ''
    });
    if (!r.ok || !r.text) return res.status(502).json({ code: -1, msg: '拉取 m3u8 失败：' + (r.error || ('HTTP ' + r.status)) });

    const token = String(req.query.token || '');
    const abs = (line) => {
        try { return new URL(line, u).href; } catch (e) { return line; }
    };
    const proxied = (absUrl) => `/api/media-source/seg?token=${encodeURIComponent(token)}&u=${encodeURIComponent(absUrl)}`;

    const out = r.text.split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
            // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-SESSION-KEY 里的 URI="..."
            return t.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxied(abs(uri))}"`);
        }
        return proxied(abs(t));
    }).join('\n');

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(out);
});

/** 分片 / mp4 字节流转发（支持 Range，拖动进度条要用） */
router.get('/seg', async (req, res) => {
    const u = String(req.query.u || '');
    if (!/^https?:\/\//i.test(u)) return res.status(400).json({ code: -1, msg: '地址不合法' });
    if (hostBlocked(u)) return res.status(400).json({ code: -1, msg: '拒绝代理内网地址' });

    const ctx = ctxOf(req.query.token) || {};
    const range = req.headers.range;
    const baseHeaders = {};
    if (range) baseHeaders.Range = range;   // 拖动进度条会带 Range，必须透传

    /* ★ 防盗链的两个方向都存在，实测必须两种都试：
     *   有的 CDN 只认 Referer（不给就 403），有的正好相反（给了 Referer 反而 403，
     *   不带才 200 —— 嘀嗒影视走的小红书 CDN 就是这样）。
     *   所以先不带 Referer 试，被拒再带 Referer 重试一次。 */
    const withRef = Object.assign({}, baseHeaders, ctx.headers || {});
    const noRef = Object.assign({}, baseHeaders);
    delete noRef.Referer;
    delete noRef.referer;

    let r = await engine.grab(u, { timeout: 30000, headers: noRef, cookie: ctx.cookie || '' });
    if ((!r.ok || !r.buf) && (r.status === 401 || r.status === 403 || !r.buf)) {
        r = await engine.grab(u, { timeout: 30000, headers: withRef, cookie: ctx.cookie || '' });
    }
    if (!r.ok || !r.buf) {
        return res.status(502).json({ code: -1, msg: '分片拉取失败：' + (r.error || ('HTTP ' + r.status)) });
    }
    res.status(r.status || 200);
    res.set('Content-Type', r.ctype || 'application/octet-stream');
    const cr = r.headers && r.headers.get && r.headers.get('content-range');
    if (cr) res.set('Content-Range', cr);
    res.set('Accept-Ranges', 'bytes');
    res.end(r.buf);
});

// ==================================================================
// 订阅刷新
// ==================================================================
router.post('/refresh', async (req, res) => {
    const r = await engine.refreshSubscription();
    if (r.error) return res.json({ code: -1, msg: r.error, data: r });
    res.json({ code: 0, msg: `已刷新 ${r.updated} 份源定义${r.failed ? `（${r.failed} 份失败）` : ''}`, data: r });
});

module.exports = router;
