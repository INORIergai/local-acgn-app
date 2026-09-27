/**
 * round37 · 封面缓存回收（GC）
 *
 * 背景（用户实测提出）：cache/posters 里 1.84GB，其中 1.36GB / 11036 个文件
 * 已经没有任何一条影片记录引用 —— 全是「换封面 / 批量换海报 / 重刮」后留下的旧图。
 * 根因：
 *   · upload-poster / upload-poster-url：文件名 = md5(filePath + 时间戳)，每次都新文件，且从不删旧的
 *   · batch-poster（一键批量换海报）：同上，3000 部跑一轮就多 3000 个文件
 *   · change-poster：只删 posterPath 那份，localPosterPath 存的是绝对路径，
 *     path.join(routes/../, 'D:/xxx') 拼出不存在 ⇒ 那份根本删不掉
 *   · 自动扫描链路用的是 md5(filePath) 稳定哈希 ⇒ 会覆盖同名，不算泄漏
 *
 * 本模块提供三件事：
 *   1. retirePoster()：换封面时回收「上一张」（引用安全：别人还在用就不删）
 *   2. scanOrphans()：盘点孤儿文件（可释放空间）
 *   3. gc() / purgeTrash()：把孤儿移进回收目录，确认后再彻底删除
 *
 * 安全边界：只动 cache/posters 与 cache/_poster-trash 两个目录内的普通文件，
 * basename 一律重新拼接，杜绝路径穿越。
 */

const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const ROOT = path.resolve(__dirname, '..');
const POSTER_DIR = path.join(ROOT, 'cache', 'posters');
const TRASH_DIR = path.join(ROOT, 'cache', '_poster-trash');

let _refCache = { at: 0, set: null };
const REF_TTL = 30 * 1000;

function human(n) {
  if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024).toFixed(1) + ' KB';
}

