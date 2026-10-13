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
// round42：封面高清化 —— thumb_url 是 le225 缩略图（糊），preview_url 是 le900 大图
        cover: (it.cover && (it.cover.url || it.cover.preview_url || it.cover.thumb_url)) || '',
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
// round42：封面高清化 —— 榜单接口只给 small.webp(~12KB 糊图)，
        // CDN 同路径存在 detail.webp(~146KB 大图)，换文件名即可（实测 200）
        cover: (it.coverUrl || '').replace(/\/small\.webp(\?|$)/, '/detail.webp$1'),
        url: it.id ? ('https://fankuhub.com/anime/' + it.id) : 'https://fankuhub.com/trending',
    }));
}

// ---------------------------------------------------------------- AniList 周期榜（round42）
// 上游 acghub/fankuhub 都不支持日/周/月/年切换（实测参数被忽略）。
// 周榜=现有双源（周聚合热度）；日/月/年用 AniList GraphQL（免鉴权、封面 extraLarge 高清）：
//   日榜 = TRENDING_DESC（实时趋势）
//   月榜 = 本季 POPULARITY_DESC（≈近月热度）
//   年榜 = 近一年开播 POPULARITY_DESC（年度累计）

const ANILIST_EP = 'https://graphql.anilist.co';

const ANILIST_FIELDS = `
  id
  title { romaji english native }
  coverImage { extraLarge large }
  averageScore
  popularity
  genres
  startDate { year month day }
  format
  status
  siteUrl
  description(asHtml: false)
`;

function anilistQueryFor(period, cat) {
    /* v1.3 四类榜：cat = anime | manga | novel
     *   manga = AniList type:MANGA（含单行本）；novel = type:MANGA + format:NOVEL（轻小说）
     *   日榜 = TRENDING_DESC；月榜 = 本季 POPULARITY；年榜 = 全站 POPULARITY
     *   （周榜是双源聚合的专属能力，漫画/小说侧由前端隐藏周 tab） */
    cat = cat || 'anime';
    const head = cat === 'manga' ? 'type:MANGA'
        : cat === 'novel' ? 'type:MANGA,format:NOVEL'
        : 'type:ANIME';
    if (period === 'day') {
        return `query { Page(page:1,perPage:30){ media(${head},sort:TRENDING_DESC,isAdult:false){ ${ANILIST_FIELDS} } } }`;
    }
    if (period === 'month') {
        const y = new Date().getFullYear();
        const m = new Date().getMonth() + 1;
        const season = m <= 3 ? 'WINTER' : m <= 6 ? 'SPRING' : m <= 9 ? 'SUMMER' : 'FALL';
        return `query { Page(page:1,perPage:30){ media(${head},sort:POPULARITY_DESC,isAdult:false,season:${season},seasonYear:${y}){ ${ANILIST_FIELDS} } } }`;
    }
    // year：全站累计人气（startDate_greater 时间戳过滤在 AniList 上实测恒返回 0，弃用）
    return `query { Page(page:1,perPage:30){ media(${head},sort:POPULARITY_DESC,isAdult:false){ ${ANILIST_FIELDS} } } }`;
}

// AniList 强制 POST（GET 返回 404 "Use POST request"）—— request() 已支持 opts.body
async function anilistQuery(query, variables) {
    let j = null;
    try {
        const r = await request(ANILIST_EP, {
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            timeout: 25000,
            method: 'POST',
            body: JSON.stringify(variables ? { query, variables } : { query }),
        }, false, null);
        const raw = typeof r === 'string' ? r : (r && r.body) || '';
        j = JSON.parse(raw);
    } catch (e) {
        // 代理路径失败 → 直连重试
        j = await anilistQueryDirect(query, variables).catch(() => null);
        if (!j) throw new Error('AniList 响应不是 JSON');
    }
    // round46：代理出口被 AniList 静默风控（返回 data.Page.media:[] 空池不报错）→ 直连重试
    const pool = j && j.data && j.data.Page && j.data.Page.media;
    if (Array.isArray(pool) && !pool.length && !j.errors) {
        const jd = await anilistQueryDirect(query, variables).catch(() => null);
        const poolD = jd && jd.data && jd.data.Page && jd.data.Page.media;
        if (Array.isArray(poolD) && poolD.length) j = jd;
    }
    if (j.errors && j.errors.length) throw new Error('AniList: ' + (j.errors[0].message || '查询失败'));
    return j;
}

