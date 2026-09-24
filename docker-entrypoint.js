/**
 * Docker容器启动脚本
 * 1. 把数据库中的Windows路径转换为容器内路径
 * 2. 启动server.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'db/movie.db');

// 路径映射表（Windows路径 -> 容器内路径）
// 支持反斜杠和正斜杠两种格式
const pathMappings = [
    { win: 'D:\\Movies', linux: '/media/movies' },
    { win: 'D:\\Movies2', linux: '/media/movies2' },
    { win: 'D:\\Anime', linux: '/media/anime' },
    { win: 'D:\\Comics', linux: '/media/comic' },
    { win: 'D:\\Novels', linux: '/media/novel' },
    { win: 'D:\\Downloads\\Movies', linux: '/media/downloads' },
];

function convertPath(filePath) {
    if (!filePath) return filePath;
    let result = filePath;
    
    // 长前缀优先：否则 'D:\\Anime' 会被更短的 'D:\\Movies2' 吃掉，
    // 写成 /media/anime（容器里没有这个挂载点）→ 整个动漫库查不到文件。
    const ordered = [...pathMappings].sort((a, b) => b.win.length - a.win.length);

    // 历史遗留错误前缀：DB 里已经写坏的那些也顺手修回来
    const LEGACY_ANIME_PREFIX = '/media/anime';
    if (result.startsWith(LEGACY_ANIME_PREFIX)) {
        return '/media/anime' + result.slice(LEGACY_ANIME_PREFIX.length);
    }

    // 尝试匹配每种映射
    for (const mapping of ordered) {
        // 支持反斜杠格式
        if (result.startsWith(mapping.win)) {
            result = mapping.linux + result.substring(mapping.win.length);
            result = result.replace(/\\/g, '/');
            return result;
        }
        // 支持正斜杠格式
        const winPosix = mapping.win.replace(/\\/g, '/');
        if (result.startsWith(winPosix)) {
            result = mapping.linux + result.substring(winPosix.length);
            return result;
        }
    }
    
    // 如果是Windows绝对路径但没匹配到映射，尝试通用转换
    if (/^[A-Z]:[\\/]/.test(result)) {
        console.log('[路径转换] 未匹配的Windows路径:', result.substring(0, 60));
    }
    
    return result;
}

async function convertDatabasePaths() {
    console.log('[路径转换] 开始转换数据库路径...');
    
    if (!fs.existsSync(dbPath)) {
        console.log('[路径转换] 数据库不存在，跳过');
        return;
    }

    try {
        const db = new Database(dbPath);
        
        const movies = db.prepare('SELECT id, filePath FROM movies').all();
        console.log(`[路径转换] 共 ${movies.length} 条影片记录`);
        
        let converted = 0;
        let alreadyLinux = 0;
        
        for (const movie of movies) {
            const oldPath = movie.filePath;
            
            // 已经是Linux路径的跳过（历史错误前缀除外，见 convertPath）
            if (oldPath && oldPath.startsWith('/media/') && !oldPath.startsWith('/media/anime')) {
                alreadyLinux++;
                continue;
            }
            
            const newPath = convertPath(oldPath);
            if (newPath !== oldPath) {
                db.prepare('UPDATE movies SET filePath = ? WHERE id = ?').run(newPath, movie.id);
                converted++;
            }
        }
        
        console.log(`[路径转换] 已转换 ${converted} 条，已是Linux路径 ${alreadyLinux} 条`);
        
        // 显示转换后的示例
        const sample = db.prepare('SELECT filePath FROM movies LIMIT 2').all();
        sample.forEach((s, i) => console.log(`[路径转换] 示例${i+1}:`, s.filePath ? s.filePath.substring(0, 80) : 'null'));
        
        db.close();
        console.log('[路径转换] 完成');
    } catch (e) {
        console.error('[路径转换] 失败:', e.message);
    }
}

// 自检：PATHMAP_SELFTEST=1 node docker-entrypoint.js 时只跑路径映射断言
if (process.env.PATHMAP_SELFTEST) {
  const assert = require('assert');
  assert.strictEqual(convertPath('D:\\Anime\\x.mp4'), '/media/anime/x.mp4');
  assert.strictEqual(convertPath('D:\\Movies2\\x.mp4'), '/media/movies2/x.mp4');
  assert.strictEqual(convertPath('D:/Anime/x.mp4'), '/media/anime/x.mp4');
  assert.strictEqual(convertPath('/media/anime/Aba/y.mp4'), '/media/anime/Aba/y.mp4');
  assert.strictEqual(convertPath('/media/movies/x.mp4'), '/media/movies/x.mp4');
  assert.strictEqual(convertPath('D:\\Downloads\\Movies/z.mp4'), '/media/downloads/z.mp4');
  console.log('[路径映射自检] 全部通过');
  process.exit(0);
}

// 先转换路径，再启动服务
convertDatabasePaths().then(() => {
    console.log('[启动] 正在启动服务...');
    require('./server.js');
});
