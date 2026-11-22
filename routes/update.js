/**
 * routes/update.js — 应用内更新（round31）
 *
 * GET  /api/update/status     当前版本 + 上次检查结果 + 下载进度（前端轮询这个）
 * POST /api/update/check      立即查 GitHub（body: {force:1} 跳过缓存）
 * POST /api/update/download   下载指定安装包（body: {assetName}，缺省用推荐项）
 * POST /api/update/incremental 增量 patch 下载+校验（M2，不切换；失败回退全量）
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

/**
 * POST /api/update/incremental — M2：增量 patch 下载 + 校验（不切换）。
 * 增量失败一律回退 A 方案全量下载（兼容 A 方案，controller 裁定）。
 *
 * 安全：绝不把 req.body 整包传给 startIncremental —— 其 opts 含 baseline /
 * baselinePath / runtimeDir 等特权字段，一旦由客户端控制即可操纵 patch 文件名
 * 与本地改动检测根目录。这里只取 assetName 这类无害标量，其余选项由服务端派生。
 */
router.post('/incremental', async (req, res) => {
    if (busy) return res.json({ code: -1, msg: '已有下载任务在进行中' });
    busy = true;
    try {
        const r = await updater.startIncremental({
            assetName: (req.body && typeof req.body.assetName === 'string') ? req.body.assetName : '',
            // baseline / baselinePath / runtimeDir 由 startIncremental 内部按服务端状态派生，
            // 不从请求体读取；验签公钥只从 CV_UPDATE_PUBLIC_KEY 环境变量读取。
        });
        res.json({ code: 0, data: r });
    } catch (e) {
        // 增量失败 → 自动回退全量下载（A 方案）
        try {
            const name = (req.body && req.body.assetName) || '';
            const full = await updater.startDownload(name);
            res.json({
                code: 0,
                data: Object.assign({ mode: 'full' }, full, {
                    incrementalError: (e && e.message) || '增量更新失败',
                }),
            });
        } catch (e2) {
            res.json({ code: -1, msg: (e && e.message || '增量失败') + '；全量回退也失败: ' + (e2 && e2.message) });
        }
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
        // 安装程序已拉起：通知 Electron 主进程主动退出，避免占用 exe 让 NSIS 安装卡住。
        // NSIS 配了 runAfterFinish=true，安装完会自动启动新版；这里只写信号，不拼任何命令。
        if (r.ok && r.mode === 'launch') {
            try {
                const fs = require('fs');
                const path = require('path');
                fs.writeFileSync(path.join(updater.updateDir(), 'quit-for-install.json'),
                    JSON.stringify({ at: Date.now() }), 'utf8');
            } catch (e) { /* 信号写失败不阻断安装（最坏仍需用户手动关闭应用） */ }
        }
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


/* ============================================================
 * round72 · 注册到全局任务中心（右上角进度胶囊 / AI 查任务状态共用）
 * 状态变量是本文件的模块级 let，外部读不到，故在此显式注册。
 * ============================================================ */
try {
    const __taskStatus = require('../utils/task-status');
    __taskStatus.registerRouteTask('update-download', { name: '更新包下载', icon: '⬇️' }, () => updater.status());
} catch (e) { /* 任务中心不可用不应影响主流程 */ }
