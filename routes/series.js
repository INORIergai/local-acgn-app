// ================================================================
// routes/series.js —— round173 追番接口
//   GET   /api/series/search?kw=&limit=            搜索番剧
//   GET   /api/series/list?type=&limit=&offset=    番剧列表
//   GET   /api/series/follows?status=              追番看板（带总集数/已看/下一集）
//   POST  /api/series/follow                       {seriesId, status, favorite}
//   POST  /api/series/unfollow                     {seriesId}
//   POST  /api/series/upsert                       新增/更新番剧（刮削/导入用）
//   POST  /api/series/:id/episodes                 {seasonNo, episodes:[...]} 批量写分集
//   GET   /api/series/:id/episodes?seasonNo=       分集列表（带进度）
//   GET   /api/series/:id/progress                 全番进度 map
//   GET   /api/series/:id/detail                   番详情（季/集/状态）
//   POST  /api/series/episode/progress             {episodeId, position, duration, watched}
//   POST  /api/series/episode/link                 {episodeId, movieId} 挂本地文件
//
//   ★ 路由顺序：字面路径（search/list/follows/...）在前，裸 /:id 在后，防止吞路径。
// ================================================================

const express = require('express');
const router = express.Router();
const sdb = require('../utils/series-db');

// ---- 字面路径（必须先于 /:id） ----
router.get('/search', (req, res) => {
  try {
    const kw = String(req.query.kw || req.query.q || '').trim();
    if (!kw) return res.json({ code: 0, data: [] });
    res.json({ code: 0, data: sdb.searchSeries(kw, req.query.limit) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 从新番放送表导入番剧到 series（lazy：拉当前周表 → 去重 upsert → 标注追番状态）
// GET /api/series/from-calendar?force=1
router.get('/from-calendar', async (req, res) => {
    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const cal = await require('../utils/acg-calendar').getCalendar(force);
        const result = sdb.importFromCalendar(cal && cal.days ? cal.days : []);
        res.json({ code: 0, data: result, source: cal && cal.source });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 检查追番更新（把我追的番里已播新集写成站内通知）
router.post('/check-updates', async (req, res) => {
    try {
        const r = await require('../utils/series-notify').checkAiringUpdates({ force: req.body.force === true });
        res.json({ code: 0, data: r });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/list', (req, res) => {
  try {
    res.json({
      code: 0,
      data: sdb.listSeries({
        type: String(req.query.type || ''),
        limit: req.query.limit,
        offset: req.query.offset
      })
    });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/follows', (req, res) => {
  try {
    res.json({ code: 0, data: sdb.getFollowBoard(String(req.query.status || '')) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/follow', (req, res) => {
  try {
    const seriesId = Number(req.body.seriesId);
    if (!seriesId) return res.json({ code: -1, msg: '缺少 seriesId' });
    sdb.setFollow(seriesId, req.body.status || 'watching', req.body.favorite);
    res.json({ code: 0, data: sdb.getSeriesById(seriesId), status: sdb.getFollowStatus(seriesId) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/unfollow', (req, res) => {
  try {
    const ok = sdb.unfollow(Number(req.body.seriesId));
    res.json({ code: 0, data: { removed: ok } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 删除番剧（级联清 episodes/follows/progress）；验证脚本与用户「移除追番」共用
router.post('/delete', (req, res) => {
  try {
    const seriesId = Number(req.body.seriesId);
    const ok = require('../utils/db').db.prepare('DELETE FROM series WHERE id = ?').run(seriesId).changes > 0;
    res.json({ code: 0, data: { removed: ok } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/upsert', (req, res) => {
  try {
    if (!String(req.body.title || '').trim()) return res.json({ code: -1, msg: '缺少 title' });
    res.json({ code: 0, data: sdb.upsertSeries(req.body) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/episode/progress', (req, res) => {
  try {
    const episodeId = Number(req.body.episodeId);
    if (!episodeId) return res.json({ code: -1, msg: '缺少 episodeId' });
    res.json({
      code: 0,
      data: sdb.setEpisodeProgress(episodeId, {
        position: req.body.position,
        duration: req.body.duration,
        watched: req.body.watched == null ? -1 : req.body.watched
      })
    });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/episode/link', (req, res) => {
  try {
    const ok = sdb.linkEpisodeMovie(req.body.episodeId, req.body.movieId);
    res.json({ code: 0, data: { linked: ok } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 回填单部番的分集（按标题搜 AniList 拿集数，生成第1..N集占位；幂等）
router.post('/:id/backfill-episodes', async (req, res) => {
    try {
        const seriesId = Number(req.params.id);
        if (!sdb.getSeriesById(seriesId)) return res.json({ code: -1, msg: '番剧不存在' });
        const r = await require('../utils/series-episodes').backfillSeries(seriesId, { force: req.body.force === true });
        res.json({ code: r.ok ? 0 : -1, data: r, msg: r.reason || '' });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// ---- 带 /:id 的路径（字面路径已处理完） ----
router.post('/:id/episodes', (req, res) => {
  try {
    const seriesId = Number(req.params.id);
    if (!sdb.getSeriesById(seriesId)) return res.json({ code: -1, msg: '番剧不存在' });
    const data = sdb.bulkUpsertEpisodes(seriesId, req.body.seasonNo || 1, req.body.episodes || []);
    res.json({ code: 0, data });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/:id/episodes', (req, res) => {
  try {
    res.json({ code: 0, data: sdb.getEpisodes(req.params.id, req.query.seasonNo || 1) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/:id/progress', (req, res) => {
  try {
    res.json({ code: 0, data: sdb.getEpisodeProgressMap(req.params.id) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/:id/detail', (req, res) => {
  try {
    const detail = sdb.getSeriesDetail(req.params.id);
    if (!detail) return res.json({ code: -1, msg: '番剧不存在' });
    res.json({ code: 0, data: detail });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 裸 /:id 放最后
router.get('/:id', (req, res) => {
  try {
    const s = sdb.getSeriesById(req.params.id);
    if (!s) return res.json({ code: -1, msg: '番剧不存在' });
    res.json({ code: 0, data: s });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
