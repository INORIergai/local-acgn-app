/**
 * utils/media-sources/stream-tokens.js —— 播放代理的一次性 token
 * ------------------------------------------------------------------
 * resolve 出来的 Referer / UA / Cookie 不能塞进 URL（会被浏览器历史与日志看见），
 * 这里存内存并换成随机 token，由 /api/media-source/stream|seg 取回。
 * 追番后台下载也要用同一条代理链，所以把 token 存储抽成独立模块，
 * 路由与下载器共享同一个 Map。
 */
const crypto = require('crypto');

const CTX_TTL = 2 * 60 * 60 * 1000;
const streamCtx = new Map();

function newToken(ctx) {
    const token = crypto.randomBytes(16).toString('hex');
    streamCtx.set(token, Object.assign({}, ctx, { at: Date.now() }));
    if (streamCtx.size > 300) {
        const now = Date.now();
        for (const [k, v] of streamCtx) if (now - v.at > CTX_TTL) streamCtx.delete(k);
    }
    return token;
}

function ctxOf(token) {
    const c = streamCtx.get(String(token || ''));
    if (!c) return null;
    if (Date.now() - c.at > CTX_TTL) { streamCtx.delete(token); return null; }
    return c;
}

/** 把真流地址包装成同源代理路径（m3u8 走 /stream，其它走 /seg） */
function buildStreamUrl(rawUrl, headers, cookie) {
    const url = String(rawUrl || '').trim();
    const token = newToken({ headers: headers || {}, cookie: cookie || '' });
    const isHls = /\.m3u8(\?|$)/i.test(url);
    return '/api/media-source/' + (isHls ? 'stream' : 'seg')
        + '?token=' + encodeURIComponent(token) + '&u=' + encodeURIComponent(url);
}

module.exports = { newToken, ctxOf, buildStreamUrl, CTX_TTL };
