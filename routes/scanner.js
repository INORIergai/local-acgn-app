const express = require('express');
const router = express.Router();
const { startFullScan, startQuickScan, getScanStatus, getAnimeScanStatus, startAnimeQuickScan, startRescrapeFailed, getRescrapeStatus } = require('../utils/scanner');
const { startComicQuickScan, getComicScanStatus } = require('../utils/comic-scanner');
const { startNovelQuickScan, getNovelScanStatus } = require('../utils/novel-scanner');
const { previewRename, startBatchRename, getRenameStatus } = require('../utils/rename-service');
const { getAllScrapeFailures } = require('../utils/db');
const { toHostPath } = require('../utils/path-map');
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