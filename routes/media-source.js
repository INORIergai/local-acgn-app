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
 *   而浏览器 video 标签没法自定义请求头，Cookie 更是跨域带不上。
 *   所以流一律走同源代理，由服务端补头。
 *
 * ★ 安全：代理接口会带着用户的请求去访问任意 URL，必须挡住内网（SSRF）。
 */
const express = require('express');const router = express.Router();
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const engine = require('../utils/media-sources/engine');
const reading = require('../utils/media-sources/reading');
const onlineHistory = require('../utils/online-history');

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
            status: st[s.id] || null,
            enabled: engine.isSourceEnabled(s.id),
            factory: s.factoryId || ''
        }))
    });
});

/* ---------------- 源启用偏好（Kazumi 式自由选源） ----------------
 * GET  /api/media-source/prefs          全部源 + enabled
 * POST /api/media-source/prefs          { id, enabled } 单个；或 { disabled: [...] } 整批
 */
router.get('/prefs', (req, res) => {
    try {
        const list = engine.loadSources().map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            tier: s.tier,
            host: s.host || '',
            factory: s.factoryId || '',
            origin: s.origin || '',
            enabled: engine.isSourceEnabled(s.id),
        }));
        res.json({ code: 0, data: { sources: list, prefsFile: engine.PREFS_FILE } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/prefs', (req, res) => {
    try {
        const body = req.body || {};
        if (Array.isArray(body.disabled)) {
            const saved = engine.setDisabledSources(body.disabled);
            return res.json({ code: 0, data: { disabled: saved } });
        }
        if (typeof body.id === 'string' && body.id) {
            const on = body.enabled !== false;
            const now = engine.setSourceEnabled(body.id, on);
            return res.json({ code: 0, data: { id: body.id, enabled: now } });
        }
        res.json({ code: -1, msg: '需要 { id, enabled } 或 { disabled: [...] }' });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
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
    const excluded = new Set(String(req.query.exclude || '').split(',').filter(Boolean));
    const timeout = Math.min(30000, Math.max(5000, Number(req.query.timeout) || 15000));
    let list = engine.loadSources().filter((s) => s.kind === 'web' && !excluded.has(s.id) && engine.isSourceEnabled(s.id));
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
// 在线观看历史（跨设备同步）
// ==================================================================
router.get('/history', (req, res) => {
    try {
        res.json({ code: 0, data: onlineHistory.list(req.query.limit) });
    } catch (e) {
        res.status(500).json({ code: -1, msg: e.message, data: [] });
    }
});

router.post('/history', (req, res) => {
    try {
        const r = onlineHistory.upsert(req.body || {});
        res.json({ code: 0, data: { saved: true, changed: r.changed } });
    } catch (e) {
        res.status(400).json({ code: -1, msg: e.message, data: null });
    }
});

router.post('/history/merge', (req, res) => {
    try {
        const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
        res.json({ code: 0, data: onlineHistory.merge(items) });
    } catch (e) {
        res.status(400).json({ code: -1, msg: e.message, data: null });
    }
});

router.delete('/history', (req, res) => {
    try {
        res.json({ code: 0, data: { cleared: onlineHistory.clear() } });
    } catch (e) {
        res.status(500).json({ code: -1, msg: e.message, data: null });
    }
});

router.delete('/history/item', (req, res) => {
    try {
        const removed = onlineHistory.remove(req.query.sourceId, req.query.url);
        res.json({ code: 0, data: { removed } });
    } catch (e) {
        res.status(400).json({ code: -1, msg: e.message, data: null });
    }
});

/* r153 · D：源站目录 / 发现页（无关键词浏览）。 */
router.get('/catalog', async (req, res) => {
    const id = String(req.query.source || '').trim();
    const source = engine.getSource(id);
    if (!source) return res.json({ code: -1, msg: '源不存在', data: [] });
    try {
        const r = await engine.catalogOf(source, {
            page: parseInt(req.query.page, 10) || 1,
            limit: Math.min(parseInt(req.query.limit, 10) || 36, 60)
        });
        res.json({
            code: 0,
            data: {
                sourceId: source.id,
                sourceName: source.name,
                items: r.items || [],
                error: r.error || ''
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message, data: [] });
    }
});

// 在线最新聚合（影视库/动漫库首页的"在线优先"卡片区）。只聚合元数据，
// 不接触用户 URL / 本地文件，故不走 /seg 的 hostBlocked。
router.get('/browse', async (req, res) => {
    const kind = req.query.kind === 'film' ? 'film' : 'anime';
    try {
        const browse = require('../utils/media-sources/browse');
        const data = await browse.browseLatest(kind, { limit: Math.min(parseInt(req.query.limit, 10) || 30, 60) });
        res.json({ code: 0, data });
    } catch (e) {
        res.json({ code: -1, msg: e.message, data: { items: [], groups: [] } });
    }
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
    try {
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
        /* 2026-11：regex 源从 HTML/JSON 里抠出来的 URL 常带首尾引号（实测稀饭 web 源
           得到 `...022.mp4"`，代理直连 401）。出口统一清洗，避免把脏 URL 传给代理。 */
        const rawUrl = String(r.url).trim()
            .replace(/^[\s"']+|[\s"',;]+$/g, '')
            .replace(/\\\//g, '/');
        if (!/^https?:\/\//i.test(rawUrl)) {
            return res.json({ code: -1, msg: '解析到的播放地址不合法', via: r.via || '' });
        }

        const token = newToken({ headers: r.headers || {}, cookie: r.cookie || '' });
        const isHls = /\.m3u8(\?|$)/i.test(rawUrl);
        const streamUrl = `/api/media-source/${isHls ? 'stream' : 'seg'}?token=${encodeURIComponent(token)}&u=${encodeURIComponent(rawUrl)}`;
        res.json({
            code: 0,
            data: {
                url: rawUrl,
                streamUrl,
                kind: isHls ? 'hls' : 'mp4',
                sourceId: id,
                sourceName: s.name,
                from: r.from || url,
                via: r.via || 'regex'
            }
        });
    } catch (e) {
        // 解析器（尤其是浏览器嗅探）偶发抛错时必须给出 JSON，否则前端 fetch 永远等不到响应
        console.error('[media-source resolve]', (e && e.stack) || e);
        try { res.json({ code: -1, msg: '解析异常：' + (e && e.message || e) }); }
        catch (e2) { /* 头已发就放弃 */ }
    }
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

/** 代理入口的统一白名单校验：仅 http/https，且拒绝本机/私网/保留地址。
 *  返回规范化后的 URL；任何不合法输入直接抛错（调用方转 400）。 */
function assertSafeProxyUrl(raw) {
    let parsed;
    try { parsed = new URL(String(raw || '')); } catch (e) { throw new Error('地址不合法'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅允许 http/https');
    if (hostBlocked(parsed.href)) throw new Error('拒绝代理内网地址');
    return parsed.href;
}

function ctxOf(token) {
    const c = streamCtx.get(String(token || ''));
    if (!c) return null;
    if (Date.now() - c.at > CTX_TTL) { streamCtx.delete(token); return null; }
    return c;
}

/** m3u8：把分片和 KEY/MAP 的地址全部改写成走 /seg 的同源地址 */
function rewriteHlsPlaylist(text, baseUrl, token) {
    const abs = (line) => {
        try { return new URL(line, baseUrl).href; } catch (e) { return line; }
    };
    /* 输出的是播放列表文本，不是 HTML；URL 仍走完整百分号编码并额外转义双引号，
       避免任何来自上游的字符闭合 URI 属性。 */
    const DQ = String.fromCharCode(34);
    const proxied = (absUrl) => {
        const enc = encodeURIComponent(String(absUrl)).replace(/"/g, '%22');
        /* ★ 子播放列表走 /stream（会继续改写里面的分片地址）；分片/密钥走 /seg。
         *   早先一律走 /seg，导致二级 m3u8 里的相对 .ts 被 hls.js 解析成
         *   /<hash>.ts（404），表现为播放器一直转圈。 */
        const ep = /\.m3u8(?:$|[?#])/i.test(String(absUrl)) ? '/api/media-source/stream' : '/api/media-source/seg';
        return ep + '?token=' + encodeURIComponent(String(token || '')) + '&u=' + enc;
    };
    return String(text || '').split(/\r?\n/).map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
            // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-SESSION-KEY / #EXT-X-MEDIA 里的 URI 属性
            return t.replace(/URI=(["'])([^"']+)\1/g, (m, q, uri) => 'URI=' + q + proxied(abs(uri)) + q);
        }
        return proxied(abs(t));
    }).join('\n');
}

/* 封面图缓存：源站图床大多在境外，单张 1~8 秒。目录每次只变几分钟，
   把图片按「URL + Referer」缓在内存里，翻回书墙 / 切源 / 刷新都不用再等一轮。
   只缓存图片且单张 ≤ 4MB，视频分片走原来的流式路径，不进这里。 */
const coverCache = new Map();
const coverPending = new Map();
const COVER_MAX = 160;
const COVER_BYTES_MAX = 96 * 1024 * 1024;
let coverBytes = 0;

function coverGet(key) {
    const hit = coverCache.get(key);
    if (!hit) return null;
    hit.at = Date.now();
    return hit;
}

function coverPut(key, buf, ctype) {
    if (!buf || buf.length > 4 * 1024 * 1024 || !/^image\//i.test(ctype || '')) return;
    const old = coverCache.get(key);
    if (old) coverBytes -= old.buf.length;
    coverCache.set(key, { buf, ctype, at: Date.now() });
    coverBytes += buf.length;
    if (coverCache.size <= COVER_MAX && coverBytes <= COVER_BYTES_MAX) return;
    const drop = Array.from(coverCache.entries())
        .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    while (drop.length && (coverCache.size > COVER_MAX || coverBytes > COVER_BYTES_MAX)) {
        const [k, v] = drop.shift();
        coverCache.delete(k);
        coverBytes -= v.buf.length;
    }
}

async function fetchCover(u, ref, headers, cookie) {
    const withRef = Object.assign({}, headers || {});
    if (ref) withRef.Referer = ref;
    const noRef = Object.assign({}, headers || {});
    delete noRef.Referer;
    delete noRef.referer;
    let r = await engine.grab(u, { timeout: 30000, headers: noRef, cookie: cookie || '' });
    if (!r.ok || !r.buf || r.status === 401 || r.status === 403) {
        r = await engine.grab(u, { timeout: 30000, headers: withRef, cookie: cookie || '' });
    }
    return r;
}

/** 目录一返回就先并发预热首屏封面；浏览器随后请求时直接命中/并到同一份在途请求 */
function warmReadCovers(items, limit = 18) {
    const picked = (items || []).slice(0, limit).filter((it) => it && it.cover);
    if (!picked.length) return;
    pool(picked, 3, (it) => {
        const m = /[?&]u=([^&]+)/.exec(it.cover);
        if (!m) return null;
        const u = decodeURIComponent(m[1]);
        const ref = (() => {
            const r = /[?&]ref=([^&]+)/.exec(it.cover);
            return r ? decodeURIComponent(r[1]) : '';
        })();
        const key = u + '|' + ref;
        if (coverCache.has(key) || coverPending.has(key)) return null;
        const job = fetchCover(u, ref, {}, '').then((r) => {
            if (r && r.ok && r.buf) coverPut(key, r.buf, r.ctype);
            return r;
        }).catch(() => null).finally(() => coverPending.delete(key));
        coverPending.set(key, job);
        return job;
    }).catch(() => { /* 预热失败不影响目录 */ });
}

/** 分片 / mp4 字节流转发（支持 Range，拖动进度条要用） */
router.get('/seg', async (req, res) => {
    const u = String(req.query.u || '');
    if (!/^https?:\/\//i.test(u)) return res.status(400).json({ code: -1, msg: '地址不合法' });
    if (hostBlocked(u)) return res.status(400).json({ code: -1, msg: '拒绝代理内网地址' });

    const ctx = ctxOf(req.query.token) || {};
    // 在线阅读的图片：/seg?u=…&ref=<站点页>，只用来补 Referer，不接受任意请求头
    const refParam = String(req.query.ref || '');
    const refOk = /^https?:\/\//i.test(refParam) && !hostBlocked(refParam);
    if (refOk) ctx.headers = Object.assign({}, ctx.headers, { Referer: refParam });
    const range = req.headers.range;
    const baseHeaders = {};
    const isImageReq = /^image\//i.test(String(req.query.img || ''));
    const keyLocked = isImageReq || !!refParam;
    // 整文件媒体（mp4/mp3…）与 HLS 分片（.ts/.m4s）区别对待：
    // 源站的开放式 Range（bytes=0-）实测会拖到超时，必须改成有界窗口；
    // HLS 分片不带 Range 时不能只探 1 字节，否则分片被截断。
    const fileLike = !keyLocked && /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|flac|wav)(?:$|[?#])/i.test(u);
    const RANGE_WINDOW = 8 * 1024 * 1024;
    let upstreamRange = range;
    if (fileLike && range) {
        const m = /^bytes=(\d+)-(\d*)$/i.exec(String(range).trim());
        if (m) {
            const start = Number(m[1]);
            const asked = m[2] ? Number(m[2]) : start + RANGE_WINDOW - 1;
            upstreamRange = 'bytes=' + start + '-' + Math.min(asked, start + RANGE_WINDOW - 1);
        }
    }
    if (upstreamRange) baseHeaders.Range = upstreamRange;
    else if (fileLike) baseHeaders.Range = 'bytes=0-' + (RANGE_WINDOW - 1);
    // Komiic 章节图要 X-Image-Ticket；只对 komiic 域名放行这一个头，别的地方一律忽略
    const xt = String(req.query.xt || '');
    try {
        const h = new URL(u).hostname;
        if (xt && /(^|\.)komiic\.com$/i.test(h)) baseHeaders['X-Image-Ticket'] = xt;
    } catch (e) { /* 上面已校验过 URL */ }

    const coverKey = u + '|' + (refOk ? refParam : '');
    const cached = coverGet(coverKey);
    if (cached) {
        res.status(200);
        res.set('Content-Type', cached.ctype);
        res.set('Cache-Control', 'public, max-age=604800');
        return res.end(cached.buf);
    }

    /* ★ 防盗链的两个方向都存在，实测必须两种都试：
     *   有的 CDN 只认 Referer（不给就 403），有的正好相反（给了 Referer 反而 403，
     *   不带才 200 —— 嘀嗒影视走的小红书 CDN 就是这样）。
     *   所以先不带 Referer 试，被拒再带 Referer 重试一次。 */
    const reqHeaders = Object.assign({}, baseHeaders, ctx.headers || {});
    // 图片缓冲用于缓存；视频/分片必须边下边发，不能等整个文件 arrayBuffer 完成。
    const streaming = !keyLocked;
    if (streaming) {
        const grabOnce = (hdrs) => engine.grab(u, { timeout: 30000, headers: hdrs, cookie: ctx.cookie || '', stream: true });
        let r = await grabOnce(reqHeaders);
        /* 2026-11：防盗链的另一面 —— 有的 CDN 给了 Referer 反而直接 400
           （实测稀饭 Next 的 apn.moedot.net：不带 Referer 206，带就 400）。
           流媒体失败且状态是 400/401/403 时，剥掉 Referer 再试一次。 */
        if ((!r.ok || !r.body) && [400, 401, 403].includes(Number(r.status))) {
            const noRef = Object.assign({}, reqHeaders);
            delete noRef.Referer;
            delete noRef.referer;
            if (Object.keys(noRef).length !== Object.keys(reqHeaders).length) {
                try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) { /* ignore */ }
                r = await grabOnce(noRef);
            }
        }
        if (!r.ok || !r.body) return res.status(502).json({ code: -1, msg: '分片拉取失败：' + (r.error || ('HTTP ' + r.status)) });
        res.status(r.status || 200);
        res.set('Content-Type', r.ctype || 'application/octet-stream');
        for (const h of ['content-length', 'content-range', 'accept-ranges']) {
            const v = r.headers.get(h);
            if (v) res.set(h, v);
        }
        if (!r.headers.get('accept-ranges')) res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'no-cache');
        try {
            await pipeline(Readable.fromWeb(r.body), res);
        } catch (e) {
            // 客户端暂停后关页会断开响应，属于正常取消，不应再写第二个错误响应。
            if (!res.headersSent && !res.destroyed) res.status(502).end();
        }
        return;
    }

    // 图片可能是首屏预热发起的同一张图：并到同一个在途请求，别重复打源站
    let r;
    if (keyLocked && coverPending.has(coverKey)) {
        r = await coverPending.get(coverKey);
    } else {
        const job = fetchCover(u, '', reqHeaders, ctx.cookie || '');
        if (keyLocked) {
            coverPending.set(coverKey, job);
            job.catch(() => null).finally(() => coverPending.delete(coverKey));
        }
        r = await job;
    }
    if (!r.ok || !r.buf) {
        return res.status(502).json({ code: -1, msg: '分片拉取失败：' + (r.error || ('HTTP ' + r.status)) });
    }
    if (keyLocked) coverPut(coverKey, r.buf, r.ctype);
    res.status(r.status || 200);
    res.set('Content-Type', r.ctype || 'application/octet-stream');
    if (keyLocked) res.set('Cache-Control', 'public, max-age=604800');
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

/** round182 P0-3：订阅新鲜度（前端进追番页时检查，过期自动刷新） */
router.get('/freshness', (req, res) => {
    res.json({ code: 0, data: engine.subscriptionFreshness() });
});

/* ---------------- Kazumi 规则自动更新 ----------------
 * POST /api/media-source/refresh-kazumi   拉 KazumiRules 官方仓库
 *   body: { force?: true }  force=忽略版本对比、全部重拉
 * 站点改版只需上游更新规则，用户点一下就能救回来，不必等应用发版。
 */
router.post('/refresh-kazumi', async (req, res) => {
    try {
        const force = !!(req.body && req.body.force);
        const r = await engine.refreshKazumiRules({ force });
        if (r.error) return res.json({ code: -1, msg: r.error, data: r });
        res.json({
            code: 0,
            msg: 'Kazumi 规则已检查：更新 ' + r.updated + ' / 跳过 ' + r.skipped + (r.failed ? ' / 失败 ' + r.failed : ''),
            data: r,
        });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/** Kazumi 规则新鲜度：本地 kazumi 目录最新 mtime */
router.get('/kazumi-freshness', (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const dirs = [path.join(engine.BUILTIN_DIR, 'kazumi'), path.join(engine.OVERRIDE_DIR, 'kazumi')];
        let latest = 0;
        let count = 0;
        for (const d of dirs) {
            let files = [];
            try { files = fs.readdirSync(d); } catch (e) { continue; }
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                try {
                    const m = fs.statSync(path.join(d, f)).mtimeMs;
                    if (m > latest) latest = m;
                    count++;
                } catch (e) { /* 忽略 */ }
            }
        }
        const ageDays = latest ? (Date.now() - latest) / 86400000 : null;
        res.json({ code: 0, data: {
            lastRefresh: latest,
            ageDays: ageDays == null ? null : Math.round(ageDays * 10) / 10,
            stale: ageDays == null || ageDays > 7,
            count,
        } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// ==================================================================
// round185 A2：人机验证救回（有头浏览器过验证 → 存 cookie 复用）
// ==================================================================
/**
 * 打开一个可见浏览器让用户过验证。★ 这是**长请求**（最多 2 分钟），
 * 前端必须给 loading 态，不能当普通接口调。
 */
router.post('/verify', async (req, res) => {
    try {
        const sourceId = String((req.body && req.body.sourceId) || '');
        if (!sourceId) return res.json({ code: -1, msg: '缺少 sourceId' });
        const r = await require('../utils/media-sources/verify').verifySource(sourceId, {
            timeout: Number(req.body && req.body.timeout) || 120000,
            url: req.body && req.body.url
        });
        if (r.ok && r.passed) {
            engine.clearCooldown(sourceId);   // 过了验证就没必要再冷却
            return res.json({ code: 0, msg: `验证通过，已保存 ${r.cookies} 条 Cookie`, data: r });
        }
        res.json({ code: 1, msg: r.reason || '验证未通过', data: r });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/** 有没有正在跑的验证窗口（前端防重复点） */
router.get('/verify-status', (req, res) => {
    let busy = null;
    try { busy = require('../utils/media-sources/verify').verifyBusy(); } catch (e) { /* 模块没加载 */ }
    res.json({ code: 0, data: { busy } });
});

/** 清除某源保存的 Cookie（验证失效/换号时用） */
router.post('/clear-cookie', (req, res) => {
    try {
        const sourceId = String((req.body && req.body.sourceId) || '');
        if (!sourceId) return res.json({ code: -1, msg: '缺少 sourceId' });
        engine.clearSourceCookies(sourceId);
        res.json({ code: 0, data: { cleared: sourceId } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// ==================================================================
// 在线阅读（r155 · 阶段3）：漫画章节图 / 小说正文 → 应用内原生阅读器
// ==================================================================
router.get('/reading/adapters', (req, res) => {
    res.json({ code: 0, data: reading.listAdapters() });
});

router.get('/reading/catalog', async (req, res) => {
    const ad = reading.getAdapter(req.query.adapter);
    if (!ad) return res.json({ code: -1, msg: '未知阅读适配器' });
    try {
        const items = await reading.catalogCached(ad.id, req.query.force === '1');
        warmReadCovers(items);
        res.json({ code: 0, data: { adapter: ad.id, name: ad.name, kind: ad.kind, count: items.length, items } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.get('/reading/chapters', async (req, res) => {
    const ad = reading.getAdapter(req.query.adapter);
    if (!ad) return res.json({ code: -1, msg: '未知阅读适配器' });
    const url = String(req.query.url || '');
    if (!/^https?:\/\//i.test(url) || hostBlocked(url)) return res.json({ code: -1, msg: '地址不合法' });
    try {
        const d = await ad.chapters(url);
        res.json({ code: 0, data: { ...d, count: d.chapters.length } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.get('/reading/chapter', async (req, res) => {
    const ad = reading.getAdapter(req.query.adapter);
    if (!ad) return res.json({ code: -1, msg: '未知阅读适配器' });
    const url = String(req.query.url || '');
    if (!/^https?:\/\//i.test(url) || hostBlocked(url)) return res.json({ code: -1, msg: '地址不合法' });
    try {
        const d = await ad.read(url);
        res.json({ code: 0, data: { kind: ad.kind, ...d } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/* HLS 主播放列表代理（/stream）单独成文件：只做 m3u8 拉取 + 地址重写，
   输出走临时文件 sendFile，避免远程文本被当作文档回显。 */
router.use(require('./media-source-stream')({ engine, ctxOf, assertSafeProxyUrl, rewriteHlsPlaylist }));

module.exports = router;

/* ---------------- Kazumi 规则自动更新调度 ----------------
 * 启动 90 秒后静默检查一次（避开启动高峰），之后每 12 小时一次。
 * 只在有版本变化时写盘；失败静默（下次再试），不打扰用户。
 * unref() 让定时器不阻止进程退出。 */
(function installKazumiRuleSync() {
    const run = () => {
        Promise.resolve()
            .then(() => engine.refreshKazumiRules({}))
            .then((r) => {
                if (r && r.updated > 0) {
                    console.log('[kazumi] 规则自动更新 ' + r.updated + ' 份（来源 ' + r.mirror + '）');
                }
            })
            .catch(() => { /* 网络不可达时静默跳过 */ });
    };
    const first = setTimeout(run, 90 * 1000);
    if (first && typeof first.unref === 'function') first.unref();
    const timer = setInterval(run, 12 * 60 * 60 * 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
})();
