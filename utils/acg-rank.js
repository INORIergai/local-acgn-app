// ================================================================
// utils/acg-rank.js —— ACG 热度榜数据层（round33）
//
// 两个来源，都是「服务端渲染 / 公开接口直接给结构化 JSON」，无需登录：
//   1) acghub.net/leaderboard —— Next.js SSR，页面里内嵌 __next_f 流，
//      其中有一段 `{"initialBoard":{...items:[{rank,title,score,heat,cover,tags}]}}`。
//      站无 X-Frame-Options / CSP ⇒ 可整页内嵌，但这里仍自建渲染（统一外观）。
//   2) fankuhub.com/api/v1/anime/ranking —— 免参数直接返回 JSON：
//      {data:[{id,titleZh,titleJa,coverUrl,heat,voteCount,aggregateScore,...}]}
//      ★ 该站页面有 `X-Frame-Options: DENY` + `frame-ancestors 'none'` ⇒ 不能内嵌，
//        只能走这个接口 + 自建渲染。
//
// 封面图直连 200（两个 CDN 都不校验 referer），但为统一走本机缓存、避免跨站
// 直连拖慢，这里提供 cover 代理：GET /api/acg/cover?u=<url>，落 cache/acg-cover/。
//
// 缓存策略：内存 + 落盘（runtime/cache/acg-rank.json），默认 TTL 10 分钟；
// 抓取失败时回退到上次成功缓存（不抛错，只把 stale=true 透传出去）。
// ================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { request } = require('./updater');

// 复用 updater 的 UA（若无则兜底）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function runtimeDir() {
    // 与 utils/db.js 等一致：优先 %APPDATA%\CinemaVault\runtime，否则项目根
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'CinemaVault', 'runtime');
    }
    return path.join(__dirname, '..');
}

const CACHE_FILE = path.join(runtimeDir(), 'cache', 'acg-rank.json');
const COVER_DIR = path.join(runtimeDir(), 'cache', 'acg-cover');

let memCache = null;      // { acghub: {...}, fankuhub: {...} }
let memCacheAt = 0;

function now() { return Date.now(); }

function readCache() {
    try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const d = JSON.parse(raw);
        if (d && d.data && d.at) return d;
    } catch (e) { /* 忽略 */ }
    return null;
}

function writeCache(data) {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ data, at: now() }, null, 2), 'utf8');
    } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- acghub