/* r46：AniList 直连（不走应用代理）——代理出口被风控返回空池时的降级通道 */
async function anilistQueryDirect(query, variables) {
    const resp = await fetch(ANILIST_EP, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(variables ? { query, variables } : { query }),
        signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) throw new Error('AniList 直连 HTTP ' + resp.status);
    return resp.json();
}

async function fetchAnilistBoard(period, cat) {
    cat = cat || 'anime';
    const j = await anilistQuery(anilistQueryFor(period, cat));
    const list = j && j.data && j.data.Page && Array.isArray(j.data.Page.media) ? j.data.Page.media : null;
    if (!list) throw new Error('AniList 榜单结构未识别');
    const items = anilistItemsFrom(list, cat);
    // round46：Bangumi 中文名 localize —— 原名（日文）最易命中；anime=书type2，manga/novel=书type1
    try { await localizeTitles(items, [cat === 'anime' ? 2 : 1]); } catch (e) { /* 失败保留原名 */ }
    return { source: 'anilist', cat, period, updated_at: now(), items };
}

/* AniList 条目 → 榜单条目（fetchAnilistBoard / fetchAnilistPopBoard 共用） */
function anilistItemsFrom(list, cat) {
    const items = list.map((m, i) => ({
        source: 'anilist',
        cat,
        rank: i + 1,
        title: (m.title && (m.title.english || m.title.romaji || m.title.native)) || '',
        titleAlt: (m.title && [m.title.native, m.title.romaji].filter(Boolean).filter(t => t !== ((m.title.english || m.title.romaji || m.title.native) || ''))) || [],
        id: String(m.id || ''),
        scope: cat,
        type: m.format || '',
        status: m.status || '',
        score: typeof m.averageScore === 'number' ? Number((m.averageScore / 10).toFixed(1)) : null,
        heat: typeof m.popularity === 'number' ? m.popularity : 0,
        voteCount: 0,
        airDate: m.startDate && m.startDate.year
            ? `${m.startDate.year}-${String(m.startDate.month || 1).padStart(2, '0')}-${String(m.startDate.day || 1).padStart(2, '0')}`
            : '',
        season: '',
        tags: (m.genres || []).slice(0, 4),
        cover: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '',
        url: m.siteUrl || ('https://anilist.co/' + (cat === 'anime' ? 'anime' : 'manga') + '/' + m.id),
    }));
    items.forEach((it, i) => {
        it.key = 'anilist:' + cat + ':' + it.id;
        const m = list[i] || {};
        it.__searchTitle = (m.title && (m.title.native || m.title.romaji || m.title.english)) || it.title;
    });
    return items;
}

/* round46：漫画/小说人气/高分榜（AniList POPULARITY 大池）。
 * 之前用 TRENDING（日）+season（月/年）：实测漫画 TRENDING+isAdult:false 经常空、
 * season 过滤对漫画天然为空 —— 全部弃用。改为 POPULARITY_DESC 拉 50 条：
 *   人气榜 = 按热度前 30；高分榜 = 池内按评分排序前 30（带 Bangumi 中文名）。 */
