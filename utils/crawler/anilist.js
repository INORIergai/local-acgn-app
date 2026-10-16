/**
 * AniList 动画封面源（动漫库主力源）
 *
 * 为什么用它：
 *   - 官方 GraphQL 接口 `https://graphql.anilist.co`，**不需要浏览器**，不受 Cloudflare 影响；
 *   - `isAdult: true` 能返回 18+ 里番条目（普通影视源会把它们过滤掉，这正是动漫库一直搜不到的原因之一）；
 *   - 返回**日文原名** + 多档封面（extraLarge / large / medium），与本地文件名（日文/繁体标题）契合度高。
 *
 * 用法：`searchAniListAll(keyword)` 拿候选列表；`searchAniListByName(keyword)` 取最佳匹配。
 */
const config = require('../config');
const { pickBest } = require('./title-match');

const ENDPOINT = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const GRAPHQL = `
query ($s: String, $adult: Boolean) {
  Page(page: 1, perPage: 10) {
    media(search: $s, type: ANIME, isAdult: $adult, sort: [SEARCH_MATCH]) {
      id
      title { romaji native english }
      coverImage { extraLarge large medium }
      startDate { year }
      episodes
      genres
      description(asHtml: false)
      isAdult
    }
  }
}`;

/** 把 GraphQL 返回的一条 media 归一成内部候选结构 */
function toCandidate(m) {
  const ci = m.coverImage || {};
  return {
    title: m.title?.native || m.title?.romaji || m.title?.english || '',
    romaji: m.title?.romaji || '',
    english: m.title?.english || '',
    cover: ci.extraLarge || ci.large || ci.medium || '',
    year: m.startDate?.year || '',
    episodes: m.episodes || 0,
    genres: Array.isArray(m.genres) ? m.genres : [],
    overview: String(m.description || '').replace(/<[^>]+>/g, '').slice(0, 400),
    isAdult: !!m.isAdult,
    detailUrl: m.id ? `https://anilist.co/anime/${m.id}` : '',
  };
}

/**
 * 调 GraphQL。AniList 是 JSON 接口，`crawler/base.js` 的 Request 只发 form-urlencoded，
 * 所以这里直接用原生 fetch（容器内实测直连 200，无需代理）。带退避重试。
 * @param {string} keyword 搜索词
 * @param {object} [opts] { isAdult: true|false }，默认 true（里番库旧行为不变；
 *                  动漫库 round34 传 false 只搜普通向）
 */
async function gql(keyword, opts = {}) {
  const adult = opts.isAdult !== false; // 缺省 true，保持兼容
  const body = JSON.stringify({ query: GRAPHQL, variables: { s: keyword, adult } });
  const tries = config.network?.retryCount || 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 800 * i));
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': UA,
          'Referer': 'https://anilist.co/',
        },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
      const data = await res.json();
      if (data.errors) throw new Error('AniList GraphQL: ' + JSON.stringify(data.errors).slice(0, 160));
      return (data.data?.Page?.media || []).map(toCandidate);
    } catch (e) {
      lastErr = e;
      console.log(`[AniList] 请求失败 第${i + 1}/${tries}次: ${e.message}`);
    }
  }
  throw lastErr;
}

/**
 * 生成「由长到短」的关键词变体。
 *
 * AniList 是全文检索，**关键词越长越搜不到**（多一个无关词就会把命中打到 0）。
 * 本地文件名往往带副标题、卷号、「第X話」等噪音，所以逐级退让：
 *   完整词 → 去掉「第X話/OVA/上巻…」这类尾巴 → 前 3 段 → 前 2 段 → 第 1 段
 */
function keywordVariants(kw) {
  const out = [];
  const push = (s) => { const t = String(s || '').trim(); if (t && !out.includes(t)) out.push(t); };

  push(kw);
  // 去掉常见的「话/集/卷/OVA」尾巴
  push(kw.replace(/[\s　]*(第\s*\d*\s*[話话集巻卷]|OVA|OAD|ONA|上巻|下巻|前編|後編|完|THE ANIMATION)\b.*$/i, ''));

  const toks = kw.split(/[\s　]+/).filter(Boolean);
  for (let n = Math.min(toks.length - 1, 3); n >= 1; n--) push(toks.slice(0, n).join(' '));

  return out;
}

/**
 * 搜索全部候选（供「更换海报」列表用）
 * 逐级尝试关键词变体，命中即停（最多试 3 次，避免拖慢刮削）
 * @param {string} keyword
 * @param {object} [opts] { isAdult }，透传给 gql
 */
async function searchAniListAll(keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const variants = keywordVariants(kw).slice(0, 3);
  for (const v of variants) {
    try {
      const list = await gql(v, opts);
      const withCover = list.filter(x => x.cover);
      if (withCover.length) {
        if (v !== kw) console.log(`[AniList] 关键词退让为「${v}」，命中 ${withCover.length} 条`);
        return withCover;
      }
    } catch (e) {
      console.log(`[AniList] 搜索「${v}」异常: ${e.message}`);
      break; // 网络/接口问题就别再换词重试了
    }
  }
  return [];
}

/**
 * 取最佳匹配（供自动刮削用）
 * @param {string} keyword
 * @param {object} [opts] { isAdult }
 * @returns {Promise<null|object>} 与 searchMovie 一致的结构
 */
async function searchAniListByName(keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;
  const cands = await searchAniListAll(kw, opts);
  if (cands.length === 0) {
    console.log('[AniList] 未检索到结果');
    return null;
  }
  // 动漫库（普通向）：无论源怎么过滤，最后再按 isAdult 标记硬挡一遍
  const pool = opts.isAdult === false ? cands.filter(c => !c.isAdult) : cands;
  if (pool.length === 0) {
    console.log('[AniList] 候选全部为 18+ 内容，按普通向过滤放弃');
    return null;
  }
  const best = pickBest(pool, kw);
  if (!best) {
    console.log(`[AniList] 有 ${pool.length} 条候选但相关度不足，放弃（避免配错封面）`);
    return null;
  }
  console.log(`[AniList] 命中: ${best.title}（${best.year || '?'}）相关度 ${best._score.toFixed(2)}`);
  return {
    title: best.title,
    originalTitle: best.romaji || best.title,
    cover: best.cover,
    releaseDate: best.year ? String(best.year) : '',
    genres: best.genres,
    overview: best.overview,
    actress: [],
    duration: 0,
    producer: '',
    director: '',
    serial: '',
    score: 0,
    sampleImages: [],
    source: 'anilist',
    detailUrl: best.detailUrl,
  };
}

module.exports = { searchAniListAll, searchAniListByName };
