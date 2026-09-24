/**
 * 小说阅读器路由
 * 支持小说阅读、进度保存、阅读计时等功能
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getMovieById } = require('../utils/db');
const config = require('../utils/config');

// 阅读进度存储
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
        stmt.run(movieId, 'novel', seconds, Date.now());
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

        const daily = {};
        for (const r of rows) {
            const d = new Date(r.readDate);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            daily[key] = (daily[key] || 0) + r.duration;
        }

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

// 获取全部阅读统计
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

        const movies = require('../utils/db').getAllMovies.all();
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
 * 读取小说内容
 * 支持 txt、epub 格式
 */
function getNovelContent(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.txt') {
        return getTxtContent(filePath);
    } else if (ext === '.epub') {
        return getEpubContent(filePath);
    } else if (ext === '.pdf') {
        // PDF需要特殊处理
        return { title: path.basename(filePath), chapters: [], content: 'PDF格式暂不支持在线阅读' };
    } else if (ext === '.mobi' || ext === '.azw3') {
        return { title: path.basename(filePath), chapters: [], content: 'Mobi/AZW3格式暂不支持在线阅读' };
    }
    
    return { title: path.basename(filePath), chapters: [], content: '不支持的格式' };
}

/**
 * 读取txt文件内容
 * 自动识别编码
 */
function getTxtContent(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        let content = '';
        
        // 尝试识别编码
        if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
            // UTF-8 BOM
            content = buffer.toString('utf8', 3);
        } else if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
            // UTF-16 LE
            content = buffer.toString('utf16le', 2);
        } else if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
            // UTF-16 BE
            content = buffer.swap16().toString('utf16le', 2);
        } else {
            // 尝试GBK编码
            try {
                const iconv = require('iconv-lite');
                content = iconv.decode(buffer, 'gbk');
                // 检查是否有乱码，如果有则用utf8
                if (content.includes('�') || content.includes('锟')) {
                    content = buffer.toString('utf8');
                }
            } catch (e) {
                // 如果没有iconv-lite，用utf8
                content = buffer.toString('utf8');
            }
        }
        
        // 清理内容
        content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        
        // 简单的章节分割
        const chapters = splitIntoChapters(content);
        
        return {
            title: path.basename(filePath, path.extname(filePath)),
            chapters: chapters,
            content: content
        };
    } catch (e) {
        console.log('读取txt失败:', e.message);
        return { title: path.basename(filePath), chapters: [], content: '读取失败: ' + e.message };
    }
}

/**
 * 将文本分割成章节
 */
function splitIntoChapters(content) {
    const lines = content.split('\n');
    const chapters = [];
    let currentChapter = { title: '正文', content: '', startLine: 0 };
    
    const chapterRegex = /^[\s　]*(第[一二三四五六七八九十百千万零\d]+[章节回卷集部篇]|Chapter\s*\d+|CHAPTER\s*\d+|序章|序言|前言|引子|楔子|尾声|后记|番外)[\s　:：.．、]*(.*)$/i;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const match = line.match(chapterRegex);
        
        if (match && line.length < 50) {
            // 保存当前章节
            if (currentChapter.content.trim().length > 0 || chapters.length === 0) {
                chapters.push(currentChapter);
            }
            // 开始新章节
            currentChapter = {
                title: match[0].trim(),
                content: '',
                startLine: i
            };
        } else {
            currentChapter.content += lines[i] + '\n';
        }
    }
    
    // 保存最后一章
    if (currentChapter.content.trim().length > 0) {
        chapters.push(currentChapter);
    }
    
    // 如果没有识别到章节，把整个内容作为一章
    if (chapters.length === 0) {
        chapters.push({ title: '正文', content: content, startLine: 0 });
    }
    
    return chapters;
}

/**
 * 读取epub文件内容
 * epub本质上是zip，里面包含HTML文件
 */
