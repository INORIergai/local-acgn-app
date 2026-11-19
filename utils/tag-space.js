/**
 * utils/tag-space.js —— round168 · 标签「思维空间」联想引擎
 *
 * 三种关系，合成一张图：
 *   1) 名称关系（语义）：NFKC → 繁转简 → 日文新字体归一 → 数字/量词归一 → 去标点
 *      再比：完全相同 / 包含 / 编辑距离 / 人工同义表
 *   2) 结构关系（共现）：同一批作品上同时出现的两个标签 ⇒ 天然相邻
 *   3) 成员关系（集合）：两个标签挂的影片集合高度重叠 ⇒ 极可能是同一个标签
 *
 * 为什么不用向量/大模型：241 个标签、4629 条关系的规模下，规则可解释、可复现、
 * 零外部依赖，而且每一条候选都能给用户一个「为什么建议合并」的理由。
 */

const { toSimplified } = require('./fuzzy-search');

/* ★ 必须懒加载 db：否则只调 normalizeTagName 也会把库连接拖进来，
 *   离线索算（离线测试 / 纯函数单测）就没法跑。 */
let _db = null;
function dbm() {
    if (!_db) _db = require('./db');
    return _db;
}

/* 日文新字体 → 中文繁体/标准字形（本库实测出现过的字，宁少勿滥） */
const JA_VARIANT = {
    '単': '單', '顔': '顏', '黒': '黑', '沢': '澤', '広': '廣', '恋': '戀',
    '竜': '龍', '浜': '濱', '県': '縣', '鉄': '鐵', '桜': '櫻', '辺': '邊',
    '楽': '樂', '売': '賣', '絵': '繪', '児': '兒', '闘': '鬥', '髪': '髮'
};

/* 量词/后缀同义归一（本库实测：4小時以上作品 / 4時間以上作品 / 16時間以上作品） */
const UNIT_RULES = [
    [/小時|時間|小时|时间/g, '时长'],
    [/以上/g, '+'],
    [/作品|作/g, ''],
    [/全集|合集|総集編|总集编|ベスト/g, '合集']
];

function normalizeTagName(raw) {
    let s = String(raw == null ? '' : raw).normalize('NFKC');
    s = toSimplified(s);                       // 繁 → 简（OpenCC 3221 字表）
    s = s.replace(/[単顔黒沢広恋竜浜県鉄桜辺楽売絵児闘髪]/g, c => JA_VARIANT[c] || c);
    s = toSimplified(s);                       // 日文新字体可能又落回繁体，再转一次
    s = s.toLowerCase();
    for (const [re, rep] of UNIT_RULES) s = s.replace(re, rep);
    // 只保留字母/数字/汉字/假名
    s = s.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9]/gu, '');
    return s;
}

/** Levenshtein（只算到阈值就早退，避免大表全量 O(n*m)） */
function levenshtein(a, b, cap = 4) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > cap) return cap + 1;
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

/** 名称相似度 0~1 + 理由 + 关系类型（identical | contain | edit） */
function nameSimilarity(nameA, nameB) {
    const a = normalizeTagName(nameA);
    const b = normalizeTagName(nameB);
    if (!a || !b) return { score: 0, reason: '', kind: '' };
    if (a === b) return { score: 1, reason: '归一后完全同名', kind: 'identical' };

    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= 2 && long.includes(short)) {
        return { score: 0.9, reason: `一方包含另一方（${short} ⊂ ${long}）`, kind: 'contain' };
    }
    const d = levenshtein(a, b, 3);
    if (d <= 3) {
        const score = 1 - d / Math.max(a.length, b.length);
        if (score >= 0.72) return { score: +score.toFixed(3), reason: `字形近似（编辑距离 ${d}）`, kind: 'edit' };
    }
    return { score: 0, reason: '', kind: '' };
}

/** 名称关系边：给思维空间图用（阈值 0.72，避免糊成一团） */
function nameEdges(tags) {
    const out = [];
    for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
            const r = nameSimilarity(tags[i].name, tags[j].name);
            if (r.score >= 0.72) out.push({ a: tags[i].id, b: tags[j].id, w: r.score, reason: r.reason });
        }
    }
    return out;
}

/** 共现索引：Map<tagId, Map<otherId, co>> */
function coIndex(lib, minCo = 1) {
    const idx = new Map();
    let pairs = [];
    try {
        pairs = dbm().getTagCooccurrence(lib, minCo);
    } catch (e) {
        pairs = [];
    }
    for (const { a, b, co } of pairs) {
        if (!idx.has(a)) idx.set(a, new Map());
        if (!idx.has(b)) idx.set(b, new Map());
        idx.get(a).set(b, co);
        idx.get(b).set(a, co);
    }
    return idx;
}

