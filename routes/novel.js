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
function getNovelContent(filePath, novelId) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.txt') {
        const r = getTxtContent(filePath);
        return r;
    } else if (ext === '.epub') {
        return getEpubContent(filePath, novelId);
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
function getEpubContent(filePath, novelId) {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        const entryNameSet = new Set(entries.map(e => e.entryName));

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

        // 把某个 xhtml 所在的相对目录 + 资源相对路径 → 代理 URL
        // zip 内部路径用 "/" 分隔；这里做归一化（处理 ../ 与 ./）
        const makeResolver = (baseDir) => (relPath) => {
            let rel = String(relPath || '').replace(/\\/g, '/');
            if (!rel || /^(https?:|data:|\/)/i.test(rel)) {
                // 外链/绝对路径保持原样（图片若是外链就直接加载）
                return rel;
            }
            // 解码 %xx（epub 里常有中文名被编码）
            try { rel = decodeURIComponent(rel); } catch (e) { /* 保持原样 */ }
            const segs = (baseDir ? baseDir.split('/') : []).concat(rel.split('/'));
            const out = [];
            for (const s of segs) {
                if (!s || s === '.') continue;
                if (s === '..') { out.pop(); continue; }
                out.push(s);
            }
            const inner = out.join('/');
            const url = `/api/novel/${novelId}/asset/${inner.split('/').map(encodeURIComponent).join('/')}`;
            return url;
        };

        if (opfEntry) {
            const opfXml = opfEntry.getData().toString('utf8');
            
            // 提取标题
            const titleMatch = opfXml.match(/<dc:title>([^<]+)<\/dc:title>/);
            if (titleMatch) title = titleMatch[1];
            
            // 提取spine顺序
            const spineMatches = [...opfXml.matchAll(/<itemref[^>]+idref="([^"]+)"[^>]*>/gi)];
            const spineOrder = spineMatches.map(m => m[1]);
            
            // 读取每个HTML文件的内容
            const opfDir = path.dirname(opfEntry.entryName).replace(/\\/g, '/');
            if (opfDir === '.') opfDir = '';

            const seen = new Set();
            for (const idref of spineOrder) {
                const itemMatch = opfXml.match(new RegExp(`<item[^>]+id="${idref}"[^>]+href="([^"]+)"`, 'i'))
                    || opfXml.match(new RegExp(`<item[^>]+href="([^"]+)"[^>]+id="${idref}"`, 'i'));
                if (!itemMatch) continue;
                const href = itemMatch[1];
                // 解析成 zip 内真实路径
                const parts = (opfDir ? opfDir.split('/') : []).concat(href.replace(/\\/g, '/').split('/'));
                const stack = [];
                for (const s of parts) {
                    if (!s || s === '.') continue;
                    if (s === '..') { stack.pop(); continue; }
                    stack.push(s);
                }
                const htmlPath = stack.join('/');
                if (seen.has(htmlPath)) continue;
                seen.add(htmlPath);

                const htmlEntry = entries.find(e => e.entryName === htmlPath)
                    || entries.find(e => e.entryName === decodeURIComponent(htmlPath));
                if (!htmlEntry) continue;

                const htmlContent = htmlEntry.getData().toString('utf8');
                const chapterDir = path.dirname(htmlEntry.entryName).replace(/\\/g, '/');
                const resolve = makeResolver(chapterDir === '.' ? '' : chapterDir);
                const rich = htmlForReader(htmlContent, resolve);
                const plain = htmlToText(htmlContent);
                const chapterTitle = extractChapterTitle(htmlContent) || path.basename(href);

                chapters.push({
                    title: chapterTitle,
                    content: rich,          // 富文本（含图片）
                    text: plain,            // 纯文本（字数/搜索/兜底用）
                    html: true,
                    innerPath: htmlEntry.entryName
                });
            }
        }
        
        // 如果没有从spine中获取到，尝试直接读取所有HTML文件
        if (chapters.length === 0) {
            const htmlEntries = entries.filter(e => /\.x?html?$/i.test(e.entryName)).sort((a, b) => a.entryName.localeCompare(b.entryName));
            
            for (const entry of htmlEntries) {
                // 跳过 nav / toc / 目录页（一般是导航而非正文）
                if (/nav(igation)?[-_.]?documents?\.x?html?$/i.test(entry.entryName)) continue;
                const htmlContent = entry.getData().toString('utf8');
                const chapterDir = path.dirname(entry.entryName).replace(/\\/g, '/');
                const resolve = makeResolver(chapterDir === '.' ? '' : chapterDir);
                const rich = htmlForReader(htmlContent, resolve);
                const plain = htmlToText(htmlContent);
                const chapterTitle = extractChapterTitle(htmlContent) || path.basename(entry.entryName);
                
                chapters.push({
                    title: chapterTitle,
                    content: rich,
                    text: plain,
                    html: true,
                    innerPath: entry.entryName
                });
            }
        }
        
        return {
            title,
            chapters,
            content: chapters.map(c => c.text || c.content).join('\n\n'),
            isEpub: true
        };
    } catch (e) {
        console.log('读取epub失败:', e.message);
        return { title: path.basename(filePath, '.epub'), chapters: [], content: '读取失败: ' + e.message };
    }
}

