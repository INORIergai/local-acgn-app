// ================================================================
// utils/bangumi-oauth.js —— round173e Bangumi OAuth + 请求层
//   职责：
//   1. 双路 HTTP（代理 → 直连），本机 bgm.tv 直连超时、走 7892 代理通
//   2. OAuth 授权码流程：授权 URL / 换 token / 刷新 token
//   3. token 持久化到 config.sources.bangumi（config.configPath）
//   4. 两种接入方式：完整 OAuth（client id/secret）或手动填 accessToken（零门槛降级）
//
//   ★ 导出的是模块对象，调用方必须解构（如 const { api } = require('./bangumi-oauth')）
// ================================================================

const fs = require('fs');
const config = require('./config');
const { ProxyAgent } = require('undici');

// ★ 允许环境变量覆盖 API base：①离线 mock 测试 ②用户自建镜像/反代（bgm.tv 大陆常需代理）
const API_BASE = (process.env.CINEMAVAULT_BGM_API || 'https://api.bgm.tv').replace(/\/$/, '');
const OAUTH_BASE = (process.env.CINEMAVAULT_BGM_OAUTH || API_BASE + '/oauth').replace(/\/$/, '');
const UA = 'CinemaVault/1.0 (local media library; Bangumi sync)';
const DEFAULT_TIMEOUT = 12000;

// ---------- 双路 fetch（代理失败→直连，照 acg-calendar.js 同构） ----------
let _proxyAgent = null;
function candidateDispatchers() {
    const px = config.network?.proxyServer;
    const list = [];
    if (px) {
        try {
            if (!_proxyAgent) _proxyAgent = new ProxyAgent(px);
            list.push(_proxyAgent);
        } catch (e) { /* 代理串坏就算了 */ }
    }
    list.push(undefined);
    return list;
}

/** 双路请求，返回 Response；全失败抛最后一个错。allowStatus=true 时不因非 2xx 放弃（让上层读错误体） */
async function dualFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
    let lastErr = '';
    for (const d of candidateDispatchers()) {
        try {
            const r = await fetch(url, {
                ...options,
                ...(d ? { dispatcher: d } : {}),
                headers: { 'User-Agent': UA, ...(options.headers || {}) },
                signal: AbortSignal.timeout(timeoutMs),
            });
            // 4xx/5xx 是「服务回了」，不算网络失败，直接返回交给上层判断
            return r;
        } catch (e) { lastErr = e.message; }
    }
    throw new Error(lastErr || 'Bangumi 请求失败（代理与直连均不可达）');
}

async function dualFetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
    const r = await dualFetch(url, options, timeoutMs);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!r.ok) {
        const err = new Error(`Bangumi HTTP ${r.status}${json ? ': ' + (json.title || json.msg || '') : ''}`);
        err.status = r.status; err.body = json || text;
        throw err;
    }
    return json;
}

// ---------- config 读写 ----------
function readCfg() { return JSON.parse(fs.readFileSync(config.configPath, 'utf8')); }
function writeCfg(cfg) { fs.writeFileSync(config.configPath, JSON.stringify(cfg, null, 4), 'utf8'); }
function bangumiSection(cfg) {
    cfg.sources = cfg.sources || {};
    cfg.sources.bangumi = cfg.sources.bangumi || {};
    return cfg.sources.bangumi;
}

/** 当前 token（优先 config.sources.bangumi.accessToken） */
function getToken() {
    return String(config.sources?.bangumi?.accessToken || '').trim();
}

function saveToken(token, extra = {}) {
    const cfg = readCfg();
    const sec = bangumiSection(cfg);
    sec.accessToken = token;
    if (extra.refreshToken) sec.refreshToken = extra.refreshToken;
    if (extra.expiresAt) sec.tokenExpiresAt = extra.expiresAt;
    sec.connectedAt = Date.now();
    writeCfg(cfg);
    // 同步内存单例，避免重启前读不到
    config.sources.bangumi.accessToken = token;
    if (extra.refreshToken) config.sources.bangumi.refreshToken = extra.refreshToken;
}