/** 某标签的「自动联想」：共现优先，名称相似兜底 */
function relatedTags(tagId, lib, limit = 10) {
    // ★ 用库作用域内的标签（不是全库）：否则「漫画库」的联想会混进 AV 标签
    const all = lib ? dbm().getTagsByLib(lib) : dbm().getAllTags.all();
    const byId = new Map(all.map(t => [t.id, t]));
    const self = byId.get(tagId);
    if (!self) return [];

    const idx = coIndex(lib, 1);
    const mine = idx.get(tagId) || new Map();
    const rows = [];

    for (const [otherId, co] of mine) {
        const t = byId.get(otherId);
        if (!t) continue;
        const jac = co / (self.movieCount + t.movieCount - co || 1);
        rows.push({
            id: t.id, name: t.name, n: t.movieCount,
            score: +(jac * 0.85 + 0.15).toFixed(3),
            reason: `共同出现 ${co} 部作品（Jaccard ${jac.toFixed(2)}）`,
            kind: 'co'
        });
    }
    // 名称相似兜底（没有共现的标签也能被联想出来，这正是「思维空间」的意义）
    for (const t of all) {
        if (t.id === tagId || mine.has(t.id)) continue;
        const r = nameSimilarity(self.name, t.name);
        if (r.score >= 0.72) {
            rows.push({ id: t.id, name: t.name, n: t.movieCount, score: +(r.score * 0.9).toFixed(3), reason: r.reason, kind: 'name' });
        }
    }
    rows.sort((x, y) => y.score - x.score);
    return rows.slice(0, limit);
}

/**
 * 合并候选：名称关系 + 成员关系（两标签挂的影片集合高度重叠）
 * 返回 [{ a, b, score, confidence, reasons[], basis, suggestedKeep }]
 *
 * ★置信度分级（很重要）：nameSimilarity 的「包含关系」在这份数据里既有真重复
 *   （潮吹 / 潮吹き、アナル / アナルセックス），也有语义不同的上下位概念
 *   （按摩 / 按摩棒、學校作品 / 學校泳裝）。前者能自动合，后者合了就是毁数据。
 *   ⇒ high  = 归一后完全同名 / 成员集合几乎完全重叠（可默认勾选）
 *     mid  = 一方包含另一方（需人工确认）
 *     low  = 仅字形近似（只做提醒，不预选）
 */
function mergeCandidates(tags, minScore = 0.62, lib = null) {
    const out = [];
    const seen = new Map();
    const keyOf = (a, b) => (a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`);
    const rank = { low: 0, mid: 1, high: 2 };

    const push = (a, b, score, reason, basis, confidence) => {
        if (a.id === b.id) return;
        if (!(a.movieCount > 0) || !(b.movieCount > 0)) return; // 幽灵标签走「清理」，不参与合并
        const k = keyOf(a, b);
        if (seen.has(k)) {
            const cur = seen.get(k);
            if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
            cur.score = Math.max(cur.score, +score.toFixed(3));
            cur.basis = cur.basis.includes(basis) ? cur.basis : cur.basis + '+' + basis;
            if (rank[confidence] > rank[cur.confidence]) cur.confidence = confidence;
            return;
        }
        const item = {
            a: { id: a.id, name: a.name, n: a.movieCount || 0 },
            b: { id: b.id, name: b.name, n: b.movieCount || 0 },
            score: +score.toFixed(3),
            confidence,
            reasons: [reason],
            basis
        };
        seen.set(k, item);
        out.push(item);
    };

    // 1) 名称关系
    for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
            const r = nameSimilarity(tags[i].name, tags[j].name);
            if (r.score < minScore) continue;
            const conf = r.kind === 'identical' ? 'high' : (r.kind === 'contain' ? 'mid' : 'low');
            push(tags[i], tags[j], r.score, r.reason, 'name', conf);
        }
    }

    // 2) 成员关系：Jaccard ≥ 0.75 基本就是同一个标签被录了两次
    let idx = new Map();
    try { idx = coIndex(lib, 1); } catch (e) { }
    const byId = new Map(tags.map(t => [t.id, t]));
    for (const [aId, others] of idx) {
        const a = byId.get(aId);
        if (!a) continue;
        for (const [bId, co] of others) {
            const b = byId.get(bId);
            if (!b || aId >= bId) continue;
            const jac = co / (a.movieCount + b.movieCount - co || 1);
            /* ★★ 成员关系不能只看 Jaccard —— 大标签之间天然重叠：
             *   实测「高画质(506) ↔ 单体作品(451)」Jaccard 0.82、「ハイビジョン(39) ↔ 独占配信(34)」0.87，
             *   它们语义毫无关系，只是覆盖面都很大（或一个是另一个的子集）。
             *   真重复必须是「集合几乎相等」：Jaccard ≥ 0.9、两边规模差 ≤25%，
             *   且大标签（>100 部）要更严格（≥0.97）才放进候选。
             *   另外成员关系一律只给 mid —— 不自动勾选，交给人判断。 */
            const sizeRatio = Math.abs(a.movieCount - b.movieCount) / Math.max(a.movieCount, b.movieCount);
            const isBig = Math.max(a.movieCount, b.movieCount) > 100;
            if (co >= 3 && Math.min(a.movieCount, b.movieCount) >= 2 &&
                jac >= 0.9 && sizeRatio <= 0.25 && !(isBig && jac < 0.97)) {
                push(a, b, +(0.8 + jac * 0.2).toFixed(3),
                    `成员几乎完全重叠（Jaccard ${jac.toFixed(2)}，共同 ${co} 部）`,
                    'membership', 'mid');
            }
        }
    }

    // 谁的影片多留谁（合并方向建议），同数量留名字短的
    for (const c of out) {
        const pickA = c.a.n > c.b.n || (c.a.n === c.b.n && c.a.name.length <= c.b.name.length);
        c.suggestedKeep = pickA ? c.a.id : c.b.id;
    }
    out.sort((x, y) => {
        const rr = rank[y.confidence] - rank[x.confidence];
        return rr !== 0 ? rr : y.score - x.score;
    });
    return out;
}

module.exports = {
    normalizeTagName,
    nameSimilarity,
    nameEdges,
    relatedTags,
    mergeCandidates,
    levenshtein,
    coIndex
};