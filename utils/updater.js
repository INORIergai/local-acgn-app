/**
 * updater.js — 应用内更新（round31）
 *
 * 职责：查 GitHub 上有没有新 Release → 比对版本 → 下载对应形态的安装包 →
 *       交给用户一键安装。全程在后端进程内完成，不新增常驻服务。
 *
 * ── 为什么自己写而不用 electron-updater ──────────────────────────────
 * electron-updater 的 GitHub provider 要求 Release 里带 `latest.yml`（内含
 * 安装包 sha512 与路径）。本项目的发布走 `packaging/_r23-release.py`
 * （REST API 手工上传 exe），并没有让 electron-builder 生成 latest.yml，
 * 硬上 electron-updater 会出现「能查到版本但下载校验失败」。
 * 另外它的 GitHub 访问走不通代理配置，而本机 GitHub 直连长期不稳。
 * 自研只需 GitHub 公开 API（无需登录），且能复用项目已有的代理设置。
 *
 * ── 版本号从哪来 ────────────────────────────────────────────────────
 * 后端跑在 `%APPDATA%\CinemaVault\runtime\`，那里的 package.json 是从
 * 开发树同步过去的根 package.json（版本 1.0.0，**不是** exe 的真实版本）。
 * 所以真实版本由 Electron 主进程在启动时写好，两条路都留了：
 *   1) 环境变量 CINEMAVAULT_VERSION（main.js spawn 后端时注入）
 *   2) runtime/app-version.json（兜底，同步脚本不会覆盖它）
 * 两条都拿不到才退回读 package.json，再不行是 '0.0.0'。
 *
 * ── 形态区分 ────────────────────────────────────────────────────────
 * 发布产物有两个：Setup（安装版，NSIS）与 Portable（便携版）。
 * 便携版是自解压运行，**不能覆盖自身**，所以它的「更新」是下载新包 +
 * 打开所在目录让用户自己替换；安装版才支持直接跑安装包升级。
 *
 * ── 增量更新（M2/M3）的部署前置 ────────────────────────────────────
 * 1) 验签公钥：部署/打包时必须把发布端的 ed25519 **公钥**注入到后端 env
 *    `CV_UPDATE_PUBLIC_KEY`（私钥只在发布端，用 {{SECRET_*}} 管理，绝不入库）。
 *    未注入时增量自动禁用并告警，全量下载照常工作 —— 这是有意的安全降级，
 *    绝不把公钥硬编码进源码/测试。
 * 2) baseline：首次增量检查会从已安装源码现场合成 `<DATA_ROOT>/updates/baseline-manifest.json`
 *    （无需联网/无需先成功增量切换）；M3 成功切换后也会更新它。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const dns = require('dns');
const net = require('net');
const { spawn } = require('child_process');

const config = require('./config');

/* https-proxy-agent v9 是 ESM-only，靠 require(esm) 才能拿（Node ≥20.19，
 * 桌面版已用 --experimental-require-module 打开）。拿不到就直连，不影响主流程。 */
let HttpsProxyAgent = null;
try {
    ({ HttpsProxyAgent } = require('https-proxy-agent'));
} catch (e) {
    console.warn('[更新] https-proxy-agent 加载失败，更新检查将一律直连（' + (e.code || e.message) + '）');
}

const DEFAULT_REPO = 'INORIergai/local-acgn-app';
const UA = 'CinemaVault-Updater';
const CHECK_CACHE_MS = 5 * 60 * 1000;      // 同一进程内检查结果的缓存时长

/* 内置 GitHub 下载加速前缀（国内直连 github.com 大文件常卡死）。
 * 这些是公开反向代理，只用于转发 Release 安装包下载；顺序即尝试顺序。
 * 用户可用 config.update.mirrorPrefixes 覆盖；设为空数组可只用原站。 */
const DEFAULT_MIRROR_PREFIXES = [
    'https://ghfast.top/',
    'https://gh-proxy.com/',
    'https://github.moeyy.xyz/',
];

/* ================================================================== 配置 */

function updaterConfig() {
    const c = config.update || {};
    return {
        enabled: c.enabled !== false,
        repo: c.repo || DEFAULT_REPO,
        apiBase: (c.apiBase || 'https://api.github.com').replace(/\/+$/, ''),
        downloadPrefix: c.downloadPrefix || '',   // 可选：单个加速前缀（旧配置，优先级最高）
        // 镜像前缀数组：null/未设→内置默认；[]→只用原站；数组→按序尝试
        mirrorPrefixes: Array.isArray(c.mirrorPrefixes)
            ? c.mirrorPrefixes.map(p => String(p).replace(/\/+$/, '') + '/')
            : DEFAULT_MIRROR_PREFIXES.slice(),
        autoCheck: c.autoCheck !== false,         // 启动时静默检查一次
        token: c.token || '',                     // 可选：提 GitHub API 限额（60/h → 5000/h）
    };
}

/* ============================================================ 本地版本 */

/**
 * 读本地版本号。
 *
 * ★ round72 修一个真 bug：原来只找 `<utils>/app-version.json` 与 `<runtime>/packaging/package.json`
 *   两个位置，但桌面版实际把 app-version.json 写在 **runtime 根目录**、package.json 也在
 *   runtime 根目录，两处都读不到 => 一路兜底到最后的 '0.0.0'。
 *   后果：checkUpdate 里 cmpVersion(线上 2.6, 0.0.0) > 0 恒为真 => 应用**明明跑的是新代码**，
 *   却一直弹「发现新版本 v2.6」，用户会误以为没更新成功。
 *   （开发模式 node server.js 时 __dirname 是项目 utils/，所以还要往上一级找 packaging/）
 */
function localVersion() {
    if (process.env.CINEMAVAULT_VERSION) return String(process.env.CINEMAVAULT_VERSION).trim();

    const readJson = (f) => {
        try {
            if (!fs.existsSync(f)) return null;
            const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
            const v = j && (j.version || j.productVersion);
            return v ? String(v) : null;
        } catch (e) { return null; }
    };

    // 按「最可能正确 -> 兜底」的顺序试
    const candidates = [
        path.join(__dirname, 'app-version.json'),                   // 旧布局（历史遗留）
        path.join(__dirname, '..', 'app-version.json'),            // ★ 桌面版真实位置：runtime 根
        path.join(__dirname, 'package.json'),                      // 少数布局把 package 放 utils 下
        path.join(__dirname, '..', 'package.json'),                 // ★ 桌面版：runtime/package.json
        path.join(__dirname, '..', 'packaging', 'package.json'),   // 开发模式：exe 版本在这
    ];
    for (const f of candidates) {
        const v = readJson(f);
        if (v && v !== '0.0.0') return v;
    }
    return '0.0.0';
}

