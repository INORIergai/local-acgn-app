const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const JSZip = require('jszip');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const KmoeCrawler = require('../utils/crawler/kmoe');
const QuarkCrawler = require('../utils/crawler/quark');
const config = require('../utils/config');
const { getStarredCloudItems, starCloudItem, unstarCloudItem, touchCloudItem, getRecentCloudItems, isCloudItemStarred } = require('../utils/db');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const { configPath } = require('../utils/config');

// 用应用统一的配置路径（Docker 下是 CONFIG_FILE=config.docker.json）——
// 之前这里写死 config.json，导致夸克登录"成功"了 cookie 却没生效
const CONFIG_PATH = configPath;

// 读取 config.json（实时读取，避免 require 缓存导致拿到过期目录/登录态）
function readConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// 写入 config.json（4 空格缩进）
function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4), 'utf8');
}

// 夸克下载文件使用的通用请求头
// 关键：夸克 CDN（dl-pc-zb.pds.quark.cn / video-play-h-zb.drive.quark.cn）强制校验 Cookie，
// 少了 Cookie 直接 403（下载）或 412（播放列表）
const QUARK_DOWNLOAD_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36 Core/1.94.225.400 QQBrowser/12.2.5544.400',
    'Referer': 'https://pan.quark.cn/',
    'Accept': '*/*'
};

// 实时拼出带 Cookie 的下载请求头（Cookie 会随扫码登录变化）
function quarkDownloadHeaders() {
    return { ...QUARK_DOWNLOAD_HEADERS, Cookie: getQuarkCrawler().cookie };
}

// 夸克相关请求的代理策略：默认直连（国内站），config.sources.quark.useProxy=true 才走代理
function quarkFetchOptions(extra = {}) {
    const opts = { redirect: 'follow', ...extra };
    if (config.sources?.quark?.useProxy && config.network?.proxyServer) {
        opts.agent = new HttpsProxyAgent(config.network.proxyServer);
    }
    return opts;
}

// node-fetch v3 的 body 是 Node 流，Readable.fromWeb() 只接受 web 流（原生 fetch）——两者都兼容
function pipeBody(resp, res) {
    if (!resp.body) return res.end();
    if (typeof resp.body.pipe === 'function') return resp.body.pipe(res);
    return Readable.fromWeb(resp.body).pipe(res);
}

// 直链/播放列表代理入口（浏览器的 <video>/<img> 发不出自定义头，只能由服务端代发）
const QUARK_STREAM_BASE = '/api/cloud/quark/stream';
const b64url = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

// 允许的漫画/小说扩展名
const MEDIA_EXTS = ['.epub', '.pdf'];
// 超大文件上限（epub 一般 <100MB，超过视为异常）
const MAX_EPUB_SIZE = 300 * 1024 * 1024;

// Kmoe 爬虫单例
let kmoeCrawler = null;

/**
 * 获取或创建 Kmoe 爬虫实例
 */
function getKmoeCrawler() {
  if (!kmoeCrawler) {
    const kmoeConfig = config.sources?.kmoe || {};
    kmoeCrawler = new KmoeCrawler({
      baseUrl: kmoeConfig.baseUrl || 'https://kox.moe',
      username: kmoeConfig.username || '',
      password: kmoeConfig.password || '',
      cookie: kmoeConfig.cookie || ''
    });
  }
  return kmoeCrawler;
}

// 夸克网盘爬虫单例
let quarkCrawler = null;

/**
 * 获取或创建夸克网盘爬虫实例
 */
function getQuarkCrawler() {
  if (!quarkCrawler) {
    const quarkConfig = config.sources?.quark || {};
    quarkCrawler = new QuarkCrawler({
      baseUrl: quarkConfig.baseUrl || 'https://drive-pc.quark.cn/1/clouddrive',
      webUrl: 'https://pan.quark.cn',
      cookie: quarkConfig.cookie || ''
    });
  }
  return quarkCrawler;
}

