/**
 * round72 · 全局任务中心 API
 *
 * 为什么单独一个文件：11 组后台任务的状态原先散在 5 个文件、各自一个 /status 路由，
 * 前端要写 6 套轮询，且进度大多渲染在设置弹窗的 div 里（弹窗一关就看不见）。
 * 这里聚合成一个接口，右上角胶囊一次 fetch 就能拿到全部进度。
 *
 *   GET  /api/tasks            全部任务
 *   GET  /api/tasks?active=1   只返回「正在跑 + 15 秒内刚完成」
 *   GET  /api/tasks?text=1     顺便给一段文字摘要（AI 工具用的就是它）
 */
const express = require('express');
const router = express.Router();
const taskStatus = require('../utils/task-status');

router.get('/', (req, res) => {
    try {
        const onlyActive = req.query.active === '1' || req.query.active === 'true';
        const list = taskStatus.allTasks({ onlyActive });
        if (req.query.text === '1' || req.query.text === 'true') {
            return res.json({ code: 0, data: { list, text: taskStatus.describeTasks() } });
        }
        const running = list.filter(t => t.running).length;
        res.json({ code: 0, data: { list, running, total: list.length } });
    } catch (e) {
        console.log('[任务中心] 查询异常', e.message);
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
