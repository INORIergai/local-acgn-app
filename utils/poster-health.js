/**
 * round71 · 海报健康度判定（纯本地，零网络，零 npm 依赖）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 在此之前，应用判断「封面健康」的唯一标准是 `posterPath` 字段非空
 * （utils/cover-fallback.js:410 / :481）。于是：
 *   · 库里 1090 张**视频抽帧截图**（420x236 / 800x450 等 16:9 画面）
 *     因为「有值」被当成健康，任何自动补封面都跳过它们；
 *   · 「一键补封面」实际只能处理 30 条 posterPath 为空的记录。
 * 用户只能手动一张张换 —— 而手动换一张就置 posterLocked=1，越换越锁。
 *
 * ── 判据是怎么来的 ────────────────────────────────────────────
 * 实测 runtime 真库 3042 条封面，逐尺寸开图目视核对后得出：
 *   · 官方源封面（DMM pl.jpg / javbus cover / javdb）：
 *       800x538（ratio 1.49）约 170KB，或 567x800 竖版（ratio 0.71）
 *       → 仅差 1~4px 的 800x537/536/539/535/540/534 同样是真封套（267 张）
 *   · 视频抽帧：420x236 / 800x450（ratio 1.78，标准 16:9），多在 40KB 以下
 *
 * ⚠️ 因此判据必须走**几何特征**（比例 / 尺寸 / 体积），
 *    绝不能走「精确尺寸白名单」——白名单会误杀那 267 张仅差几像素的真封套、
 *    24 张 840x566 的 javdb 封套，以及 183 张 900x1460 的漫画封面。
 *
 * ── 为什么自己解析宽高 ────────────────────────────────────────
 * 只为读图片头取宽高，装 sharp/jimp 属于杀鸡用牛刀（且打包体积暴涨）。
 * JPEG 走 SOF 段（height 在前、width 在后 —— 踩过坑，别写反），
 * PNG 走 IHDR，GIF 走逻辑屏幕描述符，WEBP 走 VP8/VP8L/VP8X。
 */

const fs = require('fs');
const path = require('path');

/* 资产根目录：electron 里 __dirname = <runtime>/utils ⇒ ROOT = runtime（正确）。
   从开发树跑 CLI 时要指向真库，否则会拿开发树的旧缓存去判定 —— 与
   scripts/_r37-poster-gc-cli.js 的做法保持一致，支持显式覆盖。 */
const ROOT = process.env.CINEMAVAULT_RUNTIME || path.resolve(__dirname, '..');
const POSTER_DIR = path.join(ROOT, 'cache', 'posters');

/* ---------------- 阈值（集中在这里，方便按实测微调） ---------------- */

const TH = {
    RATIO_VERTICAL_OK: 0.80,   // 比例 ≤ 此值 = 竖版 → 一律视为海报（漫画 900x1460、567x800）
    RATIO_SLEEVE_MIN: 1.38,    // DVD 封套比例下限（800x565 = 1.416）
    RATIO_SLEEVE_MAX: 1.58,    // DVD 封套比例上限（800x534 = 1.498）
    SLEEVE_MIN_WIDTH: 700,     // 官方封套最小宽度（840x566、800x538 都过线）
    SLEEVE_MIN_BYTES: 55 * 1024, // 官方封套最小体积（实测 159~198KB）
    RATIO_SCREENSHOT: 1.60,    // 比例 ≥ 此值 = 16:9 视频画面（420x236=1.78、800x450=1.78）
    MIN_BYTES_OK: 40 * 1024,   // 低于此体积 = 低清小图（420x280 仅 12KB）
    MIN_EDGE: { w: 400, h: 230 },
    // ★ 竖版豁免的最小边长。实测踩到：离线自证里一张 147x200 的极小图，因为
    //   ratio=0.735 命中了「竖版」就被无条件放行成「竖版海报」并真的换进了库。
    //   真实竖版海报最小是 567x800 ⇒ 用最长边 500 兜住缩略图。
    VERTICAL_MIN_EDGE: 500,
    // 漫画 / 小说：封面是内容页或内嵌图，比例天然无规律，用宽松规则
    LOOSE_MIN_WIDTH: 400,
    LOOSE_MIN_BYTES: 8 * 1024,
};

const VIDEO_EXT = [
    '.mp4', '.mkv', '.avi', '.wmv', '.mov', '.m4v', '.ts', '.flv',
    '.webm', '.mpg', '.mpeg', '.rmvb', '.rm', '.vob', '.m2ts'
];

/* ---------------- 图片头解析（返回 {w,h} 或 null） ---------------- */

