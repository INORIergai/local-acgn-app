const express = require('express');
const router = express.Router();
const { startFullScan, startQuickScan, getScanStatus, getAnimeScanStatus, startAnimeQuickScan, startRescrapeFailed, getRescrapeStatus, startFilmQuickScan, getFilmScanStatus, startCartoonQuickScan, getCartoonScanStatus } = require('../utils/scanner');
const { startComicQuickScan, getComicScanStatus } = require('../utils/comic-scanner');
const { startNovelQuickScan, getNovelScanStatus } = require('../utils/novel-scanner');
const { previewRename, startBatchRename, getRenameStatus } = require('../utils/rename-service');
const { getAllScrapeFailures, pruneDeadScrapeFailures } = require('../utils/db');
const { toHostPath } = require('../utils/path-map');
const dirWatch = require('../utils/dir-watch');
// 修复：补充缺失的定时器变量定义，解决 scanStatusTimer is not defined
let scanStatusTimer = null;

// ========== 刮削失败管理 ==========
// 失败列表（关联影片信息用于展示）
router.get('/failures', (req, res) => {
    try {
        /* round127：先清掉指向「已删影片 / 已消失文件」的记录，
         * 否则删片之后清单里永远挂着那几条，点刷新也只是重查同一张表。 */
        let pruned = 0;
        try { pruned = pruneDeadScrapeFailures(); } catch (e) { /* 清理失败照常返回列表 */ }
        const list = getAllScrapeFailures.all().map(f => ({
            ...f,
            hostPath: toHostPath(f.filePath),
            title: f.title || f.fileName
        }));
        res.json({ code: 0, data: list, pruned });
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

/** 手动立即检查一次（前端「🔄 检查新增」按钮）。
 *  ★ round110：busy 时禁止再返回「本次没有发现新文件」——那是谎话。
 *    scanNow 现在会分辨三种情况：别的扫描在跑（只发现 + 排队补检）/
 *    上一轮还没跑完 / 正常查完。discovered 始终是磁盘真实差集数
 *    （不受单轮 maxPerTick=200 上限影响），用户看到的就是硬盘上的真相。 */
router.post('/watch-now', async (req, res) => {
    try {
        const r = await dirWatch.scanNow();
        if (r.busy === 'checking') {
            return res.json({ code: -1, msg: '正在检查中，请稍候' });
        }
        if (r.busy === 'other-scan') {
            return res.json({
                code: 0,
                data: { found: 0, discovered: r.discovered, queued: true },
                msg: r.discovered > 0
                    ? `媒体库扫描正在进行：磁盘上已有 ${r.discovered} 个新文件，已排到扫描结束后自动入库`
                    : '媒体库扫描正在进行，扫描结束后会自动再查一次'
            });
        }
        const unstable = dirWatch.getStatus().lastUnstable || 0;
        let msg;
        if (r.found > 0) {
            msg = `发现 ${r.found} 个新文件，正在入库`;
        } else if (unstable > 0) {
            // 有文件但都不过稳定判据（大小/mtime 仍在变）——说清楚，别甩一句「没有新增」
            msg = `本次没有发现新文件（有 ${unstable} 个文件还在下载或拷贝中，完成后会自动入库）`;
        } else {
            msg = '本次没有发现新文件';
        }
        res.json({ code: 0, data: { found: r.found, discovered: r.discovered, queued: false, unstable }, msg });
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

// 扫描影视模块（round34 新四库）
router.post('/film', (req, res) => {
    const status = getFilmScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startFilmQuickScan());
    res.json({ code: 0, msg: '影视扫描已启动' });
});

// 扫描动漫模块（round34 新四库）
router.post('/cartoon', (req, res) => {
    const status = getCartoonScanStatus();
    if (status.running) {
        return res.json({ code: -1, msg: '扫描正在进行中' });
    }
    setImmediate(() => startCartoonQuickScan());
    res.json({ code: 0, msg: '动漫扫描已启动' });
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
        case 'film':
            status = getFilmScanStatus();
            break;
        case 'cartoon':
            status = getCartoonScanStatus();
            break;
        default:
            status = getScanStatus();
    }

    /* ★ round112：漫画/小说是两阶段扫描 —— Phase A 入库（几秒~几分钟）
     *   → Phase B 后台补封面（不联网）。第二阶段的进度也塞进这里，
     *   前端不用再开一条轮询，用户也能看到「已经入库了，封面还在补」。 */
    if (module === 'comic' || module === 'novel') {
        try {
            status.enrich = require('../utils/enrich-covers').getEnrichStatus();
        } catch (e) { /* 补图模块不可用不影响状态接口 */ }
    }

    res.json({ code: 0, data: status });
});

/* 网络刮削熔断状态（诊断用）：哪个源被暂停了、还剩多久、最近一次错误 */
router.get('/scrape-health', (req, res) => {
    try {
        res.json({ code: 0, data: require('../utils/scrape-guard').state() });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
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

/* ============================================================
 * round72 · 注册到全局任务中心（右上角进度胶囊 / AI 查任务状态共用）
 * 状态变量是本文件的模块级 let，外部读不到，故在此显式注册。
 * ============================================================ */
try {
    const __taskStatus = require('../utils/task-status');
    __taskStatus.registerRouteTask('export-nfo', { name: '批量导出 NFO', icon: '📤' }, () => exportNfoStatus);
} catch (e) { /* 任务中心不可用不应影响主流程 */ }
