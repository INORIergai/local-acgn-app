const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  db,
  getAllMovies,
  deleteMovieByPath,
  upsertMovieAndRelations,
  getMovieByPath,
  recalcHotScore,
  recordScrapeFailure,
  clearScrapeFailure,
  getAllScrapeFailures,
  updateActressProfile
} = require('./db');
const { getVideoMetadata, captureVideoThumb } = require('./metadata');
const {
  cleanMovieName,
  searchMovie,
  downloadPoster,
  extractAvId,
  titleIsCodeOnly
} = require('./poster-fetcher');
const { parseNfo, findLocalCover, generateNfo } = require('./nfo_utils');
const { extractActressAvatarsFromMoviePage, avatarFileName, AVATAR_DIR } = require('./crawler/actress-avatar');
const { downloadImage } = require('./crawler/base');
const config = require('./config');

// 扫描状态
let scanStatus = {
  running: false,
  total: 0,
  current: 0,
  currentFile: '',
  // 统计
  stats: {
    localHit: 0,    // 本地 NFO + 封面命中
    webScraped: 0,  // 网络刮削成功
    failed: 0,      // 刮削失败（用截图兜底）
    skipped: 0      // 跳过（已存在且数据完整）
  }
};

// 不可读目录（EIO/EPERM 等）：记一次，跳过而不是让整个进程崩溃
const unreadableDirs = new Set();

// 动漫扫描独立状态：此前和影片扫描共用 scanStatus.running，
// 启动时两个扫描并发，后启动的动漫扫描看到 running=true 就直接 return（静默不干活）
let animeScanStatus = {
  running: false,
  total: 0,
  current: 0,
  currentFile: '',
  stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0 }
};

/**
 * 递归获取目录下所有视频文件
 * 注意：坏目录/掉盘的 readdirSync 会抛 EIO，必须就地吞掉，
 * 否则一次 EIO 就会杀掉整个 node 进程（表现为「点扫描没反应」+服务重启）。
 */
/**
 * EIO 多为 bind mount（Docker Desktop / virtiofs）的瞬时抖动：实测同一个目录在扫描报错几分钟后
 * 就能正常枚举。直接判死会让该目录下所有文件被跳过（存在被误判成"已删除"的风险），
 * 所以在同一处做有限重试，代价上限约 1 秒/目录。
 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 忽略 */ }
}

function readdirSafe(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      const transient = e.code === 'EIO' || e.code === 'EAGAIN' || e.code === 'EBUSY';
      if (transient && attempt < 2) {
        sleepSync(400);
        continue;
      }
      if (!unreadableDirs.has(dir)) {
        unreadableDirs.add(dir);
        // EIO 的两个已知原因：挂载瞬时抖动；或目录里存在 UTF-8 > 255 字节的超长文件名
        const hint = e.code === 'EIO' ? ' ← 重试 3 次仍失败：多为挂载抖动，也可能是目录内有文件名超过 255 字节' : '';
        console.log(`[扫描] 目录不可读，已跳过: ${dir} (${e.code || e.message})${hint}`);
      }
      return null;
    }
  }
}

