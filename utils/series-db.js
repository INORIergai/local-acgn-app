// ================================================================
// utils/series-db.js —— round173 追番数据层
//   一部番 = series；季 = seasons；集 = episodes；
//   追番清单 = follows；分集进度 = episode_progress。
//
//   设计铁律：
//   1. 底层句柄从 require('./db').db 取（utils/db 导出的是模块对象，
//      ★ 不是 db 本身——写成 require('./db').upsertMovie 之类才对，
//      原生 sqlite 句柄在 .db 上）。
//   2. 不碰 movies 表任何列（FTS5 触发器历史事故，见 db.js round73 注释）。
//      本地文件关联只写 episodes.movieId。
//   3. 所有写操作幂等（upsert），便于刮削重跑、Bangumi 同步重放。
// ================================================================

const { db } = require('./db');

const now = () => Date.now();

// ---------- 预编译语句：series ----------
const upsertSeriesStmt = db.prepare(`
  INSERT INTO series (title, originalTitle, provider, providerId, type, overview,
                      posterPath, airDate, status, episodeCount, createdAt, updatedAt)
  VALUES (@title, @originalTitle, @provider, @providerId, @type, @overview,
          @posterPath, @airDate, @status, @episodeCount, @createdAt, @updatedAt)
  ON CONFLICT(provider, providerId) DO UPDATE SET
    title        = CASE WHEN @title <> '' THEN @title ELSE series.title END,
    originalTitle= CASE WHEN @originalTitle <> '' THEN @originalTitle ELSE series.originalTitle END,
    overview     = CASE WHEN @overview <> '' THEN @overview ELSE series.overview END,
    posterPath   = CASE WHEN @posterPath <> '' THEN @posterPath ELSE series.posterPath END,
    airDate      = CASE WHEN @airDate <> '' THEN @airDate ELSE series.airDate END,
    status       = @status,
    episodeCount = CASE WHEN @episodeCount > 0 THEN @episodeCount ELSE series.episodeCount END,
    type         = @type,
    updatedAt    = @updatedAt
`);

const getSeriesByIdStmt = db.prepare(`SELECT * FROM series WHERE id = ?`);
const getSeriesByProviderStmt = db.prepare(`SELECT * FROM series WHERE provider = ? AND providerId = ?`);

/**
 * 新增或更新一部番。
 * ★ provider+providerId 是幂等键；若调用方没给 providerId，
 *   退化成 ('custom', title+'|'+type)，保证同名番不会被重复插。
 */
function upsertSeries(s) {
  const provider = String(s.provider || 'custom').trim() || 'custom';
  const providerId = String(s.providerId || '').trim() ||
    `${String(s.title || '').trim()}|${String(s.type || 'cartoon').trim()}`;
  const t = now();
  const info = upsertSeriesStmt.run({
    title: String(s.title || '').trim(),
    originalTitle: String(s.originalTitle || ''),
    provider,
    providerId,
    type: String(s.type || 'cartoon'),
    overview: String(s.overview || ''),
    posterPath: String(s.posterPath || ''),
    airDate: String(s.airDate || ''),
    status: String(s.status || 'ongoing'),
    episodeCount: Number(s.episodeCount || 0),
    createdAt: t,
    updatedAt: t
  });
  // ON CONFLICT 时 lastInsertRowid 是已存在行的 rowid，也可直接用 provider 查回
  return getSeriesByProviderStmt.get(provider, providerId);
}

function getSeriesById(id) {
  return getSeriesByIdStmt.get(id) || null;
}

function getSeriesByProvider(provider, providerId) {
  return getSeriesByProviderStmt.get(provider, providerId) || null;
}

function searchSeries(keyword, limit = 30) {
  const kw = `%${String(keyword || '').trim()}%`;
  return db.prepare(`
    SELECT s.*, f.status AS followStatus
    FROM series s LEFT JOIN follows f ON f.seriesId = s.id
    WHERE s.title LIKE ? OR s.originalTitle LIKE ?
    ORDER BY (f.status = 'watching') DESC, s.airDate DESC
    LIMIT ?
  `).all(kw, kw, Number(limit) || 30);
}

