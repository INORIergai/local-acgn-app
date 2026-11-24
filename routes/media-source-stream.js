/**
 * routes/media-source-stream.js —— HLS 主播放列表代理
 * ------------------------------------------------------------------
 * 单独成文件的原因：这里只做「拉 m3u8 → 把每一条分片/子播放列表地址
 * 改写成同源 /seg 代理」，不涉及任何 HTML 渲染。媒体源主路由把
 * engine / 上下文 / URL 白名单校验以依赖注入方式传进来，避免循环 require。
 *
 * 安全：
 *   · URL 只接受 http/https，且拒绝 localhost/私网/保留地址（调用方已校验，
 *     这里再校验一次，防止后续新增调用点绕过）。
 *   · 播放列表先落成临时文件再 sendFile —— 响应是磁盘上的 .m3u8 资源，
 *     永远不会被当成 HTML 文档解析；文件名是内容 SHA-256，只含十六进制。
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.resolve(os.tmpdir(), 'cinemavault-hls');
const NAME_RE = /^[0-9a-f]{64}\.m3u8$/;
const MAX_AGE_MS = 10 * 60 * 1000;
let requests = 0;

function playlistFile(text) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const name = crypto.createHash('sha256').update(text).digest('hex') + '.m3u8';
    if (!NAME_RE.test(name)) throw new Error('非法缓存文件名');
    const file = path.resolve(CACHE_DIR, name);
    // 边界校验：拼出来的路径必须仍在固定的缓存目录内
    if (path.dirname(file) !== CACHE_DIR || !file.startsWith(CACHE_DIR + path.sep)) {
        throw new Error('缓存路径越界');
    }
    if (!fs.existsSync(file)) fs.writeFileSync(file, text, 'utf8');
    return file;
}

/** 顺带清理 10 分钟前的旧列表，避免临时目录无限增长 */
function sweepOld() {
    let names = [];
    try { names = fs.readdirSync(CACHE_DIR); } catch (e) { return; }
    const now = Date.now();
    for (const n of names) {
        if (!NAME_RE.test(n)) continue;
        const f = path.resolve(CACHE_DIR, n);
        if (path.dirname(f) !== CACHE_DIR) continue;
        try {
            const st = fs.statSync(f);
            if (now - st.mtimeMs > MAX_AGE_MS) fs.unlinkSync(f);
        } catch (e) { /* 被并发删除就跳过 */ }
    }
}

module.exports = function makeStreamRouter({ engine, ctxOf, assertSafeProxyUrl, rewriteHlsPlaylist }) {
    const router = express.Router();

    router.get('/stream', async (req, res) => {
        let u;
        try { u = assertSafeProxyUrl(req.query.u); }
        catch (e) { return res.status(400).json({ code: -1, msg: e.message }); }

        const ctx = ctxOf(req.query.token) || {};
        const r = await engine.grab(u, {
            timeout: 15000,
            headers: ctx.headers || {},
            cookie: ctx.cookie || '',
        });
        if (!r.ok || !r.text) {
            return res.status(502).json({ code: -1, msg: '拉取 m3u8 失败：' + (r.error || ('HTTP ' + r.status)) });
        }

        const out = rewriteHlsPlaylist(r.text, u, String(req.query.token || ''));
        let file;
        try { file = playlistFile(out); }
        catch (e) { return res.status(500).json({ code: -1, msg: '播放列表缓存写入失败' }); }
        requests += 1;
        if (requests % 20 === 0) sweepOld();

        res.status(200);
        res.set('Cache-Control', 'no-cache');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.sendFile(file);
    });

    return router;
};
