/* 作品标题结构化匹配（浏览器 + Node 共用，无依赖）。
 * 目的：区分“同一部作品的季度/特别篇”和“标题里恰好包含关键词的另一部作品”，
 * 给搜索候选、换源线路和自动换源提供统一、可解释的评分。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TitleMatch = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    /* 常见繁简差异；只做标题比对用，不改写用户输入或源站标题。 */
    const TRAD = {
        進: '进', 擊: '击', 劍: '剑', 術: '术', 師: '师', 會: '会', 長: '长', 門: '门',
        陽: '阳', 學: '学', 園: '园', 戀: '恋', 愛: '爱', 戰: '战', 記: '记', 錄: '录',
        動: '动', 畫: '画', 劇: '剧', 場: '场', 終: '终', 極: '极', 異: '异', 國: '国',
        語: '语', 聲: '声', 優: '优', 傳: '传', 說: '说', 這: '这', 個: '个', 與: '与',
        為: '为', 來: '来', 時: '时', 間: '间', 還: '还', 開: '开', 關: '关', 發: '发',
        現: '现', 實: '实', 驗: '验', 貝: '贝', 爾: '尔', 賽: '赛', 亞: '亚', 歐: '欧',
        隊: '队', 員: '员', 團: '团', 結: '结', 節: '节', 續: '续', 總: '总', 週: '周',
        號: '号', 萬: '万', 億: '亿', 龍: '龙', 鳳: '凤', 獸: '兽', 靈: '灵', 闇: '暗',
        鬥: '斗', 覇: '霸', 槍: '枪', 騎: '骑', 孫: '孙', 鳴: '鸣', 者: '者', 忍: '忍',
        廻: '回', 蓮: '莲', 響: '响', 無: '无', 雙: '双', 緣: '缘', 夢: '梦', 謎: '谜'
    };
    const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

    const SEASONS = [
        { re: /第\s*([0-9零〇一二三四五六七八九十两]+)\s*[季期]/, kind: 'season' },
        { re: /(?:season|s)\s*([0-9]+)(?![a-z0-9])/i, kind: 'season' },
        { re: /([0-9]+)(?:st|nd|rd|th)\s*season/i, kind: 'season' },
        { re: /第\s*([0-9零〇一二三四五六七八九十两]+)\s*部分?/, kind: 'part' },
        { re: /part\s*([0-9]+)(?![a-z0-9])/i, kind: 'part' },
        { re: /最终季|最終季|final\s*season/i, kind: 'final' }
    ];
    const SPECIALS = [
        { re: /劇場版|剧场版|电影版|the\s*movie/i, kind: 'movie', label: '剧场版' },
        { re: /\bova\b/i, kind: 'ova', label: 'OVA' },
        { re: /\boad\b/i, kind: 'oad', label: 'OAD' },
        { re: /特别篇|特別篇|特别版|特別版|specials?(?![a-z])/i, kind: 'special', label: '特别篇' },
        { re: /\bsp(?![a-z])/i, kind: 'special', label: 'SP' },
        { re: /番外篇?/i, kind: 'extra', label: '番外篇' },
        { re: /总集篇|總集篇|recap(?![a-z])/i, kind: 'recap', label: '总集篇' },
        { re: /短篇|short(?![a-z])/i, kind: 'short', label: '短篇' }
    ];
    const NOISE = /(?:2160p|1080p|1080i|720p|480p|4k|8k|blu-?ray|bdrip|bd|web-?dl|webrip|hdtv|hevc|avc|x26[45]|h26[45]|aac|flac|国语版|国配版|粤语版|日配版|中配版|国语|国配|粤语|日配|中字|简中|繁中|字幕|高清|蓝光|无修|未删减|合集|全集|完结|连载|更新至|tv版|tv)(?![a-z])/gi;
    const YEAR = /(?:19|20)\d{2}/;

    function globalize(re) {
        return new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    }
    function cnNum(raw) {
        const s = String(raw || '').trim();
        if (/^\d+$/.test(s)) return Number(s);
        if (!s) return null;
        if (s === '十') return 10;
        if (s.includes('十')) {
            const [a, b] = s.split('十');
            return ((a ? (CN_NUM[a] || 0) : 1) * 10) + (b ? (CN_NUM[b] || 0) : 0);
        }
        return CN_NUM[s] == null ? null : CN_NUM[s];
    }
    function findSeason(raw) {
        for (const item of SEASONS) {
            const m = item.re.exec(raw);
            if (!m) continue;
            if (item.kind === 'final') return { num: 'final', kind: 'final', raw: m[0] };
            const n = cnNum(m[1]);
            if (n == null) continue;
            return { num: n, kind: item.kind, raw: m[0] };
        }
        return null;
    }
    function findSpecial(raw) {
        for (const item of SPECIALS) {
            const m = item.re.exec(raw);
            if (m) return { kind: item.kind, label: item.label, raw: m[0] };
        }
        return null;
    }
    function removeTokens(raw) {
        let s = String(raw || '');
        for (const item of SEASONS) s = s.replace(globalize(item.re), ' ');
        for (const item of SPECIALS) s = s.replace(globalize(item.re), ' ');
        s = s.replace(globalize(YEAR), ' ');
        s = s.replace(NOISE, ' ');
        return s;
    }
    function stripBrackets(raw) {
        return String(raw || '').replace(/[\[【(（]([^\[\]【】()（）]*)[\]】)）]/g, (all, inner) => {
            const t = String(inner || '').trim();
            if (!t) return ' ';
            const rest = removeTokens(t).replace(/[^\p{L}\p{N}]/gu, '');
            return rest ? ' ' + t + ' ' : ' ';
        });
    }
    function normalizeKey(raw) {
        let s = String(raw || '').toLowerCase();
        s = s.replace(/[^\p{L}\p{N}]+/gu, '');
        return s.replace(/./gu, (ch) => TRAD[ch] || ch);
    }
    function parse(title) {
        const raw = String(title || '').normalize('NFKC').trim();
        const season = findSeason(raw);
        const special = findSpecial(raw);
        const ym = raw.match(YEAR);
        let base = stripBrackets(raw);
        base = removeTokens(base);
        base = base.replace(/[\[【(（][^\]】)）]*[\]】)）]/g, ' ');
        return {
            raw,
            base: normalizeKey(base),
            season: season ? season.num : null,
            seasonKind: season ? season.kind : '',
            special: special ? special.kind : null,
            specialLabel: special ? special.label : '',
            year: ym ? Number(ym[0]) : null
        };
    }
    function bigrams(s) {
        if (!s) return [];
        if (s.length < 2) return [s];
        const out = [];
        for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
        return out;
    }
    function similarity(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        const A = bigrams(a);
        const B = bigrams(b);
        const counts = new Map();
        for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
        let hit = 0;
        for (const g of B) {
            const n = counts.get(g) || 0;
            if (n) { hit++; counts.set(g, n - 1); }
        }
        return (2 * hit) / (A.length + B.length);
    }
    function seasonLabel(season) {
        return season === 'final' ? '最终季' : `第${season}季`;
    }
    function score(queryTitle, candidateTitle) {
        const q = parse(queryTitle);
        const c = parse(candidateTitle);
        const sim = similarity(q.base, c.base);
        let s = 15 + (sim * 60);
        let reason = '标题相关度低';
        let seasonMismatch = false;
        let specialMismatch = false;

        if (q.base && c.base && q.base === c.base) {
            s = 94;
            reason = '标题一致';
        } else if (q.base && c.base && (q.base.includes(c.base) || c.base.includes(q.base))) {
            const cov = Math.min(q.base.length, c.base.length) / Math.max(q.base.length, c.base.length);
            s = Math.max(s, 58 + (30 * cov));
            reason = '标题包含';
        } else if (sim >= 0.88) {
            s = Math.max(s, 84 + (8 * sim));
            reason = '标题接近';
        }

        if (q.season != null || c.season != null) {
            if (q.season != null && c.season != null && String(q.season) === String(c.season)) {
                s += 4;
            } else if (q.season == null) {
                s -= 26;
                seasonMismatch = true;
                reason = `候选是${seasonLabel(c.season)}`;
            } else if (c.season == null) {
                s -= 18;
                seasonMismatch = true;
                reason = '候选未标季度';
            } else {
                s -= 44;
                seasonMismatch = true;
                reason = `候选是${seasonLabel(c.season)}，查询要${seasonLabel(q.season)}`;
            }
        }
        if (q.special != null || c.special != null) {
            if (q.special != null && c.special != null && q.special === c.special) {
                s += 2;
                reason = c.specialLabel || '特别篇';
            } else if (q.special == null) {
                s -= 42;
                specialMismatch = true;
                reason = `候选是${c.specialLabel}`;
            } else if (c.special == null) {
                s -= 32;
                specialMismatch = true;
                reason = '候选不是特别篇';
            } else {
                s -= 35;
                specialMismatch = true;
                reason = `候选是${c.specialLabel}`;
            }
        }
        if (q.year && c.year) s += q.year === c.year ? 4 : -10;
        if (/国配|国语|粤语/.test(c.raw) && !/国配|国语|粤语/.test(q.raw)) {
            s -= 5;
            reason = reason + '（配音版）';
        }

        const value = Math.max(1, Math.min(99, Math.round(s)));
        let level = 'other';
        if (seasonMismatch) level = 'season';
        else if (specialMismatch) level = 'special';
        else if (q.base === c.base && q.base) level = 'exact';
        else if (sim >= 0.82) level = 'same';
        else if (sim >= 0.55) level = 'near';
        return { score: value, level, reason, baseSimilarity: sim, seasonMismatch, specialMismatch };
    }
    function lineKey(sourceId, url) {
        return String(sourceId || '') + '|' + String(url || '');
    }
    function rank(queryTitle, candidates, opts = {}) {
        const minSimilarity = opts.minSimilarity == null ? 0.5 : opts.minSimilarity;
        const minScore = opts.minScore == null ? 0 : opts.minScore;
        const exclude = opts.excludeKeys || null;
        const failed = opts.failedKeys || null;
        const seen = new Set();
        const out = [];
        for (const item of (candidates || [])) {
            const name = String(item.name || item.title || '').trim();
            if (!name) continue;
            const key = lineKey(item.sourceId || item.source || '', item.url || item.workUrl || '');
            if (exclude && exclude.has(key)) continue;
            if (failed && failed.has(key)) continue;
            if (seen.has(key)) continue;
            const match = score(queryTitle, name);
            if (match.baseSimilarity < minSimilarity) continue;
            if (match.score < minScore) continue;
            if (opts.strict && !(match.level === 'exact' || match.level === 'same')) continue;
            if (opts.strict && match.score < 72) continue;
            seen.add(key);
            out.push(Object.assign({}, item, { match }));
        }
        out.sort((a, b) => (b.match.score - a.match.score)
            || ((a.tier == null ? 9 : a.tier) - (b.tier == null ? 9 : b.tier))
            || String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
        return out;
    }
    function pick(queryTitle, candidates, opts = {}) {
        const ranked = rank(queryTitle, candidates, opts);
        const best = ranked[0] || null;
        const runnerUp = ranked[1] || null;
        return {
            best,
            runnerUp,
            ranked,
            ambiguous: !!(best && runnerUp && (best.match.score - runnerUp.match.score) < 6)
        };
    }

    // 从章节名里取完整章号（避免「第 1 话」误命中「第 11 话」的 includes 问题）
    function chapterNo(name) {
        const m = String(name || '').match(/(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:[话話章卷回集])/);
        return m ? Number(m[1]) : null;
    }
    function pickChapter(chapters, name) {
        const list = Array.isArray(chapters) ? chapters : [];
        const want = String(name || '').replace(/\s+/g, ' ').trim();
        if (!want) return -1;
        const exact = list.findIndex((c) => String((c && c.name) || '').replace(/\s+/g, ' ').trim() === want);
        if (exact >= 0) return exact;
        const n = chapterNo(want);
        if (n == null) return -1;
        return list.findIndex((c) => chapterNo(c && c.name) === n);
    }

    return { parse, similarity, score, rank, pick, lineKey, seasonLabel, chapterNo, pickChapter };
});