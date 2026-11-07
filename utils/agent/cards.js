/**
 * utils/agent/cards.js —— 对话内「可点击播放卡片」归一化
 * ============================================================================
 * 为什么单独一层：
 *   工具返回什么形状，前端不该猜。这里把「任意工具的原始返回值」统一压成
 *   卡片数组（海报地址 + 标题 + 番号 + 类型 + movieId），前端只负责画。
 *
 *   注意：这里拿到的是**未截断的原始返回值**（sandbox 在 sanitize 之前调用），
 *   否则 search_movies 返回 20 条时 JSON 会被截断，卡片就丢一半。
 *
 * 卡片形状（前端约定，勿随意改名）：
 *   {
 *     movieId: number,
 *     title:   string,
 *     avid:    string,
 *     type:    string,          // jav / anime / comic / novel / film / cartoon
 *     poster:  string,          // posterPath（可能是文件名，也可能是远程 URL）
 *     posterLocal: string,      // localPosterPath 的文件名部分
 *     kind:    'play'|'movie',  // play = 用户明确要播放，卡片主按钮是「立即播放」
 *     message: string,          // 可选：工具自带的提示语
 *   }
 * ============================================================================
 */
'use strict';

/* 后端只做「不丢数据」的上限，展示多少条由前端决定（tool 的 search limit 上限是 20）。
   设成 20 而不是 8：曾经在 14 截断导致「搜到 18 部只画 14 张」，用户会以为库少了 4 部。 */
const MAX_CARDS = 20;

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

/* 库里有极少数记录把「番号」写成了 markdown 伪链接，例如
 *   [ABP-367](ABP-367)俺だけの尻コス娘 あやみ旬果
 * 直接画到卡片上就是一行「[ABP-367](ABP-367)」的怪物。显示层统一清洗：
 *   [文本](目标) → 文本（标题优先），并把首尾多余空白压掉。
 * 只清洗**展示副本**，不动数据库里的原值（用户可能就是要那个原文）。 */