const SOF_MARKERS = [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
];

/** JPEG：SOF0/SOF2 段结构 = len(2) + precision(1) + height(2) + width(2) */
function jpegSize(buf) {
    if (buf.length < 4) return null;
    let i = 2;
    while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        if (SOF_MARKERS.includes(marker)) {
            const h = buf.readUInt16BE(i + 5);
            const w = buf.readUInt16BE(i + 7);
            if (w > 0 && h > 0) return { w, h };
            return null;
        }
        const segLen = buf.readUInt16BE(i + 2);
        if (segLen < 2) return null;
        i += 2 + segLen;
    }
    return null;
}

function pngSize(buf) {
    if (buf.length < 24) return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return (w > 0 && h > 0) ? { w, h } : null;
}

function gifSize(buf) {
    if (buf.length < 10) return null;
    const w = buf.readUInt16LE(6);
    const h = buf.readUInt16LE(8);
    return (w > 0 && h > 0) ? { w, h } : null;
}

/** WEBP：VP8X 有显式画布尺寸；VP8/VP8L 需按位解析帧头 */
function webpSize(buf) {
    if (buf.length < 30) return null;
    const fmt = buf.slice(12, 16).toString('ascii');
    try {
        if (fmt === 'VP8 ') {
            const w = buf.readUInt16LE(26) & 0x3fff;
            const h = buf.readUInt16LE(28) & 0x3fff;
            return (w > 0 && h > 0) ? { w, h } : null;
        }
        if (fmt === 'VP8L') {
            const b = buf.readUInt32LE(21);
            const w = (b & 0x3fff) + 1;
            const h = ((b >> 14) & 0x3fff) + 1;
            return { w, h };
        }
        if (fmt === 'VP8X') {
            const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
            const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
            return (w > 0 && h > 0) ? { w, h } : null;
        }
    } catch (e) { return null; }
    return null;
}

/** 只读文件头部（最多 64KB）解析尺寸，不做全量解码 */
function imageSize(absPath) {
    let fh;
    try { fh = fs.openSync(absPath, 'r'); } catch (e) { return null; }
    try {
        const head = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fh, head, 0, head.length, 0);
        const buf = head.slice(0, n);
        if (buf.length < 12) return null;
        if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
        if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return pngSize(buf);
        if (buf.slice(0, 3).toString('ascii') === 'GIF') return gifSize(buf);
        if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
            return webpSize(buf);
        }
        return null;
    } catch (e) {
        return null;
    } finally {
        try { fs.closeSync(fh); } catch (e) { /* 忽略 */ }
    }
}

/* ---------------- 路径解析 ---------------- */

/**
 * 从一条影片记录解析出封面文件的绝对路径。
 * posterPath 可能是裸文件名、也可能是完整 URL（历史数据里有）；
 * localPosterPath 可能是 'cache/posters/xxx' 相对形式，也可能是绝对路径。
 */