/**
 * HTML转纯文本（保留调用点兼容；新代码请用 htmlForReader）
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

/* ==========================================================================
   2026-09-25（round25 #2）EPUB 富文本化：保留图片
   --------------------------------------------------------------------------
   老实现拿 htmlToText() 把整份 XHTML 的标签一次抹平 —— 结果是：
     · 纯彩页/插图页（<img> 或 <svg><image>）只剩空白，textlen≈10；
     · 正文里的内嵌插图一并消失。
   Kadokawa 这类图文书尤其严重（一本 52 个 entry 里 20 多个是 jpg）。
   现在改为「保留段落结构 + 重写资源地址」，图片走 /api/novel/:id/asset/*
   由后端从 epub 里按需解出，前端用 innerHTML 渲染。
   ========================================================================== */

// 允许透出的标签/属性白名单（防 EPUB 里塞脚本）
const READER_KEEP_TAGS = new Set([
    'p', 'div', 'span', 'br', 'hr', 'img', 'svg', 'g',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'em', 'i', 'b', 'strong', 'u', 's', 'sub', 'sup', 'small', 'big',
    'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'td', 'th', 'caption', 'figure', 'figcaption',
    'ruby', 'rb', 'rt', 'rp', 'section', 'article', 'aside', 'header', 'footer', 'nav'
]);
// 注：'image' 已从白名单移除 —— 带 href 的 <image> 前面已统一转成 <img>，
// 残留的（无 href 或已破损）应当丢弃，而不是留在正文里。

function escapeAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把 XHTML 转成「阅读器可用的富文本 HTML」
 * @param {string} html      原始 XHTML
 * @param {Function} resolve (relPath) => 代理 URL，用于把图片相对路径换成可访问地址
 */
function htmlForReader(html, resolve) {
    if (!html) return '';

    // 1) 干掉「不是标签却会被当正文显示」的东西：
    //    · <?xml version="1.0" ...?>  —— 老实现没剥，直接以纯文本形式显示在章节开头（实测 5 本 EPUB 全中）
    //    · <!-- ... -->              —— 注释同样会当文本漏出来（Kadokawa pack 里带 <!--?xml ...-->）
    //    · <script>/<style>/<head>/<!DOCTYPE>
    html = html.replace(/<\?[\s\S]*?\?>/g, '');
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
    html = html.replace(/<!DOCTYPE[^>]*>/gi, '');

    /* 1.5) <svg> 包装层脱壳。
     *   Kadokawa 系「整页整图」写成 <svg><image xlink:href="..."/></svg>。里面的 <image>
     *   在下面会被转成 <img>，而 <img> 属于 HTML 规范的「破出(breakout)标签」，会自己跳出
     *   外来内容模式 —— 结果是 <svg> 只剩一个空壳。空 <svg> 的默认尺寸是 300x150，
     *   会在每张整页插图前撑出一大块空白，翻页分页时甚至能吃掉半页。
     *   ⇒ 不含矢量绘图子元素的 <svg> 直接脱壳（保留内部内容）；真矢量图原样保留。 */
    html = html.replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi, (m, inner) => {
        if (/<(path|circle|rect|ellipse|polygon|polyline|line|text|use)\b/i.test(inner)) return m;
        return inner;
    });

    // 统一的 <img> 产出：class 里保证只出现一次 novel-illus
    const buildImg = (src, alt, extraCls) => {
        const cls = ['novel-illus'];
        for (const c of String(extraCls || '').split(/\s+/)) {
            if (c && c !== 'novel-illus' && cls.indexOf(c) < 0) cls.push(c);
        }
        return `<img class="${cls.join(' ')}" src="${escapeAttr(src)}" alt="${escapeAttr(alt || '')}" loading="lazy">`;
    };

    // 2) 普通 <img src> 重写（先做，避免它再去加工下面 svg<image> 转出来的 <img>，那是重复 class 的来源）
    html = html.replace(/<img\b([^>]*?)\/?>/gi, (m, attrs) => {
        const srcM = /\bsrc\s*=\s*"([^"]+)"/i.exec(attrs) || /\bsrc\s*=\s*'([^']+)'/i.exec(attrs);
        if (!srcM) return '';
        const src = resolve ? resolve(srcM[1]) : srcM[1];
        const altM = /\balt\s*=\s*"([^"]*)"/i.exec(attrs);
        const clsM = /\bclass\s*=\s*"([^"]*)"/i.exec(attrs);
        return buildImg(src, altM ? altM[1] : '', clsM ? clsM[1] : '');
    });

    // 3) <svg><image xlink:href="..."/>（Kadokawa 的整页整图就是这种）→ <img class="novel-pageimg">
    html = html.replace(/<image\b([^>]*?)\/?>/gi, (m, attrs) => {
        const hrefM = /(?:xlink:href|href)\s*=\s*"([^"]+)"/i.exec(attrs) || /(?:xlink:href|href)\s*=\s*'([^']+)'/i.exec(attrs);
        if (!hrefM) return '';
        const src = resolve ? resolve(hrefM[1]) : hrefM[1];
        return buildImg(src, '', 'novel-pageimg');
    });

    // 4) 逐标签白名单过滤（保留结构，剥掉 class/style/事件）
    html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m, tag, attrs) => {
        const t = tag.toLowerCase();
        if (!READER_KEEP_TAGS.has(t)) return '';
        const closing = m.startsWith('</');
        if (closing) return `</${t}>`;
        // 只留少量安全属性
        const keep = [];
        const cls = /\bclass\s*=\s*"([^"]*)"/i.exec(attrs);
        if (cls) keep.push(`class="${escapeAttr(cls[1])}"`);
        if (t === 'img') {
            const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(attrs);
            const alt = /\balt\s*=\s*"([^"]*)"/i.exec(attrs);
            if (src) keep.push(`src="${escapeAttr(src[1])}"`);
            keep.push(`alt="${escapeAttr(alt ? alt[1] : '')}"`);
            keep.push('loading="lazy"');
        }
        return `<${t}${keep.length ? ' ' + keep.join(' ') : ''}>`;
    });

    // 5) 解码常用实体（保留 < > 的转义，避免二次注入）
    html = html.replace(/&nbsp;/g, '\u00a0');
    html = html.replace(/&amp;/g, '&');
    html = html.replace(/&quot;/g, '"');
    html = html.replace(/&#39;/g, "'");

    // 6) 清理空段
    html = html.replace(/(<p[^>]*>\s*(&nbsp;|\u00a0|\s)*<\/p>\s*){3,}/gi, '<p><br></p>');
    return html.trim();
}

