const express = require('express');
const router = express.Router();
const { startFullScan, startQuickScan, getScanStatus, getAnimeScanStatus, startAnimeQuickScan, startRescrapeFailed, getRescrapeStatus } = require('../utils/scanner');
const { startComicQuickScan, getComicScanStatus } = require('../utils/comic-scanner');
const { startNovelQuickScan, getNovelScanStatus } = require('../utils/novel-scanner');
const { previewRename, startBatchRename, getRenameStatus } = require('../utils/rename-service');
const { getAllScrapeFailures } = require('../utils/db');
const { toHostPath } = require('../utils/path-map');
const dirWatch = require('../utils/dir-watch');
// 修复：补充缺失的定时器变量定义，解决 scanStatusTimer is not defined
let scanStatusTimer = null;

// ========== 刮削失败管理 ==========
// 失败列表（关联影片信息用于展示）
router.get('/failures', (req, res) => {
    try {
        const list = getAllScrapeFailures.all().map(f => ({
            ...f,
            hostPath: toHostPath(f.filePath),
            title: f.title || f.fileName
        }));
        res.json({ code: 0, data: list });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 一键重刮（仅失败项）
router.post('/rescrape-failed', (req, res) => {
    const st = getRescrapeStatus();
    if (st.running) {
        return res.json({ code: -1, msg: '重刮正在进行中' });
    }
    setImmediate(() => startRescrapeFailed());
    res.json({ code: 0, msg: '一键重刮已启动' });
});

// 重刮状态轮询
router.get('/rescrape-failed/status', (req, res) => {
    res.json({ code: 0, data: getRescrapeStatus() });
});

/* ★ round26 #4：本次「启动自动增量扫描」的过程与结果
 * 前端在 init 时拉一次并轮询，用来显示「正在扫描本地库…」与「本次新增 N 部」，
 * 并给一个「📥 查看新增」入口（跳入库时间线）。 */
router.get('/startup-report', (req, res) => {
    try {
        res.json({ code: 0, data: require('../utils/startup-scan-report').get() });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== 目录监控（round28 · 开应用自启动，无需手动开启） ==========
// 注意（铁律 #6）：本文件没有裸 /:id 路由，但新增静态路由仍一律放在业务路由之前，
// 避免以后有人加了 /:id 把它们吃掉。

/** 监控状态：当前通道、轮询间隔（含退避后的实时值）、下次检查时间、最近发现 */
router.get('/watch-status', (req, res) => {
    try {
        res.json({ code: 0, data: dirWatch.getStatus() });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/** 手动立即检查一次（前端「🔄 检查新增」按钮）。检查完把轮询节奏拉回起始间隔。 */
router.post('/watch-now', async (req, res) => {
    try {
        const st = dirWatch.getStatus();
        if (st.running) return res.json({ code: -1, msg: '正在检查中，请稍候' });
        const found = await dirWatch.scanNow();
        res.json({ code: 0, data: { found }, msg: found > 0 ? `发现 ${found} 个新文件，正在入库` : '本次没有发现新文件' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/** 运行时开关（不用改配置重启）。body: { enabled: true|false } */
router.post('/watch-toggle', (req, res) => {
    try {
        const enabled = dirWatch.setEnabled(req.body && req.body.enabled !== false);
        res.json({ code: 0, data: { enabled }, msg: enabled ? '目录监控已开启' : '目录监控已关闭' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 开始全量扫描
router.post('/start', (req, res) => {
    const status = getScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startFullScan());
    res.json({ code: 0, msg: '全量扫描已启动' });
});

// 开始快速扫描（增量）
router.post('/quick', (req, res) => {
    const status = getScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startQuickScan());
    res.json({ code: 0, msg: '快速扫描已启动' });
});

// 扫描影片模块
router.post('/movie', (req, res) => {
    const status = getScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startQuickScan());
    res.json({ code: 0, msg: '影片扫描已启动' });
});

// 扫描动漫模块
router.post('/anime', (req, res) => {
    const status = getAnimeScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startAnimeQuickScan());
    res.json({ code: 0, msg: '动漫扫描已启动' });
});

// 扫描漫画模块
router.post('/comic', (req, res) => {
    const status = getScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startComicQuickScan());
    res.json({ code: 0, msg: '漫画扫描已启动' });
});

// 扫描小说模块
router.post('/novel', (req, res) => {
    const status = getScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startNovelQuickScan());
    res.json({ code: 0, msg: '小说扫描已启动' });
});

// 获取扫描状态
router.get('/status', (req, res) => {
    const module = req.query.module || 'movie';
    
    let status;
    switch (module) {
        case 'comic':
            status = getComicScanStatus();
            break;
        case 'anime':
            status = getAnimeScanStatus();
            break;
        case 'novel':
            status = getNovelScanStatus();
            break;
        default:
            status = getScanStatus();
    }
    
    res.json({ code: 0, data: status });
});

// 预览重命名
router.post('/rename/preview', async (req, res) => {
    try {
        const status = getRenameStatus();
        if (status.running) {
            return res.json({ code: -1, msg: '重命名正在进行中' });
        }
        setImmediate(async () => {
            await previewRename();
        });
        res.json({ code: 0, msg: '预览已启动' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取重命名预览列表
router.get('/rename/preview', (req, res) => {
    const status = getRenameStatus();
    res.json({ code: 0, data: status.previewList || [] });
});

// 开始批量重命名
router.post('/rename/start', (req, res) => {
    const status = getRenameStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '重命名正在进行中' });
    }
    setImmediate(() => startBatchRename());
    res.json({ code: 0, msg: '批量重命名已启动' });
});

// 获取重命名状态
router.get('/rename/status', (req, res) => {
    res.json({ code: 0, data: getRenameStatus() });
});

// 批量导出NFO状态
let exportNfoStatus = {
    running: false,
    total: 0,
    current: 0,
    success: 0,
    failed: 0,
    skipped: 0
};

// 批量导出NFO
router.post('/export-nfo', async (req, res) => {
    if (exportNfoStatus.running) {
        return res.json({ code: -1, msg: '正在导出中，请稍候' });
    }
    
    const { overwrite = false } = req.body || {};
    
    exportNfoStatus = {
        running: true,
        total: 0,
        current: 0,
        success: 0,
        failed: 0,
        skipped: 0
    };
    
    res.json({ code: 0, msg: '已开始批量导出NFO' });
    
    // 后台执行
    (async () => {
        const db = require('../utils/db');
        const { generateNfo } = require('../utils/nfo_utils');
        const path = require('path');
        const fs = require('fs');
        
        const movies = db.getAllMovies();
        exportNfoStatus.total = movies.length;
        
        for (let i = 0; i < movies.length; i++) {
            const movie = movies[i];
            exportNfoStatus.current = i + 1;
            
            try {
                const dir = path.dirname(movie.filePath);
                const stem = path.basename(movie.filePath, path.extname(movie.filePath));
                const nfoPath = path.join(dir, `${stem}.nfo`);
                
                // 如果已经存在且不覆盖，跳过
                if (fs.existsSync(nfoPath) && !overwrite) {
                    exportNfoStatus.skipped++;
                    continue;
                }
                
                // 获取女优和标签
                const actresses = db.getMovieActresses(movie.id) || [];
                const tags = db.getMovieTags(movie.id) || [];
                
                // 生成NFO
                generateNfo({
                    ...movie,
                    num: movie.avid,
                    genres: tags.map(t => t.name),
                    actresses: actresses.map(a => a.name)
                }, nfoPath);
                
                exportNfoStatus.success++;
                
            } catch (e) {
                exportNfoStatus.failed++;
            }
        }
        
        exportNfoStatus.running = false;
    })();
});

// 获取导出NFO状态
router.get('/export-nfo/status', (req, res) => {
    res.json({ code: 0, data: exportNfoStatus });
});

module.exports = router;