function getVideoFiles(dir) {
  const results = [];

  if (!fs.existsSync(dir)) return results;
  const items = readdirSafe(dir);
  if (!items) return results;

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...getVideoFiles(fullPath));
    } else {
      const ext = path.extname(item.name).toLowerCase();
      if (config.allowedVideoExt.includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * 处理单个影片文件（优先复用本地NFO+封面）
 */
async function processSingleFile(filePath, type = 'jav') {
  const fileName = path.basename(filePath);
  const cleanName = cleanMovieName(fileName);
  const stat = fs.statSync(filePath);

  // 1. 读取视频元数据
  let meta = { duration: 0, width: 0, height: 0 };
  try {
    meta = await getVideoMetadata(filePath);
  } catch (e) {
    console.log(`读取元数据失败: ${fileName}`, e.message);
  }

  // 2. 优先读取本地NFO元数据
  const nfoPath = filePath.replace(path.extname(filePath), '.nfo');
  const nfoData = parseNfo(nfoPath);

  // 3. 优先查找本地封面
  const fileHash = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 12);
  const posterSavePath = path.join(config.posterCacheDir, `${fileHash}.jpg`);
  let localPoster = findLocalCover(filePath);

  // 本地封面存在则复制到缓存目录统一管理
  if (localPoster) {
    try {
      const cacheDir = path.dirname(posterSavePath);
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      fs.copyFileSync(localPoster, posterSavePath);
      localPoster = posterSavePath;
    } catch (e) {
      console.log(`封面复制失败: ${fileName}`);
      localPoster = undefined;
    }
  }

  // 4. 本地数据不全时，才尝试网络刮削补全
  let movieInfo = null;
  // 【2026-09-25】「本地已有数据」必须排除失败兜底产物。
  // 刮削失败时照样会导出 NFO（标题=文件名清洗结果，即番号）和视频截帧封面，
  // 一旦把它认成数据完整，这条记录就被永久锁在「本地命中」分支：任何扫描都不再联网，
  // 「一键重刮失败项」也绕不过（内部同样走到这里），只会一直显示「仍失败」。
  // 实测库内 136 条「标题只剩番号」的记录里，134 条正是被这样锁死的。
  const localTitleIsReal = !!(nfoData && nfoData.title) && !titleIsCodeOnly(nfoData.title);
  const hasFullData = localTitleIsReal && localPoster;

  if (hasFullData) {
    scanStatus.stats.localHit++;
    console.log(`[本地命中] ${fileName}`);
    clearScrapeFailure.run(filePath);
  } else {
    try {
      movieInfo = await searchMovie(cleanName, fileName, type, filePath);
      if (movieInfo) {
        scanStatus.stats.webScraped++;
        console.log(`[网络刮削] ${fileName} ✓`);
        clearScrapeFailure.run(filePath);
      } else {
        scanStatus.stats.failed++;
        console.log(`[刮削失败] ${fileName} ✗`);
        recordScrapeFailure.run({
          filePath,
          movieId: getMovieByPath.get(filePath)?.id || null,
          type,
          reason: '所有刮削源均未命中',
          failedAt: Date.now()
        });
      }
    } catch (e) {
      scanStatus.stats.failed++;
      console.log(`刮削失败: ${fileName}`, e.message);
      recordScrapeFailure.run({
        filePath,
        movieId: getMovieByPath.get(filePath)?.id || null,
        type,
        reason: e.message?.substring(0, 200) || '刮削异常',
        failedAt: Date.now()
      });
    }
  }

  // 5. 合并数据：本地NFO优先，缺失字段用网络数据补
  const extra = movieInfo?._extra || {};
  // 【2026-09-25 round27】标题优先级修正。
  // 原写法 `nfoData?.title || movieInfo?.title || cleanName` 有个致命副作用：
  //   刮削失败兜底时也会导出 NFO，而 NFO 里的 <title> 就是「文件名清洗结果」= 番号。
  //   于是这条记录从此永远拿番号当标题 —— 即使后来联网刮到了真标题，也被 NFO 的番号盖掉。
  //   实测 17 条「重刮成功但标题仍是番号」全部是这个原因。
  // 新规则：① NFO 是「真标题」→ 用它（尊重用户本地整理）；
  //        ② 否则网络刮到的是真标题 → 用它；
  //        ③ 都只有番号 → 维持原样（番号/清洗名）。
  const nfoTitleReal = !!(nfoData && nfoData.title) && !titleIsCodeOnly(nfoData.title);
  const netTitleReal = !!(movieInfo && movieInfo.title) && !titleIsCodeOnly(movieInfo.title);
  const finalTitle = nfoTitleReal ? nfoData.title
    : (netTitleReal ? movieInfo.title
      : (nfoData?.title || movieInfo?.title || cleanName));
  // 原名同理，但只做「不要用文件名当原名」的最小修正
  const finalOriginalTitle = nfoData?.originalTitle || movieInfo?.original_title || cleanName || fileName;
  const avidResult = extractAvId(fileName);
  const finalAvid = nfoData?.num || extra.avid || avidResult?.avid;
  const finalGenres = nfoData?.genres?.join(',') || movieInfo?.genres?.map(g => g.name).join(',') || '';
  const finalReleaseDate = nfoData?.releaseDate || movieInfo?.release_date || '';
  const finalOverview = nfoData?.overview || movieInfo?.overview || '';
  const finalDirector = nfoData?.director || extra.director || '';
  const finalProducer = nfoData?.maker || extra.producer || '';
  // 【2026-09-22】发行商此前写死 extra.publisher 但 normalizeResult 没透传 → 全库 0 条覆盖。
  // 现在 javbus/javdb 的「發行商/發行」都已透传，NFO 侧也做兜底。
  const finalPublisher = nfoData?.publisher || extra.publisher || '';
  const finalSerial = nfoData?.series || extra.serial || '';
  // 女优数据：NFO优先，网络数据兜底
  const finalActresses = nfoData?.actors || extra.actress || [];

  // 女优头像：javbus 影片页自带的 .avatar-box，搭车下载（零额外请求）
  // 失败不影响主流程 —— 头像是锦上添花，不能因此让整条刮削挂掉
  if (extra.actressAvatars && extra.actressAvatars.length) {
    for (const { name: aName, avatar: aUrl } of extra.actressAvatars) {
      try {
        if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
        const fname = avatarFileName(aName);
        const savePath = path.join(AVATAR_DIR, fname);
        if (!fs.existsSync(savePath) || fs.statSync(savePath).size < 1024) {
          await downloadImage(aUrl, savePath, extra.detailUrl || '');
        }
        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1024) {
          updateActressProfile.run({
            name: aName,
            avatar: `/avatars/${fname}`
          });
        }
      } catch (e) {
        // 单个演员头像失败就跳过
      }
    }
  }

  // 6. 网络海报兜底：本地无封面且网络有海报时下载
  if (!localPoster && movieInfo?.poster_path) {
    try {
      await downloadPoster(movieInfo.poster_path, posterSavePath);
      localPoster = posterSavePath;
    } catch (e) {
      console.log(`海报下载失败: ${fileName}`);
    }
  }

  // 7. 终极兜底：截取视频帧
  if (!localPoster) {
    try {
      await captureVideoThumb(filePath, posterSavePath, meta.duration);
      localPoster = posterSavePath;
    } catch (e) {
      console.log(`截图失败: ${fileName}`, e.message);
    }
  }

  const record = {
    filePath,
    fileName,
    type: 'jav',
    avid: finalAvid,
    cleanName,
    fileSize: stat.size,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    tmdbId: movieInfo?.id || null,
    title: finalTitle,
    originalTitle: finalOriginalTitle,
    overview: finalOverview,
    releaseDate: finalReleaseDate,
    posterPath: movieInfo?.poster_path || undefined,
    localPosterPath: localPoster,
    country: movieInfo?.origin_country?.join(',') || '',
    genres: finalGenres,
    producer: finalProducer,
    publisher: finalPublisher,
    serial: finalSerial,
    director: finalDirector,
    score: extra.score || 0,
    source: nfoData ? 'local-nfo' : (extra.source || 'local'),
    lastScanTime: Date.now(),
    addedTime: Date.now()
  };

  // 8. 导出 NFO 和海报到视频同目录（兼容其他媒体库软件）
  const exportCfg = config.export || {};
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));

  // 导出 NFO
  if (exportCfg.enableNfoExport && !nfoData) {
    try {
      const nfoPath = path.join(dir, `${stem}.nfo`);
      if (!fs.existsSync(nfoPath) || exportCfg.overwriteExisting) {
        generateNfo({
          ...record,
          actresses: extra.actress || []
        }, nfoPath);
      }
    } catch (e) {
      console.log(`[导出NFO失败] ${fileName}:`, e.message);
    }
  }

  // 导出海报
  if (exportCfg.enablePosterExport && localPoster && !findLocalCover(filePath)) {
    try {
      const posterNames = exportCfg.posterNames || ['poster.jpg'];
      for (const name of posterNames) {
        const destPath = path.join(dir, name);
        if (!fs.existsSync(destPath) || exportCfg.overwriteExisting) {
          fs.copyFileSync(localPoster, destPath);
        }
      }
      // 同时复制一份同名封面（OpenAver 兼容）
      const sameNamePath = path.join(dir, `${stem}.jpg`);
      if (!fs.existsSync(sameNamePath) || exportCfg.overwriteExisting) {
        fs.copyFileSync(localPoster, sameNamePath);
      }
    } catch (e) {
      console.log(`[导出海报失败] ${fileName}:`, e.message);
    }
  }

  // ===== 使用事务写入：影片+标签+女优原子写入，替代 upsertMovie + updateMovieRelations =====
  const tagList = finalGenres ? finalGenres.split(',').filter(g => g.trim()) : [];
  const movieId = upsertMovieAndRelations(record, { tags: tagList, actresses: finalActresses });

  try {
    recalcHotScore(movieId);
  } catch (e) {
    console.log(`[热度计算失败] ${fileName}:`, e.message);
  }

  return record;
}

