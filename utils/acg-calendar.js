/**
 * utils/acg-calendar.js — 新番放送时间表（round36 P0-2）
 *
 * 主源：次元城动画追番周表（round56，用户点名；标题/简介全中文，直连可达）
 * 备源1：AniList airingSchedules（放送时间精确到「集」；标题经 Bangumi/bangumi-data 映射中文化）
 * 备源2：Bangumi /calendar（bgm.tv 本机常超时，apiBase 支持镜像配置，失败静默降级）
 *
 * 输出统一形态：
 * { source, weekStart, days: [ { date:'09-27 周六', items:[{title, episode, airingAt(ms), cover, source}] } ] }
 * 服务端缓存 6h（AniList 限流敏感，round34 有前科）。
 */
const config = require('./config');
const { ProxyAgent } = require('undici');

const ANILIST = 'https://graphql.anilist.co';
const CACHE = { at: 0, data: null };
const TTL = 6 * 60 * 60 * 1000;

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) { return n < 10 ? '0' + n : '' + n; }

// 代理/直连双路（danmaku.js 同构：配置的代理可能已关，代理失效时直连补一发）
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

/** 双路取 JSON；全失败抛最后一个错误 */
async function dualFetchJson(url, options = {}, timeoutMs = 10000) {
    let lastErr = '';
    const dispatchers = candidateDispatchers();
    for (let i = 0; i < dispatchers.length; i++) {
        try {
            const r = await fetch(url, {
                ...options,
                ...(dispatchers[i] ? { dispatcher: dispatchers[i] } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
            return await r.json();
        } catch (e) {
            lastErr = e.message;
        }
    }
    throw new Error(lastErr || '请求失败');
}

/**
 * Bangumi 中文名映射（round54 修复「本周放送全英文名」）：
 * AniList 没有中文标题（userPreferred 实际多为罗马音），而 bgm.tv 的
 * /calendar 自带 name_cn 且恰好覆盖当前季在播番 —— 拉一份建
 * 「归一化日文名/罗马名 → 中文名」映射，给 AniList 排播条目套上中文名。
 * Bangumi 拉不到（超时/代理关了）就静默返回空映射，条目退回原名（日文）。
 */
const NAME_MAP_CACHE = { at: 0, map: null };
function normTitle(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '')
        .replace(/[「」『』【】\[\]()（）''"":：·、，,。.\-–—~～!！?？*&+]/g, '');
}
async function getBangumiNameMap() {
    if (NAME_MAP_CACHE.map && Date.now() - NAME_MAP_CACHE.at < TTL) return NAME_MAP_CACHE.map;
    const apiBase = (config.sources?.bangumi?.apiBase || 'https://api.bgm.tv').replace(/\/$/, '');
    const week = await dualFetchJson(apiBase + '/calendar', {
        headers: { 'User-Agent': 'CinemaVault/1.0 (local app)' },
    }, 8000).catch(() => null);
    if (!Array.isArray(week) || !week.length) {
        NAME_MAP_CACHE.map = new Map();
    } else {
        const m = new Map();
        for (const day of week) {
            for (const it of (day.items || [])) {
                const cn = (it.name_cn || '').trim();
                if (!cn) continue;
                for (const k of [it.name, ...(it.name_synonyms || [])]) {
                    const nk = normTitle(k);
                    if (nk && !m.has(nk)) m.set(nk, cn);
                }
            }
        }
        NAME_MAP_CACHE.map = m;
    }
    NAME_MAP_CACHE.at = Date.now();
    return NAME_MAP_CACHE.map;
}

/* round55 补强：bangumi-data（bangumi-data.github.io 开源排播库）标题→中文映射。
 * 覆盖 Bangumi /calendar 收不到的短篇/OVA/新作（如 ふももぴゅあ 系列）。
 * 全量数据 ~7MB 经 jsdelivr 拉取，落盘 runtime/cache/bangumi-data-zh.json（TTL 7 天）；
 * 拉不到静默返回空 Map（回退 bgm 名映射 → 原名），绝不阻塞排播表。 */
const BDATA_ZH = { at: 0, map: null };
const BDATA_TTL = 7 * 24 * 60 * 60 * 1000;
async function getBdataTitleZh() {
    if (BDATA_ZH.map && Date.now() - BDATA_ZH.at < TTL) return BDATA_ZH.map;
    const bpath = require('path');
    const bfs = require('fs');
    const dir = (process.env.APPDATA
        ? bpath.join(process.env.APPDATA, 'CinemaVault', 'runtime')
        : bpath.join(__dirname, '..'));
    const file = bpath.join(dir, 'cache', 'bangumi-data-zh.json');
    // 1) 盘缓存新鲜 → 直接用（重启后零网络开销）
    try {
        const j = JSON.parse(bfs.readFileSync(file, 'utf8'));
        if (j && j.at && Date.now() - j.at < BDATA_TTL && j.map) {
            BDATA_ZH.map = new Map(Object.entries(j.map));
            BDATA_ZH.at = Date.now();
            return BDATA_ZH.map;
        }
    } catch (e) { /* 无缓存 */ }
    // 2) 拉全量建「归一化标题 → zh-Hans」映射（含各语言别名，双路：jsdelivr → unpkg）
    const urls = [
        'https://cdn.jsdelivr.net/npm/bangumi-data@latest/dist/data.json',
        'https://unpkg.com/bangumi-data@latest/dist/data.json',
    ];
    let data = null;
    for (const u of urls) {
        try {
            data = await dualFetchJson(u, { headers: { 'User-Agent': 'CinemaVault/1.0' } }, 90000);
            break;
        } catch (e) { /* 下一路 */ }
    }
    const m = new Map();
    if (data && Array.isArray(data.items)) {
        for (const it of data.items) {
            const tt = it.titleTranslate || {};
            const zh = ((tt['zh-Hans'] || [])[0] || '').trim();
            if (!zh) continue;
            const keys = [it.title];
            for (const lang of Object.keys(tt)) keys.push(...(tt[lang] || []));
            for (const k of keys) {
                const nk = normTitle(k);
                if (nk && !m.has(nk)) m.set(nk, zh);
            }
        }
    }
    BDATA_ZH.map = m;
    // 命中过空（源挂了/没网）→ 内存只信 10 分钟，尽快重试；正常 7 天
    BDATA_ZH.at = m.size ? Date.now() : Date.now() - TTL + 10 * 60 * 1000;
    // 落盘（失败不影响本次使用）
    if (m.size) {
        try {
            bfs.mkdirSync(bpath.dirname(file), { recursive: true });
            bfs.writeFileSync(file, JSON.stringify({ at: Date.now(), map: Object.fromEntries(m) }));
        } catch (e) { /* 忽略 */ }
    }
    return BDATA_ZH.map;
}

/**
 * round56 主源：次元城动画追番周表（用户点名需求）。
 * - 标题/简介/标签全中文，封面齐全，比 AniList+映射链又全又准
 * - 接口：GET /api/index/weekday（无参=全周，data.list 按 weekday 1~7 分组）
 * - 必带 header：X-App-Name: cyc_web / X-Time-Zone / X-App-Version（站前端 http client 实证）
 * - 本机直连可达（round55 实测 200/0.5s）；经代理 403 → dualFetchJson 双路自动降级直连
 */
const CYCANIME_API = 'https://www.cycani.org/api/index/weekday';
const CYC_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'X-App-Name': 'cyc_web',
    'X-Time-Zone': 'Asia/Shanghai',
    'X-App-Version': 'cycweb',
};
async function fetchCycanimeWeek() {
    const body = await dualFetchJson(CYCANIME_API, { headers: CYC_HEADERS }, 12000);
    if (!body || body.code !== 0) throw new Error(`cycanime 周表响应异常 code=${body && body.code}`);
    const list = (body.data && Array.isArray(body.data.list)) ? body.data.list : [];
    if (!list.length) throw new Error('cycanime 周表为空');
    const byWeekday = new Map();
    for (const g of list) {
        if (g && typeof g.weekday === 'number' && g.weekday >= 1 && g.weekday <= 7) {
            byWeekday.set(g.weekday, Array.isArray(g.videos) ? g.videos : []);
        }
    }
    const now = new Date();
    const days = [];
    let total = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const wd = d.getDay() === 0 ? 7 : d.getDay(); // cycanime 周一=1 … 周日=7
        const items = (byWeekday.get(wd) || []).map((v) => ({
            title: (v && v.title) || '(未命名)',
            episode: null,
            airingAt: null,
            cover: (v && v.cover_url) || '',
            source: 'cycanime',
            score: (v && v.score) || null,
            totalEps: (v && v.total) || null,
            cycId: (v && v.video_id) || null,
        }));
        total += items.length;
        days.push({
            date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
            label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEK_CN[d.getDay()]}${i === 0 ? ' · 今天' : ''}`,
            items,
        });
    }
    if (!total) throw new Error('cycanime 周表 7 天全空');
    return { source: 'cycanime', days };
}

async function fetchAniListWeek() {
    // 取「今天 0 点往前 12 小时 ~ 7 天后 18 点」的放送表，覆盖跨午夜播出
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 18, 0, 0);
    const query = `
    query ($from:Int,$to:Int){
      Page(page:1,perPage:80){
        airingSchedules(airingAt_greater:$from, airingAt_lesser:$to, sort:TIME){
          episode airingAt
          media{ id coverImage{large} title{ native romaji userPreferred } format isAdult }
        }
      }
    }`;
    const r = await fetch(ANILIST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { from: Math.floor(start.getTime() / 1000), to: Math.floor(end.getTime() / 1000) } }),
        signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`AniList HTTP ${r.status}`);
    const body = await r.json();
    const rows = body?.data?.Page?.airingSchedules || [];
    // 中文名增强（拉不到就是空 Map，静默退化）
    const nameMap = await getBangumiNameMap();
    const bdataZh = await getBdataTitleZh();
    let zhHits = 0;
    // 组装 8 天（昨天中午起的语义上仍是「今天~未来7天」为主），按自然日分组
    const byDay = new Map();
    for (const s of rows) {
        const media = s.media || {};
        if (media.isAdult) continue; // 时间表只放全龄段（里番库有自己的入口）
        const d = new Date(s.airingAt * 1000);
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (!byDay.has(key)) byDay.set(key, []);
        // 标题优先级（round54）：Bangumi 中文名 → 原名(日文) → userPreferred → romaji。
        // AniList 的 userPreferred 多为罗马音（英文观感），放最后兜底。
        const t = media.title || {};
        let title = nameMap.get(normTitle(t.native)) || nameMap.get(normTitle(t.romaji)) || nameMap.get(normTitle(t.userPreferred)) || '';
        if (!title) title = bdataZh.get(normTitle(t.native)) || bdataZh.get(normTitle(t.romaji)) || bdataZh.get(normTitle(t.userPreferred)) || '';
        if (title) zhHits++;
        else title = t.native || t.userPreferred || t.romaji || '(未命名)';
        byDay.get(key).push({
            title,
            episode: s.episode,
            airingAt: s.airingAt * 1000,
            cover: media.coverImage?.large || '',
            source: 'anilist',
            anilistId: media.id,
        });
    }
    // 输出今天起的 7 天
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const items = (byDay.get(key) || []).sort((a, b) => a.airingAt - b.airingAt);
        days.push({
            date: key,
            label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEK_CN[d.getDay()]}${i === 0 ? ' · 今天' : ''}`,
            items,
        });
    }
    return { source: 'anilist', zh: zhHits, days };
}

