/**
 * round73 · 漫画 / 小说阅读进度（落库版）
 *
 * ── 替换掉什么 ────────────────────────────────────────────────
 * 原来 routes/comic.js:14 与 routes/novel.js:14 各有一个纯内存对象 `readingProgress`，
 * 写入接口全程没有 SQL ⇒ **重启即归零**。用户看到的「读到第几页」其实是假的，
 * 这也是「右上角进度提示」这个需求必须先做这层的原因。
 *
 * ── 判定规则（产品已确认：末页 + 95% 兜底，且读完保留位置）────────
 *   在读：cursor > 0 且 percent < 95
 *   读完：cursor === total-1（翻到末页）**或** percent >= 95（快速翻到底兜底）
 *   搁置：仅手动
 *   ★ manual=1 时自动规则只更新 cursor/percent，**不改 state** ——
 *     用户手动标的状态不能被自动判定改回去，否则会失去信任。
 *   ★ 读完**不删** cursor：重读从原处继续（与影视库「看完删进度」不同，
 *     因为收藏者常回来重看某几页）。
 *
 * ── 存绝对位置而非只存百分比 ──────────────────────────────────
 * 漫画会追更。文件 100 页→200 页后，只存百分比会让昨天的 80% 漂移到 40% 的
 * 语义位置，用户会看到进度条「倒退」。存 cursor+total，只在总页数变化时才重算。
 */

const { db } = require('./db');

const DONE_THRESHOLD = 95;   // 与影视库同一阈值，全库口径统一

const _upsert = db.prepare(`
  INSERT INTO media_progress (movieId, kind, page, chapter, position, total, percent, state, manual, startedAt, finishedAt, updatedAt)
  VALUES (@movieId, @kind, @page, @chapter, @position, @total, @percent, @state, @manual, @startedAt, @finishedAt, @updatedAt)
  ON CONFLICT(movieId, kind) DO UPDATE SET
    page=@page, chapter=@chapter, position=@position, total=@total,
    percent=@percent, state=@state,
    startedAt=CASE WHEN media_progress.startedAt > 0 THEN media_progress.startedAt ELSE @startedAt END,
    finishedAt=CASE WHEN media_progress.finishedAt > 0 THEN media_progress.finishedAt ELSE @finishedAt END,
    updatedAt=@updatedAt
`);

const _markWatched = db.prepare('UPDATE movies SET watched = 1 WHERE id = ? AND watched = 0');

function normKind(kind) {
  return kind === 'novel' ? 'novel' : 'comic';
}

/**
 * 算百分比。total 未知（0）时返回 0 —— 前端据此不画进度线，不伪造进度。
 */
function calcPercent(cursor, total) {
  const c = Math.max(0, Number(cursor) || 0);
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((c / t) * 100)));
}

/**
 * 保存进度（阅读器每次翻页调用，已在前端做 1.2s 节流）。
 * @param {number} movieId
 * @param {'comic'|'novel'} kind
 * @param {{page?:number, chapter?:number, position?:number, total?:number}} data
 */
