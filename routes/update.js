/**
 * routes/update.js — 应用内更新（round31）
 *
 * GET  /api/update/status     当前版本 + 上次检查结果 + 下载进度（前端轮询这个）
 * POST /api/update/check      立即查 GitHub（body: {force:1} 跳过缓存）
 * POST /api/update/download   下载指定安装包（body: {assetName}，缺省用推荐项）
 * POST /api/update/cancel     取消下载
 * POST /api/update/install    拉起安装程序（便携版改为打开下载目录）
 * POST /api/update/open-folder 打开更新包所在目录
 */

const express = require('express');
const router = express.Router();
const updater = require('../utils/updater');

/* 同一时刻只允许一个下载任务 —— 两个 107MB 的流同时写盘既慢又容易把
 * 进度条搞乱，前端按钮本来也就只允许点一次。 */
let busy = false;

router.get('/status', (req, res) => {
    try {
        res.json({ code: 0, data: updater.status() });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/check', async (req, res) => {
    try {
        const force = !!(req.body && req.body.force);
        const r = await updater.checkUpdate(force);
        res.json({ code: 0, data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/download', async (req, res) => {
    if (busy) return res.json({ code: -1, msg: '已有下载任务在进行中' });
    busy = true;
    try {
        const name = (req.body && req.body.assetName) || '';
        const r = await updater.startDownload(name);
        res.json({ code: 0, data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    } finally {
        busy = false;
    }
});

router.post('/cancel', (req, res) => {
    const ok = updater.cancelDownload();
    res.json({ code: ok ? 0 : -1, msg: ok ? '已取消' : '当前没有进行中的下载' });
});

router.post('/install', (req, res) => {
    try {
        const name = (req.body && req.body.assetName) || '';
        const r = updater.installDownloaded(name);
        res.json(r.ok ? { code: 0, data: r } : { code: -1, msg: r.msg });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/open-folder', (req, res) => {
    try {
        const p = (req.body && req.body.file) || '';
        const ok = updater.openFolder(p || null);
        res.json(ok ? { code: 0 } : { code: -1, msg: '打开目录失败' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
