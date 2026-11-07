const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { configPath, lanInfo } = require('../utils/config');

// 读取配置
function readConfig() {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/* round34 新四库：确保 film/cartoon 扫描路径与影视/动漫刮削源的默认结构存在，
 * 这样设置页能直接渲染出来，刮削器/扫描器也不用到处写 `|| []` 兜底。 */
function ensureNewLibraryDefaults(cfg) {
    let changed = false;
    for (const key of ['filmFolders', 'cartoonFolders']) {
        if (!Array.isArray(cfg[key])) { cfg[key] = []; changed = true; }
    }
    cfg.sources = cfg.sources || {};
    if (!cfg.sources.tmdb) {
        cfg.sources.tmdb = {
            enabled: false,
            apiKey: '',
            baseUrl: 'https://api.themoviedb.org',
            configFields: ['apiKey'],
            note: '影视库主源。到 themoviedb.org 免费注册后在设置 → API 里申请 API Key（v3 auth）填入',
            __new: true
        };
        changed = true;
    }
    if (!cfg.sources.bangumi) {
        cfg.sources.bangumi = {
            enabled: true,
            accessToken: '',
            baseUrl: 'https://bgm.tv',
            configFields: ['accessToken'],
            note: '动漫库主源（bgm.tv 官方 API，免 Key 可用）；备源 AniList 普通向',
            __new: true
        };
        changed = true;
    }
    if (!cfg.sources.douban) {
        cfg.sources.douban = {
            enabled: true,
            cookie: '',
            baseUrl: 'https://www.douban.com',
            configFields: ['cookie'],
            note: '影视库备用源（无官方 API，尽力而为；填入浏览器 Cookie 可提升成功率）',
            __new: true
        };
        changed = true;
    }
    if (changed) {
        try { writeConfig(cfg); } catch (e) { /* 写不进去不影响读取 */ }
    }
    // 清理内部标记，不回传给前端
    for (const k of ['tmdb', 'bangumi', 'douban']) delete cfg.sources[k].__new;
    return cfg;
}

// 写入配置
function writeConfig(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), 'utf8');
}