async function fetchAnilistPopBoard(cat, mode) {
    const head = cat === 'novel' ? 'type:MANGA,format:NOVEL' : 'type:MANGA';
    const q = `query { Page(page:1,perPage:50){ media(${head},sort:POPULARITY_DESC,isAdult:false){ ${ANILIST_FIELDS} } } }`;
    const j = await anilistQuery(q);
    const list = j && j.data && j.data.Page && Array.isArray(j.data.Page.media) ? j.data.Page.media : null;
    if (!list) throw new Error('AniList 榜单结构未识别');
    if (!list.length) throw new Error('AniList 漫画/小说池为空（上游瞬时抖动，勿缓存）');
    let items = anilistItemsFrom(list, cat);
    try { await localizeTitles(items, [1]); } catch (e) { /* 失败保留原名 */ }
    if (mode === 'score') {
        items = items.filter(it => it.score != null).sort((a, b) => b.score - a.score).slice(0, 30);
        // r46：残缺响应（代理风控裁剪 averageScore）会过滤成空——抛错防缓存空榜
        if (!items.length) throw new Error('漫画/小说池无评分数据（上游响应异常，勿缓存）');
    } else {
        items = items.slice(0, 30);
    }
    items.forEach((it, i) => { it.rank = i + 1; });
    return { source: 'anilist', cat, sort: mode, updated_at: now(), items };
}

async function fetchAnilistDetail(id, cat) {
    if (!id) throw new Error('缺少 id');
    cat = cat || 'anime';
    const type = cat === 'anime' ? 'ANIME' : 'MANGA';
    const novelArg = cat === 'novel' ? ', format: NOVEL' : '';
    const j = await anilistQuery(
        `query($id:Int){ Media(id:$id,type:${type}${novelArg}){ ${ANILIST_FIELDS} studios(isMain:true){ nodes{ name } } } }`,
        { id: Number(id) || 0 }
    );
    const m = j && j.data && j.data.Media;
    if (!m) throw new Error('AniList 详情结构未识别');
    return {
        source: 'anilist',
        id: String(m.id),
        scope: cat,
        title: (m.title && (m.title.english || m.title.romaji || m.title.native)) || '',
        titleAlt: (m.title && [m.title.native, m.title.romaji].filter(Boolean).filter(t => t !== ((m.title.english || m.title.romaji || m.title.native) || ''))) || [],
        cover: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '',
        score: typeof m.averageScore === 'number' ? Number((m.averageScore / 10).toFixed(1)) : null,
        heat: typeof m.popularity === 'number' ? m.popularity : 0,
        voteCount: 0,
        airDate: m.startDate && m.startDate.year
            ? `${m.startDate.year}-${String(m.startDate.month || 1).padStart(2, '0')}-${String(m.startDate.day || 1).padStart(2, '0')}`
            : '',
        status: m.status || '',
        synopsis: (m.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
        genres: (m.genres || []).slice(0, 8),
        staff: [],
        studios: (m.studios && m.studios.nodes || []).map(s => s.name).filter(Boolean).slice(0, 4),
        external: { anilist: m.id },
        detailUrl: m.siteUrl || '',
    };
}

// ---------------------------------------------------------------- VNDB galgame 榜（v1.3 四类榜）
// kana API：POST https://api.vndb.org/kana/vn，免鉴权；sort=rating/votecount 实测可用。
// rating 是 10~100（已 ×10），取数时 /10 归一到十分制。
// kana 要求 UA 里带应用标识，规范起见带上产品名+版本。

const VNDB_EP = 'https://api.vndb.org/kana/vn';
const VNDB_UA = 'CinemaVault/1.3 (local personal media library)';
const VNDB_FIELDS = 'title, alttitle, titles{lang,title}, image{url}, rating, votecount, released, length_minutes, description, tags{name,rating}, developers{name}';

async function vndbQuery(payload) {
    const r = await request(VNDB_EP, {
        headers: { 'User-Agent': VNDB_UA, 'Content-Type': 'application/json' },
        timeout: 25000,
        method: 'POST',
        body: JSON.stringify(payload),
    }, false, null);
    const raw = typeof r === 'string' ? r : (r && r.body) || '';
    let j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('VNDB 响应不是 JSON'); }
    if (j.error || (j.errors && j.errors.length)) throw new Error('VNDB: ' + ((j.error && j.error.message) || j.errors[0].message || '查询失败'));
    return j;
}

