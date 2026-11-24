/**
 * cover-fallback.js —— 漫画 / 小说封面兜底（2026-09-22 新增）
 *
 * 背景：本库 178 部漫画（全是 PDF）+ 5 部小说（全是 EPUB）的 posterPath 全为空，
 *      在线搜封面（kmoe / zlibrary）经常搜不到 → 前端一片白框。
 *
 * 取封面顺序（前一步失败才走下一步）：
 *   1. 在线搜（漫画 → kmoe，小说 → zlibrary），命中就下载换上
 *   2. 内容截图兜底：
 *        · 漫画 PDF  → 用 pdf.js 在 Chromium 里把第 1 页渲成 JPEG
 *        · 小说 EPUB → 从 zip 里取封面图（文件名含 cover → opf cover meta → 最大的图）
 *   3. 都没有 → 返回 null，前端显示占位
 *
 * 落盘：cache/posters/<md5('content-cover:'+filePath)>.jpg
 *      确定性命名 → 同一部片反复跑不会堆垃圾，也能直接判断"已经生成过"。
 *
 * ── 为什么 PDF 非借浏览器不可 ──────────────────────────────────
 * 容器里没有 poppler(pdftoppm/mutool)、没有 ghostscript（ImageMagick 的 convert
 * 转 PDF 也依赖它）；pdfjs-dist 在 Node 端渲染需要 canvas 实现（未安装）。
 * 而 Playwright 自带的完整 Chromium 就在 /ms-playwright 下，pdf.js 浏览器版可以直接用。
 *
 * ── 为什么用 page.route 而不是起静态服务 ──────────────────────
 * 全部请求都打在虚拟源 http://cover.local/ 上并被 route 拦下：
 *   · 不用改 server.js 加 node_modules 的静态挂载（改了还得重启容器）
 *   · 不用把 PDF 读成 base64 再塞进 evaluate（大文件会很慢甚至爆内存）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listImageEntries, listZipEntries, readZipEntry } = require('./zip-entry');

const ROOT = path.join(__dirname, '..');
const POSTER_DIR = path.join(ROOT, 'cache', 'posters');
const PDFJS_DIR = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build');
// Playwright 官方镜像里完整 Chromium 的位置（headless_shell 不能渲染 PDF）
const FULL_CHROMIUM = '/ms-playwright/chromium-1234/chrome-linux64/chrome';
const COVER_HOST = 'http://cover.local';

/* ---------------- 命名 / 落盘 ---------------- */

function contentCoverName(filePath) {
    return crypto.createHash('md5').update('content-cover:' + filePath).digest('hex') + '.jpg';
}

function ensurePosterDir() {
    if (!fs.existsSync(POSTER_DIR)) fs.mkdirSync(POSTER_DIR, { recursive: true });
}

/**
 * 保存封面图并回写 DB。
 * ⚠️ movies 表的 UPDATE 会被 movies_fts_update 触发器管到，但该触发器带 WHEN，
 *    只在被索引列（title/cleanName/overview）变化时才重建索引；posterPath 不在其列 → 安全。
 */
function saveCover(db, movie, buffer, fileName) {
    ensurePosterDir();
    const abs = path.join(POSTER_DIR, fileName);
    fs.writeFileSync(abs, buffer);
    /* ⚠️ localPosterPath 必须存**相对形式** cache/posters/<name>：
       routes/movie.js 的删封面 / 修封面走 path.join(__dirname, '../', movie.localPosterPath)，
       存绝对路径会拼出乱路径（round24 归一化过 1892 条，别再写回绝对形式）。 */
    const rel = 'cache/posters/' + fileName;
    db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?')
        .run(fileName, rel, movie.id);
    return { posterPath: fileName, localPosterPath: rel };
}

/* ---------------- Chromium 生命周期（懒加载 + 空闲自动关） ---------------- */

let _browser = null;
let _launching = null;
let _idleTimer = null;

async function getBrowser() {
    if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
    if (_launching) return _launching;

    _launching = (async () => {
        const { chromium } = require('playwright');
        const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
        if (fs.existsSync(FULL_CHROMIUM)) opts.executablePath = FULL_CHROMIUM;
        const b = await chromium.launch(opts);
        b.on('disconnected', () => { if (_browser === b) _browser = null; });
        _browser = b;
        _launching = null;
        return b;
    })();

    try { return await _launching; } catch (e) { _launching = null; throw e; }
}

