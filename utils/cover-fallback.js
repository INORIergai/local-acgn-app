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
const AdmZip = require('adm-zip');

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
    db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?')
        .run(fileName, abs, movie.id);
    return { posterPath: fileName, localPosterPath: abs };
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
 */
async function renderPdfFirstPage(pdfPath, { maxWidth = 900, quality = 0.86, page: pageNo = 1 } = {}) {
    if (!fs.existsSync(pdfPath)) throw new Error('文件不存在: ' + pdfPath);
    const size = fs.statSync(pdfPath).size;
    if (size > 250 * 1024 * 1024) throw new Error('PDF 过大（' + Math.round(size / 1048576) + 'MB），跳过');

    const browser = await getBrowser();
    touchIdle();

    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 } });
    const page = await ctx.newPage();
    try {
        // 全部请求打在虚拟源上，自己喂：HTML / pdf.js / PDF 本体
        await page.route(COVER_HOST + '/**', (route) => {
            const u = new URL(route.request().url());
            const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
            try {
                if (name === 'render.html') {
                    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: RENDER_HTML });
                }
                if (name === 'target.pdf') {
                    return route.fulfill({
                        contentType: 'application/pdf',
                        body: fs.readFileSync(pdfPath),
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
            const doc = await pdfjs.getDocument({ url: '/target.pdf' }).promise;
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
    }
}

/* ---------------- EPUB 封面 ---------------- */

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

function extractEpubCover(epubPath) {
    if (!fs.existsSync(epubPath)) throw new Error('文件不存在: ' + epubPath);
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries();
    const imgs = entries.filter(e => IMG_RE.test(e.entryName) && !e.isDirectory);
    if (!imgs.length) throw new Error('epub 内没有图片');

    const sizeOf = e => { try { return e.header.size || e.getData().length; } catch (x) { return 0; } };
    const pick = e => {
        const d = e.getData();
        if (d.length < 8192) return null;   // 太小的多半是图标/分隔线
        return d;
    };

    // ① 文件名里带 cover 的图（最常见）
    for (const e of imgs) {
        if (/cover|封面/i.test(e.entryName)) {
            const d = pick(e);
            if (d) return d;
        }
    }

    // ② opf 的 cover meta → manifest href
    const opf = entries.find(e => /\.opf$/i.test(e.entryName));
    if (opf) {
        const xml = opf.getData().toString('utf8');
        const base = path.posix.dirname(opf.entryName);
        const meta = /<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["']/i.exec(xml);
        if (meta) {
            const id = meta[1];
            const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const href =
                (new RegExp('id=["\']' + esc + '["\'][^>]*href=["\']([^"\']+)["\']', 'i').exec(xml) || [])[1] ||
                (new RegExp('href=["\']([^"\']+)["\'][^>]*id=["\']' + esc + '["\']', 'i').exec(xml) || [])[1];
            if (href) {
                const want = decodeURIComponent(href).split('#')[0];
                const full = path.posix.normalize(path.posix.join(base, want));
                const hit = imgs.find(e => e.entryName === full) ||
                    imgs.find(e => e.entryName === want) ||
                    imgs.find(e => path.posix.basename(e.entryName) === path.posix.basename(want));
                if (hit) { const d = pick(hit); if (d) return d; }
            }
        }
    }

    // ③ 兜底：最大的那张图（实测本库 1.epub 命中 OEBPS/Images/00.jpg，602KB）
    const sorted = imgs.slice().sort((a, b) => sizeOf(b) - sizeOf(a));
    for (const e of sorted) {
        const d = pick(e);
        if (d) return d;
    }
    // ④ 实在都不够大，就取第一张
    return imgs[0].getData();
}

/* ---------------- 统一入口 ---------------- */

/** 只做「内容截图」，不联网。返回 Buffer 或抛错 */
async function buildContentCover(movie) {
    const p = movie.filePath || '';
    const ext = path.extname(p).toLowerCase();
    if (ext === '.pdf') return { buffer: await renderPdfFirstPage(p), from: 'pdf-page1' };
    if (ext === '.epub') return { buffer: extractEpubCover(p), from: 'epub-cover' };
    if (ext === '.zip' || ext === '.cbz' || ext === '.cbr' || ext === '.rar') {
        throw new Error('压缩包漫画暂未支持内容截图');
    }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        throw new Error('目录型漫画暂未支持内容截图');
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

    db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ? WHERE id = ?')
        .run(fileNameSave, savePath, movie.id);
    return { posterPath: fileNameSave, source: hit.source || 'search', title: hit.title || '' };
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
    const {
        types = ['comic', 'novel'],
        limit = 0,
        searchFirst = false,      // 批量默认不联网搜（慢且在其它轮次已试过），只做内容截图
        force = false,
        log = null,
        onProgress = null,
    } = opts;
    const say = (s) => { if (typeof log === 'function') log(s); };

    const marks = types.map(() => '?').join(',');
    let rows = db.prepare(
        `SELECT * FROM movies WHERE type IN (${marks}) ORDER BY id`
    ).all(...types);
    if (!force) rows = rows.filter(m => !(m.posterPath || '').trim());
    if (limit > 0) rows = rows.slice(0, limit);
    if (!rows.length) return { total: 0, ok: 0, fail: 0, skipped: 0, results: [] };

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
    return { total: rows.length, ok, fail, results };
}

module.exports = {
    contentCoverName,
    saveCover,
    renderPdfFirstPage,
    extractEpubCover,
    buildContentCover,
    trySearchCover,
    autoCover,
    autoCoverBatch,
    closeBrowser,
};
