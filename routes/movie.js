const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { cleanMovieName } = require('../utils/poster-fetcher');
const { spawn } = require('child_process');
const { toHostPath, pathMappings } = require('../utils/path-map');
const { isPathAllowed } = require('../utils/path-guard');
const config = require('../utils/config');
const {
    db,
    getAllMovies,
    getMoviesByHot,
    getMoviesByRecent,
    getMoviesByPlayCount,
    getMoviesByRelease,
    getUnwatchedMovies,
    getFavoriteMovies,
    searchMovies,
    getMovieById,
    updatePlayRecord,
    addWatchHistory,
    toggleFavorite,
    toggleWatched,
    updateRating,
    updateNote,
    getMovieTags,
    getMovieActresses,
    recalcHotScore,
    deleteMovieByPath,
    upsertTag,
    addMovieTag,
    removeMovieTags,
    getTagByName,
    getPlaybackProgress,
    setPlaybackProgress,
    clearPlaybackProgress,
    getAllPlaybackProgress
} = require('../utils/db');
const { withFtsHeal } = require('../utils/db');

// 视频文件流（支持 Range 请求）
router.get('/stream', (req, res) => {
    try {
        const filePath = decodeURIComponent(req.query.path || '');
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ code: -1, msg: '文件不存在' });
        }
        // 路径白名单：只允许访问 config.json 登记的扫描目录内的文件，
        // 防止任意路径读取（此前该接口可读取服务器上任意文件）
        if (!isPathAllowed(filePath)) {
            return res.status(403).json({ code: -1, msg: '路径不在允许的媒体目录内' });
        }

        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            // Range 请求，支持断点续传和拖动进度条
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;

            const file = fs.createReadStream(filePath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': 'video/mp4'
            };

            res.writeHead(206, head);
            file.pipe(res);
        } else {
            // 完整文件
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes'
            };
            res.writeHead(200, head);
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (e) {
        res.status(500).json({ code: -1, msg: e.message });
    }
});

// ==========【新增】唤起 PotPlayer 播放器接口 ==========
// PotPlayer 常见安装路径候选（按顺序探测），解决 config 里没配
// player.potPlayerPath 时硬编码路径不存在导致"打开失败"的问题
const POT_CANDIDATES = [
    'D:\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files\\PotPlayer\\PotPlayerMini64.exe',
    'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'D:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
    'D:\\Program Files\\PotPlayer\\PotPlayerMini64.exe'
];

function findPotPlayerPath() {
    const configured = config?.player?.potPlayerPath;
    const candidates = configured ? [configured, ...POT_CANDIDATES] : POT_CANDIDATES;
    for (const p of candidates) {
        try { if (p && fs.existsSync(p)) return p; } catch (e) { }
    }
    return null;
}

router.post('/open-player/:id', (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });
        const filePath = movie.filePath;
        if (!fs.existsSync(filePath)) {
            return res.json({ code: -1, msg: '视频文件不存在（网盘在线视频请先下载到本地）' });
        }
        const potPlayerPath = findPotPlayerPath();
        if (!potPlayerPath) {
            return res.json({ code: -1, msg: '未找到PotPlayer，请在设置页填写安装路径' });
        }
        // spawn数组传参，自动安全处理带空格路径，禁止字符串拼接命令行
        spawn(potPlayerPath, [filePath], { detached: true, stdio: 'ignore' }).unref();
        res.json({ code: 0, msg: '已唤起PotPlayer' });
    } catch (err) {
        console.error('[PotPlayer唤起失败]', err);
        res.json({ code: -1, msg: '唤起播放器失败：' + err.message });
    }
});

// 打开文件所在文件夹（并选中文件）
router.post('/open-folder/:id', (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });
        const filePath = movie.filePath;
        if (!fs.existsSync(filePath)) {
            return res.json({ code: -1, msg: '文件不存在' });
        }
        // Windows: explorer /select,"文件路径"
        // ⚠️ windowsVerbatimArguments 必须加：默认 Node 会把含空格参数整体加引号成
        //    explorer "/select,E:\a b\c.mp4"，Explorer 解析失败会回退打开「文档」
        spawn('explorer', ['/select,' + filePath], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ code: 0, msg: '已打开文件所在文件夹' });
    } catch (err) {
        console.error('[打开文件夹失败]', err);
        res.json({ code: -1, msg: '打开文件夹失败：' + err.message });
    }
});

// 手动上传封面图片（base64方式）
router.post('/:id/upload-poster', async (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        const { imageData } = req.body;
        if (!imageData) {
            return res.json({ code: -1, msg: '图片数据不能为空' });
        }

        // 解析base64图片
        const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!matches) {
            return res.json({ code: -1, msg: '图片格式不正确，需要base64编码' });
        }

        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer = Buffer.from(matches[2], 'base64');

        // 生成文件名
        const crypto = require('crypto');
        const timestamp = Date.now();
        const fileHash = crypto.createHash('md5').update(movie.filePath + timestamp).digest('hex');
        const posterFileName = `${fileHash}.${ext}`;
        const posterSavePath = path.join(__dirname, '../cache/posters', posterFileName);

        // 保存到缓存目录
        fs.writeFileSync(posterSavePath, buffer);

        // 同时保存到影片所在目录（poster.jpg 和 与视频同名的封面）
        try {
            const videoDir = path.dirname(movie.filePath);
            const videoExt = path.extname(movie.fileName);
            const baseName = movie.fileName.replace(videoExt, '');
            
            // 保存为 poster.jpg
            const localPoster1 = path.join(videoDir, 'poster.jpg');
            fs.writeFileSync(localPoster1, buffer);
            
            // 保存为 folder.jpg
            const localPoster2 = path.join(videoDir, 'folder.jpg');
            fs.writeFileSync(localPoster2, buffer);
            
            // 保存为与视频同名的 jpg
            const localPoster3 = path.join(videoDir, `${baseName}.jpg`);
            fs.writeFileSync(localPoster3, buffer);
        } catch (e) {
            console.log('[上传封面] 保存到影片目录失败:', e.message);
        }

        // 更新数据库
        const updateStmt = db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?');
        updateStmt.run(posterFileName, posterSavePath, movie.id);

        res.json({ 
            code: 0, 
            msg: '封面上传成功',
            data: {
                posterPath: posterFileName,
                posterUrl: `/api/movie/poster/${posterFileName}?t=${timestamp}`
            }
        });
    } catch (err) {
        console.error('[上传封面失败]', err);
        res.json({ code: -1, msg: '上传封面失败：' + err.message });
    }
});

