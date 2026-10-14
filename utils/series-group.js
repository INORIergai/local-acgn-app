/**
 * round75 · 系列名归一化与聚类（扫描时自动把同系列作品归到系列名下）
 *
 * 判定思路（用户要求：名字相似度 80% 以上算同一个系列）：
 *   1. 归一化：去扩展名 → 全角转半角/小写 → 去括号段（来源标签/汉化组）→
 *      去卷话标记（第X卷/vol.3/#5/番外12/尾随数字…）→ 压空白
 *      ★ 特例：文件名主体在括号里（如 "[Kmoe][平行天堂]番外00.epub"）——
 *        括号外剥完只剩卷号时，回退取最后一个非空括号段当标题
 *   2. 精确键分组（归一化后完全一致）
 *   3. 组间模糊合并：Levenshtein 相似度 ≥ 0.8，或前缀包含（短键 ≥5 字且是长键前缀）
 *   4. 系列名 = 该簇里出现最多的归一化键（通常是去掉卷号后的基名）
 *
 * 纯函数无副作用，扫描器 / 维护路由 / 一次性脚本都可调。
 */

const EXT_RE = /\.(kepub|epub|pdf|zip|cbz|cbr|rar|7z|mobi|azw3?|txt|mp4|mkv|avi|mov|wmv|ts|webm|flv|m2ts)$/i;

/** 全角→半角 + 小写 */
function widthFold(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
    else if (c === 0x3000) out += ' ';
    else out += ch;
  }
  return out.toLowerCase();
}

/** 拆出括号段与括号外主体。支持 [] 【】（）() 〔〕 {} 「」 */
function splitBrackets(s) {
  const pairs = { ']': '[', ')': '(', '】': '【', '）': '（', '〕': '〔', '}': '{', '」': '「' };
  const opens = new Set(Object.values(pairs));
  const segs = [];     // 括号段（含配对内容，按出现顺序）
  let cur = '', buf = '', depth = 0, openCh = '';
  for (const ch of s) {
    if (depth === 0 && opens.has(ch)) { depth = 1; openCh = ch; if (buf.trim()) cur += buf; buf = ''; continue; }
    if (depth > 0) {
      if (ch === openCh) depth++;
      else if (ch === pairs[openCh]) {
        depth--;
        if (depth === 0) { segs.push(buf); buf = ''; continue; }
      }
      buf += ch;
    } else cur += ch;
  }
  if (buf) cur += buf;
  return { outside: cur, brackets: segs };
}

/** 去卷话/序号标记（在归一化文本上跑） */
function stripVolumeTokens(s) {
  let out = s;
  const res = [
    /第\s*[0-9一二三四五六七八九十百千两]+\s*[卷话話集章季部册]/g,
    /(^|\s)[卷话話集]\s*[0-9]{1,3}$/g,                  // ★ kmoe 式「卷01」（无「第」字）
    /\b(vol|v|ch|c|volume|chapter|ep|episode)[.\s]*\d+\b/g,
    /#\d+/g,
    /[（(]\s*[0-9]{1,4}\s*[）)]$/g,                     // 尾部（01）
    /(^|\s)(番外|外传|外傳|特别篇|特別篇|sp|extra)(\s*[0-9]{1,4})?(\s|$)/g,
    /(?<=[\u4e00-\u9fff])[0-9]{1,4}([-–—][0-9.]{1,5})?$/g,   // ★ CJK 直连数字（本子6 / 本子1-2）
    /\s[0-9]{1,4}$/g,                                   // 尾随数字
    /\s[0-9]{1,4}\s*(完|end|终)$/g,
    /(全一卷|全1卷|完結|完结|\bend\b)$/g,
    /\s(上|中|下)(册|卷)?$/g,
    /\s(i{1,3}|iv|v|vi{1,3}|ix|x)\s*$/g,                // 尾部罗马数字
  ];
  for (const re of res) out = out.replace(re, ' ');
  // ★ 尾部括号组（(新增3.5和4.5) / （特典）…）逐层剥
  for (let i = 0; i < 3; i++) out = out.replace(/[（(][^（)）]*[）)]\s*$/, ' ');
  // ★ 尾部未闭合的 (（（库内 title 常残缺右括号）：从最后一个开括号起到结尾整体剥掉
  out = out.replace(/[（(][^（()）]*$/, ' ');
  return out.replace(/[\s~～·・—_\-:：,，.。]+/g, ' ').trim();
}

const CLOSE_CH = { ']': 1, ')': 1, '】': 1, '）': 1, '〕': 1, '}': 1, '」': 1 };

/**
 * 提取主体：闭括号不平衡时递归拆（库内 title 常被刮削残缺成 "kmoe][系列名]卷01"）
 */
function extractMain(s, depth) {
  if (depth > 3) return '';
  const parts = splitBrackets(s);
  const main = stripVolumeTokens(parts.outside);
  // 主体干净（够长且没有孤立闭括号）就直接用
  if (main.length >= 2 && !/[)\]」〕}]/.test(main)) return main;
  // 孤立闭括号：取最后一个闭括号，先试后面、再递归前面
  if (/[)\]」〕}]/.test(parts.outside)) {
    let m = -1;
    for (let i = parts.outside.length - 1; i >= 0; i--) {
      if (CLOSE_CH[parts.outside[i]]) { m = i; break; }
    }
    if (m >= 0) {
      const suffix = stripVolumeTokens(parts.outside.slice(m + 1));
      if (suffix.length >= 2 && !/[)\]」〕}]/.test(suffix)) return suffix;
      const r = extractMain(parts.outside.slice(0, m), depth + 1);
      if (r) return r;
    }
  }
  // 括号段兜底（来源标签在前、标题常在最后一个括号里）
  for (let i = parts.brackets.length - 1; i >= 0; i--) {
    const b = stripVolumeTokens(widthFold(parts.brackets[i]));
    if (b.length >= 2) return b;
  }
  return main;
}

