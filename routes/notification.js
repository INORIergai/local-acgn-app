const express = require('express');
const router = express.Router();
const {
    getAllNotifications,
    getUnreadNotificationCount,
    addNotification,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification
} = require('../utils/db');

// 获取所有通知
router.get('/', (req, res) => {
    try {
        const list = getAllNotifications.all();
        const unreadCount = getUnreadNotificationCount.get();
        res.json({ 
            code: 0, 
            data: {
                list,
                unreadCount: unreadCount?.count || 0
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取未读数量
router.get('/unread-count', (req, res) => {
    try {
        const result = getUnreadNotificationCount.get();
        res.json({ code: 0, data: result?.count || 0 });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 标记已读
router.post('/read/:id', (req, res) => {
    try {
        markNotificationRead.run(req.params.id);
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 全部标记已读
router.post('/read-all', (req, res) => {
    try {
        markAllNotificationsRead.run();
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 删除通知
router.delete('/:id', (req, res) => {
    try {
        deleteNotification.run(req.params.id);
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 手动添加通知（测试用）
router.post('/add', (req, res) => {
    try {
        const { type, title, content, url, cover, extra } = req.body;
        addNotification.run(type || 'info', title, content || '', url || '', cover || '', extra ? JSON.stringify(extra) : '', Date.now());
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