function extractAcghubBoard(html) {
    // 页面把数据打进 __next_f.push([1,"..."]) 里。数据是「JS 字符串字面量」形态，
    // 经过了转义：双引号写成 \"，反斜杠写成 \\（即源码里看到 \\\" 这种三层）。
    //
    // 最稳的办法：不手写括号配平，而是：
    //   1) 找到 initialBoard 之后的第一个 '{'（数据对象起点）；
    //   2) 把它当作一个「JS 字符串字面量的后半截」，用 JSON.parse('"' + seg + '"')
    //      让解析器一次性、正确地处理所有转义 —— 前提是 seg 里没有裸露的 " 和 \。
    //   3) 问题：seg 的终点未知。所以先做一次「跳转义」的括号配平找终点，
    //      但转义规则要对齐：\\ 表示一个反斜杠，\" 表示一个引号，都占两字符。
    const anchor = 'initialBoard';
    const idx = html.indexOf(anchor);
    if (idx < 0) return null;
    const start = html.indexOf('{', idx);
    if (start < 0) return null;

    // 括号配平：正确理解「字符串字面量」语义。
    // seg 里每个 " 前面都带 \（转义），所以「进入/退出字符串」的判定是：
    //   遇到 \" 这一对 → 切换 inStr 状态；其余字符按 inStr 决定是否算结构。
    // blurhash 等字段里有裸的 [ ] { } # 等字符，绝不能当成结构括号。
    let depth = 0, end = -1;
    let inStr = false;
    for (let i = start; i < html.length; i++) {
        const c = html[i];
        if (c === '\\') {
            // 转义序列：\ 后面紧跟的那个字符（最常见是 "）属于字符串内容
            if (html[i + 1] === '"') { inStr = !inStr; }  // \" 切换字符串状态
            i++;        // 跳过被转义的字符本身
            continue;
        }
        if (inStr) continue;   // 字符串内部的字符一律不算结构
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return null;

    const seg = html.slice(start, end + 1);
    // seg 是「JS 字符串字面量」形态（双引号写成 \"，见 charCode 92,34）。
    // 用 JSON.parse('"' + seg + '"') 一次性正确还原所有转义，得到纯 JSON 字符串，
    // 再 JSON.parse 一次得到对象。
    try {
        const decoded = JSON.parse('"' + seg + '"');
        return JSON.parse(decoded);
    } catch (e) {
        return null;
    }
}

function normalizeAcghub(items) {
    return (items || []).slice(0, 30).map((it) => ({
        source: 'acghub',
        rank: it.rank || 0,
        title: it.title || '',
        id: it.id || it.slug || '',
        scope: it.scope || '',
        score: typeof it.score === 'number' ? Number(it.score.toFixed(1)) : null,
        heat: typeof it.heat === 'number' ? it.heat : 0,
        tags: (it.tags || []).map(t => t.name).filter(Boolean).slice(0, 4),
        cover: (it.cover && (it.cover.thumb_url || it.cover.preview_url || it.cover.url)) || '',
        url: it.id ? ('https://acghub.net/' + (it.scope === 'anime' ? 'anime/' : it.scope ? it.scope + '/' : '') + (it.slug || it.id)) : 'https://acghub.net/leaderboard',
    }));
}

// ---------------------------------------------------------------- fankuhub

function normalizeFanku(list) {
    return (list || []).slice(0, 30).map((it, i) => ({
        source: 'fankuhub',
        rank: i + 1,
        title: it.titleZh || it.titleJa || it.titleRomaji || it.titleEn || '',
        titleAlt: (it.titleJa && it.titleJa !== (it.titleZh || '')) ? it.titleJa : '',
        id: it.id || '',
        scope: 'anime',
        type: it.type || '',
        status: it.status || '',
        score: typeof it.aggregateScore === 'number' ? Number(it.aggregateScore.toFixed(1)) : null,
        heat: typeof it.heat === 'number' ? it.heat : 0,
        voteCount: it.voteCount || 0,
        airDate: it.airDate || '',
        season: it.season || '',
        tags: [],
        cover: it.coverUrl || '',
        url: it.id ? ('https://fankuhub.com/anime/' + it.id) : 'https://fankuhub.com/trending',
    }));
}

// ---------------------------------------------------------------- 抓取

async function fetchAcghub() {
    const html = await request('https://acghub.net/leaderboard', {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        timeout: 25000,
    }, false, null).then(r => {
        if (typeof r === 'string') return r;
        // request 的文本分支会把 body 拼好返回；这里兼容对象返回
        if (r && r.body) return r.body;
        throw new Error('acghub 返回格式异常');
    });
    const board = extractAcghubBoard(html);
    if (!board || !Array.isArray(board.items)) {
        throw new Error('acghub 榜单结构未识别');
    }
    return {
        source: 'acghub',
        updated_at: board.updated_at || null,
        items: normalizeAcghub(board.items),
    };
}

async function fetchFankuhub() {
    const raw = await request('https://fankuhub.com/api/v1/anime/ranking', {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://fankuhub.com/trending' },
        timeout: 25000,
    }, false, null).then(r => {
        if (typeof r === 'string') return r;
        if (r && r.body) return r.body;
        throw new Error('fankuhub 返回格式异常');
    });
    let j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('fankuhub 响应不是 JSON'); }
    if (!j || !Array.isArray(j.data)) throw new Error('fankuhub 榜单结构未识别');
    return { source: 'fankuhub', updated_at: now(), items: normalizeFanku(j.data) };
}

// ---------------------------------------------------------------- 对外

const TTL = 10 * 60 * 1000; // 10 分钟

