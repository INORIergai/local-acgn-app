/**
 * 批量重命名服务
 * 将只有番号的文件重命名为：【番号】片名 - 女优名.扩展名
 */

const fs = require('fs');
const path = require('path');
const { getAllMovies, getMovieById, getMovieByPath, db, withFtsHeal } = require('./db');
const { searchMovie, extractAvId, cleanMovieName } = require('./poster-fetcher');
const { toHostPath } = require('./path-map');
const config = require('./config');

// 重命名状态
let renameStatus = {
  running: false,
  total: 0,
  current: 0,
  currentFile: '',
  success: 0,
  failed: 0,
  skipped: 0,
  previewList: []
};

/**
 * 清理文件名中的非法字符
 */
function sanitizeFileName(name) {
  // 移除或替换Windows下的非法字符
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 生成新文件名
 * 格式：【番号】片名 - 女优名.扩展名
 */
function generateNewFileName(movie, info) {
  const ext = path.extname(movie.fileName);
  const avid = info.num || movie.avid || '';
  const title = info.title || movie.title || '';
  
  // 女优名
  let actressName = '';
  if (info.actresses && info.actresses.length > 0) {
    actressName = info.actresses.map(a => a.name || a).join('、');
  } else if (movie.actresses && movie.actresses.length > 0) {
    actressName = movie.actresses.map(a => a.name).join('、');
  }
  
  // 构建文件名
  let newName = '';
  if (avid) {
    newName += `【${avid}】`;
  }
  if (title) {
    newName += title;
  }
  if (actressName) {
    newName += ` - ${actressName}`;
  }
  
  // 如果没有任何信息，返回原文件名
  if (!newName) {
    return movie.fileName;
  }
  
  // 清理非法字符
  newName = sanitizeFileName(newName);
  
  // 限制文件名长度（Windows最大255字符，预留扩展名）
  const maxLength = 200;
  if (newName.length > maxLength) {
    newName = newName.substring(0, maxLength) + '...';
  }
  
  return newName + ext;
}

/**
 * 检查文件是否需要重命名
 * 以下情况都需要重命名：
 * 1. 只有番号的影片（如 ABP-123.mp4）
 * 2. 番号+中文的影片（如 ABP-123 中文标题.mp4）
 * 3. 格式不统一的影片
 * 只有已经是【番号】片名 - 女优名 格式的才跳过
 */
function needsRename(movie) {
  const fileName = movie.fileName;
  const ext = path.extname(fileName);
  const nameWithoutExt = fileName.replace(ext, '');
  
  // 如果已经是【番号】... - 女优名 的格式，跳过
  // 匹配：【XXX-123】... - ...
  if (/^【[A-Za-z0-9-]+】.+ - .+$/.test(nameWithoutExt)) {
    return false;
  }
  
  // 如果文件名包含【】但没有" - "分隔符，说明格式不完整，需要重命名
  if (nameWithoutExt.includes('【') && nameWithoutExt.includes('】')) {
    return true;
  }
  
  // 有番号的影片都需要重命名（统一格式）
  const avidResult = extractAvId(fileName);
  if (avidResult && avidResult.avid) {
    return true;
  }
  
  // 没有番号的影片跳过
  return false;
}

/**
 * 预览重命名（不实际执行）
 */
async function previewRename() {
  const movies = getAllMovies.all();
  const previewList = [];
  
  for (const movie of movies) {
    if (!needsRename(movie)) continue;
    if (!movie.avid) continue;
    
    try {
      // 搜索影片信息
      const info = await searchMovie(movie.cleanName, movie.fileName);
      if (info && info.title) {
        const newFileName = generateNewFileName(movie, info);
        previewList.push({
          id: movie.id,
          oldName: movie.fileName,
          newName: newFileName,
          path: movie.filePath,
          title: info.title,
          num: info.num,
          source: info.source
        });
      }
      
      // 避免请求太快
      await new Promise(r => setTimeout(r, config.network.requestInterval || 500));
    } catch (e) {
      console.log(`预览失败 [${movie.fileName}]:`, e.message);
    }
  }
  
  renameStatus.previewList = previewList;
  return previewList;
}

/**
 * 执行单个文件重命名
 */
async function renameSingleMovie(movie) {
  const oldPath = movie.filePath;
  const dir = path.dirname(oldPath);
  const ext = path.extname(oldPath);
  
  try {
    // 搜索影片信息
    const info = await searchMovie(movie.cleanName, movie.fileName);
    if (!info || !info.title) {
      renameStatus.skipped++;
      return false;
    }
    
    // 生成新文件名
    const newFileName = generateNewFileName(movie, info);
    const newPath = path.join(dir, newFileName);
    
    // 如果文件名相同，跳过
    if (oldPath === newPath) {
      renameStatus.skipped++;
      return false;
    }
    
    // 检查新文件是否已存在
    if (fs.existsSync(newPath)) {
      console.log(`  跳过：新文件名已存在 ${newFileName}`);
      renameStatus.skipped++;
      return false;
    }
    
    // 重命名视频文件
    fs.renameSync(oldPath, newPath);
    
    // 重命名NFO文件
    const oldNfoPath = oldPath.replace(ext, '.nfo');
    const newNfoPath = newPath.replace(ext, '.nfo');
    if (fs.existsSync(oldNfoPath)) {
      fs.renameSync(oldNfoPath, newNfoPath);
    }
    
    // 重命名封面文件（同名jpg）
    const oldCoverPath = oldPath.replace(ext, '.jpg');
    const newCoverPath = newPath.replace(ext, '.jpg');
    if (fs.existsSync(oldCoverPath)) {
      fs.renameSync(oldCoverPath, newCoverPath);
    }
    
    // 重命名其他可能的封面文件
    const coverNames = ['poster.jpg', 'folder.jpg', 'fanart.jpg', 'cover.jpg'];
    for (const coverName of coverNames) {
      const oldCover = path.join(dir, coverName);
      if (fs.existsSync(oldCover)) {
        // 同目录下的通用封面不重命名
      }
    }
    
    // 更新数据库
    const updateStmt = db.prepare(`
      UPDATE movies 
      SET filePath = ?, fileName = ?, title = ?, originalTitle = ?, overview = ?, 
          releaseDate = ?, producer = ?, director = ?, score = ?, source = ?
      WHERE id = ?
    `);
    
    updateStmt.run(
      newPath,
      newFileName,
      info.title || movie.title,
      info.originalTitle || movie.originalTitle,
      info.overview || movie.overview,
      info.releaseDate || movie.releaseDate,
      info.producer || movie.producer,
      info.director || movie.director,
      info.score || movie.score || 0,
      info.source || movie.source,
      movie.id
    );
    
    // 更新标签和女优关联
    try {
      const { updateMovieRelations } = require('./db');
      const tags = info.genres || [];
      const actresses = info.actresses || [];
      updateMovieRelations(movie.id, tags, actresses);
    } catch (e) {}
    
    renameStatus.success++;
    console.log(`  ✓ 重命名成功: ${movie.fileName} -> ${newFileName}`);
    return true;
    
  } catch (e) {
    renameStatus.failed++;
    console.log(`  ✗ 重命名失败: ${movie.fileName} - ${e.message}`);
    return false;
  }
}

/**
 * 执行批量重命名
 */
async function startBatchRename() {
  if (renameStatus.running) return;
  
  renameStatus = {
    running: true,
    total: 0,
    current: 0,
    currentFile: '',
    success: 0,
    failed: 0,
    skipped: 0,
    previewList: []
  };
  
  try {
    // 获取所有影片
    const movies = getAllMovies.all();
    
    // 筛选需要重命名的影片
    const toRename = movies.filter(m => m.avid && needsRename(m));
    renameStatus.total = toRename.length;
    
    console.log(`[批量重命名] 共 ${toRename.length} 个文件需要重命名`);
    
    // 逐个重命名
    for (let i = 0; i < toRename.length; i++) {
      renameStatus.current = i + 1;
      renameStatus.currentFile = toRename[i].fileName;
      
      await renameSingleMovie(toRename[i]);
      
      // 避免请求太快
      await new Promise(r => setTimeout(r, config.network.requestInterval || 500));
    }
    
    console.log(`[批量重命名] 完成！成功 ${renameStatus.success}，失败 ${renameStatus.failed}，跳过 ${renameStatus.skipped}`);
    
  } finally {
    renameStatus.running = false;
  }
}

/**
 * 获取重命名状态
 */
function getRenameStatus() {
  return { ...renameStatus };
}

/**
 * ★ round52：改名落盘核心（原来内联在 routes/movie.js 的 POST /:id/rename，抽出来给批量共用）
 *
 * 落盘口径（务必与前端 suggestFileNameStem 的净化规则保持一致）：
 * 磁盘视频 + 同目录同名 .nfo + 同名 .jpg + 库内 filePath/fileName/cleanName（带 FTS 自愈）
 * + 标题跟随策略（round26 #2）。
 * 返回 { code, msg, data? } JSON 形状：单片接口原样回给前端，批量接口逐条消费。
 * 注意：本函数只做本地文件系统与 SQLite 写入，不发起任何网络请求。
 */

// 新名净化：非法字符换成空格并收紧空白；末尾的点/空格在 Windows 上不合法，一并去掉。
// 批量入口直接吃前端传来的名字，这里兜底净化，也顺带杜绝路径穿越（\/ 都会被替换）。
function sanitizeRenameStem(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 180)
    .trim();
}