/** 当前是便携版还是安装版 */
function isPortable() {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
    try {
        const f = path.join(__dirname, 'app-version.json');
        if (fs.existsSync(f)) {
            const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
            return !!j.portable;
        }
    } catch (e) { /* 忽略 */ }
    return false;
}

/**
 * 语义化版本比较。返回 >0 表示 a 比 b 新。
 * 容忍 v 前缀、位数不等（1.0 vs 1.0.2）、以及 -beta 之类的后缀。
 */
function cmpVersion(a, b) {
    const norm = (v) => String(v || '0').trim().replace(/^[vV]/, '').split(/[.\-+]/);
    const pa = norm(a), pb = norm(b);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const x = pa[i], y = pb[i];
        const xMissing = (x === undefined || x === '');
        const yMissing = (y === undefined || y === '');
        if (xMissing && yMissing) continue;

        /* 位数不等（1.0 vs 1.0.2）：缺的那一段按 0 算 ⇒ 短的那个更旧。
         * 但若多出来的是非数字段（1.1.0 vs 1.1.0-beta），那叫预发布，
         * 带后缀的更旧 —— 这两种「多一段」的语义相反，必须分开判。 */
        if (xMissing) return /^\d+$/.test(y) ? -1 : 1;
        if (yMissing) return /^\d+$/.test(x) ? 1 : -1;

        const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
        if (nx && ny) {
            const d = parseInt(x, 10) - parseInt(y, 10);
            if (d !== 0) return d;
        } else {
            if (x === y) continue;
            return x > y ? 1 : -1;   // 都是非数字段：按字典序
        }
    }
    return 0;
}

/* ================================================================ 网络 */

/* ── SSRF 防护 ─────────────────────────────────────────────────────────
 * 更新器会跟随 GitHub 的 302 下载链接，也会接受配置里的镜像前缀。若不做
 * 校验，恶意/误配的 URL（或 DNS rebinding）可能让服务端请求本机或内网。
 * 统一规则：只放行 http/https；host 不能是 localhost / 环回 / 私网 /
 * 链路本地 / 保留地址；域名要解析，且所有解析结果都必须落在公网。
 * ──────────────────────────────────────────────────────────────────── */

/** IPv4：环回/私网/链路本地/保留/组播/未指定，全部不允许 */
function isBlockedIpv4(addr) {
    const p = String(addr).split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;              // 未指定/私网/环回
    if (a === 169 && b === 254) return true;                        // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true;               // 私网
    if (a === 192 && b === 168) return true;                        // 私网
    if (a === 192 && b === 0) return true;                          // IETF 协议分配
    if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 共享地址
    if (a === 127 || a === 255) return true;                        // 环回/广播
    if (a >= 224) return true;                                      // 组播及保留
    return false;
}

/** IPv6：环回/未指定/链路本地/唯一本地/保留 不允许；IPv4-mapped 拆出来再判 */
function isBlockedIpv6(addr) {
    let s = String(addr).toLowerCase().split('%')[0];              // 去掉 zone id
    if (s.startsWith('::ffff:')) {
        const tail = s.slice(7);
        if (tail.includes('.')) return isBlockedIpv4(tail);         // ::ffff:a.b.c.d
    }
    if (s === '::' || s === '::1') return true;
    if (/^f[cd]/.test(s)) return true;                              // 唯一本地 fc00::/7
    if (/^fe[89ab]/.test(s)) return true;                           // 链路本地 fe80::/10
    return false;
}

function isBlockedIp(addr) {
    if (net.isIPv4(addr)) return isBlockedIpv4(addr);
    if (net.isIPv6(addr)) return isBlockedIpv6(addr);
    return true;                                                    // 非 IP 形态视为异常
}

/**
 * 校验一个 URL 是否允许请求（async：域名要解析）。
 * 成功 resolve()，失败 throw Error（含可读原因）。
 */
async function assertSafeUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); }
    catch (e) { throw new Error('URL 无效'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('仅允许 http/https 协议');
    }
    if (u.username || u.password) throw new Error('URL 不允许携带用户名/密码');

    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');   // IPv6 去方括号
    if (host === 'localhost' || host.endsWith('.localhost') ||
        host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error('禁止请求本机/内网主机名');
    }
    if (net.isIP(host)) {
        if (isBlockedIp(host)) throw new Error('禁止请求本机/私网/保留地址');
        return;
    }
    // 域名：解析所有 A/AAAA 记录，任一命中禁区即拒绝（防 DNS rebinding）
    let addrs;
    try { addrs = await dns.promises.lookup(host, { all: true }); }
    catch (e) { throw new Error('域名解析失败: ' + (e && e.code || 'unknown')); }
    if (!addrs || !addrs.length) throw new Error('域名无解析结果');
    for (const a of addrs) {
        if (isBlockedIp(a.address)) throw new Error('域名解析到私网/保留地址，已拒绝');
    }
}

function makeAgent(opts = {}) {
    if (opts.noProxy) return { agent: null, proxy: null };
    const proxy = config.network && config.network.proxyServer;
    if (!proxy || !HttpsProxyAgent) return { agent: null, proxy: null };
    try {
        return { agent: new HttpsProxyAgent(proxy), proxy };
    } catch (e) {
        return { agent: null, proxy: null };
    }
}

/* 「值得再试一次」的网络层错误：代理软件时开时关（ECONNREFUSED 127.0.0.1:xxxx）、
 * 直连被中途掐断（TLS 握手断开）、超时、DNS 抽风 —— 全在这一类里。
 * 其余错误（比如 HTTP 403 限流）不算，那是有明确含义的响应，重试也没用。 */
function isTransientNetError(e) {
    const c = e && (e.code || '');
    return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPROTO', 'EPIPE']
        .indexOf(c) >= 0 || /socket hang up|Proxy|proxy/i.test((e && e.message) || '');
}

/**
 * 发一个 HTTPS/HTTP 请求，自动跟随 3xx（GitHub 的下载链接会 302 到对象存储）。
 * 请求头固定 `Accept-Encoding: identity` —— 省掉一层 gzip 解压，
 * 也让「已下载字节数」等于真实文件大小，进度条不会跳。
 * @param {string} url
 * @param {object} opts {headers, timeout}
 * @param {boolean} stream  true 时把响应流交给 onData 后立即 resolve（用于下载）
 */
