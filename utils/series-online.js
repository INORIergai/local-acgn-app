/**
 * utils/series-online.js —— round185 追番在线源的「决策层」
 * ------------------------------------------------------------------
 * 把「搜全部源 → 选最优源 → 挂剧集」这套判断从 routes/series.js 里抽出来，
 * 好处是：① match-online（只看）和 auto-attach（直接挂）共用同一套打分，
 * 不会出现「弹窗推荐 A、一键挂载却挂了 B」的割裂；② 打分规则能单测。
 *
 * 设计取向（对齐 Animeko 的 MediaAutoSelector + Kazumi 的失败隔离）：
 *   · tier 是「源可信度」，数值越小越优先；但它不该压过标题匹配度 ——
 *     tier=0 的源搜出一部八竿子打不着的番，也不能自动挂。
 *   · 只有 score ≥ 0.55 才允许「自动」，否则一律交回给用户点选。
 *   · 冷却中的源直接跳过（连续 3 次 error/captcha，见 engine.noteFailure）。
 */
const engine = require('./media-sources/engine');

/** 固定并发池：避免一次把几十个源全打出去（见 searchAllWeb 的注释）。 */
async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            out[i] = await worker(items[i]);
        }
    }));
    return out;
}

// ==================================================================
// 标题匹配打分
// ==================================================================
/**
 * 标题归一化：全角→半角、小写、去括号内容、去季标记、去空白与标点。
 * 「冰之城墙 第二季」→「冰之城墙」，「【我推的孩子】」→「我推的孩子」。
 */
function normalizeTitle(s) {
    return String(s || '')
        .normalize('NFKC')
        .toLowerCase()
        // 圆括号/方括号里通常是注释（字幕组、画质、年份），整段丢
        .replace(/[（(][^）)]*[）)]/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        // ★【】不是注释而是标题装饰：「【我推的孩子】」必须保留内容，只去掉符号。
        //   早先把整个【...】当括号删掉，`【我推的孩子】` vs `我推的孩子` 直接算 0 分。
        .replace(/[【】]/g, '')
        .replace(/第\s*[一二三四五六七八九十百\d]+\s*[季期部篇]/g, ' ')
        .replace(/(?:season|part|cour)\s*\d+/gi, ' ')
        .replace(/(?:the\s+)?(?:final\s+season)/gi, ' ')
        .replace(/[\s\p{P}\p{S}]/gu, '')
        .trim();
}

function bigrams(s) {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
}

/** Sørensen–Dice 二元组相似度（对中文标题比编辑距离稳，短标题也不会乱给分） */
function diceCoeff(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const A = bigrams(a), B = bigrams(b);
    if (!A.length || !B.length) return 0;
    const pool = new Map();
    A.forEach((x) => pool.set(x, (pool.get(x) || 0) + 1));
    let hit = 0;
    B.forEach((x) => {
        const c = pool.get(x) || 0;
        if (c > 0) { hit++; pool.set(x, c - 1); }
    });
    return (2 * hit) / (A.length + B.length);
}

/** 取季号（「第二季」→2，「Season 3」→3，没有则空串） */
function seasonOf(s) {
    const t = String(s || '');
    const m = /第\s*([一二三四五六七八九十百\d]+)\s*[季期部]/.exec(t) || /(?:season|part|cour)\s*(\d+)/i.exec(t);
    if (!m) return '';
    const cn = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
    return cn[m[1]] || String(m[1]);
}

/** 候选标题 vs 目标标题，0~1。包含关系给高分（「冰之城墙 第二季」含「冰之城墙」） */
function titleScore(candidate, keyword) {
    const a = normalizeTitle(candidate);
    const b = normalizeTitle(keyword);
    if (!a || !b) return 0;
    let base;
    if (a === b) base = 1;
    else if (a.includes(b) || b.includes(a)) {
        // 长度差太大时降级：「冰之城墙」vs「冰之城墙外传剧场版特别篇」不该算 0.88
        const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
        base = 0.62 + 0.3 * ratio;
    } else base = diceCoeff(a, b);

    /* ★ 季号对齐：归一化会把「第二季」抹掉，于是「冰之城墙」和「冰之城墙第二季」同为 1.00。
     * 追第一季却自动挂到第二季，用户会看到完全不同的剧情 —— 季标记不一致必须降权。 */
    if (seasonOf(candidate) !== seasonOf(keyword)) base = Math.max(0, base - 0.12);
    return base;
}

