/**
 * 夸克网盘漫画/小说扫描器
 * 从夸克网盘导入漫画和小说到数据库
 */

const QuarkCrawler = require('./crawler/quark');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

class QuarkScanner {
    constructor(config) {
        this.config = config;
        this.crawler = new QuarkCrawler({
            baseUrl: 'https://drive-pc.quark.cn/1/clouddrive',
            webUrl: 'https://pan.quark.cn',
            cookie: config.sources.quark.cookie
        });
        
        const dbPath = path.join(__dirname, '..', 'db', 'movie.db');
        this.db = new Database(dbPath);
        
        this.posterCacheDir = path.join(__dirname, '..', 'cache', 'posters');
        if (!fs.existsSync(this.posterCacheDir)) {
            fs.mkdirSync(this.posterCacheDir, { recursive: true });
        }
    }

    /**
     * 扫描夸克网盘的漫画目录
     */
    async scanComics() {
        console.log('[夸克漫画扫描] 开始扫描...');
        
        // 获取根目录
        const root = await this.crawler.getFileList('0', 1, 100);
        const comicFolder = root.list?.find(f => f.file_name.includes('漫画') && f.dir);
        
        if (!comicFolder) {
            console.log('[夸克漫画扫描] 未找到漫画文件夹');
            return 0;
        }
        
        console.log('[夸克漫画扫描] 找到漫画文件夹:', comicFolder.file_name);
        
        // 获取所有漫画文件
        const allFiles = await this.getAllFiles(comicFolder.fid);
        console.log(`[夸克漫画扫描] 找到 ${allFiles.length} 个文件`);
        
        let added = 0;
        for (const file of allFiles) {
            try {
                const result = await this.importComicFile(file);
                if (result) added++;
            } catch (e) {
                console.error('  导入失败:', file.file_name, e.message);
            }
        }
        
        console.log(`[夸克漫画扫描] 完成！新增 ${added} 个`);
        return added;
    }

    /**
     * 扫描夸克网盘的小说目录
     */
    async scanNovels() {
        console.log('[夸克小说扫描] 开始扫描...');
        
        // 获取根目录
        const root = await this.crawler.getFileList('0', 1, 100);
        const novelFolder = root.list?.find(f => f.file_name.includes('轻小说') && f.dir);
        
        if (!novelFolder) {
            console.log('[夸克小说扫描] 未找到轻小说文件夹');
            return 0;
        }
        
        console.log('[夸克小说扫描] 找到轻小说文件夹:', novelFolder.file_name);
        
        // 获取所有小说文件
        const allFiles = await this.getAllFiles(novelFolder.fid);
        console.log(`[夸克小说扫描] 找到 ${allFiles.length} 个文件/文件夹`);
        
        let added = 0;
        for (const file of allFiles) {
            try {
                const result = await this.importNovelFile(file);
                if (result) added++;
            } catch (e) {
                console.error('  导入失败:', file.file_name, e.message);
            }
        }
        
        console.log(`[夸克小说扫描] 完成！新增 ${added} 个`);
        return added;
    }

    /**
     * 递归获取所有文件
     */
    async getAllFiles(fid, prefix = '') {
        const result = [];
        let page = 1;
        const pageSize = 200;
        
        while (true) {
            const list = await this.crawler.getFileList(fid, page, pageSize);
            if (!list.list || list.list.length === 0) break;
            
            for (const file of list.list) {
                if (file.dir) {
                    // 递归子目录
                    const subFiles = await this.getAllFiles(file.fid, prefix + file.file_name + '/');
                    result.push(...subFiles);
                } else {
                    result.push({
                        ...file,
                        fullPath: prefix + file.file_name
                    });
                }
            }
            
            if (list.list.length < pageSize) break;
            page++;
        }
        
        return result;
    }