/**
 * 全量扫描
 */
async function startFullScan() {
  if (scanStatus.running) return;
  scanStatus = {
    running: true,
    total: 0,
    current: 0,
    currentFile: '',
    stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0 }
  };

  try {
    // 收集所有文件
    const allFiles = [];
    for (const folder of config.scanFolders) {
      allFiles.push(...getVideoFiles(folder));
    }
    scanStatus.total = allFiles.length;

    // 逐个处理
    const existingPaths = new Set(getAllMovies.all().map(m => m.filePath));

    for (let i = 0; i < allFiles.length; i++) {
      scanStatus.current = i + 1;
      scanStatus.currentFile = path.basename(allFiles[i]);
      existingPaths.delete(allFiles[i]);

      try {
        await processSingleFile(allFiles[i]);
      } catch (e) {
        console.log(`处理失败: ${allFiles[i]}`, e.message);
      }
    }

    // 删除失效文件记录
    // 只有文件确实不在磁盘上才删记录：目录 EIO 时 readdir 列不出来，
    // 若直接按差集删，会把「存在但目录读不了」的 959 条好记录一起删掉。
    let removed = 0;
    for (const lostPath of existingPaths) {
      if (fs.existsSync(lostPath)) continue;
      try {
        deleteMovieByPath.run(lostPath);
        removed++;
        console.log(`移除失效记录: ${path.basename(lostPath)}`);
      } catch (e) { }
    }
    if (unreadableDirs.size) {
      console.log(`[全量扫描] 跳过 ${unreadableDirs.size} 个不可读目录，保留其中仍存在的记录`);
    }

  } finally {
    scanStatus.running = false;
  }
}