function listSeries({ type = '', limit = 60, offset = 0 } = {}) {
  return db.prepare(`
    SELECT s.*, f.status AS followStatus, f.favorite
    FROM series s LEFT JOIN follows f ON f.seriesId = s.id
    WHERE (? = '' OR s.type = ?)
    ORDER BY s.airDate DESC, s.id DESC
    LIMIT ? OFFSET ?
  `).all(type, type, Number(limit) || 60, Number(offset) || 0);
}

// ---------- 预编译语句：seasons / episodes ----------
const upsertSeasonStmt = db.prepare(`
  INSERT INTO seasons (seriesId, seasonNo, title, posterPath)
  VALUES (@seriesId, @seasonNo, @title, @posterPath)
  ON CONFLICT(seriesId, seasonNo) DO UPDATE SET
    title = CASE WHEN @title <> '' THEN @title ELSE seasons.title END,
    posterPath = CASE WHEN @posterPath <> '' THEN @posterPath ELSE seasons.posterPath END
`);

function ensureSeason(seriesId, seasonNo = 1, title = '', posterPath = '') {
  upsertSeasonStmt.run({
    seriesId: Number(seriesId),
    seasonNo: Number(seasonNo) || 1,
    title: String(title || ''),
    posterPath: String(posterPath || '')
  });
  return db.prepare(`SELECT * FROM seasons WHERE seriesId = ? AND seasonNo = ?`)
    .get(Number(seriesId), Number(seasonNo) || 1);
}

const upsertEpisodeStmt = db.prepare(`
  INSERT INTO episodes (seriesId, seasonId, episodeNo, title, airDate, duration, movieId, createdAt)
  VALUES (@seriesId, @seasonId, @episodeNo, @title, @airDate, @duration, @movieId, @createdAt)
  ON CONFLICT(seriesId, seasonId, episodeNo) DO UPDATE SET
    title    = CASE WHEN @title <> '' THEN @title ELSE episodes.title END,
    airDate  = CASE WHEN @airDate <> '' THEN @airDate ELSE episodes.airDate END,
    duration = CASE WHEN @duration > 0 THEN @duration ELSE episodes.duration END,
    movieId  = CASE WHEN @movieId IS NOT NULL THEN @movieId ELSE episodes.movieId END
`);

/** 批量写入某季的分集（事务，供 Bangumi/AniList 刮削回填） */
function bulkUpsertEpisodes(seriesId, seasonNo, episodes) {
  const season = ensureSeason(seriesId, seasonNo);
  const t = now();
  const run = db.transaction((rows) => {
    for (const e of rows) {
      if (e.episodeNo == null) continue;
      upsertEpisodeStmt.run({
        seriesId: Number(seriesId),
        seasonId: season.id,
        episodeNo: Number(e.episodeNo),
        title: String(e.title || ''),
        airDate: String(e.airDate || ''),
        duration: Number(e.duration || 0),
        movieId: e.movieId != null ? Number(e.movieId) : null,
        createdAt: t
      });
    }
  });
  run(Array.isArray(episodes) ? episodes : []);
  return getEpisodes(seriesId, seasonNo);
}

/** 取某季全部分集（左连接进度，一次拿全） */
function getEpisodes(seriesId, seasonNo = 1) {
  const season = db.prepare(`SELECT id FROM seasons WHERE seriesId = ? AND seasonNo = ?`)
    .get(Number(seriesId), Number(seasonNo) || 1);
  if (!season) return [];
  return db.prepare(`
    SELECT e.*, p.position, p.duration AS progressDuration, p.watched, p.updatedAt AS progressAt
    FROM episodes e LEFT JOIN episode_progress p ON p.episodeId = e.id
    WHERE e.seasonId = ?
    ORDER BY e.episodeNo ASC
  `).all(season.id);
}

function getSeasons(seriesId) {
  return db.prepare(`SELECT * FROM seasons WHERE seriesId = ? ORDER BY seasonNo ASC`)
    .all(Number(seriesId));
}