/**
 * @param {number} attempt 第几次尝试（内部递归用）。API 请求默认最多试 3 次 ——
 *   本机直连 GitHub 时通时断（TLS 握手被中途掐断是常态），一次失败就放弃
 *   会让「检查更新」看起来像坏了。下载（stream）不重试：断点续传没实现，
 *   重试意味着重写文件，不如干脆把错误报给用户。
 */
function request(url, opts = {}, stream = false, onData = null, attempt = 1) {
    const maxAttempts = stream ? 1 : (opts.retry == null ? 3 : opts.retry);
    return new Promise((resolve, reject) => {
        // SSRF 防护：发起任何请求前先校验目标（协议/host/解析结果）。
        // 校验本身是异步的（DNS），放在 Promise 里 await 后再继续建连。
        assertSafeUrl(url).then(() => doRequest(), reject);

        function doRequest() {
        let u;
        try { u = new URL(url); } catch (e) { return reject(new Error('URL 无效: ' + url)); }

        const { agent, proxy } = makeAgent(opts);
        const mod = u.protocol === 'http:' ? http : https;
        const headers = Object.assign({
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
        }, opts.headers || {});

        // round42：支持 POST body（AniList GraphQL 等接口用；GET/无 body 完全不受影响）
        let bodyBuf = null;
        if (opts.body != null) {
            bodyBuf = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body;
            if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
                headers['Content-Length'] = bodyBuf.length;
            }
        }

        const req = mod.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search,
            method: opts.method || 'GET',
            headers,
            agent: agent || undefined,
            timeout: opts.timeout || 20000,
        }, (res) => {
            // 重定向：目标同样要过安全校验（防 302 打到内网元数据服务等）
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, url).toString(); }
                catch (e) { return reject(new Error('重定向 URL 无效')); }
                return assertSafeUrl(next)
                    .then(() => resolve(request(next, opts, stream, onData, 1)))
                    .catch(reject);
            }
            if (stream) {
                return resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    length: parseInt(res.headers['content-length'] || '0', 10),
                    stream: res,
                });
            }
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    url: url,                       // 最终 URL（跟随跳转后）—— HTML 回退要靠它取 tag
                    body: buf.toString('utf-8'),
                });
            });
            res.on('error', reject);
        });

        /* 代理/直连双路：本机代理软件时开时关，配了代理但代理没起是最常见的
         * 失败形态（ECONNREFUSED 127.0.0.1:xxxx）。这种时候退化成直连重试一次，
         * 好过直接告诉用户「检查更新失败」。 */
        const onErr = (e) => {
            if (proxy && isTransientNetError(e)) {
                console.log('[更新] 代理不可用（' + ((e && e.message) || e) + '），改为直连重试');
                return resolve(request(url, Object.assign({}, opts, { noProxy: true }), stream, onData, 1));
            }
            if (!stream && attempt < maxAttempts && isTransientNetError(e)) {
                const wait = 400 * attempt;
                console.log(`[更新] 第 ${attempt} 次请求失败（${(e && e.message) || e}），${wait}ms 后重试`);
                return setTimeout(() => {
                    resolve(request(url, opts, stream, onData, attempt + 1));
                }, wait);
            }
            reject(e);
        };
        req.on('timeout', () => {
            const e = new Error('请求超时');
            e.code = 'ETIMEDOUT';
            req.destroy(e);
        });
        req.on('error', onErr);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
        } // doRequest
    });
}

/* ========================================================== 检查更新 */

let lastCheck = null;      // {at, result}
let downloadState = null;  // {state, ...}

function repoApi(cfg, suffix) {
    return `${cfg.apiBase}/repos/${cfg.repo}${suffix}`;
}

/**
 * HTML 回退通道：不碰 GitHub API，直接读 Release 页面。
 *
 * 【为什么必须有这条】api.github.com 未认证只有 60 次/小时，而且是按**出口 IP**
 * 算的 —— 公司网 / 校园网 / 同一代理出口下，配额会被别人一起吃掉，表现为
 * 「刚才还能检查，现在一直提示限流」。而 github.com 的网页没有这个限制。
 * 代价是拿不到精确文件大小（下载时改为只校验非空），更新说明也取不全，
 * 但「能不能更新」这个核心判断不受影响。
 *
 * 解析两点：① /releases/latest 会 302 到 /releases/tag/<tag>，从最终 URL 取版本号；
 *          ② 页面里 /releases/download/<tag>/xxx.exe 就是资产直链。
 */
