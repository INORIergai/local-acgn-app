const express = require('express');
const router = express.Router();
const {
  getAllActresses,
  getFollowedActresses,
  getActressById,
  toggleActressFollow,
  getMoviesByActress,
  getActressesWithoutAvatar,
  getActressAvatarStats,
  updateActressProfile
} = require('../utils/db');
const {
  fetchActressProfile,
  avatarFileName,
  AVATAR_DIR
} = require('../utils/crawler/actress-avatar');
const fs = require('fs');
const path = require('path');

// 女优列表
router.get('/', (req, res) => {
    try {
        const list = getAllActresses.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 头像刮削进度（前端轮询）
router.get('/avatar-stats', (req, res) => {
    try {
        res.json({ code: 0, data: { ...getActressAvatarStats(), running: avatarJob.running, progress: avatarJob } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ============ 女优头像/档案批量刮削 ============
// 串行 + 限速：javbus 对并发很敏感，一次只跑一个，每个之间 sleep。
// 任务在后台跑，前端轮询 /avatar-stats 看进度。
let avatarJob = { running: false, done: 0, total: 0, ok: 0, fail: 0, current: '', startedAt: 0 };

async function runAvatarScrape({ onlyWithMovies = true, limit = 0 } = {}) {
    if (avatarJob.running) return;
    avatarJob = { running: true, done: 0, total: 0, ok: 0, fail: 0, current: '', startedAt: Date.now() };

    try {
        const rows = getActressesWithoutAvatar.all({
            onlyWithMovies: onlyWithMovies ? 1 : 0,
            limit: limit > 0 ? limit : 100000
        });
        avatarJob.total = rows.length;
        console.log(`[女优头像] 开始刮削，待处理 ${rows.length} 位`);

        for (const a of rows) {
            avatarJob.current = a.name;
            try {
                const prof = await fetchActressProfile(a.name);
                if (prof && (prof.avatarFile || prof.birthday || prof.height)) {
                    updateActressProfile.run({
                        name: a.name,
                        avatar: prof.avatarFile || '',
                        birthday: prof.birthday || '',
                        height: prof.height || 0
                    });
                    avatarJob.ok++;
                } else {
                    avatarJob.fail++;
                }            } catch (e) {
                avatarJob.fail++;
            }
            avatarJob.done++;
            // 限速：javbus 高频会 403，间隔 700ms（与 config.network.requestInterval 对齐）
            await new Promise(r => setTimeout(r, 700));
        }
        console.log(`[女优头像] 完成：成功 ${avatarJob.ok} / 失败 ${avatarJob.fail} / 共 ${avatarJob.total}`);
    } catch (e) {
        console.log('[女优头像] 任务异常:', e.message);
    } finally {
        avatarJob.running = false;
        avatarJob.current = '';
    }
}

// 启动批量刮削
router.post('/scrape-avatars', (req, res) => {
    try {
        if (avatarJob.running) return res.json({ code: -1, msg: '已有刮削任务在运行' });
        const onlyWithMovies = req.body?.all !== true;
        const limit = parseInt(req.body?.limit) || 0;
        res.json({ code: 0, msg: '已开始后台刮削女优头像' });
        runAvatarScrape({ onlyWithMovies, limit });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 单个女优刮削（卡片上的小按钮）
router.post('/:id/scrape-avatar', async (req, res) => {
    try {
        const item = getActressById.get(req.params.id);
        if (!item) return res.json({ code: -1, msg: '女优不存在' });
        const prof = await fetchActressProfile(item.name);
        if (!prof) return res.json({ code: -1, msg: '未在 javbus 找到该女优' });
        updateActressProfile.run({
                        name: item.name,
                        avatar: prof.avatarFile || '',
                        birthday: prof.birthday || '',
                        height: prof.height || 0
                    });
        res.json({ code: 0, data: { ...getActressById.get(req.params.id) } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 关注的女优
router.get('/followed/list', (req, res) => {
    try {
        const list = getFollowedActresses.all();
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 女优详情
router.get('/:id', (req, res) => {
    try {
        const item = getActressById.get(req.params.id);
        if (!item) return res.json({ code: -1, msg: '不存在' });
        res.json({ code: 0, data: item });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 女优的作品列表
router.get('/:id/movies', (req, res) => {
    try {
        const movies = getMoviesByActress.all(req.params.id);
        res.json({ code: 0, data: movies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 关注/取消关注
router.post('/:id/follow', (req, res) => {
    try {
        toggleActressFollow.run(req.params.id);
        const item = getActressById.get(req.params.id);
        res.json({ code: 0, data: { followed: item?.followed === 1 } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
