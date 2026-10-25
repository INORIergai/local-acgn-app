/**
 * 小说扫描器
 * 扫描本地小说文件，支持 txt、epub、pdf、mobi 等格式
 *
 * ★★ round112 重构：两阶段扫描（先入库，后补图）
 *   旧实现串行 `await processSingleNovelFile()`，每个文件都同步等 zlibrary 刮削
 *   （浏览器通道，源挂了单文件 ~4.5s，4095 个文件 = 5 小时以上；而启动扫描链
 *    排在漫画后面，漫画不结束小说永远轮不到 —— 实机库里 novel 一直是 0 条）。
 *
 *   现在：Phase A 本地索引（并发 8，一个请求都不发）→ 立刻可见；
 *        Phase B 后台补封面（EPUB 内封面 / PDF 首页），不阻塞扫描状态与目录监控。
 *        网络元数据只在单文件路径做，并且过熔断（utils/scrape-guard.js）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  db,
  getAllMovies,
  deleteMovieByPath,
  upsertMovie,
  getMovieByPath,
  updateMovieRelations,
  recalcHotScore,
  recordScrapeFailure,
  clearScrapeFailure
} = require('./db');
const { parseNfo, generateNfo } = require('./nfo_utils');
const { resetInlineBudget, inlineContentCover } = require('./cover-fallback');
const { poolMap } = require('./pool');
const guard = require('./scrape-guard');
const config = require('./config');
const { extractSeriesKey } = require('./series-group');

// 支持的小说格式
const NOVEL_EXTENSIONS = ['.txt', '.epub', '.pdf', '.mobi', '.azw3', '.docx', '.doc', '.rtf'];

// 扫描状态
let novelScanStatus = {
  running: false,
  phase: 'idle',      // round112：idle | index | enrich | done
  total: 0,
  current: 0,
  currentFile: '',
  stats: {
    localHit: 0,
    webScraped: 0,
    failed: 0,
    skipped: 0
  }
};

function indexConcurrency() {
  const n = Number(config.scan && config.scan.indexConcurrency);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : 8;
}

/** 站点标签（与 comic-scanner 同一套判定，见 utils/title-clean.js） */
const { prettyTitle, cleanStoredTitles } = require('./title-clean');

/**
 * 递归获取目录下所有小说文件
 */
function getNovelFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return results; }
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...getNovelFiles(fullPath));
    } else {
      const ext = path.extname(item.name).toLowerCase();
      if (NOVEL_EXTENSIONS.includes(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/** 同目录同名图片 / cover.jpg 当封面 */
function findNovelCover(filePath) {
  try {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const stem = path.basename(filePath, ext);
    for (const coverExt of ['.jpg', '.jpeg', '.png', '.webp']) {
      const p = path.join(dir, stem + coverExt);
      if (fs.existsSync(p)) return p;
    }
    for (const name of ['cover.jpg', 'folder.jpg', 'poster.jpg']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

function cacheLocalCover(filePath, localCover) {
  try {
    const hash = crypto.createHash('md5').update(filePath).digest('hex');
    const coverExt = path.extname(localCover);
    const dir = path.join(__dirname, '../cache/posters');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cachePath = path.join(dir, hash + coverExt);
    if (!fs.existsSync(cachePath)) fs.copyFileSync(localCover, cachePath);
    return { posterPath: hash + coverExt, localPosterPath: localCover };
  } catch (e) {
    return { posterPath: '', localPosterPath: '' };
  }
}

/**
 * Phase A：本地入库（不联网）
 */
async function indexNovel(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const cleanName = fileName.replace(ext, '');

  try {
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const localCover = findNovelCover(filePath);
    const prev = getMovieByPath.get(filePath) || null;

    let nfoData = null;
    try {
      const nfoPath = path.join(path.dirname(filePath), path.basename(fileName, ext) + '.nfo');
      if (fs.existsSync(nfoPath)) nfoData = parseNfo(nfoPath);
    } catch (e) { /* NFO 坏了就当没有 */ }

    const prevTitle = prev && String(prev.title || '').trim();
    let title;
    if (nfoData && nfoData.title) title = prettyTitle(nfoData.title);
    else if (prevTitle && prevTitle !== cleanName) title = prevTitle;
    else title = prettyTitle(cleanName);

    const overview = (nfoData && nfoData.plot) || (prev && prev.overview) || '';
    const releaseDate = (nfoData && nfoData.premiered) || (prev && prev.releaseDate) || '';
    const genres = (nfoData && nfoData.genres && nfoData.genres.join(', ')) || (prev && prev.genres) || '';

    const cov = localCover ? cacheLocalCover(filePath, localCover) : { posterPath: '', localPosterPath: '' };

    upsertMovie.run({
      filePath,
      fileName,
      type: 'novel',
      avid: '',
      cleanName,
      fileSize,
      duration: 0,
      width: 0,
      height: 0,
      tmdbId: null,
      title,
      originalTitle: (nfoData && nfoData.originalTitle) || (prev && prev.originalTitle) || '',
      overview,
      releaseDate,
      posterPath: prev ? (cov.posterPath || null) : cov.posterPath,
      localPosterPath: prev ? (cov.localPosterPath || null) : cov.localPosterPath,
      country: '',
      genres,
      producer: (prev && prev.producer) || '',
      publisher: '',
      serial: extractSeriesKey(title || cleanName) || '',
      director: '',
      score: 0,
      source: nfoData ? 'local-nfo' : ((prev && prev.source) || 'local'),
      lastScanTime: Date.now(),
      addedTime: Date.now()
    });

    // ★ 按路径反查 id（UPSERT 命中旧行时 lastInsertRowid 不可靠）
    const row = getMovieByPath.get(filePath);
    try {
      if (row && nfoData && nfoData.genres && nfoData.genres.length) {
        updateMovieRelations(row.id, { tags: nfoData.genres, actresses: [] });
        recalcHotScore(row.id);
      }
    } catch (e) { /* 忽略 */ }

    const exportCfg = config.export || {};
    if (exportCfg.enableNfoExport && !nfoData) {
      try {
        const dir = path.dirname(filePath);
        const stem = path.basename(fileName, ext);
        const nfoPath = path.join(dir, stem + '.nfo');
        if (!fs.existsSync(nfoPath) || exportCfg.overwriteExisting) {
          generateNfo({
            title,
            originalTitle: '',
            num: '',
            overview,
            releaseDate,
            genres: [],
            actors: [],
            thumb: cov.posterPath
          }, nfoPath);
        }
      } catch (e) {
        console.log(`[导出NFO失败] ${fileName}:`, e.message);
      }
    }

    novelScanStatus.stats.localHit++;
    return { ok: true, id: row ? row.id : null, title, hasPoster: !!cov.posterPath };
  } catch (e) {
    novelScanStatus.stats.failed++;
    console.log(`  ✗ 入库失败: ${fileName} → ${e.message}`);
    return { ok: false, error: e.message };
  }
}

let _zlib = null;
function zlib() {
  if (!_zlib) {
    const ZLibraryCrawler = require('./crawler/zlibrary');
    _zlib = new ZLibraryCrawler(config.sources?.zlibrary || {});
  }
  return _zlib;
}

/**
 * Phase B：给一条已入库的小说补元数据 / 封面
 */
async function enrichNovel(filePath, opts) {
  const o = opts || {};
  const wantNetwork = o.network === true;
  const wantCover = o.contentCover !== false;

  const rec = getMovieByPath.get(filePath);
  if (!rec) return { ok: false, reason: 'no-row' };

  const fileName = rec.fileName || path.basename(filePath);
  const ext = path.extname(fileName);
  let webData = null;
  let webAttempted = false;
  let posterPath = rec.posterPath || '';

  if (wantNetwork && guard.canTry('zlibrary')) {
    webAttempted = true;
    try {
      const crawler = zlib();
      webData = await crawler.searchByFileName(fileName);
      if (webData) guard.ok('zlibrary');
      else if (crawler.networkFailed) guard.fail('zlibrary', crawler.lastError || '镜像全部不可达');
      else guard.ok('zlibrary');       // 源通着，只是没匹配到
    } catch (e) {
      guard.fail('zlibrary', e);
      console.log(`  网络刮削失败: ${e.message}`);
    }
  }

  if (webData) {
    novelScanStatus.stats.webScraped++;
    const title = webData.title || rec.title;
    try {
      db.prepare(`UPDATE movies SET title=@title, originalTitle=@originalTitle,
                  overview=@overview, producer=@producer, releaseDate=@releaseDate,
                  source=@source, serial=@serial WHERE id=@id`).run({
        title,
        originalTitle: rec.originalTitle || webData.originalTitle || '',
        overview: rec.overview || webData.description || '',
        producer: rec.producer || webData.author || '',
        releaseDate: rec.releaseDate || webData.releaseDate || '',
        source: 'zlibrary',
        serial: rec.serial || extractSeriesKey(title) || '',
        id: rec.id
      });
    } catch (e) { /* 忽略 */ }

    if (!posterPath && webData.cover) {
      try {
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        const cachePath = path.join(__dirname, '../cache/posters', `${hash}.jpg`);
        const videoDir = path.dirname(filePath);
        const baseName = path.basename(filePath, ext);
        const localCoverPath = path.join(videoDir, `${baseName}-poster.jpg`);
        const { downloadPoster } = require('./poster-fetcher');
        await downloadPoster(webData.cover, localCoverPath);
        if (fs.existsSync(localCoverPath)) fs.copyFileSync(localCoverPath, cachePath);
        posterPath = `${hash}.jpg`;
        db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?')
          .run(posterPath, `cache/posters/${hash}.jpg`, rec.id);
      } catch (e) {
        console.log(`  小说封面下载失败: ${e.message}`);
      }
    }
  }

  if (wantCover && !posterPath) {
    try {
      const r = await inlineContentCover(db, filePath, s => console.log('    ' + s));
      if (r && r.ok && r.posterPath) {
        novelScanStatus.stats.coverFallback = (novelScanStatus.stats.coverFallback || 0) + 1;
        posterPath = r.posterPath;
        console.log(`  ✅ 内容页兜底封面已生成（${r.strategy}）`);
      } else if (r && r.skipped) {
        console.log(`  ⏭️ 内容页兜底跳过：${r.skipped}`);
      } else if (r && r.error) {
        console.log(`  ⚠️ 内容页兜底失败：${r.error}`);
      }
    } catch (e) {
      console.log(`  ⚠️ 内容页兜底异常：${e.message}`);
    }
  }

  try {
    if (!webAttempted || (webData && webData.cover) || rec.localPosterPath) {
      clearScrapeFailure.run(filePath);
    } else if (posterPath) {
      recordScrapeFailure.run({
        filePath,
        movieId: rec.id || null,
        type: 'novel',
        reason: '网络刮削未命中，当前为内容页兜底封面',
        failedAt: Date.now()
      });
    } else {
      recordScrapeFailure.run({
        filePath,
        movieId: rec.id || null,
        type: 'novel',
        reason: '网络刮削未命中且内容页兜底失败',
        failedAt: Date.now()
      });
    }
  } catch (e) { /* 忽略 */ }

  return { ok: true, web: !!webData, poster: !!posterPath };
}

/**
 * 处理单个小说文件（目录监控 / 手动单文件走这条）
 */
async function processSingleNovelFile(filePath, opts) {
  const o = opts || {};
  console.log(`[小说] 处理: ${path.basename(filePath)}`);
  const r = await indexNovel(filePath);
  if (!r.ok) return r;
  await enrichNovel(filePath, {
    network: o.network !== false,
    contentCover: o.contentCover !== false
  });
  console.log(`  ✓ 完成: ${r.title}`);
  return r;
}

/**
 * 快速增量扫描：Phase A 本地索引（并发）→ Phase B 后台补封面
 */
async function startNovelQuickScan() {
  if (novelScanStatus.running) return;
  novelScanStatus = {
    running: true,
    phase: 'index',
    total: 0,
    current: 0,
    currentFile: '',
    startedAt: Date.now(),
    stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0, coverFallback: 0 }
  };
  const _lim = config.autoContentCoverLimit;
  const coverBudget = resetInlineBudget(_lim === -1 ? Infinity : (Number(_lim) >= 0 ? Number(_lim) : 40));
  console.log(`[小说扫描] 本轮内容页兜底预算: ${coverBudget === Infinity ? '不限' : coverBudget} 张`);

  try {
    const novelFolders = config.novelFolders || [];
    if (novelFolders.length === 0) {
      console.log('[小说扫描] 未配置小说目录');
      return;
    }

    const allFiles = [];
    for (const folder of novelFolders) {
      allFiles.push(...getNovelFiles(folder));
    }

    const allMovies = getAllMovies.all();
    const existingNovels = allMovies.filter(m => m.type === 'novel');
    const existingPaths = new Set(existingNovels.map(m => m.filePath));

    const allFileSet = new Set(allFiles);
    const newFiles = allFiles.filter(f => !existingPaths.has(f));
    const deletedPaths = Array.from(existingPaths).filter(p => !allFileSet.has(p));

    novelScanStatus.total = newFiles.length;
    console.log(`[小说扫描] 共 ${allFiles.length} 个文件，新增 ${newFiles.length} 个，并发 ${indexConcurrency()} 路入库`);

    const t0 = Date.now();
    let done = 0;
    if (newFiles.length) {
      await poolMap(newFiles, indexConcurrency(), (f) => indexNovel(f), (f) => {
        done++;
        novelScanStatus.current = done;
        novelScanStatus.currentFile = path.basename(f);
        if (done % 100 === 0 || done === newFiles.length) {
          const sec = (Date.now() - t0) / 1000;
          const rate = sec > 0 ? (done / sec).toFixed(1) : '0';
          console.log(`[小说扫描] 入库进度 ${done}/${newFiles.length}（${rate} 个/秒）`);
        }
      });
    }
    const indexSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[小说扫描] 入库完成：新增 ${newFiles.length} 个，耗时 ${indexSec}s`);

    try { cleanStoredTitles(db, ['novel'], s => console.log('[小说扫描] ' + s)); } catch (e) { /* 不阻塞 */ }

    if (deletedPaths.length) {
      for (const lostPath of deletedPaths) {
        try { deleteMovieByPath.run(lostPath); } catch (e) { /* 忽略 */ }
      }
      novelScanStatus.stats.removed = deletedPaths.length;
      console.log(`[小说扫描] 清理失效记录 ${deletedPaths.length} 条`);
    }

    novelScanStatus.phase = 'done';
    novelScanStatus.running = false;

    // 即使本轮 0 新增也调：补封面任务会自己查「还缺多少」，没缺的立刻返回（可续跑）
    try {
      require('./enrich-covers').startEnrich({ types: ['novel'], reason: '小说扫描' });
    } catch (e) {
      console.log('[小说扫描] 补封面任务启动失败（不影响入库）:', e.message);
    }
    console.log(`[小说扫描] 结束（入库 ${newFiles.length} 个，${indexSec}s）`);

  } catch (e) {
    novelScanStatus.stats.failed++;
    console.log('[小说扫描] 异常:', e.message);
  } finally {
    novelScanStatus.running = false;
    if (novelScanStatus.phase !== 'done') novelScanStatus.phase = 'done';
  }
}

function getNovelScanStatus() {
  return { ...novelScanStatus };
}

module.exports = {
  startNovelQuickScan,
  getNovelScanStatus,
  processSingleNovelFile,
  indexNovel,
  enrichNovel,
  getNovelFiles,
  prettyTitle
};
