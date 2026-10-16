/**
 * routes/cloud-oauth.js —— 123云盘 / 百度网盘 OAuth 官方授权接入（round91）
 * ============================================================================
 * 背景：夸克只有 Cookie 私有协议一条路（routes/cloud.js），而 123云盘与百度网盘
 * 都有官方开放平台，可以做「跳转授权登录」：
 *   - 123云盘开放平台  https://123yunpan.yuque.com/...（open-api.123pan.com）
 *       授权页 https://yun.123pan.com/auth?client_id&redirect_uri&scope&state
 *       换token POST /api/v1/oauth2/access_token（grant_type=authorization_code / refresh_token）
 *       access_token 2h 有效，refresh_token 90天 且单次有效（必须每次落盘）
 *   - 百度网盘开放平台  https://pan.baidu.com/union
 *       授权页 https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&scope=basic,netdisk
 *       换token GET https://openapi.baidu.com/oauth/2.0/token（30天有效，refresh_token 续期）
 *       文件列表 GET pan.baidu.com/rest/2.0/xpan/file?method=list&dir=/路径
 *       下载 GET ...?method=filemetas&fsids=[..]&dlink=1 → dlink 必须带 User-Agent 头访问
 *
 * 授权流程：
 *   1. 用户在设置 → 授权Cookie 里填 client_id / client_secret（各开放平台注册应用获得）
 *   2. 点「授权」→ 后端生成 state 存内存 → 返回授权页 URL → 前端 window.open
 *   3. 用户在授权页登录并同意 → 网盘跳回 redirect_uri = 本应用
 *      http://host:port/api/cloud/oauth/callback/:provider?code=..&state=..
 *   4. 后端校验 state → 用 code 换 token → 写入 config.json cloudOAuth 段 → 返回成功页
 *
 * token 自动续期：getAccessToken() 发现快过期就 refresh；refresh_token 是单次票，
 * 必须把新的 refreshToken 立刻写回 config（丢了这个就只能重新授权一次）。
 *
 * 网盘目录绑定：POST /set-media-dir {provider,type,fid,name}（type = movie/comic/novel）
 *   与夸克的 sources.quark.comicDir 同构，写入 cloudOAuth.<p>.mediaDirs.<type>；
 *   功能页「网盘 / 全部」视图聚合夸克 + 123 + 百度的绑定目录（GET /media-files）。
 * ============================================================================
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const configUtil = require('../utils/config');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// round97：控制面请求（换票/验证/刷新）统一 20s 超时 —— 之前裸 fetch 在代理半死时会
// 挂 180s+，前端「保存 Token」点了没任何反应；超时必须变成一句人话报错，绝不能静默挂死。
async function fetchT(url, opts = {}, ms = 20000) {
    try {
        const c = new AbortController();
        const timer = setTimeout(() => c.abort(), ms);
        try {
            return await fetch(url, { ...opts, signal: c.signal });
        } finally { clearTimeout(timer); }
    } catch (e) {
        if (/abort|timeout/i.test(String((e && (e.message || e)) || ''))) {
            throw new Error('请求超时（' + (ms / 1000) + 's）——网络或系统代理不通，稍后重试');
        }
        throw e;
    }
}

// 复用 cloud.js 的 epub 解析与夸克爬虫（已在 cloud.js 末尾追加导出）
let parseEpub = null;
try { parseEpub = require('./cloud').parseEpub; } catch (e) { parseEpub = null; }
let getQuarkCrawler = null;
try { getQuarkCrawler = require('./cloud').getQuarkCrawler; } catch (e) { getQuarkCrawler = null; }

const { configPath } = configUtil;
const CONFIG_PATH = configPath;

function readConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4), 'utf8');
}

// ==================== 提供方定义 ====================

const PAN123_API = 'https://open-api.123pan.com';
const BAIDU_OPEN = 'https://openapi.baidu.com/oauth/2.0';
const BAIDU_PCS = 'https://pan.baidu.com/rest/2.0/xpan';

// round93：123云盘「快速授权」通道 —— 复用 Alist 开源工具的公共授权应用。
// 用户无需注册开放平台开发者：跳 123 官方授权页 → 同意 → Alist 回调页显示
// access_token / refresh_token → 复制回来即可。带 code 的回调 URL 还可以由
// Alist 公共换票接口（api.alistgo.com/alist/123pan/code）直接换出双 token。
// 限制：快速通道的 token 刷新不带 client_secret（不保证成功），失败则提示重新授权。
const PAN123_QUICK = {
    clientId: 'zpcup2ci1kmy62s8mkbc363e32z2v9l5',
    authorizeUrl: 'https://yun.123pan.com/auth?client_id=zpcup2ci1kmy62s8mkbc363e32z2v9l5' +
        '&redirect_uri=https%3A%2F%2Falistgo.com%2Ftool%2F123pan%2Fcallback' +
        '&scope=user%3Abase%2Cfile%3Aall%3Aread%2Cfile%3Aall%3Awrite&state=alist',
    exchanger: 'https://api.alistgo.com/alist/123pan/code',
};

const PROVIDERS = {
    pan123: {
        label: '123云盘',
        credLabels: { clientId: 'client_id（AppID）', clientSecret: 'client_secret（SecretID）' },
        docHint: '在 123云盘开放平台（123yunpan.yuque.com 文档站 → 控制台 https://www.123pan.com/developer）创建应用后获得，回调地址须与应用内登记一致',
        authorizeUrl(clientId, redirectUri, state) {
            const q = new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirectUri,
                scope: 'user:base,file:all:read,file:all:write',
                state
            });
            return 'https://yun.123pan.com/auth?' + q.toString();
        },
    },
    baidu: {
        label: '百度网盘',
        credLabels: { clientId: 'AppKey（API Key）', clientSecret: 'SecretKey' },
        docHint: '在百度网盘开放平台（pan.baidu.com/union）创建应用后获得，授权回调地址须与应用内登记一致',
        authorizeUrl(clientId, redirectUri, state) {
            const q = new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: redirectUri,
                scope: 'basic,netdisk',
                display: 'page',
                state
            });
            return BAIDU_OPEN + '/authorize?' + q.toString();
        },
    },
};

const OAUTH_PROVIDERS = ['pan123', 'baidu'];
const MEDIA_TYPES = ['movie', 'comic', 'novel'];
const TYPE_LABEL = { movie: '影视', comic: '漫画', novel: '小说' };

// 各类型允许在线展示的扩展名（与 routes/cloud.js 的 quark media-files 对齐）
const EXTS_BY_TYPE = {
    movie: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.rmvb', '.mpg', '.mpeg'],
    comic: ['.epub', '.pdf', '.cbz', '.cbr', '.zip'],
    novel: ['.epub', '.pdf', '.txt'],
};

// ==================== 授权态存取 ====================

// CSRF state：内存 Map，10 分钟有效（本进程一次性，重启作废也无妨）
const pendingStates = new Map();   // state -> { provider, ts }

function makeOAuthSection(cfg, provider) {
    if (!cfg.cloudOAuth) cfg.cloudOAuth = {};
    if (!cfg.cloudOAuth[provider]) {
        cfg.cloudOAuth[provider] = {
            clientId: '', clientSecret: '',
            accessToken: '', refreshToken: '', expireAt: 0,
            mediaDirs: {},   // type -> { fid, name }
        };
    }
    if (!cfg.cloudOAuth[provider].mediaDirs) cfg.cloudOAuth[provider].mediaDirs = {};
    return cfg.cloudOAuth[provider];
}

// token 内存缓存：省掉每次请求都读盘
const tokenMem = {};   // provider -> { accessToken, expireAt }

/**
 * ★ round102：从 JWT 里读真实有效期（毫秒时间戳；不是 JWT 就返回 0）。
 *
 * 【为什么必须这么做 —— 用户报的「每次重开都要重新授权」的真因】
 *   123 快速授权拿到的是 JWT（HS256），payload 里带 exp（实测 30 天后）。
 *   但换票/验证响应里**没有 expires_in**，旧代码只能按 1 小时估 → 写进 config 的
 *   expireAt = 现在+1h。1 小时后：
 *     · /status 用 sec.expireAt 判定 → 说「已授权」（还带个假过期时间）
 *     · 真取文件走 getAccessToken → expireAt 已过 → refreshToken() → refresh_token 为空
 *       → 抛 NeedAuthError ⇒ 界面弹「尚未授权」，但 token 明明还有 30 天有效期。
 *   只要 token 是 JWT，就一律以它自己的 exp 为准（比任何估算都可靠）。
 */
