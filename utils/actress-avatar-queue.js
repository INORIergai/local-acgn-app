/**
 * utils/actress-avatar-queue.js —— 女优头像「搭车」补抓队列（round141）
 * ---------------------------------------------------------------------------
 * 用户反馈：女优标签里有一批没有头像，只有在演员库一个个点 ⟳ 才补得上。
 * 期望：编辑影片 / 更换海报时，顺手把这部片子女优缺的头像补掉。
 *
 * 设计纪律（照抄 round133 批量改名的几条老规矩）：
 *  ① **串行 + 限速**：javbus 对并发敏感（实测高并发直接 403），一次只跑一位，
 *     每位之间 700ms（与 routes/actress.js 的批量刮削同口径）。
 *  ② **只补缺**：已有头像的女优绝不重抓（幂等；也避免把用户手动设的头像覆盖掉）。
 *  ③ **不阻塞请求**：调用方只把名字塞进队列就返回，HTTP 立刻响应，抓取在后台跑完。
 *  ④ **失败静默计入统计**：网络抖动、javbus 找不到人都不算错误，不弹红字，
 *     结束后只在「有补到东西」时发一条 operation 通知（toast，不落库）。
 *  ⑤ **同一批只提示一次**：队列空了才汇总，避免 3 位女优刷 3 条通知。
 *
 * 对外：
 *   queueForMovie(movieId, {source})  → 返回排队条数（0 = 都有头像/没有女优）
 *   queueNames(names, {source})       → 返回新增排队条数
 *   status()                          → { queued, running, done, ok, fail, lastSource }
 */

// ★ 注意：utils/db 导出的是模块对象 —— 原生 sqlite 句柄在 .db 上，
//   而 updateActressProfile 是模块自己的导出（挂在模块上，不在句柄上）。
const { db, updateActressProfile } = require('./db');
const { fetchActressProfile } = require('./crawler/actress-avatar');
const { notify } = require('./notify');

const GAP_MS = 1100;         // 女优之间的间隔（javbus 对被连续抓取很敏感：700ms 实测会 403）
const RETRY_WAIT_MS = 2500;  // 失败后隔久一点重试一次
const MAX_PER_BATCH = 12;    // 单次搭车最多补 12 位，防止一部片几十个标签把队列堵死

const pending = [];          // 待处理的女优名（FIFO）
const seen = new Set();      // 已在队列里/刚处理过（本轮去重）
let running = false;
let stats = { done: 0, ok: 0, fail: 0, lastSource: '', lastAt: 0 };
let lastBatch = { ok: 0, fail: 0, source: '' };

const namesWithoutAvatarByMovie = db.prepare(`
  SELECT a.id, a.name, a.avatar
  FROM actresses a
  JOIN movie_actress ma ON ma.actressId = a.id
  WHERE ma.movieId = ? AND (a.avatar IS NULL OR a.avatar = '')
`);
const actressByName = db.prepare('SELECT id, name, avatar FROM actresses WHERE name = ?');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function push(name, source) {
  const n = String(name || '').trim();
  if (!n) return 0;
  if (seen.has(n)) return 0;
  if (pending.length >= MAX_PER_BATCH) return 0;
  seen.add(n);
  pending.push({ name: n, source: source || 'manual' });
  return 1;
}

function queueNames(names, opts) {
  const source = (opts && opts.source) || 'manual';
  let added = 0;
  (names || []).forEach(n => { added += push(n, source); });
  if (added) pump();
  return added;
}

function queueForMovie(movieId, opts) {
  const id = parseInt(movieId, 10);
  if (!id) return 0;
  let rows = [];
  try { rows = namesWithoutAvatarByMovie.all(id) || []; } catch (e) { rows = []; }
  if (!rows.length) return 0;
  return queueNames(rows.map(r => r.name), { source: (opts && opts.source) || ('movie:' + id) });
}

async function pump() {
  if (running) return;
  running = true;
  const batchStartOk = stats.ok;
  let batchOk = 0, batchFail = 0, source = '';
  try {
    while (pending.length) {
      const item = pending.shift();
      source = item.source || source;
      try {
        // 抓之前再确认一次「还是没头像」：队列排队期间可能已被别的路径补上
        const cur = actressByName.get(item.name);
        if (cur && cur.avatar) { batchFail++; continue; }   // 已有头像，算跳过
        /* ★ 连续抓取时 javbus 会间歇 403（searchStarByName 内部 catch 掉了，返回 null）。
           实测一部片 6 位女优连抓时全部失败、而单独抓同一个名字立即成功 ⇒ 必须重试。 */
        let prof = await fetchActressProfile(item.name);
        if (!prof) {
          await sleep(RETRY_WAIT_MS);
          prof = await fetchActressProfile(item.name);
        }
        if (prof && prof.avatarFile) {
          updateActressProfile.run({
            name: item.name,
            avatar: prof.avatarFile,
            birthday: prof.birthday || '',
            height: prof.height || 0
          });
          batchOk++;
          stats.ok++;
          console.log(`[女优头像] 搭车补到：${item.name} → ${prof.avatarFile}`);
        } else {
          console.warn(`[女优头像] 搭车未找到资料：${item.name}（重试后仍为空）`);
          batchFail++;
          stats.fail++;
        }
      } catch (e) {
        console.warn(`[女优头像] 搭车抓取异常 [${item.name}]:`, e.message);
        batchFail++;
        stats.fail++;
      }
      stats.done++;
      stats.lastSource = source;
      stats.lastAt = Date.now();
      await sleep(GAP_MS);
    }
  } finally {
    running = false;
    lastBatch = { ok: batchOk, fail: batchFail, source };
    // 只在「真补到了头像」时提示一次；全失败不打扰用户（javbus 抽风是常态）
    if (batchOk > 0) {
      try {
        notify('operation', `已补 ${batchOk} 位女优头像`,
          `搭车自动补抓完成${batchFail ? `（${batchFail} 位没找到资料）` : ''}。可在「演员库」看到新头像。`);
      } catch (e) { /* 通知失败不影响队列 */ }
    }
    seen.clear();   // 允许下一轮重新入队（用户可能手动清过头像）
  }
}

function status() {
  return {
    queued: pending.length,
    running,
    done: stats.done,
    ok: stats.ok,
    fail: stats.fail,
    lastSource: stats.lastSource,
    lastBatch
  };
}

module.exports = { queueForMovie, queueNames, status };
