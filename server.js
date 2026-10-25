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

// ====================== round117：响应 gzip 压缩（零依赖，替代 compression） ======================
// 为什么要自己写：node_modules 里没有 compression，而弱网/手机端首屏最缺的就是压缩。
// 策略：拦截 write/end，攒够后一次性 zlib.gzipSync；只压文本类，绝不碰视频流与 206。
const zlib = require('zlib');

/** 可压缩类型白名单（图片/视频/APK/字体本身已压缩，不压；SSE 也不能缓冲） */
const GZIP_TYPE_RE = /^(?:text\/(?!event-stream)|application\/(?:json|ld\+json|javascript|x-javascript|ecmascript|xml|xhtml\+xml|rss\+xml|atom\+xml)|image\/svg\+xml)/i;

function appendVaryEncoding(res) {
    const prev = res.getHeader('Vary');
    if (!prev) { res.setHeader('Vary', 'Accept-Encoding'); return; }
    const list = String(prev).split(',').map(s => s.trim().toLowerCase());
    if (list.indexOf('accept-encoding') === -1) res.setHeader('Vary', String(prev) + ', Accept-Encoding');
}

function gzipMiddleware() {
    const MIN_SIZE = 1024;                 // 小于 1KB 压了反而更慢
    const MAX_BUFFER = 4 * 1024 * 1024;    // 超 4MB 放弃压缩、原样透传（代理大文件不撑爆内存）

    function toBuf(chunk, encoding) {
        if (chunk == null) return null;
        if (Buffer.isBuffer(chunk)) return chunk;
        if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        return Buffer.from(String(chunk));
    }

    return function gzip(req, res, next) {
        if (req.method === 'HEAD') return next();
        if (req.headers.range) return next();                          // Range 请求（视频 seek / 断点续传）一律不压
        if (req.headers['x-no-compression']) return next();            // 客户端可显式关闭
        if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

        const origWrite = res.write;
        const origEnd = res.end;
        const chunks = [];
        let total = 0;
        let mode = null;    // null=未判定 / 'buffer'=缓冲中 / 'pass'=直通

        function canCompress() {
            if (res.headersSent) return false;
            if (res.statusCode !== 200) return false;                  // 206/304/3xx/4xx 都不压
            if (res.getHeader('Content-Encoding')) return false;        // 已经有编码（不重复压）
            return GZIP_TYPE_RE.test(String(res.getHeader('Content-Type') || ''));
        }

        function passThrough() {
            mode = 'pass';
            for (let i = 0; i < chunks.length; i++) origWrite.call(res, chunks[i]);
            chunks.length = 0;
            total = 0;
        }

        res.write = function (chunk, encoding, callback) {
            if (mode === 'pass') return origWrite.apply(res, arguments);
            if (mode === null) {
                if (!canCompress()) { mode = 'pass'; return origWrite.apply(res, arguments); }
                mode = 'buffer';
            }
            const buf = toBuf(chunk, encoding);
            if (buf && buf.length) {
                chunks.push(buf);
                total += buf.length;
                if (total > MAX_BUFFER) passThrough();
            }
            const cb = typeof encoding === 'function' ? encoding : (typeof callback === 'function' ? callback : null);
            if (cb) cb();                                              // 缓冲语义下视为「已接收」
            return true;
        };

        res.end = function (chunk, encoding, callback) {
            if (mode === 'pass') return origEnd.apply(res, arguments);
            if (mode === null) {
                if (!canCompress()) { mode = 'pass'; return origEnd.apply(res, arguments); }
                mode = 'buffer';
            }
            const tail = toBuf(chunk, typeof encoding === 'string' ? encoding : undefined);
            if (tail && tail.length) { chunks.push(tail); total += tail.length; }
            const cb = typeof encoding === 'function' ? encoding : (typeof callback === 'function' ? callback : null);
            const body = chunks.length === 0 ? Buffer.alloc(0)
                : (chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total));
            chunks.length = 0;

            if (total < MIN_SIZE) {                                    // 太小 → 原样发
                appendVaryEncoding(res);
                return origEnd.call(res, body, cb);
            }
            let gz = null;
            try {
                gz = zlib.gzipSync(body, { level: 6 });
            } catch (e) { /* 压缩失败就原样发，绝不因此让请求失败 */ }
            if (!gz || gz.length >= total) {                            // 压不动（已是压缩内容）
                appendVaryEncoding(res);
                return origEnd.call(res, body, cb);
            }
            res.setHeader('Content-Encoding', 'gzip');
            res.removeHeader('Content-Length');
            res.setHeader('Content-Length', String(gz.length));
            appendVaryEncoding(res);
            return origEnd.call(res, gz, cb);
        };

        next();
    };
}
app.use(gzipMiddleware());