function touchIdle(ms = 120000) {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => closeBrowser().catch(() => { }), ms);
    if (_idleTimer.unref) _idleTimer.unref();
}

async function closeBrowser() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    const b = _browser;
    _browser = null;
    if (b) { try { await b.close(); } catch (e) { /* 忽略 */ } }
}

/* ---------------- PDF 第 1 页 → JPEG ---------------- */

const RENDER_HTML = '<!doctype html><meta charset="utf-8">' +
    '<title>cover-render</title>' +
    '<style>html,body{margin:0;padding:0;background:#fff}canvas{display:block}</style>' +
    '<canvas id="c"></canvas>';

/**
 * 渲染 PDF 的某一页 → JPEG Buffer
 * @param {string} pdfPath
 * @param {{maxWidth?:number, quality?:number, page?:number}} opts
 *        page 从 1 开始；超出范围会自动夹到 [1, numPages]。
 *        （round25：选封面时要给出「前 4 页」候选，所以必须支持指定页。）
 *
 * ★ round112：PDF 本体改为**分段喂给 pdf.js**（支持 HTTP Range），不再整本读进内存。
 *   旧实现 `fs.readFileSync(pdfPath)` 一次性把整本塞给 Chromium：
 *     · 库里 531 本缺封面 PDF 有 119 本超过 120MB（最大 561MB）→ 只能整本拒绝；
 *     · 常态下每渲染一张也要几百 MB 外部内存，两路并发直接 OOM（见 enrich-covers 注释）。
 *   现在按请求头 `Range` 只读它要的那一段（pdf.js 默认 rangeChunkSize=64KB，
 *   只为首页取 xref/对象），单本内存从「整本」降到「几十 KB ~ 几 MB」。
 *   若浏览器没发 Range（pdf.js 在探测阶段可能先发一次整包 GET），才退回整读，
 *   并且仅在体积 <= PDF_FULL_READ_MAX 时才允许，避免又回到 OOM 老路。
 */
const PDF_FULL_READ_MAX = 150 * 1024 * 1024;