function normalizeVndb(v, i) {
    const titles = v.titles || [];
    const zh = titles.find(t => t.lang === 'zh-Hans') || titles.find(t => t.lang === 'zh') || null;
    const title = (zh && zh.title) || v.alttitle || v.title || '';
    const titleAlt = [v.title, v.alttitle].filter(Boolean).filter(t => t !== title).slice(0, 2);
    return {
        source: 'vndb',
        rank: i + 1,
        title,
        titleAlt,
        id: v.id || '',
        scope: 'gal',
        type: '',
        status: v.released && v.released > String(new Date().toISOString().slice(0, 10)) ? '未发售' : '',
        score: typeof v.rating === 'number' ? Number((v.rating / 10).toFixed(1)) : null,
        heat: v.votecount || 0,
        voteCount: v.votecount || 0,
        airDate: v.released || '',
        season: '',
        tags: (v.tags || []).slice(0, 4).map(t => t.name).filter(Boolean),
        cover: (v.image && v.image.url) || '',
        url: v.id ? ('https://vndb.org/' + v.id) : 'https://vndb.org',
    };
}

/* 高分榜(sort=rating) / 人气榜(sort=votecount)。取两页共 ~200 条：
 * 前 30 直接当榜，200 条整池留给「每日推荐」做按日轮换。 */
async function fetchVndbBoard(sort) {
    const by = sort === 'votes' ? 'votecount' : 'rating';
    const raw = [];
    for (let p = 1; p <= 2; p++) {
        const j = await vndbQuery({ filters: [], fields: VNDB_FIELDS, sort: by, reverse: true, results: 100, page: p });
        (j.results || []).forEach(v => raw.push(v));
        if (!j.more) break;
    }
    if (!raw.length) throw new Error('VNDB 榜单结构未识别');
    const items = raw.map(normalizeVndb);
    // round46：VNDB 自带 zh-Hans 标题覆盖率有限 → Bangumi localize 补中文
    items.forEach((it, i) => {
        it.key = 'vndb:' + (raw[i] && raw[i].id || it.id);
        it.__searchTitle = (raw[i] && raw[i].title) || it.title;
    });
    try { await localizeTitles(items, [4]); } catch (e) { /* 失败保留原名 */ }
    return {
        source: 'vndb',
        sort: by,
        updated_at: now(),
        items,
    };
}

/* VNDB 详情：按 id 精确取（filters ["id","=",id]） */
async function fetchVndbDetail(id) {
    if (!id) throw new Error('缺少 id');
    const j = await vndbQuery({ filters: ['id', '=', String(id)], fields: VNDB_FIELDS });
    const v = j && j.results && j.results[0];
    if (!v) throw new Error('VNDB 详情结构未识别');
    // 轻度清洗 VNDB bbcode：[url=x]y[/url] → y，[spoiler] 块直接剥壳
    const desc = String(v.description || '')
        .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '$2')
        .replace(/\[(\/?)(spoiler|b|i|u|s|quote)\]/gi, '')
        .trim();
    const n = normalizeVndb(v, 0);
    return {
        source: 'vndb',
        id: n.id,
        scope: 'gal',
        title: n.title,
        titleAlt: n.titleAlt,
        cover: n.cover,
        score: n.score,
        heat: n.heat,
        voteCount: n.voteCount,
        airDate: n.airDate,
        status: n.status,
        synopsis: desc,
        genres: n.tags,
        staff: [],
        studios: (v.developers || []).map(d => d.name).filter(Boolean).slice(0, 4),
        lengthMinutes: v.length_minutes || 0,
        external: { vndb: n.id },
        detailUrl: n.url,
    };
}

// ---------------------------------------------------------------- Bangumi 中文名 localize（round46）
// 用户反馈：漫画/小说/gal 榜全是英文名、外链也是英文站。方案：
//   列表引擎保留 AniList / VNDB（榜单稳、封面好），每条目按「日文原名」搜 Bangumi
//   （api.bgm.tv，name_cn 是官方中文译名），命中即换中文标题 + bgm.tv 中文链接。
//   命中结果落盘 runtime/cache/bgm-title-map.json —— 一次成本，长期复用。
// ★ Bangumi 必须 UA 标识应用，且只能走应用代理（直连超时）；tag 过滤字段是单数 tag。