// 登录
router.post('/kmoe/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const crawler = getKmoeCrawler();
        const success = await crawler.login(username, password);
        
        if (success) {
            res.json({ code: 0, msg: '登录成功' });
        } else {
            res.json({ code: -1, msg: '登录失败' });
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 搜索漫画
router.get('/kmoe/search', async (req, res) => {
    try {
        const { keyword, page } = req.query;
        if (!keyword) return res.json({ code: -1, msg: '关键词不能为空' });
        
        const crawler = getKmoeCrawler();
        const results = await crawler.search(keyword, parseInt(page) || 1);
        
        res.json({ code: 0, data: results });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取漫画详情
router.get('/kmoe/detail', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.json({ code: -1, msg: 'URL不能为空' });
        
        const crawler = getKmoeCrawler();
        const detail = await crawler.getDetail(url);
        
        if (detail) {
            res.json({ code: 0, data: detail });
        } else {
            res.json({ code: -1, msg: '获取详情失败' });
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取章节图片
router.get('/kmoe/chapter', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.json({ code: -1, msg: 'URL不能为空' });
        
        const crawler = getKmoeCrawler();
        const images = await crawler.getChapterImages(url);
        
        res.json({ code: 0, data: images });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取热门漫画
router.get('/kmoe/hot', async (req, res) => {
    try {
        const { page } = req.query;
        const crawler = getKmoeCrawler();
        const results = await crawler.getHot(parseInt(page) || 1);
        
        res.json({ code: 0, data: results });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取最新更新
router.get('/kmoe/latest', async (req, res) => {
    try {
        const { page } = req.query;
        const crawler = getKmoeCrawler();
        const results = await crawler.getLatest(parseInt(page) || 1);
        
        res.json({ code: 0, data: results });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取分类列表
router.get('/kmoe/categories', async (req, res) => {
    try {
        const crawler = getKmoeCrawler();
        const categories = await crawler.getCategories();
        
        res.json({ code: 0, data: categories });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 下载漫画
router.get('/kmoe/download', async (req, res) => {
    try {
        const { url, format } = req.query;
        if (!url) return res.json({ code: -1, msg: 'URL不能为空' });
        
        const crawler = getKmoeCrawler();
        const downloadUrl = await crawler.downloadComic(url, format || 'epub');
        
        if (downloadUrl) {
            res.json({ code: 0, data: { url: downloadUrl } });
        } else {
            res.json({ code: -1, msg: '获取下载链接失败' });
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 网盘星标：漫画/小说主页要直接显示这些，不用每次进文件夹找
router.get('/quark/starred', (req, res) => {
    try {
        res.json({ code: 0, data: getStarredCloudItems(req.query.kind || '') });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/quark/star', (req, res) => {
    try {
        const { fid, name, is_dir, pdir_fid, size, kind, starred } = req.body || {};
        if (!fid) return res.json({ code: -1, msg: 'fid不能为空' });
        if (starred) starCloudItem({ fid, name, is_dir, pdir_fid, size, kind });
        else unstarCloudItem(fid);
        res.json({ code: 0, data: { starred: !!starred } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 打开历史：打开过的文件夹/文件记一笔，主页可以一键回到上次看的地方
router.post('/quark/touch', (req, res) => {
    try {
        const b = req.body || {};
        if (!b.fid) return res.json({ code: -1, msg: 'fid不能为空' });
        touchCloudItem(b);
        res.json({ code: 0 });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/quark/recent', (req, res) => {
    try {
        res.json({ code: 0, data: getRecentCloudItems(req.query.kind || '', Number(req.query.limit) || 24) });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// ==================== 夸克网盘 ====================

// 设置夸克网盘 cookie
router.post('/quark/set-cookie', (req, res) => {
    try {
        const { cookie } = req.body;
        if (!cookie) return res.json({ code: -1, msg: 'cookie不能为空' });
        
        const crawler = getQuarkCrawler();
        crawler.setCookie(cookie);

        // 落盘：只写内存的话，容器一重启 cookie 就没了（配合宿主机抓 cookie 的脚本用）
        try {
            const cfg = readConfig();
            if (!cfg.sources) cfg.sources = {};
            if (!cfg.sources.quark) cfg.sources.quark = {};
            cfg.sources.quark.cookie = cookie;
            writeConfig(cfg);
        } catch (e) {
            console.log('[夸克] cookie 写回配置失败:', e.message);
        }

        res.json({ code: 0, msg: 'cookie设置成功（已保存）' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 检查夸克网盘登录状态
router.get('/quark/check-login', async (req, res) => {
    try {
        const crawler = getQuarkCrawler();
        const loggedIn = await crawler.checkLogin();
        
        res.json({ code: 0, data: { loggedIn } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取夸克网盘存储空间信息
router.get('/quark/storage', async (req, res) => {
    try {
        const crawler = getQuarkCrawler();
        const storageInfo = await crawler.getStorageInfo();
        
        if (storageInfo) {
            res.json({ code: 0, data: storageInfo });
        } else {
            res.json({ code: -1, msg: '获取存储空间信息失败' });
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取夸克网盘文件列表
router.get('/quark/files', async (req, res) => {
    try {
        const { fid, page, pageSize } = req.query;
        const crawler = getQuarkCrawler();
        const files = await crawler.getFileList(fid || 0, parseInt(page) || 1, parseInt(pageSize) || 100);
        
        res.json({ code: 0, data: files });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 搜索夸克网盘文件
router.get('/quark/search', async (req, res) => {
    try {
        const { keyword, page } = req.query;
        if (!keyword) return res.json({ code: -1, msg: '关键词不能为空' });
        
        const crawler = getQuarkCrawler();
        const results = await crawler.search(keyword, parseInt(page) || 1);
        
        res.json({ code: 0, data: results });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取夸克网盘文件详情
router.get('/quark/detail', async (req, res) => {
    try {
        const { fid } = req.query;
        if (!fid) return res.json({ code: -1, msg: '文件ID不能为空' });
        
        const crawler = getQuarkCrawler();
        const detail = await crawler.getFileDetail(fid);
        
        if (detail) {
            res.json({ code: 0, data: detail });
        } else {
            res.json({ code: -1, msg: '获取详情失败' });
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取夸克网盘下载链接
router.get('/quark/download', async (req, res) => {
    try {
        const { fid } = req.query;
        if (!fid) return res.json({ code: -1, msg: '文件ID不能为空' });
        
        const crawler = getQuarkCrawler();
        const downloadUrl = await crawler.getDownloadUrl(fid);
        
        if (downloadUrl) {
            res.json({ code: 0, data: { url: downloadUrl } });
        } else {
            res.json({ code: -1, msg: '获取下载链接失败' });
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 夸克直链 / HLS 播放列表代理
// 浏览器直接请求 CDN 会 403/412（Cookie 校验），所以统一由服务端代取；
// m3u8 里的分片地址也改写回本接口，让 hls.js 能一路带着 Cookie 取流。
router.get('/quark/stream', async (req, res) => {
    try {
        const { fid, u, video } = req.query;
        let target = null;

        if (u) {
            target = unb64url(u);
            // 只允许夸克自家 CDN，别把这里变成任意 URL 代理
            if (!/^https:\/\/[\w.-]+\.quark\.cn\//.test(target)) {
                return res.status(400).json({ code: -1, msg: '不支持的地址' });
            }
        } else {
            if (!fid) return res.status(400).json({ code: -1, msg: '缺少 fid' });
            const crawler = getQuarkCrawler();
            const stream = await crawler.getStreamUrl(fid, { isVideo: video === '1' });
            if (!stream) {
                const why = crawler.lastDownloadError || '';
                return res.status(502).json({
                    code: -1,
                    msg: /size limit/i.test(why)
                        ? '夸克非会员不支持直链读取该文件（超过约 50MB）'
                        : ('夸克直链获取失败: ' + (why || '未知错误'))
                });
            }
            target = stream.url;
        }

        const headers = quarkDownloadHeaders();
        if (req.headers.range) headers.Range = req.headers.range;

        const resp = await fetch(target, quarkFetchOptions({ headers }));
        if (!resp.ok) {
            return res.status(resp.status).json({ code: -1, msg: `夸克 CDN 返回 HTTP ${resp.status}` });
        }

        const contentType = resp.headers.get('content-type') || '';
        if (/mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(target)) {
            const text = await resp.text();
            const prox = (abs) => `${QUARK_STREAM_BASE}?fid=${fid || ''}&u=${b64url(abs)}`;
            const rewritten = text.split('\n').map((line) => {
                const t = line.trim();
                if (!t) return line;
                if (t.startsWith('#')) return line.replace(/https?:\/\/[^\s",]+/g, prox);
                return prox(new URL(t, target).href);
            }).join('\n');
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(rewritten);
        }

        res.status(resp.status);
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
            const v = resp.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        pipeBody(resp, res);
    } catch (e) {
        if (!res.headersSent) res.status(502).json({ code: -1, msg: e.message });
        else res.end();
    }
});

// 获取夸克网盘视频播放地址（统一走代理：CDN 要 Cookie，浏览器给不了）
router.get('/quark/video', async (req, res) => {
    try {
        const { fid } = req.query;
        if (!fid) return res.json({ code: -1, msg: '文件ID不能为空' });

        const crawler = getQuarkCrawler();
        const stream = await crawler.getStreamUrl(fid, { isVideo: true });

        if (!stream) {
            const why = crawler.lastDownloadError || '';
            return res.json({
                code: -1,
                msg: /size limit/i.test(why)
                    ? '夸克非会员无法直链该文件，且转码播放地址获取失败'
                    : ('获取播放地址失败: ' + (why || '未知错误'))
            });
        }

        res.json({ code: 0, data: { url: `${QUARK_STREAM_BASE}?fid=${fid}&u=${b64url(stream.url)}`, kind: stream.kind } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取夸克网盘分类文件
router.get('/quark/category', async (req, res) => {
    try {
        const { category, page } = req.query;
        if (!category) return res.json({ code: -1, msg: '分类不能为空' });
        
        const crawler = getQuarkCrawler();
        const files = await crawler.getFilesByCategory(category, parseInt(page) || 1);
        
        res.json({ code: 0, data: files });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ==================== 夸克网盘漫画/小说在线阅读 ====================

// 设置夸克漫画/小说目录（写入 config.json 的 sources.quark.comicDir / novelDir）
router.post('/quark/set-media-dir', (req, res) => {
    try {
        const { type, fid, name } = req.body;
        if (!['comic', 'novel'].includes(type)) return res.json({ code: -1, msg: 'type 必须为 comic 或 novel' });
        if (!fid) return res.json({ code: -1, msg: '目录ID不能为空' });

        const cfg = readConfig();
        if (!cfg.sources) cfg.sources = {};
        if (!cfg.sources.quark) cfg.sources.quark = {};
        const key = type === 'comic' ? 'comicDir' : 'novelDir';
        cfg.sources.quark[key] = { fid: String(fid), name: name || '' };
        writeConfig(cfg);

        res.json({ code: 0, msg: '目录已保存', data: cfg.sources.quark[key] });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取夸克漫画/小说目录下的媒体文件列表（过滤 epub/pdf）
router.get('/quark/media-files', async (req, res) => {
    try {
        const { type, page, pageSize } = req.query;
        if (!['comic', 'novel'].includes(type)) return res.json({ code: -1, msg: 'type 必须为 comic 或 novel' });

        const cfg = readConfig();
        const key = type === 'comic' ? 'comicDir' : 'novelDir';
        const dir = cfg.sources?.quark?.[key];
        if (!dir || !dir.fid) {
            const label = type === 'comic' ? '漫画' : '小说';
            return res.json({ code: -1, msg: `尚未设置${label}目录，请先选择夸克目录` });
        }

        const crawler = getQuarkCrawler();
        const loggedIn = await crawler.checkLogin();
        if (!loggedIn) return res.json({ code: -1, msg: '夸克网盘未登录或Cookie已失效' });

        const p = parseInt(page) || 1;
        const ps = parseInt(pageSize) || 200;
        const result = await crawler.getFileList(dir.fid, p, ps);

        const list = (result.list || []).filter(f => {
            if (f.dir) return false;
            const ext = path.extname(f.file_name || '').toLowerCase();
            return MEDIA_EXTS.includes(ext);
        }).map(f => ({
            fid: f.fid,
            name: f.file_name,
            size: f.size || 0,
            ext: path.extname(f.file_name || '').toLowerCase().replace(/^\./, '')
        }));

        res.json({ code: 0, data: { dir, list, total: list.length, page: p, pageSize: ps } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 夸克 epub 在线阅读（后端代理：下载 → 解包 → 解析章节）
router.get('/quark/read/epub', async (req, res) => {
    try {
        const { fid } = req.query;
        if (!fid) return res.json({ code: -1, msg: '文件ID不能为空' });

        const crawler = getQuarkCrawler();
        const loggedIn = await crawler.checkLogin();
        if (!loggedIn) return res.json({ code: -1, msg: '夸克网盘未登录或Cookie已失效' });

        const downloadUrl = await crawler.getDownloadUrl(fid);
        if (!downloadUrl) return res.json({ code: -1, msg: '获取下载链接失败，临时链接可能已过期' });

        const buffer = await downloadBuffer(downloadUrl);
        const epub = await parseEpub(buffer);
        res.json({ code: 0, data: epub });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 夸克 pdf 在线阅读（后端流式代理转发）
router.get('/quark/read/pdf', async (req, res) => {
    try {
        const { fid } = req.query;
        if (!fid) return res.json({ code: -1, msg: '文件ID不能为空' });

        const crawler = getQuarkCrawler();
        const downloadUrl = await crawler.getDownloadUrl(fid);
        if (!downloadUrl) return res.json({ code: -1, msg: '获取下载链接失败，临时链接可能已过期' });

        const headers = quarkDownloadHeaders();
        if (req.headers.range) headers.Range = req.headers.range;

        const resp = await fetch(downloadUrl, quarkFetchOptions({ headers }));
        if (!resp.ok) return res.status(resp.status).json({ code: -1, msg: `下载失败 HTTP ${resp.status}` });

        res.status(resp.status === 206 ? 206 : 200);
        res.setHeader('Content-Type', resp.headers.get('content-type') || 'application/pdf');
        const contentLength = resp.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        const contentRange = resp.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);
        res.setHeader('Accept-Ranges', 'bytes');

        pipeBody(resp, res);
    } catch (e) {
        if (!res.headersSent) return res.json({ code: -1, msg: e.message });
        res.end();
    }
});

// 夸克网盘 CDP 登录（拉起浏览器，等用户手动登录后抓取 cookie 写回 config.json）
router.post('/quark/login', async (req, res) => {
    try {
        // 容器里没有浏览器，驱动不了登录；直接告诉用户去双击脚本，别让人干等 180 秒
        if (fs.existsSync('/.dockerenv')) {
            return res.json({ code: -1, msg: '容器里无法拉起浏览器。请在项目目录双击「夸克登录.bat」，它会打开扫码窗口并把 cookie 自动写入。' });
        }
        const userBrowser = require('../utils/crawler/user-browser');

        const verify = async (cookieStr) => {
            const testCrawler = new QuarkCrawler({ cookie: cookieStr });
            return await testCrawler.checkLogin();
        };

        const result = await userBrowser.openAndCaptureCookies('https://pan.quark.cn', {
            timeoutMs: 180000,
            domain: 'quark.cn',
            triggerCookieNames: ['ctoken', 'isg', 'isQuark', 'tfstk', '__pus'],
            verify
        });

        if (!result.success) return res.json({ code: -1, msg: result.message });

        const cfg = readConfig();
        if (!cfg.sources) cfg.sources = {};
        if (!cfg.sources.quark) cfg.sources.quark = {};
        cfg.sources.quark.cookie = result.cookie;
        writeConfig(cfg);

        getQuarkCrawler().setCookie(result.cookie);
        res.json({ code: 0, msg: '登录成功', data: { loggedIn: true } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 夸克网盘登录状态（复用 QuarkCrawler.checkLogin）
router.get('/quark/login-status', async (req, res) => {
    try {
        const crawler = getQuarkCrawler();
        const loggedIn = await crawler.checkLogin();
        res.json({ code: 0, data: { loggedIn } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ==================== epub 解析工具 ====================

// 从 XML 标签中提取属性值
function getAttr(tag, name) {
    const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
    const m = tag.match(re);
    return m ? m[1] : '';
}

// 安全 decodeURIComponent
function decodeURIComponentSafe(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
}

// 解码 XML 实体
function decodeEntities(s) {
    return String(s || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

// 读取 opf 中的 dc 元数据（title/creator 等）
function readMeta(xml, localName) {
    const re = new RegExp(`<(?:dc:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:dc:)?${localName}\\s*>`, 'i');
    const m = xml.match(re);
    if (!m) return '';
    return decodeEntities(m[1].trim());
}

// 下载夸克临时链接内容到内存（限制大小）
async function downloadBuffer(downloadUrl) {
    const resp = await fetch(downloadUrl, quarkFetchOptions({ headers: quarkDownloadHeaders() }));
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);

    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_EPUB_SIZE) throw new Error('文件过大，暂不支持在线阅读');

    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_EPUB_SIZE) throw new Error('文件过大，暂不支持在线阅读');
    return Buffer.from(buf);
}

// 解析章节内容（返回 html 与纯文本）
async function extractChapter(zip, opfDir, href) {
    let cleanHref = href.split('#')[0];
    cleanHref = decodeURIComponentSafe(cleanHref);

    const candidates = [];
    if (opfDir) candidates.push(path.posix.normalize(path.posix.join(opfDir, cleanHref)));
    candidates.push(cleanHref.replace(/^\/+/, ''));

    let file = null;
    for (const p of candidates) {
        file = zip.file(p);
        if (file) break;
    }
    if (!file) return { text: '', html: '' };

    const raw = await file.async('string');
    const ext = path.posix.extname(cleanHref).toLowerCase();

    if (['.xhtml', '.html', '.htm', '.xml'].includes(ext)) {
        const $ = cheerio.load(raw);
        const body = $('body');
        const html = body.length ? body.html() : raw;
        const text = (body.length ? body.text() : $.root().text()).trim();
        return { html: html || '', text: text || '' };
    }
    return { html: '', text: raw || '' };
}

// 解析 epub：container.xml → content.opf → metadata + manifest + spine
async function parseEpub(buffer) {
    const zip = await JSZip.loadAsync(buffer);

    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('无效的 epub：缺少 META-INF/container.xml');

    const containerXml = await containerFile.async('string');
    const rootfileMatch = containerXml.match(/<rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/i);
    if (!rootfileMatch) throw new Error('无效的 epub：container.xml 中找不到 rootfile');

    const opfPath = decodeURIComponentSafe(rootfileMatch[1]).replace(/^\/+/, '');
    const opfFile = zip.file(opfPath);
    if (!opfFile) throw new Error('无效的 epub：找不到 content.opf');

    const opf = await opfFile.async('string');
    const opfDir = path.posix.dirname(opfPath);

    const title = readMeta(opf, 'title');
    const author = readMeta(opf, 'creator');

    // manifest
    const manifestMap = {};
    let m;
    const itemRe = /<item\b[^>]*>/g;
    while ((m = itemRe.exec(opf)) !== null) {
        const id = getAttr(m[0], 'id');
        if (!id) continue;
        manifestMap[id] = {
            id,
            href: getAttr(m[0], 'href'),
            mediaType: getAttr(m[0], 'media-type')
        };
    }

    // spine 章节顺序
    const spineRefs = [];
    const refRe = /<itemref\b[^>]*>/g;
    while ((m = refRe.exec(opf)) !== null) {
        const idref = getAttr(m[0], 'idref');
        if (idref) spineRefs.push(idref);
    }

    let order = spineRefs;
    if (order.length === 0) {
        order = Object.values(manifestMap)
            .filter(it => /\.(xhtml|html|htm|xml)$/i.test(it.href || ''))
            .map(it => it.id);
    }

    const chapters = [];
    let idx = 0;
    for (const idref of order) {
        const item = manifestMap[idref];
        if (!item || !item.href) continue;
        const content = await extractChapter(zip, opfDir, item.href);
        chapters.push({
            id: String(idx),
            href: item.href,
            title: item.title || '',
            text: content.text,
            html: content.html
        });
        idx++;
    }

    if (chapters.length === 0) throw new Error('epub 中未解析到任何章节');

    return { title, author, chapters };
}

module.exports = router;