function saveMediaProgress(movieId, kind, data) {
  const k = normKind(kind);
  const id = parseInt(movieId, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('movieId 非法');

  const d = data || {};
  const page = Math.max(0, parseInt(d.page, 10) || 0);
  const chapter = Math.max(0, parseInt(d.chapter, 10) || 0);
  const position = Math.max(0, parseInt(d.position, 10) || 0);
  const total = Math.max(0, parseInt(d.total, 10) || 0);

  const cursor = k === 'novel' ? chapter : page;
  const percent = calcPercent(cursor, total);

  // 读旧行：手动标记过的，state 只能由用户改
  let old = null;
  try {
    old = db.prepare('SELECT state, manual, startedAt, finishedAt FROM media_progress WHERE movieId=? AND kind=?').get(id, k);
  } catch (e) { /* 表可能还没建（迁移前） */ }

  const manual = old && old.manual ? 1 : 0;
  let state = (old && old.state) || 'reading';
  if (!manual) {
    // 自动规则：到末页 或 ≥95% ⇒ done
    state = (total > 0 && (cursor >= total - 1 || percent >= DONE_THRESHOLD)) ? 'done' : 'reading';
  }
  // 手动状态是 done 时，即使 cursor 归 0（重读）也保持 done，除非用户改
  if (manual && state === 'done' && cursor === 0) {
    state = 'done';
  }

  const now = Date.now();
  // startedAt：首次开始；finishedAt：**首次**读完的时刻。
  // 为什么用 `||` 保留而不是每次覆盖 ——「读完保留位置」是已确认的产品决策，
  // 重读时不该把 finishedAt 推走，否则「今天读完几本」会把老书重复计进今天。
  const startedAt = (old && old.startedAt) ? old.startedAt : now;
  const finishedAt = state === 'done' ? ((old && old.finishedAt) ? old.finishedAt : now) : ((old && old.finishedAt) || 0);

  _upsert.run({
    movieId: id, kind: k, page, chapter, position, total,
    percent, state, manual, startedAt, finishedAt, updatedAt: now,
  });

  // 读完 → 同步 movies.watched（幂等：WHERE watched=0）
  // ⚠️ watched 不在 FTS 触发器的 WHEN 列里（db.js:81-93 只管 title/cleanName/avid/fileName/overview），
  //    写它不会触发索引重建。
  if (state === 'done') { try { _markWatched.run(id); } catch (e) { /* 忽略 */ } }

  return { percent, state, manual: !!manual, total, cursor };
}

/** 手动设状态；传 null 清除手动覆盖（回到自动判定） */
function setManualState(movieId, kind, state) {
  const k = normKind(kind);
  const id = parseInt(movieId, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error('movieId 非法');

  if (state === null || state === undefined || state === 'auto') {
    db.prepare('UPDATE media_progress SET manual=0, updatedAt=? WHERE movieId=? AND kind=?')
      .run(Date.now(), id, k);
    return { code: 0, msg: '已恢复为自动判定' };
  }
  const s = ['reading', 'done', 'shelved'].includes(state) ? state : 'reading';
  const row = db.prepare('SELECT total, percent, finishedAt FROM media_progress WHERE movieId=? AND kind=?').get(id, k);
  const now = Date.now();
  // 没有行也要能标（用户没读过就标搁置/读完）⇒ upsert。
  // ⚠️ INSERT 的 VALUES 与 ON CONFLICT DO UPDATE 必须用**同一套占位符**：
  //    混用 `?` 与 @name 会被 better-sqlite3 拒掉（Missing named parameters）。
  //    DO UPDATE 只改 state/manual/finishedAt/updatedAt —— 保留原有 cursor/percent，
  //    这样「手动标记」不会把用户的阅读位置清零。
  db.prepare(`
    INSERT INTO media_progress (movieId, kind, page, chapter, position, total, percent, state, manual, startedAt, finishedAt, updatedAt)
    VALUES (@movieId, @kind, 0, 0, 0, @total, @percent, @state, 1, @startedAt, @finishedAt, @updatedAt)
    ON CONFLICT(movieId, kind) DO UPDATE SET
      state=@state, manual=1, finishedAt=@finishedAt, updatedAt=@updatedAt
  `).run({
    movieId: id, kind: k,
    total: row ? (row.total || 0) : 0,
    percent: row ? (row.percent || 0) : 0,
    state: s,
    startedAt: now,
    // 手动标读完也算一次「读完」，要记时刻；标回 reading 时保留原 finishedAt（不推走）
    finishedAt: s === 'done' ? ((row && row.finishedAt) ? row.finishedAt : now) : ((row && row.finishedAt) || 0),
    updatedAt: now,
  });

  if (s === 'done') { try { _markWatched.run(id); } catch (e) { /* 忽略 */ } }
  else if (s === 'reading') { try { db.prepare('UPDATE movies SET watched=0 WHERE id=?').run(id); } catch (e) { } }

  return { code: 0, msg: '已标记', state: s };
}

/** 清除进度回到未读 */
function clearProgress(movieId, kind) {
  const k = normKind(kind);
  const id = parseInt(movieId, 10);
  db.prepare('DELETE FROM media_progress WHERE movieId=? AND kind=?').run(id, k);
  try { db.prepare('UPDATE movies SET watched=0 WHERE id=?').run(id); } catch (e) { }
  return { code: 0, msg: '已清除进度' };
}

/** 批量设状态。返回 skipped（被手动标记保护、没被覆盖的条目） */
function batchSetState(ids, kind, state) {
  const k = normKind(kind);
  const s = ['reading', 'done', 'shelved'].includes(state) ? state : 'reading';
  let changed = 0, skipped = 0;
  const list = (ids || []).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
  const run = db.transaction(() => {
    for (const id of list) {
      const r = setManualState(id, k, s);
      if (r) changed++; else skipped++;
    }
  });
  try { run(); } catch (e) { console.log('[媒体进度] 批量设状态失败:', e.message); }
  return { code: 0, changed, skipped, total: list.length, state: s };
}

/**
 * 批量读进度map（前端卡片区一次请求拿全，仿 routes/movie.js:778 的 /progress-map）
 * @param {'comic'|'novel'|'all'} kind
 * @returns {Object<string, {p:number,s:string,u:number,page:number,total:number}>}
 */
function getProgressMap(kind) {
  const k = kind === 'all' ? null : normKind(kind);
  const rows = k
    ? db.prepare('SELECT movieId, page, chapter, total, percent, state, updatedAt FROM media_progress WHERE kind=?').all(k)
    : db.prepare('SELECT movieId, page, chapter, total, percent, state, updatedAt FROM media_progress').all();
  const out = {};
  for (const r of rows) {
    out[r.movieId] = {
      p: Number(r.percent) || 0,
      s: r.state || 'reading',
      u: Number(r.updatedAt) || 0,
      c: k === 'novel' ? (Number(r.chapter) || 0) : (Number(r.page) || 0),  // cursor
      t: Number(r.total) || 0,                                             // total
    };
  }
  return out;
}

/** 统计：按状态计数（给筛选 chips 上的数字用） */
function statusCounts(kind) {
  const k = normKind(kind);
  try {
    const rows = db.prepare("SELECT state, COUNT(*) n FROM media_progress WHERE kind=? GROUP BY state").all(k);
    const m = { reading: 0, done: 0, shelved: 0 };
    for (const r of rows) m[r.state] = r.n;
    return m;
  } catch (e) { return { reading: 0, done: 0, shelved: 0 }; }
}

/**
 * 读单条进度，返回**与旧内存对象同构**的形状。
 * 旧的 `readingProgress[id] = { page, chapter, position, lastRead }` 是内存对象，
 * 重启即丢。这里从库里读并保持同样的字段名 ⇒ 读取它的接口（comic /info、stats 等）
 * 一行都不用改，前端也零感知。
 * @returns {{page:number, chapter:number, position:number, total:number, percent:number, state:string, lastRead:string|null}}
 */
function getProgressRow(movieId, kind) {
  const k = normKind(kind);
  const id = parseInt(movieId, 10);
  const empty = { page: 0, chapter: 0, position: 0, total: 0, percent: 0, state: '', lastRead: null };
  if (!Number.isFinite(id) || id <= 0) return empty;
  let r = null;
  try {
    r = db.prepare('SELECT page, chapter, position, total, percent, state, updatedAt FROM media_progress WHERE movieId=? AND kind=?')
      .get(id, k);
  } catch (e) { return empty; }
  if (!r) return empty;
  return {
    page: Number(r.page) || 0,
    chapter: Number(r.chapter) || 0,
    position: Number(r.position) || 0,
    total: Number(r.total) || 0,
    percent: Number(r.percent) || 0,
    state: r.state || 'reading',
    lastRead: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  };
}

/**
 * ★ round74：今日/近 N 日聚合（首页看板 + 统计中心共用）
 *
 * 读时长来自 reading_history（duration 秒 + readDate 毫秒），
 * 读完本数来自 media_progress.finishedAt —— 两者口径不同，必须分开再合并，
 * 否则「今天读完 3 本」会被算成时长指标的一部分。
 *
 * @param {{kind?:string, days?:number}} opt
 *   kind: 'comic' | 'novel' | 'all'（默认 all）
 *   days: 统计最近多少天，含今天（默认 7）
 * @returns {{days:Array<{date,seconds,books}>, today:{seconds,books}, total:{seconds,books},
 *            streakDays:number, readingDays:number}}
 */
function readingDigest(opt) {
    const o = opt || {};
    const days = Math.max(1, Math.min(3650, Number(o.days) || 7));
    const kinds = o.kind && o.kind !== 'all' ? [normKind(o.kind)] : ['comic', 'novel'];

    // ── 本地零点 → 毫秒（按本地时区，不用 UTC，否则凌晨 8 点前的记录会算到昨天）──
    const now = new Date();
    const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const from = localMidnight - (days - 1) * 86400000;

    const marks = kinds.map(() => '?').join(',');
    const since = localMidnight - days * 86400000;   // streak 要多扫一点

    // 时长：reading_history
    const durRows = db.prepare(
        `SELECT readDate, SUM(duration) s FROM reading_history
          WHERE type IN (${marks}) AND readDate >= ? GROUP BY date(readDate/1000,'unixepoch','localtime')`
    ).all(...kinds, since);

    // 读完本数：media_progress.finishedAt
    const finRows = db.prepare(
        `SELECT finishedAt FROM media_progress
          WHERE kind IN (${marks}) AND state = 'done' AND finishedAt >= ?`
    ).all(...kinds, since);

    const DAY = 86400000;
    const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const map = new Map();
    for (let i = 0; i < days; i++) {
        const ts = localMidnight - i * DAY;
        map.set(dayKey(ts), { date: dayKey(ts), ts, seconds: 0, books: 0 });
    }
    for (const r of durRows) {
        const k = dayKey(r.readDate);
        if (map.has(k)) map.get(k).seconds += (Number(r.s) || 0);
    }
    const todayKey = dayKey(Date.now());
    for (const r of finRows) {
        const k = dayKey(r.finishedAt);
        if (map.has(k)) map.get(k).books++;
    }

    const list = [...map.values()].sort((a, b) => a.ts - b.ts);   // 旧 → 新
    const today = map.get(todayKey) || { date: todayKey, seconds: 0, books: 0 };
    const total = list.reduce((a, d) => ({ seconds: a.seconds + d.seconds, books: a.books + d.books }), { seconds: 0, books: 0 });

    // 连续阅读天数：从今天（或昨天）往前数连续有记录的天
    const allDays = db.prepare(
        `SELECT DISTINCT date(readDate/1000,'unixepoch','localtime') d FROM reading_history
          WHERE type IN (${marks}) AND readDate >= ?`
    ).all(...kinds, localMidnight - 400 * DAY).map(r => r.d);
    const set = new Set(allDays);
    let streak = 0;
    let cursor = localMidnight;
    if (!set.has(dayKey(cursor))) cursor -= DAY;      // 今天还没读，从昨天开始数
    while (set.has(dayKey(cursor))) { streak++; cursor -= DAY; }

    return {
        days: list, today, total, streakDays: streak,
        readingDays: allDays.length,
    };
}

/** 读今日目标（时长 + 本数）；没有就返回默认 10 分钟 / 5 本 */
function getGoal(scope) {
    const sc = ['comic', 'novel', 'all'].includes(scope) ? scope : 'all';
    let row = null;
    try {
        row = db.prepare("SELECT * FROM reading_goals WHERE kind='daily' AND scope=?").get(sc);
    } catch (e) { /* 表还没建 */ }
    if (!row) row = db.prepare("SELECT * FROM reading_goals WHERE kind='daily' AND scope='all'").get();
    return {
        scope: sc,
        minutes: row ? (Number(row.minutes) || 0) : 10,
        books: row ? (Number(row.books) || 0) : 5,
    };
}

/** 存今日目标 */
function setGoal(scope, patch) {
    const sc = ['comic', 'novel', 'all'].includes(scope) ? scope : 'all';
    const cur = getGoal(sc);
    const minutes = patch && patch.minutes != null ? Math.max(0, parseInt(patch.minutes, 10) || 0) : cur.minutes;
    const books = patch && patch.books != null ? Math.max(0, parseInt(patch.books, 10) || 0) : cur.books;
    db.prepare(`
        INSERT INTO reading_goals (kind, scope, minutes, books, updatedAt) VALUES ('daily', ?, ?, ?, ?)
        ON CONFLICT(kind, scope) DO UPDATE SET minutes=@minutes, books=@books, updatedAt=@updatedAt
    `).run(sc, minutes, books, Date.now());
    return getGoal(sc);
}

module.exports = {
    DONE_THRESHOLD,
    calcPercent,
    saveMediaProgress,
    getProgressRow,
    setManualState,
    clearProgress,
    batchSetState,
    getProgressMap,
    statusCounts,
    readingDigest,
    getGoal,
    setGoal,
};
