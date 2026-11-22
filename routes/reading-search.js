/**
 * 漫画跨源搜索路由（第四批）
 * ------------------------------------------------------------------
 * 单独成文件：发出搜索请求的所有目标 host 都在本文件显式白名单校验，
 * 用户输入只作为书名关键词编码进固定 URL，绝不当主机使用（SSRF 防线）。
 * 挂载点：/api/media-source/reading/search（与 media-source router 同前缀）。
 */
const express = require('express');
const router = express.Router();
const reading = require('../utils/media-sources/reading');

// 只允许访问这几个固定域名；任何其它 host、内网/保留地址一律拒绝
const ALLOW_HOSTS = new Set(['www.dm5.com', 'manhua.zaimanhua.com', 'komiic.com']);
const SEARCH_ENDPOINTS = [
    'https://www.dm5.com/search',
    'https://manhua.zaimanhua.com/app/v1/search/index',
    'https://komiic.com/api/query',
];
function assertSafeTargets() {
    for (const u of SEARCH_ENDPOINTS) {
        let p;
        try { p = new URL(u); } catch (e) { throw new Error('搜索目标配置无效'); }
        if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error('搜索协议不允许');
        const h = p.hostname.toLowerCase();
        if (h === 'localhost' || h === '::1' || h === '[::1]'
            || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
            || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)
            || /^0\./.test(h) || /\.local$/.test(h) || /\.internal$/.test(h)) {
            throw new Error('搜索目标含内网/保留地址');
        }
        if (!ALLOW_HOSTS.has(h)) throw new Error('搜索目标不在白名单');
    }
    return true;
}
assertSafeTargets();

// 只保留书名常用字符，剔除所有 URL 控制字符（/?&#:% 等），从源头杜绝注入
function cleanQuery(raw) {
    return String(raw || '').replace(/[<>?"'\\/:#%&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const TTL = 60 * 1000;
const cache = new Map();

router.get('/reading/search', async (req, res) => {
    const q = cleanQuery(req.query.q);
    if (!q) return res.json({ code: -1, msg: '缺少搜索关键词' });
    try {
        assertSafeTargets(); // 请求前复核：目标 host 合法且非内网
    } catch (e) {
        return res.json({ code: -1, msg: e.message });
    }
    const kind = req.query.kind === 'novel' ? 'novel' : 'manga';
    const key = kind + '|' + q;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return res.json({ code: 0, data: hit.data, cached: true });
    try {
        const groups = await reading.searchAll(q, { kind });
        const data = { query: q, kind, groups };
        cache.set(key, { at: Date.now(), data });
        res.json({ code: 0, data });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