function cleanTitle(t) {
  let s = str(t);
  if (!s) return '';
  s = s.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ---------- round144：剥离标题里粘连的「番号前缀」 ----------
 * 库里 9306 条中有 1171 条标题以番号开头，形态五花八门：
 *   [PPPD-720]Julia                    ← 方括号包着
 *   ABP-367俺だけの尻コス娘 あやみ旬果    ← 连字符 + 直接粘连
 *   FNS 069兔女郎 / MIDA049尻           ← 空格分隔或干脆无分隔
 *   [SSNI-963]SSNI-963COS               ← 剥一层还藏着一层
 * 卡片上把番号重复两遍既占地方又难看（番号本来就有独立字段显示）。
 *
 * 规则：**只在标题确实以「本片番号」开头时才剥**，用 avid 做锚点，不做通用正则猜测——
 * 通用正则会误伤「START-060性欲…」这种把番号当标题开头的正常片名（虽然它也确实是番号），
 * 更会误伤番号形如 "BF-674" 但标题以 "BF" 开头的真实作品。
 *
 * 反复剥到不再以番号开头为止（处理 [X]X-123... 这种双层），
 * 但**剥完必须还剩东西**，否则整条标题就是个番号，说明本来没标题可剥，原样返回。 */
function stripAvidPrefix(title, avid) {
  const a = str(avid).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (!a || a.length < 4) return title;

  let s = title;
  for (let guard = 0; guard < 4; guard++) {
    const before = s;
    // 去掉开头的包裹符号与空白，方便判断
    const head = s.replace(/^[\s\[\(【（]+/, '');
    // 把 head 的前若干字符归一化，看是否以番号开头
    const probe = head.slice(0, a.length + 6).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
    if (!probe.startsWith(a)) break;

    // 定位番号在原文里的真实结束位置（按字母数字计数，跳过中间的分隔符）
    let idx = 0, cnt = 0;
    const start = s.length - head.length;
    for (idx = start; idx < s.length && cnt < a.length; idx++) {
      if (/[0-9a-zA-Z]/.test(s[idx])) cnt++;
    }
    // 番号后面可能紧跟一个闭合括号（[PPPD-720]Julia 的 ]）
    const rest = s.slice(idx).replace(/^[\s\]\)】）\-_·:：|]+/, '').trim();
    // 剥完什么都不剩 → 整条就是番号，不该剥
    if (!rest) break;
    s = rest;
    if (s === before) break;
  }
  return s || title;
}

/** localPosterPath（可能是绝对路径）只取文件名，前端接口只认文件名 */
function localPosterName(p) {
  const s = str(p);
  if (!s) return '';
  return s.split(/[\\/]/).pop() || '';
}

/** 从任意形如「影片对象」的东西里抽卡片；抽不出 movieId 的一律丢弃 */
function toCard(obj, kind) {
  if (!obj || typeof obj !== 'object') return null;
  const movieId = Number(obj.movieId != null ? obj.movieId : obj.id);
  if (!Number.isFinite(movieId) || movieId <= 0) return null;
  const avid = str(obj.avid || obj.avidCode || '');
  /* round144：先清 markdown 伪链接，再按 avid 剥掉粘连的番号前缀。
     顺序不能反 —— 伪链接里的 [ABP-367] 也要先降级成纯文本，才轮得到剥前缀。 */
  const title = stripAvidPrefix(cleanTitle(obj.title || obj.fileName || obj.name), avid);
  if (!title) return null;

  const poster = str(obj.posterPath || obj.poster || obj.cover || '');
  return {
    movieId,
    title,
    avid,
    type: str(obj.type || ''),
    poster,
    posterLocal: localPosterName(obj.localPosterPath || ''),
    kind: kind || 'movie',
    message: str(obj.message || obj.notice || '')
  };
}

function looksLikeMovie(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const hasId = Number.isFinite(Number(obj.movieId != null ? obj.movieId : obj.id));
  const hasTitle = !!str(obj.title || obj.fileName || obj.name);
  return hasId && hasTitle;
}

function dedupe(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    if (!c) continue;
    if (seen.has(c.movieId)) continue;
    seen.add(c.movieId);
    out.push(c);
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

/**
 * 把工具结果归一化成卡片
 * @param {string} toolName
 * @param {*} data 工具原始返回值（未截断）
 * @returns {{ cards: Array, kind: 'play'|'movie' }}
 */
function extractCards(toolName, data) {
  if (!data) return { cards: [], kind: 'movie' };

  // ① 明确播放：工具声明 uiAction=play_movie
  if (typeof data === 'object' && !Array.isArray(data) && data.uiAction === 'play_movie') {
    const card = toCard(data, 'play');
    return { cards: card ? [card] : [], kind: 'play' };
  }

  // ② 数组：搜索结果 / 随机推荐 / 同类列表
  if (Array.isArray(data)) {
    return { cards: dedupe(data.filter(looksLikeMovie).map(o => toCard(o, 'movie'))), kind: 'movie' };
  }

  if (typeof data !== 'object') return { cards: [], kind: 'movie' };

  // ③ 对象里包着的列表
  for (const key of ['movies', 'samples', 'items', 'results', 'list', 'related']) {
    if (Array.isArray(data[key]) && data[key].length) {
      const cards = dedupe(data[key].filter(looksLikeMovie).map(o => toCard(o, 'movie')));
      if (cards.length) return { cards, kind: 'movie' };
    }
  }

  // ④ 单个影片对象（get_movie_detail 等）
  if (looksLikeMovie(data)) {
    const card = toCard(data, 'movie');
    return { cards: card ? [card] : [], kind: 'movie' };
  }

  return { cards: [], kind: 'movie' };
}

module.exports = { extractCards, toCard, cleanTitle, stripAvidPrefix, MAX_CARDS };
