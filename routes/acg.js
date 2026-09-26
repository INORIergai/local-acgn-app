// ================================================================
// routes/acg.js —— ACG 热度榜接口（round33）
//   GET  /api/acg/rank?source=acghub|fankuhub|all&force=1
//   GET  /api/acg/cover?u=<图片URL>          —— 封面本地缓存代理
//   POST /api/acg/refresh                     —— 强制刷新缓存
// ================================================================

const express = require('express');
const router = express.Router();
const acg = require('../utils/acg-rank');

// 榜单：单个来源或全部
router.get('/rank', async (req, res) => {
    try {
        const source = (req.query.source || 'all').toString();
        const force = req.query.force === '1' || req.query.force === 'true';
        if (source === 'all') {
            const r = await acg.getBoth({ force });
            return res.json({ code: 0, data: r.data, errors: r.errors });
        }
        if (source !== 'acghub' && source !== 'fankuhub') {
            return res.json({ code: -1, msg: '未知榜单来源：' + source });
        }
        const r = await acg.getRank(source, { force });
        res.json({ code: 0, data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 封面代理（本地缓存）
router.get('/cover', async (req, res) => {
    try {
        const u = (req.query.u || '').toString();
        if (!/^https?:\/\//i.test(u)) {
            return res.status(400).json({ code: -1, msg: '图片地址无效' });
        }
        const r = await acg.getCover(u);
        const ext = (u.match(/\.(webp|png|jpe?g|gif)(\?|$)/i) || [])[1] || 'img';
        const mime = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[ext] || 'image/*';
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(r.bytes);
    } catch (e) {
        res.status(502).json({ code: -1, msg: '封面抓取失败：' + e.message });
    }
});

// 详情（round34 批次B）：榜单条目点开 → 应用内详情弹窗
router.get('/detail', async (req, res) => {
    try {
        const source = (req.query.source || '').toString();
        const id = (req.query.id || '').toString();
        const scope = (req.query.scope || '').toString();
        if (!id) return res.json({ code: -1, msg: '缺少 id' });
        const d = source === 'fankuhub'
            ? await acg.fetchFankuDetail(id)
            : await acg.fetchAcghubDetail(id, scope);
        res.json({ code: 0, data: d });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 强制刷新
router.post('/refresh', async (req, res) => {
    try {
        const r = await acg.getBoth({ force: true });
        res.json({ code: 0, data: r.data, errors: r.errors });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