function getEpubContent(filePath) {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        
        // 找到OPF文件
        let opfEntry = entries.find(e => e.entryName.endsWith('.opf'));
        if (!opfEntry) {
            // 尝试从META-INF/container.xml中查找
            const containerEntry = entries.find(e => e.entryName === 'META-INF/container.xml');
            if (containerEntry) {
                const containerXml = containerEntry.getData().toString('utf8');
                const opfMatch = containerXml.match(/full-path="([^"]+)"/);
                if (opfMatch) {
                    opfEntry = entries.find(e => e.entryName === opfMatch[1]);
                }
            }
        }
        
        let chapters = [];
        let title = path.basename(filePath, '.epub');
        
        if (opfEntry) {
            const opfXml = opfEntry.getData().toString('utf8');
            
            // 提取标题
            const titleMatch = opfXml.match(/<dc:title>([^<]+)<\/dc:title>/);
            if (titleMatch) title = titleMatch[1];
            
            // 提取manifest中的HTML文件
            const manifestMatches = [...opfXml.matchAll(/<item[^>]+href="([^"]+\.x?html?)"[^>]*>/gi)];
            const htmlFiles = manifestMatches.map(m => m[1]);
            
            // 提取spine顺序
            const spineMatches = [...opfXml.matchAll(/<itemref[^>]+idref="([^"]+)"[^>]*>/gi)];
            const spineOrder = spineMatches.map(m => m[1]);
            
            // 读取每个HTML文件的内容
            const opfDir = path.dirname(opfEntry.entryName);
            
            for (const idref of spineOrder) {
                const itemMatch = opfXml.match(new RegExp(`<item[^>]+id="${idref}"[^>]+href="([^"]+)"`, 'i'));
                if (itemMatch) {
                    const href = itemMatch[1];
                    const htmlPath = path.join(opfDir, href).replace(/\\/g, '/');
                    const htmlEntry = entries.find(e => e.entryName === htmlPath);
                    
                    if (htmlEntry) {
                        const htmlContent = htmlEntry.getData().toString('utf8');
                        const textContent = htmlToText(htmlContent);
                        const chapterTitle = extractChapterTitle(htmlContent) || path.basename(href);
                        
                        chapters.push({
                            title: chapterTitle,
                            content: textContent
                        });
                    }
                }
            }
        }
        
        // 如果没有从spine中获取到，尝试直接读取所有HTML文件
        if (chapters.length === 0) {
            const htmlEntries = entries.filter(e => /\.x?html?$/i.test(e.entryName)).sort((a, b) => a.entryName.localeCompare(b.entryName));
            
            for (const entry of htmlEntries) {
                const htmlContent = entry.getData().toString('utf8');
                const textContent = htmlToText(htmlContent);
                const chapterTitle = extractChapterTitle(htmlContent) || path.basename(entry.entryName);
                
                chapters.push({
                    title: chapterTitle,
                    content: textContent
                });
            }
        }
        
        return { title, chapters, content: chapters.map(c => c.content).join('\n\n') };
    } catch (e) {
        console.log('读取epub失败:', e.message);
        return { title: path.basename(filePath, '.epub'), chapters: [], content: '读取失败: ' + e.message };
    }
}

/**
 * HTML转纯文本
 */
function htmlToText(html) {
    // 移除script和style
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    
    // 替换换行标签
    html = html.replace(/<br\s*\/?>/gi, '\n');
    html = html.replace(/<\/p>/gi, '\n\n');
    html = html.replace(/<\/div>/gi, '\n');
    html = html.replace(/<\/h[1-6]>/gi, '\n\n');
    
    // 移除所有标签
    html = html.replace(/<[^>]+>/g, '');
    
    // 解码HTML实体
    html = html.replace(/&nbsp;/g, ' ');
    html = html.replace(/&amp;/g, '&');
    html = html.replace(/&lt;/g, '<');
    html = html.replace(/&gt;/g, '>');
    html = html.replace(/&quot;/g, '"');
    html = html.replace(/&#39;/g, "'");
    
    // 清理多余空行
    html = html.replace(/\n{3,}/g, '\n\n');
    html = html.trim();
    
    return html;
}

/**
 * 从HTML中提取章节标题
 */
function extractChapterTitle(html) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) return titleMatch[1].trim();
    
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) return h1Match[1].trim();
    
    const h2Match = html.match(/<h2[^>]*>([^<]+)<\/h2>/i);
    if (h2Match) return h2Match[1].trim();
    
    return null;
}