async function renderPdfFirstPage(pdfPath, { maxWidth = 900, quality = 0.86, page: pageNo = 1 } = {}) {
    if (!fs.existsSync(pdfPath)) throw new Error('文件不存在: ' + pdfPath);
    const st0 = fs.statSync(pdfPath);
    const size = st0.size;
    // 2GB 以上属于「扫描件合订本」，首页渲染也没意义（渲染出来全是空白页）
    if (size > 2048 * 1024 * 1024) throw new Error('PDF 过大（' + Math.round(size / 1073741824) + 'GB），跳过');

    const browser = await getBrowser();
    touchIdle();

    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 } });
    const page = await ctx.newPage();
    let fd = null;
    try {
        fd = fs.openSync(pdfPath, 'r');
        const fdRef = fd;
        const readSlice = (start, len) => {
            const buf = Buffer.allocUnsafe(len);
            const n = fs.readSync(fdRef, buf, 0, len, start);
            return n === len ? buf : buf.subarray(0, n);
        };

        // 全部请求打在虚拟源上，自己喂：HTML / pdf.js / PDF 本体
        await page.route(COVER_HOST + '/**', (route) => {
            const u = new URL(route.request().url());
            const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
            try {
                if (name === 'render.html') {
                    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: RENDER_HTML });
                }
                if (name === 'target.pdf') {
                    const range = route.request().headers()['range'];
                    if (process.env.CV_COVER_DEBUG) {
                        console.log('[pdf-range] req range=' + JSON.stringify(range || null) + ' size=' + size);
                    }
                    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
                    if (m) {
                        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
                        let end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
                        if (!Number.isFinite(start) || start < 0) start = 0;
                        if (!Number.isFinite(end) || end >= size) end = size - 1;
                        if (start > end) {
                            return route.fulfill({ status: 416, headers: { 'Content-Range': 'bytes */' + size }, body: '' });
                        }
                        return route.fulfill({
                            status: 206,
                            headers: {
                                'Content-Type': 'application/pdf',
                                'Accept-Ranges': 'bytes',
                                'Content-Range': `bytes ${start}-${end}/${size}`,
                                'Content-Length': String(end - start + 1)
                            },
                            body: readSlice(start, end - start + 1)
                        });
                    }
                    // 无 Range 的那一次：pdf.js 的探测请求（PDFFetchStreamReader 构造函数里固定发不带
                    // Range 的 GET，靠响应头 Accept-Ranges + Content-Length 判断是否支持分段）。
                    // ⚠️ Content-Length 必须报**完整长度**：pdf.js 有 `if (length <= 2*rangeChunkSize)
                    //    return`（视为小文件不值当分段），报 64KB 会被判成「不支持 Range」，
                    //    然后它把这段 64KB 当成整本 PDF → InvalidPDFException。
                    // 它拿到响应头就会 cancel 这条流（disableStream 分支），所以正文只喂头部一段，
                    // 既让探测通过，又不把整本读进内存。
                    const headLen = Math.min(size, 65536);
                    return route.fulfill({
                        status: 200,
                        headers: {
                            'Content-Type': 'application/pdf',
                            'Accept-Ranges': 'bytes',
                            'Content-Length': String(size)
                        },
                        body: readSlice(0, headLen)
                    });
                }
                if (/^pdf(\.worker)?(\.min)?\.mjs$/.test(name)) {
                    const p = path.join(PDFJS_DIR, name);
                    if (fs.existsSync(p)) {
                        return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(p) });
                    }
                }
                return route.fulfill({ status: 404, body: '' });
            } catch (e) {
                return route.fulfill({ status: 500, body: '' });
            }
        });

        await page.goto(COVER_HOST + '/render.html', { waitUntil: 'domcontentloaded', timeout: 20000 });

        const dataUrl = await page.evaluate(async (opts) => {
            const pdfjs = await import('/pdf.min.mjs');
            pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
            // ⚠️ pdf.js v4+ 不再接受裸 URL 字符串（会抛 "expected either data, range, or url"）
            // ★ round112：**必须显式给 rangeChunkSize**，否则 pdf.js 内部把 disableRange 置真
            //   （见 pdf.mjs: `if (!rangeChunkSize && !disableRange) disableRange = true`），
            //   于是整本 PDF 一次性 GET 下来 —— 大文件既慢又吃内存，正是我们要避免的。
            //   给了之后它只按 64KB 分段取首页要用的对象（xref / page1 / 字体）。
            const doc = await pdfjs.getDocument({
                url: '/target.pdf',
                rangeChunkSize: 65536,
                disableAutoFetch: true,     // 只取首页范围内的分块，不预取后半本
                disableStream: true      // 关掉流式：pdf.js 拿到头就 cancel，全面改走 Range 分段
            }).promise;
            // 页号夹到合法范围（1-based）
            const want = Math.min(Math.max(1, opts.page || 1), doc.numPages);
            const target = await doc.getPage(want);
            const base = target.getViewport({ scale: 1 });
            const scale = Math.min(opts.maxWidth / base.width, 3);
            const vp = target.getViewport({ scale });
            const cv = document.getElementById('c');
            cv.width = Math.round(vp.width);
            cv.height = Math.round(vp.height);
            const g = cv.getContext('2d');
            g.fillStyle = '#fff';
            g.fillRect(0, 0, cv.width, cv.height);
            await target.render({ canvasContext: g, viewport: vp }).promise;
            return cv.toDataURL('image/jpeg', opts.quality);
        }, { maxWidth, quality, page: pageNo });

        const m = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl || '');
        if (!m) throw new Error('渲染结果为空');
        const buf = Buffer.from(m[1], 'base64');
        if (buf.length < 2048) throw new Error('渲染结果过小（' + buf.length + 'B）');
        return buf;
    } finally {
        await ctx.close().catch(() => { });
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } }
    }
}

/* ---------------- EPUB 封面 ---------------- */

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

/* ★ round112 换引擎（原 AdmZip）：
 *   旧实现 `new AdmZip(p)` 会把整包读成 Buffer，再对候选图逐个 `getData()` 同步解压；
 *   一本 320MB 的合集 epub 就要 10~15 秒，且全程占着主线程 ⇒ 后端接口跟着超时。
 *   新实现只读中央目录（自带解压后大小，不解压即可排序）+ 只解压命中的那一条，
 *   实测同一批文件从 15459ms → 数十毫秒。见 utils/zip-entry.js 顶部注释。 */