// 代理预览URL图片（绕过防盗链）
router.get('/poster/proxy', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ code: -1, msg: '无效的图片URL' });
        }

        const config = require('../utils/config');
        const downloadOptions = {};
        if (config.network?.proxyServer) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            downloadOptions.agent = new HttpsProxyAgent(config.network.proxyServer);
        }

        const resp = await fetch(url, {
            ...downloadOptions,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                // 部分图床认Referer：91动漫图床(pic.tuafjz.cn)要用站点根，
                // 其它按自身 origin 兜底即可
                'Referer': /tuafjz\.cn|iffuglfyc/.test(url)
                    ? (require('../utils/config').sources?.dongman?.baseUrl || 'https://91dongman.net') + '/'
                    : new URL(url).origin + '/',
                'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            }
        });

        if (!resp.ok) {
            return res.status(resp.status).json({ code: -1, msg: `下载失败 HTTP ${resp.status}` });
        }

        const arrayBuffer = await resp.arrayBuffer();
        const rawBuf = Buffer.from(arrayBuffer);

        // ★ 必须过「是不是真图片」这一关：91动漫图床返回的是 **AES-128-CBC 密文**，
        //   原样转发给浏览器 → 前端显示破图（实测海报候选面板全是白框）。
        //   能解密就解密，不能就当作失败（别把密文当图片发出去）。
        const { ensureRealImage, imageKind } = require('../utils/crawler/image-guard');
        const realBuf = ensureRealImage(rawBuf);
        if (!realBuf) {
            return res.status(502).json({ code: -1, msg: `返回内容不是图片（${rawBuf.length}B，加密或防盗链页）` });
        }
        if (realBuf !== rawBuf) {
            console.log(`[图片代理] AES 解密成功: ${url.split('?')[0].slice(-52)}`);
        }

        const kind = imageKind(realBuf);
        res.setHeader('Content-Type', kind === 'png' ? 'image/png' : kind === 'gif' ? 'image/gif' : kind === 'webp' ? 'image/webp' : 'image/jpeg');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(realBuf);
    } catch (e) {
        console.error('[图片代理] 失败:', e.message);
        res.status(500).json({ code: -1, msg: '代理下载失败: ' + e.message });
    }
});

// ============================================================================
// 宿主机「海报中转」(tools/poster-relay.js)
// 容器出网被掐得很死（打外网域名 ~5s 后 RST），而宿主机出网明显更宽：
// 实测宿主机可达 api.anilist.co / api.jikan.moe / anime1.me，容器全不通。
// 所以这里把抓取请求交给宿主机代发，容器只做转发 + 解析。
// 中转没启动时全部静默降级（relayRequest 返回 null），不影响原有链路。
// ⚠️ 这几个路由必须注册在 `/:id` 之前，否则会被 /:id 吞掉。
// ============================================================================
function relayCfg() {
    const cfg = require('../utils/config');
    const r = (cfg.network && cfg.network.relay) || {};
    return {
        enabled: r.enabled !== false && !!r.url,
        url: String(r.url || '').replace(/\/+$/, ''),
        token: r.token || '',
        timeout: Number(r.timeout || 15000),
    };
}

/** 打中转；不可用返回 null（不抛） */
async function relayRequest(pathname, timeoutMs) {
    const r = relayCfg();
    if (!r.enabled) return null;
    try {
        const res = await fetch(r.url + pathname, {
            headers: r.token ? { 'x-relay-token': r.token } : {},
            signal: AbortSignal.timeout(timeoutMs || r.timeout),
        });
        if (!res.ok) {
            console.log('[海报中转] HTTP ' + res.status + ' ' + pathname.slice(0, 80));
            return null;
        }
        return res;
    } catch (e) {
        console.log('[海报中转] 不可用（' + (e.code || e.name || e.message) + '），走原链路');
        return null;
    }
}

// 把任意图片经宿主机中转回来（浏览器不用能连外网，图走容器出）
router.get('/poster/relay', async (req, res) => {
    try {
        const { url, referer } = req.query;
        if (!url || !/^https?:/i.test(url)) return res.status(400).json({ code: -1, msg: '无效的图片URL' });
        let r = ref => relayRequest('/proxy?url=' + encodeURIComponent(url) + (ref ? '&referer=' + encodeURIComponent(ref) : ''), 25000);
        let out = await r(referer);
        if (!out) out = await r();                    // 带 referer 失败就裸取
        if (!out) return res.status(502).json({ code: -1, msg: '中转不可用，先启动 tools/start-poster-relay.bat' });
        const buf = Buffer.from(await out.arrayBuffer());
        res.setHeader('Content-Type', out.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buf);
    } catch (e) {
        console.error('[图片中转] 失败:', e.message);
        res.status(500).json({ code: -1, msg: e.message });
    }
});

// 动画海报搜索：走宿主机的 AniList（跨站抓封面时容器自己够不着）
// 返回结构与 hanime-proxy-search 一致，前端可直接复用「更换海报」的渲染
router.get('/anime-search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) return res.json({ code: -1, msg: '关键词不能为空', data: [] });
        const limit = Math.min(Math.max(Number(req.query.limit || 6), 1), 20);
        const out = await relayRequest('/anilist?q=' + encodeURIComponent(q) + '&limit=' + limit, 20000);
        if (!out) return res.json({ code: -1, msg: 'AniList 中转不可用（先启动 tools/start-poster-relay.bat）', data: [] });
        const j = await out.json();
        const list = (j.data || []).map(it => Object.assign({}, it, {
            // 封面也走容器中转，避免用户浏览器直连 anilist 图床失败
            cover: '/api/movie/poster/relay?url=' + encodeURIComponent(it.cover),
            coverRaw: it.cover,
        }));
        return res.json({ code: 0, data: list, source: 'anilist' });
    } catch (e) {
        console.log('[AniList 搜索异常]', e.message);
        return res.json({ code: -1, msg: e.message, data: [] });
    }
});

