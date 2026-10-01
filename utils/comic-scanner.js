/**
 * 漫画扫描器
 * 扫描本地漫画文件，支持 epub、pdf、zip、rar 等格式
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
  recalcHotScore
} = require('./db');
const { parseNfo, findLocalCover, generateNfo } = require('./nfo_utils');
const { downloadPoster } = require('./poster-fetcher');
const { resetInlineBudget, inlineContentCover } = require('./cover-fallback');
const KmoeCrawler = require('./crawler/kmoe');
const config = require('./config');

// 支持的漫画格式
const COMIC_EXTENSIONS = ['.epub', '.pdf', '.zip', '.rar', '.cbz', '.cbr', '.mobi', '.azw3'];

// 扫描状态
let comicScanStatus = {
  running: false,
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

/**
 * 递归获取目录下所有漫画文件
 */
function getComicFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });
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

/**
 * 处理单个漫画文件
 */
async function processSingleComic(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const cleanName = fileName.replace(ext, '');
  
  console.log(`[漫画] 处理: ${fileName}`);
  
  try {
    // 1. 读取文件信息
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    
    // 2. 读取本地 NFO
    let nfoData = null;
    try {
      const nfoPath = filePath.replace(ext, '.nfo');
      if (fs.existsSync(nfoPath)) {
        nfoData = parseNfo(nfoPath);
      }
    } catch (e) {}
    
    // 3. 查找本地封面
    let localCover = null;
    try {
      localCover = findLocalCover(filePath);
    } catch (e) {}
    
    // 4. 网络刮削（如果本地数据不全）——漫画库走 kmoe
    let webData = null;
    if (!nfoData || !nfoData.title || !localCover) {
      try {
        const KmoeCrawler = require('./crawler/kmoe');
        const crawler = new KmoeCrawler(config.sources?.kmoe || {});
        
        // 清洗文件名作为搜索词
        const keyword = cleanName
          .replace(/\[.*?\]/g, ' ')
          .replace(/\(.*?\)/g, ' ')
          .replace(/【.*?】/g, ' ')
          .replace(/(epub|mobi|pdf|txt|zip|rar|cbz|cbr|azw3|全一冊|全一册|汉化组)/gi, ' ')
          .replace(/[！？♥〜～]/g, ' ')
          .replace(/[-_.]/g, ' ')
          .trim().replace(/\s+/g, ' ');
        
        if (keyword.length >= 2) {
          const list = await crawler.search(keyword);
          if (Array.isArray(list) && list.length > 0) {
            const first = list[0];
            const detail = await crawler.getDetail(first.url);
            if (detail) {
              webData = {
                title: detail.title || first.title || keyword,
                originalTitle: detail.title || '',
                description: detail.intro || '',
                author: detail.author || first.author || '',
                cover: detail.cover || first.cover || '',
                tags: detail.category ? [detail.category] : [],
                source: 'kmoe'
              };
            } else {
              webData = {
                title: first.title || keyword,
                originalTitle: first.title || '',
                description: '',
                author: first.author || '',
                cover: first.cover || '',
                tags: [],
                source: 'kmoe'
              };
            }
          }
        }
      } catch (e) {
        console.log(`  网络刮削失败: ${e.message}`);
      }
    }
    
    // 5. 合并数据
    const title = nfoData?.title || webData?.title || cleanName;
    const originalTitle = nfoData?.originalTitle || webData?.originalTitle || '';
    const overview = nfoData?.overview || webData?.description || '';
    const releaseDate = nfoData?.releaseDate || webData?.releaseDate || '';
    const author = nfoData?.author || webData?.author || '';
    
    // 6. 处理封面
    let posterPath = '';
    let localPosterPath = '';
    
    if (localCover) {
      try {
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        const coverExt = path.extname(localCover);
        const cachePath = path.join(__dirname, '../cache/posters', hash + coverExt);
        
        if (!fs.existsSync(cachePath)) {
          fs.copyFileSync(localCover, cachePath);
        }
        posterPath = hash + coverExt;
        localPosterPath = localCover;
      } catch (e) {}
    } else if (webData?.cover) {
      try {
        // 下载网络封面（kmoe 封面）到影片同目录 + 缓存
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        const cachePath = path.join(__dirname, '../cache/posters', `${hash}.jpg`);
        const videoDir = path.dirname(filePath);
        const baseName = path.basename(filePath, ext);
        const localCoverPath = path.join(videoDir, `${baseName}-poster.jpg`);

        await downloadPoster(webData.cover, localCoverPath);
        if (fs.existsSync(localCoverPath)) {
          fs.copyFileSync(localCoverPath, cachePath);
        }
        posterPath = `${hash}.jpg`;
        localPosterPath = cachePath;
      } catch (e) {
        console.log(`  封面下载失败: ${e.message}`);
      }
    }
    
    // 7. 写入数据库
    // 注意：必须补齐 upsertMovie 的全部命名参数（tmdbId/country/publisher/serial/director/score），
    // 否则 better-sqlite3 会抛 RangeError: Missing named parameter 导致整条记录失败
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
      posterPath,
      localPosterPath,
      country: '',
      genres: nfoData?.genres?.join(', ') || webData?.tags?.join(', ') || '',
      producer: author || '',
      publisher: '',
      serial: '',
      director: '',
      score: 0,
      source: webData?.source || 'local',
      lastScanTime: Date.now(),
      addedTime: Date.now()
    });
    
    const movieId = result.lastInsertRowid;
    
    // 8. 更新标签关联
    // 修复：updateMovieRelations 签名是 (movieId, { tags, actresses })，旧代码传了三个参数导致标签被静默丢弃
    try {
      const tags = nfoData?.genres || webData?.tags || [];
      updateMovieRelations(movieId, { tags, actresses: [] });
    } catch (e) {}
    
    // 9. 计算热度
    try {
      recalcHotScore(movieId);
    } catch (e) {}

    // 9.5 ★ round26续：刮削没拿到封面 → 自动用「内容页」兜底
    //   （PDF 第 1 页 / EPUB 内封面）。此前这里在网络刮削失败时只打一行日志就过去了，
    //   库里于是留下永久白框，只能靠用户手动一部部补。
    if (!posterPath) {
      try {
        const r = await inlineContentCover(db, filePath, s => console.log('    ' + s));
        if (r && r.ok && r.posterPath) {
          posterPath = r.posterPath;
          comicScanStatus.stats.coverFallback = (comicScanStatus.stats.coverFallback || 0) + 1;
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
    
    // 10. 导出 NFO（如果启用）
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
            thumb: posterPath
          }, nfoPath);
        }
      } catch (e) {
        console.log(`[导出NFO失败] ${fileName}:`, e.message);
      }
    }
    
    comicScanStatus.stats.localHit++;
    console.log(`  ✓ 完成: ${title}`);
    
  } catch (e) {
    comicScanStatus.stats.failed++;
    console.log(`  ✗ 处理失败: ${e.message}`);
  }
}