/** 把 posterPath / localPosterPath 归一成缓存文件名（可能是相对名，也可能是绝对路径） */
function cacheNameOf(p) {
  if (!p || typeof p !== 'string') return null;
  const b = path.basename(p.replace(/\\/g, '/'));
  if (!b || b === '.' || b === '..') return null;
  return b;
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/** 当前被任意影片引用的缓存文件名集合（带 30s 缓存，换封面高频调用也不卡） */
function referencedNames(force) {
  const now = Date.now();
  if (!force && _refCache.set && (now - _refCache.at) < REF_TTL) return _refCache.set;
  const set = new Set();
  try {
    const rows = db.prepare('SELECT posterPath, localPosterPath FROM movies').all();
    for (const r of rows) {
      const a = cacheNameOf(r.posterPath); if (a) set.add(a);
      const b = cacheNameOf(r.localPosterPath); if (b) set.add(b);
    }
  } catch (e) {
    console.log('[封面GC] 读取引用失败:', e.message);
  }
  _refCache = { at: now, set };
  return set;
}

function invalidateRefCache() {
  _refCache = { at: 0, set: null };
}

/**
 * 换封面时调用：回收这部片「上一张」缓存图。
 * @param oldRefs  {string[]} 更新数据库之前读到的 posterPath / localPosterPath
 * @param keepName {string}   新的缓存文件名（绝不能删）
 * @returns {removed:number, bytes:number, skipped:string[]}
 */
function retirePoster(oldRefs, keepName) {
  const out = { removed: 0, bytes: 0, skipped: [] };
  const keep = cacheNameOf(keepName);
  const ref = referencedNames();
  for (const raw of (oldRefs || [])) {
    const name = cacheNameOf(raw);
    if (!name || name === keep) continue;
    // 还有别的影片在用 ⇒ 不动。posterPath 有裸名/相对两种存法、localPosterPath 有相对/绝对
    // 两种存法，用 LIKE 兜住全部形态（文件名是 hex hash，不含 % _ 等通配符，安全）。
    let inUseElsewhere = false;
    try {
      const c = db.prepare(
        'SELECT COUNT(*) c FROM movies WHERE posterPath LIKE ? OR localPosterPath LIKE ?'
      ).get('%' + name, '%' + name).c;
      inUseElsewhere = c > 0;
    } catch (e) { inUseElsewhere = false; }
    if (inUseElsewhere) { out.skipped.push(name + ' (仍被引用)'); continue; }

    const full = path.join(POSTER_DIR, name);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    try {
      const size = fs.statSync(full).size;
      fs.unlinkSync(full);
      out.removed++; out.bytes += size;
    } catch (e) {
      out.skipped.push(name + ' (' + e.message + ')');
    }
  }
  invalidateRefCache();
  return out;
}

/** 盘点：缓存目录现状 + 孤儿文件 */
function scanOrphans() {
  ensureDir(POSTER_DIR);
  const files = fs.readdirSync(POSTER_DIR).filter(f => {
    try { return fs.statSync(path.join(POSTER_DIR, f)).isFile(); } catch (e) { return false; }
  });
  const ref = referencedNames(true);
  let totalBytes = 0, orphanBytes = 0;
  const orphans = [], missing = [];
  for (const f of files) {
    const size = fs.statSync(path.join(POSTER_DIR, f)).size;
    totalBytes += size;
    if (ref.has(f)) continue;
    orphans.push({ name: f, size, mtime: fs.statSync(path.join(POSTER_DIR, f)).mtimeMs });
    orphanBytes += size;
  }
  for (const n of ref) if (!fs.existsSync(path.join(POSTER_DIR, n))) missing.push(n);
  return {
    dir: POSTER_DIR,
    files: files.length, totalBytes, totalHuman: human(totalBytes),
    orphans, orphanCount: orphans.length, orphanBytes, orphanHuman: human(orphanBytes),
    referenced: ref.size, missingCount: missing.length, missing
  };
}

/**
 * 清理孤儿。
 * @param {object} opt
 *   mode: 'quarantine'(默认，移到 cache/_poster-trash/<ts>，可逆) | 'delete'(直接删，不可逆)
 *   minAgeHours: 只处理修改时间早于 N 小时前的文件（默认 0 = 全处理）
 *   limit: 最多处理多少个（默认不限）
 */
function gc(opt) {
  const o = opt || {};
  const mode = o.mode === 'delete' ? 'delete' : 'quarantine';
  const minAgeMs = (Number(o.minAgeHours) || 0) * 3600 * 1000;
  const limit = Number(o.limit) || Infinity;
  const scan = scanOrphans();
  const cut = Date.now() - minAgeMs;

  let done = 0, bytes = 0, failed = 0;
  let trashDir = null;
  if (mode === 'quarantine') {
    trashDir = path.join(TRASH_DIR, 'gc-' + new Date().toISOString().replace(/[:.]/g, '-'));
    ensureDir(trashDir);
  }

  for (const it of scan.orphans) {
    if (done >= limit) break;
    if (minAgeMs > 0 && it.mtime > cut) continue;
    const src = path.join(POSTER_DIR, it.name);
    try {
      if (mode === 'delete') {
        fs.unlinkSync(src);
      } else {
        fs.renameSync(src, path.join(trashDir, it.name));
      }
      done++; bytes += it.size;
    } catch (e) {
      failed++;
    }
  }
  invalidateRefCache();
  return {
    mode, done, failed, bytes, human: human(bytes),
    trashDir, remaining: scan.orphanCount - done,
    before: { files: scan.files, orphans: scan.orphanCount, totalHuman: scan.totalHuman }
  };
}

/** 回收目录信息 */
function trashInfo() {
  if (!fs.existsSync(TRASH_DIR)) return { exists: false, dir: TRASH_DIR, count: 0, bytes: 0, human: '0 KB', batches: [] };
  const batches = [];
  let count = 0, bytes = 0;
  for (const d of fs.readdirSync(TRASH_DIR)) {
    const full = path.join(TRASH_DIR, d);
    if (!fs.statSync(full).isDirectory()) continue;
    let c = 0, b = 0;
    for (const f of fs.readdirSync(full)) {
      try { const st = fs.statSync(path.join(full, f)); if (st.isFile()) { c++; b += st.size; } } catch (e) { }
    }
    batches.push({ name: d, count: c, bytes: b, human: human(b) });
    count += c; bytes += b;
  }
  return { exists: true, dir: TRASH_DIR, count, bytes, human: human(bytes), batches };
}

/** 彻底删除回收目录（不可逆） */
function purgeTrash() {
  const info = trashInfo();
  if (!info.exists || info.count === 0) return { purged: 0, bytes: info.bytes, human: info.human };
  let purged = 0, bytes = 0;
  for (const b of info.batches) {
    const dir = path.join(TRASH_DIR, b.name);
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        fs.unlinkSync(p); purged++; bytes += st.size;
      } catch (e) { }
    }
    try { fs.rmdirSync(dir); } catch (e) { }
  }
  return { purged, bytes, human: human(bytes) };
}

/** 把回收目录里的文件放回缓存目录（误删回滚） */
function restoreTrash() {
  const info = trashInfo();
  if (!info.exists) return { restored: 0 };
  ensureDir(POSTER_DIR);
  let restored = 0;
  for (const b of info.batches) {
    const dir = path.join(TRASH_DIR, b.name);
    for (const f of fs.readdirSync(dir)) {
      const src = path.join(dir, f);
      const dst = path.join(POSTER_DIR, f);
      try { if (fs.statSync(src).isFile()) { fs.renameSync(src, dst); restored++; } } catch (e) { }
    }
    try { fs.rmdirSync(dir); } catch (e) { }
  }
  invalidateRefCache();
  return { restored };
}

module.exports = {
  POSTER_DIR, TRASH_DIR,
  cacheNameOf, referencedNames, invalidateRefCache,
  retirePoster, scanOrphans, gc, trashInfo, purgeTrash, restoreTrash, human
};
