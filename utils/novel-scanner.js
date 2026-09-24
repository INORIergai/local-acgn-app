/**
 * 小说扫描器
 * 扫描本地小说文件，支持 txt、epub、pdf、mobi 等格式
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  getAllMovies,
  deleteMovieByPath,
  upsertMovie,
  getMovieByPath,
  updateMovieRelations,
  recalcHotScore
} = require('./db');
const { parseNfo, findLocalCover, generateNfo } = require('./nfo_utils');
const config = require('./config');

// 支持的小说格式
const NOVEL_EXTENSIONS = ['.txt', '.epub', '.pdf', '.mobi', '.azw3', '.docx', '.doc', '.rtf'];

// 扫描状态
let novelScanStatus = {
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
 * 递归获取目录下所有小说文件
 */
function getNovelFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });
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

/**
 * 快速增量扫描
 */
async function startNovelQuickScan() {
  if (novelScanStatus.running) return;
  novelScanStatus = {
    running: true,
    total: 0,
    current: 0,
    currentFile: '',
    stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0 }
  };

  try {
    const novelFolders = config.novelFolders || [];
    if (novelFolders.length === 0) {
      console.log('[小说扫描] 未配置小说目录');
      return;
    }

    // 收集所有小说文件
    const allFiles = [];
    for (const folder of novelFolders) {
      allFiles.push(...getNovelFiles(folder));
    }
    
    // 获取数据库中已有的小说
    const allMovies = getAllMovies.all();
    const existingNovels = allMovies.filter(m => m.type === 'novel');
    const existingPaths = new Set(existingNovels.map(m => m.filePath));
    
    // 找出新增的和删除的
    const newFiles = allFiles.filter(f => !existingPaths.has(f));
    const deletedPaths = Array.from(existingPaths).filter(p => !allFiles.includes(p));
    
    novelScanStatus.total = newFiles.length;
    console.log(`[小说扫描] 共 ${allFiles.length} 个文件，新增 ${newFiles.length} 个`);
    
    // 处理新增文件
    for (let i = 0; i < newFiles.length; i++) {
      novelScanStatus.current = i + 1;
      novelScanStatus.currentFile = path.basename(newFiles[i]);
      
      try {
        await processSingleNovelFile(newFiles[i]);
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
    
    console.log(`[小说扫描] 完成！新增 ${newFiles.length} 个`);

  } finally {
    novelScanStatus.running = false;
  }
}

/**
 * 处理单个小说文件
 */
async function processSingleNovelFile(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const cleanName = fileName.replace(ext, '');
  
  console.log(`[小说] 处理: ${fileName}`);
  
  try {
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    
    // 查找本地封面（同目录下的同名图片）
    let localCover = null;
    try {
      const dir = path.dirname(filePath);
      const stem = path.basename(fileName, ext);
      const coverExts = ['.jpg', '.jpeg', '.png', '.webp'];
      for (const coverExt of coverExts) {
        const coverPath = path.join(dir, stem + coverExt);
        if (fs.existsSync(coverPath)) {
          localCover = coverPath;
          break;
        }
      }
      // 也检查 cover.jpg / folder.jpg
      if (!localCover) {
        for (const name of ['cover.jpg', 'folder.jpg', 'poster.jpg']) {
          const coverPath = path.join(dir, name);
          if (fs.existsSync(coverPath)) {
            localCover = coverPath;
            break;
          }
        }
      }
    } catch (e) {}
    
    // 处理封面
    let posterPath = '';
    if (localCover) {
      try {
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        const coverExt = path.extname(localCover);
        const cachePath = path.join(__dirname, '../cache/posters', hash + coverExt);
        
        if (!fs.existsSync(cachePath)) {
          fs.copyFileSync(localCover, cachePath);
        }
        posterPath = hash + coverExt;
      } catch (e) {}
    }
    
    // 尝试读取 NFO
    let nfoData = null;
    try {
      const dir = path.dirname(filePath);
      const stem = path.basename(fileName, ext);
      const nfoPath = path.join(dir, stem + '.nfo');
      if (fs.existsSync(nfoPath)) {
        nfoData = parseNfo(nfoPath);
      }
    } catch (e) {}
    
    // 网络刮削（如果本地数据不全）——小说库走 zlibrary
    let webData = null;
    if (!nfoData || !nfoData.title || !localCover) {
      try {
        const ZLibraryCrawler = require('./crawler/zlibrary');
        const crawler = new ZLibraryCrawler(config.sources?.zlibrary || {});
        webData = await crawler.searchByFileName(fileName);
        
        // zlibrary 封面下载到影片同目录 + 缓存
        if (webData && webData.cover && !localCover) {
          try {
            const hash = crypto.createHash('md5').update(filePath).digest('hex');
            const cachePath = path.join(__dirname, '../cache/posters', `${hash}.jpg`);
            const videoDir = path.dirname(filePath);
            const baseName = path.basename(filePath, ext);
            const localCoverPath = path.join(videoDir, `${baseName}-poster.jpg`);
            
            const { downloadPoster } = require('./poster-fetcher');
            await downloadPoster(webData.cover, localCoverPath);
            if (fs.existsSync(localCoverPath)) {
              fs.copyFileSync(localCoverPath, cachePath);
            }
            posterPath = `${hash}.jpg`;
            localCover = localCoverPath;
          } catch (e) {
            console.log(`  小说封面下载失败: ${e.message}`);
          }
        }
      } catch (e) {
        console.log(`  网络刮削失败: ${e.message}`);
      }
    }
    
    const title = nfoData?.title || webData?.title || cleanName;
    const originalTitle = nfoData?.originalTitle || webData?.originalTitle || '';
    const overview = nfoData?.plot || webData?.description || '';
    const releaseDate = nfoData?.premiered || webData?.releaseDate || '';
    const genres = nfoData?.genres?.join(', ') || webData?.genres?.join(', ') || '';
    
    // 写入数据库
    // 修复：补齐 upsertMovie 全部命名参数，避免 RangeError: Missing named parameter
    const result = upsertMovie.run({
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
      originalTitle,
      overview,
      releaseDate,
      posterPath,
      localPosterPath: localCover || '',
      country: '',
      genres,
      producer: '',
      publisher: '',
      serial: '',
      director: '',
      score: 0,
      source: nfoData ? 'local-nfo' : 'local',
      lastScanTime: Date.now(),
      addedTime: Date.now()
    });
    
    // 更新标签关联
    try {
      const movieRec = getMovieByPath.get(filePath);
      if (movieRec && nfoData?.genres?.length > 0) {
        updateMovieRelations(movieRec.id, { tags: nfoData.genres, actresses: [] });
        recalcHotScore(movieRec.id);
      }
    } catch (e) {}
    
    novelScanStatus.stats.localHit++;
    console.log(`  ✓ 完成: ${title}`);
    
  } catch (e) {
    novelScanStatus.stats.failed++;
    console.log(`  ✗ 处理失败: ${e.message}`);
  }
}

/**
 * 获取扫描状态
 */
function getNovelScanStatus() {
  return novelScanStatus;
}

module.exports = {
  startNovelQuickScan,
  getNovelScanStatus,
  processSingleNovelFile,
  getNovelFiles
};