/**
 * 快速增量扫描（只处理新增和删除的文件，速度极快）
 */
async function startQuickScan() {
  if (scanStatus.running) return;
  scanStatus = {
    running: true,
    total: 0,
    current: 0,
    currentFile: '',
    stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0 }
  };

  try {
    // 收集所有文件
    const allFiles = [];
    for (const folder of config.scanFolders) {
      allFiles.push(...getVideoFiles(folder));
    }

    // 获取数据库中已有的影片文件路径（只处理jav类型，避免误删动漫/漫画/小说）
    const existingMovies = getAllMovies.all().filter(m => (m.type || 'jav') === 'jav');
    const existingPaths = new Set(existingMovies.map(m => m.filePath));
    const existingPathMap = new Map(existingMovies.map(m => [m.filePath, m]));

    // 找出新增的和删除的
    const newFiles = allFiles.filter(f => !existingPaths.has(f));
    const deletedPaths = Array.from(existingPaths).filter(p => !allFiles.includes(p));

    scanStatus.total = newFiles.length;
    console.log(`[快速扫描] 共 ${allFiles.length} 个文件，新增 ${newFiles.length} 个，删除 ${deletedPaths.length} 个`);

    // 处理新增文件
    for (let i = 0; i < newFiles.length; i++) {
      scanStatus.current = i + 1;
      scanStatus.currentFile = path.basename(newFiles[i]);

      try {
        await processSingleFile(newFiles[i]);
      } catch (e) {
        console.log(`处理失败: ${newFiles[i]}`, e.message);
      }
    }

    // 修复历史遗留：ffprobe 坏掉期间入库的记录 duration/宽高全是 0，而增量扫描原来只处理
    // 新文件，这些记录永远修不好（症状：详情页时长显示 0:00）。每次启动顺带补一遍，
    // 全部补完后这一段的条数自然收敛为 0，不再有开销。
    const brokenMeta = existingMovies.filter(m => !m.duration && m.filePath && fs.existsSync(m.filePath));
    if (brokenMeta.length) {
      console.log(`[快速扫描] 补爬历史缺失的时长/分辨率：${brokenMeta.length} 条`);
      let fixedMeta = 0;
      for (let i = 0; i < brokenMeta.length; i++) {
        const m = brokenMeta[i];
        try {
          const meta = await getVideoMetadata(m.filePath);
          if (meta && meta.duration) {
            db.prepare('UPDATE movies SET duration = ?, width = ?, height = ? WHERE id = ?')
              .run(meta.duration, meta.width || 0, meta.height || 0, m.id);
            fixedMeta++;
          }
        } catch (e) { /* 单条失败不影响其余 */ }
        if ((i + 1) % 50 === 0) console.log(`[快速扫描] 时长补爬进度 ${i + 1}/${brokenMeta.length}`);
      }
      console.log(`[快速扫描] 时长补爬完成：修复 ${fixedMeta}/${brokenMeta.length}`);
    }

    // 删除失效文件记录（同样先确认文件真的不在磁盘上）
    let removed = 0;
    for (const lostPath of deletedPaths) {
      if (fs.existsSync(lostPath)) continue;
      try {
        deleteMovieByPath.run(lostPath);
        removed++;
        console.log(`移除失效记录: ${path.basename(lostPath)}`);
      } catch (e) { }
    }

    console.log(`[快速扫描] 完成！新增 ${newFiles.length} 个，删除 ${removed} 个`);
    // 最终结果写进 stats，否则前端拿不到"新增/移除/不可读"
    scanStatus.stats.added = newFiles.length;
    scanStatus.stats.removed = removed;
    scanStatus.filesSeen = allFiles.length;
    if (unreadableDirs.size) {
      console.log(`[快速扫描] 跳过 ${unreadableDirs.size} 个不可读目录（见 /api/scanner/status 的 unreadableDirs）`);
    }

  } finally {
    scanStatus.running = false;
  }
}

