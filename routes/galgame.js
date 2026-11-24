// ================================================================
// routes/galgame.js —— GALGAME 资料库
//   GET  /api/galgame/list?source=kungal|inari&page=&limit=&sort=&q=&nsfw=
//   GET  /api/galgame/detail?source=&id=
//   GET  /api/galgame/resources?id=                         Kungal 作品资源列表
//   POST /api/galgame/download  {source, resourceId}         兑换下载地址（Kungal 发券）
//   GET  /api/galgame/inari-download?id=                     解析 Inari 直链（302 → URL）
//   GET  /api/galgame/rank?source=inari
//   GET  /api/galgame/sources                                三站可用性
//
// 数据源：Kungal 主源（匿名 /api/v1）、InariGal 补充直链下载；
// TouchGal 受 Cloudflare 保护，仅作为外部入口（见 sourcesStatus）。
// ================================================================
const express = require('express');
const router = express.Router();
const gal = require('../utils/galgame');

router.get('/sources', async (req, res) => {
    try { res.json({ code: 0, data: await gal.sourcesStatus() }); }
    catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/list', async (req, res) => {
    try {
        const source = String(req.query.source || 'kungal');
        const nsfw = req.query.nsfw === '1' || req.query.nsfw === 'true';
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 24));
        if (source === 'inari') {
            const d = await gal.inariList({
                page, pageSize: limit, q: String(req.query.q || '').trim(),
            });
            if (!nsfw) d.items = d.items.filter((x) => !x.nsfw);
            return res.json({ code: 0, data: d });
        }
        if (source !== 'kungal') return res.json({ code: -1, msg: '未知来源：' + source });
        res.json({ code: 0, data: await gal.kungalList({
            page, limit,
            sort: String(req.query.sort || 'resource_updated_desc'),
            q: String(req.query.q || '').trim(), nsfw,
        }) });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/rank', async (req, res) => {
    try {
        const nsfw = req.query.nsfw === '1' || req.query.nsfw === 'true';
        if (String(req.query.source || 'inari') !== 'inari') {
            // Kungal 没有独立下载榜，用「最多浏览」当发现榜
            return res.json({ code: 0, data: await gal.kungalList({ page: 1, limit: 24, sort: 'view_desc', nsfw }) });
        }
        const d = await gal.inariRank();
        if (!nsfw) d.items = d.items.filter((x) => !x.nsfw);
        res.json({ code: 0, data: d });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/detail', async (req, res) => {
    try {
        const source = String(req.query.source || 'kungal');
        const id = String(req.query.id || '');
        if (!id) return res.json({ code: -1, msg: '缺少 id' });
        const data = source === 'inari' ? await gal.inariDetail(id) : await gal.kungalDetail(id);
        res.json({ code: 0, data });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/resources', async (req, res) => {
    try {
        const id = String(req.query.id || '');
        if (!id) return res.json({ code: -1, msg: '缺少作品 id' });
        res.json({ code: 0, data: await gal.kungalResources(id, req.query.page, req.query.limit) });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/download', async (req, res) => {
    try {
        const source = String(req.body.source || 'kungal');
        const rid = String(req.body.resourceId || '');
        if (!rid) return res.json({ code: -1, msg: '缺少 resourceId' });
        if (source === 'inari') {
            const url = await gal.inariDownloadUrl(rid);
            return res.json({ code: 0, data: { source, urls: [url], code: '', password: '' } });
        }
        res.json({ code: 0, data: await gal.kungalDownload(rid) });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/* Inari 直链解析：前端也可以直接点 /inari-download?id= 让浏览器 302 */
router.get('/inari-download', async (req, res) => {
    try {
        const id = Number(req.query.id);
        if (!id) return res.status(400).json({ code: -1, msg: '缺少 id' });
        const url = await gal.inariDownloadUrl(id);
        res.json({ code: 0, data: { url } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
