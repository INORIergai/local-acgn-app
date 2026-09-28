/**
 * 批量重命名服务
 * 将只有番号的文件重命名为：【番号】片名 - 女优名.扩展名
 */

const fs = require('fs');
const path = require('path');
const { getAllMovies, getMovieById, getMovieByPath, db } = require('./db');
const { searchMovie, extractAvId } = require('./poster-fetcher');
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

module.exports = {
  previewRename,
  startBatchRename,
  getRenameStatus,
  generateNewFileName,
  sanitizeFileName
};