async function getRank(source, opts = {}) {
    const force = opts.force === true;
    const fresh = memCache && memCache[source] && (now() - memCacheAt < TTL);

    if (!force && fresh) {
        return { ...memCache[source], cached: true, stale: false };
    }

    // 落盘缓存作为回退
    const disk = readCache();
    const diskData = disk && disk.data && disk.data[source] ? disk.data[source] : null;

    try {
        const fetched = source === 'acghub' ? await fetchAcghub() : await fetchFankuhub();
        memCache = memCache || {};
        memCache[source] = fetched;
        memCacheAt = now();
        // 合并写盘：保留另一个来源的缓存
        const all = (disk && disk.data) || {};
        all[source] = fetched;
        writeCache(all);
        return { ...fetched, cached: false, stale: false };
    } catch (e) {
        // 回退：内存 → 磁盘
        if (memCache && memCache[source]) {
            return { ...memCache[source], cached: true, stale: true, error: e.message };
        }
        if (diskData) {
            return { ...diskData, cached: true, stale: true, error: e.message };
        }
        throw e;
    }
}

async function getBoth(opts = {}) {
    const out = {};
    const errors = {};
    await Promise.allSettled(['acghub', 'fankuhub'].map(async (s) => {
        try { out[s] = await getRank(s, opts); }
        catch (e) { errors[s] = e.message; }
    }));
    return { data: out, errors };
}

// ---------------------------------------------------------------- 详情（round34 批次B）

/**
 * fankuhub 详情：官方 API GET /api/v1/anime/{id}
 * 返回 {success:true,data:{...titleZh,titleJa,synopsis,staff:[],characters:[],...}}
 */
async function fetchFankuDetail(id) {
    if (!id) throw new Error('缺少 id');
    const raw = await request('https://fankuhub.com/api/v1/anime/' + encodeURIComponent(id), {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://fankuhub.com/trending' },
        timeout: 25000,
    }, false, null).then(r => (typeof r === 'string' ? r : (r && r.body) || ''));
    const j = JSON.parse(raw);
    if (!j || !j.data) throw new Error('番库详情结构未识别');
    const d = j.data;
    return {
        source: 'fankuhub',
        id,
        title: d.titleZh || d.titleJa || d.titleEn || '',
        titleAlt: [d.titleJa, d.titleEn, d.titleRomaji].filter(Boolean).filter(t => t !== (d.titleZh || '')).slice(0, 2),
        cover: d.coverUrl || '',
        score: typeof d.aggregateScore === 'number' ? Number(d.aggregateScore.toFixed(1)) : null,
        heat: d.heat || 0,
        voteCount: d.voteCount || 0,
        airDate: d.airDate || '',
        status: d.status || '',
        synopsis: (d.synopsis || '').replace(/\\n/g, '\n').trim(),
        genres: (d.genres || []).map(g => g.nameZh || g.name || g).filter(Boolean).slice(0, 8),
        staff: (d.staff || []).slice(0, 6).map(s => s.nameCn || s.name || '').filter(Boolean),
        studios: (d.studios || d.production || []).map(s => s.nameCn || s.name || '').filter(Boolean).slice(0, 4),
        external: {
            bangumi: d.bangumiId || null,
            mal: d.malId || null,
            anilist: d.anilistId || null,
        },
    };
}

/**
 * acghub 详情：爬详情页 SSR。页面里有两份数据：
 *   1) JSON-LD（application/ld+json，明文单层转义）：name/description/startDate/genre/aggregateRating/image
 *   2) __next_f 深层数据（三层转义，成本高）
 * 用 JSON-LD（官方 schema.org 结构化数据，比翻 __next_f 稳）。
 */