/**
 * 从原始文件名/标题提取「系列基名」。
 * @returns {string} 空串表示提取失败
 */
function extractSeriesKey(raw) {
  let s = String(raw || '').trim().replace(EXT_RE, '');
  if (!s) return '';
  s = widthFold(s);
  const k = extractMain(s, 0);
  // ★ 纯卷号/通用序号不算系列名（防「卷01/卷02/卷03」跨作品互聚成假系列）
  if (!k || /^[卷话話集章回]\s*[0-9]{0,4}$/.test(k) || /^(vol|ch|c|v)[.\s]*\d+$/i.test(k)) return '';
  return k;
}

/** Levenshtein 距离（短串 DP，带长度差剪枝） */
function lev(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la || !lb) return Math.max(la, lb);
  if (Math.abs(la - lb) > Math.max(la, lb) * 0.45) return Math.max(la, lb) + 1;   // 剪枝：必 <0.55
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}

/** 相似度 0~1 */
function similarity(a, b) {
  if (a === b) return 1;
  const m = Math.max(a.length, b.length);
  if (!m) return 0;
  if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return 1;   // 前缀包含直接判同系列
  return 1 - lev(a, b) / m;
}

/**
 * 聚类。
 * @param {Array<{id:number, title:string}>} items
 * @param {{threshold?:number}} opt
 * @returns {Array<{key:string, name:string, ids:number[]}>} 只返回成员 ≥2 的系列
 */
function clusterSeries(items, opt) {
  const threshold = (opt && opt.threshold) || 0.8;
  // 1. 精确键分组
  const byKey = new Map();
  for (const it of items || []) {
    const key = extractSeriesKey(it.title);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it.id);
  }
  if (!byKey.size) return [];

  // 2. 组间模糊合并（大簇优先做基准）
  const keys = [...byKey.keys()].sort((a, b) => byKey.get(b).length - byKey.get(a).length);
  const clusters = [];   // [{key, keys:[...]}]
  for (const k of keys) {
    let hit = null;
    for (const c of clusters) {
      if (similarity(k, c.key) >= threshold) { hit = c; break; }
    }
    if (hit) hit.keys.push(k);
    else clusters.push({ key: k, keys: [k] });
  }

  // 3. 输出（成员 ≥2 才算系列）；系列名取簇内最短键（通常是最干净的基名）
  const out = [];
  for (const c of clusters) {
    const ids = [];
    for (const k of c.keys) ids.push(...byKey.get(k));
    if (ids.length < 2) continue;
    const name = c.keys.slice().sort((a, b) => a.length - b.length)[0];
    out.push({ key: name, name, ids });
  }
  return out;
}

/**
 * 把聚类结果写回 movies.serial（better-sqlite3 db 句柄）。
 * 策略：
 *   · comic/novel/cartoon：serial 永远用计算结果覆盖（这三类的 serial 只归本模块管）
 *   · film：TMDB 刮削已给 serial 的不覆盖，空的才填
 *   · jav / anime（里番）：不碰
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} types 如 ['comic','novel','cartoon','film']
 * @returns {{changed:number, series:number}} changed=更新行数 series=系列数（≥2 成员）
 */
function recomputeSerials(db, types) {
  const nodePath = require('path');
  const list = Array.isArray(types) ? types : ['comic', 'novel', 'cartoon', 'film'];
  const ph = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, type, title, fileName, filePath, serial FROM movies WHERE type IN (${ph})`).all(...list);
  // ★ 按「类型 + 父目录」分桶：不同目录下的同名作品不互相误合并
  const byBucket = new Map();
  for (const r of rows) {
    const dir = nodePath.dirname(String(r.filePath || r.fileName || ''));
    const bkey = r.type + '\u0000' + dir;
    if (!byBucket.has(bkey)) byBucket.set(bkey, { type: r.type, items: [] });
    byBucket.get(bkey).items.push(r);
  }

  const upd = db.prepare('UPDATE movies SET serial = ? WHERE id = ?');
  let changed = 0, seriesCount = 0;
  const tx = db.transaction(() => {
    for (const { type, items } of byBucket.values()) {
      const clusters = clusterSeries(items.map(r => ({ id: r.id, title: r.title || r.fileName })));
      seriesCount += clusters.length;
      const nameById = new Map();
      for (const c of clusters) for (const id of c.ids) nameById.set(id, c.name);
      for (const it of items) {
        let name;
        if (type === 'film') {
          name = (it.serial && String(it.serial).trim()) || nameById.get(it.id) || extractSeriesKey(it.title || it.fileName) || '';
        } else {
          name = nameById.get(it.id) || extractSeriesKey(it.title || it.fileName) || '';
        }
        if ((it.serial || '') !== name) { upd.run(name, it.id); changed++; }
      }
    }
  });
  tx();
  return { changed, series: seriesCount };
}

module.exports = { extractSeriesKey, clusterSeries, similarity, recomputeSerials, normalizeTitle: extractSeriesKey };