// ==================================================================
// 并发搜索（match-online 与 auto-attach 共用）
// ==================================================================
const AUTO_THRESHOLD = 0.55;

/**
 * 并发搜全部 web 源。
 * @returns {{ hits, all, states, scanned, skipped }}
 *   hits   —— 有 item 的源（已按 tier 升序 + 最佳分数降序排好）
 *   all    —— 每个源的完整状态（含 noResult/captcha/error/cooling），给 UI 展示"为什么没有"
 *   states —— 各状态计数
 */
async function searchAllWeb(keyword, opts = {}) {
    const kw = String(keyword || '').trim();
    // 与 /api/media-source/search 一致：用缓存源列表。此前每次 force 重载会把
    // 22 份规则文件全部重解析（HTTP 高频调用时既慢又容易与其他请求互相干扰）。
    const web = engine.loadSources()
        .filter((x) => x.kind === 'web' && engine.isSourceEnabled(x.id));
    const force = opts.force === true;
    const timeout = opts.timeout || 12000;

    // 冷却中的源不请求，但仍进 all（UI 要能说明"它在冷却"）
    const runnable = [];
    const cooling = [];
    web.forEach((src) => {
        const cd = engine.cooldownOf(src.id);
        if (cd.cooling && !force) cooling.push({ src, cd });
        else runnable.push(src);
    });

    /* 池并发 6 —— 不能用 Promise.all 一次打 22 个源：
     * 实测全并发会把 undici 连接池和站点侧限流同时打爆，22 个源集体超时（success 0），
     * 而逐个/小并发时同一批源都能正常返回。与 /api/media-source/search 的并发策略保持一致。 */
    const settled = await pool(runnable, 6, async (src) => {
        try {
            const r = await engine.searchOn(src, kw, { timeout });
            const items = (r.items || []).slice(0, 20);
            const state = r.state || (items.length ? 'success' : 'noResult');
            if (state === 'success') engine.noteSuccess(src.id);
            else engine.noteFailure(src.id, state);
            const best = items.reduce((m, it) => Math.max(m, titleScore(it.name, kw)), 0);
            return { sourceId: src.id, sourceName: src.name, tier: src.tier, items,
                     error: r.error || '', state, bestScore: Math.round(best * 100) / 100 };
        } catch (e) {
            engine.noteFailure(src.id, 'error');
            return { sourceId: src.id, sourceName: src.name, tier: src.tier, items: [],
                     error: e.message, state: 'error', bestScore: 0 };
        }
    });

    const coolingRows = cooling.map(({ src, cd }) => ({
        sourceId: src.id, sourceName: src.name, tier: src.tier, items: [],
        error: `冷却中（${cd.reason === 'captcha' ? '需人机验证' : '连续失败'}，${Math.max(1, Math.ceil((cd.until - Date.now()) / 3600000))} 小时后重试）`,
        state: 'cooling', bestScore: 0
    }));

    const all = settled.concat(coolingRows);
    const hits = all.filter((x) => x.items.length > 0)
        .sort((a, b) => (b.bestScore - a.bestScore) || (a.tier - b.tier));

    const states = { success: 0, noResult: 0, error: 0, captcha: 0, cooling: 0 };
    all.forEach((x) => { if (states[x.state] != null) states[x.state]++; });

    return { hits, all, states, scanned: web.length, skipped: coolingRows.length };
}

// ==================================================================
// 自动选源
// ==================================================================
/**
 * 从搜索结果里挑一条最该挂的。
 * 规则：先够相似（≥0.55），再比分数；分数接近（差 ≤0.02）时 tier 小的赢。
 * tier ≤ 0 的源额外享受「同分优先」，但不允许越级压过明显更高的匹配。
 * @returns {{sourceId,sourceName,tier,detailUrl,name,score,reason}|null}
 */