function clearToken() {
    const cfg = readCfg();
    const sec = bangumiSection(cfg);
    delete sec.accessToken; delete sec.refreshToken; delete sec.tokenExpiresAt; delete sec.connectedAt;
    writeCfg(cfg);
    delete config.sources.bangumi.accessToken;
    delete config.sources.bangumi.refreshToken;
}

function getCredentials() {
    const sec = config.sources?.bangumi || {};
    return { clientId: String(sec.clientId || ''), clientSecret: String(sec.clientSecret || '') };
}

function saveCredentials(clientId, clientSecret) {
    const cfg = readCfg();
    const sec = bangumiSection(cfg);
    sec.clientId = String(clientId || '').trim();
    sec.clientSecret = String(clientSecret || '').trim();
    writeCfg(cfg);
    config.sources.bangumi.clientId = sec.clientId;
    config.sources.bangumi.clientSecret = sec.clientSecret;
}

// ---------- OAuth ----------
/** 生成授权 URL；redirectUri 由调用方（路由）按当前 host 拼好传入 */
function buildAuthorizeUrl(redirectUri, state) {
    const { clientId } = getCredentials();
    if (!clientId) throw new Error('请先保存 Bangumi Client ID');
    const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state: String(state || ''),
    });
    return OAUTH_BASE + '/authorize?' + q.toString();
}

/** 授权码换 token */
async function exchangeCode(code, redirectUri) {
    const { clientId, clientSecret } = getCredentials();
    if (!clientId || !clientSecret) throw new Error('请先保存 Bangumi Client ID / Secret');
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        redirect_uri: redirectUri,
    });
    const j = await dualFetchJson(OAUTH_BASE + '/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!j.access_token) throw new Error('授权响应缺少 access_token');
    saveToken(j.access_token, {
        refreshToken: j.refresh_token,
        expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : null,
    });
    return j;
}

/** 刷新 token（若有 refresh_token） */
async function refreshAccessToken() {
    const cfg = readCfg();
    const sec = bangumiSection(cfg);
    if (!sec.refreshToken) throw new Error('没有 refresh_token，请重新授权');
    const { clientId, clientSecret } = getCredentials();
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId, client_secret: clientSecret,
        refresh_token: sec.refreshToken,
    });
    const j = await dualFetchJson(OAUTH_BASE + '/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!j.access_token) throw new Error('刷新响应缺少 access_token');
    saveToken(j.access_token, {
        refreshToken: j.refresh_token || sec.refreshToken,
        expiresAt: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : null,
    });
    return j;
}

// ---------- API 请求 ----------
/** 带 token 的 Bangumi API 请求；401 自动刷新一次重试 */
async function api(path, opts = {}, _retried = false) {
    const token = getToken();
    if (!token) throw new Error('未连接 Bangumi（未配置 access token）');
    const r = await dualFetch(API_BASE + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) },
    });
    if (r.status === 401 && !_retried && getCredentials().clientId) {
        try { await refreshAccessToken(); return await api(path, opts, true); }
        catch (e) { /* 刷新失败就往下走，抛原始 401 */ }
    }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    if (!r.ok) {
        const err = new Error(`Bangumi API ${r.status}: ${(json && (json.title || json.msg)) || text.slice(0, 100)}`);
        err.status = r.status; throw err;
    }
    return json;
}

/** 验证 token 是否有效，返回用户信息 */
async function me() {
    return api('/v0/me');
}

module.exports = {
    API_BASE, OAUTH_BASE,
    dualFetch, dualFetchJson,
    getToken, saveToken, clearToken,
    getCredentials, saveCredentials,
    buildAuthorizeUrl, exchangeCode, refreshAccessToken,
    api, me,
};