function decodeEntities(s) {
    return String(s || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

async function fetchLatestViaHtml(cfg) {
    /* ① 版本号与更新说明：releases.atom
     *   实测（_r31-probe-endpoints.js）：/releases/latest 的正式页面已经改成
     *   JS 渲染壳 —— 拿得到 HTML 但里面既没有 tag 也没有资产直链，解析必失败。
     *   而 releases.atom 是服务端渲染的静态 XML，同一个仓库实测 200、
     *   首个 entry 就是最新 Release，且**不受 API 限流影响**。 */
    const atom = await request(`https://github.com/${cfg.repo}/releases.atom`, {}, false);
    if (atom.status !== 200) throw new Error('GitHub Atom 返回 ' + atom.status);

    const xml = atom.body || '';
    const entry = (xml.split('<entry>')[1] || '');
    if (!entry) throw new Error('Atom 里没有 Release 条目');

    // tag 优先取 <id> 里的 Repository/<id>/<tag>，比标题稳（标题里还有「· 午夜场」）
    let tag = '';
    const mid = /Repository\/\d+\/([^<"\s]+)/.exec(entry) || /Repository\/\d+\/([^<"\s]+)/.exec(xml);
    if (mid) tag = mid[1].trim();
    if (!tag) {
        const mt = /<title>([^<]*)<\/title>/.exec(entry);
        const mv = /(v?\d+(?:\.\d+)+)/.exec(mt ? mt[1] : '');
        if (mv) tag = mv[1];
    }
    if (!tag) throw new Error('无法从 Atom 解析出版本号');

    let notes = '';
    const mc = /<content[^>]*>([\s\S]*?)<\/content>/.exec(entry);
    if (mc) {
        notes = decodeEntities(
            mc[1].replace(/<[^>]+>/g, '\n').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n')
        ).trim();
    }
    let published = '';
    const mp = /<updated>([^<]+)<\/updated>/.exec(entry);
    if (mp) published = mp[1].trim();

    /* ② 资产直链：expanded_assets/<tag>
     *   正式页面把资产区做成懒加载片段，只有这个 fragment 里才有真实直链。 */
    const exp = await request(
        `https://github.com/${cfg.repo}/releases/expanded_assets/${encodeURIComponent(tag)}`, {}, false);
    const html = exp.status === 200 ? (exp.body || '') : '';

    const assets = [];
    const seen = new Set();
    const re = /\/releases\/download\/[^"'\\]+\/([^"'\s>]+?\.(?:exe|zip|7z))/g;
    let mm;
    while ((mm = re.exec(html)) !== null) {
        const name = mm[1];
        if (seen.has(name)) continue;
        seen.add(name);
        assets.push({
            name,
            size: 0,
            sizeExact: false,     // 页面只给「107 MB」这种近似值，不能拿来校验下载
            downloadUrl: `https://github.com/${cfg.repo}/releases/download/${tag}/${name}`,
            updatedAt: '',
        });
    }
    if (!assets.length) throw new Error('未取到安装包列表（expanded_assets 返回 ' + exp.status + '）');

    return {
        tag_name: tag,
        name: tag,
        html_url: `https://github.com/${cfg.repo}/releases/tag/${tag}`,
        published_at: published,
        body: notes,
        assets,
    };
}

/**
 * 拉 GitHub 最新 Release 并与本地版本比对。
 * 只认正式 Release（跳过 draft 与 prerelease）—— prerelease 有单独的接口语义，
 * 这里直接过滤，避免把测试包推给所有用户。
 */
async function checkUpdate(force = false) {
    const cfg = updaterConfig();
    const current = localVersion();

    if (!force && lastCheck && Date.now() - lastCheck.at < CHECK_CACHE_MS) {
        return Object.assign({ cached: true }, lastCheck.result);
    }

    const base = {
        current,
        portable: isPortable(),
        enabled: cfg.enabled,
        checkedAt: Date.now(),
        hasUpdate: false,
        release: null,
        assets: [],
        recommended: null,
        error: null,
        rateLimited: false,
        source: null,          // 'api' = GitHub 接口（信息全） / 'html' = 网页兜底（无大小与说明）
    };

    if (!cfg.enabled) {
        base.error = '更新检查已关闭（config.update.enabled=false）';
        lastCheck = { at: Date.now(), result: base };
        return base;
    }

    const headers = { 'Accept': 'application/vnd.github+json' };
    if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;

    /* 主通道：GitHub API（信息最全：精确大小、发布时间、更新说明）。
     * 限流或拿不到时自动降级到网页通道，不让「配额用完」变成功能不可用。 */
    let rel = null;
    let apiNote = '';
    try {
        const r = await request(repoApi(cfg, '/releases/latest'), { headers, timeout: 15000 });
        if (r.status === 403 || r.status === 429) {
            base.rateLimited = true;
            apiNote = 'GitHub 接口限流（未配置 token 时每小时 60 次）';
        } else if (r.status !== 200) {
            apiNote = `GitHub 接口返回 ${r.status}`;
        } else {
            rel = JSON.parse(r.body);
            base.source = 'api';
        }
    } catch (e) {
        apiNote = '无法连接 GitHub：' + (e && e.message);
    }

    if (!rel) {
        console.log('[更新] API 通道不可用（' + apiNote + '），改用网页通道');
        try {
            rel = await fetchLatestViaHtml(cfg);
            base.source = 'html';
        } catch (e2) {
            base.error = apiNote + '；网页通道也失败：' + (e2 && e2.message)
                + '（可在「设置 → 数据源」配置代理后重试）';
            lastCheck = { at: Date.now(), result: base };
            return base;
        }
    }

    const latest = String(rel.tag_name || rel.name || '').trim();
    const portable = base.portable;

    /* 资产筛选：只保留 .exe，排除 blockmap / yml 之类；
     * 再按形态推荐：便携版找 Portable，安装版找 Setup。 */
    const assets = (rel.assets || [])
        .filter((a) => /\.exe$/i.test(a.name || ''))
        .map((a) => ({
            name: a.name,
            size: a.size || 0,
            /* 两条通道的字段名不一样：API 给 browser_download_url + 精确 size，
             * 网页通道自己拼 downloadUrl + size 为 0。这里统一成一份结构，
             * 别让下游（下载/校验/前端）还要区分「我这是哪条通道来的」。 */
            sizeExact: a.sizeExact !== false,
            downloadUrl: a.browser_download_url || a.downloadUrl || '',
            updatedAt: a.updated_at || '',
        }));

    const pick = (kw) => assets.find((a) => new RegExp(kw, 'i').test(a.name)) || null;
    const recommended = portable
        ? (pick('Portable') || pick('Setup'))
        : (pick('Setup') || pick('Portable'));

    base.release = {
        tag: latest,
        version: latest.replace(/^[vV]/, ''),
        name: rel.name || latest,
        publishedAt: rel.published_at || rel.created_at || '',
        notes: (rel.body || '').trim() || (base.source === 'html'
            ? '（当前走网页通道，未取到更新说明；可点上方「Release 页」查看）'
            : ''),
        htmlUrl: rel.html_url || '',
    };
    base.assets = assets;
    base.recommended = recommended;
    base.hasUpdate = cmpVersion(latest, current) > 0;

    /* M2：附带下载该 Release 的 cv-manifest-<ver>.json，统一字段名为 camelCase 后
     * 存入 lastCheck.result.manifest。下载走同一个 request（内含 assertSafeUrl 校验），
     * 失败只记 manifestError，不影响「检查更新」主流程与 A 方案全量下载。 */
    base.manifest = null;
    base.manifestError = null;
    {
        const mName = manifestAssetName(latest);
        const mUrl = assetDownloadUrl(cfg, latest, rel, mName);
        if (mUrl) {
            try {
                const mr = await request(mUrl, { timeout: 15000 }, false);
                if (mr.status === 200) {
                    const raw = JSON.parse(mr.body);
                    base.manifest = Object.assign(normalizeManifest(raw), { downloadUrl: mUrl, assetName: mName });
                } else {
                    base.manifestError = 'manifest 下载返回 HTTP ' + mr.status;
                }
            } catch (e) {
                base.manifestError = 'manifest 下载失败: ' + (e && e.message);
            }
        } else {
            base.manifestError = '该 Release 未提供 manifest 直链';
        }
    }

    // round34 批次B：发现新版本 → 站内通知（同一版本只提醒一次）
    if (base.hasUpdate) {
        try {
            const cur = (lastUpdateNotified = lastUpdateNotified || { tag: '' });
            if (cur.tag !== latest) {
                cur.tag = latest;
                require('./notify').notify('update', '🚀 发现新版本 ' + latest,
                    `当前 v${current}，新版本 ${rel.name || latest} 已发布，可到「检查更新」下载安装。`,
                    { url: '/view/settings', extra: { tag: latest } });
            }
        } catch (e) { /* 通知失败不影响更新检查 */ }
    }

    lastCheck = { at: Date.now(), result: base };
    return base;
}

/** round34 批次B：记录已提醒过的新版本 tag（避免重复通知） */
let lastUpdateNotified = null;

/* ================================================================ 下载 */

/** 更新包落盘目录：数据目录下 updates/（不进 runtime，避免被同步脚本扫到） */
function updateDir() {
    // __dirname = <DATA_ROOT>/runtime，数据目录是它的上一级
    const dir = path.join(__dirname, '..', 'updates');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 由下载时报出 */ }
    return dir;
}

function getDownloadState() {
    return downloadState || { state: 'idle' };
}

/** 已下载完成的包（用于「立即安装」） */
function findDownloaded(assetName) {
    const dir = updateDir();
    const p = path.join(dir, assetName);
    return fs.existsSync(p) ? p : null;
}

/**
 * 构造候选下载 URL（按优先级去重）：
 *   1) config.update.downloadPrefix（旧的单镜像配置，显式指定优先级最高）
 *   2) GitHub 原站
 *   3) config.update.mirrorPrefixes（默认内置 3 个国内加速前缀）
 * 镜像前缀只拼在 GitHub 官方下载直链前，且每个 URL 在 request() 里都会再过
 * SSRF 校验，避免配置被污染后打到内网。
 */
function candidateDownloadUrls(cfg, asset) {
    const out = [];
    const seen = new Set();
    const add = (u, label) => {
        if (!u || seen.has(u)) return;
        seen.add(u);
        out.push({ url: u, label });
    };
    // 国内直连 github.com 大文件常卡在 1MB/s，故「加速镜像优先、官方原站兜底」。
    // 自定义 downloadPrefix 优先级最高（用户显式指定）。
    if (cfg.downloadPrefix) {
        add(cfg.downloadPrefix.replace(/\/+$/, '') + '/' + asset.downloadUrl, '自定义镜像');
    }
    for (const p of cfg.mirrorPrefixes || []) {
        // 前缀必须是 http/https 且 host 非内网/保留地址，杜绝配置被污染后打到内网
        if (!/^https?:\/\//i.test(p)) continue;
        let ph;
        try { ph = new URL(p).hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
        catch (e) { continue; }
        if (ph === 'localhost' || ph.endsWith('.localhost') || ph.endsWith('.local') ||
            (net.isIP(ph) && isBlockedIp(ph))) continue;
        add(p.replace(/\/+$/, '') + '/' + asset.downloadUrl, '加速镜像 ' + ph);
    }
    // 原站放最后兜底（镜像全挂时才用），避免"原站能连但极慢"拖垮整体体验
    add(asset.downloadUrl, '官方原站');
    return out;
}

/* ======================================================== 增量更新（M2）辅助 */

/** Release 资产直链：优先用 GitHub API 给的真实 URL，否则按命名约定拼。 */
function assetDownloadUrl(cfg, tag, rel, name) {
    const found = ((rel && rel.assets) || []).find(a => (a.name || '') === name);
    if (found) return found.browser_download_url || found.downloadUrl || '';
    return `https://github.com/${cfg.repo}/releases/download/${tag}/${name}`;
}

/** 发布端 manifest 文件名：cv-manifest-<ver>.json（ver 去掉 v 前缀）。 */
function manifestAssetName(tag) {
    const ver = String(tag || '').replace(/^[vV]/, '');
    return 'cv-manifest-' + ver + '.json';
}

/**
 * 字段名转换：发布端 manifest 为 snake_case 风格字段（`files[rel].sha256/size`、
 * `generated_at`/`binary_dirs`/`full_fallback` 等变体），统一归一化为
 * camelCase 结构写入 checkUpdate 结果，避免下游读不到（controller 裁定）。
 */
function normalizeManifest(m) {
    const files = {};
    for (const [rel, meta] of Object.entries((m && m.files) || {})) {
        files[rel] = { sha256: meta.sha256 || '', size: meta.size || 0 };
    }
    return {
        version: (m && m.version) || '',
        generatedAt: (m && (m.generated_at || m.generatedAt)) || '',
        files,
        binaryDirs: (m && (m.binary_dirs || m.binaryDirs)) || [],
        fullFallback: (m && (m.full_fallback || m.fullFallback)) || {},
    };
}

/** 增量 diff 覆盖的源码前缀：必须与 packaging/_cv_patch.py 的 ALLOWED 一致，
 *  也与发布端 build_manifest() 的扫描范围一致，否则合成 baseline 的文件集合
 *  与发布端 manifest 不对齐，本地改动检测会误报/漏报。 */
const INCREMENTAL_FILE_PREFIXES = ['public/', 'routes/', 'utils/', 'server.js', 'package.json', 'android-dist/'];

/**
 * 从「本地已安装文件」合成 baseline manifest —— 不触网、不需要事先成功切换过。
 *
 * 解决了增量更新的鸡生蛋问题：过去只有 M3 成功切换后才写 baseline-manifest.json，
 * 而成功切换又必须先 startIncremental 读到 baseline，导致全新安装/一路全量下载的用户
 * 永远无 baseline、增量形同虚设。这里在首次增量检查时按已安装源码现场算 sha256，
 * 文件集合与发布端 build_manifest() 同口径，故 from→to 命名与本地改动检测都能正常工作。
 *
 * @param {string} runtimeDir 已安装源码根目录（默认 <DATA_ROOT>）
 * @param {string} version    本地版本号（默认 localVersion()）
 * @returns {{version:string, generatedAt:string, files:object, binaryDirs:Array, fullFallback:object}}
 */
function synthesizeBaseline(runtimeDir, version) {
    const root = path.resolve(runtimeDir || path.join(__dirname, '..'));
    const files = {};
    const inScope = (rel, isDir) => {
        // 目录用 rel+'/' 判定，才能 descending 进 public/routes/utils 根；
        // 文件用 rel 判定，与发布端 build_manifest 的 rel.startswith(p) 完全同口径。
        const r = isDir ? rel + '/' : rel;
        return INCREMENTAL_FILE_PREFIXES.some(p => r.startsWith(p));
    };
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (e) { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const full = path.join(dir, e.name);
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (e.isDirectory()) {
                if (inScope(rel, true)) walk(full);
                continue;
            }
            if (!e.isFile() || !inScope(rel, false)) continue;
            try {
                const st = fs.statSync(full);
                files[rel] = {
                    sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
                    size: st.size,
                };
            } catch (e) { /* 单文件读失败跳过，不让整份 baseline 失效 */ }
        }
    };
    walk(root);
    return {
        version: String(version || localVersion()).replace(/^[vV]/, ''),
        generatedAt: new Date().toISOString(),
        files,
        binaryDirs: [],
        fullFallback: {},
    };
}

/**
 * 取得可用的 baseline：优先用显式传入 / 磁盘上已有的；没有或损坏则从已安装文件合成
 * 并落盘（原子 rename），供后续复用且与 M3 切换写入方共用同一路径。
 * 仅做本地文件系统操作，绝不触网。
 *
 * @param {object} [opts] {runtimeDir?, baselinePath?, version?}
 * @returns {object|null} 归一化后的 baseline；连已安装文件也扫不到时返回 null（交上层回退全量）
 */
function ensureBaseline(opts = {}) {
    const bp = opts.baselinePath || path.join(updateDir(), 'baseline-manifest.json');
    // 磁盘 baseline 必须「版本等于当前安装版本」才能复用。M3 切换后它记录的是
    // 上次 patch 的目标版本，老用户升级上来常残留过期版本（实测 6.8.5 基线跑在
    // 6.8.7 上）。旧基线会拼出错误的 cv-patch-<旧>-<新>.zip → 404 → 回退全量，
    // 且哈希对不上还会被本地改动检测拒绝。故版本不符一律现场重合成。
    const wantVersion = String(opts.version || localVersion() || '').replace(/^[vV]/, '');
    try {
        if (fs.existsSync(bp)) {
            const m = normalizeManifest(JSON.parse(fs.readFileSync(bp, 'utf8')));
            const gotVersion = String(m.version || '').replace(/^[vV]/, '');
            if (m.files && Object.keys(m.files).length &&
                (!wantVersion || !gotVersion || gotVersion === wantVersion)) return m;
            console.log('[更新] 磁盘 baseline 版本 ' + (gotVersion || '?') +
                ' 与当前版本 ' + (wantVersion || '?') + ' 不符，重新合成');
        }
    } catch (e) { /* 文件缺失/损坏/不可读 → 现场合成 */ }

    const synthesized = synthesizeBaseline(opts.runtimeDir, opts.version);
    if (!Object.keys(synthesized.files).length) return null;
    try {
        fs.mkdirSync(path.dirname(bp), { recursive: true });
        const tmp = bp + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(synthesized, null, 2), 'utf8');
        fs.renameSync(tmp, bp);
    } catch (e) {
        // 落盘失败不阻断本次增量（用内存中的 baseline 继续），但要显式告警
        console.warn('[更新] baseline-manifest.json 落盘失败（本次仍可用内存 baseline）: ' + (e && e.message));
    }
    return normalizeManifest(synthesized);
}

/** 增量的验签公钥守卫：缺失时告警并抛错，交给路由层回退 A 方案全量下载。
 *  公钥只从 env 读取，绝不硬编码；打包版必须在部署时注入 CV_UPDATE_PUBLIC_KEY
 *  才能启用增量更新，否则增量不可用但全量下载照常工作。 */
function requireUpdatePublicKey() {
    const pem = readUpdatePublicKey();
    if (!pem) {
        console.warn('[更新] 未配置验签公钥 CV_UPDATE_PUBLIC_KEY：增量更新不可用，本次回退全量下载。'
            + '打包版需在部署时注入该环境变量（公钥可公开，私钥仅发布端持有）方可启用增量更新。');
        throw new Error('未配置验签公钥（CV_UPDATE_PUBLIC_KEY）');
    }
    return pem;
}

/** 单个源的下载尝试：成功 resolve(true)，失败/被取消 resolve(false)。 */
function trySource(entry, ctx) {
    const { tmpPath, asset, finalPath } = ctx;
    return new Promise((resolve) => {
        let settled = false;
        let ws = null;
        let stream = null;
        const done = (ok, err) => {
            if (settled) return;
            settled = true;
            try { if (stream && !stream.destroyed) stream.destroy(); } catch (e) { /* 忽略 */ }
            try { if (ws) ws.end(); } catch (e) { /* 忽略 */ }
            if (ok) return resolve(true);
            // 被用户取消：清理后不再尝试其它源
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* 忽略 */ }
            if (downloadState.state === 'cancelled') return resolve(false);
            ctx.errors.push(entry.label + '：' + (err && err.message ? err.message : '失败'));
            return resolve(false);
        };

        request(entry.url, { timeout: 30000 }, true).then((r) => {
            if (downloadState.state === 'cancelled') return done(false, new Error('已取消'));
            if (r.status !== 200) return done(false, new Error('HTTP ' + r.status));
            stream = r.stream;
            downloadState.source = entry.label;
            downloadState.sourceUrl = entry.url;
            downloadState.total = r.length || asset.size || 0;
            downloadState.received = 0;   // 每换一个源，字节数从头算
            ws = fs.createWriteStream(tmpPath);
            stream.on('data', (chunk) => {
                downloadState.received += chunk.length;
                if (downloadState.total) {
                    downloadState.percent = Math.min(99.9, +(downloadState.received / downloadState.total * 100).toFixed(1));
                }
            });
            ws.on('error', (e) => done(false, e));
            stream.on('error', (e) => done(false, e));
            stream.on('end', () => {
                // 流结束：先关文件句柄，再校验大小（fs.statSync 需在数据落盘后）
                try { ws.end(); } catch (e) { /* 忽略 */ }
                // end 事件早于文件 fd 关闭，用 close 事件确保写完
                ws.on('close', () => {
                    try {
                        const st = fs.statSync(tmpPath);
                        const exact = asset.size && asset.sizeExact !== false;
                        if (exact ? st.size !== asset.size : st.size < 1024 * 1024) {
                            return done(false, new Error(asset.size
                                ? `文件大小不符（应 ${asset.size} 实际 ${st.size}）`
                                : `内容异常（仅 ${st.size} 字节）`));
                        }
                        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                        fs.renameSync(tmpPath, finalPath);
                        downloadState.received = st.size;
                        done(true);
                    } catch (e) { done(false, e); }
                });
            });
            downloadState._abort = () => { done(false, new Error('已取消')); };
        }).catch((e) => done(false, e));
    });
}

async function startDownload(assetName) {
    const cfg = updaterConfig();
    const chk = lastCheck && lastCheck.result;
    if (!chk || !chk.assets || !chk.assets.length) {
        throw new Error('请先执行一次「检查更新」');
    }
    const asset = chk.assets.find((a) => a.name === assetName) || chk.assets[0];
    if (!asset.downloadUrl) throw new Error('该版本没有可下载的安装包');

    const dir = updateDir();
    const finalPath = path.join(dir, asset.name);
    const tmpPath = finalPath + '.part';
    const candidates = candidateDownloadUrls(cfg, asset);
    if (!candidates.length) throw new Error('没有可用的下载源');

    const ctx = { tmpPath, asset, finalPath, errors: [] };
    downloadState = {
        state: 'downloading',
        assetName: asset.name,
        file: finalPath,
        received: 0,
        total: asset.size || 0,
        percent: 0,
        startedAt: Date.now(),
        error: null,
        source: null,
        attemptedSources: [],
    };

    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* 忽略 */ }

    for (const entry of candidates) {
        if (downloadState.state === 'cancelled') break;
        console.log('[更新] 尝试下载源：' + entry.label + ' ' + entry.url);
        downloadState.attemptedSources.push(entry.label);
        const ok = await trySource(entry, ctx);
        if (ok) {
            downloadState.state = 'done';
            downloadState.percent = 100;
            downloadState.finishedAt = Date.now();
            downloadState.error = null;
            console.log('[更新] 下载完成（源：' + entry.label + '）');
            return downloadState;
        }
        if (downloadState.state === 'cancelled') break;   // 用户取消，停止切换
        downloadState.received = 0;
        downloadState.percent = 0;
    }

    // 走到这里说明所有源都失败（或被取消）
    if (downloadState.state !== 'cancelled') {
        downloadState.state = 'error';
        downloadState.error = ctx.errors.join('；') || '所有下载源均失败';
    }
    const msg = downloadState.error || '下载已取消';
    throw new Error(msg);
}