// 获取完整配置（隐藏敏感字段）
router.get('/', (req, res) => {
    try {
        let cfg = readConfig();
        cfg = ensureNewLibraryDefaults(cfg);
        delete cfg.tmdbApiKey;
        /* 访问密码只回传「开关状态」，绝不回传明文 —— 设置页只需要知道
         * 当前开没开，用来控制那个开关的初始位置。 */
        cfg.auth = {
            enabled: typeof cfg.auth?.enabled === 'boolean'
                ? cfg.auth.enabled
                : !!cfg.auth?.password,
            hasPassword: !!cfg.auth?.password
        };
        /* round36：弹弹play 凭据只回传 appId 与「是否已配置」，明文 secret 不出后端 */
        cfg.danmaku = {
            appId: cfg.danmaku?.appId || '',
            hasSecret: !!cfg.danmaku?.appSecret
        };
        res.json({ code: 0, data: cfg });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 保存配置
router.post('/', (req, res) => {
    try {
        const newConfig = req.body;
        const currentConfig = readConfig();
        
        // 合并配置，保留tmdbApiKey等敏感字段
        const merged = {
            ...currentConfig,
            ...newConfig,
            tmdbApiKey: currentConfig.tmdbApiKey // 保留API key
        };
        
        // 合并sources，保留baseUrl、cookie等字段
        if (newConfig.sources && currentConfig.sources) {
            merged.sources = { ...currentConfig.sources };
            for (const [key, value] of Object.entries(newConfig.sources)) {
                merged.sources[key] = {
                    ...currentConfig.sources[key],
                    ...value
                };
            }
        }

        // round36：弹幕凭据 —— secret 未提交（空/'........' 遮蔽值）时保留原值
        if (newConfig.danmaku || currentConfig.danmaku) {
            const nd = newConfig.danmaku || {};
            const cd = currentConfig.danmaku || {};
            const secret = (nd.appSecret || '').trim();
            merged.danmaku = {
                appId: (nd.appId !== undefined ? nd.appId : cd.appId) || '',
                appSecret: (secret && secret !== '........') ? secret : (cd.appSecret || '')
            };
        }
        
        writeConfig(merged);
        res.json({ code: 0, msg: '保存成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取指定模块的扫描路径
router.get('/folders/:module', (req, res) => {
    try {
        const { module } = req.params;
        const cfg = readConfig();
        
        let folders = [];
        switch (module) {
            case 'movie':
            case 'jav':
                folders = cfg.scanFolders || [];
                break;
            case 'anime':
                folders = cfg.animeFolders || [];
                break;
            case 'comic':
                folders = cfg.comicFolders || [];
                break;
            case 'novel':
                folders = cfg.novelFolders || [];
                break;
            case 'film':
                folders = cfg.filmFolders || [];
                break;
            case 'cartoon':
                folders = cfg.cartoonFolders || [];
                break;
            default:
                return res.json({ code: -1, msg: '未知模块' });
        }

        res.json({ code: 0, data: folders });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 添加扫描路径到指定模块
router.post('/folders/:module', (req, res) => {
    try {
        const { module } = req.params;
        const { folderPath } = req.body;
        
        if (!folderPath) return res.json({ code: -1, msg: '路径不能为空' });
        
        // 检查路径是否存在
        if (!fs.existsSync(folderPath)) {
            return res.json({ code: -1, msg: '路径不存在' });
        }
        
        const cfg = readConfig();
        
        let folderKey = '';
        switch (module) {
            case 'movie':
            case 'jav':
                folderKey = 'scanFolders';
                break;
            case 'anime':
                folderKey = 'animeFolders';
                break;
            case 'comic':
                folderKey = 'comicFolders';
                break;
            case 'novel':
                folderKey = 'novelFolders';
                break;
            case 'film':
                folderKey = 'filmFolders';
                break;
            case 'cartoon':
                folderKey = 'cartoonFolders';
                break;
            default:
                return res.json({ code: -1, msg: '未知模块' });
        }

        if (!cfg[folderKey]) cfg[folderKey] = [];
        
        if (cfg[folderKey].includes(folderPath)) {
            return res.json({ code: -1, msg: '该路径已存在' });
        }
        
        cfg[folderKey].push(folderPath);
        writeConfig(cfg);
        
        res.json({ 
            code: 0, 
            msg: '添加成功，重启服务后生效', 
            data: cfg[folderKey] 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 删除指定模块的扫描路径
router.delete('/folders/:module', (req, res) => {
    try {
        const { module } = req.params;
        const { folderPath } = req.body;
        
        const cfg = readConfig();
        
        let folderKey = '';
        switch (module) {
            case 'movie':
            case 'jav':
                folderKey = 'scanFolders';
                break;
            case 'anime':
                folderKey = 'animeFolders';
                break;
            case 'comic':
                folderKey = 'comicFolders';
                break;
            case 'novel':
                folderKey = 'novelFolders';
                break;
            case 'film':
                folderKey = 'filmFolders';
                break;
            case 'cartoon':
                folderKey = 'cartoonFolders';
                break;
            default:
                return res.json({ code: -1, msg: '未知模块' });
        }

        cfg[folderKey] = (cfg[folderKey] || []).filter(f => f !== folderPath);
        writeConfig(cfg);
        
        res.json({ 
            code: 0, 
            msg: '删除成功，重启服务后生效', 
            data: cfg[folderKey] 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取所有模块的扫描路径
router.get('/all-folders', (req, res) => {
    try {
        const cfg = readConfig();
        res.json({
            code: 0,
            data: {
                movie: cfg.scanFolders || [],
                anime: cfg.animeFolders || [],
                comic: cfg.comicFolders || [],
                novel: cfg.novelFolders || [],
                film: cfg.filmFolders || [],
                cartoon: cfg.cartoonFolders || []
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 测试路径是否存在
router.post('/test-path', (req, res) => {
    try {
        const { folderPath } = req.body;
        const exists = fs.existsSync(folderPath);
        const isDir = exists && fs.statSync(folderPath).isDirectory();
        
        res.json({
            code: 0,
            data: {
                exists,
                isDirectory: isDir,
                valid: exists && isDir
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取Cookie配置（只显示是否已设置，不显示完整值）
router.get('/cookies', (req, res) => {
    try {
        const cfg = readConfig();
        const sources = cfg.sources || {};
        
        const result = {};
        
        // Kmoe Cookie
        if (sources.kmoe) {
            const cookie = sources.kmoe.cookie || '';
            result.kmoe = {
                hasCookie: !!cookie,
                cookieLength: cookie.length,
                username: sources.kmoe.username || ''
            };
        }
        
        // 夸克网盘 Cookie
        if (sources.quark) {
            const cookie = sources.quark.cookie || '';
            result.quark = {
                hasCookie: !!cookie,
                cookieLength: cookie.length
            };
        }
        
        res.json({ code: 0, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 更新Cookie
router.post('/cookies/:source', (req, res) => {
    try {
        const { source } = req.params;
        const { cookie } = req.body;

        if (!cookie) {
            return res.json({ code: -1, msg: 'Cookie不能为空' });
        }

        const cfg = readConfig();

        if (!cfg.sources) cfg.sources = {};
        if (!cfg.sources[source]) cfg.sources[source] = {};

        cfg.sources[source].cookie = cookie;
        // ★ hanime 特例：导入 cookie 即自动启用该源（App API 竖版封面通道），
        //   用户无需再手动改 config.json 的 sources.hanime.enabled
        let extraMsg = '';
        if (source === 'hanime' && !cfg.sources.hanime.enabled) {
            cfg.sources.hanime.enabled = true;
            extraMsg = '，hanime 源已自动启用';
        }
        writeConfig(cfg);

        // ★ 热生效：utils/config 模块导出的 config 对象被所有爬虫共享引用，
        //   就地改写它，下一次 new 爬虫立即拿到新 cookie，不必重启应用。
        //   （test 接口用的是写死的官方域名，不存在用户可控 URL）
        try {
            const live = require('../utils/config');
            live.sources = live.sources || {};
            live.sources[source] = live.sources[source] || {};
            live.sources[source].cookie = cookie;
            if (source === 'hanime') live.sources.hanime.enabled = true;
        } catch (e) { /* 模块不可用则退回重启生效 */ }

        res.json({
            code: 0,
            msg: 'Cookie 更新成功，已即时生效' + extraMsg
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 测试Cookie有效性
router.post('/cookies/:source/test', async (req, res) => {
    try {
        const { source } = req.params;
        const cfg = readConfig();
        
        // 优先使用请求体中传入的cookie（用于测试未保存的新cookie）
        // 如果请求体没有，则使用配置文件中已保存的cookie
        const cookie = req.body?.cookie || cfg.sources?.[source]?.cookie || '';
        
        if (!cookie) {
            return res.json({ code: -1, msg: '未设置Cookie' });
        }
        let valid = false;
        let message = '';
        
        if (source === 'kmoe') {
            // 测试Kmoe Cookie —— 判据与 kmoe.js checkLogin() 一致（两个标记必须同时出现，
            // 只用 || 的话首页任意一处静态 '/u/' 字样就会把无效 cookie 误判成已登录）
            const { Request } = require('../utils/crawler/base');
            const req = new Request({ cookies: parseCookie(cookie) });
            try {
                const res = await req.get('https://kzo.moe/');
                const html = await res.text();
                valid = html.includes('/u/') && html.includes('主頁');
                message = valid ? 'Cookie有效，已登录' : 'Cookie无效或已过期（未登录）';
            } catch (e) {
                message = '测试失败: ' + e.message;
            }
        } else if (source === 'quark') {
            // 测试夸克网盘Cookie
            const { Request } = require('../utils/crawler/base');
            const req = new Request({ cookies: parseCookie(cookie) });
            try {
                const res = await req.post('https://drive-pc.quark.cn/1/clouddrive/file/list?pr=ucpro&fr=pc&uc_param_str=&__t=' + Date.now() + '&__dt=1000',
                    { pdir_fid: '0', page: 1, size: 10 }
                );
                const data = await res.json();
                valid = data.data && data.data.list;
                message = valid ? `Cookie有效，文件数: ${data.data.list.length}` : 'Cookie无效';
            } catch (e) {
                message = '测试失败: ' + e.message;
            }
        } else if (source === 'hanime') {
            // 测试 hanime1.me Cookie：登录后导航会出现「登出」/个人链接，匿名只有「登入」
            const { Request } = require('../utils/crawler/base');
            const req = new Request({ cookies: parseCookie(cookie) });
            try {
                const res = await req.get('https://hanime1.me/');
                const html = await res.text();
                if (/Attention Required!/.test(html)) {
                    message = '被 Cloudflare 拦截（服务端直连不可达，封面抓取需 CDP 浏览器模式）';
                } else {
                    valid = html.includes('登出') || html.includes('/users/');
                    message = valid ? 'Cookie有效，已登录'
                        : (html.includes('登入') ? 'Cookie无效或未登录' : '无法确认登录态（站点可能改版）');
                }
            } catch (e) {
                message = '测试失败: ' + e.message;
            }
        } else {
            return res.json({ code: -1, msg: '不支持的数据源' });
        }
        
        res.json({ 
            code: 0, 
            data: { valid, message } 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 解析Cookie字符串为对象
function parseCookie(cookieStr) {
    const cookies = {};
    cookieStr.split(';').forEach(pair => {
        const [name, ...valueParts] = pair.trim().split('=');
        if (name) {
            cookies[name.trim()] = valueParts.join('=').trim();
        }
    });
    return cookies;
}

// ========== 浏览器验证相关 API ==========

// 初始化浏览器验证（弹出有窗口浏览器，让用户手动通过CF验证）
router.post('/browser/init-verification', async (req, res) => {
    try {
        const { url } = req.body;
        const userBrowser = require('../utils/crawler/user-browser');
        const result = await userBrowser.initBrowserVerification(url || 'https://hanime1.me');
        res.json({ code: result.success ? 0 : -1, msg: result.message, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 检查浏览器cookie是否有效
router.get('/browser/check-cookie', async (req, res) => {
    try {
        const { url } = req.query;
        const userBrowser = require('../utils/crawler/user-browser');
        const valid = await userBrowser.checkCookieValid(url || 'https://hanime1.me');
        res.json({ code: 0, data: { valid } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 当前 CDP 浏览器是否处于「有窗口」模式（round72 诊断用）
// 背景：headless 标志一旦被卡在 false，之后每次自动拉起浏览器都会弹窗，
// 用户会看到「关掉还在一直弹」。这个接口让状态可观测。
router.get('/browser/mode', (req, res) => {
    try {
        const userBrowser = require('../utils/crawler/user-browser');
        res.json({ code: 0, data: { headful: userBrowser.isHeadful() } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 关闭浏览器
router.post('/browser/close', async (req, res) => {
    try {
        const userBrowser = require('../utils/crawler/user-browser');
        await userBrowser.closeBrowser();
        res.json({ code: 0, msg: '浏览器已关闭' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取局域网访问信息
router.get('/lan-info', (req, res) => {
    // 部署模式：Docker 容器内无法直接唤起宿主机程序，
    // 前端据此决定是否走 lmlplayer:// 协议（本地直跑必须走后端 spawn）
    const isDocker = fs.existsSync('/.dockerenv');
    res.json({
        code: 0,
        data: {
            ...lanInfo(),
            deployment: isDocker ? 'docker' : 'local'
        }
    });
});

/* ★ round134：侧栏布局服务端持久化
 * 只存一份 800 字节左右的 JSON，写在 config.json 的 ui.sidebarLayout 下。
 * 前端每次拖动后防抖 POST 一次；页面加载时由 server.js 注入回 HTML
 * （window.__cvSidebarLayout），这样即使 Chromium 的 localStorage 被清掉/换了 profile，
 * 布局也不会丢。localStorage 退化为「首屏快速回显」的缓存。
 */
router.get('/ui-layout', (req, res) => {
    try {
        const cfg = readConfig();
        res.json({
            code: 0,
            data: {
                layout: (cfg.ui && cfg.ui.sidebarLayout) || null,
                updatedAt: Number((cfg.ui && cfg.ui.sidebarLayoutAt) || 0)
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/ui-layout', (req, res) => {
    try {
        const body = req.body || {};
        const layout = body.layout;
        if (!layout || !Array.isArray(layout.sections)) {
            return res.json({ code: -1, msg: '布局格式不合法' });
        }
        // 只接受结构化的最小字段，避免把任意内容塞进配置文件
        const clean = {
            sections: layout.sections.slice(0, 60).map(s => ({
                k: String((s && s.k) || '').slice(0, 80),
                n: String((s && s.n) || '').slice(0, 80),
                c: (s && s.c) ? 1 : 0,
                items: Array.isArray(s && s.items) ? s.items.slice(0, 120).map(x => String(x).slice(0, 80)) : []
            }))
        };
        const cfg = readConfig();
        cfg.ui = Object.assign({}, cfg.ui, {
            sidebarLayout: clean,
            sidebarLayoutAt: Date.now()
        });
        writeConfig(cfg);
        res.json({ code: 0, msg: '已保存', data: { updatedAt: cfg.ui.sidebarLayoutAt } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/* ============================================================================
 * round142：Cloudflare 验证辅助 + 浏览器环境自检
 * ----------------------------------------------------------------------------
 * 为什么需要：hanime / 91动漫 被 Cloudflare 保护，**无头浏览器一律被拦**，
 * 必须用真实浏览器过一次验证。此前用户只知道「刮削失败」，不知道要做什么。
 *
 * /browser-status  检测本机有没有可用的真实浏览器（ego-lite / Chrome / Edge）
 * /hanime-verify   拉起有头浏览器打开 hanime，让用户手动过 CF 并登录（登录态持久化）
 * ========================================================================== */

/** 检测本机可用的真实浏览器（含 ego-lite 与 Playwright 自带 Chromium） */
router.get('/browser-status', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const cfg = readConfig();
        const cdp = (cfg.network && cfg.network.cdp) || {};

        const candidates = [
            { name: 'ego-lite', paths: [
                'C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego lite.exe',
                path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ego lite', 'ego lite.exe')
            ] },
            { name: 'Chrome', paths: [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
            ] },
            { name: 'Edge', paths: [
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
            ] }
        ];
        const found = [];
        for (const c of candidates) {
            const hit = c.paths.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
            if (hit) found.push({ name: c.name, path: hit });
        }

        /* 9222 调试端口是否已在监听（说明已有可复用的浏览器实例） */
        const port = Number(cdp.port) || 9222;
        const listening = await new Promise((resolve) => {
            const net = require('net');
            const sock = net.connect({ port, host: '127.0.0.1' });
            sock.setTimeout(800);
            sock.once('connect', () => { sock.destroy(); resolve(true); });
            sock.once('error', () => { sock.destroy(); resolve(false); });
            sock.once('timeout', () => { sock.destroy(); resolve(false); });
        });

        res.json({
            code: 0,
            data: {
                browsers: found,
                hasRealBrowser: found.length > 0,
                debugPort: port,
                debugPortListening: listening,
                headless: cdp.headless !== false,
                // 一句话结论，前端直接显示
                advice: found.length
                    ? (cdp.headless !== false
                        ? '检测到真实浏览器，但当前配置为「无头」模式 —— 无头会被 Cloudflare 拦，建议改成有头并过一次验证'
                        : '检测到真实浏览器且为「有头」模式，可以直接过 Cloudflare')
                    : '未检测到真实浏览器。请安装 ego-lite 或 Chrome/Edge（其一即可），否则 hanime 源会被自动跳过'
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/** 拉起有头浏览器打开 hanime，让用户手动过 CF + 登录（登录态写入持久化 userDataDir） */
router.post('/hanime-verify', async (req, res) => {
    try {
        const userBrowser = require('../utils/crawler/user-browser');
        const browser = await userBrowser.ensureBrowser();
        const contexts = browser.contexts();
        const ctx = contexts.length ? contexts[0] : await browser.newContext();

        // 复用已有 hanime 标签页，没有就开一个
        let page = ctx.pages().find(p => /hanime/i.test(p.url() || ''));
        if (!page) page = await ctx.newPage();
        await page.goto('https://hanime1.me/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });

        // 尽力把窗口提到前台（CDP 模式下无法保证，失败不影响功能）
        try { await page.bringToFront(); } catch (e) { }

        res.json({
            code: 0,
            msg: '已打开浏览器。请在弹出的窗口里完成 Cloudflare 验证并登录 hanime，之后保持该浏览器运行即可',
            data: { url: page.url(), headless: false }
        });
    } catch (e) {
        res.json({
            code: -1,
            msg: '启动浏览器失败：' + e.message + '（请确认已安装 Chrome/Edge 或 ego-lite，且没有被安全软件拦截）'
        });
    }
});

module.exports = router;