async function renameOneMovie(id, rawNewName, wantSync) {
  try {
    const newName = sanitizeRenameStem(rawNewName);
    const movie = getMovieById.get(id);
    if (!movie) return { code: -1, msg: '影片不存在' };
    if (!newName) return { code: -1, msg: '新名称不能为空' };

    const oldPath = movie.filePath;
    const dir = path.dirname(oldPath);
    const ext = path.extname(movie.fileName);
    const oldStem = path.basename(movie.fileName, ext);
    const realNewFileName = newName + ext;
    const newPath = path.join(dir, realNewFileName);

    if (oldPath === newPath) {
      return { code: 0, msg: '名称未改变' };
    }
    // 数据库路径可能已过时（文件被外部改名/移动）。给出真正原因，
    // 而不是抛 ENOENT 让用户误以为"原文件名被别人改过了"。
    if (!fs.existsSync(oldPath)) {
      return { code: -1, msg: `原文件已不存在：${movie.fileName}（可能已被重命名或移动，请先执行一次扫描）` };
    }
    if (fs.existsSync(newPath)) {
      return { code: -1, msg: '目标文件已存在' };
    }

    //重命名磁盘视频
    fs.renameSync(oldPath, newPath);

    // NFO 与同名封面：用 stem 拼接，不用 replace(ext)
    // （replace(ext,'.nfo') 会替换路径里第一次出现的 ".mp4" 片段，不只是扩展名）
    for (const suffix of ['.nfo', '.jpg']) {
      const oldSide = path.join(dir, oldStem + suffix);
      const newSide = path.join(dir, newName + suffix);
      if (fs.existsSync(oldSide)) fs.renameSync(oldSide, newSide);
    }

    //=====重点：同步更新 cleanName！=====（cleanMovieName 为纯字符串清洗，不联网）
    const newCleanName = cleanMovieName(realNewFileName);

    withFtsHeal(() => db.prepare(`
      UPDATE movies
      SET filePath = ?, fileName = ?, cleanName = ?
      WHERE id = ?
    `).run(newPath, realNewFileName, newCleanName, id), '重命名');

    /* ★ round26 #2：标题更新策略
     *   ① 明确传 updateTitle=true → 无条件跟随新文件名；
     *   ② 没传 → 保守逻辑：只有当标题本来就是从文件名推出来的
     *      （空 / 等于旧 stem / 等于 cleanName）才跟随。
     *   批量改名沿用同一策略：预览名由「番号 + 标题」生成，标题即来源，
     *   一般不会触发跟随；刮到的片名不会被文件名覆盖。 */
    let titleUpdated = false;
    const derivedFromName = !movie.title || movie.title === oldStem || movie.title === movie.cleanName;
    if (wantSync === true || (wantSync === undefined && derivedFromName)) {
      withFtsHeal(() => db.prepare('UPDATE movies SET title = ? WHERE id = ?').run(newName, id), '重命名同步标题');
      titleUpdated = true;
    }

    return {
      code: 0,
      msg: '重命名成功',
      data: {
        fileName: realNewFileName,
        newName,
        titleUpdated,
        oldTitle: movie.title || '',
        hostPath: toHostPath(newPath)
      }
    };
  } catch (e) {
    return { code: -1, msg: e.message };
  }
}

module.exports = {
  previewRename,
  startBatchRename,
  getRenameStatus,
  generateNewFileName,
  sanitizeFileName,
  sanitizeRenameStem,
  renameOneMovie
};
