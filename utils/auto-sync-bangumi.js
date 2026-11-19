// ================================================================
// utils/auto-sync-bangumi.js —— 第一档改进① 看完自动上报 Bangumi
//   movie 播放完成（≥95%）后：movieId → episode → series → Bangumi subjectId，
//   增量上报 ep_status（看到第几集），若看完该季最后一集则标记 collect(2)。
//
//   ★ 铁律：
//   1. 只在 Bangumi 已连接（有 token）且该番绑定了 bangumi subjectId 时上报；
//   2. 全程异步、try-catch 静默——绝不影响播放/进度上报主流程；
//   3. ep_status 只增不减（max），避免回退。
// ================================================================

const { db, getMovieById } = require('./db');
const { api, getToken } = require('./bangumi-oauth');

const TYPE_WATCHING = 3, TYPE_COLLECT = 2;

/** 由 movieId 找关联的 bangumi subject + 集号；找不到返回 null */
function resolve(movieId) {
  if (!movieId) return null;
  const ep = db.prepare(`SELECT e.id episodeId, e.episodeNo, e.seasonId, e.seriesId
                         FROM episodes e WHERE e.movieId = ? LIMIT 1`).get(movieId);
  if (!ep) return null;
  const s = db.prepare(`SELECT id, title, provider, providerId, episodeCount
                        FROM series WHERE id = ?`).get(ep.seriesId);
  if (!s || s.provider !== 'bangumi' || !s.providerId) return null;
  return { episodeNo: Number(ep.episodeNo) || 0, seasonId: ep.seasonId || 1,
           seriesId: s.id, subjectId: s.providerId, title: s.title,
           total: Number(s.episodeCount) || 0 };
}

/** 看完一集后自动上报（异步，不抛错） */
async function onMovieCompleted(movieId) {
  try {
    if (!getToken()) return { ok: false, reason: 'Bangumi 未连接' };
    const info = resolve(movieId);
    if (!info) return { ok: false, reason: '未关联 bangumi 分集' };
    if (!info.episodeNo) return { ok: false, reason: '无集号' };

    // 读 Bangumi 当前收藏状态，取 ep_status 较大者（只增不减）
    let cols = [];
    try { cols = await api(`/v0/users/-/collections?subject_type=2&limit=100`) || []; }
    catch (e) { return { ok: false, reason: '读 Bangumi 收藏失败: ' + e.message }; }
    const cur = (cols || []).find(c => String((c.subject || {}).id || c.subject_id) === String(info.subjectId));
    const curEp = Number(cur && cur.ep_status || 0);
    const newEp = Math.max(curEp, info.episodeNo);

    // 看完该季最后一集 → collect(2)，否则 do(3)
    const type = (info.total > 0 && newEp >= info.total) ? TYPE_COLLECT : TYPE_WATCHING;
    await api(`/v0/users/-/collections/${info.subjectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ep_status: newEp }),
    });
    return { ok: true, title: info.title, episodeNo: info.episodeNo, epStatus: newEp, type };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { resolve, onMovieCompleted };