    /**
     * 导入漫画文件
     */
    async importComicFile(file) {
        // 只处理epub和pdf文件
        const ext = path.extname(file.file_name).toLowerCase();
        if (!['.epub', '.pdf', '.cbz', '.cbr'].includes(ext)) {
            return false;
        }
        
        // 解析文件名
        const { title, volume, author } = this.parseComicFileName(file.file_name);
        
        // 生成唯一的filePath（使用fid）
        const filePath = `quark://comic/${file.fid}`;
        
        // 检查是否已存在
        const existing = this.db.prepare('SELECT id FROM movies WHERE filePath = ?').get(filePath);
        if (existing) {
            return false;
        }
        
        // 生成文件hash
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        
        // 插入数据库
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO movies (
                filePath, fileName, avid, cleanName, fileSize, duration, width, height,
                tmdbId, title, originalTitle, overview, releaseDate, posterPath, localPosterPath,
                country, genres, producer, publisher, serial, director, score, source,
                lastScanTime, type
            ) VALUES (
                @filePath, @fileName, @avid, @cleanName, @fileSize, @duration, @width, @height,
                @tmdbId, @title, @originalTitle, @overview, @releaseDate, @posterPath, @localPosterPath,
                @country, @genres, @producer, @publisher, @serial, @director, @score, @source,
                @lastScanTime, @type
            )
            ON CONFLICT(filePath) DO UPDATE SET
                fileName=COALESCE(@fileName, fileName),
                title=COALESCE(@title, title),
                fileSize=COALESCE(@fileSize, fileSize),
                lastScanTime=@lastScanTime
        `);
        
        stmt.run({
            filePath,
            fileName: file.file_name,
            avid: '',
            cleanName: title,
            fileSize: file.size || 0,
            duration: 0,
            width: 0,
            height: 0,
            tmdbId: null,
            title,
            originalTitle: title,
            overview: '',
            releaseDate: '',
            posterPath: '',
            localPosterPath: '',
            country: '',
            genres: '漫画',
            producer: author || '',
            publisher: '',
            serial: volume || '',
            director: '',
            score: 0,
            source: 'quark-comic',
            lastScanTime: now,
            type: 'comic'
        });
        
        console.log('  ✓ 导入:', title);
        return true;
    }

    /**
     * 导入小说文件
     */
    async importNovelFile(file) {
        // 处理txt、epub、pdf文件
        const ext = path.extname(file.file_name).toLowerCase();
        if (!['.txt', '.epub', '.pdf', '.mobi', '.azw3'].includes(ext)) {
            // 如果是文件夹，也作为一个作品导入
            if (file.dir) {
                // 文件夹作为一个作品
            } else {
                return false;
            }
        }
        
        // 解析文件名
        const title = this.parseNovelFileName(file.file_name);
        
        // 生成唯一的filePath（使用fid）
        const filePath = `quark://novel/${file.fid}`;
        
        // 检查是否已存在
        const existing = this.db.prepare('SELECT id FROM movies WHERE filePath = ?').get(filePath);
        if (existing) {
            return false;
        }
        
        // 生成文件hash
        const hash = crypto.createHash('md5').update(filePath).digest('hex');
        
        // 插入数据库
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO movies (
                filePath, fileName, avid, cleanName, fileSize, duration, width, height,
                tmdbId, title, originalTitle, overview, releaseDate, posterPath, localPosterPath,
                country, genres, producer, publisher, serial, director, score, source,
                lastScanTime, type
            ) VALUES (
                @filePath, @fileName, @avid, @cleanName, @fileSize, @duration, @width, @height,
                @tmdbId, @title, @originalTitle, @overview, @releaseDate, @posterPath, @localPosterPath,
                @country, @genres, @producer, @publisher, @serial, @director, @score, @source,
                @lastScanTime, @type
            )
            ON CONFLICT(filePath) DO UPDATE SET
                fileName=COALESCE(@fileName, fileName),
                title=COALESCE(@title, title),
                fileSize=COALESCE(@fileSize, fileSize),
                lastScanTime=@lastScanTime
        `);
        
        stmt.run({
            filePath,
            fileName: file.file_name,
            avid: '',
            cleanName: title,
            fileSize: file.size || 0,
            duration: 0,
            width: 0,
            height: 0,
            tmdbId: null,
            title,
            originalTitle: title,
            overview: '',
            releaseDate: '',
            posterPath: '',
            localPosterPath: '',
            country: '',
            genres: '轻小说',
            producer: '',
            publisher: '',
            serial: '',
            director: '',
            score: 0,
            source: 'quark-novel',
            lastScanTime: now,
            type: 'novel'
        });
        
        console.log('  ✓ 导入:', title);
        return true;
    }

    /**
     * 解析漫画文件名
     * 格式示例：[Kmoe][監禁王]卷03.epub
     */
    parseComicFileName(fileName) {
        // 去掉扩展名
        const name = fileName.replace(/\.[^.]+$/, '');
        
        let title = name;
        let volume = '';
        let author = '';
        
        // 匹配 [Kmoe][作品名]卷XX 格式
        const match = name.match(/\[.*?\]\[(.*?)\](卷\d+)?/);
        if (match) {
            title = match[1];
            volume = match[2] || '';
        } else {
            // 尝试其他格式
            const volMatch = name.match(/卷(\d+)/);
            if (volMatch) {
                volume = '卷' + volMatch[1];
                title = name.replace(/卷\d+.*/, '').trim();
            }
        }
        
        return { title, volume, author };
    }

    /**
     * 解析小说文件名
     */
    parseNovelFileName(fileName) {
        // 去掉扩展名
        const name = fileName.replace(/\.[^.]+$/, '');
        return name;
    }

    close() {
        this.db.close();
    }
}

module.exports = QuarkScanner;