const BGM_EP = 'https://api.bgm.tv';
const BGM_UA = 'CinemaVault/1.3 (local personal media library)';
const BGM_MAP_FILE = path.join(runtimeDir(), 'cache', 'bgm-title-map.json');
let bgmMap = null;
let bgmMapSaveTimer = null;

function bgmMapLoad() {
    if (bgmMap) return bgmMap;
    try { bgmMap = JSON.parse(fs.readFileSync(BGM_MAP_FILE, 'utf8')) || {}; } catch (e) { bgmMap = {}; }
    return bgmMap;
}

function bgmMapQueueSave() {
    if (bgmMapSaveTimer) return;
    bgmMapSaveTimer = setTimeout(() => {
        bgmMapSaveTimer = null;
        try {
            fs.mkdirSync(path.dirname(BGM_MAP_FILE), { recursive: true });
            fs.writeFileSync(BGM_MAP_FILE, JSON.stringify(bgmMap || {}), 'utf8');
        } catch (e) { /* 忽略 */ }
    }, 1500);
    if (bgmMapSaveTimer.unref) bgmMapSaveTimer.unref();
}

async function bgmSearchOne(keyword, types) {
    const r = await request(BGM_EP + '/v0/search/subjects', {
        headers: { 'User-Agent': BGM_UA, 'Content-Type': 'application/json' },
        timeout: 20000,
        method: 'POST',
        body: JSON.stringify({ keyword: String(keyword || '').slice(0, 80), filter: { type: types }, sort: 'heat' }),
    }, false, null);
    const raw = typeof r === 'string' ? r : (r && r.body) || '';
    let j;
    try { j = JSON.parse(raw); } catch (e) { throw new Error('Bangumi 响应不是 JSON'); }
    const rows = (j && j.data) || [];
    if (!rows.length) return null;
    const s = rows[0];
    return {
        cn: (s.name_cn || '').trim(),
        bgmId: s.id,
        score: s.rating && typeof s.rating.score === 'number' ? Number(s.rating.score.toFixed(1)) : null,
        voteCount: (s.rating && s.rating.total) || 0,
    };
}

function applyBgmHit(it, hit) {
    if (!hit || !hit.cn) return;
    if (!it.__origTitle) it.__origTitle = it.title;
    it.title = hit.cn;
    it.titleAlt = [it.__origTitle].filter(t => t && t !== hit.cn).slice(0, 2);
    it.bgmId = hit.bgmId;
    it.url = 'https://bgm.tv/subject/' + hit.bgmId;
}

/* 批量 localize：先吃缓存（同步），缺的并发 4 路查 Bangumi，命中写盘。
 * items 里每个 it 需带 key（缓存键）与 __searchTitle（搜索用原名）。 */
async function localizeTitles(items, types) {
    const map = bgmMapLoad();
    items.forEach(it => {
        if (!it || it.__bgmChecked) return;
        const hit = map[it.key];
        if (hit && hit.cn) { applyBgmHit(it, hit); it.__bgmChecked = true; }
    });
    const todo = items.filter(it => it && !it.__bgmChecked);
    if (!todo.length) return;
    let active = 0;
    const queue = todo.slice();
    await new Promise((resolve) => {
        const next = () => {
            if (!queue.length && !active) return resolve();
            while (active < 4 && queue.length) {
                const it = queue.shift();
                active++;
                bgmSearchOne(it.__searchTitle || it.title, types)
                    .then(hit => {
                        it.__bgmChecked = true;
                        if (hit && hit.cn) {
                            applyBgmHit(it, hit);
                            map[it.key] = { cn: hit.cn, bgmId: hit.bgmId, kw: String(it.__searchTitle || '').slice(0, 80) };
                        }
                    })
                    .catch(() => { it.__bgmChecked = true; })
                    .finally(() => { active--; next(); });
            }
            if (!queue.length && !active) resolve();
        };
        next();
    });
    bgmMapQueueSave();
}