function getScanStatus() {
  return { ...scanStatus, unreadableDirs: Array.from(unreadableDirs) };
}

/**
 * 动漫扫描（快速增量）
 */
async function startAnimeQuickScan() {
  if (animeScanStatus.running) return;
  animeScanStatus = {
    running: true,
    total: 0,
    current: 0,
    currentFile: '',
    stats: { localHit: 0, webScraped: 0, failed: 0, skipped: 0 }
  };

  try {
    const animeFolders = config.animeFolders || [];
    if (animeFolders.length === 0) {
      console.log('[动漫扫描] 未配置动漫目录');
      return;
    }

    // 收集所有文件
    const allFiles = [];
    for (const folder of animeFolders) {
      allFiles.push(...getVideoFiles(folder));
    }

    // 获取数据库中已有的动漫文件
    const allMovies = getAllMovies.all();
    const existingAnime = allMovies.filter(m => m.type === 'anime');
    const existingPaths = new Set(existingAnime.map(m => m.filePath));

    // 找出新增的和删除的
    const newFiles = allFiles.filter(f => !existingPaths.has(f));
    const deletedPaths = Array.from(existingPaths).filter(p => !allFiles.includes(p));

    animeScanStatus.total = newFiles.length;
    console.log(`[动漫扫描] 共 ${allFiles.length} 个文件，新增 ${newFiles.length} 个`);

    // 处理新增文件
    for (let i = 0; i < newFiles.length; i++) {
      animeScanStatus.current = i + 1;
      animeScanStatus.currentFile = path.basename(newFiles[i]);

      try {
        await processSingleAnimeFile(newFiles[i]);
      } catch (e) {
        console.log(`处理失败: ${newFiles[i]}`, e.message);
      }
    }

    // 删除失效记录（先确认文件真的不在磁盘上，坏目录不能当成文件被删）
    let removed = 0;
    for (const lostPath of deletedPaths) {
      if (fs.existsSync(lostPath)) continue;
      try {
        deleteMovieByPath.run(lostPath);
        removed++;
      } catch (e) { }
    }

    console.log(`[动漫扫描] 完成！新增 ${newFiles.length} 个，删除 ${removed} 个`);
    animeScanStatus.stats.added = newFiles.length;
    animeScanStatus.stats.removed = removed;
    animeScanStatus.filesSeen = allFiles.length;

  } finally {
    animeScanStatus.running = false;
  }
}

function getAnimeScanStatus() {
  return { ...animeScanStatus, unreadableDirs: Array.from(unreadableDirs) };
}

/**
 * 处理单个动漫文件
 */