/** Bangumi 备源（apiBase 可配镜像；失败静默返回 null） */
async function fetchBangumiWeek() {
    const apiBase = (config.sources?.bangumi?.apiBase || 'https://api.bgm.tv').replace(/\/$/, '');
    try {
        const r = await fetch(apiBase + '/calendar', {
            headers: { 'User-Agent': 'CinemaVault/1.0 (local app)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const week = await r.json();
        if (!Array.isArray(week) || !week.length) return null;
        // Bangumi calendar 是「周几」数组，映射到未来 7 天
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            const wd = d.getDay() === 0 ? 6 : d.getDay() - 1; // bangumi 周一=0
            const day = week[wd] || { items: [] };
            days.push({
                date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
                label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEK_CN[d.getDay()]}${i === 0 ? ' · 今天' : ''}`,
                items: (day.items || []).slice(0, 30).map((s) => ({
                    title: s.name_cn || s.name,
                    episode: null,
                    airingAt: null,
                    cover: (s.images && (s.images.large || s.images.common)) || '',
                    source: 'bangumi',
                    bangumiId: s.id,
                })),
            });
        }
        return { source: 'bangumi', days };
    } catch (e) {
        return null;
    }
}

async function getCalendar(force = false) {
    if (!force && CACHE.data && Date.now() - CACHE.at < TTL) return CACHE.data;
    // round56 数据链：cycanime（中文完整，主源）→ AniList(+Bangumi/bdata 映射) → Bangumi
    let data = null;
    try {
        data = await fetchCycanimeWeek();
    } catch (e) {
        data = null;
    }
    if (!data) {
        try {
            data = await fetchAniListWeek();
        } catch (e) {
            data = null;
        }
    }
    if (!data) data = await fetchBangumiWeek(); // 备源
    if (!data) throw new Error('放送时间表数据源均不可达（cycanime / AniList / Bangumi）');
    CACHE.at = Date.now();
    CACHE.data = data;
    return data;
}

module.exports = { getCalendar };