/* Bangumi 详情（中文简介）：GET /v0/subjects/{id} */
async function fetchBgmDetail(id) {
    if (!id) throw new Error('缺少 bgm id');
    const raw = await request(`${BGM_EP}/v0/subjects/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': BGM_UA, 'Accept': 'application/json' },
        timeout: 20000,
    }, false, null).then(r => (typeof r === 'string' ? r : (r && r.body) || ''));
    const s = JSON.parse(raw);
    if (!s || !s.id) throw new Error('Bangumi 详情结构未识别');
    const tags = (s.tags || []).map(t => t.name).filter(Boolean).slice(0, 6);
    return {
        source: 'bgm',
        id: String(s.id),
        scope: s.type === 4 ? 'gal' : s.type === 1 ? 'manga' : 'anime',
        title: s.name_cn || s.name || '',
        titleAlt: [s.name].filter(t => t && t !== (s.name_cn || s.name)).slice(0, 2),
        cover: (s.images && (s.images.large || s.images.common)) || '',
        score: s.rating && typeof s.rating.score === 'number' ? Number(s.rating.score.toFixed(1)) : null,
        heat: (s.collection && s.collection.total) || (s.rating && s.rating.total) || 0,
        voteCount: (s.rating && s.rating.total) || 0,
        airDate: s.date || '',
        status: '',
        synopsis: String(s.summary || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
        genres: tags,
        staff: [],
        studios: [],
        external: { bgm: s.id },
        detailUrl: 'https://bgm.tv/subject/' + s.id,
    };
}

// ---------------------------------------------------------------- Bangumi 书籍榜（round46，漫画/小说榜主源）
// AniList POPULARITY 池被上游风控（应用代理 + 直连均返回 200 但 media:[]，实测 5/5），
// bgm.tv 网页榜单子路径又触发 Cloudflare 质询（根路径可用但无分类过滤）。
// 最终方案：api.bgm.tv 搜索接口多 tag 拼池 —— 实测 tag:['少年漫画']+sort:heat 返回
//   链锯人/进击的巨人/航海王/死亡笔记，name_cn 直接是中文（无需 localize）。
//   人气榜 = 池子原序（heat）；高分榜 = 池内按 rating.score 排序前 30。
//   ★ 搜索每次恒返回 10 条（limit/offset 被忽略）—— 多 tag 各拿 10 条拼池去重。
const BGM_BOOK_TAGS = {
    manga: ['少年漫画', '青年漫画', '漫画单行本'],
    novel: ['轻小说', '電撃文庫', 'ライトノベル'],
};

async function bgmSearchByTag(tag) {
    const r = await request(BGM_EP + '/v0/search/subjects', {
        headers: { 'User-Agent': BGM_UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 20000,
        method: 'POST',
        body: JSON.stringify({ filter: { type: [1], tag: [tag] }, sort: 'heat' }),
    }, false, null);
    const raw = typeof r === 'string' ? r : (r && r.body) || '';
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.data)) throw new Error('Bangumi 搜索响应结构未识别');
    return j.data;
}

async function fetchBgmBrowserBoard(cat, mode) {
    const tags = BGM_BOOK_TAGS[cat] || BGM_BOOK_TAGS.manga;
    const results = await Promise.allSettled(tags.map((t, i) => (async () => {
        if (i) await new Promise(r => setTimeout(r, 800 * i));   // 防抖：错峰请求
        return bgmSearchByTag(t);
    })()));
    const seen = new Set();
    const pool = [];
    results.forEach((r) => {
        if (r.status !== 'fulfilled') return;
        r.value.forEach((s) => {
            if (!s || !s.id || seen.has(s.id)) return;
            seen.add(s.id);
            pool.push(s);
        });
    });
    if (!pool.length) throw new Error('Bangumi 书籍榜为空（全部 tag 搜索失败，勿缓存）');
    const items = pool.map((s, i) => ({
        source: 'bgm',
        cat,
        rank: i + 1,
        title: s.name_cn || s.name || '',
        titleAlt: [s.name].filter(t => t && t !== (s.name_cn || s.name)).slice(0, 2),
        id: String(s.id),
        scope: cat === 'novel' ? 'novel' : 'manga',
        type: '',
        status: '',
        score: s.rating && typeof s.rating.score === 'number' ? Number(s.rating.score.toFixed(1)) : null,
        heat: (s.collection && ((s.collection.wish || 0) + (s.collection.doing || 0) + (s.collection.collect || 0))) || 0,
        voteCount: (s.rating && s.rating.total) || 0,
        airDate: s.date || '',
        season: '',
        tags: (s.tags || []).map(t => t.name).filter(Boolean).slice(0, 4),
        cover: (s.images && (s.images.common || s.images.medium || s.images.large)) || '',
        url: 'https://bgm.tv/subject/' + s.id,
        __bgmRank: (s.rating && s.rating.rank) || null,
    }));
    if (mode === 'score') {
        items.sort((a, b) => (b.score != null ? b.score : -1) - (a.score != null ? a.score : -1));
    }
    items.slice(0, 30).forEach((it, i) => { it.rank = i + 1; });
    return { source: 'bgm', cat, sort: mode, updated_at: now(), items: items.slice(0, 30) };
}

// ---------------------------------------------------------------- CnGal 精选（round46，用户点名）
// https://www.cngal.org —— 中文 galgame 资料库。走开放 API（api.cngal.org，swagger 公开）：
//   精选榜 = GET /api/home/ListHotRecommends（中文名/中文简介/封面/词条链接）
//   详情   = GET /api/entries/GetEntryView/{id}
const CNGAL_EP = 'https://api.cngal.org';

async function fetchCngalHot() {
    const raw = await request(CNGAL_EP + '/api/home/ListHotRecommends', {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 20000,
    }, false, null).then(r => (typeof r === 'string' ? r : (r && r.body) || ''));
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) throw new Error('CnGal 榜单结构未识别');
    return {
        source: 'cngal',
        updated_at: now(),
        items: j.slice(0, 30).map((g, i) => {
            const id = (String(g.url || '').match(/entries\/index\/(\d+)/) || [])[1] || '';
            return {
                source: 'cngal',
                rank: i + 1,
                title: g.name || '',
                titleAlt: [],
                id,
                scope: 'gal',
                type: '',
                status: '',
                score: null,
                heat: 0,
                voteCount: 0,
                airDate: '',
                season: '',
                tags: [g.reason].filter(Boolean),
                cover: g.image || '',
                url: id ? ('https://www.cngal.org/entries/index/' + id) : 'https://www.cngal.org/',
            };
        }).filter(it => it.title),
    };
}

async function fetchCngalDetail(id) {
    if (!id) throw new Error('缺少 cngal id');
    const raw = await request(`${CNGAL_EP}/api/entries/GetEntryView/${encodeURIComponent(id)}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: 20000,
    }, false, null).then(r => (typeof r === 'string' ? r : (r && r.body) || ''));
    const d = JSON.parse(raw);
    if (!d || !d.name) throw new Error('CnGal 详情结构未识别');
    return {
        source: 'cngal',
        id: String(d.id || id),
        scope: 'gal',
        title: d.name || '',
        titleAlt: [d.anotherName].filter(Boolean).slice(0, 2),
        cover: d.mainPicture || d.thumbnail || '',
        score: null,
        heat: 0,
        voteCount: 0,
        airDate: '',
        status: '',
        synopsis: String(d.briefIntroduction || '').trim(),
        genres: [],
        staff: [],
        studios: (d.productionGroups || []).map(p => p.name).filter(Boolean).slice(0, 4),
        external: { cngal: d.id || id },
        detailUrl: 'https://www.cngal.org/entries/index/' + (d.id || id),
    };
}