function jwtExpMs(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3 || !parts[1]) return 0;
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(Buffer.from(b64 + '='.repeat((4 - b64.length % 4) % 4), 'base64').toString('utf8'));
        const exp = Number(payload && payload.exp);
        return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
    } catch (e) { return 0; }
}

function saveTokens(provider, tok) {
    const cfg = readConfig();
    const sec = makeOAuthSection(cfg, provider);
    sec.accessToken = tok.accessToken || '';
    sec.refreshToken = tok.refreshToken || sec.refreshToken || '';
    // round102：JWT 版 access_token 自带 exp，直接采用（覆盖「估 1 小时」那种不可靠值）
    const jwtExp = jwtExpMs(sec.accessToken);
    sec.expireAt = jwtExp > Date.now() ? jwtExp : (tok.expireAt || 0);
    if (tok.authMode) sec.authMode = tok.authMode;   // quick / app（round93：不传则保留原值）
    writeConfig(cfg);
    tokenMem[provider] = { accessToken: sec.accessToken, expireAt: sec.expireAt };
}

function loadTokens(provider) {
    if (tokenMem[provider] && tokenMem[provider].accessToken) {
        // 内存命中也要看过期（写盘后 tokenMem 会同步，这里只是兜底）
        if ((tokenMem[provider].expireAt || 0) > Date.now() + 60000) return tokenMem[provider];
    }
    try {
        const cfg = readConfig();
        const sec = makeOAuthSection(cfg, provider);
        if (sec.accessToken) {
            // round102 自愈：历史配置里的 expireAt 是「估 1 小时」写下的假值，
            // 会让仍然有效的 JWT token 被判过期。读到就按 JWT exp 纠正并回写，
            // 这样 /status 与实际取文件行为也一致（不再出现「状态说没授权」的错觉）。
            const jwtExp = jwtExpMs(sec.accessToken);
            if (jwtExp && jwtExp !== (sec.expireAt || 0)) {
                sec.expireAt = jwtExp;
                try { writeConfig(cfg); } catch (e) { /* 写盘失败不影响本次使用 */ }
            }
            tokenMem[provider] = { accessToken: sec.accessToken, expireAt: sec.expireAt || 0 };
            return tokenMem[provider];
        }
    } catch (e) { /* 配置还没生成 */ }
    return null;
}

class NeedAuthError extends Error {
    constructor(msg) { super(msg || '尚未授权，请先在「设置 → 授权Cookie」完成授权'); this.needAuth = true; }
}

// refresh_token 单次有效 → 换到的新的必须立刻落盘
async function refreshToken(provider) {
    const p = PROVIDERS[provider];
    const cfg = readConfig();
    const sec = makeOAuthSection(cfg, provider);
    const isQuick = provider === 'pan123' && sec.authMode === 'quick';

    // round102 防御：手上这个 JWT access_token 其实还没到期（只是 expireAt 被估小了）→ 直接复用，
    // 绝不误报「需要重新授权」。这是「每次重开都要重新授权」最直接的兜底。
    const ownExp = jwtExpMs(sec.accessToken);
    if (ownExp > Date.now() + 60000) {
        if (ownExp !== (sec.expireAt || 0)) {
            sec.expireAt = ownExp;
            try { writeConfig(cfg); } catch (e) { /* 忽略 */ }
        }
        tokenMem[provider] = { accessToken: sec.accessToken, expireAt: ownExp };
        return sec.accessToken;
    }

    let url;
    if (provider === 'pan123') {
        if (!sec.refreshToken) {
            throw new NeedAuthError('123云盘的 access_token 已过期，且这次授权没有 refresh_token（快速授权只粘了 access_token 时就是如此）。请重新点「一键快速授权」完整走一遍——回调页整页复制可同时拿到 access_token 与 refresh_token');
        }
        if (!isQuick && (!sec.clientId || !sec.clientSecret)) throw new NeedAuthError();
        const q = new URLSearchParams({
            client_id: isQuick ? PAN123_QUICK.clientId : sec.clientId,
            client_secret: isQuick ? '' : sec.clientSecret,   // 快速通道没有 secret，交给服务端裁决
            grant_type: 'refresh_token', refresh_token: sec.refreshToken,
        });
        url = PAN123_API + '/api/v1/oauth2/access_token?' + q.toString();
    } else {
        const q = new URLSearchParams({
            grant_type: 'refresh_token', refresh_token: sec.refreshToken,
            client_id: sec.clientId, client_secret: sec.clientSecret,
        });
        url = BAIDU_OPEN + '/token?' + q.toString();
    }
    const resp = await fetchT(url, { method: 'POST' });
    const j = await resp.json().catch(() => ({}));
    const at = j.access_token;
    if (!at) {
        // refresh 票失效：清掉本地 token，逼用户重新走一次授权
        sec.accessToken = ''; sec.expireAt = 0;
        if (j.error && /invalid_grant|expired/i.test(j.error + ' ' + (j.error_description || ''))) {
            sec.refreshToken = '';
        }
        writeConfig(cfg);
        delete tokenMem[provider];
        const why = j.error_description || j.error || j.msg || 'HTTP ' + resp.status;
        throw new NeedAuthError(isQuick
            ? '快速授权的 token 无法自动续期（' + why + '）。请重新点「一键快速授权」，或在高级选项里改用自建应用获得可自动续期的授权'
            : '授权已过期且无法自动续期（' + why + '），请重新授权');
    }
    saveTokens(provider, {
        accessToken: at,
        refreshToken: j.refresh_token || sec.refreshToken,
        expireAt: Date.now() + Math.max(60, (Number(j.expires_in) || 7200) - 300) * 1000,
    });
    return tokenMem[provider].accessToken;
}

async function getAccessToken(provider) {
    if (!PROVIDERS[provider]) throw new Error('未知的网盘提供方: ' + provider);
    const tok = loadTokens(provider);
    if (tok && (tok.expireAt || 0) > Date.now() + 120000) return tok.accessToken;
    // expireAt=0（快速授权粘贴的裸 token，有效期未知）：先用着，401 时再走刷新/重授权
    if (tok && tok.accessToken && !(tok.expireAt || 0)) return tok.accessToken;
    return refreshToken(provider);
}

// ==================== 各提供方 API 封装 ====================

// --- 123云盘 ---
async function pan123Api(pathName, params = {}, retry = true) {
    const token = await getAccessToken('pan123');
    const q = new URLSearchParams(params);
    const resp = await fetchT(PAN123_API + pathName + '?' + q.toString(), {
        headers: { Authorization: 'Bearer ' + token, Platform: 'open_platform' },
    });
    const j = await resp.json().catch(() => ({}));
    // 123 未授权时 code=401（HTTP 也可能 401）
    if ((j.code === 401 || resp.status === 401) && retry) {
        delete tokenMem.pan123;
        return pan123Api(pathName, params, false);
    }
    if (j.code && j.code !== 0) {
        const err = new Error('123云盘接口错误 ' + j.code + ': ' + (j.message || j.msg || ''));
        err.code = j.code;
        throw err;
    }
    return j.data || j;
}

// --- 百度网盘 ---
// errno 111 = access_token 失效；-6 = 身份验证失败 → 都按重新授权处理（先试一次刷新）
async function baiduApi(baseUrl, params = {}, retry = true) {
    const token = await getAccessToken('baidu');
    const q = new URLSearchParams(params);
    q.set('access_token', token);
    const resp = await fetchT(baseUrl + '?' + q.toString());
    const j = await resp.json().catch(() => ({}));
    if ((j.errno === 111 || j.errno === -6) && retry) {
        delete tokenMem.baidu;
        return baiduApi(baseUrl, params, false);
    }
    if (j.errno && j.errno !== 0) {
        const err = new Error('百度网盘接口错误 errno=' + j.errno);
        err.errno = j.errno;
        throw err;
    }
    return j;
}

// 列目录：统一输出 { list: [{fid, name, size, is_dir}], total }
async function listFolder(provider, fid, page) {
    if (provider === 'pan123') {
        const data = await pan123Api('/api/v1/file/list', {
            parentFileId: fid || 0,
            page: page || 1,
            limit: 100,
            orderBy: 'file_id',
            orderDirection: 'asc',
        });
        const raw = data.fileList || data.file_list || [];
        const list = raw
            .filter(x => !x.trashed)
            .map(x => ({
                fid: String(x.fileID !== undefined ? x.fileID : (x.fileId !== undefined ? x.fileId : x.id)),
                name: String(x.filename || x.fileName || x.name || ''),
                size: Number(x.size) || 0,
                is_dir: Number(x.type) === 1,
            }));
        return { list, total: Number(data.total) || list.length };
    }

    // baidu：fid 是完整路径（/ 为根）
    const dir = fid || '/';
    const data = await baiduApi(BAIDU_PCS + '/file', {
        method: 'list',
        dir,
        limit: 100,
        order: 'name',
        webdavstatus: '1',
    });
    const raw = data.list || [];
    const list = raw.map(x => ({
        fid: String(x.path || ''),                    // 百度用路径当 id
        name: String(x.server_filename || x.path.split('/').pop() || ''),
        size: Number(x.size) || 0,
        is_dir: Number(x.isdir) === 1,
    }));
    return { list, total: list.length };
}

