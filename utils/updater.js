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
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
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

/* ================================================================== 配置 */

function updaterConfig() {
    const c = config.update || {};
    return {
        enabled: c.enabled !== false,
        repo: c.repo || DEFAULT_REPO,
        apiBase: (c.apiBase || 'https://api.github.com').replace(/\/+$/, ''),
        downloadPrefix: c.downloadPrefix || '',   // 可选：CDN/加速前缀，拼在下载链接前
        autoCheck: c.autoCheck !== false,         // 启动时静默检查一次
        token: c.token || '',                     // 可选：提 GitHub API 限额（60/h → 5000/h）
    };
}

/* ============================================================ 本地版本 */

function localVersion() {
    if (process.env.CINEMAVAULT_VERSION) return String(process.env.CINEMAVAULT_VERSION).trim();

    try {
        const f = path.join(__dirname, 'app-version.json');
        if (fs.existsSync(f)) {
            const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
            if (j && j.version) return String(j.version);
        }
    } catch (e) { /* 兜底下一条 */ }

    // 开发模式（直接 node server.js）：读 packaging/package.json，那才是 exe 的版本
    try {
        const f = path.join(__dirname, '..', 'packaging', 'package.json');
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')).version || '0.0.0';
    } catch (e) { /* 兜底下一条 */ }

    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
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
        let u;
        try { u = new URL(url); } catch (e) { return reject(new Error('URL 无效: ' + url)); }

        const { agent, proxy } = makeAgent(opts);
        const mod = u.protocol === 'http:' ? http : https;
        const headers = Object.assign({
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
        }, opts.headers || {});

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
            // 重定向
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).toString();
                return resolve(request(next, opts, stream, onData));
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
        req.end();
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

    lastCheck = { at: Date.now(), result: base };
    return base;
}

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

    downloadState = {
        state: 'downloading',
        assetName: asset.name,
        file: finalPath,
        received: 0,
        total: asset.size || 0,
        percent: 0,
        startedAt: Date.now(),
        error: null,
    };

    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* 忽略 */ }

    /* 下载加速前缀：有些地区 GitHub 直连很慢，可在 config.update.downloadPrefix
     * 里填镜像前缀（如 https://ghfast.top/），会自动拼到原始链接前面。 */
    const url = cfg.downloadPrefix
        ? cfg.downloadPrefix.replace(/\/+$/, '') + '/' + asset.downloadUrl
        : asset.downloadUrl;

    return new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpPath);
        let settled = false;
        const finish = (err) => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch (e) { /* 忽略 */ }
            if (err) {
                downloadState.state = 'error';
                downloadState.error = err.message;
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* 忽略 */ }
                return reject(err);
            }
            /* 大小校验：API 通道有精确 size，对不上就是下坏了；
             * 网页通道拿不到 size，退而求其次 —— 小于 1MB 的一定不是 100MB 的安装包。 */
            const st = fs.statSync(tmpPath);
            const exact = asset.size && asset.sizeExact !== false;
            if (exact ? st.size !== asset.size : st.size < 1024 * 1024) {
                downloadState.state = 'error';
                downloadState.error = asset.size
                    ? `文件大小不符（应为 ${asset.size} 实际 ${st.size}）`
                    : `下载内容异常（只有 ${st.size} 字节），请重试`;
                try { fs.unlinkSync(tmpPath); } catch (e) { /* 忽略 */ }
                return reject(new Error(downloadState.error));
            }
            try {
                if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                fs.renameSync(tmpPath, finalPath);
            } catch (e) {
                downloadState.state = 'error';
                downloadState.error = '落盘失败：' + e.message;
                return reject(e);
            }
            downloadState.state = 'done';
            downloadState.percent = 100;
            downloadState.received = st.size;
            downloadState.finishedAt = Date.now();
            resolve(downloadState);
        };

        request(url, { timeout: 30000 }, true).then((r) => {
            if (r.status !== 200) {
                return finish(new Error('下载失败，HTTP ' + r.status));
            }
            downloadState.total = r.length || asset.size || 0;
            let cur = null;
            r.stream.on('data', (chunk) => {
                downloadState.received += chunk.length;
                if (downloadState.total) {
                    downloadState.percent = Math.min(99.9, +(downloadState.received / downloadState.total * 100).toFixed(1));
                }
            });
            ws.on('error', finish);
            r.stream.on('error', finish);
            r.stream.on('end', () => finish(null));
            r.stream.pipe(ws);
            cur = r.stream;
            downloadState._abort = () => { try { cur.destroy(); } catch (e) { /* 忽略 */ } };
        }).catch(finish);
    });
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
};
