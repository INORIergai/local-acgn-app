/**
 * Cinema Vault 桌面版 —— Electron 主进程
 * ==========================================================================
 * 结构：
 *   packaging/main.js            ← 本文件（Electron 主进程 = GUI 壳）
 *   packaging/app/               ← prepare-export.js 生成的脱敏应用副本（随包发布，只读）
 *   <数据目录>/runtime/          ← 首次启动时把 app/ 复制到这里，之后一直跑这里（可写）
 *   <数据目录>/server.log        ← 后端日志
 *
 * 数据目录：
 *   · 便携版（portable exe）→ 与 exe 同级的 CinemaVault-Data\（真正绿色，可放 U 盘）
 *   · 安装版              → %APPDATA%\CinemaVault\
 *
 * 【为什么必须复制一份再跑】
 * 这个应用的数据（db/movie.db、posters/、cache/、config.json）都是相对
 * `__dirname` 写的，而打包后的程序目录是**只读**的（NSIS 安装到
 * %LOCALAPPDATA%\Programs、便携版每次解压到随机临时目录）。
 * 直接在原位跑 = 一写库就崩 / 便携版每次重启库就没了。
 * 所以首次启动把代码复制到可写的数据目录，之后从那里跑；升级时按版本号重新同步，
 * 但**永远不动用户数据**（config.json / db / posters / cache / data 一律保留）。
 *
 * 后端进程用 ELECTRON_RUN_AS_NODE 起（Electron 自带 Node，不用另装运行时），
 * 依赖里的 better-sqlite3 已按 Electron ABI 预编译（见 build-exe.bat）。
 */
'use strict';

const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ---------------------------------------------------------------- 启动日志
 * 桌面版最难查的就是「双击没反应」：GUI 子系统没有控制台，Electron 主进程一抛异常
 * 就只弹个错误框，外部什么都看不到。所以这里第一步就落盘一份 boot 日志
 * （放在临时目录，保证一定能写），每一步都记一笔，异常也记。
 * 用户报「打不开」时，让对方把这个文件发过来即可。
 */