// 获取小说信息
router.get('/:id/info', (req, res) => {
    try {
        const novel = getMovieById.get(req.params.id);
        if (!novel) return res.json({ code: -1, msg: '小说不存在' });
        
        const content = getNovelContent(novel.filePath);
        const progress = readingProgress[novel.id] || { chapter: 0, position: 0, lastRead: null };
        
        res.json({
            code: 0,
            data: {
                id: novel.id,
                title: content.title || novel.title,
                filePath: novel.filePath,
                totalChapters: content.chapters.length,
                currentChapter: progress.chapter,
                currentPosition: progress.position,
                lastRead: progress.lastRead,
                chapters: content.chapters.map((c, i) => ({
                    index: i,
                    title: c.title,
                    length: c.content.length
                }))
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取小说章节内容
router.get('/:id/chapter/:chapterIndex', (req, res) => {
    try {
        const novel = getMovieById.get(req.params.id);
        if (!novel) return res.json({ code: -1, msg: '小说不存在' });
        
        const chapterIndex = parseInt(req.params.chapterIndex);
        const content = getNovelContent(novel.filePath);
        
        if (chapterIndex < 0 || chapterIndex >= content.chapters.length) {
            return res.json({ code: -1, msg: '章节超出范围' });
        }
        
        const chapter = content.chapters[chapterIndex];
        
        res.json({
            code: 0,
            data: {
                index: chapterIndex,
                title: chapter.title,
                content: chapter.content,
                totalChapters: content.chapters.length
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 保存阅读进度
router.post('/:id/progress', (req, res) => {
    try {
        const { chapter, position } = req.body;
        const novelId = req.params.id;
        
        readingProgress[novelId] = {
            chapter: parseInt(chapter) || 0,
            position: parseInt(position) || 0,
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
        const novelId = req.params.id;
        readingSessions[novelId] = {
            startTime: Date.now(),
            totalTime: readingSessions[novelId]?.totalTime || 0
        };
        
        res.json({ code: 0, msg: '计时开始' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 结束阅读计时
router.post('/:id/stop-reading', (req, res) => {
    try {
        const novelId = req.params.id;
        const session = readingSessions[novelId];
        
        if (session && session.startTime) {
            const duration = Date.now() - session.startTime;
            session.totalTime += duration;
            session.startTime = null;

            // 持久化到数据库
            persistReadingDuration(parseInt(novelId), duration);
            
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
        const novelId = req.params.id;
        const session = readingSessions[novelId];
        const progress = readingProgress[novelId];
        const persisted = getMovieReadingStats(parseInt(novelId));
        
        res.json({
            code: 0,
            data: {
                totalTime: (session?.totalTime || 0) + (persisted.totalSeconds * 1000),
                currentChapter: progress?.chapter || 0,
                currentPosition: progress?.position || 0,
                lastRead: progress?.lastRead || null,
                totalSeconds: persisted.totalSeconds,
                sessionCount: persisted.sessionCount
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 小说库阅读统计总览（主界面横幅）
router.get('/stats/overview', (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const summary = getAllReadingStats('novel');
        const daily = getDailyReadingStats('novel', days);
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

// 小说库文件夹树（按子文件夹递归分组）
router.get('/tree', (req, res) => {
    try {
        const { buildTree, flattenTree } = require('../utils/media-tree');
        const all = require('../utils/db').getAllMovies.all().filter(m => (m.type || 'jav') === 'novel');
        const roots = config.novelFolders || [];
        const tree = buildTree(all, roots);
        const groups = flattenTree(tree);
        res.json({ code: 0, data: { tree, groups, roots } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
