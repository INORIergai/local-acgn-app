/**
 * 漫画阅读器路由
 * 支持漫画阅读、进度保存、阅读计时等功能
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getMovieById, getAllMovies } = require('../utils/db');
const config = require('../utils/config');

// 阅读进度存储（内存版，后续可持久化到数据库）
const readingProgress = {};
// 阅读计时存储
const readingSessions = {};

// 持久化阅读时长
function persistReadingDuration(movieId, durationMs) {
    try {
        const db = require('../utils/db').db;
        const seconds = Math.max(0, Math.round(durationMs / 1000));
        if (seconds <= 0) return;
        const stmt = db.prepare('INSERT INTO reading_history (movieId, type, duration, readDate) VALUES (?, ?, ?, ?)');
        stmt.run(movieId, 'comic', seconds, Date.now());
    } catch (e) {
        console.log('阅读时长持久化失败:', e.message);
    }
}

// 获取某个作品的累计阅读时长
function getMovieReadingStats(movieId) {
    try {
        const db = require('../utils/db').db;
        const row = db.prepare(`
            SELECT COALESCE(SUM(duration), 0) as totalSeconds,
                   COUNT(*) as sessionCount,
                   MAX(readDate) as lastRead
            FROM reading_history WHERE movieId = ?
        `).get(movieId);
        return row || { totalSeconds: 0, sessionCount: 0, lastRead: null };
    } catch (e) {
        return { totalSeconds: 0, sessionCount: 0, lastRead: null };
    }
}

// 获取最近N天每日阅读时长（柱状图数据）
function getDailyReadingStats(type, days = 7) {
    try {
        const db = require('../utils/db').db;
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - (days - 1));
        const startTs = start.getTime();

        const rows = db.prepare(`
            SELECT readDate, duration FROM reading_history
            WHERE type = ? AND readDate >= ?
        `).all(type, startTs);

        // 按天聚合
        const daily = {};
        for (const r of rows) {
            const d = new Date(r.readDate);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            daily[key] = (daily[key] || 0) + r.duration;
        }

        // 生成近 days 天的数组
        const result = [];
        for (let i = 0; i < days; i++) {
            const d = new Date(startTs + i * 86400000);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            result.push({
                date: key,
                seconds: daily[key] || 0
            });
        }
        return result;
    } catch (e) {
        console.log('阅读统计聚合失败:', e.message);
        return [];
    }
}

// 获取全部阅读统计（总计 + 作品排名）
function getAllReadingStats(type) {
    try {
        const db = require('../utils/db').db;
        const total = db.prepare(`
            SELECT COALESCE(SUM(duration), 0) as totalSeconds, COUNT(*) as sessionCount
            FROM reading_history WHERE type = ?
        `).get(type);

        const topList = db.prepare(`
            SELECT movieId, SUM(duration) as seconds, COUNT(*) as sessions, MAX(readDate) as lastRead
            FROM reading_history WHERE type = ?
            GROUP BY movieId ORDER BY seconds DESC LIMIT 10
        `).all(type);

        const movies = getAllMovies.all();
        const idMap = {};
        for (const m of movies) idMap[m.id] = m;

        const top = topList.map(t => ({
            movieId: t.movieId,
            title: idMap[t.movieId]?.title || idMap[t.movieId]?.fileName || `ID:${t.movieId}`,
            fileName: idMap[t.movieId]?.fileName || '',
            seconds: t.seconds,
            sessions: t.sessions,
            lastRead: t.lastRead
        }));

        return {
            totalSeconds: total?.totalSeconds || 0,
            sessionCount: total?.sessionCount || 0,
            top: top
        };
    } catch (e) {
        console.log('阅读总统计失败:', e.message);
        return { totalSeconds: 0, sessionCount: 0, top: [] };
    }
}

/**
 * 获取漫画文件中的图片列表
 * 支持 zip/cbz 格式
 */
