const express = require('express');
const router = express.Router();
const {
  getStats,
  getStatsByType,
  getStatsByProducer,
  getStatsByYear,
  getTopActresses,
  getTopTags,
  getWatchHistory,
  getStatsByResolution,
  getStatsByDuration,
  getStatsByFormat
} = require('../utils/db');

// 总览统计（支持 ?type=jav/anime/comic/novel 按库过滤）
router.get('/overview', (req, res) => {
    try {
        const type = req.query.type;
        const stats = type ? getStatsByType.get(type) : getStats.get();
        res.json({ code: 0, data: stats });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 按片商统计
router.get('/by-producer', (req, res) => {
    try {
        const list = getStatsByProducer.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 按年份统计
router.get('/by-year', (req, res) => {
    try {
        const list = getStatsByYear.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 女优排行
router.get('/top-actresses', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const list = getTopActresses.all().slice(0, limit);
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 标签排行
router.get('/top-tags', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 30;
        const list = getTopTags.all().slice(0, limit);
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 观看历史
router.get('/watch-history', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const list = getWatchHistory.all(limit, offset);
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 按分辨率统计
router.get('/by-resolution', (req, res) => {
    try {
        const list = getStatsByResolution.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 按时长统计
router.get('/by-duration', (req, res) => {
    try {
        const list = getStatsByDuration.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 按文件格式统计
router.get('/by-format', (req, res) => {
    try {
        const list = getStatsByFormat.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== 年度观影报告 ==========
// 汇总指定年份：播放/入库按月分布、总时长、TOP女优/标签/影片、收藏、阅读时长
router.get('/annual', (req, res) => {
    try {
        const db = require('../utils/db').db;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const yearStart = new Date(`${year}-01-01T00:00:00`).getTime();
        const yearEnd = new Date(`${year + 1}-01-01T00:00:00`).getTime();

        // 播放次数按月分布
        const playsByMonth = db.prepare(`
            SELECT strftime('%m', datetime(playTime / 1000, 'unixepoch', 'localtime')) as month,
                   COUNT(*) as plays, COUNT(DISTINCT movieId) as uniqueMovies
            FROM watch_history
            WHERE playTime >= ? AND playTime < ?
            GROUP BY month ORDER BY month
        `).all(yearStart, yearEnd);

        // 入库量按月分布
        const addedByMonth = db.prepare(`
            SELECT strftime('%m', datetime(addedTime / 1000, 'unixepoch', 'localtime')) as month,
                   COUNT(*) as added
            FROM movies
            WHERE addedTime >= ? AND addedTime < ?
            GROUP BY month ORDER BY month
        `).all(yearStart, yearEnd);

        // 年度观看总时长（按影片时长累计）
        const watchSummary = db.prepare(`
            SELECT COUNT(*) as totalPlays,
                   COUNT(DISTINCT wh.movieId) as uniqueMovies,
                   COALESCE(SUM(m.duration), 0) as totalMinutes
            FROM watch_history wh
            JOIN movies m ON m.id = wh.movieId
            WHERE wh.playTime >= ? AND wh.playTime < ?
        `).get(yearStart, yearEnd);

        // TOP 女优（按年内播放次数）
        const topActresses = db.prepare(`
            SELECT a.id, a.name, a.avatar, COUNT(wh.id) as playCount
            FROM watch_history wh
            JOIN movie_actress ma ON ma.movieId = wh.movieId
            JOIN actresses a ON a.id = ma.actressId
            WHERE wh.playTime >= ? AND wh.playTime < ?
            GROUP BY a.id ORDER BY playCount DESC LIMIT 10
        `).all(yearStart, yearEnd);

        // TOP 标签
        const topTags = db.prepare(`
            SELECT t.id, t.name, COUNT(wh.id) as playCount
            FROM watch_history wh
            JOIN movie_tag mt ON mt.movieId = wh.movieId
            JOIN tags t ON t.id = mt.tagId
            WHERE wh.playTime >= ? AND wh.playTime < ?
            GROUP BY t.id ORDER BY playCount DESC LIMIT 10
        `).all(yearStart, yearEnd);

        // 最常播放的影片
        const topMovies = db.prepare(`
            SELECT wh.movieId as id, m.title, m.avid, m.localPosterPath, m.posterPath,
                   COUNT(wh.id) as playCount
            FROM watch_history wh
            JOIN movies m ON m.id = wh.movieId
            WHERE wh.playTime >= ? AND wh.playTime < ?
            GROUP BY wh.movieId ORDER BY playCount DESC LIMIT 10
        `).all(yearStart, yearEnd);

        // 年内新增按库分布
        const addedByType = db.prepare(`
            SELECT type, COUNT(*) as count FROM movies
            WHERE addedTime >= ? AND addedTime < ?
            GROUP BY type
        `).all(yearStart, yearEnd);

        // 年内阅读时长（分钟）按类型
        const readingSummary = db.prepare(`
            SELECT type, COALESCE(SUM(duration), 0) as totalMinutes
            FROM reading_history
            WHERE readDate >= ? AND readDate < ?
            GROUP BY type
        `).all(yearStart, yearEnd);

        // 有记录的年份列表（供年份切换）
        const availableYears = db.prepare(`
            SELECT DISTINCT CAST(strftime('%Y', datetime(playTime / 1000, 'unixepoch', 'localtime')) AS INTEGER) as year
            FROM watch_history UNION
            SELECT DISTINCT CAST(strftime('%Y', datetime(addedTime / 1000, 'unixepoch', 'localtime')) AS INTEGER) as year
            FROM movies WHERE addedTime > 0
            ORDER BY year DESC
        `).all().map(r => r.year).filter(Boolean);

        res.json({
            code: 0,
            data: {
                year,
                playsByMonth,
                addedByMonth,
                watchSummary,
                topActresses,
                topTags,
                topMovies,
                addedByType,
                readingSummary,
                availableYears
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
