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

// ====================== 服务端会话鉴权 ======================
// 旧版仅靠前端 cookie（isLogin=true 可伪造）且所有 /api/* 裸奔；
// 现改为服务端签发 httpOnly 会话，页面与 API 双层拦截。
// 注意：守卫必须在 express.static 之前，否则 library.html 会被静态服务直接放行。
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

// 页面级守卫：**启用访问密码时**，四个库（影片/动漫/漫画/小说）都要先登录。
// 未启用（config.auth.enabled=false）时全部放行 —— 这是默认状态。
//
// 【为什么不再按 type 区分】
// 旧逻辑只拦 jav/anime，漫画/小说免密。但 library.html 是「一体式」界面，
// 所有数据都要 /api/*；免密进去后接口全 401，界面直接变成半死状态
// （左侧计数全 0、点「设置」一片空白）。改成「启用密码就全要密码」后
// 这种状态不可能出现：要么免密且一切正常，要么没登录就被挡在登录页。
app.use((req, res, next) => {
    if (!isAuthEnabled()) return next();
    if (req.path === '/library.html') {
        const token = req.cookies && req.cookies.lml_session;
        if (!validateSession(token)) {
            const type = req.query.type || 'jav';
            return res.redirect('/login.html?type=' + encodeURIComponent(type));
        }
    }
    next();
});

// API 级守卫：启用访问密码时，只有 /api/auth（登录本身）放行，其余一律需要会话
app.use('/api', (req, res, next) => {
    if (!isAuthEnabled()) return next();
    if (req.path.startsWith('/auth')) return next();
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
app.use('/api/ai', require('./routes/ai'));
app.use('/api/cloud', require('./routes/cloud'));
app.use('/api/comic', require('./routes/comic'));
app.use('/api/novel', require('./routes/novel'));

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

    // 启动时自动执行快速增量扫描（Docker环境下可通过DISABLE_AUTO_SCAN禁用）
    // 各模块必须串行：共用扫描状态会让后启动的模块直接跳过（历史上动漫扫描就是这么被吞掉的）
    if (!process.env.DISABLE_AUTO_SCAN) {
        const { startQuickScan, startAnimeQuickScan } = require('./utils/scanner');
        const { startComicQuickScan } = require('./utils/comic-scanner');
        const { startNovelQuickScan } = require('./utils/novel-scanner');
        setTimeout(async () => {
            console.log('[启动] 正在执行快速增量扫描...');
            const jobs = [
                ['影片', startQuickScan],
                ['动漫', startAnimeQuickScan],
                ['漫画', startComicQuickScan],
                ['小说', startNovelQuickScan]
            ];
            for (const [name, run] of jobs) {
                try {
                    await run();
                    console.log(`[启动] ${name}扫描完成！`);
                } catch (e) {
                    console.log(`[启动] ${name}扫描失败:`, e.message);
                }
            }
        }, 1000);
    } else {
        console.log('[启动] 已禁用自动扫描（DISABLE_AUTO_SCAN）');
    }

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