/** 把本地 movie 挂到某一集上（下载入库后调用） */
function linkEpisodeMovie(episodeId, movieId) {
  const r = db.prepare(`UPDATE episodes SET movieId = ? WHERE id = ?`)
    .run(movieId != null ? Number(movieId) : null, Number(episodeId));
  return r.changes > 0;
}

// ---------- follows ----------
const setFollowStmt = db.prepare(`
  INSERT INTO follows (seriesId, status, favorite, addedAt, updatedAt)
  VALUES (@seriesId, @status, @favorite, @addedAt, @updatedAt)
  ON CONFLICT(seriesId) DO UPDATE SET
    status = @status,
    favorite = CASE WHEN @favorite >= 0 THEN @favorite ELSE follows.favorite END,
    updatedAt = @updatedAt
`);

const FOLLOW_STATUS = ['watching', 'planned', 'completed', 'dropped'];

function setFollow(seriesId, status = 'watching', favorite = -1) {
  if (!FOLLOW_STATUS.includes(status)) throw new Error('无效追番状态: ' + status);
  const t = now();
  setFollowStmt.run({ seriesId: Number(seriesId), status, favorite: Number(favorite), addedAt: t, updatedAt: t });
  return getSeriesById(seriesId);
}

function unfollow(seriesId) {
  return db.prepare(`DELETE FROM follows WHERE seriesId = ?`).run(Number(seriesId)).changes > 0;
}

function getFollowStatus(seriesId) {
  const r = db.prepare(`SELECT status FROM follows WHERE seriesId = ?`).get(Number(seriesId));
  return r ? r.status : null;
}

/**
 * 追番看板：每个已追番的番，带总集数/已看集数/下一集。
 * ★ nextEpisode = 最小未看集号，前端「继续看」直接用它。
 */
function getFollowBoard(status = '') {
  const st = String(status || '');
  return db.prepare(`
    SELECT s.*, f.status AS followStatus, f.favorite, f.updatedAt AS followUpdatedAt,
      (SELECT COUNT(*) FROM episodes e WHERE e.seriesId = s.id) AS episodeTotal,
      (SELECT COUNT(*) FROM episodes e JOIN episode_progress p ON p.episodeId = e.id
         WHERE e.seriesId = s.id AND p.watched = 1) AS watchedCount,
      (SELECT MIN(e.episodeNo) FROM episodes e LEFT JOIN episode_progress p ON p.episodeId = e.id
         WHERE e.seriesId = s.id AND (p.watched IS NULL OR p.watched = 0)) AS nextEpisode
    FROM follows f JOIN series s ON s.id = f.seriesId
    WHERE (? = '' OR f.status = ?)
    ORDER BY f.updatedAt DESC
  `).all(st, st);
}

// ---------- episode_progress ----------
const setEpisodeProgressStmt = db.prepare(`
  INSERT INTO episode_progress (episodeId, position, duration, watched, updatedAt)
  VALUES (@episodeId, @position, @duration,
          CASE WHEN @watched >= 0 THEN @watched ELSE 0 END, @updatedAt)
  ON CONFLICT(episodeId) DO UPDATE SET
    position = @position,
    duration = CASE WHEN @duration > 0 THEN @duration ELSE episode_progress.duration END,
    watched  = CASE WHEN @watched >= 0 THEN @watched ELSE episode_progress.watched END,
    updatedAt = @updatedAt
`);

/**
 * 上报某集进度。
 * watched 传 -1 表示「不改」（只更新位置）；0/1 表示明确设置。
 * ★ 与影片级一致：position/duration >= 0.95 视为看完，自动置 watched=1。
 */
function setEpisodeProgress(episodeId, { position = 0, duration = 0, watched = -1 } = {}) {
  let w = Number(watched);
  if (w < 0 && duration > 0 && position / duration >= 0.95) w = 1;
  setEpisodeProgressStmt.run({
    episodeId: Number(episodeId),
    position: Number(position) || 0,
    duration: Number(duration) || 0,
    watched: w,
    updatedAt: now()
  });
  return getEpisodeProgress(episodeId);
}

function getEpisodeProgress(episodeId) {
  return db.prepare(`SELECT * FROM episode_progress WHERE episodeId = ?`).get(Number(episodeId)) || null;
}

