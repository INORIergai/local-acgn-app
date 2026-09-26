const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const configPath = process.env.CONFIG_FILE || './config.json';
const config = require(configPath);

const app = express();
const PORT = config.serverPort || 3000;

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ====================== round34 入口与密码时机改造 ======================
// 旧版：启用密码时访问 library.html 直接 302 到登录页 → 用户永远进不了首页，
//       一开机就被迫先选库。新版：library.html 匿名可开，默认落在首页；
//       受保护的库（AV/里番/漫画/小说）在**点击导航时**由前端弹密码框（gate.js），
//       影视/动漫库与首页/ACG榜单免密；API 层保留服务端会话校验（前端 401 统一拉起密码框）。
const cookieParser = require('cookie-parser');
app.use(cookieParser());

const { sessionMiddleware, isAuthEnabled, validateSession } = require('./utils/auth');

// 兜底：任何未捕获异常都不要杀掉服务进程。
// 此前一次 EIO（坏目录/掉盘）就能让整个影库服务崩掉，前端表现为「点了没反应」。
process.on('uncaughtException', (e) => {
    console.error('[未捕获异常] 服务继续运行:', e && (e.stack || e.message || e));
});
process.on('unhandledRejection', (e) => {
    console.error('[未处理的Promise拒绝]:', e && (e.stack || e.message || e));
});

// API 级守卫（round34 白名单制）：
//   - 启用密码时，公开接口（首页/榜单/影视库/动漫库所需）无需会话；
//   - 其余接口仍要求服务端会话（前端统一捕 401 弹密码框）。
// 公开前缀：/auth 登录本身、/acg ACG热度榜（首页）、/ai/chat + /ai/status（首页 AI 对话）。
const { db } = require('./utils/db');

/** 该影片行是否属于「免密码」的普通内容库（影视/动漫） */
function isPublicMovieType(type) {
    return type === 'film' || type === 'cartoon';
}

const PUBLIC_API_PREFIXES = ['/auth', '/acg', '/ai/chat', '/ai/status'];

app.use('/api', (req, res, next) => {
    if (!isAuthEnabled()) return next();

    // 1) 前缀白名单
    if (PUBLIC_API_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/') || req.path.startsWith(p + '?'))) {
        return next();
    }

    // 2) 影视/动漫库的定向放行（普通内容，家人可看）
    try {
        // 影片列表：仅显式 ?type=film|cartoon 时放行（type=all 会带出 AV，必须拦）
        if (req.method === 'GET' && req.path === '/movie') {
            const t = String(req.query.type || '');
            if (isPublicMovieType(t)) return next();
            return sessionMiddleware(req, res, next);
        }
        // 影片详情/播放：按记录的 type 查库放行（film/cartoon 免密）
        const detailMatch = req.path.match(/^\/movie\/(?:play\/)?(\d+)$/);
        if (detailMatch && (req.method === 'GET' || req.method === 'POST')) {
            const row = db.prepare('SELECT type FROM movies WHERE id = ?').get(detailMatch[1]);
            if (row && isPublicMovieType(row.type)) return next();
        }
        // 海报图：按 posterPath 反查所属影片的 type（封面文件名是不可逆 hash，反查不到就拦）
        const posterMatch = req.method === 'GET' && req.path.match(/^\/movie\/poster\/([^/]+)$/);
        if (posterMatch) {
            const row = db.prepare(
                "SELECT type FROM movies WHERE posterPath = 'cache/posters/' || ? OR posterPath LIKE '%' || ? LIMIT 1"
            ).get(posterMatch[1], posterMatch[1]);
            if (row && isPublicMovieType(row.type)) return next();
        }
        // 统计总览：仅 ?type=film|cartoon 放行（侧栏计数）
        if (req.method === 'GET' && req.path === '/stats/overview' && isPublicMovieType(String(req.query.type || ''))) {
            return next();
        }
    } catch (e) {
        // 查库失败按未授权处理，宁可多拦不可漏拦
        return sessionMiddleware(req, res, next);
    }

    return sessionMiddleware(req, res, next);
});
// =====================================================================

// 托管前端静态页面 public 文件夹
app.use(express.static(path.join(__dirname, 'public')));

// 托管 pdf.js 库（漫画 PDF 阅读）
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));