// 直链获取（流播 / 下载用）
const directLinkCache = new Map();   // provider:fid -> { url, ts }

async function getDirectUrl(provider, fid) {
    const key = provider + ':' + fid;
    const hit = directLinkCache.get(key);
    if (hit && Date.now() - hit.ts < 4 * 60 * 1000) return hit.url;

    let url;
    if (provider === 'pan123') {
        // round100 实测：直链接口要求文件所在文件夹开启「直链空间」（123 侧手动开启、根目录不支持），
        // 未开启报 code 400「该文件并未开启直链空间」→ 兜底走 download_info 下载接口
        // （GET /api/v1/file/download_info，免费可用实测 200 返回 downloadUrl，支持 Range）
        try {
            const data = await pan123Api('/api/v1/direct-link/url', { fileID: fid });
            url = data.url || (data.data && data.data.url);
        } catch (e) {
            url = '';
        }
        if (!url) {
            const d2 = await pan123Api('/api/v1/file/download_info', { fileID: fid });
            url = d2 && (d2.downloadUrl || d2.download_url || d2.url);
        }
        if (!url) throw new Error('123云盘未返回下载链接（文件可能已删除或无权限）');
    } else {
        const data = await baiduApi(BAIDU_PCS + '/file', {
            method: 'filemetas',
            fsids: '[' + Number(fid) + ']',
            dlink: '1',
        });
        const item = (data.list || [])[0];
        if (!item || !item.dlink) throw new Error('百度网盘未返回下载直链');
        // dlink 后面必须拼 access_token，且请求必须带 User-Agent，否则 403
        url = item.dlink + '&access_token=' + await getAccessToken('baidu');
    }
    directLinkCache.set(key, { url, ts: Date.now() });
    return url;
}

// 百度下载必须带 UA；123 直链一般裸拉也行，统一带一个
const DOWNLOAD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CinemaVault/' + (process.env.npm_package_version || '1.0');

// ==================== 路由 ====================

