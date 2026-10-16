const express = require('express');
const router = express.Router();
const { chat, recommendMovies } = require('../utils/ollama-client');
const { db } = require('../utils/db');

// AI对话
router.post('/chat', async (req, res) => {
    try {
        const { prompt } = req.body;
        const reply = await chat(prompt);
        res.json({ code: 0, data: reply });
    } catch (err) {
        res.json({ code: -1, msg: "AI请求失败：" + err.message });
    }
});

// 智能影片推荐
router.get('/recommend', async (req, res) => {
    try {
        const movies = db.getAllMovies.all().slice(0, 15);
        const result = await recommendMovies(movies);
        res.json({ code: 0, data: result });
    } catch (err) {
        res.json({ code: -1, msg: "推荐失败：" + err.message });
    }
});

module.exports = router;