// hanime1.me 搜索（HTML 经宿主机中转取回，容器只负责解析）
// 老接口 /hanime-proxy-search 注册在 /:id 之后，其实一直被 /:id 吞掉，这里补一个能用的
router.get('/hanime-search', async (req, res) => {
    try {
        const keyword = (req.query.q || '').trim();
        if (!keyword) return res.json({ code: -1, msg: '关键词不能为空', data: [] });

        const baseUrl = (require('../utils/config').sources?.hanime?.baseUrl || 'https://hanime1.me').replace(/\/+$/, '');
        const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(keyword)}`;

        // ① 优先走宿主机中转
        let html = null;
        const out = await relayRequest('/proxy?url=' + encodeURIComponent(searchUrl) + '&referer=' + encodeURIComponent(baseUrl), 25000);
        if (out) html = await out.text();

        // ② 中转不可用 → 原样直连（容器能通的话）
        if (!html) {
            const fetchNF = (...a) => import('node-fetch').then(({ default: fetch }) => fetch(...a));
            const resp = await fetchNF(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8',
                    'Referer': baseUrl,
                },
                timeout: 15000,
            });
            html = await resp.text();
        }
        if (!html) return res.json({ code: -1, msg: 'hanime1.me 取不到（中转未启动且容器直连不通）', data: [] });

        const cheerio = require('cheerio');
        const $ = cheerio.load(html);
        const resultList = [];
        const isAdHref = (href) => !href || /erodalabs|juicyads|exoclick/i.test(href) || !(href.includes('/watch/') || href.includes('/watch?v='));
        $('div.video-item-container').each((_, el) => {
            const $el = $(el);
            const $a = $el.find('a.video-link').first();
            let href = $a.attr('href') || '';
            if (isAdHref(href)) return;
            const title = $el.attr('title') || $a.find('.title').text().trim();
            const img = $el.find('img.main-thumb').first();
            let cover = img.attr('data-src') || img.attr('src') || '';
            if (!title || !href || !cover) return;
            if (cover.startsWith('//')) cover = 'https:' + cover;
            else if (cover.startsWith('/')) cover = baseUrl + cover;
            if (href.startsWith('//')) href = 'https:' + href;
            else if (href.startsWith('/')) href = baseUrl + href;
            resultList.push({ title, cover, url: href, source: 'hanime' });
        });
        return res.json({ code: 0, data: resultList });
    } catch (e) {
        console.log('[hanime 搜索异常]', e.message);
        return res.json({ code: -1, msg: e.message, data: [] });
    }
});

// 通过URL上传封面（后端自动下载）
router.post('/:id/upload-poster-url', async (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        const { url } = req.body;
        if (!url || !url.startsWith('http')) {
            return res.json({ code: -1, msg: '请输入有效的图片URL' });
        }

        console.log(`[URL上传封面] 正在下载: ${url}`);

        // 下载图片
        const config = require('../utils/config');
        const downloadOptions = {};
        if (config.network?.proxyServer) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            downloadOptions.agent = new HttpsProxyAgent(config.network.proxyServer);
        }

        const resp = await fetch(url, {
            ...downloadOptions,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': new URL(url).origin + '/'
            }
        });

        if (!resp.ok) {
            return res.json({ code: -1, msg: `下载失败 HTTP ${resp.status}` });
        }

        const arrayBuffer = await resp.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 检测文件类型
        const contentType = resp.headers.get('content-type') || '';
        let ext = 'jpg';
        if (contentType.includes('png')) ext = 'png';
        else if (contentType.includes('webp')) ext = 'webp';
        else if (contentType.includes('gif')) ext = 'gif';
        else {
            // 从URL推断
            const urlExt = url.split('?')[0].split('.').pop().toLowerCase();
            if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(urlExt)) {
                ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
            }
        }

        // 生成文件名
        const crypto = require('crypto');
        const timestamp = Date.now();
        const fileHash = crypto.createHash('md5').update(movie.filePath + timestamp).digest('hex');
        const posterFileName = `${fileHash}.${ext}`;
        const posterSavePath = path.join(__dirname, '../cache/posters', posterFileName);

        // 保存到缓存目录
        fs.writeFileSync(posterSavePath, buffer);

        // 同时保存到影片所在目录
        try {
            const videoDir = path.dirname(movie.filePath);
            const videoExt = path.extname(movie.fileName);
            const baseName = movie.fileName.replace(videoExt, '');

            fs.writeFileSync(path.join(videoDir, 'poster.jpg'), buffer);
            fs.writeFileSync(path.join(videoDir, 'folder.jpg'), buffer);
            fs.writeFileSync(path.join(videoDir, `${baseName}.jpg`), buffer);
        } catch (e) {
            console.log('[URL上传封面] 保存到影片目录失败:', e.message);
        }

        // 更新数据库
        const updateStmt = db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?');
        updateStmt.run(posterFileName, posterSavePath, movie.id);

        console.log(`[URL上传封面] 成功: ${posterFileName}`);

        res.json({ 
            code: 0, 
            msg: '封面下载并保存成功',
            data: {
                posterPath: posterFileName,
                posterUrl: `/api/movie/poster/${posterFileName}?t=${timestamp}`
            }
        });
    } catch (err) {
        console.error('[URL上传封面失败]', err);
        res.json({ code: -1, msg: '下载封面失败：' + err.message });
    }
});

// 获取影片列表（支持排序和筛选）
router.get('/', (req, res) => {
    try {
        const sort = req.query.sort || 'hot';
        const filter = req.query.filter || 'all';
        const type = req.query.type || 'all';
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 50;
        const limit = pageSize;
        const offset = (page - 1) * pageSize;

        let list = [];
        let total = 0;

        // 先获取全部（用于计算总数和筛选）
        let allList = [];
        if (filter === 'favorite') {
            allList = getFavoriteMovies.all();
        } else if (filter === 'unwatched') {
            allList = getUnwatchedMovies.all(999999, 0);
        } else {
            allList = getAllMovies.all();
        }

        // 按类型筛选（确保严格匹配，容错处理NULL和空字符串）
        if (type && type !== 'all') {
            const typeLower = String(type).toLowerCase();
            allList = allList.filter(m => {
                const mType = (m.type || 'jav').toLowerCase();
                return mType === typeLower;
            });
        }

        // 按女优筛选
        if (req.query.actressId) {
            const { getMovieActresses } = require('../utils/db');
            const actressId = parseInt(req.query.actressId);
            allList = allList.filter(m => {
                const actresses = getMovieActresses.all(m.id);
                return actresses.some(a => a.id === actressId);
            });
        }

        // 按标签筛选
        if (req.query.tagId) {
            const { getMovieTags } = require('../utils/db');
            const tagId = parseInt(req.query.tagId);
            allList = allList.filter(m => {
                const tags = getMovieTags.all(m.id);
                return tags.some(t => t.id === tagId);
            });
        }

        total = allList.length;

        // 排序
        switch (sort) {
            case 'hot':
                allList.sort((a, b) => (b.hotScore || 0) - (a.hotScore || 0));
                break;
            case 'recent':
                allList.sort((a, b) => (b.addedTime || 0) - (a.addedTime || 0));
                break;
            case 'play':
                allList.sort((a, b) => (b.playCount || 0) - (a.playCount || 0));
                break;
            case 'lastplay':
                // 最近观看：按最后播放时间倒序（没看过的自然沉底，前端再过滤）
                allList.sort((a, b) => (b.lastPlayTime || 0) - (a.lastPlayTime || 0));
                break;
            case 'release':
                allList.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
                break;
        }

        // 分页
        list = allList.slice(offset, offset + limit);
        list.forEach(m => { m.hostPath = toHostPath(m.filePath); });

        res.json({
            code: 0,
            data: list,
            total: total,
            page: page,
            pageSize: pageSize,
            totalPages: Math.ceil(total / pageSize)
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 搜索影片
router.get('/search', (req, res) => {
    try {
        const q = req.query.q || '';
        const type = req.query.type || 'all';
        const kw = `%${q}%`;
        let data = searchMovies.all({ kw });
        
        // 按类型筛选
        if (type && type !== 'all') {
            const typeLower = String(type).toLowerCase();
            data = data.filter(m => {
                const mType = (m.type || 'jav').toLowerCase();
                return mType === typeLower;
            });
        }
        
        // 记录搜索历史（关键词长度>=2才记录）
        if (q && q.length >= 2) {
            try {
                const { addSearchHistory } = require('../utils/db');
                addSearchHistory.run(q, Date.now(), data.length);
            } catch (e) {
                console.log('[搜索历史] 记录失败:', e.message);
            }
        }
        
        data.forEach(m => { m.hostPath = toHostPath(m.filePath); });
        res.json({ code: 0, data });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== 播放进度（续播） ==========
// 保存进度：position >= 95% 视为看完，自动标记已看并清除续播点
router.post('/progress/:id', (req, res) => {
    try {
        const { position, duration } = req.body || {};
        const pos = parseFloat(position) || 0;
        const dur = parseFloat(duration) || 0;
        if (dur > 0 && pos / dur >= 0.95) {
            clearPlaybackProgress.run(req.params.id);
            db.prepare('UPDATE movies SET watched = 1 WHERE id = ?').run(req.params.id);
            return res.json({ code: 0, data: { completed: true } });
        }
        setPlaybackProgress.run({
            movieId: parseInt(req.params.id),
            position: pos,
            duration: dur,
            updatedAt: Date.now()
        });
        res.json({ code: 0, data: { completed: false } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 查询单部进度
router.get('/progress/:id', (req, res) => {
    try {
        const row = getPlaybackProgress.get(req.params.id);
        res.json({ code: 0, data: row || null });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 批量查询进度（卡片进度条用），返回 movieId -> percent 映射
router.get('/progress-map', (req, res) => {
    try {
        const rows = getAllPlaybackProgress.all();
        const map = {};
        for (const r of rows) {
            if (r.duration > 0) {
                map[r.movieId] = Math.min(100, Math.round((r.position / r.duration) * 100));
            }
        }
        res.json({ code: 0, data: map });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 清除进度（不标记已看）
router.post('/progress/:id/clear', (req, res) => {
    try {
        clearPlaybackProgress.run(req.params.id);
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== 海报健康检测（缺失 / 多部共用同一张封面） ==========
// 找出：① 完全没有海报的影片；② 封面图片内容完全相同的多部影片（同一张图下给多部）。
// 注意：数据库路径本身不重复，但不同文件里可能是同一张图片，故按图片字节 hash 去重。
/* ★ round26 #10：入库时间线查询
 * GET /api/movie/added-timeline?days=7&q=&limit=300&type=
 * 返回「最近 N 天入库」的影片（按入库时间倒序）+ 按天分桶计数。
 * 既给前端时间线用，也给 AI/agent 当工具用（用户要求「让 AI 也能提出」）。
 * ⚠️ 必须注册在 /:id 之前，否则 'added-timeline' 会被当成影片 id。
 */
router.get('/added-timeline', (req, res) => {
    try {
        const days = Math.max(0, parseInt(req.query.days) || 0);
        const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit) || 300));
        const q = String(req.query.q || '').trim();
        const type = String(req.query.type || '').trim();
        const since = days > 0 ? Date.now() - days * 86400000 : 0;

        const where = ['IFNULL(addedTime,0) >= ?'];
        const args = [since];
        if (type && type !== 'all') {
            where.push("COALESCE(NULLIF(type,''),'jav') = ?");
            args.push(type);
        }
        if (q) {
            where.push("(IFNULL(title,'') LIKE ? OR IFNULL(fileName,'') LIKE ? OR IFNULL(avid,'') LIKE ?)");
            const like = '%' + q + '%';
            args.push(like, like, like);
        }

        const sql = `SELECT * FROM movies WHERE ${where.join(' AND ')} ORDER BY IFNULL(addedTime,0) DESC LIMIT ?`;
        const list = db.prepare(sql).all(...args, limit);
        list.forEach(m => { m.hostPath = toHostPath(m.filePath); });

        // 按天分桶：日期 → 条数（时间线分组用）
        const buckets = {};
        for (const m of list) {
            const d = new Date(Number(m.addedTime) || 0);
            if (isNaN(d.getTime())) continue;
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            buckets[key] = (buckets[key] || 0) + 1;
        }

        res.json({ code: 0, data: list, total: list.length, days: days, buckets: buckets });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.get('/poster-health', (req, res) => {
    try {
        const fs = require('fs');
        const crypto = require('crypto');
        const path = require('path');
        const cacheDir = path.join(__dirname, '../cache/posters');

        // 解析某部影片实际海报文件路径（兼容 Docker /app 前缀、Windows 反斜杠、相对路径）
        const resolvePosterFile = (movie) => {
            const candidates = [];
            if (movie.localPosterPath) candidates.push(movie.localPosterPath);
            if (movie.posterPath) {
                if (path.isAbsolute(movie.posterPath)) candidates.push(movie.posterPath);
                else candidates.push(path.join(cacheDir, movie.posterPath));
            }
            for (const c of candidates) {
                // 统一分隔符：Windows 存的是反斜杠，Linux 需转成 / 才能命中
                const normalized = c.replace(/\\/g, '/');
                const variants = [
                    normalized,
                    normalized.replace(/^\/app\//, ''),
                    path.join(cacheDir, path.basename(normalized))
                ];
                for (const cand of variants) {
                    try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch (e) {}
                }
            }
            return null;
        };

        const all = db.prepare("SELECT id, title, fileName, type, posterPath, localPosterPath FROM movies").all();
        const missing = [];
        const byHash = new Map();

        for (const m of all) {
            const file = resolvePosterFile(m);
            if (!file) { missing.push({ ...m, posterUrl: '' }); continue; }
            let hash;
            try {
                hash = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
            } catch (e) {
                missing.push({ ...m, posterUrl: '' });
                continue;
            }
            if (!byHash.has(hash)) byHash.set(hash, []);
            byHash.get(hash).push({ ...m, posterFile: file });
        }

        // 内容相同的分组（>1 部共用同一张封面）
        const duplicateGroups = [];
        for (const [hash, group] of byHash) {
            if (group.length > 1) {
                duplicateGroups.push({
                    hash,
                    count: group.length,
                    movies: group.map(g => ({ id: g.id, title: g.title, fileName: g.fileName, type: g.type }))
                });
            }
        }
        duplicateGroups.sort((a, b) => b.count - a.count);

        res.json({ code: 0, data: { missing, duplicateGroups, missingCount: missing.length, dupGroupsCount: duplicateGroups.length } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});
router.get('/fts-search', (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const type = req.query.type || 'all';
        if (!q) return res.json({ code: 0, data: [] });
        // 用户输入按普通词处理，避免裸冒号等 FTS 语法字符导致报错
        const safe = q.replace(/["'()\[\]{}:*^]/g, ' ').split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' ');
        if (!safe) return res.json({ code: 0, data: [] });
        let rows;
        try {
            rows = db.prepare(`
                SELECT m.*, bm25(movies_fts) as rank
                FROM movies_fts f
                JOIN movies m ON m.id = f.rowid
                WHERE movies_fts MATCH ?
                ORDER BY rank
                LIMIT 30
            `).all(safe);
        } catch (e) {
            // FTS 不可用时回退 LIKE
            const kw = `%${q}%`;
            rows = searchMovies.all({ kw }).slice(0, 30);
        }
        if (type && type !== 'all') {
            const typeLower = String(type).toLowerCase();
            rows = rows.filter(m => (m.type || 'jav').toLowerCase() === typeLower);
        }
        rows.forEach(m => { m.hostPath = toHostPath(m.filePath); });
        res.json({ code: 0, data: rows });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/* ===== 全文索引（FTS）体检 / 修复 —— 2026-09-25 round27 =====
 * 背景：movies_fts 的影子表坏掉时，`PRAGMA integrity_check` 依然返回 ok，
 *   但**任何触发 movies_fts_update 触发器的 UPDATE 都会报 `database disk image is malformed`**
 *   ⇒ 「编辑标题 / 重命名 / 重新刮削写片名」全部失败，前端只看到「保存失败」，
 *   看起来像前端 bug，实际是库坏了。
 * 前端在「保存失败」时可调 /fts-repair 自愈一次再重试。
 * ⚠️ 必须注册在裸 `/:id`（本文件 L842 附近）**之前**：实测放到后面会被 `/:id` 吃掉，
 *    返回 `{"code":-1,"msg":"影片不存在"}`（round27 活体验证踩到）。 */
router.get('/fts-health', (req, res) => {
    try {
        const { ftsIsWritable } = require('../utils/db');
        res.json({ code: 0, data: ftsIsWritable() });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取影片详情
router.get('/:id', (req, res) => {
    try {
        const item = getMovieById.get(req.params.id);
        if (!item) return res.json({ code: -1, msg: '影片不存在' });

        const tags = getMovieTags.all(req.params.id);
        const actresses = getMovieActresses.all(req.params.id);
        item.tags = tags;
        item.actresses = actresses;
        item.hostPath = toHostPath(item.filePath);

        res.json({ code: 0, data: item });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 记录播放
router.post('/play/:id', (req, res) => {
    try {
        const now = Date.now();
        updatePlayRecord.run({ id: req.params.id, time: now });
        addWatchHistory.run(req.params.id, now, 0);
        recalcHotScore(req.params.id);
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 切换收藏
router.post('/favorite/:id', (req, res) => {
    try {
        toggleFavorite.run(req.params.id);
        recalcHotScore(req.params.id);
        const movie = getMovieById.get(req.params.id);
        res.json({ code: 0, data: { favorite: movie?.favorite === 1 } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 切换已看/未看
router.post('/watched/:id', (req, res) => {
    try {
        toggleWatched.run(req.params.id);
        recalcHotScore(req.params.id);
        const movie = getMovieById.get(req.params.id);
        res.json({ code: 0, data: { watched: movie?.watched === 1 } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 更新评分
router.post('/rating/:id', (req, res) => {
    try {
        const { rating } = req.body;
        updateRating.run({ id: req.params.id, rating: parseFloat(rating) || 0 });
        recalcHotScore(req.params.id);
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 更新备注
router.post('/note/:id', (req, res) => {
    try {
        const { note } = req.body;
        updateNote.run({ id: req.params.id, note: note || '' });
        res.json({ code: 0, msg: 'ok' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 更新元数据（标题、简介等）
router.post('/update/:id', (req, res) => {
    try {
        const { title, overview, releaseDate, producer, serial, director } = req.body;
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        withFtsHeal(() => db.prepare(`
            UPDATE movies SET 
                title = COALESCE(?, title),
                overview = COALESCE(?, overview),
                releaseDate = COALESCE(?, releaseDate),
                producer = COALESCE(?, producer),
                serial = COALESCE(?, serial),
                director = COALESCE(?, director)
            WHERE id = ?
        `).run(title, overview, releaseDate, producer, serial, director, req.params.id), '编辑标题');

        res.json({ code: 0, msg: '更新成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 手动重新刮削
router.post('/rescrape/:id', async (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        // 异步执行刮削
        res.json({ code: 0, msg: '已开始重新刮削' });

        // 后台执行刮削
        const { processSingleFile } = require('../utils/scanner');
        processSingleFile(movie.filePath).catch(e => {
            console.log(`重新刮削失败 [${movie.fileName}]:`, e.message);
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 搜索番号的所有可用海报（用于手动更换）
router.get('/:id/search-posters', async (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        const path = require('path');
        const { detectTypeByPath, searchAllPosters } = require('../utils/poster-fetcher');

        // 根据文件路径判断资源类型（优先于数据库中的type字段）
        const detectedType = detectTypeByPath(movie.filePath);
        const finalType = movie.type || detectedType;
        
        console.log(`[搜索海报] 影片: ${movie.fileName}, 路径: ${movie.filePath}, 数据库type: ${movie.type}, 路径检测type: ${detectedType}, 最终使用: ${finalType}`);

        let realFileName = movie.fileName;
        if (!realFileName && movie.filePath) {
            realFileName = path.basename(movie.filePath);
        }

        const posters = await searchAllPosters(movie.avid, movie.cleanName, realFileName, finalType, movie.filePath);
        res.json({ code: 0, data: posters });
    } catch (e) {
        console.log("search-posters异常", e);
        res.json({ code: -1, msg: e.message });
    }
});

/* ==========================================================================
   封面兜底（2026-09-22）
   漫画 178 部（PDF）+ 小说 5 部（EPUB）此前 posterPath 全空，在线搜也常搜不到。
   链路：在线搜（kmoe / zlibrary）→ 内容截图（PDF 第 1 页 / EPUB 内封面图）。
   详见 utils/cover-fallback.js
   ========================================================================== */

// 单部：给指定影片补封面
router.post('/:id/auto-cover', async (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        const { autoCover } = require('../utils/cover-fallback');
        const r = await autoCover(db, movie.id, {
            searchFirst: req.body && req.body.searchFirst !== false,
            force: !!(req.body && req.body.force),
            log: s => console.log(`[补封面 #${movie.id}]${s}`),
        });
        res.json({ code: r.ok ? 0 : -1, data: r, msg: r.ok ? '已生成封面' : (r.error || '失败') });
    } catch (e) {
        console.log('auto-cover 异常', e);
        res.json({ code: -1, msg: e.message });
    }
});