function getComicImages(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.zip' || ext === '.cbz') {
        return getZipImages(filePath);
    } else if (ext === '.epub') {
        return getEpubImages(filePath);
    } else if (ext === '.pdf') {
        // PDF需要特殊处理，暂时返回空
        return [];
    } else if (fs.statSync(filePath).isDirectory()) {
        // 文件夹模式，直接读取图片
        return getDirectoryImages(filePath);
    }
    
    return [];
}

/**
 * 从zip文件中获取图片列表
 */
function getZipImages(filePath) {
    try {
        // 使用Node.js内置的zlib解压
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const images = entries
            .filter(entry => {
                const ext = path.extname(entry.entryName).toLowerCase();
                return imageExtensions.includes(ext) && !entry.isDirectory;
            })
            .map(entry => entry.entryName)
            .sort(naturalCompare);
        
        return images;
    } catch (e) {
        console.log('读取zip失败:', e.message);
        return [];
    }
}

/**
 * 从epub文件中获取图片列表
 * epub本质上是zip，里面包含HTML和图片
 * 优先解析content.opf获取正确的阅读顺序，其次按HTML文件顺序，最后按图片文件名自然排序
 */
function getEpubImages(filePath) {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const imageEntries = entries.filter(entry => {
            const ext = path.extname(entry.entryName).toLowerCase();
            return imageExtensions.includes(ext) && !entry.isDirectory;
        });
        
        // 尝试从OPF文件获取阅读顺序
        const opfEntry = entries.find(e => e.entryName.endsWith('.opf'));
        if (opfEntry) {
            try {
                const opfContent = opfEntry.getData().toString('utf8');
                // 解析spine中的itemref顺序
                const spineMatch = opfContent.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
                if (spineMatch) {
                    const idrefs = [...spineMatch[1].matchAll(/idref="([^"]+)"/gi)].map(m => m[1]);
                    // 解析manifest中的id到href的映射
                    const manifestMatch = opfContent.match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
                    const idToHref = {};
                    if (manifestMatch) {
                        [...manifestMatch[1].matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/gi)].forEach(m => {
                            idToHref[m[1]] = m[2];
                        });
                    }
                    // 按spine顺序获取HTML文件，然后从HTML中提取图片
                    const htmlFiles = idrefs.map(id => idToHref[id]).filter(Boolean);
                    const orderedImages = [];
                    for (const htmlFile of htmlFiles) {
                        const htmlEntry = entries.find(e => e.entryName.endsWith(htmlFile) || e.entryName === htmlFile);
                        if (htmlEntry) {
                            const htmlContent = htmlEntry.getData().toString('utf8');
                            // 匹配img标签的src属性，支持跨行和单引号
                            const imgRegex = /<img[^>]*?src=["']([^"']+)["']/gi;
                            let match;
                            while ((match = imgRegex.exec(htmlContent)) !== null) {
                                let imgSrc = match[1];
                                // 处理相对路径
                                const htmlDir = path.dirname(htmlFile);
                                const fullImgPath = path.normalize(path.join(htmlDir, imgSrc)).replace(/\\/g, '/');
                                const imgEntry = imageEntries.find(e => e.entryName === fullImgPath || e.entryName.endsWith(imgSrc.replace(/^\.\.\//, '')));
                                if (imgEntry && !orderedImages.includes(imgEntry.entryName)) {
                                    orderedImages.push(imgEntry.entryName);
                                }
                            }
                        }
                    }
                    if (orderedImages.length > 0) {
                        return orderedImages;
                    }
                }
            } catch (e) {
                console.log('解析OPF失败，使用默认排序:', e.message);
            }
        }
        
        // 按HTML文件顺序提取图片
        const htmlEntries = entries.filter(e => 
            (e.entryName.endsWith('.html') || e.entryName.endsWith('.xhtml')) && !e.isDirectory
        ).sort((a, b) => naturalCompare(a.entryName, b.entryName));
        
        if (htmlEntries.length > 0) {
            const orderedImages = [];
            for (const htmlEntry of htmlEntries) {
                try {
                    const htmlContent = htmlEntry.getData().toString('utf8');
                    // 匹配img标签的src属性，支持跨行和单引号
                    const imgRegex = /<img[^>]*?src=["']([^"']+)["']/gi;
                    let match;
                    while ((match = imgRegex.exec(htmlContent)) !== null) {
                        const imgSrc = match[1];
                        const imgEntry = imageEntries.find(e => e.entryName.endsWith(imgSrc.replace(/^\.\.\//, '')));
                        if (imgEntry && !orderedImages.includes(imgEntry.entryName)) {
                            orderedImages.push(imgEntry.entryName);
                        }
                    }
                } catch (e) {}
            }
            if (orderedImages.length > 0) {
                return orderedImages;
            }
        }
        
        // 最后兜底：按自然排序（数字部分按数值比较）
        return imageEntries
            .map(entry => entry.entryName)
            .sort(naturalCompare);
    } catch (e) {
        console.log('读取epub失败:', e.message);
        return [];
    }
}

/**
 * 自然排序比较函数（数字部分按数值比较）
 */
function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * 从文件夹中获取图片列表
 */
function getDirectoryImages(dirPath) {
    try {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const files = fs.readdirSync(dirPath);
        const images = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return imageExtensions.includes(ext);
            })
            .sort();
        
        return images.map(name => path.join(dirPath, name));
    } catch (e) {
        console.log('读取文件夹失败:', e.message);
        return [];
    }
}

/**
 * 从压缩文件中提取单张图片
 */
function extractImageFromArchive(filePath, imageName) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.zip' || ext === '.cbz' || ext === '.epub') {
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(filePath);
            const entry = zip.getEntry(imageName);
            if (entry) {
                return entry.getData();
            }
        } catch (e) {
            console.log('提取图片失败:', e.message);
        }
    }
    
    return null;
}