function extractEpubCover(epubPath) {
    if (!fs.existsSync(epubPath)) throw new Error('文件不存在: ' + epubPath);
    const imgs = listImageEntries(epubPath);
    if (!imgs.length) throw new Error('epub 内没有图片');

    // 太小的多半是图标/分隔线；读不出来就换下一个候选，不再因为一张坏图整本失败
    const readImg = (e, minBytes) => {
        let d;
        try { d = readZipEntry(epubPath, e); } catch (x) { return null; }
        if (!d || d.length < (minBytes || 8192)) return null;
        return d;
    };

    // ① 文件名里带 cover 的图（最常见）——同一批里取最大的，避免命中缩略图；
    //    但要排掉封底/书脊（back/spine/封底），否则「取最大」会把封底当封面
    const byName = imgs
        .filter(e => /cover|封面/i.test(e.name) && !/back|spine|封底|书脊/i.test(e.name))
        .sort((a, b) => b.size - a.size);
    for (const e of byName) { const d = readImg(e); if (d) return d; }

    // ② opf 的 cover meta → manifest href
    const entries = listZipEntries(epubPath);
    const opf = entries.find(e => /\.opf$/i.test(e.name));
    if (opf) {
        let xml = '';
        try { xml = readZipEntry(epubPath, opf, { maxBytes: 8 * 1024 * 1024 }).toString('utf8'); } catch (x) { xml = ''; }
        const base = path.posix.dirname(opf.name);
        const meta = xml && /<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i.exec(xml);
        if (meta) {
            const id = meta[1];
            const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const href =
                (new RegExp('id=["\']' + esc + '["\'][^>]*href=["\']([^"\']+)["\']', 'i').exec(xml) || [])[1] ||
                (new RegExp('href=["\']([^"\']+)["\'][^>]*id=["\']' + esc + '["\']', 'i').exec(xml) || [])[1];
            if (href) {
                const want = decodeURIComponent(href).split('#')[0];
                const full = path.posix.normalize(path.posix.join(base, want));
                const hit = imgs.find(e => e.name === full) ||
                    imgs.find(e => e.name === want) ||
                    imgs.find(e => path.posix.basename(e.name) === path.posix.basename(want));
                if (hit) { const d = readImg(hit); if (d) return d; }
            }
        }
    }

    // ③ 兜底：最大的那张图（中央目录里就有 size，排序零成本，不解压）
    const sorted = imgs.slice().sort((a, b) => b.size - a.size);
    for (const e of sorted) { const d = readImg(e); if (d) return d; }
    // ④ 实在都不够大，就取第一张（放宽容差：宁可有封面也不留白框）
    return readZipEntry(epubPath, imgs[0]);
}

/* ---------------- ZIP / CBZ 首图（round112） ----------------
 * cbz 就是一个装图片的 zip，扫描时它和 pdf/epub 一样是「一个文件一部漫画」，
 * 旧实现直接抛「压缩包漫画暂未支持内容截图」→ 库里的 cbz 永远是白框。
 * 这里按文件名排序取第一张够大的图（跳过 __MACOSX / 图标 / 广告条）。 */
function extractZipFirstImage(zipPath) {
    if (!fs.existsSync(zipPath)) throw new Error('文件不存在: ' + zipPath);
    const imgs = listImageEntries(zipPath)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    if (!imgs.length) throw new Error('压缩包内没有图片');
    for (const e of imgs) {
        try {
            const d = readZipEntry(zipPath, e);
            if (d && d.length >= 8192) return d;
        } catch (x) { /* 单张读不出来（比如超出体积上限）就下一张 */ }
    }
    return readZipEntry(zipPath, imgs[0]);
}

/* ---------------- 统一入口 ---------------- */

/* ★ 2026-09-25 round27：视频也要能「内容页兜底」。
 * 原实现只认 .pdf / .epub，视频一律 `不支持的文件类型: .mp4`
 * ⇒ 「一键自动补封面」对动漫/影片 100% 失败（实测 19/19 全败），
 *    用户看到的却是「一个都没补成功」，而按设计「最差也该有抽帧图」。 */
const VIDEO_EXT = [
    '.mp4', '.mkv', '.avi', '.wmv', '.mov', '.m4v', '.ts', '.flv',
    '.webm', '.mpg', '.mpeg', '.rmvb', '.rm', '.vob', '.m2ts'
];