// 批量：补齐所有缺封面的漫画 / 小说（后台跑，立即返回）
let _coverJob = null;
router.post('/auto-cover/batch', async (req, res) => {
    if (_coverJob && _coverJob.running) {
        return res.json({ code: 0, data: _coverJob, msg: '已有任务在跑' });
    }
    const { autoCoverBatch } = require('../utils/cover-fallback');
    const opts = (req.body || {});
    _coverJob = {
        running: true, startedAt: Date.now(),
        total: 0, done: 0, ok: 0, fail: 0, lastTitle: '', failures: [],
        types: Array.isArray(opts.types) && opts.types.length ? opts.types : null,
    };
    res.json({ code: 0, data: _coverJob, msg: '已开始后台补齐' });

    autoCoverBatch(db, {
        // ★ round27：默认 null → 由 cover-fallback 按库内实况探测「谁缺封面补谁」。
        //   原来写死 ['comic','novel']，而缺封面的往往是 anime ⇒ 扫完 0 条、点了没反应。
        types: (Array.isArray(opts.types) && opts.types.length) ? opts.types : null,
        limit: opts.limit || 0,
        searchFirst: !!opts.searchFirst,
        force: !!opts.force,
        log: s => console.log('[补封面]' + s),
        onProgress: (done, total, movie, r) => {
            _coverJob.done = done;
            _coverJob.total = total;
            _coverJob.lastTitle = (movie.title || movie.fileName || '').slice(0, 40);
            if (r.ok) _coverJob.ok++;
            else { _coverJob.fail++; if (_coverJob.failures.length < 30) _coverJob.failures.push({ id: movie.id, fileName: movie.fileName, error: r.error }); }
        },
    }).then(r => {
        _coverJob.running = false;
        _coverJob.finishedAt = Date.now();
        _coverJob.total = r.total;
        _coverJob.types = r.types || _coverJob.types;
        console.log(`[补封面] 完成 成功${r.ok} 失败${r.fail}（类型 ${(_coverJob.types || []).join(',') || '-'}）`);
    }).catch(e => {
        _coverJob.running = false;
        _coverJob.error = e.message;
        console.log('[补封面] 异常', e);
    });
});