// 挂载所有路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/movie', require('./routes/movie'));
app.use('/api/scanner', require('./routes/scanner'));
app.use('/api/actress', require('./routes/actress'));
app.use('/api/tags', require('./routes/tags'));
app.use('/api/recommend', require('./routes/recommend'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/config', require('./routes/config'));
app.use('/api/playlist', require('./routes/playlist'));
app.use('/api/notification', require('./routes/notification'));
app.use('/api/new-release', require('./routes/new-release'));
// 在线观看：先挂详情接口，再把「整站反代」挂到根路径下的 /{站点key}/*
// 反代必须在 express.static 之后、页面 fallback 之前 —— 它会接管 /netflav/xxx 这类路径。
const webviewRouter = require('./routes/webview');
app.use('/api/webview', webviewRouter);

const webviewProxy = require('./routes/webview-proxy');
// 复用 webview 的地址探测（带缓存），避免同一站点被探测两次、拿到不同镜像
webviewProxy.bindResolver(webviewRouter.resolveSite);
// CF 挑战站（如 jable）的 HTML 文档要靠持久 Chromium 渲染才拿得到，
// 这里把渲染器注入反代，避免两个模块互相 require 成环。
webviewProxy.bindBrowser(webviewRouter.withBrowser);
app.use('/', webviewProxy);
app.use('/api/update', require('./routes/update'));   // round31：应用内更新
app.use('/api/ai', require('./routes/ai'));
app.use('/api/cloud', require('./routes/cloud'));
app.use('/api/comic', require('./routes/comic'));
app.use('/api/novel', require('./routes/novel'));
app.use('/api/acg', require('./routes/acg'));   // round33：ACG 热度榜

// 【修复Cannot GET 404】html页面fallback，防止静态路由找不到文件
app.get('*.html', (req, res) => {
    const filePath = path.join(__dirname, 'public', req.path);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('页面不存在');
    }
});

// 自动创建海报缓存目录
const cacheDir = path.join(__dirname, 'cache/posters');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// 女优头像目录：刮削下来的头像落在这里，前端通过 /avatars/xxx.jpg 访问。
// 必须显式挂静态服务 —— data/ 不在 public/ 下，不挂会 404。
const avatarDir = path.join(__dirname, 'data/avatars');
if (!fs.existsSync(avatarDir)) fs.mkdirSync(avatarDir, { recursive: true });
app.use('/avatars', express.static(avatarDir, { maxAge: '7d' }));

// 个性化背景图（设置 → 个性化 上传的主页/banner 底图），同 data/ 不在 public/ 下，需显式挂载
const customDir = path.join(__dirname, 'data/custom');
if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true });
app.use('/custom', express.static(customDir, { maxAge: '7d' }));
app.use('/api/customization', require('./routes/customization'));

// 首页跳转入口页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// 局域网展示地址：优先 config.lan（容器内探测到的是 172.x 容器网段，手机连不上）
const { lanInfo } = require('./utils/config');
const LAN = lanInfo();