function resolvePosterPath(movie) {
    const pp = (movie && movie.posterPath) ? String(movie.posterPath).trim() : '';
    const lp = (movie && movie.localPosterPath) ? String(movie.localPosterPath).trim() : '';
    const cands = [];
    if (lp) {
        if (path.isAbsolute(lp)) cands.push(lp);
        cands.push(path.join(ROOT, lp.replace(/\\/g, '/').replace(/^\//, '')));
    }
    if (pp) {
        // 历史脏数据：posterPath 直接存了 http(s) URL，取 basename 兜一下
        const name = /^https?:\/\//i.test(pp) ? path.basename(pp.split('?')[0]) : pp;
        if (path.isAbsolute(name)) cands.push(name);
        cands.push(path.join(POSTER_DIR, path.basename(name)));
        cands.push(path.join(ROOT, pp.replace(/\\/g, '/').replace(/^\//, '')));
    }
    for (const c of cands) {
        try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (e) { /* 继续 */ }
    }
    return null;
}

function isVideoMovie(movie) {
    const ext = path.extname((movie && movie.filePath) || '').toLowerCase();
    return VIDEO_EXT.includes(ext);
}

/* ---------------- 核心判定 ---------------- */

/**
 * 判定一张封面「像不像正常海报」。
 * @param {string} absPath 封面文件绝对路径
 * @param {{type?:string, isVideo?:boolean}} opt
 * @returns {{level:'ok'|'suspect'|'bad'|'missing', score:number, reason:string, w:number, h:number, ratio:number, bytes:number}}
 */
function healthOf(absPath, opt) {
    const o = opt || {};
    const base = { level: 'bad', score: 0, reason: '', w: 0, h: 0, ratio: 0, bytes: 0 };
    if (!absPath) return Object.assign(base, { level: 'missing', reason: '封面文件缺失' });

    let bytes = 0;
    try { bytes = fs.statSync(absPath).size; } catch (e) {
        return Object.assign(base, { level: 'missing', reason: '封面文件缺失' });
    }
    // 实测有一批 800~1000B 的残图（扫到一半断流留下的），原因文案必须归一，
    // 否则体检报告里会出现几十种「封面文件过小（879B）」的单条原因，没法聚合统计。
    if (bytes < 1024) return Object.assign(base, { reason: '封面文件过小或已损坏', bytes });

    const dim = imageSize(absPath);
    if (!dim) return Object.assign(base, { reason: '无法解析图片尺寸', bytes });

    const { w, h } = dim;
    const ratio = h > 0 ? +(w / h).toFixed(3) : 0;
    const info = { w, h, ratio, bytes };

    const ok = (reason, score) => Object.assign(base, info, { level: 'ok', reason, score });
    const bad = (reason, score) => Object.assign(base, info, { level: 'bad', reason, score });

    /* 漫画 / 小说：封面来自内容页或 epub 内嵌图，比例本就无规律，走宽松规则。
       否则 2048x829 的小说封面、900x1460 的漫画封面会被 16:9 判据误杀。
       o.looseMinWidth：调用方可放宽最小宽（如 kmoe 官方封面是 280x400 的
       !cover_l 规格，全局 400px 会把官方图全误杀——只在显式传入时放宽）。 */
    if (o.isVideo === false) {
        const minW = Number(o.looseMinWidth) || TH.LOOSE_MIN_WIDTH;
        if (w >= minW && bytes >= TH.LOOSE_MIN_BYTES) return ok('内容封面', 85);
        return bad('内容封面过小', 20);
    }

    // ① 竖版 —— 海报的标准形态（也保护了 567x800 这类小尺寸竖版）。
    //    ★ 但必须有最小边长：离线自证实测 147x200 的极小图 ratio=0.735 也会命中
    //      「竖版」，无限制就会被当成合格海报真的换进库。
    if (ratio > 0 && ratio <= TH.RATIO_VERTICAL_OK) {
        if (Math.max(w, h) >= TH.VERTICAL_MIN_EDGE) {
            return ok('竖版海报', w >= 700 ? 95 : 88);
        }
        return bad('竖版过小', 12);
    }
    // ② DVD 横版封套 —— 官方源的标准形态（800x538=1.49、840x566=1.48、800x565=1.42）
    if (ratio >= TH.RATIO_SLEEVE_MIN && ratio <= TH.RATIO_SLEEVE_MAX &&
        w >= TH.SLEEVE_MIN_WIDTH && bytes >= TH.SLEEVE_MIN_BYTES) {
        return ok('官方封套', w >= 800 ? 95 : 90);
    }
    // ③ 16:9 及更宽 —— 视频画面的形状，海报不会长这样
    if (ratio >= TH.RATIO_SCREENSHOT) {
        return bad('视频截图(16:9宽幅)', 8);
    }
    // ④ 体积过小 —— 缩略图 / 低清产物（420x280 仅 12KB）
    if (bytes < TH.MIN_BYTES_OK) {
        return bad('低清小图', 12);
    }
    // ⑤ 分辨率过低
    if (w < TH.MIN_EDGE.w || h < TH.MIN_EDGE.h) {
        return bad('分辨率过低', 15);
    }
    // ⑥ 剩下的（如 800x600 = 1.33）不自动换，只报告由人判断
    return Object.assign(base, info, { level: 'suspect', reason: '非标准规格', score: 50 });
}

/** 是否应该被「一键修复」处理 */
function needsRepair(r) {
    return r && r.level === 'bad';
}

/**
 * 给一条影片记录做判定（含路径解析）。
 * @returns 判定结果 + absPath / missing
 */
function judgeMovie(movie, opt) {
    const isVideo = isVideoMovie(movie);
    const abs = resolvePosterPath(movie);
    if (!abs) {
        return {
            level: 'missing', score: 0, reason: '封面文件缺失',
            w: 0, h: 0, ratio: 0, bytes: 0, absPath: null,
            isVideo, hasField: !!((movie && movie.posterPath) || '').trim(),
        };
    }
    const r = healthOf(abs, { isVideo, type: movie && movie.type, looseMinWidth: opt && opt.looseMinWidth });
    r.absPath = abs;
    r.isVideo = isVideo;
    r.hasField = !!((movie && movie.posterPath) || '').trim();
    return r;
}

/* ---------------- 全库体检（只读） ---------------- */

/**
 * @param {object} db better-sqlite3 实例
 * @param {{types?:string[], log?:Function}} opt
 * @returns {Promise<{total, ok, suspect, bad, missing, noField, byType, items}>}
 */
async function auditAll(db, opt) {
    const o = opt || {};
    const say = (s) => { if (typeof o.log === 'function') o.log(s); };

    let sql = 'SELECT id, type, avid, title, fileName, filePath, posterPath, localPosterPath, COALESCE(posterLocked,0) AS locked FROM movies';
    let rows;
    if (Array.isArray(o.types) && o.types.length) {
        const marks = o.types.map(() => '?').join(',');
        rows = db.prepare(sql + ' WHERE type IN (' + marks + ') ORDER BY id').all(...o.types);
    } else {
        rows = db.prepare(sql + ' ORDER BY id').all();
    }

    const items = [];
    const judged = [];   // 全量判定结果（只带 id/level/reason），供调用方批量落库
    const byType = {};
    let ok = 0, suspect = 0, bad = 0, missing = 0, noField = 0;

    for (const m of rows) {
        const r = judgeMovie(m);
        judged.push({ id: m.id, level: r.level, reason: r.reason, score: r.score });
        if (r.level === 'ok') ok++;
        else if (r.level === 'suspect') suspect++;
        else if (r.level === 'missing') missing++;
        else bad++;
        if (!r.hasField) noField++;

        const t = m.type || '?';
        byType[t] = byType[t] || { total: 0, ok: 0, suspect: 0, bad: 0, missing: 0, noField: 0 };
        byType[t].total++;
        byType[t][r.level] = (byType[t][r.level] || 0) + 1;
        if (!r.hasField) byType[t].noField++;

        if (r.level !== 'ok') {
            items.push({
                id: m.id, type: t, avid: m.avid || '', locked: Number(m.locked || 0) === 1,
                title: m.title || m.fileName || '', fileName: m.fileName || '',
                level: r.level, reason: r.reason, score: r.score,
                w: r.w, h: r.h, ratio: r.ratio, bytes: r.bytes,
            });
        }
    }

    const out = { total: rows.length, ok, suspect, bad, missing, noField, byType, items, judged };
    say(`[海报体检] 共 ${rows.length}：健康 ${ok} / 可疑 ${suspect} / 待换 ${bad} / 缺失 ${missing}`);
    return out;
}

/* ---------------- 一键修复（只换判定为 bad 的） ---------------- */

/**
 * 给一条影片换一张「合格」的封面。
 *
 * ★ 核心纪律：新图必须先过 healthOf 判定为 ok 才写入。
 *   宁可保留原来的截图，也不能换上一张更差的图 —— 这正是旧的
 *   「一键批量换海报」（routes/movie.js:1622）不敢用的原因：它无差别全换，
 *   会把已经正常的官方封套也换成更差的。
 *
 * @param {object} db
 * @param {object} movie 影片记录（至少要有 id/type/avid/cleanName/fileName/filePath/posterPath/localPosterPath）
 * @param {{log?:Function, maxCands?:number, minLevel?:string}} opt
 * @returns {Promise<{ok:boolean, strategy:string, posterPath?:string, source?:string, reason?:string, detail?:object}>}
 */
async function repairOne(db, movie, opt) {
    const o = opt || {};
    const say = (s) => { if (typeof o.log === 'function') o.log(s); };
    const maxCands = Number(o.maxCands) || 3;

    const before = judgeMovie(movie, { looseMinWidth: o.looseMinWidth });
    if (before.level !== 'bad' && !o.force) {
        return { ok: true, strategy: 'skip', reason: '当前封面判定为 ' + before.level + '，无需修复' };
    }

    const { searchAllPosters, downloadPoster, detectTypeByPath } = require('./poster-fetcher');
    const crypto = require('crypto');
    const { retirePoster } = require('./poster-gc');

    const finalType = movie.type || detectTypeByPath(movie.filePath);
    const fileName = movie.fileName || path.basename(movie.filePath || '');

    let list = [];
    try {
        list = await searchAllPosters(movie.avid || '', movie.cleanName || '', fileName, finalType, movie.filePath);
    } catch (e) {
        return { ok: false, strategy: 'search-fail', reason: '搜索异常：' + e.message };
    }
    const cands = (list || []).filter(x => x && x.url);
    if (!cands.length) {
        return { ok: false, strategy: 'no-candidate', reason: '三个源均未返回候选' };
    }

    const isVideo = isVideoMovie(movie);
    const tmpDir = path.join(POSTER_DIR, '_health-tmp');
    try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { }

    let best = null;
    const tried = [];
    for (const c of cands.slice(0, maxCands)) {
        const tmp = path.join(tmpDir, `h${movie.id}-${crypto.createHash('md5').update(c.url).digest('hex').slice(0, 10)}.img`);
        try {
            await downloadPoster(c.url, tmp);
            const h = healthOf(tmp, { isVideo, type: finalType, looseMinWidth: o.looseMinWidth });
            tried.push({ source: c.source, level: h.level, reason: h.reason, w: h.w, h: h.h, bytes: h.bytes });
            if (h.level === 'ok' && (!best || h.score > best.h.score)) best = { c, h, tmp };
        } catch (e) {
            tried.push({ source: c.source, level: 'error', reason: String(e.message).slice(0, 50) });
        }
    }

    if (!best) {
        try { for (const f of fs.readdirSync(tmpDir)) if (f.startsWith(`h${movie.id}-`)) fs.unlinkSync(path.join(tmpDir, f)); } catch (e) { }
        return {
            ok: false, strategy: 'no-good-candidate',
            reason: `候选 ${cands.length} 个，无一通过健康判定（宁缺勿错，保留原图）`,
            detail: { tried },
        };
    }

    // force 全量重刮模式：默认现有封面已达标时，新候选必须严格更优才值得换
    //（漫画/小说的内容封面宽松判据都是 85 分，同分即视为不更优，保留原图）。
    // acceptOk：显式要求「官方刮削结果 ≥ 现有即替换」——用于用 kmoe/zlibrary
    // 官方封面换掉内容页兜底图/本地缩略图的场景（用户明确要求全量刮一次时用）。
    if (o.force && before.level === 'ok' && !o.acceptOk && best.h.score <= before.score) {
        try { for (const f of fs.readdirSync(tmpDir)) if (f.startsWith(`h${movie.id}-`)) fs.unlinkSync(path.join(tmpDir, f)); } catch (e) { }
        return { ok: true, strategy: 'keep', reason: `现有封面 ${before.score} 分已达标，最优候选 ${best.h.score} 分不更优，保留原图` };
    }

    // 落盘：文件名沿用 batch-poster 的稳定做法（md5(filePath + 时间戳)），
    // 不覆盖同名 ⇒ 不会把别的记录正在用的图冲掉。
    const outName = crypto.createHash('md5').update((movie.filePath || '') + Date.now()).digest('hex') + '.jpg';
    const outPath = path.join(POSTER_DIR, outName);
    let moved = false;
    try {
        fs.copyFileSync(best.tmp, outPath);
        moved = true;
    } catch (e) {
        return { ok: false, strategy: 'save-fail', reason: '写入失败：' + e.message, detail: { tried } };
    } finally {
        try { for (const f of fs.readdirSync(tmpDir)) if (f.startsWith(`h${movie.id}-`)) fs.unlinkSync(path.join(tmpDir, f)); } catch (e) { }
    }
    if (!moved) return { ok: false, strategy: 'save-fail', reason: '写入失败' };

    const rel = 'cache/posters/' + outName;
    // ⚠️ posterPath 更新会走 movies 表 UPDATE，但该表的 FTS 触发器带 WHEN 只管
    //    title/cleanName/overview，posterPath 不在其列 ⇒ 不会触发索引重建。
    db.prepare('UPDATE movies SET posterPath = ?, localPosterPath = ?, posterHealth = ?, posterHealthReason = ?, posterHealthAt = ? WHERE id = ?')
        .run(outName, rel, best.h.level, best.h.reason, Date.now(), movie.id);

    // 换完立刻回收上一张（引用安全：别人还在用就不删）
    try { retirePoster([movie.posterPath, movie.localPosterPath], outName); } catch (e) { }

    // 封面修好了，顺带清掉这条路径的刮削失败记录（若有），避免失败清单留陈账
    try { if (movie.filePath) db.prepare('DELETE FROM scrape_failures WHERE filePath = ?').run(movie.filePath); } catch (e) { }

    say(`  ✅ #${movie.id} ← ${best.c.source} ${best.h.w}x${best.h.h}（${best.h.reason}）`);
    return {
        ok: true, strategy: 'replaced', posterPath: outName, source: best.c.source,
        reason: best.h.reason,
        detail: { before: { w: before.w, h: before.h, reason: before.reason }, after: best.h, tried },
    };
}

module.exports = {
    TH, ROOT, POSTER_DIR,
    imageSize, resolvePosterPath, isVideoMovie,
    healthOf, judgeMovie, needsRepair, auditAll, repairOne,
};