function pickBest(hits, keyword) {
    let best = null;
    (hits || []).forEach((h) => {
        (h.items || []).forEach((it) => {
            const score = titleScore(it.name, keyword);
            const cand = {
                sourceId: h.sourceId, sourceName: h.sourceName, tier: h.tier,
                detailUrl: it.url, name: it.name, score: Math.round(score * 100) / 100
            };
            if (!best) { best = cand; return; }
            const eps = 0.02;
            if (cand.score > best.score + eps) { best = cand; return; }
            if (cand.score >= best.score - eps) {
                const candTier = Number(cand.tier) || 9;
                const bestTier = Number(best.tier) || 9;
                // 同分区间内：tier 小的优先；tier 相同时标题更短的优先（少一堆后缀噪声）
                if (candTier < bestTier ||
                    (candTier === bestTier && normalizeTitle(cand.name).length < normalizeTitle(best.name).length)) {
                    best = cand;
                }
            }
        });
    });
    if (!best || best.score < AUTO_THRESHOLD) return null;
    best.reason = best.score >= 0.95 ? '标题完全一致'
        : best.score >= 0.8 ? '标题高度相似'
        : '标题相近';
    return best;
}

// ==================================================================
// 一键挂载
// ==================================================================
/**
 * 搜源 → 选源 → 解析剧集 → 写入 episodes，一次到底。
 * 失败时**不抛异常**，把原因和候选带回去，前端可以降级成手动选源。
 */
async function autoAttach(seriesId, keyword, seasonNo, opts = {}) {
    const sdb = require('./series-db');
    const kw = String(keyword || '').trim();
    if (!seriesId || !kw) return { attached: 0, reason: '缺少番剧或关键词', hits: [] };

    const found = await searchAllWeb(kw, opts);
    if (!found.hits.length) {
        const why = found.states.captcha > 0
            ? `${found.states.captcha} 个源需要人机验证，其余 ${found.states.error} 个不可用 / ${found.states.noResult} 个无结果`
            : `扫了 ${found.scanned} 个源都没有结果（${found.states.error} 个不可用，${found.states.noResult} 个无匹配）`;
        return { attached: 0, reason: why, hits: [], states: found.states, scanned: found.scanned };
    }

    const pick = pickBest(found.hits, kw);
    if (!pick) {
        const top = found.hits[0];
        return {
            attached: 0,
            reason: `找到 ${found.hits.length} 个源，但没有标题足够接近的条目（最接近：${top.items[0] ? top.items[0].name : '—'}）`,
            hits: found.hits, states: found.states, scanned: found.scanned,
            nearest: top.items[0] ? top.items[0].name : ''
        };
    }

    const src = engine.getSource(pick.sourceId);
    if (!src) return { attached: 0, reason: '源已失效：' + pick.sourceId, hits: found.hits };

    const epRes = await engine.episodesOf(src, pick.detailUrl, { timeout: opts.episodeTimeout || 20000 });
    if (epRes.state && epRes.state !== 'success' && !(epRes.episodes || []).length) {
        engine.noteFailure(src.id, epRes.state === 'captcha' ? 'captcha' : 'error');
        return { attached: 0, reason: '剧集解析失败：' + (epRes.error || epRes.state),
                 hits: found.hits, pick, states: found.states };
    }

    const eps = (epRes.episodes || []).map((e, i) => {
        let no = Number(e.episodeNo != null ? e.episodeNo : (e.no != null ? e.no : e.sort));
        if (!no) {
            const m = /第\s*([\d.]+)\s*[话集]/.exec(String(e.name || ''));
            if (m) no = parseFloat(m[1]);
        }
        if (!no) no = i + 1;
        return { episodeNo: no, title: e.name || e.title || '', url: e.url || e.href || '' };
    }).filter((e) => e.episodeNo > 0 && e.url);

    if (!eps.length) {
        return { attached: 0, reason: `条目「${pick.name}」没解析出可用剧集`, hits: found.hits, pick, states: found.states };
    }

    const r = sdb.applyOnlineSource(seriesId, seasonNo || 1, pick.sourceId, src.name, eps);
    if (r.error) return { attached: 0, reason: r.error, hits: found.hits, pick, states: found.states };

    return {
        attached: r.updated, total: eps.length,
        sourceId: pick.sourceId, sourceName: src.name,
        detailUrl: pick.detailUrl, matchedName: pick.name,
        score: pick.score, auto: true, via: epRes.via || 'selector',
        states: found.states, hits: found.hits
    };
}

module.exports = {
    normalizeTitle,
    titleScore,
    searchAllWeb,
    pickBest,
    autoAttach,
    AUTO_THRESHOLD
};
