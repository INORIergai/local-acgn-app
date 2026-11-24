/**
 * utils/series-rating.js —— 追番海报右上角的 Bangumi 评分
 * ------------------------------------------------------------------
 * 数据源：api.bgm.tv/v0（与 scraper/rank 共用同一套代理策略）
 *   · 能确定 Bangumi 条目 id 的（provider=bangumi + 数字 providerId）→ 直接取详情
 *   · 其余按标题搜索（filter.type=2 只搜动画），用 series-online 的 titleScore
 *     选最像的一条；低于 0.7 视为没匹配上，不显示评分（宁缺勿错）
 *
 * 缓存：runtime/cache/series-ratings.json
 *   byId / byTitle 双键 —— 同一部番在放送表和追番看板里是两条 series 记录，
 *   标题键可以让它们共用一次请求。命中 14 天、未命中 2 天后重试。
 *
 * 预算：调用方给 budgetMs（默认 12s）；到点就返回已完成的，剩下的放进 pending，
 * 前端可以过几秒再补一次。绝不因为 Bangumi 慢/不可达拖死页面渲染。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { request } = require('./updater');
const { normalizeTitle, titleScore } = require('./series-online');

const API = String(config.sources?.bangumi?.apiBase || 'https://api.bgm.tv').replace(/\/$/, '');
const UA = 'CinemaVault/1.4 (local personal media library)';
const TTL_HIT = 14 * 24 * 3600 * 1000;
const TTL_MISS = 2 * 24 * 3600 * 1000;
const MATCH_THRESHOLD = 0.7;

function runtimeDir() {
    if (process.env.APPDATA) return path.join(process.env.APPDATA, 'CinemaVault', 'runtime');
    return path.join(__dirname, '..');
}
const CACHE_FILE = path.join(runtimeDir(), 'cache', 'series-ratings.json');

let cache = null;
let saveTimer = null;

function loadCache() {
    if (cache) return cache;
    try {
        const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        cache = {
            byId: (j && j.byId) || {},
            byTitle: (j && j.byTitle) || {},
        };
    } catch (e) {
        cache = { byId: {}, byTitle: {} };
    }
    return cache;
}

function queueSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
            fs.writeFileSync(CACHE_FILE, JSON.stringify(loadCache()), 'utf8');
        } catch (e) { /* 缓存写失败不影响功能 */ }
    }, 1200);
    if (saveTimer.unref) saveTimer.unref();
}

function apiHeaders(extra) {
    const h = Object.assign({ 'User-Agent': UA, 'Accept': 'application/json' }, extra || {});
    const token = config.sources?.bangumi?.accessToken;
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
}

async function getJson(pathname, timeout) {
    const r = await request(API + pathname, { headers: apiHeaders(), timeout: timeout || 8000 }, false, null);
    const raw = typeof r === 'string' ? r : (r && r.body) || '';
    return JSON.parse(raw);
}

async function postJson(pathname, body, timeout) {
    const r = await request(API + pathname, {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        timeout: timeout || 8000,
    }, false, null);
    const raw = typeof r === 'string' ? r : (r && r.body) || '';
    return JSON.parse(raw);
}

function pickRating(subject) {
    const rt = subject && subject.rating;
    const score = rt && typeof rt.score === 'number' ? Number(rt.score.toFixed(1)) : null;
    if (score == null || score <= 0) return null;
    return {
        score,
        votes: Number(rt.total) || 0,
        rank: Number(rt.rank) || 0,
        bgmId: subject.id || null,
    };
}

/** provider 自带 Bangumi id：一条详情请求即可（最准） */
async function byProviderId(provider, providerId) {
    const p = String(provider || '').toLowerCase();
    if (!/^(bangumi|bgm|bgtv)$/.test(p)) return null;
    const id = String(providerId || '').trim();
    if (!/^\d+$/.test(id)) return null;
    const s = await getJson('/v0/subjects/' + id);
    const r = pickRating(s);
    if (!r) return null;
    r.title = s.name_cn || s.name || '';
    return r;
}

/** 按标题搜索（只搜动画 type=2），取 titleScore 最高且 ≥0.7 的条目 */
async function bySearch(keywords) {
    let best = null;
    for (const kw of keywords) {
        const q = String(kw || '').trim();
        if (!q) continue;
        let j;
        try {
            j = await postJson('/v0/search/subjects', { keyword: q.slice(0, 80), filter: { type: [2] } });
        } catch (e) {
            continue;
        }
        for (const s of (j && j.data) || []) {
            const r = pickRating(s);
            if (!r) continue;
            const scoreHit = Math.max(
                titleScore(s.name_cn || '', q),
                titleScore(s.name || '', q)
            );
            if (!best || scoreHit > best.match) {
                best = { ...r, title: s.name_cn || s.name || '', match: scoreHit };
            }
        }
        if (best && best.match >= 0.95) break;   // 完全一致就不用再试别的关键词
    }
    if (!best || best.match < MATCH_THRESHOLD) return null;
    return best;
}

async function resolveOne(s) {
    const one = await byProviderId(s.provider, s.providerId);
    if (one) return one;
    return bySearch([s.title, s.originalTitle]);
}

function fresh(entry) {
    if (!entry || !entry.at) return false;
    return Date.now() - entry.at < (entry.miss ? TTL_MISS : TTL_HIT);
}

function shape(entry) {
    if (!entry || entry.miss || entry.score == null) return null;
    return { score: entry.score, votes: entry.votes || 0, rank: entry.rank || 0, bgmId: entry.bgmId || null };
}

/**
 * @param {Array<{id,title,originalTitle,provider,providerId}>} seriesList
 * @param {{budgetMs?:number, force?:boolean}} opts
 * @returns {Promise<{ratings:Object<number,object>, pending:number[]}>}
 */
async function getRatings(seriesList, opts = {}) {
    const c = loadCache();
    const ratings = {};
    const pending = [];
    const todo = [];
    const force = opts.force === true;

    for (const s of (Array.isArray(seriesList) ? seriesList : [])) {
        const id = Number(s.id);
        if (!id) continue;
        const key = normalizeTitle(s.title);
        const byId = c.byId[id];
        const byTitle = key ? c.byTitle[key] : null;
        const hit = (!force && byId && byId.title === s.title && fresh(byId)) ? byId
            : (!force && byTitle && fresh(byTitle)) ? byTitle
            : null;
        if (hit) {
            const r = shape(hit);
            if (r) ratings[id] = r;
            continue;
        }
        todo.push(s);
        pending.push(id);
    }

    const startedAt = Date.now();
    const budget = Math.max(1000, Number(opts.budgetMs) || 12000);
    let cursor = 0;
    const worker = async () => {
        while (cursor < todo.length && Date.now() - startedAt < budget) {
            const s = todo[cursor++];
            const id = Number(s.id);
            const key = normalizeTitle(s.title);
            try {
                const one = await resolveOne(s);
                const at = Date.now();
                if (one) {
                    const entry = { ...one, title: s.title, at };
                    c.byId[id] = entry;
                    if (key) c.byTitle[key] = entry;
                    ratings[id] = shape(entry);
                } else {
                    c.byId[id] = { title: s.title, miss: true, at };
                }
                const idx = pending.indexOf(id);
                if (idx >= 0) pending.splice(idx, 1);
            } catch (e) {
                // 网络层失败：不写 miss 缓存，留给下一次重试；仍留在 pending
            }
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    queueSave();
    return { ratings, pending };
}

module.exports = { getRatings, CACHE_FILE };