/**
 * 漫画快速增量扫描
 */
async function startComicQuickScan() {
  if (comicScanStatus.running) return;
  comicScanStatus = {
    running: true,
    total: 0,
    current: 0,
    currentFile: '',
    stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0, coverFallback: 0 }
  };
  // 每轮扫描重置「内容页兜底」预算（默认 40 张，约 30 秒；其余下次扫描继续）
  // config.autoContentCoverLimit：正数=本轮上限，0=关闭，-1=不限
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
    
    // 找出新增的和删除的
    const newFiles = allFiles.filter(f => !existingPaths.has(f));
    const deletedPaths = Array.from(existingPaths).filter(p => !allFiles.includes(p));
    
    comicScanStatus.total = newFiles.length;
    console.log(`[漫画扫描] 共 ${allFiles.length} 个文件，新增 ${newFiles.length} 个`);
    
    // 处理新增文件
    for (let i = 0; i < newFiles.length; i++) {
      comicScanStatus.current = i + 1;
      comicScanStatus.currentFile = path.basename(newFiles[i]);
      
      try {
        await processSingleComic(newFiles[i]);
      } catch (e) {
        console.log(`处理失败: ${newFiles[i]}`, e.message);
      }
    }
    
    // 删除失效记录
    for (const lostPath of deletedPaths) {
      try {
        deleteMovieByPath.run(lostPath);
      } catch (e) {}
    }
    
    console.log(`[漫画扫描] 完成！新增 ${newFiles.length} 个`);

  } finally {
    comicScanStatus.running = false;
  }
}

function getComicScanStatus() {
  return { ...comicScanStatus };
}

module.exports = {
  startComicQuickScan,
  getComicScanStatus,
  processSingleComic,
  getComicFiles
};
