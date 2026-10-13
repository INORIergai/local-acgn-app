/**
 * 91动漫（里番）封面源 —— 动漫库的**第二**封面源（第一是 AniList）
 *
 * ★ 历史坑（导致「动漫库一个封面都搜不到」的真凶之一）：
 *   旧代码用 `/search-result/<关键词>/` 这个页面抓 `.dm-card`。实测该页面返回的是
 *   **推荐列表**，不是搜索结果 —— 用乱码关键词 `qzxwvbnmasdf` 去请求，照样返回 40+ 张卡片，
 *   且卡片标题与关键词毫无关系。所以解析出来的东西永远匹配不上，一路 null。
 *
 * ★ 正确入口：`GET /api/search?q=<关键词>`，返回 JSON：
 *   { status:1, data:{ items:[ { cover, href, id, tags, title, type } ] } }
 *
 * 两个必须注意的点：
 *   1. `cover` 带 `?auth_key=<过期时间>-...` 签名，**拿到就得马上下载**，不能存着以后用；
 *   2. 站点搜索偏「模糊」，返回值里混着不相关内容 → 必须用 title-match 做相似度筛选，
 *      宁可不出图，也不要配一张错的封面。
 *
 * 域名不稳，站点有多个镜像（`284.iffuglfyc.com` / `9ed.nodgswul.cc` / ...），逐个回退。
 */
const config = require('../config');
const { pickBest, norm, simScore, toSimp } = require('./title-match');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function bases() {
  const c = config.sources?.dongman || {};
  const list = [c.baseUrl, ...(c.mirrors || [])].filter(Boolean);
  return [...new Set(list.map(u => String(u).replace(/\/+$/, '')))];
}

async function apiSearch(base, keyword) {
  const url = `${base}/api/search?q=${encodeURIComponent(keyword)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': base + '/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const items = j?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(`返回体不含 items：${JSON.stringify(j).slice(0, 120)}`);
  }
  return items
    .filter(it => it && it.cover && it.title)
    .map(it => ({
      title: String(it.title).trim(),
      cover: String(it.cover),
      href: it.href || '',
      id: it.id,
      type: it.type || 'anime',
      tags: Array.isArray(it.tags) ? it.tags : [],
      year: '',
      episodes: 0,
      genres: Array.isArray(it.tags) ? it.tags : [],
      overview: '',
      detailUrl: it.href ? base + it.href : '',
      source: '91dongman',
    }))
    // 排掉漫画卡（本库漫画另走 kmoe）
    .filter(it => it.type !== 'comic');
}

/**
 * 拿全部候选项（多镜像回退 + 繁简双查）
 *
 * ★ 实测（2026-09-23）：这个 `/api/search` 对**任何**关键词都会返回一页 24 条
 *   （连乱码和纯日文原名也一样），属于「宽匹配 + 补满一页」。所以：
 *     - 不能用「有没有返回」判断命中，必须靠 title-match 打分；
 *     - 繁体/简体在它这儿召回**不一样**（「讓妻子參加同學會後」与「妻子参加同学会后」
 *       返回的两批 24 条几乎不重叠）→ 两种写法都查一遍取并集。
 *   为控制耗时：第一轮若已出现高分候选（>=0.6）就直接返回，不再查第二种写法。
 */
async function searchDongmanAll(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];

  // 第一轮：原样
  const first = await onePass(kw);
  if (bestScoreOf(first, kw) >= 0.6) return first;

  // 第二轮：简体写法（繁体转简体；本身是简体则跳过）
  const simp = toSimp(kw);
  if (simp && simp !== kw) {
    const second = await onePass(simp);
    const merged = dedupe([...first, ...second]);
    if (second.length) console.log(`[91动漫] 繁简并查：原样 ${first.length} + 简体 ${second.length} → 去重 ${merged.length}`);
    return merged;
  }
  return first;
}

/** 单轮：多镜像回退 */
async function onePass(kw) {
  let lastErr = null;
  for (const base of bases()) {
    try {
      const items = await apiSearch(base, kw);
      if (items.length) {
        console.log(`[91动漫] ${base} 返回 ${items.length} 条候选`);
        return items;
      }
    } catch (e) {
      lastErr = e;
      console.log(`[91动漫] ${base} 失败: ${e.message}`);
    }
  }
  if (lastErr) console.log('[91动漫] 所有镜像均失败');
  return [];
}

function bestScoreOf(list, kw) {
  const qn = norm(kw);
  let best = 0;
  for (const c of list) {
    const s = simScore(c.title, qn);
    if (s > best) best = s;
  }
  return best;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = (c.href || '') + '|' + c.title;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * 取最佳匹配
 * @returns {Promise<null|object>} 与 searchMovie 一致的结构
 */
async function searchDongmanByName(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;
  const cands = await searchDongmanAll(kw);
  if (cands.length === 0) return null;

  const best = pickBest(cands, kw);
  if (!best) {
    console.log('[91动漫] 有候选但相关度不足，放弃（避免配错封面）');
    return null;
  }
  console.log(`[91动漫] 命中: ${best.title}（相关度 ${best._score.toFixed(2)}）`);
  return {
    title: best.title,
    originalTitle: best.title,
    cover: best.cover,
    releaseDate: '',
    genres: best.tags,
    overview: '',
    actress: [],
    duration: 0,
    producer: '',
    director: '',
    serial: '',
    score: 0,
    sampleImages: [],
    source: '91dongman',
    detailUrl: best.href.startsWith('http') ? best.href : best.detailUrl,
  };
}

module.exports = { searchDongmanAll, searchDongmanByName };