// 授权状态总览（设置页用；quark 的媒体目录绑定也一并回报，扫描路径页统一渲染）
router.get('/status', (req, res) => {
    try {
        const cfg = readConfig();
        const proto = req.protocol || 'http';
        const host = req.headers.host || '127.0.0.1';
        const providers = {};
        for (const p of OAUTH_PROVIDERS) {
            const sec = cfg.cloudOAuth && cfg.cloudOAuth[p];
            const credOk = !!(sec && sec.clientId && sec.clientSecret);
            const tok = sec && sec.accessToken;
            const isQuick = p === 'pan123' && sec && sec.authMode === 'quick';
            // round102：JWT token 以自身 exp 为准（历史配置里的假 expireAt 不再误导状态页）
            const jwtExp = jwtExpMs(tok);
            const expMs = jwtExp || (sec && sec.expireAt) || 0;
            providers[p] = {
                label: PROVIDERS[p].label,
                configured: isQuick ? true : credOk,
                configuredClientId: (sec && sec.clientId) || '',
                authMode: (sec && sec.authMode) || (credOk ? 'app' : ''),
                authorized: isQuick ? !!(tok || (sec && sec.refreshToken)) : !!(credOk && tok),
                expireAt: expMs,
                expireFromJwt: !!jwtExp,
                accessTokenExpired: !!tok && !!expMs && expMs <= Date.now(),
                refreshTokenOk: !!(sec && sec.refreshToken),
                quickUrl: p === 'pan123' ? PAN123_QUICK.authorizeUrl : undefined,
                redirectUri: proto + '://' + host + '/api/cloud/oauth/callback/' + p,
                mediaDirs: (sec && sec.mediaDirs) || {},
            };
        }
        const quarkDirs = {};
        for (const t of MEDIA_TYPES) {
            const key = { comic: 'comicDir', novel: 'novelDir', movie: 'movieDir' }[t];
            const d = cfg.sources && cfg.sources.quark && cfg.sources.quark[key];
            if (d) quarkDirs[t] = d;
        }
        res.json({ code: 0, data: { providers, quark: { label: '夸克网盘', mediaDirs: quarkDirs } } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 保存应用凭证（开放平台注册后发的 client_id / client_secret）
router.post('/credentials/:provider', (req, res) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        const { clientId, clientSecret } = req.body || {};
        if (!clientId || !clientSecret) return res.json({ code: -1, msg: 'client_id / client_secret 不能为空' });
        const cfg = readConfig();
        const sec = makeOAuthSection(cfg, provider);
        sec.clientId = String(clientId).trim();
        sec.clientSecret = String(clientSecret).trim();
        sec.authMode = 'app';   // round93：明确切到自建应用模式（完整 OAuth + 自动续期）
        writeConfig(cfg);
        res.json({ code: 0, msg: '凭证已保存' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ==================== round93：123云盘快速授权（Alist 公共应用通道） ====================
// POST /quick-token/pan123 { value } —— value 兼容四种输入：
//   a) Alist 回调页完整 URL（带 code=）→ 调 Alist 公共换票接口换出双 token（推荐）
//   b) 回调页显示的整段 JSON → 直接抽取 access_token / refresh_token
//   c) 回调页显示的 refresh_token → 先尝试换出 access_token（快速通道无 secret，可能失败）
//   d) 回调页显示的 access_token → 验证通过后直接存（过期后需重新授权）
// ★ 任何路径都「先验证再落盘」：无效 token 一律拒绝保存并明确报错（round94 教训：
//   用户把回调页的 {"code":401,...} 错误体粘进来，旧版当 token 存了还提示授权完成）
router.post('/quick-token/pan123', express.json(), async (req, res) => {
    try {
        const raw = String((req.body || {}).value || '').trim();
        if (!raw) return res.json({ code: -1, msg: '请粘贴 Alist 回调地址、回调页 JSON 或 Token' });

        let at = '', rt = '', expiresIn = 0, via = '';
        // 去掉全部空白（回调页的 token 可能被换行折断；token 本身只含 [A-Za-z0-9._-]，清洗安全）
        const flat = raw.replace(/\s+/g, '');
        // 带标签文本（如回调页整页复制出来的 "access_token: eyJ... refresh_token: ODI5..."）
        // round97：Alist 回调页整页复制还可能是「access_token eyJ...」无分隔符格式
        //（label 和 token 之间只有空格/换行）→ raw 回退正则允许省略分隔符，40/20 位长度门槛挡误匹配
        const labeledA = flat.match(/access_token[:：=]([A-Za-z0-9._-]{40,})/i) || raw.match(/access_token\s*[:：=]?\s*([A-Za-z0-9._-]{40,})/i);
        const labeledR = flat.match(/refresh_token[:：=]([A-Za-z0-9._-]{20,})/i) || raw.match(/refresh_token\s*[:：=]?\s*([A-Za-z0-9._-]{20,})/i);
        // round97b：输入日志（不记 token 全文，只记形态）——用户再报错时能直接看到粘的是什么
        console.log('[cloud-oauth] quick-token input:', JSON.stringify({
            len: raw.length,
            head: raw.slice(0, 28).replace(/\s+/g, ' '),
            isJson: raw.startsWith('{'),
            hasCode: /[?&]code=/.test(raw),
        }));
        // b) JSON（成功态=含 token 的响应体；失败态=Alist 换票错误，如 {"error":"invalid_grant",...}）
        // round97b：整页复制可能是「JSON + token 框」混合文本 → 整体 parse 失败时先截取
        // 首个 {...} 块再试，仍失败则落到 labeled / 裸 token 分支，绝不短路报错
        let j = null;
        if (raw.startsWith('{')) {
            try { j = JSON.parse(raw); } catch (e) { /* 整段不是 JSON */ }
            if (!j) {
                const m = raw.match(/\{[^{}]*\}/);
                if (m) { try { j = JSON.parse(m[0]); } catch (e) { /* 首块也不是 JSON */ } }
            }
        }
        if (j) {
            const d = (j.data && typeof j.data === 'object') ? j.data : j;
            at = d.access_token || d.accessToken || '';
            rt = d.refresh_token || d.refreshToken || '';
            expiresIn = Number(d.expires_in || d.expiresIn) || 0;
            if (at || rt) {
                via = '回调页 JSON 自动提取';
            } else if (labeledA || labeledR) {
                // JSON 里没 token 但文本里带标签 → 继续提取
                at = labeledA ? labeledA[1] : '';
                rt = labeledR ? labeledR[1] : '';
                if (at) via = '从带标签文本中提取 access_token';
            } else {
                // 确实是错误 JSON：按错误类型给精准引导（round97b 实测 Alist 换票失败返回
                // {"error":"invalid_grant","error_description":"The provided authorization grant..."}）
                const why = String(j.error_description || j.error || j.msg || j.message || ('code=' + j.code) || '未知错误').slice(0, 120);
                let hint;
                if (j.error === 'invalid_grant' || /invalid_grant|expired|revoked/i.test(why)) {
                    hint = '这是 Alist 回调页「换票失败」的 JSON：你带回来的授权码无效/已过期/已被使用。授权码是一次性的，旧回调页复制多少次都没用——请回到本应用重新点「一键快速授权」完整走一遍；如果授权页没让你登录 123，先打开 www.123pan.com 退出账号重新登录再授权';
                } else if (/access.?token/i.test(why)) {
                    // 官方确认的坑：授权页复用了失效的 123pan 网页会话 → 签出的授权码无效
                    hint = '这是 123云盘网页登录态失效的典型表现：先打开 www.123pan.com 退出账号并重新登录，然后回来重新点「一键快速授权」';
                } else {
                    hint = '请回到本应用重新点「一键快速授权」完整走一遍，并把新的回调页整页复制（Ctrl+A → Ctrl+C）';
                }
                return res.json({ code: -1, msg: '粘贴的内容是错误信息而不是 token（' + why + '）。' + hint });
            }
        } else if (/^https?:\/\//i.test(raw) || /[?&]code=/.test(raw)) {
            let code = '';
            try { code = new URL(raw).searchParams.get('code') || ''; }
            catch (e) { const m = raw.match(/[?&]code=([^&]+)/); code = m ? m[1] : ''; }
            if (!code) return res.json({ code: -1, msg: '回调地址里没有 code 参数' });
            const r = await fetchT(PAN123_QUICK.exchanger, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const j = await r.json().catch(() => ({}));
            const d = j && j.data ? j.data : j;
            at = d.access_token || d.accessToken || '';
            rt = d.refresh_token || d.refreshToken || '';
            expiresIn = Number(d.expires_in || d.expiresIn) || 0;
            if (!at && !rt) return res.json({ code: -1, msg: 'Alist 换票失败：' + (j.error_description || j.error || j.message || j.msg || ('HTTP ' + r.status)) + '（授权码是一次性的，且回调页打开那一刻就已经消费掉了——复制地址让我们再换票必然失败。请回到本应用重新点「一键快速授权」完整走一遍，成功后在回调页整页 Ctrl+A → Ctrl+C 复制）' });
            via = '回调地址自动换票';
        } else if (labeledA || labeledR) {
            // c2) 整页全选复制出来的带标签文本 → 优先抽 access_token（快速通道真正能用的就是它）
            at = labeledA ? labeledA[1] : '';
            rt = labeledR ? labeledR[1] : '';
            if (at) via = '从带标签文本中提取 access_token';
        } else if (raw.startsWith('{')) {
            // { 开头但 JSON 解析失败、又没有任何可识别的 token → 别拿乱码去当 token 验证
            return res.json({ code: -1, msg: '粘贴的内容以 { 开头但既不是合法 JSON 也不含可识别的 token。请回到回调页整页复制（Ctrl+A → Ctrl+C），或只复制 access_token（长的那段 JWT）' });
        } else {
            const tokenCand = flat;   // 裸 token 也用清洗后的
            const q = new URLSearchParams({
                client_id: PAN123_QUICK.clientId, client_secret: '',
                grant_type: 'refresh_token', refresh_token: tokenCand,
            });
            const r = await fetchT(PAN123_API + '/api/v1/oauth2/access_token?' + q.toString(), { method: 'POST' });
            const j = await r.json().catch(() => ({}));
            if (j.access_token) {
                at = j.access_token;
                rt = j.refresh_token || tokenCand;
                expiresIn = Number(j.expires_in) || 0;
                via = 'refresh_token 已自动换取 access_token';
            } else {
                at = tokenCand;
                via = 'access_token 直接保存';
            }
        }

        // 只有 refresh_token 没有 access_token → 尝试换票；换不到就明说，绝不落盘
        if (!at && rt) {
            return res.json({ code: -1, msg: '只拿到了 refresh_token（短的那段），它在快速通道里换不出可用的 access_token。请复制回调页里长的 access_token（或整页 Ctrl+A 全选复制）' });
        }

        // ★ 先验证再落盘
        const bad = await (async () => {
            try {
                // ★round98b：123 接口「先验 token 后验参数」，file/list 现在强制要求
                // orderBy/orderDirection —— 少传会被参数校验拦下，误判「验证未通过」
                //（实测：假 token 缺参返回 401，真 token 缺参返回 code=1 OrderBy required）
                const resp = await fetchT(PAN123_API + '/api/v1/file/list?parentFileId=0&page=1&limit=1&orderBy=file_id&orderDirection=asc', {
                    headers: { Authorization: 'Bearer ' + at, Platform: 'open_platform' },
                });
                const j = await resp.json().catch(() => ({}));
                if (resp.ok && (j.code === 0 || j.code === undefined)) return null;
                if (j.code === 401 || resp.status === 401) return 'token 无效（123云盘返回 401）——请确认复制的是 access_token 本体（长的那段 JWT）';
                return '验证未通过（接口 code=' + (j.code || resp.status) + (j.message ? ' ' + j.message : '') + '）';
            } catch (e) { return '验证请求失败：' + e.message; }
        })();
        if (bad) return res.json({ code: -1, msg: '未保存（' + (via || '来源未识别') + '）。' + bad });

        saveTokens('pan123', {
            accessToken: at, refreshToken: rt,
            // 有效期未知时按 1 小时估（乐观使用，401 时前端会提示重新授权）
            expireAt: Date.now() + Math.max(60, (expiresIn || 3600) - 300) * 1000,
            authMode: 'quick',
        });

        res.json({ code: 0, msg: '123云盘 授权完成（' + via + '），已通过 123云盘接口验证 ✔' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 生成授权跳转地址
router.get('/authorize/:provider', (req, res) => {
    try {
        const { provider } = req.params;
        const p = PROVIDERS[provider];
        if (!p) return res.json({ code: -1, msg: '未知的网盘提供方' });
        const cfg = readConfig();
        const sec = cfg.cloudOAuth && cfg.cloudOAuth[provider];
        if (!sec || !sec.clientId || !sec.clientSecret) {
            return res.json({ code: -1, msg: '请先填写并保存应用凭证（client_id / client_secret）' });
        }
        const proto = req.protocol || 'http';
        const host = req.headers.host || '127.0.0.1';
        const redirectUri = proto + '://' + host + '/api/cloud/oauth/callback/' + provider;
        const state = crypto.randomBytes(8).toString('hex');
        pendingStates.set(state, { provider, ts: Date.now() });
        // 清理 10 分钟前的残留
        for (const [k, v] of pendingStates) {
            if (Date.now() - v.ts > 10 * 60 * 1000) pendingStates.delete(k);
        }
        res.json({ code: 0, data: { url: p.authorizeUrl(sec.clientId, redirectUri, state), redirectUri, state } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 授权回调（网盘服务器 302 回来）
router.get('/callback/:provider', async (req, res) => {
    const { provider } = req.params;
    const p = PROVIDERS[provider];
    if (!p) return res.status(404).send('未知的提供方');

    const { code, state, error, error_description } = req.query;
    const html = (ok, title, msg) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;background:#f5f2ea;color:#333;}
.box{max-width:460px;padding:38px 42px;border-radius:16px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.12);text-align:center;}
h1{font-size:20px;margin:0 0 12px}p{font-size:14px;color:#666;line-height:1.8;margin:6px 0}a{color:#C08A2D}</style></head>
<body><div class="box"><h1>${ok ? '✅' : '❌'} ${title}</h1><p>${msg}</p>
<p style="margin-top:18px;font-size:13px;">完成${ok ? '' : '排查后'}可以关闭这个窗口，回到应用查看状态。</p></div>
${ok ? '<script>setTimeout(function(){try{window.close()}catch(e){}},2500)</script>' : ''}</body></html>`;

    try {
        if (error) {
            return res.send(html(false, '授权被取消', (error_description || error) + '。请回到应用重新点「授权」。'));
        }
        const st = pendingStates.get(state);
        if (!st || st.provider !== provider) {
            return res.send(html(false, 'state 校验失败', '回调参数与会话不匹配（可能超时超过10分钟或重复回调）。请回到应用重新点「授权」。'));
        }
        pendingStates.delete(state);
        if (!code) return res.send(html(false, '缺少授权码', '回调里没有 code 参数，请重新授权。'));

        // 换 token —— 两家的端点与参数不同，分开处理
        const cfg = readConfig();
        const sec = makeOAuthSection(cfg, provider);
        const proto = req.protocol || 'http';
        const host = req.headers.host || '127.0.0.1';
        const redirectUri = proto + '://' + host + '/api/cloud/oauth/callback/' + provider;

        let j;
        if (provider === 'pan123') {
            const q = new URLSearchParams({
                client_id: sec.clientId, client_secret: sec.clientSecret,
                grant_type: 'authorization_code', code: String(code),
                redirect_uri: redirectUri,
            });
            const resp = await fetchT(PAN123_API + '/api/v1/oauth2/access_token?' + q.toString(), { method: 'POST' });
            j = await resp.json().catch(() => ({}));
        } else {
            const q = new URLSearchParams({
                grant_type: 'authorization_code', code: String(code),
                client_id: sec.clientId, client_secret: sec.clientSecret,
                redirect_uri: redirectUri,
            });
            const resp = await fetchT(BAIDU_OPEN + '/token?' + q.toString());
            j = await resp.json().catch(() => ({}));
        }

        if (!j.access_token) {
            const why = j.error_description || j.error || j.message || j.msg || ('HTTP 状态异常');
            return res.send(html(false, '换取令牌失败', '网盘返回：' + why + '。常见原因：回调地址与开放平台登记的不一致、授权码被用过（刷新重试）、凭证填错。'));
        }

        saveTokens(provider, {
            accessToken: j.access_token,
            refreshToken: j.refresh_token || sec.refreshToken || '',
            expireAt: Date.now() + Math.max(60, (Number(j.expires_in) || (provider === 'baidu' ? 2592000 : 7200)) - 300) * 1000,
        });

        res.send(html(true, p.label + ' 授权成功', '登录凭证已写入应用。回到应用 → 设置 → 授权Cookie 可以看到状态已变为「已授权」。'));
    } catch (e) {
        res.send(html(false, '授权失败', e.message));
    }
});

// 手动模式：用户把回调 URL（或其中的 code）粘贴回来
router.post('/callback-manual', express.json(), async (req, res) => {
    try {
        const { provider, value } = req.body || {};
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        if (!value) return res.json({ code: -1, msg: '请粘贴回调地址或授权码' });
        let code = '', state = '';
        if (/[?&]code=/.test(value)) {
            try {
                const u = new URL(value);
                code = u.searchParams.get('code') || '';
                state = u.searchParams.get('state') || '';
            } catch (e) {
                const m = String(value).match(/code=([^&]+)/);
                code = m ? m[1] : '';
                const m2 = String(value).match(/state=([^&]+)/);
                state = m2 ? m2[1] : '';
            }
        } else {
            code = String(value).trim();
        }
        if (!code) return res.json({ code: -1, msg: '解析不到授权码' });
        // 手动模式跳过 state 校验（粘贴整条回调 URL 时 state 同样在参数里，可防误绑，不强制）
        const cfg = readConfig();
        const sec = makeOAuthSection(cfg, provider);
        const proto = req.protocol || 'http';
        const host = req.headers.host || '127.0.0.1';
        const redirectUri = proto + '://' + host + '/api/cloud/oauth/callback/' + provider;

        let j;
        if (provider === 'pan123') {
            const q = new URLSearchParams({
                client_id: sec.clientId, client_secret: sec.clientSecret,
                grant_type: 'authorization_code', code,
                redirect_uri: redirectUri,
            });
            const resp = await fetchT(PAN123_API + '/api/v1/oauth2/access_token?' + q.toString(), { method: 'POST' });
            j = await resp.json().catch(() => ({}));
        } else {
            const q = new URLSearchParams({
                grant_type: 'authorization_code', code,
                client_id: sec.clientId, client_secret: sec.clientSecret,
                redirect_uri: redirectUri,
            });
            const resp = await fetchT(BAIDU_OPEN + '/token?' + q.toString());
            j = await resp.json().catch(() => ({}));
        }
        if (!j.access_token) {
            return res.json({ code: -1, msg: '换取令牌失败：' + (j.error_description || j.error || j.message || j.msg || '未知') });
        }
        saveTokens(provider, {
            accessToken: j.access_token,
            refreshToken: j.refresh_token || sec.refreshToken || '',
            expireAt: Date.now() + Math.max(60, (Number(j.expires_in) || (provider === 'baidu' ? 2592000 : 7200)) - 300) * 1000,
        });
        res.json({ code: 0, msg: PROVIDERS[provider].label + ' 授权成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 解除授权（清 token；凭证保留方便重新授权）
router.post('/disconnect/:provider', (req, res) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        const cfg = readConfig();
        if (cfg.cloudOAuth && cfg.cloudOAuth[provider]) {
            cfg.cloudOAuth[provider].accessToken = '';
            cfg.cloudOAuth[provider].refreshToken = '';
            cfg.cloudOAuth[provider].expireAt = 0;
            writeConfig(cfg);
        }
        delete tokenMem[provider];
        res.json({ code: 0, msg: '已解除授权' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ==================== 文件浏览 / 目录绑定 / 媒体列表 ====================

// 列文件夹（设置页目录选择器 + 网盘浏览页共用）
// pan123 的 fid 是数字目录ID；baidu 的 fid 是目录路径（根传 /）
router.get('/files/:provider', async (req, res) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        const fid = req.query.fid || (provider === 'pan123' ? '0' : '/');
        const page = parseInt(req.query.page) || 1;
        const data = await listFolder(provider, fid, page);
        res.json({ code: 0, data: { fid, ...data } });
    } catch (e) {
        res.json({ code: e.needAuth ? -2 : -1, msg: e.message, needAuth: !!e.needAuth });
    }
});

// 网盘媒体目录绑定（movie / comic / novel；quark 也走这里，落到 sources.quark.*Dir 保持同构）
router.post('/set-media-dir', (req, res) => {
    try {
        const { provider, type, fid, name } = req.body || {};
        if (!['pan123', 'baidu', 'quark'].includes(provider)) return res.json({ code: -1, msg: '未知的网盘提供方' });
        if (!MEDIA_TYPES.includes(type)) return res.json({ code: -1, msg: 'type 必须为 movie / comic / novel' });

        const cfg = readConfig();
        const quarkKey = { comic: 'comicDir', novel: 'novelDir', movie: 'movieDir' }[type];

        // 解绑：fid 传空串 → 删除该类型绑定（设置页「解绑」按钮）
        if (fid === '') {
            if (provider === 'quark') {
                if (cfg.sources && cfg.sources.quark) delete cfg.sources.quark[quarkKey];
            } else {
                const sec = makeOAuthSection(cfg, provider);
                delete sec.mediaDirs[type];
            }
            writeConfig(cfg);
            return res.json({ code: 0, msg: '目录已解绑' });
        }

        if (!fid && fid !== 0) return res.json({ code: -1, msg: '目录ID不能为空' });

        const store = {
            fid: String(fid),
            name: name || '',
        };
        if (provider === 'quark') {
            if (!cfg.sources) cfg.sources = {};
            if (!cfg.sources.quark) cfg.sources.quark = {};
            cfg.sources.quark[quarkKey] = store;
        } else {
            const sec = makeOAuthSection(cfg, provider);
            sec.mediaDirs[type] = store;
        }
        writeConfig(cfg);
        res.json({ code: 0, msg: '目录已保存', data: store });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 绑定目录下的媒体文件（type 过滤扩展名）；quark 有自己的同名接口，前端聚合时分别调用
router.get('/media-files', async (req, res) => {
    try {
        const { provider, type, page, pageSize } = req.query;
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        if (!MEDIA_TYPES.includes(type)) return res.json({ code: -1, msg: 'type 必须为 movie / comic / novel' });

        const cfg = readConfig();
        const sec = cfg.cloudOAuth && cfg.cloudOAuth[provider];
        const dir = sec && sec.mediaDirs && sec.mediaDirs[type];
        if (!dir || !dir.fid && dir.fid !== 0) {
            return res.json({ code: -1, msg: `尚未绑定${PROVIDERS[provider].label}的${TYPE_LABEL[type]}目录` });
        }

        const data = await listFolder(provider, String(dir.fid), 1);
        const ps = Math.min(500, parseInt(pageSize) || 300);
        const exts = EXTS_BY_TYPE[type] || [];
        const list = data.list
            .filter(f => !f.is_dir && exts.includes(path.extname(f.name).toLowerCase()))
            .slice(0, ps)
            .map(f => ({
                fid: f.fid,
                name: f.name,
                size: f.size,
                ext: path.extname(f.name).toLowerCase().replace(/^\./, ''),
            }));
        res.json({ code: 0, data: { dir, list, total: list.length, provider } });
    } catch (e) {
        res.json({ code: e.needAuth ? -2 : -1, msg: e.message, needAuth: !!e.needAuth });
    }
});

// ==================== 取流（视频/图片/pdf 直链代理） ====================
// 百度的 dlink 必须带 User-Agent 才能下，浏览器发不出自定义头 → 一律走服务端代理；
// 123 直链虽然能裸拉，但统一代理可以顺便解决跨域与防盗链不确定性。

function pipeProxy(resp, res) {
    res.status(resp.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const v = resp.headers.get(h);
        if (v) res.setHeader(h, v);
    }
    if (!resp.body) return res.end();
    if (typeof resp.body.pipe === 'function') return resp.body.pipe(res);
    const { Readable } = require('stream');
    return Readable.fromWeb(resp.body).pipe(res);
}

async function proxyDirect(req, res, provider, fid) {
    let url = await getDirectUrl(provider, fid);
    let headers = { 'User-Agent': DOWNLOAD_UA };
    if (req.headers.range) headers.Range = req.headers.range;

    let resp = await fetch(url, { headers });
    // 直链可能已失效（缓存命中过期签名）：清缓存重取一次
    if ((resp.status === 403 || resp.status === 404) && directLinkCache.has(provider + ':' + fid)) {
        directLinkCache.delete(provider + ':' + fid);
        url = await getDirectUrl(provider, fid);
        resp = await fetch(url, { headers });
    }
    if (!resp.ok) {
        return res.status(resp.status).json({
            code: -1,
            msg: provider === 'pan123'
                ? `123云盘直链返回 HTTP ${resp.status}（可能需要会员或文件被审核拦截）`
                : `百度网盘直链返回 HTTP ${resp.status}（若为 403 请尝试重新授权）`,
        });
    }
    pipeProxy(resp, res);
}

router.get('/stream/:provider', async (req, res) => {
    try {
        const { provider } = req.params;
        const { fid } = req.query;
        if (!PROVIDERS[provider]) return res.status(400).json({ code: -1, msg: '未知的网盘提供方' });
        if (!fid) return res.status(400).json({ code: -1, msg: '缺少 fid' });
        await proxyDirect(req, res, provider, String(fid));
    } catch (e) {
        if (!res.headersSent) res.status(e.needAuth ? 401 : 502).json({ code: -1, msg: e.message, needAuth: !!e.needAuth });
        else res.end();
    }
});

// epub 在线阅读（下载 → 解包 → 解析章节，与夸克 read/epub 同构）
router.get('/read/:provider/epub', async (req, res) => {
    try {
        const { provider } = req.params;
        const { fid } = req.query;
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        if (!fid) return res.json({ code: -1, msg: '文件ID不能为空' });
        if (!parseEpub) return res.json({ code: -1, msg: 'epub 解析模块不可用' });

        const url = await getDirectUrl(provider, String(fid));
        const resp = await fetch(url, { headers: { 'User-Agent': DOWNLOAD_UA } });
        if (!resp.ok) return res.json({ code: -1, msg: `下载失败 HTTP ${resp.status}` });
        const ab = await resp.arrayBuffer();
        const epub = await parseEpub(Buffer.from(ab));
        res.json({ code: 0, data: epub });
    } catch (e) {
        res.json({ code: e.needAuth ? -2 : -1, msg: e.message, needAuth: !!e.needAuth });
    }
});

// ==================== 封面：本地映射封面库（round100） ====================
// 对标 koob.one「导入即有封面」：网盘 epub/cbz/zip 文件 Range 抽封面（不下载整包），
// 抽到后落盘本地封面库（key=provider/fid-size），前端网盘浏览页/聚合卡片直接 <img> 引用。
const { extractZipCover } = require('../utils/zip-cover');
const COVER_CACHE_DIR = path.join(path.dirname(CONFIG_PATH), 'covers', 'cloud');

function sniffImgType(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
    return null;
}

router.get('/cover/:provider/:fid', async (req, res) => {
    try {
        const provider = req.params.provider;
        const fid = String(req.params.fid || '');
        const name = String(req.query.name || '');
        const size = Number(req.query.size) || 0;
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '';
        if (!({ epub: 1, cbz: 1, zip: 1 })[ext]) {
            return res.json({ code: 1, msg: '该类型暂不支持封面（' + (ext || '未知') + '）' });
        }

        // 本地封面库命中直接回（key = provider/fid-size；文件重传 size 变化自然换 key）
        const cacheFile = path.join(COVER_CACHE_DIR, provider, fid.replace(/[^\w.-]/g, '_') + '-' + size + '.img');
        if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 128) {
            const cbuf = fs.readFileSync(cacheFile);
            const ct = sniffImgType(cbuf);
            if (ct) {
                res.setHeader('Content-Type', 'image/' + ct);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.send(cbuf);
            }
        }

        // 抽取：下载 URL → Range 读 zip 容器（epub 封面命名优先；漫画取第一页）
        const url = await getDirectUrl(provider, fid);
        const fetchRange = async (start, end) => {
            const r = await fetchT(url, { headers: { Range: 'bytes=' + start + '-' + end, 'User-Agent': DOWNLOAD_UA } });
            if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
            return Buffer.from(await r.arrayBuffer());
        };
        const buf = await extractZipCover({ size, fetchRange, epub: ext === 'epub' });
        const imgType = sniffImgType(buf);
        if (!imgType) return res.json({ code: 2, msg: '未能从文件中抽取到封面' });
        try {
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, buf);
        } catch (e) { /* 缓存写失败不影响返回 */ }
        res.setHeader('Content-Type', 'image/' + imgType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// EPUB 内部资源（round101：漫画 EPUB 的页面图片）—— Range 抽 zip 指定路径条目，
// 内存 LRU 缓存（翻回上一页/重开章节不重复拉 CDN）
const { extractZipEntryByPath } = require('../utils/zip-cover');
const epubResCache = new Map();   // provider:fid:path -> { buf, ts }
const EPUB_RES_CACHE_MAX = 48;
// round103：文件体积探测缓存 —— 漫画 EPUB 的页面图是靠「Range 读 zip 中央目录」抽出来的，
// 第一步就要 size；而 cloud-reader 的 URL 里没有 size 参数（列表视图才有）。
// 缺 size 时 extractZipEntryByPath 直接 null ⇒ 全部图片 404（用户报的「图片破损」真根因）。
const cloudFileSizeCache = new Map();   // provider:fid -> bytes

async function probeCloudFileSize(provider, fid, directUrl) {
    const key = provider + ':' + fid;
    const hit = cloudFileSizeCache.get(key);
    if (hit) return hit;
    try {
        const r = await fetchT(directUrl, { headers: { Range: 'bytes=0-0', 'User-Agent': DOWNLOAD_UA } });
        let size = 0;
        const cr = r.headers.get('content-range') || '';
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) size = Number(m[1]) || 0;
        if (!size && r.status === 200) size = Number(r.headers.get('content-length') || 0) || 0;
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) { /* 忽略 */ }
        if (size) cloudFileSizeCache.set(key, size);
        return size;
    } catch (e) {
        return 0;
    }
}

function sniffResType(buf, p) {
    const byExt = (String(p).match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', css: 'text/css', html: 'text/html; charset=utf-8', xhtml: 'text/html; charset=utf-8', opf: 'text/xml', ncx: 'text/xml' };
    if (byExt && map[byExt]) return map[byExt];
    const t = sniffImgType(buf);
    return t ? 'image/' + t : 'application/octet-stream';
}

router.get('/epub-res/:provider/:fid', async (req, res) => {
    try {
        const provider = req.params.provider;
        const fid = String(req.params.fid || '');
        const resPath = String(req.query.path || '');
        let size = Number(req.query.size) || 0;
        if (!PROVIDERS[provider] || !fid || !resPath) return res.status(400).json({ code: -1, msg: '参数缺失' });
        // 防路径逃逸（zip 内本来就是扁平键，仅防御性）
        if (resPath.includes('..')) return res.status(400).json({ code: -1, msg: '非法路径' });

        const key = provider + ':' + fid + ':' + resPath;
        const hit = epubResCache.get(key);
        if (hit) {
            res.setHeader('Content-Type', sniffResType(hit.buf, resPath));
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(hit.buf);
        }

        const url = await getDirectUrl(provider, fid);
        // round103：size 缺省 ⇒ 后端自探测（否则 zip 抽取第一步就失败，图片全 404）
        if (!size) size = await probeCloudFileSize(provider, fid, url);
        if (!size) return res.status(502).json({ code: -1, msg: '无法确定文件体积，EPUB 内资源不可读' });
        const fetchRange = async (start, end) => {
            const r = await fetchT(url, { headers: { Range: 'bytes=' + start + '-' + end, 'User-Agent': DOWNLOAD_UA } });
            if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
            return Buffer.from(await r.arrayBuffer());
        };
        const buf = await extractZipEntryByPath({ size, fetchRange, path: resPath });
        if (!buf || !buf.length) return res.status(404).json({ code: -1, msg: 'EPUB 内未找到资源: ' + resPath.slice(0, 80) });
        if (epubResCache.size >= EPUB_RES_CACHE_MAX) {
            const firstKey = epubResCache.keys().next().value;
            epubResCache.delete(firstKey);
        }
        epubResCache.set(key, { buf, ts: Date.now() });
        res.setHeader('Content-Type', sniffResType(buf, resPath));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (e) {
        res.status(502).json({ code: -1, msg: e.message });
    }
});

// 下载（浏览器另存为）
router.get('/download/:provider', async (req, res) => {
    try {
        const { provider } = req.params;
        const { fid, name } = req.query;
        if (!PROVIDERS[provider] || !fid) return res.status(400).json({ code: -1, msg: '参数缺失' });
        const url = await getDirectUrl(provider, String(fid));
        const resp = await fetch(url, { headers: { 'User-Agent': DOWNLOAD_UA } });
        if (!resp.ok) return res.status(resp.status).json({ code: -1, msg: `下载失败 HTTP ${resp.status}` });
        if (name) res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(String(name)));
        pipeProxy(resp, res);
    } catch (e) {
        if (!res.headersSent) res.status(e.needAuth ? 401 : 502).json({ code: -1, msg: e.message });
        else res.end();
    }
});

// ==================== 数据同步 / 备份（round92，对标 Reeden 数据同步） ====================
// 同步 = 刷新所有已绑定网盘目录（夸克/123/百度 × 影视/漫画/小说）的文件清单并落盘缓存，
//        功能页「网盘 / 全部」可用缓存秒开，再后台拉实时。
// 备份 = 把应用配置快照（脱敏后）上传到用户指定的网盘文件夹，保留最近 N 份。
// 授权凭证类（OAuth token / 夸克 Cookie）不上云 —— 与 Reeden「账号密码不同步」同策略。

const CACHE_FILE = path.join(path.dirname(CONFIG_PATH), 'cloud-cache.json');

function readCacheFile() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return { ts: 0, lastSync: null, dirs: {} }; }
}
function writeCacheFile(c) {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), 'utf8'); } catch (e) { /* 只读盘等异常不致命 */ }
}

function readSyncSettings(cfg) {
    const s = (cfg && cfg.cloudSync) || {};
    return {
        autoSync: !!s.autoSync,
        intervalMin: Number(s.intervalMin) || 30,
        syncOnStartup: !!s.syncOnStartup,
        autoBackup: !!s.autoBackup,
        keepBackups: Number(s.keepBackups) || 7,
        backupDirs: s.backupDirs || {},   // provider -> { fid, name }
    };
}

// --- 快照脱敏：token / cookie 不进备份 ---
function buildBackupSnapshot(cfg) {
    const clone = JSON.parse(JSON.stringify(cfg || {}));
    for (const p of OAUTH_PROVIDERS) {
        const sec = clone.cloudOAuth && clone.cloudOAuth[p];
        if (sec) { sec.accessToken = ''; sec.refreshToken = ''; sec.expireAt = 0; }
    }
    if (clone.sources && clone.sources.quark) {
        delete clone.sources.quark.cookie;
        delete clone.sources.quark.cookies;
    }
    delete clone.cloudSync;   // 同步设置本身不随备份走
    return {
        app: 'CinemaVault', kind: 'config-backup', exportedAt: new Date().toISOString(), config: clone,
    };
}

// --- 123云盘 上传（v1 分片流程，备份 JSON 单分片足够） ---
async function pan123Post(pathName, bodyObj) {
    const token = await getAccessToken('pan123');
    const resp = await fetch(PAN123_API + pathName, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, Platform: 'open_platform', 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj || {}),
    });
    const j = await resp.json().catch(() => ({}));
    if (j.code && j.code !== 0) throw new Error('123云盘接口错误 ' + j.code + ': ' + (j.message || j.msg || ''));
    return j.data || j;
}

async function pan123Upload(fid, filename, buf) {
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const created = await pan123Post('/api/v1/file/upload/create', {
        parentFileId: Number(fid) || 0, filename, etag: md5, size: buf.length,
    });
    if (created.reuse) return { fileId: created.fileId };
    const domain = await pan123Api('/api/v1/file/upload/get_upload_domain');
    const upDomain = (domain && (domain.uploadDomain || domain.domain)) || '';
    if (!upDomain) throw new Error('123云盘未返回上传域名');
    const partUrl = 'https://' + upDomain.replace(/^https?:\/\//, '') +
        '/upload/v1/file/part?preuploadId=' + encodeURIComponent(created.preuploadId) + '&partNumber=1';
    const partResp = await fetch(partUrl, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + await getAccessToken('pan123'), Platform: 'open_platform', 'Content-Type': 'application/octet-stream' },
        body: buf,
    });
    const partJ = await partResp.json().catch(() => ({}));
    if ((partJ.code && partJ.code !== 0) || partResp.status >= 400) {
        throw new Error('123云盘分片上传失败: ' + (partJ.message || ('HTTP ' + partResp.status)));
    }
    const done = await pan123Post('/api/v1/file/upload/complete', {
        fileId: created.fileId, preuploadId: created.preuploadId,
    });
    return { fileId: (done && done.fileId) || created.fileId };
}

async function pan123Trash(fileIds) {
    return pan123Post('/api/v1/file/trash', { fileIDs: fileIds.map(Number) });
}

// --- 百度网盘 上传（precreate → superfile2 分片 → create；路径必须在 /apps/ 开放空间内） ---
async function baiduUpload(pathStr, buf) {
    const token = await getAccessToken('baidu');
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const pre = await baiduApi(BAIDU_PCS + '/file', {
        method: 'precreate', path: pathStr, size: String(buf.length), isdir: '0', rtype: '1',
        block_list: JSON.stringify([md5]),
    });
    if (!pre || !pre.uploadid) throw new Error('百度网盘 precreate 失败（文件路径需在 /apps/ 应用目录下）');
    const uploadid = pre.uploadid;
    // 手工拼 multipart（项目里没有 form-data 包，node-fetch v2 不认全局 FormData）
    const boundary = '----CinemaVault' + Date.now().toString(16);
    const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, buf, tail]);
    const upResp = await fetch('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&access_token=' + token +
        '&type=object&uploadid=' + encodeURIComponent(uploadid) + '&path=' + encodeURIComponent(pathStr), {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body,
    });
    const upJ = await upResp.json().catch(() => ({}));
    if (upJ.errno) throw new Error('百度网盘分片上传失败 errno=' + upJ.errno);
    const done = await baiduApi(BAIDU_PCS + '/file', {
        method: 'create', path: pathStr, size: String(buf.length), isdir: '0', rtype: '1',
        uploadid, block_list: JSON.stringify([md5]),
    });
    return { fsid: done && done.fs_id };
}

async function baiduTrash(paths) {
    return baiduApi(BAIDU_PCS + '/filemanager', { method: 'filemanager', opera: 'delete', filelist: JSON.stringify(paths) });
}

// --- 备份入口：上传 + 保留份数清理 ---
async function uploadBackupTo(provider, dirInfo, settings) {
    const cfg = readConfig();
    const snap = buildBackupSnapshot(cfg);
    const buf = Buffer.from(JSON.stringify(snap, null, 2), 'utf8');
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fname = `CinemaVault-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
    let remotePath;
    if (provider === 'pan123') {
        await pan123Upload(dirInfo.fid, fname, buf);
    } else {
        remotePath = (dirInfo.fid === '/' ? '/apps/CinemaVault备份' : String(dirInfo.fid).replace(/\/$/, '')) + '/' + fname;
        await baiduUpload(remotePath, buf);
    }

    // 保留份数：按文件名（内含时间戳）倒序，保留最新 keepBackups 份，多余的进回收站
    let cleaned = 0;
    try {
        const listing = await listFolder(provider, provider === 'pan123' ? dirInfo.fid : remotePath ? remotePath.split('/').slice(0, -1).join('/') || '/' : dirInfo.fid, 1);
        const olds = listing.list
            .filter(f => !f.is_dir && /^CinemaVault-backup-\d{8}-\d{6}\.json$/.test(f.name))
            .sort((a, b) => b.name.localeCompare(a.name));
        const keep = Math.max(1, settings.keepBackups || 7);
        const drop = olds.slice(keep);
        for (const f of drop) {
            try {
                if (provider === 'pan123') await pan123Trash([f.fid]);
                else await baiduTrash([f.fid]);
                cleaned++;
            } catch (e) { /* 清理失败不影响备份结果 */ }
        }
    } catch (e) { /* 列目录失败就跳过清理 */ }

    return { file: fname, size: buf.length, cleaned };
}

// --- 同步主流程 ---
let syncRunning = false;

async function runCloudSync(reason) {
    if (syncRunning) return { code: -1, msg: '已有一次同步在进行中，请稍候' };
    syncRunning = true;
    const startedAt = Date.now();
    const results = [];
    try {
        const cfg = readConfig();
        const settings = readSyncSettings(cfg);

        // ① 刷新绑定目录清单（夸克 + OAuth 两家）
        const dirsData = {};
        for (const p of ['quark', 'pan123', 'baidu']) dirsData[p] = {};
        for (const p of ['quark', 'pan123', 'baidu']) {
            const dirs = oauthProviderDirsCfg(cfg, p);
            for (const t of MEDIA_TYPES) {
                const dir = dirs[t];
                if (!dir || (dir.fid === undefined)) continue;
                try {
                    let files;
                    if (p === 'quark') {
                        const crawler = getQuarkCrawler();
                        const r = await crawler.getFileList(dir.fid, 1, 300);
                        files = (r.list || []).filter(f => !f.dir)
                            .map(f => ({ fid: String(f.fid), name: String(f.file_name || ''), size: Number(f.size) || 0, ext: path.extname(String(f.file_name || '')).toLowerCase().replace(/^\./, '') }));
                    } else {
                        const listing = await listFolder(p, String(dir.fid), 1);
                        files = listing.list.filter(f => !f.is_dir)
                            .map(f => ({ fid: String(f.fid), name: String(f.name || ''), size: Number(f.size) || 0, ext: path.extname(String(f.name || '')).toLowerCase().replace(/^\./, '') }));
                    }
                    dirsData[p][t] = { dir, files };
                    results.push({ provider: p, type: t, ok: true, count: files.length });
                } catch (e) {
                    results.push({ provider: p, type: t, ok: false, msg: e.message });
                }
            }
        }

        // ② 自动备份（开启且两家各自绑了备份目录才动）
        let backupResults = [];
        if (settings.autoBackup) {
            for (const p of ['pan123', 'baidu']) {
                const bd = settings.backupDirs[p];
                const authorized = !!(cfg.cloudOAuth && cfg.cloudOAuth[p] && cfg.cloudOAuth[p].accessToken);
                if (!bd || !bd.fid || !authorized) continue;
                try {
                    const r = await uploadBackupTo(p, bd, settings);
                    backupResults.push({ provider: p, ok: true, ...r });
                } catch (e) {
                    backupResults.push({ provider: p, ok: false, msg: e.message });
                }
            }
        }

        // ③ 写缓存
        const cache = readCacheFile();
        cache.ts = Date.now();
        cache.dirs = dirsData;
        cache.lastSync = {
            time: startedAt, reason: reason || 'manual',
            results, backups: backupResults,
            ms: Date.now() - startedAt,
        };
        writeCacheFile(cache);
        return { code: 0, data: cache.lastSync };
    } catch (e) {
        return { code: -1, msg: e.message };
    } finally {
        syncRunning = false;
    }
}

// 从原始 config 读绑定目录（不走 fetchOAuthStatus 的 req 视角）
function oauthProviderDirsCfg(cfg, p) {
    if (p === 'quark') {
        const out = {};
        const q = cfg.sources && cfg.sources.quark;
        for (const t of MEDIA_TYPES) {
            const key = { comic: 'comicDir', novel: 'novelDir', movie: 'movieDir' }[t];
            if (q && q[key]) out[t] = q[key];
        }
        return out;
    }
    const sec = cfg.cloudOAuth && cfg.cloudOAuth[p];
    return (sec && sec.mediaDirs) || {};
}

// --- 调度器：启动同步（45s 后）+ 每分钟检查间隔同步 ---
(function installScheduler() {
    setTimeout(async () => {
        try {
            const cfg = readConfig();
            const s = readSyncSettings(cfg);
            if (s.syncOnStartup) await runCloudSync('startup');
        } catch (e) { /* 配置异常不致命 */ }
    }, 45 * 1000);
    setInterval(async () => {
        try {
            if (syncRunning) return;
            const cfg = readConfig();
            const s = readSyncSettings(cfg);
            if (!s.autoSync || !(s.intervalMin > 0)) return;
            const cache = readCacheFile();
            const last = (cache && cache.ts) || 0;
            if (Date.now() - last < s.intervalMin * 60 * 1000) return;
            await runCloudSync('auto');
        } catch (e) { /* 定时任务吞错 */ }
    }, 60 * 1000);
})();

// --- 同步相关路由 ---

// 同步设置 + 状态总览
router.get('/sync-settings', (req, res) => {
    try {
        const cfg = readConfig();
        const s = readSyncSettings(cfg);
        const cache = readCacheFile();
        res.json({
            code: 0,
            data: {
                ...s,
                cacheTs: cache.ts || 0,
                lastSync: cache.lastSync || null,
                running: syncRunning,
            },
        });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/sync-settings', (req, res) => {
    try {
        const patch = req.body || {};
        const cfg = readConfig();
        if (!cfg.cloudSync) cfg.cloudSync = {};
        const cur = readSyncSettings(cfg);
        for (const k of ['autoSync', 'syncOnStartup', 'autoBackup']) {
            if (k in patch) cur[k] = !!patch[k];
        }
        if ('intervalMin' in patch) cur.intervalMin = Math.max(1, Number(patch.intervalMin) || 30);
        if ('keepBackups' in patch) cur.keepBackups = Math.max(1, Number(patch.keepBackups) || 7);
        if (patch.backupDirs && typeof patch.backupDirs === 'object') {
            cur.backupDirs = cur.backupDirs || {};
            for (const p of Object.keys(patch.backupDirs)) {
                const v = patch.backupDirs[p];
                if (!v || !v.fid) delete cur.backupDirs[p];
                else cur.backupDirs[p] = { fid: String(v.fid), name: v.name || '' };
            }
        }
        cfg.cloudSync = cur;
        writeConfig(cfg);
        res.json({ code: 0, msg: '同步设置已保存', data: cur });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 备份目录绑定（独立于媒体目录；fid='' 解绑）
router.post('/backup-dir', (req, res) => {
    try {
        const { provider, fid, name } = req.body || {};
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        const cfg = readConfig();
        if (!cfg.cloudSync) cfg.cloudSync = {};
        if (!cfg.cloudSync.backupDirs) cfg.cloudSync.backupDirs = {};
        if (!fid) delete cfg.cloudSync.backupDirs[provider];
        else cfg.cloudSync.backupDirs[provider] = { fid: String(fid), name: name || '' };
        writeConfig(cfg);
        res.json({ code: 0, msg: fid ? '备份目录已保存' : '备份目录已解绑' });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 手动立即同步
router.post('/sync-now', async (req, res) => {
    try {
        const r = await runCloudSync('manual');
        res.json(r);
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 目录缓存（功能页秒开用）
router.get('/media-cache', (req, res) => {
    try {
        const cache = readCacheFile();
        if (!cache || !cache.ts) return res.json({ code: -1, msg: '暂无缓存' });
        res.json({ code: 0, data: cache });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 授权等待探测（前端轮询用：有未消费的 state 即认为用户正在授权流程中）
router.get('/auth-pending/:provider', (req, res) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS[provider]) return res.json({ code: -1, msg: '未知的网盘提供方' });
        let since = 0;
        for (const [, v] of pendingStates) {
            if (v.provider === provider && Date.now() - v.ts <= 10 * 60 * 1000) {
                since = Math.max(since, v.ts);
            }
        }
        res.json({ code: 0, data: { pending: !!since, since } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
