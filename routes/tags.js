const express = require('express');
const router = express.Router();
const {
  getAllTags,
  getTagById,
  getMoviesByTag,
  getMoviesByTags,
  getTopTags
} = require('../utils/db');

// 标签列表（带影片数统计）
router.get('/', (req, res) => {
    try {
        const list = getAllTags.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 热门标签（标签云）
router.get('/top/list', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const list = getTopTags.all().slice(0, limit);
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 标签详情
router.get('/:id', (req, res) => {
    try {
        const item = getTagById.get(req.params.id);
        if (!item) return res.json({ code: -1, msg: '不存在' });
        res.json({ code: 0, data: item });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 单个标签的影片列表
router.get('/:id/movies', (req, res) => {
    try {
        const movies = getMoviesByTag.all(req.params.id);
        res.json({ code: 0, data: movies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 多标签组合筛选（同时包含所有标签）
router.post('/filter/movies', (req, res) => {
    try {
        const { tagIds } = req.body;
        if (!tagIds || !tagIds.length) {
            return res.json({ code: 0, data: [] });
        }
        const movies = getMoviesByTags(tagIds);
        res.json({ code: 0, data: movies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