// 启动监听
app.listen(PORT, '0.0.0.0', () => {
    console.log('=============================================');
    console.log(`本地影库服务启动成功`);
    console.log(`本机访问：http://localhost:${LAN.port}`);
    console.log(`局域网访问（手机用这个）：${LAN.url}`);
    console.log(`手机扫码或输入上面的局域网地址即可访问`);
    console.log(`扫描目录：${config.scanFolders.join('、')}`);
    console.log('=============================================');

    // ★ 目录监控（round28）：开应用自启动，不需要手动点任何东西。
    //   不新增服务/守护进程/计划任务 —— 代码就在这个 Node 进程里，应用关掉即归零。
    //   两条通道：Windows fs.watch 事件通道（亚秒级，负责快）+ 退避轮询（负责不漏）。
    //   轮询间隔：起始 5 秒，每轮没扫到新增就翻倍，上限 1 小时；一有新增立刻回到 5 秒。
    //   只在启动增量扫描跑完之后挂上，避免两者同时处理同一个新文件。
    const startDirWatch = () => {
        if (process.env.DISABLE_WATCH) {
            console.log('[目录监控] 已禁用（DISABLE_WATCH）');
            return;
        }
        try {
            require('./utils/dir-watch').start();
        } catch (e) {
            console.log('[目录监控] 启动失败:', (e && e.message) || e);
        }
    };

    // 启动时自动执行快速增量扫描（设环境变量 DISABLE_AUTO_SCAN=1 可禁用；桌面版默认开启）
    // 各模块必须串行：共用扫描状态会让后启动的模块直接跳过（历史上动漫扫描就是这么被吞掉的）
    if (!process.env.DISABLE_AUTO_SCAN) {
        const { startQuickScan, startAnimeQuickScan } = require('./utils/scanner');
        const { startComicQuickScan } = require('./utils/comic-scanner');
        const { startNovelQuickScan } = require('./utils/novel-scanner');
        setTimeout(async () => {
            console.log('[启动] 正在执行快速增量扫描...');
            /* ★ round26 #4：把本次启动扫描「新增了什么」记下来，供前端展示。
             *   实现在 utils/startup-scan-report.js，前端读 GET /api/scanner/startup-report。
             *   取新增条目的判据：扫描前后 MAX(id) 之间新插入的行（movies.id 是 AUTOINCREMENT）。 */
            const report = require('./utils/startup-scan-report');
            const { db } = require('./utils/db');
            const jobs = [
                ['影片', startQuickScan],
                ['动漫', startAnimeQuickScan],
                ['漫画', startComicQuickScan],
                ['小说', startNovelQuickScan]
            ];
            const maxIdNow = () => {
                try { return db.prepare('SELECT IFNULL(MAX(id),0) AS m FROM movies').get().m; }
                catch (e) { return 0; }
            };
            report.begin();
            for (const [name, run] of jobs) {
                report.setCurrent(name);
                const before = maxIdNow();
                const t0 = Date.now();
                let err = '';
                try {
                    await run();
                    console.log(`[启动] ${name}扫描完成！`);
                } catch (e) {
                    err = e.message;
                    console.log(`[启动] ${name}扫描失败:`, e.message);
                }
                let addedRows = [];
                try {
                    addedRows = db.prepare(
                        'SELECT id, title, fileName, filePath, type, addedTime FROM movies WHERE id > ? ORDER BY id'
                    ).all(before);
                } catch (e) { /* 统计失败不影响扫描本身 */ }
                report.endJob(name, {
                    added: addedRows.length,
                    addedRows: addedRows,
                    elapsedMs: Date.now() - t0,
                    error: err
                });
                if (addedRows.length) {
                    console.log(`[启动] ${name}新增 ${addedRows.length} 部`);
                }
            }
            report.end();
            console.log('[启动] 快速增量扫描全部结束');
            startDirWatch();
        }, 1000);
    } else {
        console.log('[启动] 已禁用自动扫描（DISABLE_AUTO_SCAN）');
        setTimeout(startDirWatch, 3000);
    }

    /* ★ 启动时静默检查一次更新（round31）
     *   只打一次 GitHub 公开接口比对版本号，不下载、不弹窗。
     *   结果缓存 5 分钟，前端进「设置 → 版本」时直接读 /api/update/status，
     *   不用再等一次网络往返。失败一律静默 —— 网络不通是最常见的情况，不该打扰用户。 */
    setTimeout(async () => {
        try {
            const u = require('./utils/updater');
            if (!u.updaterConfig().autoCheck) {
                console.log('[更新] 启动检查已关闭（config.update.autoCheck=false）');
                return;
            }
            const r = await u.checkUpdate(true);
            if (r.error) {
                console.log('[更新] 启动检查未拿到结果：' + r.error);
            } else {
                console.log(`[更新] 本地 v${r.current} / 远端 ${r.release.tag} → ${r.hasUpdate ? '发现新版本' : '已是最新'}`);
            }
        } catch (e) {
            console.log('[更新] 启动检查异常（已忽略）: ' + ((e && e.message) || e));
        }
    }, 5000);

    // 启动新作监控定时任务（每6小时检查一次）
    // 全库遍历是「分片轮转」的：每轮只扫 60 位女优，所以 6 小时一轮能持续覆盖全库。
    const { getChecker } = require('./utils/new-release-checker');
    setTimeout(() => {
        console.log('[启动] 初始化女优新作监控（全库分片）...');
        const checker = getChecker();
        // 启动10分钟后第一次检查
        setTimeout(() => {
            console.log('[女优新作监控] 执行首次检查...');
            checker.checkAll();
        }, 10 * 60 * 1000);

        // 每6小时检查一次
        setInterval(() => {
            console.log('[女优新作监控] 定时检查...');
            checker.checkAll();
        }, 6 * 60 * 60 * 1000);
    }, 2000);

    // 启动漫画新作监控定时任务（每12小时检查一次）
    const { getChecker: getComicChecker } = require('./utils/comic-new-release');
    setTimeout(() => {
        console.log('[启动] 初始化漫画新作监控（kmoe 全库分片）...');
        const checker = getComicChecker();
        // 启动15分钟后第一次检查
        setTimeout(() => {
            console.log('[漫画新作监控] 执行首次检查...');
            checker.checkAll();
        }, 15 * 60 * 1000);

        // 每12小时检查一次
        setInterval(() => {
            console.log('[漫画新作监控] 定时检查...');
            checker.checkAll();
        }, 12 * 60 * 60 * 1000);
    }, 3000);
});