const { sessionMiddleware, isAuthEnabled, validateSession, isSectionProtected, isSectionUnlocked, COOKIE_NAME } = require('./utils/auth');

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

const PUBLIC_API_PREFIXES = ['/auth', '/acg', '/ai/chat', '/ai/status', '/app'];

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

/* round39：分入口密码 —— 上锁入口的影片列表必须带「该分区已解锁」的会话。
 * 挂在主密码守卫之后：主密码拦「能不能进应用」，这里拦「能不能开这个库」。
 * 覆盖 /api/movie?type=<view>（列表）；详情/播放属入口级保护的次级面，暂不拦。 */
app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/movie') return next();
    const t = String((req.query && req.query.type) || '');
    if (!t || !isSectionProtected(t)) return next();
    if (isSectionUnlocked(req.cookies && req.cookies[COOKIE_NAME], t)) return next();
    res.status(401).json({ code: -1, msg: '该入口已单独上锁', section: t });
});
// =====================================================================

// 托管前端静态页面 public 文件夹
// 根路径直达应用（v3.1 移除四馆入口页）：必须放在 static 之前 ——
// 老部署的 runtime 里会残留旧 index.html，static 会抢先把它发出去（实测踩过）
app.get('/', (req, res) => {
    res.redirect('/library.html');
});
/* ★ round134：侧栏布局改成「服务端为准，localStorage 当缓存」。
 * 起因（用户报）：左侧导航挪动后不记录，重开回到原位置。
 * 根因不在拖动逻辑（四种拖动实测都能落 localStorage），而在**持久化载体**：
 * 布局只存在 Chromium 的 localStorage 里，profile 一变（多实例回退到 *.tmp profile、
 * 异常退出没 flush、换便携版数据目录）就整块丢，用户看到的就是「回到原位置」。
 * 这里把已保存的布局在页面 HTML 里注入成 window.__cvSidebarLayout，
 * 前端初始化时同步就能拿到（不引入额外请求，也不改动初始化时序）。
 */