async function fetchAcghubDetail(id, scope) {
    if (!id) throw new Error('缺少 id');
    // 榜单条目的 id 形如 "anime-chou-kaguya-hime"（scope 前缀已内嵌），
    // 详情页真实路径是 /anime/chou-kaguya-hime —— 从 id 里剥掉 scope 前缀当 slug。
    let slug = id;
    const prefix = (scope || '') + '-';
    if (scope && slug.startsWith(prefix)) slug = slug.slice(prefix.length);
    const pathSeg = scope === 'anime' ? 'anime/' : scope ? scope + '/' : '';
    const url = 'https://acghub.net/' + pathSeg + slug;
    const html = await request(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        timeout: 25000,
    }, false, null).then(r => (typeof r === 'string' ? r : (r && r.body) || ''));
    if (!html) throw new Error('详情页为空');

    // ① JSON-LD：页面有多个块（站点级 WebSite/Organization + 作品级，作品级可能是数组）。
    //    挑「作品级」的：有 name 且带 aggregateRating / genre / startDate 之一。
    let ld = null;
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const isWorkLd = (o) => o && o.name && (o.aggregateRating || o.genre || o.startDate || o.description);
    for (const b of blocks) {
        try {
            const parsed = JSON.parse(b[1]);
            const cands = Array.isArray(parsed) ? parsed : [parsed];
            for (const o of cands) {
                if (isWorkLd(o) && (o.aggregateRating || o.genre)) { ld = o; break; }
            }
        } catch (e) { /* 下一块 */ }
        if (ld) break;
    }
    // ② 兜底：直接找 startDate/genre 联合出现的单层转义 JSON 片段
    if (!ld) {
        const i = html.indexOf('startDate');
        if (i >= 0) {
            const start = html.lastIndexOf('{', i);
            let depth = 0, end = -1;
            for (let k = start; k < html.length; k++) {
                const c = html[k];
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
                else if (c === '"') { k++; while (k < html.length && html[k] !== '"') { if (html[k] === '\\') k++; k++; } }
            }
            if (end > 0) {
                try { ld = JSON.parse(html.slice(start, end + 1)); } catch (e) { ld = null; }
            }
        }
    }
    if (!ld) throw new Error('acghub 详情结构未识别');

    const rating = ld.aggregateRating || {};
    return {
        source: 'acghub',
        id,
        scope: scope || 'anime',
        title: ld.name || '',
        titleAlt: [],
        cover: (typeof ld.image === 'string' ? ld.image : (Array.isArray(ld.image) ? ld.image[0] : '')) || '',
        score: typeof rating.ratingValue === 'number' ? Number(rating.ratingValue.toFixed(1)) : null,
        heat: 0,
        voteCount: rating.ratingCount || rating.voteCount || 0,
        airDate: ld.startDate || ld.datePublished || '',
        status: '',
        synopsis: (ld.description || '').trim(),
        genres: (ld.genre || []).slice(0, 8),
        staff: [],
        studios: [],
        external: {},
        detailUrl: url,
    };
}

// ---------------------------------------------------------------- 封面代理

function coverPathFor(url) {
    const h = crypto.createHash('md5').update(url).digest('hex');
    const ext = (url.match(/\.(webp|png|jpe?g|gif)(\?|$)/i) || [])[1] || 'img';
    return path.join(COVER_DIR, h + '.' + ext);
}

async function getCover(url) {
    if (!url) return null;
    const fp = coverPathFor(url);
    if (fs.existsSync(fp)) {
        const buf = fs.readFileSync(fp);
        if (buf.length > 0) return { path: fp, bytes: buf };
    }
    // 抓取图片（request 支持 stream 但这里直接拿 text 会错，用 binary 分支）
    const r = await request(url, {
        headers: { 'User-Agent': UA, 'Accept': 'image/*' },
        timeout: 25000,
    }, true);
    // request(stream=true) 返回 { status, headers, stream }，需要读流
    return await new Promise((resolve, reject) => {
        const chunks = [];
        r.stream.on('data', c => chunks.push(c));
        r.stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length === 0) return reject(new Error('封面为空'));
            try {
                fs.mkdirSync(COVER_DIR, { recursive: true });
                fs.writeFileSync(fp, buf);
            } catch (e) { /* 忽略写盘失败，仍返回字节 */ }
            resolve({ path: fp, bytes: buf });
        });
        r.stream.on('error', reject);
    });
}

module.exports = { getRank, getBoth, getCover, TTL, fetchFankuDetail, fetchAcghubDetail };
