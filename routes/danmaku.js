/**
 * routes/danmaku.js — 弹幕接口（round36 P0-1）
 *   POST /api/danmaku/match    { fileName } → { episodeId, animeTitle, episodeTitle } | null
 *   GET  /api/danmaku/comments?episodeId= → { comments: [{t,mode,color,text}] }
 *   GET  /api/danmaku/status   → { configured, appId }
 */
const express = require('express');
const danmaku = require('../utils/danmaku');

const router = express.Router();

router.post('/match', async (req, res) => {
    try {
        if (!danmaku.isConfigured()) {
            return res.json({ code: 2, msg: '弹弹play 未配置：设置 → 弹幕 中填入 AppId / AppSecret' });
        }
        const fileName = String(req.body?.fileName || '').trim();
        if (!fileName) return res.json({ code: -1, msg: 'fileName 不能为空' });
        const result = await danmaku.matchEpisode(fileName);
        res.json({ code: 0, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.get('/comments', async (req, res) => {
    try {
        if (!danmaku.isConfigured()) {
            return res.json({ code: 2, msg: '弹弹play 未配置' });
        }
        const id = parseInt(req.query.episodeId, 10);
        if (!id) return res.json({ code: -1, msg: 'episodeId 无效' });
        const comments = await danmaku.getComments(id, req.query.chConvert === '0' ? 0 : 1);
        res.json({ code: 0, data: { comments, count: comments.length } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.get('/status', (req, res) => {
    // 与 utils/danmaku.creds 同源：重读配置文件，保存即生效
    let appId = '';
    try {
        appId = (JSON.parse(require('fs').readFileSync(require('../utils/config').configPath, 'utf8')).danmaku?.appId || '').trim();
    } catch (e) { /* 保持空 */ }
    res.json({
        code: 0,
        data: {
            configured: danmaku.isConfigured(),
            appId
        },
    });
});

module.exports = router;