const BOOT_LOG = path.join(os.tmpdir(), 'cinemavault-boot.log');
function blog(msg) {
    try {
        fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${msg}\r\n`);
    } catch (e) { /* 日志都写不了就只能忍了 */ }
}
try { fs.writeFileSync(BOOT_LOG, ''); } catch (e) { /* 忽略 */ }
blog('=== CinemaVault boot ===');
blog(`electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`);
blog(`argv=${JSON.stringify(process.argv)}`);
blog(`isPackaged=${app.isPackaged} resourcesPath=${process.resourcesPath}`);
blog(`__dirname=${__dirname} cwd=${process.cwd()}`);
process.on('uncaughtException', (e) => {
    blog('!!! uncaughtException: ' + (e && (e.stack || e.message || e)));
});
process.on('unhandledRejection', (e) => {
    blog('!!! unhandledRejection: ' + (e && (e.stack || e.message || e)));
});

/* ------------------------------------------------------------------ 路径 */
/**
 * 应用代码的位置。
 *
 * 打包后走 `resources/payload`（由 package.json 的 extraResources 原样铺过去），
 * 而不是 `resources/app/payload`。
 * 【为什么】electron-builder 对 `files` 里的 `node_modules` 有特殊规则 ——
 * 不管你怎么写 glob，它都会把 `node_modules` 与 `package-lock.json` 过滤掉
 * （它认为依赖应该由自己的依赖集合来收集）。结果 exe 一启动就
 * `Cannot find module 'better-sqlite3'`。
 * 改用 extraResources 是「原样复制，不走 files 过滤」，一劳永逸。
 */
const PAYLOAD = app.isPackaged
    ? path.join(process.resourcesPath, 'payload')
    : path.join(__dirname, 'payload');
blog(`PAYLOAD=${PAYLOAD} exists=${fs.existsSync(PAYLOAD)}`);
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;   // electron-builder 便携版会注入

/* Electron 的 app.getPath('userData') 默认取 package.json 的 name，也就是
 * `cinema-vault-desktop` —— 于是用户会在自己的 AppData 里看到一个 kebab-case
 * 的包名，菜单「打开数据文件夹」也指到那儿，很不成样子。
 * （顶层加 productName 没用：打包后 resources/app/package.json 是 electron-builder
 *  自己生成的，只带 name / version / main。）
 * 所以直接改路径。必须在 app ready 之前调用，这里正好是最早的时机。
 */
try {
    app.setPath('userData', path.join(app.getPath('appData'), 'CinemaVault'));
} catch (e) {
    blog('设置 userData 路径失败，沿用默认: ' + e.message);
}

/** 选一个真的可写的根目录；便携版优先「跟着 exe 走」，失败再退回 %APPDATA% */
function pickDataRoot() {
    const list = [];
    if (IS_PORTABLE) list.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'CinemaVault-Data'));
    list.push(app.getPath('userData'));
    for (const dir of list) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
            return dir;
        } catch (e) { /* 换下一个候选 */ }
    }
    return app.getPath('userData');
}

const DATA_ROOT = pickDataRoot();
blog(`DATA_ROOT=${DATA_ROOT} (portable=${IS_PORTABLE})`);

/* ------------------------------------------------------- GPU 崩溃自动降级
 * Chromium 的 GPU 进程在下面这些环境里会反复崩溃（exitCode -1073741819
 * = 0xC0000005 访问违例）：远程桌面 / 虚拟机 / 老旧或异常的显卡驱动 /
 * 没有真实显示器的会话。症状极其隐蔽 —— GUI 程序没有控制台，用户看到的
 * 只有「双击后闪一下就没了」，连错误框都来不及弹。
 *
 * 处理办法：默认仍然开启硬件加速（视频播放要靠它），但一旦 GPU 进程连续崩溃
 * 就落一个标记文件，**下次启动自动改用软件渲染**。用户无感，也不会因为
 * 默认关掉硬件加速而牺牲所有正常机器的播放性能。
 *
 * 想手动强制软件渲染（排查用）：设 CV_SOFTWARE_RENDER=1，或删/建
 * 数据目录下的 .software-render 文件。
 */
const GPU_FLAG = path.join(DATA_ROOT, '.software-render');
if (process.env.CV_SOFTWARE_RENDER === '1' || fs.existsSync(GPU_FLAG)) {
    app.disableHardwareAcceleration();
    blog('已禁用硬件加速（software-render 标记或 CV_SOFTWARE_RENDER=1）');
}

/* ---------------------------------------------------- 沙箱不可用自动降级
 * 和上面的 GPU 崩溃是两回事，但症状一模一样（双击闪一下就没）。
 *
 * 实测（packaging/_test-flags.py 跑过 15 组组合）：同一个 exe
 *   · 不带开关                → 主进程 0.1 秒内直接死，窗口永远不会出现
 *   · 只关 GPU 沙箱的各种组合  → 进程能活 12 秒，但窗口建不出来
 *   · 加 --no-sandbox         → 3 秒内正常出窗口 ✓
 * 也就是说「Chromium 沙箱在这个环境起不来」，而 GPU/渲染子进程一崩，
 * 主进程会被连环崩溃拖死，GUI 程序还没有控制台可看，用户只能看到「没反应」。
 *
 * 触发条件常见于：第三方杀软拦截、企业安全策略、远程桌面 / 无头会话、
 * 部分精简版系统。**正常桌面机不会触发**。
 *
 * 所以策略是：默认**保留沙箱**（安全优先，也保住反代第三方站点的隔离），
 * 一旦真的崩了就写下标记并自动重启，之后每次启动都带 --no-sandbox。
 * 用户侧的感受只是「第一次启动稍慢一点」。
 *
 * 想手动指定：环境变量 CV_NO_SANDBOX=1，或删/建数据目录下的 .no-sandbox。
 */
const SANDBOX_FLAG = path.join(DATA_ROOT, '.no-sandbox');
const SANDBOX_OFF = process.env.CV_NO_SANDBOX === '1' || fs.existsSync(SANDBOX_FLAG);
if (SANDBOX_OFF) {
    app.commandLine.appendSwitch('no-sandbox');
    blog('已启用 --no-sandbox（no-sandbox 标记或 CV_NO_SANDBOX=1）');
}
const RUNTIME = path.join(DATA_ROOT, 'runtime');
const CONFIG_FILE = path.join(RUNTIME, 'config.json');
const SERVER_LOG = path.join(DATA_ROOT, 'server.log');
const FFMPEG_DIR = path.join(DATA_ROOT, 'bin');               // 用户可把 ffmpeg.exe / ffprobe.exe 丢这里

/* ------------------------------------------------- 版本号交给后端（round31）
 * 「设置 → 版本」要比对 GitHub 上的版本号，后端必须知道当前跑的是哪一版。
 * 但后端的 package.json 是从开发树同步过去的根 package.json（恒为 1.0.0），
 * **不是 exe 的真实版本** —— 真版本只有 app.getVersion() 知道（读的是
 * packaging/package.json）。
 * 所以这里双管齐下：写一份 app-version.json 到 runtime，并在 spawn 后端时
 * 注入环境变量。写文件是主渠道（同步脚本不会碰它，重启后依然在），
 * 环境变量是兜底（万一 runtime 只读，仍能拿到）。 */
const APP_VERSION = {
    version: app.getVersion(),
    portable: IS_PORTABLE,
    writtenAt: new Date().toISOString(),
};
const VERSION_FILE = path.join(RUNTIME, 'app-version.json');
try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    fs.writeFileSync(VERSION_FILE, JSON.stringify(APP_VERSION, null, 2));
    blog(`写入版本文件 ${VERSION_FILE} → v${APP_VERSION.version} (portable=${IS_PORTABLE})`);
} catch (e) {
    blog('写入版本文件失败（后端将退化读 package.json）: ' + e.message);
}

/**
 * 「用户数据」永不覆盖：升级同步时这些名字一律跳过（目标已存在就保留）。
 * 没在第一次出现（目标不存在）时会正常复制过去，比如 db/schema.sql。
 */
const PRESERVE = new Set(['config.json', 'db', 'posters', 'cache', 'data', 'tmp-render', 'backups', 'logs']);

let serverProc = null;
let win = null;
let BASE = '';

/* -------------------------------------------------------------- 小工具 */
function log(...a) { console.log('[cv]', ...a); }

function rotateLog(maxBytes = 5 * 1024 * 1024) {
    try {
        if (fs.existsSync(SERVER_LOG) && fs.statSync(SERVER_LOG).size > maxBytes) {
            fs.renameSync(SERVER_LOG, SERVER_LOG + '.old');
        }
    } catch (e) { /* 忽略 */ }
}

/** 递归复制；preserve=true 时不覆盖已存在的用户数据 */
function copyTree(src, dst, preserve) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dst, name);
        if (preserve && PRESERVE.has(name) && fs.existsSync(d)) continue;
        let st;
        try { st = fs.lstatSync(s); } catch (e) { continue; }
        if (st.isDirectory()) copyTree(s, d, preserve);
        else if (st.isFile()) fs.copyFileSync(s, d);
    }
}

/** 载荷指纹：版本号 + server.js 大小（版本没变但代码变了也能触发同步） */
function buildStamp() {
    let size = 0;
    try { size = fs.statSync(path.join(PAYLOAD, 'server.js')).size; } catch (e) { /* 忽略 */ }
    return `${app.getVersion()}:${size}`;
}

function ensureRuntime() {
    const stampFile = path.join(RUNTIME, '.build-stamp');
    let prev = '';
    try { prev = fs.readFileSync(stampFile, 'utf8').trim(); } catch (e) { /* 首次 */ }
    const stamp = buildStamp();
    const missing = !fs.existsSync(path.join(RUNTIME, 'server.js')) ||
                    !fs.existsSync(path.join(RUNTIME, 'node_modules'));
    if (!missing && prev === stamp) return { copied: false };

    log(missing ? '首次启动：展开运行目录 →' : '检测到版本变化：同步代码 →', RUNTIME);
    copyTree(PAYLOAD, RUNTIME, true);
    try { fs.writeFileSync(stampFile, stamp, 'utf8'); } catch (e) { /* 忽略 */ }
    return { copied: true };
}

/** 从 start 起找一个空闲端口 */
function findFreePort(start) {
    return new Promise((resolve) => {
        let p = start;
        const next = () => {
            if (p > start + 40) return resolve(0);
            const srv = net.createServer();
            srv.unref();
            srv.once('error', () => { p += 1; next(); });
            srv.once('listening', () => srv.close(() => resolve(p)));
            srv.listen(p, '127.0.0.1');
        };
        next();
    });
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/** 读文件尾部若干字符（诊断用，顺便把换行压成 ⏎ 便于单行日志） */
function readTail(file, n) {
    try {
        const s = fs.readFileSync(file, 'utf8');
        return s.slice(-n).replace(/\r?\n/g, ' ⏎ ');
    } catch (e) { return '(读不到: ' + e.message + ')'; }
}

/**
 * 准备 config.json。
 * 首次运行：以 config.example.json 为模板，但把路径类字段清空、端口换成实际端口、
 * 口令换成随机 6 位数 —— 公开下载的陌生人拿到的是一个能跑、且口令唯一的配置。
 */
function ensureConfig(port) {
    const existed = fs.existsSync(CONFIG_FILE);
    let cfg = readJson(CONFIG_FILE);
    let firstRun = false;

    if (!cfg) {
        const base = readJson(path.join(RUNTIME, 'config.example.json')) || {};
        cfg = base;
        cfg.scanFolders = [];
        cfg.animeFolders = [];
        cfg.comicFolders = [];
        cfg.novelFolders = [];
        cfg.lan = Object.assign({}, base.lan, { host: '', port });
        /* 访问密码默认**不开启** —— 桌面版是个人软件，双击就该能直接用。
         * 想加密码：设置 → 🔒 安全与通知 → 打开「进入影库需要输入密码」。
         * （早期版本在这里随机生成 6 位口令，强制的，用户反馈太别扭。） */
        cfg.auth = { enabled: false, password: '' };
        firstRun = true;
    }
    if (cfg.serverPort !== port) cfg.serverPort = port;

    // ffmpeg 不是必需品：有就用（截帧封面 / 读时长），没有就退回 PATH 查找
    if (fs.existsSync(path.join(FFMPEG_DIR, 'ffmpeg.exe'))) {
        const prev = cfg.ffmpeg;
        cfg.ffmpeg = Object.assign(
            { screenshotTime: 10, thumbnailWidth: 420 },
            typeof prev === 'object' ? prev : {},
            { binPath: FFMPEG_DIR }
        );
    }

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
        log('写 config.json 失败：' + e.message);
    }
    return { cfg, firstRun, existed };
}

/* ------------------------------------------------------------ 后端进程 */
function startServer() {
    rotateLog();

    /* ★★ 这里有一个非常隐蔽、但会让整个应用「双击没反应」的坑：
     *
     * 依赖里有 ESM-only 的包（cheerio@1.2.0、https-proxy-agent@9.1.0），
     * 而源码是用 CommonJS 的 require() 引它们的（routes/movie.js 等）。
     * `require()` 加载 ESM 需要 Node >= 20.19（那之后才默认开启 require(esm)）。
     *
     *   · Docker 容器      → Node 20.20.2  ✅ 满足，所以一直跑得好好的
     *   · Electron 33 内置 → Node 20.18.3  ❌ 差一点点，require 直接抛
     *                                      ERR_REQUIRE_ESM
     *
     * 而 routes/movie.js 是核心路由 —— 这个 require 一崩，server.js 的加载链
     * 就断了，app.listen 和建库都不会执行，表现就是「exe 起来了但什么服务都没有」。
     *
     * `--experimental-require-module` 在 Node 20.17 就存在了，正好能把
     * require(esm) 提前打开（只会多打一行 ExperimentalWarning，不影响功能）。
     * 这里**显式覆盖** NODE_OPTIONS 而不是追加，顺便把宿主机可能存在的
     * NODE_OPTIONS 污染（某些 IDE / 工具链会往里塞 --require 垫片）一起挡掉。
     */
    const childEnv = Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',      // 用 Electron 自带 Node 跑 Express（ABI 与原生模块一致）
        NODE_ENV: 'production',
        CONFIG_FILE,
        CINEMAVAULT_VERSION: APP_VERSION.version,                      // round31：真实版本号
        PORTABLE_EXECUTABLE_DIR: IS_PORTABLE ? (process.env.PORTABLE_EXECUTABLE_DIR || '') : '',
        NODE_OPTIONS: '--experimental-require-module',
    });
    blog(`spawn 后端: execPath=${process.execPath}`);
    blog(`  cwd=${RUNTIME}  server.js 存在=${fs.existsSync(path.join(RUNTIME, 'server.js'))}`);

    /* stdio 用 pipe + 手动落盘，而不是直接把 fs.openSync 的 fd 交给子进程 ——
     * 后者在某些环境下子进程拿到的句柄是坏的，症状是「server.log 一直是 0 字节」，
     * 排查时会被误导成「后端没启动」。pipe 一定能拿到内容。 */
    serverProc = spawn(process.execPath, [path.join(RUNTIME, 'server.js')], {
        cwd: RUNTIME,
        env: childEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    blog(`后端 pid=${serverProc.pid}`);

    try {
        const outStream = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
        const tee = (tag) => (d) => {
            try { outStream.write(d); } catch (e) { /* 忽略 */ }
            blog(tag + String(d).slice(0, 500).replace(/\r?\n/g, ' ⏎ '));
        };
        serverProc.stdout.on('data', tee('  [后端] '));
        serverProc.stderr.on('data', tee('  [后端!] '));
    } catch (e) {
        blog('落盘后端日志失败: ' + e.message);
    }

    serverProc.on('exit', (code, sig) => {
        blog(`后端进程退出 code=${code} sig=${sig}`);
        log(`后端进程退出 code=${code}`);
    });
    serverProc.on('error', (e) => {
        blog('后端进程启动失败：' + (e.stack || e.message));
        log('后端进程启动失败：' + e.message);
    });
}

function killServer() {
    if (!serverProc) return;
    try { serverProc.kill(); } catch (e) { /* 忽略 */ }
    serverProc = null;
}

function pingOnce(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode || 0); });
        req.on('error', () => resolve(0));
        req.setTimeout(2500, () => { req.destroy(); resolve(0); });
    });
}

/** 等后端就绪（最多 ~75 秒；首次启动要建库，慢一点正常） */
async function waitServer(timeoutMs = 75000) {
    const url = BASE + '/api/auth/status';
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (serverProc && serverProc.exitCode !== null) {
            throw new Error(`后端进程已退出（code=${serverProc.exitCode}）`);
        }
        if (await pingOnce(url)) return true;
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('后端启动超时');
}

/* ---------------------------------------------------------------- 窗口 */
function createWindow() {
    win = new BrowserWindow({
        width: 1560,
        height: 940,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#0e0c0a',
        autoHideMenuBar: true,          // 菜单按 Alt 才出现
        show: false,
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });

    win.once('ready-to-show', () => win.show());

    /* ★ 窗口显示兜底。
     * 正常路径是等 ready-to-show（首帧渲染完）再 show，避免白屏闪烁。
     * 但这个事件在少数环境下**根本不会触发** —— 典型就是 GPU/驱动异常，
     * 页面永远等不到首帧，于是窗口一直藏在后台，用户看到的就是
     * 「双击了，任务管理器里有进程，但就是没窗口」。实测便携版上真的复现了。
     * 所以给一个硬兜底：4 秒还没显示就强行显示（哪怕内容是白的也比没窗口强）。
     */
    const forceShow = setTimeout(() => {
        if (win && !win.isDestroyed() && !win.isVisible()) {
            blog('ready-to-show 未触发 → 兜底强制显示窗口');
            win.show();
        }
    }, 4000);
    win.once('show', () => clearTimeout(forceShow));

    // 页面加载失败也要留痕，否则只会表现为「窗口空着」
    win.webContents.on('did-fail-load', (e, code, desc, url) => {
        blog(`did-fail-load code=${code} desc=${desc} url=${url}`);
    });
    win.webContents.on('render-process-gone', (e, d) => {
        blog('渲染进程退出 ' + JSON.stringify(d));
    });

    // 应用内的 URL 一律在窗口里跑；外部链接丢给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(BASE)) return { action: 'allow' };
        if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (url.startsWith(BASE)) return;
        e.preventDefault();
        // 含 PotPlayer 这类自定义协议（lmlplayer://），交给系统处理
        shell.openExternal(url).catch(() => {});
    });

    win.on('closed', () => { win = null; });
    // 首页是应用自己的入口枢纽（影片 / 动漫 / 漫画 / 小说四合一）
    win.loadURL(BASE + '/');
}

function buildMenu(getAuth) {
    const open = (p) => shell.openPath(p).catch(() => {});
    return Menu.buildFromTemplate([
        {
            label: '文件',
            submenu: [
                { label: '打开数据文件夹', click: () => open(DATA_ROOT) },
                { label: '打开配置 config.json', click: () => open(CONFIG_FILE) },
                { label: '查看后端日志', click: () => open(SERVER_LOG) },
                { type: 'separator' },
                {
                    label: '重启后端服务',
                    click: () => { killServer(); startServer(); win && win.reload(); },
                },
                { type: 'separator' },
                { role: 'quit', label: '退出' },
            ],
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '刷新界面' },
                { role: 'forceReload', label: '强制刷新' },
                { type: 'separator' },
                { role: 'resetZoom', label: '实际大小' },
                { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '缩小' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '全屏' },
                { role: 'toggleDevTools', label: '开发者工具' },
            ],
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '访问密码状态',
                    click: () => {
                        const a = getAuth() || {};
                        /* 与 utils/auth.js#isAuthEnabled() 保持一致的判定：
                         * 有 enabled 布尔就以它为准，老配置没有该字段则退化成「有密码即启用」 */
                        const on = typeof a.enabled === 'boolean' ? (a.enabled && !!a.password) : !!a.password;
                        dialog.showMessageBox(win, {
                            type: 'info',
                            title: '访问密码',
                            message: on ? '已开启：进入影库需要输入密码' : '未开启：进入影库不需要密码',
                            detail: on
                                ? `当前密码：${a.password}\n\n可到「设置 → 🔒 安全与通知」修改或关闭。\n密码存在：\n${CONFIG_FILE}`
                                : '想加密码的话，到「设置 → 🔒 安全与通知」打开开关即可。\n配置存在：\n' + CONFIG_FILE,
                        });
                    },
                },
                {
                    label: '关于',
                    click: () => dialog.showMessageBox(win, {
                        type: 'info',
                        title: '关于 Cinema Vault',
                        message: 'Cinema Vault · 本地媒体库',
                        detail: `版本 ${app.getVersion()}\n数据目录：${DATA_ROOT}\n运行目录：${RUNTIME}`,
                    }),
                },
            ],
        },
    ]);
}

/* ---------------------------------------------------------------- 启动 */
if (!app.requestSingleInstanceLock()) {
    blog('!!! 单实例锁被其它实例占用 → 本实例退出');
    app.quit();
} else {
    app.setAppUserModelId('cn.cinemavault.desktop');
    app.on('second-instance', () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
    });

    app.whenReady().then(async () => {
        const t0 = Date.now();
        try {
            blog('whenReady 触发');
            ensureRuntime();
            blog('ensureRuntime 完成');
            const port = await findFreePort(Number(process.env.CV_PORT) || 3517);
            if (!port) {
                blog('!!! 找不到空闲端口');
                dialog.showErrorBox('启动失败', '找不到可用端口（3517-3557 都被占用）。');
                app.quit();
                return;
            }
            BASE = `http://127.0.0.1:${port}`;
            const { cfg, firstRun } = ensureConfig(port);
            blog(`端口=${port} firstRun=${firstRun}`);
            log(`运行目录 ${RUNTIME}`);
            log(`服务地址 ${BASE}`);

            startServer();
            blog('startServer 返回，进入 waitServer');
            try {
                await waitServer();
                blog('waitServer 正常返回');
            } catch (e) {
                blog('waitServer 失败: ' + (e && (e.stack || e.message || e)));
                blog('后端日志尾部: ' + readTail(SERVER_LOG, 2000));
                const r = dialog.showMessageBoxSync({
                    type: 'error',
                    title: '后端启动失败',
                    message: String(e.message || e),
                    detail: `日志：${SERVER_LOG}\n\n常见原因：端口被占用、杀毒软件拦截、运行目录不可写。`,
                    buttons: ['打开日志', '退出'],
                    defaultId: 0,
                });
                if (r === 0) shell.openPath(SERVER_LOG).catch(() => {});
                killServer();
                app.quit();
                return;
            }
            blog(`后端就绪，用时 ${Date.now() - t0}ms`);
            log(`后端就绪，用时 ${Date.now() - t0}ms`);

            Menu.setApplicationMenu(buildMenu(() => (readJson(CONFIG_FILE) || {}).auth || {}));
            createWindow();
            blog('窗口已创建');

            if (firstRun) {
                dialog.showMessageBox(win, {
                    type: 'info',
                    title: '欢迎使用 Cinema Vault',
                    message: '首次启动已完成初始化',
                    detail:
                        '默认不设密码，直接就能用。建议先做两件事：\n\n' +
                        '1. 「设置 → 📂 扫描路径」添加你的影片 / 动漫 / 漫画 / 小说文件夹，' +
                        '然后点右上角「开始扫描」。\n\n' +
                        '2. 如果你会用手机通过局域网访问，' +
                        '建议到「设置 → 🔒 安全与通知」打开访问密码。\n\n' +
                        `数据目录：${DATA_ROOT}`,
                    buttons: ['开始使用'],
                });
            }
        } catch (e) {
            // 兜底：任何没被上面分支接住的异常都落盘，不然就成了「双击没反应」
            blog('!!! whenReady 里未处理的异常: ' + (e && (e.stack || e.message || e)));
            dialog.showErrorBox('启动失败', String((e && (e.stack || e.message)) || e));
            app.quit();
        }
    });

    app.on('window-all-closed', () => { blog('事件 window-all-closed → quit'); app.quit(); });
    app.on('before-quit', () => { blog('事件 before-quit'); killServer(); });
    app.on('will-quit', () => { blog('事件 will-quit'); killServer(); });
    app.on('quit', (e, code) => blog('事件 quit code=' + code));
    let gpuCrashes = 0;
    let degrading = false;
    app.on('child-process-gone', (e, d) => {
        blog('事件 child-process-gone ' + JSON.stringify(d));
        if (!d || d.reason !== 'crashed' || degrading) return;
        gpuCrashes += 1;

        /* 第一次崩就立刻降级 —— 不能等「崩够 3 次再说」：实测主进程会在约 150ms
         * 内被连环崩溃拖死，根本没有第二次机会。 */
        if (!SANDBOX_OFF) {
            degrading = true;
            try {
                fs.writeFileSync(SANDBOX_FLAG,
                    `Chromium 沙箱在本机不可用（${d.type} 进程崩溃 exitCode=${d.exitCode}，${new Date().toISOString()}）。\n` +
                    '已自动改用 --no-sandbox 启动。删除本文件可恢复沙箱。\n');
                blog('检测到子进程崩溃 → 写入 no-sandbox 标记并自动重启');
                killServer();
                app.releaseSingleInstanceLock();   // 先放锁，否则新实例会以为自己重复启动而退出
                app.relaunch({
                    args: process.argv.slice(1).filter((a) => a !== '--no-sandbox').concat(['--no-sandbox']),
                });
                app.exit(0);
            } catch (e2) {
                blog('自动重启失败（再双击一次即可）: ' + e2.message);
            }
            return;
        }

        // 已经带 --no-sandbox 还在崩 → 再退一级，关掉硬件加速
        if (gpuCrashes >= 3 && !fs.existsSync(GPU_FLAG)) {
            try {
                fs.writeFileSync(GPU_FLAG,
                    `GPU 进程连续崩溃 ${gpuCrashes} 次（${new Date().toISOString()}）。\n` +
                    '已自动切换为软件渲染。删除本文件即可恢复硬件加速。\n');
                blog('GPU 连续崩溃 → 写入 software-render 标记，下次启动走软件渲染');
            } catch (e2) { /* 忽略 */ }
        }
    });
    app.on('render-process-gone', (e, wc, d) => blog('事件 render-process-gone ' + JSON.stringify(d)));
    process.on('exit', (code) => { blog('process exit code=' + code); killServer(); });
    process.on('SIGINT', () => blog('信号 SIGINT'));
    process.on('SIGTERM', () => blog('信号 SIGTERM'));
}