// 批量进度
router.get('/auto-cover/status', (req, res) => {
    res.json({ code: 0, data: _coverJob || { running: false, done: 0, total: 0 } });
});

/* ===== 全文索引（FTS）修复 —— 2026-09-25 round27 =====
 * 背景与「保存失败」的因果见上方 `GET /fts-health` 处注释块。
 * ⚠️ GET /fts-health 必须注册在裸 `/:id` **之前**（实测被 `/:id` 吃掉会返回「影片不存在」）；
 *    本 POST 版是两段以上静态路径，不受裸 `/:id` 影响，留在原位即可。 */
router.post('/fts-repair', (req, res) => {
    try {
        const { rebuildFts } = require('../utils/db');
        const r = rebuildFts('前端手动触发');
        res.json({ code: r.ok ? 0 : -1, data: r, msg: r.ok ? '全文索引已重建，请重试刚才的操作' : r.error });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});
// 新增：hanime搜索代理接口，给前端更换海报使用，无playwright，纯http代理
router.get('/hanime-proxy-search', async (req, res) => {
    try {
        const keyword = req.query.q?.trim();
        if (!keyword) return res.json({ code: -1, msg: "关键词不能为空" });
        const baseUrl = (require('../utils/config').sources?.hanime?.baseUrl || 'https://hanime1.me').replace(/\/+$/, '');
        const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(keyword)}`;

        // 使用node-fetch简单http请求，不需要playwright
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        const resp = await fetch(searchUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8",
                "Referer": baseUrl
            },
            timeout: 15000
        });
        const html = await resp.text();
        const cheerio = require('cheerio');
        const $ = cheerio.load(html);
        const resultList = [];

        // 解析搜索卡片（前端代理接口使用的解析器）
        // 当前 hanime1.me 结构：div.video-item-container > .horizontal-card > a.video-link + img.main-thumb
        const isAdHref = (href) => !href || /erodalabs|juicyads|exoclick/i.test(href) || !(href.includes('/watch/') || href.includes('/watch?v='));
        $('div.video-item-container').each((_, el) => {
            const $el = $(el);
            const $a = $el.find('a.video-link').first();
            const href = $a.attr('href') || '';
            if (isAdHref(href)) return;

            const title = $el.attr('title') || $a.find('.title').text().trim();
            const img = $el.find('img.main-thumb').first();
            let cover = img.attr('data-src') || img.attr('src') || '';
            if (!title || !href || !cover) return;

            if (cover.startsWith('//')) cover = 'https:' + cover;
            else if (cover.startsWith('/')) cover = baseUrl + cover;
            if (href.startsWith('//')) href = 'https:' + href;
            else if (href.startsWith('/')) href = baseUrl + href;

            resultList.push({
                title,
                cover,
                url: href,
                source: "hanime"
            });
        });
        return res.json({ code: 0, data: resultList });
    } catch (e) {
        console.log("[hanime代理搜索异常]", e.message);
        return res.json({ code: -1, msg: e.message, data: [] });
    }
});
// 更换海报
// 视频截帧候选：没刮到封面时，让用户从视频里挑一帧当海报
// ponytail: 每次请求现截 4 帧落盘缓存（同名直接复用），够用；要更多候选就加 OFFSETS
const FRAME_OFFSETS = [0.1, 0.35, 0.6, 0.85];
router.get('/:id/frame-candidates', async (req, res) => {
    const { captureVideoThumb } = require('../utils/metadata');
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });
        if (!fs.existsSync(movie.filePath)) return res.json({ code: 0, data: [] });

        const ext = path.extname(movie.filePath).toLowerCase();

        /* ★ round25 修复 #105（第二半）：
         * 漫画（PDF）/ 小说（EPUB）根本没有视频帧可截，此前这个接口对它们
         * 直接返回空数组 ⇒ 用户在「选封面」弹窗里看不到任何候选。
         * 这里按类型给出「内容截图」候选：
         *   · PDF  → 用 pdf.js 渲染前 4 页（浏览器内截图，无需 poppler）
         *   · EPUB → 抽出内封面图
         * 复用 utils/cover-fallback，不重复造轮子。 */
        if (ext === '.pdf' || ext === '.epub') {
            const data = [];
            const crypto = require('crypto');
            const { renderPdfFirstPage, extractEpubCover } = require('../utils/cover-fallback');
            const cacheDir = path.join(__dirname, '../cache/posters');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

            if (ext === '.pdf') {
                // PDF：前 4 页各出一张，让用户挑一页最像封面的
                const pages = [1, 2, 3, 4];
                for (const p of pages) {
                    const file = 'pdfpage-' + crypto.createHash('md5')
                        .update(movie.filePath + ':p' + p).digest('hex') + '.jpg';
                    const dest = path.join(cacheDir, file);
                    try {
                        if (!fs.existsSync(dest)) {
                            const buf = await renderPdfFirstPage(movie.filePath, { page: p });
                            if (buf && buf.length > 2048) fs.writeFileSync(dest, buf);
                        }
                        if (fs.existsSync(dest)) {
                            data.push({ source: '内容页', kind: 'pdf', page: p, url: `/api/movie/poster/${file}`, title: `第 ${p} 页` });
                        }
                    } catch (e) { /* 这一页渲不出来就跳过 */ }
                }
            } else {
                // EPUB：内封面（若内封面太小或不存在，cover-fallback 会自动退到最大图）
                const file = 'epubcover-' + crypto.createHash('md5')
                    .update(movie.filePath).digest('hex') + '.jpg';
                const dest = path.join(cacheDir, file);
                try {
                    if (!fs.existsSync(dest)) {
                        const buf = extractEpubCover(movie.filePath);
                        if (buf && buf.length > 2048) fs.writeFileSync(dest, buf);
                    }
                    if (fs.existsSync(dest)) {
                        data.push({ source: '内封面', kind: 'epub', url: `/api/movie/poster/${file}`, title: 'EPUB 内封面' });
                    }
                } catch (e) { /* 取不到就算了 */ }
            }
            return res.json({ code: 0, data });
        }

        // —— 视频：原有逻辑（按时长比例取 4 个时间点）——
        const duration = Number(movie.duration) || 0;
        const times = duration > 0
            ? FRAME_OFFSETS.map(t => Math.max(1, Math.round(duration * t)))
            : [1, 10, 30, 60];

        const data = [];
        for (const t of times) {
            const file = `frame-${movie.id}-${t}.jpg`;
            const dest = path.join(__dirname, '../cache/posters', file);
            try {
                if (!fs.existsSync(dest)) await captureVideoThumb(movie.filePath, dest, duration, t);
                if (fs.existsSync(dest)) {
                    data.push({
                        source: '截帧',
                        kind: 'video',
                        url: `/api/movie/poster/${file}`,
                        title: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
                    });
                }
            } catch (e) { /* 这一帧截不出来就跳过 */ }
        }
        return res.json({ code: 0, data });
    } catch (e) {
        return res.json({ code: -1, msg: e.message });
    }
});

router.post('/:id/change-poster', async (req, res) => {
    try {
        const { posterUrl } = req.body;
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });
        if (!posterUrl) return res.json({ code: -1, msg: '海报地址不能为空' });

        const { downloadPoster } = require('../utils/poster-fetcher');
        const crypto = require('crypto');
        const fs = require('fs');
        const path = require('path');

        // 生成新的海报文件名（带时间戳防止缓存）
        const timestamp = Date.now();
        const fileHash = crypto.createHash('md5').update(movie.filePath + timestamp).digest('hex');
        const posterFileName = fileHash + '.jpg';
        const posterSavePath = path.join(__dirname, '../cache/posters', posterFileName);

        // 删除旧的海报文件
        if (movie.posterPath) {
            const oldPosterPath = path.join(__dirname, '../cache/posters', movie.posterPath);
            if (fs.existsSync(oldPosterPath)) {
                try { fs.unlinkSync(oldPosterPath); } catch (e) { }
            }
        }
        if (movie.localPosterPath) {
            const oldLocalPath = path.join(__dirname, '../', movie.localPosterPath);
            if (fs.existsSync(oldLocalPath)) {
                try { fs.unlinkSync(oldLocalPath); } catch (e) { }
            }
        }

        // 本应用自己缓存里的图（例如「截帧」候选）直接复制，不走网络
        const localMatch = /^\/api\/movie\/poster\/([^?]+)/.exec(posterUrl);
        const localSrc = localMatch
            ? path.join(__dirname, '../cache/posters', path.basename(decodeURIComponent(localMatch[1])))
            : null;
        if (localSrc && fs.existsSync(localSrc)) {
            fs.copyFileSync(localSrc, posterSavePath);
        } else {
            // 下载新海报
            await downloadPoster(posterUrl, posterSavePath);
        }

        // 更新数据库（同时更新两个字段）
        const updatePoster = db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?');
        updatePoster.run(posterFileName, 'cache/posters/' + posterFileName, movie.id);

        // 同步更新本地封面图（保存到影片目录）
        try {
            const config = require('../utils/config');
            const videoDir = path.dirname(movie.filePath);
            const posterNames = config.export?.posterNames || ['poster.jpg', 'folder.jpg'];

            for (const name of posterNames) {
                const destPath = path.join(videoDir, name);
                try {
                    fs.copyFileSync(posterSavePath, destPath);
                } catch (e) { }
            }

            // 同时复制同名封面
            const stem = path.basename(movie.filePath, path.extname(movie.filePath));
            const sameNamePath = path.join(videoDir, `${stem}.jpg`);
            try {
                fs.copyFileSync(posterSavePath, sameNamePath);
            } catch (e) { }
        } catch (e) {
            console.log(`  本地封面同步失败: ${e.message}`);
        }

        res.json({
            code: 0,
            msg: '海报更换成功',
            data: {
                posterPath: posterFileName,
                timestamp: timestamp
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 删除海报
router.post('/:id/delete-poster', async (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        // 删除缓存目录里的海报文件
        if (movie.posterPath) {
            const cachePosterPath = path.join(__dirname, '../cache/posters', movie.posterPath);
            if (fs.existsSync(cachePosterPath)) {
                try { fs.unlinkSync(cachePosterPath); } catch (e) { }
            }
        }

        // 删除本地海报文件
        if (movie.localPosterPath) {
            const posterPath = path.join(__dirname, '../', movie.localPosterPath);
            if (fs.existsSync(posterPath)) {
                try { fs.unlinkSync(posterPath); } catch (e) { }
            }
        }

        // 清空数据库中的海报字段
        const updateStmt = db.prepare('UPDATE movies SET posterPath = NULL, localPosterPath = NULL WHERE id = ?');
        updateStmt.run(req.params.id);

        res.json({ code: 0, msg: '海报已删除' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 清空所有海报
router.post('/clear-all-posters', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');

        // 清空数据库
        const updateStmt = db.prepare('UPDATE movies SET posterPath = NULL, localPosterPath = NULL');
        updateStmt.run();

        // 删除缓存目录所有文件
        const cacheDir = path.join(__dirname, '../cache/posters');
        if (fs.existsSync(cacheDir)) {
            const files = fs.readdirSync(cacheDir);
            for (const file of files) {
                try { fs.unlinkSync(path.join(cacheDir, file)); } catch (e) { }
            }
        }

        res.json({ code: 0, msg: '所有海报已清空' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 批量更换海报状态
let batchPosterStatus = {
    running: false,
    total: 0,
    current: 0,
    success: 0,
    failed: 0,
    currentFile: ''
};

// 获取批量更换海报状态
router.get('/batch-poster/status', (req, res) => {
    res.json({ code: 0, data: batchPosterStatus });
});

// 一键更换所有海报【修复：增加事务，参数化，解决no such column报错】
router.post('/batch-poster/start', async (req, res) => {
    try {
        if (batchPosterStatus.running) {
            return res.json({ code: -1, msg: '批量更换正在进行中' });
        }

        const { searchIndex = 0 } = req.body; // 0=第一个, 2=第三个

        // 异步执行
        res.json({ code: 0, msg: '已开始批量更换海报' });

        const { searchAllPosters, downloadPoster, detectTypeByPath } = require('../utils/poster-fetcher');
        const crypto = require('crypto');
        const fs = require('fs');
        const path = require('path');
        const config = require('../utils/config');

        batchPosterStatus = {
            running: true,
            total: 0,
            current: 0,
            success: 0,
            failed: 0,
            currentFile: ''
        };

        // 获取所有有番号的影片
        const movies = db.prepare("SELECT * FROM movies WHERE avid IS NOT NULL AND avid != ''").all();
        batchPosterStatus.total = movies.length;

        console.log(`[批量更换海报] 开始，共 ${movies.length} 部影片，使用第 ${searchIndex + 1} 个搜索结果`);

        // 批量更新预处理stmt，复用，全部参数化，杜绝SQL拼接
        const updatePosterStmt = db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?');

        for (let i = 0; i < movies.length; i++) {
            const movie = movies[i];
            batchPosterStatus.current = i + 1;
            batchPosterStatus.currentFile = movie.avid || movie.fileName;

            try {
                // 根据文件路径判断资源类型，确保使用正确的刮削源
                const detectedType = detectTypeByPath(movie.filePath);
                const finalType = movie.type || detectedType;
                
                // 搜索海报
                const posters = await searchAllPosters(movie.avid, movie.cleanName, movie.fileName, finalType, movie.filePath);

                if (posters && posters.length > searchIndex) {
                    const posterUrl = posters[searchIndex].url;

                    // 生成新的海报文件名
                    const timestamp = Date.now();
                    const fileHash = crypto.createHash('md5').update(movie.filePath + timestamp).digest('hex');
                    const posterFileName = fileHash + '.jpg';
                    const posterSavePath = path.join(__dirname, '../cache/posters', posterFileName);

                    // 下载新海报
                    await downloadPoster(posterUrl, posterSavePath);

                    // 参数化更新数据库，完全避免字符串拼接空值报错
                    updatePosterStmt.run(posterFileName, 'cache/posters/' + posterFileName, movie.id);

                    // 同步更新本地封面图
                    try {
                        const videoDir = path.dirname(movie.filePath);
                        const posterNames = config.export?.posterNames || ['poster.jpg', 'folder.jpg'];

                        for (const name of posterNames) {
                            const destPath = path.join(videoDir, name);
                            try {
                                fs.copyFileSync(posterSavePath, destPath);
                            } catch (e) { }
                        }

                        // 同时复制同名封面
                        const stem = path.basename(movie.filePath, path.extname(movie.filePath));
                        const sameNamePath = path.join(videoDir, `${stem}.jpg`);
                        try {
                            fs.copyFileSync(posterSavePath, sameNamePath);
                        } catch (e) { }
                    } catch (e) {
                        console.log(`  本地封面同步失败: ${e.message}`);
                    }

                    batchPosterStatus.success++;
                } else {
                    batchPosterStatus.failed++;
                }
            } catch (e) {
                batchPosterStatus.failed++;
                console.log(`[批量更换海报] 失败 ${movie.avid}: ${e.message}`);
            }

            // 限流
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        batchPosterStatus.running = false;
        console.log(`[批量更换海报] 完成！成功 ${batchPosterStatus.success}，失败 ${batchPosterStatus.failed}`);

    } catch (e) {
        batchPosterStatus.running = false;
        console.log('[批量更换海报] 异常:', e.message);
    }
});

// 海报代理访问（hash 参数只允许安全字符，防止 ../ 目录穿越）
router.get('/poster/:hash', (req, res) => {
    const hash = req.params.hash;
    if (!/^[\w.-]+$/.test(hash)) {
        return res.status(400).end();
    }
    const posterPath = path.join(__dirname, '../cache/posters', hash);
    if (fs.existsSync(posterPath)) {
        res.sendFile(posterPath);
    } else {
        res.status(404).end();
    }
});

// 重命名文件
// ==========修改后路由完整片段==========
router.post('/:id/rename', async (req, res) => {
    try {
        const { newName } = req.body;
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });
        if (!newName) return res.json({ code: -1, msg: '新名称不能为空' });

        const oldPath = movie.filePath;
        const dir = path.dirname(oldPath);
        const ext = path.extname(movie.fileName);
        const oldStem = path.basename(movie.fileName, ext);
        const realNewFileName = newName + ext;
        const newPath = path.join(dir, realNewFileName);

        if (oldPath === newPath) {
            return res.json({ code: 0, msg: '名称未改变' });
        }
        // 数据库路径可能已过时（文件被外部改名/移动）。给出真正原因，
        // 而不是抛 ENOENT 让用户误以为"原文件名被别人改过了"。
        if (!fs.existsSync(oldPath)) {
            return res.json({
                code: -1,
                msg: `原文件已不存在：${movie.fileName}（可能已被重命名或移动，请先执行一次扫描）`
            });
        }
        if (fs.existsSync(newPath)) {
            return res.json({ code: -1, msg: '目标文件已存在' });
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

        //=====重点：同步更新 cleanName！=====
        const { cleanMovieName } = require('../utils/poster-fetcher');
        const newCleanName = cleanMovieName(realNewFileName);

        withFtsHeal(() => db.prepare(`
      UPDATE movies 
      SET filePath = ?, fileName = ?, cleanName = ?
      WHERE id = ?
    `).run(newPath, realNewFileName, newCleanName, req.params.id), '重命名');

        /* ★ round26 #2：标题更新策略
         *   ① 前端明确勾选「同时更新显示标题」→ 无条件跟随新文件名；
         *   ② 没传该参数（旧前端 / 其它调用方）→ 保留原保守逻辑：
         *      只有当标题本来就是从文件名推出来的（空 / 等于旧 stem / 等于 cleanName）才跟随。
         *   原来只有 ②，于是「已经刮到片名」的记录改完名字后，列表上标题纹丝不动，
         *   用户以为重命名没生效。 */
        let titleUpdated = false;
        const wantSync = req.body && req.body.updateTitle;
        const derivedFromName = !movie.title || movie.title === oldStem || movie.title === movie.cleanName;
        if (wantSync === true || (wantSync === undefined && derivedFromName)) {
            withFtsHeal(() => db.prepare('UPDATE movies SET title = ? WHERE id = ?').run(newName, req.params.id), '重命名同步标题');
            titleUpdated = true;
        }

        return res.json({
            code: 0,
            msg: '重命名成功',
            data: {
                fileName: realNewFileName,
                newName,
                titleUpdated,
                oldTitle: movie.title || '',
                hostPath: toHostPath(newPath)
            }
        });
    } catch (e) {
        return res.json({ code: -1, msg: e.message });
    }
});

// 删除文件（从磁盘删除）
router.delete('/:id', (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });

        const filePath = movie.filePath;
        const ext = path.extname(filePath);

        // 删除视频文件
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // 删除 NFO 文件
        const nfoPath = filePath.replace(ext, '.nfo');
        if (fs.existsSync(nfoPath)) {
            fs.unlinkSync(nfoPath);
        }

        // 删除封面文件
        const posterPath = filePath.replace(ext, '.jpg');
        if (fs.existsSync(posterPath)) {
            fs.unlinkSync(posterPath);
        }

        // 删除数据库记录
        deleteMovieByPath.run(filePath);

        res.json({ code: 0, msg: '删除成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 给影片添加标签
router.post('/:id/add-tag', (req, res) => {
    try {
        const { tagName } = req.body;
        const movieId = req.params.id;

        if (!tagName) return res.json({ code: -1, msg: '标签名不能为空' });

        // 查找或创建标签
        let tag = getTagByName.get(tagName);
        if (!tag) {
            const result = upsertTag.run(tagName);
            tag = { id: result.lastInsertRowid, name: tagName };
        }

        // 添加关联
        addMovieTag.run(movieId, tag.id);

        // 更新标签计数
        db.prepare('UPDATE tags SET movieCount = (SELECT COUNT(*) FROM movie_tag WHERE tagId = ?) WHERE id = ?')
            .run(tag.id, tag.id);

        res.json({ code: 0, msg: '标签添加成功', data: tag });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 移除影片标签
router.post('/:id/remove-tag', (req, res) => {
    try {
        const { tagId } = req.body;
        const movieId = req.params.id;

        db.prepare('DELETE FROM movie_tag WHERE movieId = ? AND tagId = ?').run(movieId, tagId);

        // 更新标签计数
        db.prepare('UPDATE tags SET movieCount = (SELECT COUNT(*) FROM movie_tag WHERE tagId = ?) WHERE id = ?')
            .run(tagId, tagId);

        res.json({ code: 0, msg: '标签已移除' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;