/**
 * 从 epub 取内嵌资源（图片/字体），带目录穿越防护
 * @returns {Buffer|null}
 */
function readEpubAsset(filePath, innerPath) {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(filePath);
        const norm = String(innerPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        // 目录穿越防护
        if (norm.split('/').some(seg => seg === '..')) return null;
        const entry = zip.getEntry(norm) || zip.getEntry(decodeURIComponent(norm));
        if (!entry || entry.isDirectory) return null;
        return entry.getData();
    } catch (e) {
        console.log('读取epub资源失败:', e.message);
        return null;
    }
}

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.avif': 'image/avif',
    '.css': 'text/css', '.otf': 'font/otf', '.ttf': 'font/ttf',
    '.woff': 'font/woff', '.woff2': 'font/woff2'
};

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
        
        const content = getNovelContent(novel.filePath, novel.id);
        const progress = readingProgress[novel.id] || { chapter: 0, position: 0, lastRead: null };
        
        res.json({
            code: 0,
            data: {
                id: novel.id,
                title: content.title || novel.title,
                filePath: novel.filePath,
                format: path.extname(novel.filePath).replace('.', '').toLowerCase(),
                isEpub: !!content.isEpub,
                totalChapters: content.chapters.length,
                currentChapter: progress.chapter,
                currentPosition: progress.position,
                lastRead: progress.lastRead,
                chapters: content.chapters.map((c, i) => ({
                    index: i,
                    title: c.title,
                    // EPUB 章节可能只有图没有字，长度按纯文本算会显示 0 —— 改成「有内容就算 1」
                    length: (c.text || '').length || (c.content ? 1 : 0),
                    hasImage: /<img/i.test(c.content || '')
                }))
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/**
 * 读取 EPUB 内嵌资源（round25 #2）
 * 形如 /api/novel/123/asset/item/image/m-001.jpg
 * 必须注册在 /:id/chapter 之前不冲突的位置即可（这里是独立前缀，安全）
 */
router.get('/:id/asset/*', (req, res) => {
    try {
        const novel = getMovieById.get(req.params.id);
        if (!novel) return res.status(404).send('小说不存在');
        const ext = path.extname(novel.filePath).toLowerCase();
        if (ext !== '.epub') return res.status(404).send('非 EPUB');

        // express 5 用 req.params[0] 拿通配
        let inner = req.params[0] || '';
        try { inner = decodeURIComponent(inner); } catch (e) { /* 保持 */ }

        const buf = readEpubAsset(novel.filePath, inner);
        if (!buf) return res.status(404).send('资源不存在');

        const mime = MIME_BY_EXT[path.extname(inner).toLowerCase()] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.send(buf);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 获取小说章节内容
router.get('/:id/chapter/:chapterIndex', (req, res) => {
    try {
        const novel = getMovieById.get(req.params.id);
        if (!novel) return res.json({ code: -1, msg: '小说不存在' });
        
        const chapterIndex = parseInt(req.params.chapterIndex);
        const content = getNovelContent(novel.filePath, novel.id);
        
        if (chapterIndex < 0 || chapterIndex >= content.chapters.length) {
            return res.json({ code: -1, msg: '章节超出范围' });
        }
        
        const chapter = content.chapters[chapterIndex];
        
        res.json({
            code: 0,
            data: {
                index: chapterIndex,
                title: chapter.title,
                content: chapter.content,     // 富文本（含 <img>）
                text: chapter.text || '',     // 纯文本（备用）
                isHtml: !!chapter.html,
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