/**
 * 验签公钥唯一信任锚：只从 CV_UPDATE_PUBLIC_KEY 环境变量读取。
 * 绝不接收 HTTP 请求体或调用方 opts 传入的公钥（否则攻击者可用自己的公钥
 * 伪造 patch 签名）。此函数不接受任何参数，是可供非 HTTP 测试注入的 seam。
 */
function readUpdatePublicKey() {
    // 1) 环境变量优先（部署时显式注入，最高优先级）
    const fromEnv = process.env.CV_UPDATE_PUBLIC_KEY;
    if (fromEnv && String(fromEnv).trim()) return fromEnv;
    // 2) 数据目录下的公钥文件（打包版由主进程从 payload 写入；公钥可公开，非凭据）
    //    <runtime>/utils/updater.js → 上两级到 <DATA_ROOT>/updates
    try {
        const dataUpdates = path.join(__dirname, '..', '..', 'updates');
        const keyFile = path.join(dataUpdates, 'update-public-key.pem');
        if (fs.existsSync(keyFile)) {
            const pem = fs.readFileSync(keyFile, 'utf-8').trim();
            if (pem) return pem;
        }
    } catch (e) { /* 读不到就当没有，回退全量下载 */ }
    return '';
}

/**
 * M2：增量 patch 下载 + 验签 + 写 staging / pending-switch.json（不切换）。
 *
 * 注意：opts 仅供内部/非 HTTP 测试使用，绝不可把 HTTP 请求体整包传入 ——
 * baseline / baselinePath / runtimeDir 等特权字段一旦被客户端控制，将可操纵
 * patch 文件名与本地改动检测根目录。HTTP 入口见 routes/update.js 的显式构造。
 *
 * 流程：取 baseline manifest（opts.baseline 或 opts.baselinePath 指向本地
 * cv-manifest-<ver>.json；未传则退到本地版本文件）→ 算 from→to →
 * 下载 cv-patch-<from>-<to>.zip（多源，复用 assertSafeUrl/candidateDownloadUrls/request）→
 * verifyPatch（验签公钥来自 CV_UPDATE_PUBLIC_KEY env，zip-slip + sha256）→
 * stagePatch（用 baseline 检测本地改动，只写 staging 与 pending-switch.json）。
 *
 * 任何一步失败都 throw，交给路由层回退 A 方案全量下载（不覆盖任何运行文件）。
 */