/** 第一档②：设置某集的跳过片头/片尾区间（秒）。先确保有进度行，再 UPDATE。 */
function setEpisodeSkip(episodeId, { skipOp = 0, skipEd = 0 } = {}) {
  const eid = Number(episodeId);
  if (!eid) return null;
  // 借 setEpisodeProgress 确保行存在（watched=-1 不改其它字段）
  setEpisodeProgressStmt.run({ episodeId: eid, position: 0, duration: 0, watched: -1, updatedAt: now() });
  db.prepare(`UPDATE episode_progress SET skipOp = ?, skipEd = ?, updatedAt = ? WHERE episodeId = ?`)
    .run(Number(skipOp) || 0, Number(skipEd) || 0, now(), eid);
  return getEpisodeProgress(eid);
}

function getEpisodeProgressMap(seriesId) {
  const rows = db.prepare(`
    SELECT p.episodeId, p.position, p.duration, p.watched, p.updatedAt
    FROM episode_progress p JOIN episodes e ON e.id = p.episodeId
    WHERE e.seriesId = ?
  `).all(Number(seriesId));
  const map = {};
  for (const r of rows) map[r.episodeId] = r;
  return map;
}

function clearEpisodeProgress(episodeId) {
  return db.prepare(`DELETE FROM episode_progress WHERE episodeId = ?`).run(Number(episodeId)).changes > 0;
}

/**
 * 从新番放送表数据批量 upsert 成 series，并标注每部是否已入库/已追番。
 * ★ 幂等键 = (provider, providerId)，providerId 优先 anilistId > bangumiId > cycId > 标题。
 * 同一部番在不同源重复出现时按标题去重（归一化去空格/符号）。
 * 返回 { items:[{title, cover, provider, providerId, seriesId, followStatus, episode, airingAt}], count }
 */
function importFromCalendar(days) {
  const seen = new Set();
  const items = [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').trim();
  for (const day of (Array.isArray(days) ? days : [])) {
    for (const it of (Array.isArray(day.items) ? day.items : [])) {
      const title = String(it.title || '').trim();
      if (!title || title === '(未命名)') continue;
      const key = norm(title);
      if (seen.has(key)) continue;
      seen.add(key);

      let provider = 'custom', providerId = '';
      if (it.anilistId != null) { provider = 'anilist'; providerId = String(it.anilistId); }
      else if (it.bangumiId != null) { provider = 'bangumi'; providerId = String(it.bangumiId); }
      else if (it.cycId != null) { provider = 'cycanime'; providerId = String(it.cycId); }
      else providerId = key;

      const s = upsertSeries({
        title,
        provider,
        providerId,
        type: 'cartoon',
        posterPath: String(it.cover || ''),
        status: 'ongoing',
        episodeCount: Number(it.totalEps || 0)
      });
      items.push({
        title,
        cover: String(it.cover || ''),
        provider,
        providerId,
        seriesId: s.id,
        followStatus: getFollowStatus(s.id),
        episode: it.episode != null ? it.episode : null,
        airingAt: it.airingAt || null,
        date: day.date || ''
      });
    }
  }
  return { items, count: items.length };
}

// ---------- 组合查询：番详情（含季/集/追番状态/进度） ----------
function getSeriesDetail(seriesId) {
  const series = getSeriesById(seriesId);
  if (!series) return null;
  return {
    series,
    seasons: getSeasons(seriesId),
    episodes: getEpisodes(seriesId, 1),
    followStatus: getFollowStatus(seriesId)
  };
}

module.exports = {
  FOLLOW_STATUS,
  upsertSeries,
  getSeriesById,
  getSeriesByProvider,
  searchSeries,
  listSeries,
  ensureSeason,
  getSeasons,
  bulkUpsertEpisodes,
  getEpisodes,
  linkEpisodeMovie,
  setFollow,
  unfollow,
  getFollowStatus,
  getFollowBoard,
  setEpisodeProgress,
  setEpisodeSkip,
  getEpisodeProgress,
  getEpisodeProgressMap,
  clearEpisodeProgress,
  getSeriesDetail,
  importFromCalendar
};
