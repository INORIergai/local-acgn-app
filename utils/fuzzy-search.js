'use strict';
/* ===== round127 · 模糊搜索（标点 / 空格 / 全半角 / 繁简 均无关） =====
 * 用户原话：「搜索时输入的内容一定要连标点符号也要输入，不能进行模糊搜索」。
 * 根因：/api/movie/search 一直是 `title LIKE '%q%'`，而库里标题长这样——
 *   `[脸肿字幕组][ピンクパイナップル]PRETTY×CATION 2 THE ANIMATION ＃1 二人の休日[720p][x264_aac]`
 * 用户按常识打「PRETTY CATION 2」，因为多了个空格、少了 `×`，LIKE 一条都命中不了；
 * 反倒要把 `【】×＃～·-` 全部照抄才搜得到 —— 这不叫搜索，叫默写。
 *
 * 做法：查询词与标题走同一套归一化（NFKC 全半角折叠 → 小写 → 繁转简 → 只保留字母/数字/汉字/假名），
 * 再把查询按标点空格切成 token，要求**每个 token 都出现在同一字段里**（顺序不限）：
 *   `PRETTY CATION`  → ["pretty","cation"] → 命中 `PRETTY×CATION`
 *   `spy family`     → ["spy","family"]    → 命中 `SPY×FAMILY`
 *   `铃木 第四夜`    → 繁转简后命中 `鈴木みら乃 … 第四夜`
 * 一字未中时再退一步做「限距子序列」匹配（容忍漏字，如 pretycation ⊂ prettycation）。
 * 
 * 只做「放宽」，不做「收紧」：原来 LIKE 能搜到的，归一化后必然还能搜到。
 */
const { T2S_FULL } = require('./crawler/t2s-dict');   // OpenCC 繁→简 3221 字映射（crawler 已在用）

const KEEP = /[^\p{L}\p{N}]+/gu;

/** 繁转简：逐码点查表（比拼巨型正则安全，不会把代理对拆开） */
function toSimplified(str) {
    if (!str) return '';
    let out = '';
    for (const ch of str) {
        const s = T2S_FULL[ch];
        out += s || ch;
    }
    return out;
}

/** 归一化：NFKC（全角→半角、兼容字符折叠）→ 小写 → 繁转简 → 去掉一切非字母数字汉字假名的字符 */
function normalizeText(input) {
    return toSimplified(String(input == null ? '' : input).normalize('NFKC').toLowerCase())
        .replace(KEEP, '');
}

/** 查询词 → token 数组（标点/空格只当分隔符，不参与匹配） */
function queryTokens(query) {
    const norm = toSimplified(String(query == null ? '' : query).normalize('NFKC').toLowerCase());
    return norm.split(KEEP).filter(Boolean);
}

/**
 * 限距子序列：needle 的字符要按顺序出现在 hay 里，且两次命中之间最多隔 maxGap 个字符。
 * 不设距离上限的裸子序列会把「spy family」匹配到一段全平假名的标题上（实测踩过），
 * 那是噪音不是模糊。
 */
function windowedSubsequence(needle, hay, maxGap) {
    const n = needle.length;
    if (!n) return false;
    const gap = maxGap == null ? 2 : maxGap;
    for (let start = 0; start + n - 1 < hay.length + gap; start++) {
        if (hay[start] !== needle[0]) continue;
        let i = 1, j = start + 1, idle = 0;
        while (i < n) {
            if (j >= hay.length) break;
            if (hay[j] === needle[i]) { i++; idle = 0; }
            else if (++idle > gap) break;
            j++;
        }
        if (i === n) return true;
    }
    return false;
}

/* 单行参与匹配的字段（各自归一化，**不跨字段拼接**：拼起来会凭空造出跨栏假词） */
function fieldsOf(row) {
    return [row.title, row.originalTitle, row.fileName, row.avid, row.cleanName]
        .map(normalizeText)
        .filter(Boolean);
}

/* 归一化结果缓存：文本列变了才重算（2848 条全量约 20ms，缓存后基本为 0） */
const _cache = new Map();   // id → { sig, fields }

function fieldsCached(row) {
    const sig = [row.title, row.originalTitle, row.fileName, row.avid, row.cleanName].join('\u0001');
    const hit = _cache.get(row.id);
    if (hit && hit.sig === sig) return hit.fields;
    const fields = fieldsOf(row);
    if (_cache.size > 6000) _cache.clear();     // 库特别大时别当缓存垃圾场
    _cache.set(row.id, { sig, fields });
    return fields;
}

/**
 * 在候选行里做模糊筛选。
 * @param {Array} rows   至少含 id/title/originalTitle/fileName/avid/cleanName
 * @param {string} query 用户原始输入
 * @returns {Array} 命中的行（保持入参顺序）
 */
function fuzzyFilter(rows, query) {
    const toks = queryTokens(query);
    if (!toks.length) return [];            // 只打了标点/空格：不做全库返回
    const full = normalizeText(query);
    const exact = [];
    for (const row of rows) {
        const fields = fieldsCached(row);
        if (!fields.length) continue;
        if (toks.every(t => fields.some(f => f.includes(t)))) exact.push(row);
    }
    if (exact.length) return exact;
    /* 一级落空 → 限距子序列兜底。太短的词不做（噪音大于收益）。 */
    if (full.length < 4) return [];
    const loose = [];
    for (const row of rows) {
        const fields = fieldsCached(row);
        if (!fields.length) continue;
        if (toks.every(t => t.length >= 3 && fields.some(f => windowedSubsequence(t, f, 2)))) loose.push(row);
    }
    return loose;
}

module.exports = { normalizeText, queryTokens, toSimplified, windowedSubsequence, fuzzyFilter };
