/**
 * round73 · 阅读进度 / 状态接口（漫画 + 小说统一入口）
 *
 * 为什么不挂在 /api/comic 和 /api/novel 下面：
 *   进度「写入」已经各自在既有路由里（routes/comic.js POST /:id/progress），
 *   那是老接口、必须保留兼容（两个阅读器在用）。而「读 map / 改状态 / 批量 / 清除」
 *   是新能力，逻辑完全一致，分开挂在两处只会写两遍。
 *
 * 路由表（挂载点 /api/media）：
 *   GET  /api/media/progress-map?type=comic|novel|all   批量读，卡片区一次拿全
 *   GET  /api/media/stats?type=comic|novel              按状态计数（筛选 chips 的数字）
 *   POST /api/media/:kind/:id/status                    手动设状态；传 null 交回自动判定
 *   POST /api/media/:kind/:id/progress/clear           清除进度回到未读
 *   POST /api/media/:kind/batch/status                  批量设状态
 */
const express = require('express');
const router = express.Router();
const mp = require('../utils/media-progress');

const KINDS = ['comic', 'novel'];

/** kind 归一 + 校验：非法 kind 直接判错，别让它去建脏数据 */
function kindOf(v) {
  const k = String(v || '').toLowerCase();
  return KINDS.includes(k) ? k : null;
}

// 批量读进度（前端卡片区首屏拉一次）
router.get('/progress-map', (req, res) => {
  try {
    const type = String(req.query.type || 'all');
    const k = type === 'all' ? null : kindOf(type);
    if (type !== 'all' && !k) return res.json({ code: -1, msg: 'type 只能是 comic / novel / all' });
    res.json({ code: 0, data: mp.getProgressMap(k || 'all') });
  } catch (e) {
    console.log('[媒体进度] progress-map 异常', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

// 状态计数（筛选 chips 上的数字）
router.get('/stats', (req, res) => {
  try {
    const k = kindOf(req.query.type) || 'comic';
    res.json({ code: 0, data: mp.statusCounts(k) });
  } catch (e) {
    res.json({ code: -1, msg: e.message });
  }
});

// 手动设状态（reading / done / shelved；传 null 清除手动覆盖）
router.post('/:kind/:id/status', (req, res) => {
  try {
    const k = kindOf(req.params.kind);
    if (!k) return res.json({ code: -1, msg: 'kind 只能是 comic / novel' });
    const body = req.body || {};
    const st = body.status === null ? null : String(body.status || '');
    const r = mp.setManualState(req.params.id, k, st);
    res.json(Object.assign({ code: 0 }, r, { data: mp.getProgressRow(req.params.id, k) }));
  } catch (e) {
    console.log('[媒体进度] 设状态异常', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

// 清除进度，回到未读
router.post('/:kind/:id/progress/clear', (req, res) => {
  try {
    const k = kindOf(req.params.kind);
    if (!k) return res.json({ code: -1, msg: 'kind 只能是 comic / novel' });
    const r = mp.clearProgress(req.params.id, k);
    res.json(Object.assign({ code: 0 }, r));
  } catch (e) {
    res.json({ code: -1, msg: e.message });
  }
});

// 批量设状态
router.post('/:kind/batch/status', (req, res) => {
  try {
    const k = kindOf(req.params.kind);
    if (!k) return res.json({ code: -1, msg: 'kind 只能是 comic / novel' });
    const body = req.body || {};
    const r = mp.batchSetState(body.ids, k, String(body.status || 'done'));
    res.json(r);
  } catch (e) {
    console.log('[媒体进度] 批量设状态异常', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

// ★ round74：阅读聚合（首页看板 + 统计中心共用）
//   返回最近 N 天的「时长(秒) + 读完本数」逐日序列、今日值、连续天数，
//   以及今日目标（时长分钟 / 本数）与达成率 —— 「今日目标 = 时长 + 本数」两个独立指标。
router.get('/digest', (req, res) => {
  try {
    const kind = String(req.query.type || 'all');
    const k = kind === 'all' ? 'all' : kindOf(kind);
    if (!k) return res.json({ code: -1, msg: 'type 只能是 comic / novel / all' });
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 7));
    const scope = String(req.query.scope || k || 'all');

    const d = mp.readingDigest({ kind: k, days });
    const goal = mp.getGoal(scope);
    const t = d.today;

    const pctOf = (now, target) => (target > 0 ? Math.min(999, Math.round((now / target) * 100)) : 0);
    res.json({
      code: 0,
      data: {
        days: d.days,
        today: t,
        total: d.total,
        streakDays: d.streakDays,
        readingDays: d.readingDays,
        goal: {
          ...goal,
          minutesPct: pctOf(Math.round(t.seconds / 60), goal.minutes),
          booksPct: pctOf(t.books, goal.books),
        },
      },
    });
  } catch (e) {
    console.log('[阅读聚合] 异常', e.message);
    res.json({ code: -1, msg: e.message });
  }
});

// 读写今日目标
router.get('/goal', (req, res) => {
  try {
    const scope = String(req.query.scope || 'all');
    res.json({ code: 0, data: mp.getGoal(scope) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/goal', (req, res) => {
  try {
    const b = req.body || {};
    const scope = String(b.scope || 'all');
    res.json({ code: 0, data: mp.setGoal(scope, b) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