async function processSingleAnimeFile(filePath) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const cleanName = fileName.replace(ext, '');

  console.log(`[动漫] 处理: ${fileName}`);

  try {
    // 1. 读取视频元数据
    let metadata = {};
    try {
      metadata = await getVideoMetadata(filePath);
    } catch (e) {
      console.log(`  元数据读取失败: ${e.message}`);
    }

    // 2. 读取本地 NFO
    let nfoData = null;
    try {
      const nfoPath = filePath.replace(ext, '.nfo');
      if (fs.existsSync(nfoPath)) {
        nfoData = parseNfo(nfoPath);
      }
    } catch (e) { }

    // 3. 查找本地封面
    let localCover = undefined;
    try {
      localCover = findLocalCover(filePath);
    } catch (e) { }

    // 4. 网络刮削（如果本地数据不全）——按库硬分流：anime 库统一走 hanime
    let webData = null;
    if (!nfoData || !nfoData.title || !localCover) {
      try {
        webData = await searchMovie(cleanName, fileName, 'anime', filePath);
      } catch (e) {
        console.log(`  网络刮削失败: ${e.message}`);
      }
    }

    // 刮削失败落库 / 成功清记录（供一键重刮）
    if (webData) {
      clearScrapeFailure.run(filePath);
    } else if (!nfoData?.title) {
      recordScrapeFailure.run({
        filePath,
        movieId: null,
        type: 'anime',
        reason: '本地NFO缺失且hanime未命中',
        failedAt: Date.now()
      });
    }

    // 5. 合并数据
    const title = nfoData?.title || webData?.title || cleanName;
    const originalTitle = nfoData?.originalTitle || webData?.originalTitle || '';
    const overview = nfoData?.overview || webData?.overview || '';
    const releaseDate = nfoData?.releaseDate || webData?.releaseDate || '';

    // 6. 处理封面
    let posterPath = undefined;
    let localPosterPath = undefined;

    if (localCover) {
      // 复制到缓存目录
      try {
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        const cext = path.extname(localCover);
        const cachePath = path.join(__dirname, '../cache/posters', hash + cext);

        if (!fs.existsSync(cachePath)) {
          fs.copyFileSync(localCover, cachePath);
        }
        posterPath = hash + cext;
        localPosterPath = cachePath;
      } catch (e) {
        localPosterPath = undefined;
      }
    } else if (webData?.cover) {
      // 下载网络封面 - 先保存到视频同目录，再复制到缓存
      try {
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        const cachePath = path.join(__dirname, '../cache/posters', `${hash}.jpg`);
        
        // 保存到视频同目录（方便下次扫描直接找到，不用重复刮削）
        const videoDir = path.dirname(filePath);
        const baseName = path.basename(filePath, path.extname(filePath));
        const localCoverPath = path.join(videoDir, `${baseName}-poster.jpg`);
        
        // 下载到本地视频目录
        await downloadPoster(webData.cover, localCoverPath);
        
        // 同时复制一份到缓存目录用于显示
        if (fs.existsSync(localCoverPath)) {
          fs.copyFileSync(localCoverPath, cachePath);
        }
        
        posterPath = `${hash}.jpg`;
        localPosterPath = cachePath;
        console.log(`  ✓ 封面已保存到视频目录: ${baseName}-poster.jpg`);
      } catch (e) {
        console.log(`  封面下载失败: ${e.message}`);
      }
    }

    // 7. 截图兜底
    if (!localPosterPath) {
      try {
        const hash = crypto.createHash('md5').update(filePath + '_thumb').digest('hex');
        const cachePath = path.join(__dirname, '../cache/posters', hash + '.jpg');
        await captureVideoThumb(filePath, cachePath, metadata.duration || 0);
        if (fs.existsSync(cachePath)) {
          localPosterPath = cachePath;
          posterPath = hash + '.jpg';
        }
      } catch (e) {
        console.log(`  截图失败: ${e.message}`);
      }
    }

    // 8. 写入数据库（事务）
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    const tagArr = nfoData?.genres || webData?.tags || [];

    const record = {
      filePath,
      fileName,
      type: 'anime',
      avid: '',
      cleanName,
      fileSize,
      duration: metadata.duration || 0,
      width: metadata.width || 0,
      height: metadata.height || 0,
      tmdbId: null,
      title,
      originalTitle,
      overview,
      releaseDate,
      posterPath,
      localPosterPath,
      country: '',
      genres: tagArr.join(','),
      producer: '',
      publisher: '',
      serial: '',
      director: '',
      score: 0,
      source: webData?.source || 'local',
      lastScanTime: Date.now(),
      addedTime: Date.now()
    };

    const movieId = upsertMovieAndRelations(record, { tags: tagArr, actresses: [] });

    // 10. 计算热度
    try {
      recalcHotScore(movieId);
    } catch (e) { }

    animeScanStatus.stats.localHit++;
    console.log(`  ✓ 完成: ${title}`);

  } catch (e) {
    animeScanStatus.stats.failed++;
    console.log(`  ✗ 处理失败: ${e.message}`);
  }
}