/* galgame 每日推荐：从 VNDB 高分池（~200）按日期做确定性轮换，每天 12 款。
 * 同一天多次请求结果一致（不抖动），跨天自然换一批。 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function getGalDaily(opts = {}) {
    const force = opts.force === true;
    const day = new Date().toISOString().slice(0, 10);
    const fresh = memCache && memCache['gal-daily'] && memCache['gal-daily'].day === day && (now() - memCacheAt < TTL);
    if (!force && fresh) return { ...memCache['gal-daily'], cached: true, stale: false };

    const disk = readCache();
    const diskDaily = disk && disk.data && disk.data['gal-daily'] && disk.data['gal-daily'].day === day ? disk.data['gal-daily'] : null;
    try {
        const pool = await getRank('vndb:rating', { force });
        const items = (pool.items || []).slice();
        // round46：混入 CnGal 精选（中文 gal），best-effort —— 拉不到就只用 VNDB 池
        try {
            const cn = await getRank('cngal:hot', { force });
            (cn.items || []).forEach(it => { it.key = 'cngal:' + it.id; items.push(it); });
        } catch (e2) { /* 忽略 */ }
        const rnd = mulberry32(Number(day.replace(/-/g, '')) || 20260928);
        // Fisher-Yates 部分洗牌：取前 12 个不重复的
        const pick = [];
        const n = Math.min(12, items.length);
        for (let i = 0; i < n; i++) {
            const j = i + Math.floor(rnd() * (items.length - i));
            const t = items[i]; items[i] = items[j]; items[j] = t;
            pick.push({ ...items[i], rank: i + 1 });
        }
        const out = {
            source: 'vndb-daily',
            day,
            updated_at: now(),
            items: pick,
        };
        memCache = memCache || {};
        memCache['gal-daily'] = out;
        memCacheAt = now();
        const all = (disk && disk.data) || {};
        all['gal-daily'] = out;
        writeCache(all);
        return { ...out, cached: false, stale: false };
    } catch (e) {
        if (memCache && memCache['gal-daily']) return { ...memCache['gal-daily'], cached: true, stale: true, error: e.message };
        if (diskDaily) return { ...diskDaily, cached: true, stale: true, error: e.message };
        throw e;
    }
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
        // round42：source 支持 'anilist:day|month|year'（周榜仍是 acghub/fankuhub 双源）
        // v1.3：扩展 'anilist:{manga|novel}:{period}' 与 'vndb:{rating|votecount}'
        // round46：扩展 'cngal:hot'（CnGal 精选）；漫画/小说人气/高分榜 = 'anilistpop:{cat}:{heat|score}'；
        //         所有条目经 Bangumi 中文名 localize
        const fetched = source === 'acghub' ? await fetchAcghub()
            : source === 'fankuhub' ? await fetchFankuhub()
            : source === 'cngal:hot' ? await fetchCngalHot()
            : source.startsWith('bgmbook:') ? await (async () => {
                // r46：漫画/小说榜主源（Bangumi 书籍榜，AniList 被风控后的替代）
                const [cat, mode] = source.slice('bgmbook:'.length).split(':');
                return fetchBgmBrowserBoard(cat || 'manga', mode || 'heat');
            })()
            : source.startsWith('anilistpop:') ? await (async () => {
                const [cat, mode] = source.slice('anilistpop:'.length).split(':');
                return fetchAnilistPopBoard(cat || 'manga', mode || 'heat');
            })()
            : source.startsWith('vndb:') ? await fetchVndbBoard(source.slice('vndb:'.length))
            : source.startsWith('anilist:') ? await (async () => {
                const parts = source.slice('anilist:'.length).split(':');
                if (parts.length >= 2) return fetchAnilistBoard(parts[1], parts[0]);   // anilist:{cat}:{period}
                return fetchAnilistBoard(parts[0], 'anime');                            // anilist:{period}
            })()
            : await Promise.reject(new Error('未知榜单来源：' + source));
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

module.exports = { getRank, getBoth, getCover, TTL, fetchFankuDetail, fetchAcghubDetail, fetchAnilistBoard, fetchAnilistDetail, fetchAnilistPopBoard, fetchVndbBoard, fetchVndbDetail, fetchBgmDetail, fetchBgmBrowserBoard, fetchCngalHot, fetchCngalDetail, getGalDaily, localizeTitles };