app.get('/library.html', (req, res, next) => {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
        const layout = (cfg.ui && cfg.ui.sidebarLayout) || null;
        if (!layout) return next();
        const file = path.join(__dirname, 'public', 'library.html');
        const html = fs.readFileSync(file, 'utf8');
        const payload = JSON.stringify({
            layout,
            updatedAt: Number((cfg.ui && cfg.ui.sidebarLayoutAt) || 0)
        }).replace(/</g, '\\u003c');
        res.setHeader('Cache-Control', 'no-cache');
        res.type('html').send(
            html.replace('</head>', '<script>window.__cvSidebarLayout=' + payload + ';</script>\n</head>')
        );
    } catch (e) {
        next();   // 注入失败就回退静态文件，绝不能因为一个布局把首页打不开
    }
});
// round92：HTML 页面一律 no-cache 强制协商 —— 之前 max-age=0 时 Electron 窗口
// 可能继续吃旧缓存，用户重启 EXE 也看不到新前端（「改了代码用户那边还是老的」元凶）。
// 带版本号（?v=N）的 js/css 不受影响，走浏览器自己的协商缓存。
app.use((req, res, next) => {
    if (/\.(html|htm)$/i.test(req.path) || req.path === '/' || req.path === '/library.html') {
        res.setHeader('Cache-Control', 'no-cache');
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

// 托管 pdf.js 库（漫画 PDF 阅读）
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));

// 挂载所有路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/movie', require('./routes/movie'));
app.use('/api/scanner', require('./routes/scanner'));
app.use('/api/tasks', require('./routes/tasks'));        // round72：全局任务中心（右上角胶囊 / AI 查状态）
app.use('/api/media', require('./routes/media-progress')); // round73：漫画/小说阅读进度与状态
app.use('/api/tts', require('./routes/tts'));   // round74：语音朗读（一键体检/自启/音色）
app.use('/api/actress', require('./routes/actress'));
app.use('/api/tags', require('./routes/tags'));
app.use('/api/recommend', require('./routes/recommend'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/config', require('./routes/config'));
app.use('/api/playlist', require('./routes/playlist'));
app.use('/api/fav', require('./routes/favorites'));   // round53：收藏夹（网页收藏板块；视频播放列表仍在 /api/playlist）
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
app.use('/api/app', require('./routes/app-update'));     // 移动端/Android APK 更新与下载
app.use('/api/app', require('./routes/harmony-update')); // 鸿蒙 HAP 应用内更新（构建目录为源）
// round135：Agent 运行时（真流式 + 单步审批 + 轨迹）。必须挂在 /api/ai 之前 —— 
// 旧 router 里有同名前缀的处理，先让更具体的 /api/ai/agent/* 命中。
app.use('/api/ai/agent', require('./routes/ai-agent'));
app.use('/api/ai', require('./routes/ai'));app.use('/api/cloud', require('./routes/cloud'));
app.use('/api/cloud/oauth', require('./routes/cloud-oauth'));   // round91：123云盘/百度网盘 OAuth 官方授权
app.use('/api/comic', require('./routes/comic'));
app.use('/api/novel', require('./routes/novel'));
app.use('/api/acg', require('./routes/acg'));   // round33：ACG 热度榜
app.use('/api/danmaku', require('./routes/danmaku'));   // round36：弹幕
app.use('/api/health', require('./routes/health'));     // round36：环境信息/网络自检
// round36 批次B：站点解析器（声明式源定义 + m3u8 代理播放）
// ★ 必须挂在整站反代（app.use('/', webviewProxy)）之前：反代会接管任意一层路径，
//   挂它后面可能被当成某个站点的子路径吞掉。
app.use('/api/media-source', require('./routes/media-source'));
app.use('/api/maintenance', require('./routes/maintenance'));   // round37：封面缓存盘点/清理/回收站
app.use('/api/connect', require('./routes/connect'));   // 移动端扫码连接（connect.html 二维码页）

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
// round49：UI_anime 动效库（D:/UI_anime 归档的 106 款 thumb 预览），目录可在 config.json 顶层 uiAnimeDir 配置
const uiAnimeDir = config.uiAnimeDir || 'D:/UI_anime';
if (fs.existsSync(uiAnimeDir)) app.use('/ui-anime', express.static(uiAnimeDir, { maxAge: '1d' }));

app.use('/api/customization', require('./routes/customization'));

// 根路径重定向已在静态服务之前统一处理（见上）

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
        /* ★ round110 看门狗：启动扫描链万一长时间不结束（漫画/小说要爬站、网络重试，
         * 实测能拖 1.75 小时以上），目录监控不能一直挂在「等扫描链」上不启动——
         * 那期间 fs.watch 事件全丢、轮询也不转，用户点「检查新增」只能得到谎话
         * （round110 实机复盘：watcher started=false/ticks=0 挂了好几天）。
         * 超时后强行挂载：runTick 内部有 otherScanBusy 看门，扫描在跑时轮询/事件
         * 都会自动让路，不存在两家同时处理同一个文件；链结束后下一轮自动生效。 */
        const watchGuard = setTimeout(() => {
            console.log('[目录监控] 启动扫描链超过 10 分钟未结束，看门狗触发：先行挂载（扫描结束后自动生效）');
            startDirWatch();
        }, 10 * 60 * 1000);
        if (watchGuard.unref) watchGuard.unref();
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
            /* ★ round112：补封面任务「续跑」入口。
             *   漫画/小说的封面是扫描的第二阶段（纯本地取图，不联网），上一次如果
             *   用户关掉应用就会中断 —— 每次启动在这里再拉一次，模块自己会查
             *   「还缺多少张」，一个不缺就立刻返回，不会空转。 */
            try {
                require('./utils/enrich-covers').startEnrich({ types: ['comic', 'novel'], reason: '启动续补' });
            } catch (e) {
                console.log('[补封面] 续跑启动失败（不影响其他功能）:', e.message);
            }
            // round75：扫描完成后做一次系列归类（≥80% 同名合并到系列名下，写 movies.serial）
            try {
                const { recomputeSerials } = require('./utils/series-group');
                const t0s = Date.now();
                const r = recomputeSerials(db, ['comic', 'novel', 'cartoon', 'film']);
                console.log(`[系列] 归类完成：${r.series} 个系列，更新 ${r.changed} 条（${Date.now() - t0s}ms）`);
            } catch (e) {
                console.log('[系列] 归类失败（不影响扫描结果）:', e.message);
            }
            startDirWatch();
            clearTimeout(watchGuard);   // round110：链正常结束，看门狗下岗
        }, 1000);
    } else {
        console.log('[启动] 已禁用自动扫描（DISABLE_AUTO_SCAN）');
        // round75：禁扫描时也要回填一次系列（存量库首次升级）
        try {
            const { recomputeSerials } = require('./utils/series-group');
            const r = recomputeSerials(db, ['comic', 'novel', 'cartoon', 'film']);
            console.log(`[系列] 归类完成：${r.series} 个系列，更新 ${r.changed} 条`);
        } catch (e) { /* 不影响启动 */ }
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