// ========== 一键重刮（仅针对刮削失败的条目） ==========
let rescrapeStatus = {
    running: false,
    total: 0,
    current: 0,
    currentFile: '',
    success: 0,
    stillFailed: 0
};

/**
 * 重新刮削所有失败记录：
 * 逐条调用 processSingleFile（失败条目无本地NFO，会重新走网络刮削），
 * 成功后从 scrape_failures 表清除，仍失败则更新失败时间。
 */
async function startRescrapeFailed() {
    if (rescrapeStatus.running) return false;
    const failures = getAllScrapeFailures.all();
    rescrapeStatus = {
        running: true,
        total: failures.length,
        current: 0,
        currentFile: '',
        success: 0,
        stillFailed: 0
    };
    console.log(`[一键重刮] 开始，共 ${failures.length} 条失败记录`);

    for (const f of failures) {
        rescrapeStatus.current++;
        rescrapeStatus.currentFile = f.fileName || f.filePath;
        if (!fs.existsSync(f.filePath)) {
            // 文件已不存在，直接清掉失效记录
            clearScrapeFailure.run(f.filePath);
            rescrapeStatus.success++;
            continue;
        }
        try {
            const before = getMovieByPath.get(f.filePath);
            await processSingleFile(f.filePath, f.type || 'jav');
            const after = getMovieByPath.get(f.filePath);

            /* ★ 2026-09-25 round27 修复判定：原来是 `after.title !== after.cleanName`。
             *
             * 那个判据把整类「本地命中」误判为失败：cleanMovieName(文件名) 与 NFO 里的标题
             * **本来就一模一样**（都是「番号 + 日文标题」，如 SODS-088 全ての…），
             * 于是每次重刮都计 stillFailed 并把记录重新写回 scrape_failures ⇒ **永远 0 成功**。
             * 实测 2026-09-25 那次：成功 0 / 仍失败 41，其中 23 条正是这种「本地命中」。
             *
             * 正确判据：这条记录现在有没有**真实标题**（排除「只剩番号」的兜底产物），
             * 或者标题相比重刮前确实变了。二者满足其一即为成功。 */
            const titleOk = !!(after && after.title && !titleIsCodeOnly(after.title));
            const changed = !!(before && after && before.title !== after.title);
            const scraped = titleOk || changed;
            if (scraped) {
                clearScrapeFailure.run(f.filePath);
                rescrapeStatus.success++;
                console.log(`[一键重刮] ✓ ${path.basename(f.filePath)}`);
            } else {
                rescrapeStatus.stillFailed++;
                recordScrapeFailure.run({
                    filePath: f.filePath,
                    movieId: after?.id || null,
                    type: f.type || 'jav',
                    reason: `重刮仍未命中（第${(f.retryCount || 0) + 1}次）`,
                    failedAt: Date.now()
                });
                db.prepare('UPDATE scrape_failures SET retryCount = retryCount + 1 WHERE filePath = ?')
                    .run(f.filePath);
            }
        } catch (e) {
            rescrapeStatus.stillFailed++;
            console.log(`[一键重刮] ✗ ${path.basename(f.filePath)}: ${e.message}`);
        }
        // 限流，避免打爆刮削源
        await new Promise(r => setTimeout(r, config.network?.requestInterval || 800));
    }

    rescrapeStatus.running = false;
    console.log(`[一键重刮] 完成！成功 ${rescrapeStatus.success}，仍失败 ${rescrapeStatus.stillFailed}`);
    return true;
}

function getRescrapeStatus() {
    return { ...rescrapeStatus };
}

module.exports = {
  startFullScan,
  startQuickScan,
  startAnimeQuickScan,
  getScanStatus,
  getAnimeScanStatus,
  processSingleFile,
  processSingleAnimeFile,
  getVideoFiles,
  startRescrapeFailed,
  getRescrapeStatus
};