async function startIncremental(opts = {}) {
    const iu = require('./incremental-updater');   // 惰性 require，避免循环依赖
    // 必须强制重查：lastCheck 是 5 分钟缓存，Release 刚发布或之前查过旧版时，
    // 缓存里的 tag 可能是旧的 → 拼出不存在的 patch → 404 → 回退全量下载旧 Setup。
    // 实测用户「点增量却下了 6.8.8 全量包」即源于此。force=true 跳过缓存。
    let chk = null;
    try {
        chk = await checkUpdate(true);
    } catch (e) { /* checkUpdate 内部已降级，抛错则交回退层 */ }
    if (!chk || !chk.release) throw new Error('检查更新失败，无法确定目标版本');

    const target = String(chk.release.version || chk.release.tag || '').replace(/^[vV]/, '');
    // 阶段化进度：前端轮询 /api/update/status 可展示「进行到哪一步 + 预估剩余」。
    // phase: checking → downloading → verifying → staging → ready
    const started = Date.now();
    const setPhase = (phase, extra) => {
        downloadState = Object.assign({
            state: 'incremental-' + phase,
            phase,
            target,
            startedAt: started,
            percent: 0,
            error: null,
        }, extra || {});
    };
    setPhase('checking', { note: '正在检查版本与本地基线…' });

    /* baseline = 本地当前版本的 manifest（用于 from→to 命名 + 本地改动检测）。
     * checkUpdate.result.manifest 是「目标版本」的 manifest，只用于 target 侧参考，
     * 不能当 baseline（否则 from==to、本地改动全被误报），故必须从本地读取：
     *   opts.baseline  >  opts.baselinePath > <DATA_ROOT>/updates/baseline-manifest.json
     * 若以上都没有，ensureBaseline 会从本地已安装文件现场合成并落盘（首次安装/
     * 全量下载用户的 bootstrap），无需先成功切换过，也无需额外网络请求。 */
    let baseline = opts.baseline || null;
    if (!baseline) {
        baseline = ensureBaseline({
            runtimeDir: opts.runtimeDir,
            baselinePath: opts.baselinePath,
            version: localVersion(),
        });
    }
    if (!baseline || !baseline.files || !Object.keys(baseline.files).length) {
        throw new Error('本地无可合成 baseline 的源码文件，改走全量');
    }

    const cfg = updaterConfig();
    const fromVer = baseline.version || localVersion();
    const patchName = 'cv-patch-' + String(fromVer).replace(/^[vV]/, '') + '-' + target + '.zip';
    const patchUrl = assetDownloadUrl(cfg, chk.release.tag || chk.release.version, relForCheck(chk), patchName);
    if (!patchUrl) throw new Error('该版本未提供 patch 资产');

    // 信任锚：验签公钥只从环境变量读取，不接受 opts/请求体注入（review round1 Important#1）。
    // 缺失时告警并抛错 → 路由层回退全量；打包版须在部署时注入 CV_UPDATE_PUBLIC_KEY。
    const pubkeyPem = requireUpdatePublicKey();

    // 阶段2：下载 patch（带真实字节进度）
    setPhase('downloading', { note: '正在下载增量包…', percent: 0, received: 0, total: 0 });
    const patchBytes = await iu.downloadPatchBytes(cfg, { downloadUrl: patchUrl }, (received, total, label) => {
        const pct = total > 0 ? Math.min(99, Math.round(received / total * 100)) : 0;
        downloadState = Object.assign({}, downloadState, {
            state: 'incremental-downloading', phase: 'downloading',
            percent: pct, received, total,
            note: '正在下载增量包…' + (total > 0 ? ' ' + pct + '%' : ''),
            source: label,
        });
    });
    // 阶段3：校验签名与逐文件 sha256
    setPhase('verifying', { note: '正在校验签名与文件完整性…', percent: 99 });
    const updatesDir = updateDir();
    const stagingDir = path.join(updatesDir, 'staging-' + target);

    // 先清掉残留 staging（只删我们自己的 staging-* 目录，绝不碰运行文件）
    try { if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

    const staged = iu.stagePatch(patchBytes, {
        pubkeyPem,
        stagingDir,
        updatesDir,
        target,
        runtimeDir: opts.runtimeDir || path.join(__dirname, '..'),
        verifyAgainst: baseline,
    });
    if (!staged.ok) throw new Error(staged.error || 'patch 校验失败');

    // 阶段4：已就绪，等待主进程轮询切换（15s 一次），切换后自动重启
    setPhase('ready', {
        stagingPath: staged.stagingPath,
        file: staged.stagingPath,
        percent: 100,
        finishedAt: Date.now(),
        note: '增量包已就绪，正在自动完成更新（无需操作），稍后应用会自动重启',
    });
    return { ok: true, mode: 'incremental', target, stagingPath: staged.stagingPath };
}

/** 把 checkUpdate 结果里够用的字段拼回轻量 rel（供 assetDownloadUrl 用）。 */
function relForCheck(chk) {
    return { assets: (chk.assets || []).map(a => ({ name: a.name, browser_download_url: a.downloadUrl })) };
}

function cancelDownload() {
    if (!downloadState || downloadState.state !== 'downloading') return false;
    try { if (downloadState._abort) downloadState._abort(); } catch (e) { /* 忽略 */ }
    downloadState.state = 'cancelled';
    return true;
}

/* ============================================================ 安装/打开 */

/**
 * 安装已下载的包。
 * 安装版 → 直接拉起安装包（detached，脱离本进程），NSIS 会自己处理覆盖升级；
 * 便携版 → 无法自我覆盖，改为打开所在目录让用户替换。
 */
function installDownloaded(assetName) {
    const st = downloadState;
    const file = (st && st.state === 'done' && st.file) ? st.file
        : (assetName ? findDownloaded(assetName) : null);
    if (!file || !fs.existsSync(file)) return { ok: false, msg: '没有已下载的安装包' };

    const portable = isPortable();
    const isSetup = !/portable/i.test(path.basename(file));

    if (!portable && isSetup) {
        try {
            spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
            return { ok: true, mode: 'launch', msg: '已启动安装程序，按提示完成升级' };
        } catch (e) {
            return { ok: false, msg: '启动安装程序失败：' + e.message };
        }
    }
    // 便携版 / 拿了非 Setup 包：打开文件夹让用户自己替换
    const opened = openFolder(file);
    return {
        ok: opened,
        mode: 'folder',
        msg: opened
            ? '便携版需手动替换：已打开下载目录，关闭本程序后把新 exe 覆盖到原位置'
            : '已下载到：' + file,
    };
}

function openFolder(file) {
    const target = file || updateDir();
    try {
        if (process.platform === 'win32') {
            spawn('explorer', file ? ['/select,', target] : [target], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
            spawn('open', [file ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
        } else {
            spawn('xdg-open', [file ? path.dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
        }
        return true;
    } catch (e) {
        console.warn('[更新] 打开目录失败: ' + e.message);
        return false;
    }
}

/* ================================================================ 导出 */

function status() {
    const cfg = updaterConfig();
    return {
        version: localVersion(),
        portable: isPortable(),
        enabled: cfg.enabled,
        autoCheck: cfg.autoCheck,
        repo: cfg.repo,
        check: lastCheck ? lastCheck.result : null,
        download: getDownloadState(),
        downloadedFile: (downloadState && downloadState.state === 'done') ? downloadState.file : null,
    };
}

module.exports = {
    updaterConfig,
    localVersion,
    isPortable,
    cmpVersion,
    checkUpdate,
    startDownload,
    cancelDownload,
    installDownloaded,
    openFolder,
    updateDir,
    status,
    request,        // round33：acg-rank.js 复用它的代理/直连双路请求
    assertSafeUrl,  // 导出供单测与复用：SSRF 目标校验
    isBlockedIp,    // 纯函数，便于测试私网/保留地址判定
    candidateDownloadUrls, // 导出供单测：多源 URL 构造
    startIncremental,       // M2：增量 patch 下载 + 校验（不切换）
    readUpdatePublicKey,    // M2：验签公钥唯一信任锚（只读 env，供非 HTTP 测试）
    requireUpdatePublicKey, // 公钥缺失守卫：告警 + 抛错 → 回退全量（供非 HTTP 测试）
    synthesizeBaseline,     // fresh-install bootstrap：从本地已安装文件合成 baseline（不触网）
    ensureBaseline,         // baseline 读取/合成 + 落盘（供非 HTTP 测试）
    INCREMENTAL_FILE_PREFIXES, // 增量扫描前缀（与发布端 _cv_patch.py ALLOWED 同口径）
    /** 仅供非 HTTP 单测注入最近一次 checkUpdate 结果（startIncremental 依赖它）。
     *  HTTP 路由绝不调用；真实运行由 checkUpdate() 自行填充。 */
    __setLastCheckForTest(result) { lastCheck = result ? { at: Date.now(), result } : null; },
    normalizeManifest,      // M2：snake_case → camelCase 字段转换
    manifestAssetName,      // M2：cv-manifest-<ver>.json 命名
};
