// ================================================================
// routes/gamekee.js —— GameKee 游戏资料页
//   GET /api/gamekee/games?q=             游戏库（本地名称/别名过滤）
//   GET /api/gamekee/game?id=             游戏详情（简介/截图/资讯）
//   GET /api/gamekee/tree?gameId=&pid=    目录树（懒加载）
//   GET /api/gamekee/articles?gameId=&page=&limit=
//   GET /api/gamekee/article?id=          文章正文（HTML 已清洗 / 块 JSON 已转义）
//
// GameKee 全站 SPA，正文只能走 /v1/**；所有请求在 utils/gamekee.js 里
// 统一带 Game-Id 头，并做内容清洗后再回给前端。
// ================================================================
const express = require('express');
const router = express.Router();
const gk = require('../utils/gamekee');

router.get('/games', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const items = await gk.searchGames(q, req.query.force === '1');
        res.json({ code: 0, data: { query: q, items } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/game', async (req, res) => {
    try {
        const id = Number(req.query.id);
        if (!id) return res.json({ code: -1, msg: '缺少 game id' });
        res.json({ code: 0, data: await gk.game(id) });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/tree', async (req, res) => {
    try {
        const gameId = Number(req.query.gameId);
        if (!gameId) return res.json({ code: -1, msg: '缺少 gameId' });
        res.json({ code: 0, data: { nodes: await gk.tree(gameId, req.query.pid || 0) } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/articles', async (req, res) => {
    try {
        const gameId = Number(req.query.gameId);
        if (!gameId) return res.json({ code: -1, msg: '缺少 gameId' });
        res.json({ code: 0, data: await gk.articles(gameId, req.query.page, req.query.limit) });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/article', async (req, res) => {
    try {
        const id = Number(req.query.id);
        if (!id) return res.json({ code: -1, msg: '缺少文章 id' });
        res.json({ code: 0, data: await gk.article(id) });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
