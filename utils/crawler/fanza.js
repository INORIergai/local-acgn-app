/**
 * FANZA 官方 API（DMM アフィリエイト API v3）—— 里番动画 / AV 的**官方**封面源
 *
 * ★ 为什么单独开一个源（2026-09-23 实测结论）：
 *   1. FANZA / DMM 的**网页**对非日本 IP 全部拒绝：
 *      `www.dmm.co.jp` / `video.dmm.co.jp` → 「このページはお住まいの地域からご利用になれません」；
 *      `www.dmm.com` 同理。所以**不能抓网页**。
 *   2. `api.video.dmm.co.jp/graphql`（项目里 dmm.js 用的那个）**不封锁、也免 key**，
 *      但它的 `legacySearchPPV` **只索引真人 AV 目录**：
 *      搜里番厂商名 `メリー・ジェーン` / `PoRO` / `鈴木みら乃` / `ピンクパイナップル` / `魔人`
 *      → **全部 0 条**。拿它搜里番永远搜不到。
 *   3. 唯一官方能取到「FANZAアニメ（里番）」封面的入口就是这个アフィリエイト API v3：
 *      `site=FANZA & service=digital & floor=anime`，且**不受区域封锁**（容器实测可达）。
 *
 * ★ 需要凭证（免费）：
 *   去 https://affiliate.dmm.com/ 注册 → 拿到 `api_id` + `affiliate_id`
 *   （注意：FANZA 成人内容的凭证要在 FANZA 侧申请，与 DMM.com 通用站不通用）
 *   填到 config 的 `sources.fanza`，本源才会启用。
 *
 * ★ 语言：FANZA 只认**日语**标题。库里中文译名（如「讓妻子參加同學會後」）搜不到，
 *   这类只能靠 hanime1（中文索引站）。
 */
const config = require('../config');
const { pickBest, norm, simScore } = require('./title-match');

const ENDPOINT = 'https://api.dmm.com/affiliate/v3/ItemList';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function creds() {
  const c = config.sources?.fanza || {};
  return {
    apiId: c.apiId || c.api_id || '',
    affiliateId: c.affiliateId || c.affiliate_id || '',
    enabled: c.enabled !== false,
  };
}

function available() {
  const { apiId, affiliateId, enabled } = creds();
  return enabled && !!apiId && !!affiliateId;
}

/**
 * 调 ItemList
 * @param {object} p {site, service, floor, keyword, hits, sort}
 */
async function itemList(p) {
  const { apiId, affiliateId } = creds();
  const qs = new URLSearchParams({
    api_id: apiId,
    affiliate_id: affiliateId,
    site: p.site || 'FANZA',
    service: p.service || 'digital',
    floor: p.floor || 'anime',
    hits: String(p.hits || 20),
    sort: p.sort || 'rank',
    output: 'json',
  });
  if (p.keyword) qs.set('keyword', p.keyword);

  const res = await fetch(`${ENDPOINT}?${qs.toString()}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 160)}`);
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`非 JSON 响应: ${txt.slice(0, 120)}`); }
  const r = j?.result;
  if (!r) throw new Error(`响应无 result: ${txt.slice(0, 120)}`);
  if (r.status !== 200) {
    throw new Error(`FANZA ${r.status}: ${typeof r.errors === 'object' ? JSON.stringify(r.errors).slice(0, 160) : r.message || ''}`);
  }
  return Array.isArray(r.items) ? r.items : [];
}

/** FANZA item → 内部候选结构 */
function toCandidate(it) {
  const img = it.imageURL || {};
  return {
    title: String(it.title || '').trim(),
    cover: img.large || img.list || img.small || '',
    contentId: it.content_id || '',
    floor: it.floor_code || '',
    releaseDate: (it.date || '').slice(0, 10),
    overview: '',
    genres: [],
    detailUrl: it.URL || '',
    source: 'fanza',
  };
}

/**
 * 搜全部候选（供「更换海报」用）
 * @param {string} keyword 日语关键词
 * @param {object} [opt] {floor:'anime'|'videoa', hits}
 */
async function searchFanzaAll(keyword, opt = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  if (!available()) {
    console.log('[FANZA] 未配置 api_id / affiliate_id，跳过（去 https://affiliate.dmm.com/ 免费申请）');
    return [];
  }
  try {
    const items = await itemList({
      floor: opt.floor || 'anime',
      keyword: kw,
      hits: opt.hits || 20,
      sort: opt.sort || 'rank',
    });
    const list = items.map(toCandidate).filter(c => c.title && c.cover);
    if (list.length) console.log(`[FANZA:${opt.floor || 'anime'}] 返回 ${list.length} 条候选`);
    return list;
  } catch (e) {
    console.log(`[FANZA] 搜索失败: ${e.message}`);
    return [];
  }
}

/**
 * 取最佳匹配（带相关性闸门，宁可不出图也不配错）
 * @param {string} keyword 日语关键词
 * @param {object} [opt]
 */
async function searchFanzaByName(keyword, opt = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;
  const cands = await searchFanzaAll(kw, opt);
  if (!cands.length) return null;
  const best = pickBest(cands, kw, opt.threshold ?? 0.6);
  if (!best) return null;
  console.log(`[FANZA] 命中: ${best.title}（相关度 ${best._score.toFixed(2)}）`);
  return {
    title: best.title,
    originalTitle: best.title,
    cover: best.cover,
    releaseDate: best.releaseDate,
    genres: [],
    overview: '',
    actress: [],
    duration: 0,
    producer: '',
    director: '',
    serial: '',
    score: 0,
    sampleImages: [],
    source: 'fanza',
    detailUrl: best.detailUrl,
  };
}

/** 探测凭证是否有效（给设置页/自检用） */
async function probeFanza() {
  if (!available()) return { ok: false, reason: '缺少 api_id / affiliate_id' };
  try {
    const items = await itemList({ floor: 'anime', keyword: '妹', hits: 1 });
    return { ok: true, sample: items.slice(0, 1).map(toCandidate) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { searchFanzaAll, searchFanzaByName, probeFanza, available, itemList };
