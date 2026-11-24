/**
 * routes/enrich.js —— 漫画/小说元数据补齐（round169）
 *
 *   GET  /api/enrich/status            各库元数据覆盖现状
 *   POST /api/enrich/library  {lib,limit,dryRun,minScore}
 *
 * 说明：同步执行（每条 ~0.6s 限流），所以 limit 上限 30（约 30~45 秒）。
 *       默认 dryRun=true —— 必须先看「会写什么」再决定落库。
 */

const express = require('express');
const router = express.Router();
const { enrichLibrary, coverage, LIB_TYPE } = require('../utils/enrich');

function isDryRun(v, dflt) {
    if (v === undefined || v === null || v === '') return dflt;
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    return !(s === '0' || s === 'false' || s === 'no');
}

router.get('/status', (req, res) => {
    try {
        res.json({ code: 0, data: coverage(), libs: Object.keys(LIB_TYPE) });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/library', async (req, res) => {
    try {
        const body = req.body || {};
        const lib = String(body.lib || '');
        if (!LIB_TYPE[lib]) return res.status(400).json({ code: -1, msg: `不支持的库：${lib}（可选 ${Object.keys(LIB_TYPE).join(' / ')}）` });
        const dryRun = isDryRun(body.dryRun, true);
        const limit = Math.min(30, Math.max(1, parseInt(body.limit, 10) || 10));
        const minScore = body.minScore;
        const sinceId = Math.max(0, parseInt(body.sinceId, 10) || 0);
        const started = Date.now();
        const r = await enrichLibrary(lib, { limit, dryRun, minScore, sinceId });
        res.json({
            code: 0,
            data: { lib, dryRun, sinceId, lastId: r.items.length ? r.items[r.items.length - 1].id : sinceId, ...r.stats, elapsedMs: Date.now() - started, items: r.items }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;