/** 只做「内容截图」，不联网。返回 Buffer 或抛错 */
async function buildContentCover(movie, opts = {}) {
    const p = movie.filePath || '';
    const ext = path.extname(p).toLowerCase();

    // 0. 先确认源文件真的能读 —— 否则后面 ffmpeg 只会吐英文原始错误，用户看不懂
    if (!fs.existsSync(p)) throw new Error('源文件不存在（可能已被移动/删除）');
    let st = null;
    try { st = fs.statSync(p); } catch (e) { throw new Error('无法读取源文件: ' + e.message); }
    if (st.isDirectory()) throw new Error('目录型漫画暂未支持内容截图');
    if (st.size === 0) throw new Error('源文件是 0 字节（下载未完成或已损坏），无法取图');
    if (st.size < 8192) throw new Error('源文件只有 ' + st.size + ' 字节，内容不完整，无法取图');

    if (ext === '.pdf') return { buffer: await renderPdfFirstPage(p), from: 'pdf-page1' };
    if (ext === '.epub') return { buffer: extractEpubCover(p), from: 'epub-cover' };
    if (ext === '.zip' || ext === '.cbz') return { buffer: extractZipFirstImage(p), from: 'zip-page1' };
    // round112：mobi/azw3 的封面就是 PDB 记录里一段未压缩图片，见 utils/mobi-cover.js
    if (ext === '.mobi' || ext === '.azw3') {
        const { extractMobiCover } = require('./mobi-cover');
        return { buffer: extractMobiCover(p), from: 'mobi-cover' };
    }

    if (VIDEO_EXT.includes(ext)) {
        const { captureVideoThumb } = require('./metadata');
        ensurePosterDir();
        const tmp = path.join(POSTER_DIR, 'vframe-' + crypto.createHash('md5').update(p).digest('hex') + '.jpg');
        const dur = Number(movie.duration) || 0;
        // 【2026-09-25 round27】多点位取帧。
        // 旧实现只取一个时间点（配置的 screenshotTime=15s），而片头/广告位常有黑场或纯色，
        // 抽出来是「有效但无意义」的几百字节小图 → 旧代码直接判失败（实测 7 条卡在这）。
        // 现在按顺序试多个点位，取第一个「够大」的；成功路径仍是第 1 个点位就收工，
        // 因此对绝大多数片子没有额外耗时。
        const offsets = [];
        const push = (v) => { const n = Math.max(1, Math.round(v)); if (!offsets.includes(n)) offsets.push(n); };
        push(0);                       // 0 = 用 config.ffmpeg.screenshotTime（默认 15s）
        if (dur > 0) { push(dur * 0.3); push(dur * 0.55); push(dur * 0.8); }
        push(3); push(60); push(300);  // 时长未知（duration=0）时的固定兜底点位
        let lastErr = null, bestBuf = null, bestAt = -1;
        for (const at of offsets) {
            try {
                if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
                await captureVideoThumb(p, tmp, dur, at);
                if (!fs.existsSync(tmp)) continue;
                const b = fs.readFileSync(tmp);
                if (b.length >= 2048) { bestBuf = b; bestAt = at; break; }
                // 过小也别扔：留着当「所有点位都是纯色」时的最后一根稻草
                if (!bestBuf || b.length > bestBuf.length) { bestBuf = b; bestAt = at; }
            } catch (e) {
                lastErr = e;
            }
        }
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
        if (bestBuf && bestBuf.length >= 2048) return { buffer: bestBuf, from: 'video-frame@' + (bestAt || 'default') + 's' };
        // 全部点位都失败 → 文件真的坏了，给可读原因
        if (lastErr) throw new Error('视频抽帧失败（源文件可能未下载完整或已损坏）：' + (lastErr.message || lastErr));
        if (bestBuf) {
            // 每个点位都是纯色/黑场：按「宁可有封面也不留白」的原则采用最大的那张
            return { buffer: bestBuf, from: 'video-frame@' + (bestAt || 'default') + 's(纯色兜底)' };
        }
        throw new Error('视频抽帧未产出文件');
    }

    if (ext === '.cbr' || ext === '.rar') {
        throw new Error('RAR 压缩包漫画暂未支持内容截图（CBZ/ZIP 已支持）');
    }
    throw new Error('不支持的文件类型: ' + ext);
}

/**
 * 在线搜封面（漫画 kmoe / 小说 zlibrary），命中就下载落盘。
 * @returns {Promise<{posterPath, source, title}|null>}
 */