/* ============================================================================
   ★ round26 续 #7：PDF 打不开的「可自证」记录
   ----------------------------------------------------------------------------
   用户报「PDF 依旧会显示打开报错」，但全量审计（178/178 文件合法、接口 200、
   实开 3 部正常）无法复现。为了不再靠"要用户描述"，这里把两类失败都记下来：
     · 服务端：PDF 文件不存在 / 不可读 / 流错误
     · 客户端：pdf.js 解析失败 / 渲染失败（由 comic-reader.html 回报）
   查询：GET /api/comic/pdf-errors
   ⚠️ 必须注册在 /:id 之前，否则 'pdf-errors' 会被当成漫画 id。
   ============================================================================ */
const PDF_ERRORS = [];
function recordPdfError(entry) {
    const rec = Object.assign({ at: Date.now() }, entry || {});
    PDF_ERRORS.unshift(rec);
    if (PDF_ERRORS.length > 200) PDF_ERRORS.length = 200;
    console.error('[PDF错误]', JSON.stringify(rec));
    // 最好再落一份盘，进程崩了也留痕
    try {
        const fs2 = require('fs');
        const dir = path.join(process.cwd(), 'logs');
        if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
        fs2.appendFileSync(path.join(dir, 'pdf-errors.log'),
            new Date(rec.at).toISOString() + ' ' + JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) { /* 落盘失败不影响主流程 */ }
    return rec;
}

router.get('/pdf-errors', (req, res) => {
    res.json({ code: 0, data: PDF_ERRORS });
});

// 客户端（comic-reader 里的 pdf.js）回报的失败
router.post('/:id/pdf-error', (req, res) => {
    const b = req.body || {};
    recordPdfError({
        side: 'client', movieId: req.params.id,
        stage: String(b.stage || '').slice(0, 60),
        message: String(b.message || '').slice(0, 400),
        ua: String(b.ua || '').slice(0, 160)
    });
    res.json({ code: 0 });
});

// 获取漫画信息和图片列表
router.get('/:id/info', (req, res) => {
    try {
        const comic = getMovieById.get(req.params.id);
        if (!comic) return res.json({ code: -1, msg: '漫画不存在' });
        
        const isPdf = path.extname(comic.filePath).toLowerCase() === '.pdf';
        const images = isPdf ? [] : getComicImages(comic.filePath);
        const progress = readingProgress[comic.id] || { page: 0, lastRead: null };
        
        res.json({
            code: 0,
            data: {
                id: comic.id,
                title: comic.title,
                filePath: comic.filePath,
                format: isPdf ? 'pdf' : (fs.statSync(comic.filePath).isDirectory() ? 'dir' : 'archive'),
                totalPages: isPdf ? 0 : images.length,
                currentPage: progress.page,
                lastRead: progress.lastRead,
                images: images
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取漫画PDF原始文件（供前端 pdf.js 渲染）
router.get('/:id/pdf', (req, res) => {
    try {
        const comic = getMovieById.get(req.params.id);
        if (!comic) {
            recordPdfError({ side: 'server', stage: 'lookup', movieId: req.params.id, message: '漫画记录不存在' });
            return res.status(404).send('漫画不存在');
        }

        const isPdf = path.extname(comic.filePath).toLowerCase() === '.pdf';
        if (!isPdf) return res.status(400).send('非PDF文件');

        /* ★ round26 续 #7：老实现直接 createReadStream().pipe(res)，**没有存在性检查、
         *   也没有 stream error 处理**。一旦文件读不到（盘没挂上 / bind mount 抽风 /
         *   文件被移走），流会抛未捕获的 'error'，客户端拿到的是空响应或断流 ——
         *   在 pdf.js 里就表现为「PDF 加载失败」。
         *   现在：先 stat 给明确状态码，再给流挂 error/close 处理。 */
        let stat = null;
        try {
            stat = fs.statSync(comic.filePath);
        } catch (e) {
            recordPdfError({
                side: 'server', stage: 'stat', movieId: comic.id,
                fileName: comic.fileName, filePath: comic.filePath, message: e.code || e.message
            });
            return res.status(404).json({
                code: -1, msg: `PDF 文件不可访问（${e.code || e.message}）：${comic.filePath}`
            });
        }
        if (!stat.isFile() || stat.size === 0) {
            recordPdfError({
                side: 'server', stage: 'stat', movieId: comic.id,
                fileName: comic.fileName, filePath: comic.filePath,
                message: stat.isFile() ? '文件为 0 字节' : '不是普通文件'
            });
            return res.status(422).json({ code: -1, msg: 'PDF 文件为空或不是普通文件' });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Content-Length', String(stat.size));

        const stream = fs.createReadStream(comic.filePath);
        stream.on('error', (e) => {
            recordPdfError({
                side: 'server', stage: 'stream', movieId: comic.id,
                fileName: comic.fileName, filePath: comic.filePath, message: e.code || e.message
            });
            if (!res.headersSent) res.status(500).json({ code: -1, msg: '读取 PDF 失败: ' + (e.code || e.message) });
            else try { res.destroy(); } catch (_) { }
        });
        res.on('close', () => { try { stream.destroy(); } catch (_) { } });
        return stream.pipe(res);
    } catch (e) {
        recordPdfError({ side: 'server', stage: 'route', movieId: req.params.id, message: e.message });
        res.status(500).send('读取失败: ' + e.message);
    }
});

// 获取漫画单页图片
router.get('/:id/page/:pageIndex', (req, res) => {
    try {
        const comic = getMovieById.get(req.params.id);
        if (!comic) return res.status(404).send('漫画不存在');
        
        const pageIndex = parseInt(req.params.pageIndex);
        const images = getComicImages(comic.filePath);
        
        if (pageIndex < 0 || pageIndex >= images.length) {
            return res.status(404).send('页码超出范围');
        }
        
        const imageName = images[pageIndex];
        const ext = path.extname(imageName).toLowerCase();
        
        // 如果是文件夹模式，直接读取文件
        if (fs.statSync(comic.filePath).isDirectory()) {
            const imagePath = imageName;
            if (fs.existsSync(imagePath)) {
                const contentType = getContentType(ext);
                res.setHeader('Content-Type', contentType);
                return fs.createReadStream(imagePath).pipe(res);
            }
        }
        
        // 从压缩文件中提取
        const imageData = extractImageFromArchive(comic.filePath, imageName);
        if (imageData) {
            const contentType = getContentType(ext);
            res.setHeader('Content-Type', contentType);
            return res.send(imageData);
        }
        
        res.status(404).send('图片不存在');
    } catch (e) {
        res.status(500).send('读取失败: ' + e.message);
    }
});

// 保存阅读进度
router.post('/:id/progress', (req, res) => {
    try {
        const { page } = req.body;
        const comicId = req.params.id;
        
        readingProgress[comicId] = {
            page: parseInt(page) || 0,
            lastRead: new Date().toISOString()
        };
        
        res.json({ code: 0, msg: '进度已保存' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 开始阅读计时
router.post('/:id/start-reading', (req, res) => {
    try {
        const comicId = req.params.id;
        readingSessions[comicId] = {
            startTime: Date.now(),
            totalTime: readingSessions[comicId]?.totalTime || 0
        };
        
        res.json({ code: 0, msg: '计时开始' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 结束阅读计时
router.post('/:id/stop-reading', (req, res) => {
    try {
        const comicId = req.params.id;
        const session = readingSessions[comicId];
        
        if (session && session.startTime) {
            const duration = Date.now() - session.startTime;
            session.totalTime += duration;
            session.startTime = null;
            
            // 持久化到数据库
            persistReadingDuration(parseInt(comicId), duration);
            
            res.json({
                code: 0,
                data: {
                    sessionDuration: duration,
                    totalTime: session.totalTime
                }
            });
        } else {
            res.json({ code: -1, msg: '没有进行中的阅读会话' });
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取阅读统计
router.get('/:id/stats', (req, res) => {
    try {
        const comicId = req.params.id;
        const session = readingSessions[comicId];
        const progress = readingProgress[comicId];
        const persisted = getMovieReadingStats(parseInt(comicId));
        
        res.json({
            code: 0,
            data: {
                totalTime: (session?.totalTime || 0) + (persisted.totalSeconds * 1000),
                currentPage: progress?.page || 0,
                lastRead: progress?.lastRead || null,
                totalSeconds: persisted.totalSeconds,
                sessionCount: persisted.sessionCount
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取所有漫画的阅读统计
router.get('/stats/all', (req, res) => {
    try {
        const allStats = {};
        for (const [comicId, session] of Object.entries(readingSessions)) {
            const persisted = getMovieReadingStats(parseInt(comicId));
            allStats[comicId] = {
                totalTime: (session.totalTime || 0) + (persisted.totalSeconds * 1000),
                totalSeconds: persisted.totalSeconds,
                currentPage: readingProgress[comicId]?.page || 0,
                lastRead: readingProgress[comicId]?.lastRead || null
            };
        }
        
        res.json({ code: 0, data: allStats });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 漫画库阅读统计总览（主界面横幅）
router.get('/stats/overview', (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const summary = getAllReadingStats('comic');
        const daily = getDailyReadingStats('comic', days);
        res.json({
            code: 0,
            data: {
                ...summary,
                daily: daily
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 漫画库文件夹树（按子文件夹递归分组）
router.get('/tree', (req, res) => {
    try {
        const { buildTree, flattenTree } = require('../utils/media-tree');
        const all = getAllMovies.all().filter(m => (m.type || 'jav') === 'comic');
        const roots = config.comicFolders || [];
        const tree = buildTree(all, roots);
        const groups = flattenTree(tree);
        res.json({ code: 0, data: { tree, groups, roots } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取内容类型
function getContentType(ext) {
    const types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.webp': 'image/webp'
    };
    return types[ext] || 'application/octet-stream';
}

module.exports = router;
