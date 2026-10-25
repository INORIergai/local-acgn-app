/**
 * 漫画扫描器
 * 扫描本地漫画文件，支持 epub、pdf、zip、rar 等格式
 *
 * ★★ round112 重构：两阶段扫描（先入库，后补图）
 *   旧实现是一个 `for` 循环里 `await processSingleComic()`，而 processSingleComic 里
 *   **同步等待网络刮削**（kmoe 搜索 + 详情）。源一旦不可用，单个文件要烧 30~100 秒
 *   （15s 超时 × 重试 × 两种 URL 形态 × 换镜像），2351 个文件 = 一晚上只入库两三个。
 *   实机日志证据（round112）：
 *     `[漫画扫描] 共 2351 个文件，新增 1715 个` → 重启后 1712 → 1710，每次只前进 2 个。
 *
 *   现在的分工：
 *     Phase A · 本地索引（并发 8）—— stat / 读 NFO / 本地封面 / 写库，**一个请求都不发**
 *     Phase B · 后台补封面（并发 3）—— 内容页取图（EPUB 内封面 / PDF 首页 / CBZ 首图）
 *     网络元数据刮削只在「单文件」路径（目录监控新增、手动单文件）里做，并且走熔断：
 *       同一个源连续失败 3 次就暂停 5 分钟，期间一个请求都不发（见 utils/scrape-guard.js）
 *
 *   关键不变量：
 *     · 入库绝不依赖网络 —— 网络再烂，文件也必须在库里可见
 *     · 重扫绝不擦掉已有的好标题 / 好封面（旧实现会把刮削结果覆盖成文件名）
 *     · 进度可续 —— 每次都从数据库算差集，中断后重跑不会从头再来
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
const { parseNfo, findLocalCover, generateNfo } = require('./nfo_utils');
const { downloadPoster } = require('./poster-fetcher');
const { extractSeriesKey } = require('./series-group');
const { resetInlineBudget, inlineContentCover } = require('./cover-fallback');
const { poolMap } = require('./pool');
const guard = require('./scrape-guard');
const config = require('./config');

// 支持的漫画格式
const COMIC_EXTENSIONS = ['.epub', '.pdf', '.zip', '.rar', '.cbz', '.cbr', '.mobi', '.azw3'];

// 扫描状态
let comicScanStatus = {
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

/** 索引阶段的并发度：本地 IO 为主，8 路足够把磁盘打到瓶颈（可配 config.scan.indexConcurrency） */
function indexConcurrency() {
    const n = Number(config.scan && config.scan.indexConcurrency);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : 8;
}

/**
 * 递归获取目录下所有漫画文件
 */
function getComicFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return results; }
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...getComicFiles(fullPath));
    } else {
      const ext = path.extname(item.name).toLowerCase();
      if (COMIC_EXTENSIONS.includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/* ==================== 标题美化（零成本，不联网） ==================== */
/* 库内文件名普遍形如 `[Kmoe][異世界歸來的舅舅]卷12.epub`，旧实现直接取 cleanName
   → 用户看到一屏「[Kmoe][…]」。规则见 utils/title-clean.js。 */
const { prettyTitle, cleanStoredTitles } = require('./title-clean');

/* ==================== 本地元数据读取（无网络） ==================== */

function readNfoSafe(filePath, ext) {
    try {
        const nfoPath = filePath.replace(ext, '.nfo');
        if (fs.existsSync(nfoPath)) return parseNfo(nfoPath);
    } catch (e) { /* NFO 坏了就当没有 */ }
    return null;
}

function findCoverSafe(filePath) {
    try { return findLocalCover(filePath) || null; } catch (e) { return null; }
}

/** 把本地封面复制进海报缓存，返回 { posterPath, localPosterPath } */
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
 * Phase A：把一个漫画文件本地入库（不联网）。
 * @returns {Promise<{ok:boolean, id?:number, title?:string, hasPoster?:boolean, error?:string}>}
 */
async function indexComic(filePath) {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName);
    const cleanName = fileName.replace(ext, '');

    try {
        const fileSize = fs.statSync(filePath).size;
        const nfoData = readNfoSafe(filePath, ext);
        const localCover = findCoverSafe(filePath);
        const prev = getMovieByPath.get(filePath) || null;

        // ★ 防「重扫擦掉已刮削结果」：已有标题不是裸文件名时优先保留
        const prevTitle = prev && String(prev.title || '').trim();
        let title;
        if (nfoData && nfoData.title) title = prettyTitle(nfoData.title);
        else if (prevTitle && prevTitle !== cleanName) title = prevTitle;
        else title = prettyTitle(cleanName);

        const overview = (nfoData && nfoData.overview) || (prev && prev.overview) || '';
        const originalTitle = (nfoData && nfoData.originalTitle) || (prev && prev.originalTitle) || '';
        const releaseDate = (nfoData && nfoData.releaseDate) || (prev && prev.releaseDate) || '';
        const author = (nfoData && nfoData.author) || (prev && prev.producer) || '';
        const genres = (nfoData && nfoData.genres && nfoData.genres.join(', '))
            || (prev && prev.genres) || '';

        const cov = localCover ? cacheLocalCover(filePath, localCover) : { posterPath: '', localPosterPath: '' };

        const result = upsertMovie.run({
            filePath,
            fileName,
            type: 'comic',
            avid: '',
            cleanName,
            fileSize,
            duration: 0,
            width: 0,
            height: 0,
            tmdbId: null,
            title,
            originalTitle,
            overview,
            releaseDate,
            // ★ 已有记录且本次没找到本地封面时传 null：upsert 的 COALESCE 会保留旧封面。
            //   传 '' 会把老封面覆盖成空（COALESCE('', posterPath) = ''）。
            posterPath: prev ? (cov.posterPath || null) : cov.posterPath,
            localPosterPath: prev ? (cov.localPosterPath || null) : cov.localPosterPath,
            country: '',
            genres,
            producer: author,
            publisher: '',
            serial: extractSeriesKey(title || cleanName) || '',
            director: '',
            score: 0,
            source: nfoData ? 'local-nfo' : ((prev && prev.source) || 'local'),
            lastScanTime: Date.now(),
            addedTime: Date.now()
        });

        // ★ 旧实现用 result.lastInsertRowid 当 movieId —— UPSERT 命中已有行时
        //   SQLite 不会更新 last_insert_rowid，标签会被挂到别的影片上。按路径反查才准。
        const row = getMovieByPath.get(filePath);
        const movieId = row ? row.id : result.lastInsertRowid;

        try {
            if (nfoData && nfoData.genres && nfoData.genres.length) {
                updateMovieRelations(movieId, { tags: nfoData.genres, actresses: [] });
            }
        } catch (e) { /* 标签失败不影响入库 */ }
        try { recalcHotScore(movieId); } catch (e) { /* 热度失败不影响入库 */ }

        // 导出 NFO（如果启用）
        const exportCfg = config.export || {};
        if (exportCfg.enableNfoExport && !nfoData) {
            try {
                const dir = path.dirname(filePath);
                const stem = path.basename(fileName, ext);
                const nfoPath = path.join(dir, stem + '.nfo');
                if (!fs.existsSync(nfoPath) || exportCfg.overwriteExisting) {
                    generateNfo({
                        title,
                        originalTitle,
                        num: '',
                        overview,
                        releaseDate,
                        genres: nfoData?.genres || [],
                        actors: [],
                        thumb: cov.posterPath
                    }, nfoPath);
                }
            } catch (e) {
                console.log(`[导出NFO失败] ${fileName}:`, e.message);
            }
        }

        comicScanStatus.stats.localHit++;
        return { ok: true, id: movieId, title, hasPoster: !!(cov.posterPath || (prev && prev.posterPath)) };
    } catch (e) {
        comicScanStatus.stats.failed++;
        console.log(`  ✗ 入库失败: ${fileName} → ${e.message}`);
        return { ok: false, error: e.message };
    }
}

/* ==================== Phase B：网络元数据 + 内容页封面 ==================== */

let _kmoe = null;
function kmoe() {
    if (!_kmoe) {
        const KmoeCrawler = require('./crawler/kmoe');
        _kmoe = new KmoeCrawler(config.sources?.kmoe || {});
    }
    return _kmoe;
}

function searchKeyword(cleanName) {
    return String(cleanName || '')
        .replace(/\[.*?\]/g, ' ')
        .replace(/\(.*?\)/g, ' ')
        .replace(/【.*?】/g, ' ')
        .replace(/(epub|mobi|pdf|txt|zip|rar|cbz|cbr|azw3|全一冊|全一册|汉化组)/gi, ' ')
        .replace(/[！？♥〜～]/g, ' ')
        .replace(/[-_.]/g, ' ')
        .trim().replace(/\s+/g, ' ');
}

/**
 * Phase B：给一条已入库的漫画补元数据 / 封面。
 * @param {string} filePath
 * @param {{network?:boolean, contentCover?:boolean}} opts
 *        network=false → 只做内容页封面（批量扫描走这条，绝不联网）
 */
async function enrichComic(filePath, opts) {
    const o = opts || {};
    const wantNetwork = o.network === true;
    const wantCover = o.contentCover !== false;

    const rec = getMovieByPath.get(filePath);
    if (!rec) return { ok: false, reason: 'no-row' };

    const ext = path.extname(rec.fileName || filePath);
    const cleanName = rec.cleanName || path.basename(filePath).replace(ext, '');
    let webData = null;
    let webAttempted = false;

    // ---- 1) 网络元数据（只在单文件路径，且源健康时）----
    if (wantNetwork && guard.canTry('kmoe')) {
        const keyword = searchKeyword(cleanName);
        if (keyword.length >= 2) {
            webAttempted = true;
            try {
                const crawler = kmoe();
                const list = await crawler.search(keyword);
                if (Array.isArray(list) && list.length > 0) {
                    const first = list[0];
                    const detail = await crawler.getDetail(first.url).catch(() => null);
                    webData = detail
                        ? {
                            title: detail.title || first.title || keyword,
                            originalTitle: detail.title || '',
                            description: detail.intro || '',
                            author: detail.author || first.author || '',
                            cover: detail.cover || first.cover || '',
                            tags: detail.category ? [detail.category] : [],
                            source: 'kmoe'
                        }
                        : {
                            title: first.title || keyword,
                            originalTitle: first.title || '',
                            description: '',
                            author: first.author || '',
                            cover: first.cover || '',
                            tags: [],
                            source: 'kmoe'
                        };
                    guard.ok('kmoe');
                } else if (crawler.loginWall) {
                    guard.fail('kmoe', '登录墙：Cookie 失效且自动重登失败');
                } else if (crawler.lastError) {
                    guard.fail('kmoe', crawler.lastError);
                } else {
                    guard.ok('kmoe');       // 源是通的，只是这本没搜到
                }
            } catch (e) {
                guard.fail('kmoe', e);
                console.log(`  网络刮削失败: ${e.message}`);
            }
        }
    }

    // ---- 2) 合并元数据 ----
    let posterPath = rec.posterPath || '';
    if (webData) {
        comicScanStatus.stats.webScraped++;
        const title = webData.title || rec.title;
        const overview = rec.overview || webData.description || '';
        const author = rec.producer || webData.author || '';
        try {
            db.prepare(`UPDATE movies SET title=@title, originalTitle=@originalTitle,
                        overview=@overview, producer=@producer, genres=@genres, source=@source,
                        serial=@serial WHERE id=@id`).run({
                title,
                originalTitle: rec.originalTitle || webData.originalTitle || '',
                overview,
                producer: author,
                genres: rec.genres || (webData.tags || []).join(', '),
                source: 'kmoe',
                serial: rec.serial || extractSeriesKey(title || cleanName) || '',
                id: rec.id
            });
        } catch (e) { /* 元数据更新失败不影响封面 */ }

        // 网络封面（仅在没有本地封面时）
        if (!posterPath && webData.cover) {
            try {
                const hash = crypto.createHash('md5').update(filePath).digest('hex');
                const cachePath = path.join(__dirname, '../cache/posters', `${hash}.jpg`);
                const videoDir = path.dirname(filePath);
                const baseName = path.basename(filePath, ext);
                const localCoverPath = path.join(videoDir, `${baseName}-poster.jpg`);
                await downloadPoster(webData.cover, localCoverPath);
                if (fs.existsSync(localCoverPath)) fs.copyFileSync(localCoverPath, cachePath);
                posterPath = `${hash}.jpg`;
                db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?')
                    .run(posterPath, `cache/posters/${hash}.jpg`, rec.id);
            } catch (e) {
                console.log(`  封面下载失败: ${e.message}`);
            }
        }
    }

    // ---- 3) 内容页兜底封面 ----
    if (wantCover && !posterPath) {
        try {
            const r = await inlineContentCover(db, filePath, s => console.log('    ' + s));
            if (r && r.ok && r.posterPath) {
                comicScanStatus.stats.coverFallback = (comicScanStatus.stats.coverFallback || 0) + 1;
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

    // ---- 4) 刮削失败清单 ----
    try {
        if (!webAttempted || (webData && webData.cover) || rec.localPosterPath) {
            clearScrapeFailure.run(filePath);
        } else if (posterPath) {
            recordScrapeFailure.run({
                filePath,
                movieId: rec.id || null,
                type: 'comic',
                reason: '网络刮削未命中，当前为内容页兜底封面',
                failedAt: Date.now()
            });
        } else {
            recordScrapeFailure.run({
                filePath,
                movieId: rec.id || null,
                type: 'comic',
                reason: '网络刮削未命中且内容页兜底失败',
                failedAt: Date.now()
            });
        }
    } catch (e) { /* 失败记录不影响扫描主流程 */ }

    return { ok: true, web: !!webData, poster: !!posterPath };
}

/**
 * 处理单个漫画文件（目录监控 / 手动单文件走这条）。
 * ★ 默认「入库 + （源健康时）网络刮削 + 内容页封面」——保持与旧行为一致，
 *   只是多了一层熔断：源挂了就只做本地部分，不会每来一个文件都去撞墙。
 */
async function processSingleComic(filePath, opts) {
    const o = opts || {};
    console.log(`[漫画] 处理: ${path.basename(filePath)}`);
    const r = await indexComic(filePath);
    if (!r.ok) return r;
    await enrichComic(filePath, {
        network: o.network !== false,
        contentCover: o.contentCover !== false
    });
    console.log(`  ✓ 完成: ${r.title}`);
    return r;
}

/**
 * 漫画快速增量扫描
 * Phase A 本地索引（并发）→ Phase B 后台补封面（不阻塞扫描状态）
 */
async function startComicQuickScan() {
  if (comicScanStatus.running) return;
  comicScanStatus = {
    running: true,
    phase: 'index',
    total: 0,
    current: 0,
    currentFile: '',
    startedAt: Date.now(),
    stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0, coverFallback: 0 }
  };
  // 每轮扫描重置「内容页兜底」预算（默认 40 张）；Phase B 走 autoCover，不受这个预算限制
  const _lim = config.autoContentCoverLimit;
  const coverBudget = resetInlineBudget(_lim === -1 ? Infinity : (Number(_lim) >= 0 ? Number(_lim) : 40));
  console.log(`[漫画扫描] 本轮内容页兜底预算: ${coverBudget === Infinity ? '不限' : coverBudget} 张`);

  try {
    const comicFolders = config.comicFolders || [];
    if (comicFolders.length === 0) {
      console.log('[漫画扫描] 未配置漫画目录');
      return;
    }

    // 收集所有文件
    const allFiles = [];
    for (const folder of comicFolders) {
      allFiles.push(...getComicFiles(folder));
    }

    // 获取数据库中已有的漫画
    const allMovies = getAllMovies.all();
    const existingComics = allMovies.filter(m => m.type === 'comic');
    const existingPaths = new Set(existingComics.map(m => m.filePath));

    // 找出新增的和删除的（★ 旧实现用 allFiles.includes → O(n²)，几千文件白烧 CPU）
    const allFileSet = new Set(allFiles);
    const newFiles = allFiles.filter(f => !existingPaths.has(f));
    const deletedPaths = Array.from(existingPaths).filter(p => !allFileSet.has(p));

    comicScanStatus.total = newFiles.length;
    console.log(`[漫画扫描] 共 ${allFiles.length} 个文件，新增 ${newFiles.length} 个，并发 ${indexConcurrency()} 路入库`);

    // ---------- Phase A：本地索引（不联网，并发） ----------
    const t0 = Date.now();
    let done = 0;
    if (newFiles.length) {
      await poolMap(newFiles, indexConcurrency(), (f) => indexComic(f), (f) => {
        done++;
        comicScanStatus.current = done;
        comicScanStatus.currentFile = path.basename(f);
        if (done % 100 === 0 || done === newFiles.length) {
          const sec = (Date.now() - t0) / 1000;
          const rate = sec > 0 ? (done / sec).toFixed(1) : '0';
          console.log(`[漫画扫描] 入库进度 ${done}/${newFiles.length}（${rate} 个/秒）`);
        }
      });
    }
    const indexSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[漫画扫描] 入库完成：新增 ${newFiles.length} 个，耗时 ${indexSec}s`);

    // 存量记录（本轮之前入库的）标题一起过一遍：旧逻辑存的是裸文件名
    try { cleanStoredTitles(db, ['comic'], s => console.log('[漫画扫描] ' + s)); } catch (e) { /* 不阻塞 */ }

    // 删除失效记录
    if (deletedPaths.length) {
      for (const lostPath of deletedPaths) {
        try { deleteMovieByPath.run(lostPath); } catch (e) { /* 忽略单条失败 */ }
      }
      comicScanStatus.stats.removed = deletedPaths.length;
      console.log(`[漫画扫描] 清理失效记录 ${deletedPaths.length} 条`);
    }

    comicScanStatus.phase = 'done';
    comicScanStatus.running = false;

    // ---------- Phase B：后台补封面（不阻塞扫描状态，也不阻塞目录监控） ----------
    // 注意：即使本轮 0 新增也要调 —— 上一次可能被关掉应用打断了，
    // 补封面任务自己会查「还缺多少」，没缺的会立刻返回（可续跑）。
    try {
      require('./enrich-covers').startEnrich({ types: ['comic'], reason: '漫画扫描' });
    } catch (e) {
      console.log('[漫画扫描] 补封面任务启动失败（不影响入库）:', e.message);
    }
    console.log(`[漫画扫描] 结束（入库 ${newFiles.length} 个，${indexSec}s）`);

  } catch (e) {
    comicScanStatus.stats.failed++;
    console.log('[漫画扫描] 异常:', e.message);
  } finally {
    comicScanStatus.running = false;
    if (comicScanStatus.phase !== 'done') comicScanStatus.phase = 'done';
  }
}

function getComicScanStatus() {
  return { ...comicScanStatus };
}

module.exports = {
  startComicQuickScan,
  getComicScanStatus,
  processSingleComic,
  indexComic,
  enrichComic,
  getComicFiles,
  prettyTitle
};