async function trySearchCover(db, movie, log) {
    const { searchAllPosters, downloadPoster } = require('./poster-fetcher');
    const fileName = movie.fileName || path.basename(movie.filePath || '');
    let list = [];
    try {
        list = await searchAllPosters(movie.avid || '', movie.cleanName || '', fileName, movie.type, movie.filePath);
    } catch (e) {
        if (log) log('  搜索异常：' + e.message);
        return null;
    }
    const hit = (list || []).find(x => x && x.url);
    if (!hit) return null;

    ensurePosterDir();
    const fileNameSave = contentCoverName(movie.filePath);
    const savePath = path.join(POSTER_DIR, fileNameSave);
    try {
        await downloadPoster(hit.url, savePath);
    } catch (e) {
        if (log) log('  下载失败：' + e.message);
        return null;
    }
    if (!fs.existsSync(savePath) || fs.statSync(savePath).size < 2048) return null;

    const rel = 'cache/posters/' + fileNameSave;
    db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?')
        .run(fileNameSave, rel, movie.id);
    return { posterPath: fileNameSave, source: hit.source || 'search', title: hit.title || '' };
}

/* ---------------- 扫描流程内联兜底（round26 续） ----------------
 * 背景：comic-scanner / novel-scanner 在网络刮削失败时只打一行日志就过去了，
 *      于是「刮削没搜到」= 库里永久白框，用户只能手动一部部补。
 *      这里提供一个扫描期间可直接 await 的入口：不联网搜，直接取内容页。
 * 限流：PDF 渲染实测约 0.6–0.8s/张，178 部一次补完会把「扫描」拖成两分钟以上，
 *      所以每轮扫描给一个预算；用完就停，下一次扫描继续补（结果是增量、可重复的）。 */

let _inlineBudget = 0;

/** 每轮扫描开始时重置预算；返回本轮可用张数（Infinity = 不限） */
function resetInlineBudget(n = 40) {
    _inlineBudget = (n === Infinity || (Number.isFinite(n) && n >= 0)) ? n : 40;
    return _inlineBudget;
}

function inlineBudgetLeft() { return _inlineBudget; }

/**
 * 给「刚扫进来、还没封面」的记录补一张内容页封面。
 * @param {object} db better-sqlite3 实例
 * @param {string} filePath 用 filePath 反查 id —— upsertMovie 是 INSERT…ON CONFLICT DO UPDATE，
 *        命中已有行时 lastInsertRowid 不代表该行 id，拿它写封面会写错记录。
 * @returns {Promise<{ok:boolean, strategy?:string, posterPath?:string, skipped?:string, error?:string}>}
 */
async function inlineContentCover(db, filePath, log) {
    const say = (s) => { if (typeof log === 'function') log(s); };
    let rec;
    try {
        rec = db.prepare('SELECT id, posterPath FROM movies WHERE filePath = ?').get(filePath);
    } catch (e) {
        return { ok: false, error: e.message };
    }
    if (!rec) return { ok: false, error: '记录不存在' };
    if ((rec.posterPath || '').trim()) return { ok: true, skipped: '已有封面' };
    if (_inlineBudget <= 0) return { ok: true, skipped: '本轮预算用完（下次扫描继续）' };
    _inlineBudget--;
    say('内容页兜底 →');
    return autoCover(db, rec.id, { searchFirst: false, log: say });
}

/**
 * 给一部漫画 / 小说补齐封面。
 * @param {object} db better-sqlite3 实例
 * @param {number} movieId
 * @param {object} opts { searchFirst=true, force=false, log=fn }
 * @returns {Promise<{ok, strategy, posterPath?, error?}>}
 */
