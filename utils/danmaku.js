/**
 * utils/danmaku.js — 弹弹play 开放 API 客户端（round36 P0-1）
 *
 * 协议参照 animeko danmaku/dandanplay 客户端实现：
 *   POST /api/v2/match            按文件名匹配剧集 → episodeId
 *   GET  /api/v2/comment/{id}     拉取弹幕池（含聚合源）
 *
 * 鉴权（弹弹play 开放平台，免费申请：https://www.dandanplay.com/dpa.html）：
 *   X-AppId:      申请的 appId
 *   X-Timestamp:  Unix 秒
 *   X-Signature:  Base64( SHA256( appId + timestamp + path + appSecret ) )
 *   path = URL 路径（不含 query），与 animeko generateSignature 一致。
 *
 * 凭据存 config.danmaku = { appId, appSecret }；未配置时接口返回明确提示，
 * 前端弹幕层降级为隐藏（不报错打扰）。
 */
const crypto = require('crypto');
const { ProxyAgent } = require('undici');
const config = require('./config');

const BASE = 'https://api.dandanplay.net';
const UA = 'CinemaVault/1.0 (local media library)';

// 代理/直连双路（与 routes/webview.js probeDispatcher 同构；代理失效时直连补一发）
let _proxyAgent = null;
function candidateDispatchers() {
    const px = config.network?.proxyServer;
    const list = [];
    if (px) {
        if (!_proxyAgent) _proxyAgent = new ProxyAgent(px);
        list.push(_proxyAgent);
    }
    list.push(undefined); // 直连兜底
    return list;
}

// 弹幕池内存缓存：episodeId -> { at, comments }
const commentCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h
// 匹配结果缓存：fileName -> { at, result }
const matchCache = new Map();

function creds() {
    // ★ 每次调用重读配置文件：凭据在设置页保存后无需重启即可生效
    //   （utils/config.js 是启动快照，其余配置项仍遵循「重启后生效」惯例）
    try {
        const d = JSON.parse(require('fs').readFileSync(config.configPath, 'utf8')).danmaku || {};
        return { appId: (d.appId || '').trim(), appSecret: (d.appSecret || '').trim() };
    } catch (e) {
        const d = config.danmaku || {};
        return { appId: (d.appId || '').trim(), appSecret: (d.appSecret || '').trim() };
    }
}

function isConfigured() {
    const { appId, appSecret } = creds();
    return !!(appId && appSecret);
}

/** 按弹弹play 规范生成签名头 */
function authHeaders(path) {
    const { appId, appSecret } = creds();
    const ts = Math.floor(Date.now() / 1000);
    const data = appId + ts + path + appSecret;
    const sig = crypto.createHash('sha256').update(data, 'utf8').digest('base64');
    return {
        'X-AppId': appId,
        'X-Timestamp': String(ts),
        'X-Signature': sig,
        'User-Agent': UA,
        'Content-Type': 'application/json',
    };
}

/**
 * 请求代理/直连双路（round35 probeFetch 经验：配置代理可能失效）
 */
async function ddpFetch(path, options = {}) {
    const dispatchers = candidateDispatchers();
    let lastErr = '';
    for (let i = 0; i < dispatchers.length; i++) {
        try {
            const r = await fetch(BASE + path, {
                ...options,
                headers: { ...authHeaders(path.split('?')[0]), ...(options.headers || {}) },
                ...(dispatchers[i] ? { dispatcher: dispatchers[i] } : {}),
                signal: AbortSignal.timeout(15000),
            });
            const body = await r.json().catch(() => ({}));
            if (r.status === 200 && body.success !== false) return body;
            lastErr = `HTTP ${r.status} ${body.errorMessage || ''}`.trim();
        } catch (e) {
            lastErr = e.message;
        }
        if (i < dispatchers.length - 1) await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(lastErr || '请求失败');
}

/**
 * 按文件名匹配剧集
 * @returns {{episodeId:number, animeTitle:string, episodeTitle:string}|null}
 */
async function matchEpisode(fileName) {
    if (!isConfigured()) throw new Error('弹弹play 未配置：请在设置中填入 AppId / AppSecret');
    const cacheKey = String(fileName || '').trim();
    if (!cacheKey) throw new Error('文件名为空，无法匹配');
    const hit = matchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.result;

    const body = await ddpFetch('/api/v2/match', {
        method: 'POST',
        body: JSON.stringify({ fileName: cacheKey, matchMode: 'fileNameOnly' }),
    });
    const m = (body.matches || [])[0];
    const result = m
        ? { episodeId: m.episodeId, animeTitle: m.animeTitle, episodeTitle: m.episodeTitle }
        : null;
    matchCache.set(cacheKey, { at: Date.now(), result });
    return result;
}

/**
 * 拉取并规范化弹幕
 * @returns {Promise<Array<{t:number, mode:number, color:number, text:string}>>}
 *   t=毫秒, mode: 1滚动 4底部 5顶部（弹弹play 编码 1-3滚动/4底部/5顶部）
 */
async function getComments(episodeId, chConvert = 1) {
    if (!isConfigured()) throw new Error('弹弹play 未配置');
    const hit = commentCache.get(episodeId);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.comments;

    const body = await ddpFetch(`/api/v2/comment/${encodeURIComponent(episodeId)}?chConvert=${chConvert}&withRelated=true`);
    const raw = Array.isArray(body.comments) ? body.comments : [];
    const comments = [];
    for (const c of raw) {
        // p = "时间(秒),模式,颜色[,来源]"；文本在 c.m
        if (!c || typeof c.p !== 'string' || typeof c.m !== 'string') continue;
        const parts = c.p.split(',');
        const t = Math.round(parseFloat(parts[0]) * 1000);
        if (!Number.isFinite(t) || t < 0) continue;
        let mode = parseInt(parts[1], 10) || 1;
        mode = (mode <= 3) ? 1 : (mode === 4 ? 4 : 5);
        const color = parseInt(parts[2], 10) || 0xffffff;
        const text = c.m.trim();
        if (!text) continue;
        comments.push({ t, mode, color, text });
    }
    comments.sort((a, b) => a.t - b.t);
    commentCache.set(episodeId, { at: Date.now(), comments });
    return comments;
}

module.exports = { matchEpisode, getComments, isConfigured };
