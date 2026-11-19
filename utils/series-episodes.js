// ================================================================
// utils/series-episodes.js —— round173c 分集数据回填
//   加追后 series 只有元数据、episodes 为空 ⇒ 「继续看第 N 集」点不动。
//   本服务按标题搜 AniList 拿 episodes 总数，生成「第 N 集」占位分集。
//
//   为什么不用 Bangumi 分集 API（/v0/episodes）拿逐集标题：
//   · 本机实测 api.bgm.tv / bgm.tv / bgmlauncher 全不可达（socket hang up）；
//   · AniList 直连可达，且新番表导入的番只有标题能对齐。
//   占位分集虽无逐集标题，但 episodeNo + airDate(放送表有的话) 足够支撑追番进度。
//
//   幂等：已有任意分集则跳过；回填可重复调用不产生重复集。
// ================================================================

const sdb = require('./series-db');
const { searchAniListAll } = require('./crawler/anilist');
const { pickBest } = require('./crawler/title-match');

/**
 * 按标题从 AniList 找番，返回 { episodes, anilistId, title, score } 或 null。
 * 用 isAdult:false（新番表都是普通向）。
 */
async function findEpisodeCount(title) {
  const kw = String(title || '').trim();
  if (!kw) return null;
  const cands = await searchAniListAll(kw, { isAdult: false });
  if (!cands.length) return null;
  const best = pickBest(cands, kw);
  if (!best) return null;
  const n = Number(best.episodes || 0);
  if (!n || n > 200) return null; // 0=未知 / >200 多半是特摄短篇合集，不生成占位
  return { episodes: n, title: best.title, score: best._score || 0, detailUrl: best.detailUrl };
}

/**
 * 回填一部番的分集（幂等）。
 * @returns {Promise<{ok:boolean, count:number, reason?:string, source?:string}>}
 */
async function backfillSeries(seriesId, opts = {}) {
  const s = sdb.getSeriesById(seriesId);
  if (!s) return { ok: false, count: 0, reason: '番剧不存在' };

  // 已有分集 → 幂等跳过
  const existing = sdb.getEpisodes(seriesId, 1);
  if (existing.length && !opts.force) {
    return { ok: true, count: existing.length, reason: 'already', source: 'existing' };
  }

  // 若 series 自带 episodeCount（cycanime 周表的 total 字段），优先用它，省一次网络
  let total = Number(s.episodeCount || 0);
  let source = 'series.episodeCount';
  let found = null;
  if (!total) {
    found = await findEpisodeCount(s.title || s.originalTitle);
    if (!found) return { ok: false, count: 0, reason: 'AniList 未找到或集数未知' };
    total = found.episodes;
    source = 'anilist';
  }

  // 生成占位分集：第 1..N 集，标题「第 N 话」
  const eps = [];
  for (let i = 1; i <= total; i++) {
    eps.push({ episodeNo: i, title: '第 ' + i + ' 话' });
  }
  const rows = sdb.bulkUpsertEpisodes(seriesId, 1, eps);

  // 若 AniList 找到了，顺手把 anilistId/简介/原名补进 series（仅填空，不覆盖用户数据）
  if (found && found.detailUrl) {
    const anilistId = String(found.detailUrl).split('/').pop();
    try {
      const { db } = require('./db');
      db.prepare(`UPDATE series SET originalTitle = CASE WHEN originalTitle='' THEN ? ELSE originalTitle END,
                  provider = CASE WHEN provider='custom' OR provider='cycanime' THEN 'anilist' ELSE provider END,
                  providerId = CASE WHEN providerId='' THEN ? ELSE providerId END,
                  updatedAt = ? WHERE id = ?`)
        .run(found.title || '', anilistId, Date.now(), seriesId);
    } catch (e) { /* 元数据补全失败不致命，分集已落库 */ }
  }

  return { ok: true, count: rows.length, source };
}

module.exports = { findEpisodeCount, backfillSeries };