async function autoCover(db, movieId, opts = {}) {
    const { searchFirst = true, force = false, log = null } = opts;
    const say = (s) => { if (typeof log === 'function') log(s); };

    const movie = db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId);
    if (!movie) return { ok: false, error: '影片不存在' };

    const existing = (movie.posterPath || '').trim();
    if (existing && !force) {
        return { ok: true, strategy: 'skip', posterPath: existing, msg: '已有封面' };
    }

    /* round37：用户手动设过的封面已锁定 → 自动补封面一律不动。
       要强制覆盖必须显式传 ignoreLock（仅供用户明确点击「换一张」的链路使用）。 */
    if (Number(movie.posterLocked || 0) === 1 && !opts.ignoreLock) {
        return { ok: true, strategy: 'locked', posterPath: existing, msg: '封面已锁定（用户手动设置），跳过' };
    }

    // ① 在线搜
    if (searchFirst) {
        try {
            const r = await trySearchCover(db, movie, say);
            if (r) {
                say('  ✅ 在线搜到封面：' + (r.title || r.source));
                return { ok: true, strategy: 'search', posterPath: r.posterPath };
            }
            say('  在线没搜到，转内容截图');
        } catch (e) {
            say('  在线搜索失败：' + e.message);
        }
    }

    // ② 内容截图
    try {
        const built = await buildContentCover(movie);
        const name = contentCoverName(movie.filePath);
        const saved = saveCover(db, movie, built.buffer, name);
        say('  ✅ 内容截图兜底（' + built.from + '，' + Math.round(built.buffer.length / 1024) + 'KB）');
        return { ok: true, strategy: 'content:' + built.from, posterPath: saved.posterPath };
    } catch (e) {
        say('  ❌ 内容截图也失败：' + e.message);
        return { ok: false, error: e.message };
    }
}

/**
 * 批量补齐。默认只处理缺封面的漫画 + 小说。
 * @returns {Promise<object>} 汇总
 */
async function autoCoverBatch(db, opts = {}) {
    let {
        types = null,             // ★ round27：null = 自动探测「确实缺封面的类型」，不再写死漫画/小说
        limit = 0,
        searchFirst = false,      // 批量默认不联网搜（慢且在其它轮次已试过），只做内容截图
        force = false,
        log = null,
        onProgress = null,
    } = opts;
    const say = (s) => { if (typeof log === 'function') log(s); };

    /* ★ round27：原默认 types=['comic','novel']，而用户库里「缺封面的」其实全是 anime
     *   ⇒ 一键补封面扫完 0 条、一个都不动，用户体感「点了没反应」。
     *   改成按数据库实况自动探测：谁缺封面就补谁。 */
    if (!Array.isArray(types) || !types.length) {
        types = db.prepare(
            `SELECT DISTINCT type FROM movies
              WHERE (posterPath IS NULL OR TRIM(posterPath) = '')
                AND (localPosterPath IS NULL OR TRIM(localPosterPath) = '')
                AND COALESCE(posterLocked, 0) = 0
              ORDER BY type`
        ).all().map(r => r.type);
        if (!types.length) return { total: 0, ok: 0, fail: 0, skipped: 0, results: [], types: [] };
        say(`自动探测到缺封面的类型：${types.join(' / ')}`);
    }

    const marks = types.map(() => '?').join(',');
    let rows = db.prepare(
        `SELECT * FROM movies WHERE type IN (${marks}) AND COALESCE(posterLocked, 0) = 0 ORDER BY id`
    ).all(...types);
    if (!force) rows = rows.filter(m => !(m.posterPath || '').trim());
    if (limit > 0) rows = rows.slice(0, limit);
    if (!rows.length) return { total: 0, ok: 0, fail: 0, skipped: 0, results: [], types };

    say(`共 ${rows.length} 部待补封面`);

    const results = [];
    let ok = 0, fail = 0;
    for (let i = 0; i < rows.length; i++) {
        const m = rows[i];
        say(`[${i + 1}/${rows.length}] #${m.id} ${(m.title || m.fileName || '').slice(0, 42)}`);
        let r;
        try {
            r = await autoCover(db, m.id, { searchFirst, force, log: say });
        } catch (e) {
            r = { ok: false, error: e.message };
        }
        if (r.ok) ok++; else fail++;
        results.push({ id: m.id, title: m.title, fileName: m.fileName, ...r });
        if (typeof onProgress === 'function') onProgress(i + 1, rows.length, m, r);
    }

    // 收尾：把浏览器关掉，别让 Chromium 常驻占内存
    await closeBrowser();

    say(`完成：成功 ${ok} / 失败 ${fail}`);
    return { total: rows.length, ok, fail, results, types };
}

module.exports = {
    contentCoverName,
    saveCover,
    renderPdfFirstPage,
    extractEpubCover,
    extractZipFirstImage,
    buildContentCover,
    trySearchCover,
    autoCover,
    autoCoverBatch,
    resetInlineBudget,
    inlineBudgetLeft,
    inlineContentCover,
    closeBrowser,
};
