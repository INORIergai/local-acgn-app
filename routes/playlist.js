const express = require('express');
const router = express.Router();
const { db } = require('../utils/db');

// 获取所有播放列表
router.get('/', (req, res) => {
    try {
        const lists = db.prepare(`
            SELECT p.*, COUNT(pi.id) as movieCount
            FROM playlists p
            LEFT JOIN playlist_items pi ON pi.playlistId = p.id
            GROUP BY p.id
            ORDER BY p.createdAt DESC
        `).all();
        res.json({ code: 0, data: lists });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 创建播放列表
router.post('/create', (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) return res.json({ code: -1, msg: '名称不能为空' });
        
        const result = db.prepare(`
            INSERT INTO playlists (name, description, createdAt)
            VALUES (?, ?, ?)
        `).run(name, description || '', Date.now());
        
        res.json({ code: 0, data: { id: result.lastInsertRowid } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 删除播放列表
router.delete('/:id', (req, res) => {
    try {
        const id = req.params.id;
        db.prepare('DELETE FROM playlist_items WHERE playlistId = ?').run(id);
        db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
        res.json({ code: 0, msg: '删除成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取播放列表详情（包含影片）
router.get('/:id', (req, res) => {
    try {
        const id = req.params.id;
        const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
        if (!playlist) return res.json({ code: -1, msg: '播放列表不存在' });
        
        const movies = db.prepare(`
            SELECT m.*, pi.sortOrder
            FROM playlist_items pi
            JOIN movies m ON m.id = pi.movieId
            WHERE pi.playlistId = ?
            ORDER BY pi.sortOrder ASC
        `).all(id);
        
        playlist.movies = movies;
        playlist.movieCount = movies.length;
        
        res.json({ code: 0, data: playlist });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 添加影片到播放列表
router.post('/:id/add', (req, res) => {
    try {
        const playlistId = req.params.id;
        const { movieId } = req.body;
        
        // 检查是否已存在
        const exists = db.prepare('SELECT id FROM playlist_items WHERE playlistId = ? AND movieId = ?')
            .get(playlistId, movieId);
        if (exists) {
            return res.json({ code: -1, msg: '影片已在播放列表中' });
        }
        
        // 获取最大排序号
        const maxOrder = db.prepare('SELECT MAX(sortOrder) as max FROM playlist_items WHERE playlistId = ?')
            .get(playlistId);
        const sortOrder = (maxOrder?.max || 0) + 1;
        
        db.prepare(`
            INSERT INTO playlist_items (playlistId, movieId, sortOrder, addedAt)
            VALUES (?, ?, ?, ?)
        `).run(playlistId, movieId, sortOrder, Date.now());
        
        // 更新播放列表的影片数
        db.prepare('UPDATE playlists SET movieCount = movieCount + 1 WHERE id = ?').run(playlistId);
        
        res.json({ code: 0, msg: '添加成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 从播放列表移除影片
router.post('/:id/remove', (req, res) => {
    try {
        const playlistId = req.params.id;
        const { movieId } = req.body;
        
        db.prepare('DELETE FROM playlist_items WHERE playlistId = ? AND movieId = ?')
            .run(playlistId, movieId);
        
        // 更新播放列表的影片数
        db.prepare('UPDATE playlists SET movieCount = movieCount - 1 WHERE id = ?').run(playlistId);
        
        res.json({ code: 0, msg: '移除成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 调整影片顺序
router.post('/:id/reorder', (req, res) => {
    try {
        const playlistId = req.params.id;
        const { orders } = req.body; // [{movieId, sortOrder}]
        
        const stmt = db.prepare('UPDATE playlist_items SET sortOrder = ? WHERE playlistId = ? AND movieId = ?');
        
        const tx = db.transaction(() => {
            for (const item of orders) {
                stmt.run(item.sortOrder, playlistId, item.movieId);
            }
        });
        
        tx();
        
        res.json({ code: 0, msg: '排序已更新' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
