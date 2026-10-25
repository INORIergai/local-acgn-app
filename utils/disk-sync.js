/**
 * round132 · 编辑落盘同步（disk-sync）
 *
 * 背景（用户报的 bug）：
 *   详情弹窗 → 编辑 → 「刮削并填入」→ 保存，界面上标题变了，但**磁盘文件名没变**，
 *   而且没有任何提示。更糟的是下一次扫描会把标题按文件名重新推导，
 *   用户的手改被冲回去（实测 `_r132-repro.js`：改完是「刮削填入的新标题」，
 *   跑一次 processSingleFile 后变回「TEST 999」，同时那个错标题还被写进了 NFO）。
 *
 * 原则（用户要求）：
 *   应用内针对某个对象做的变更，必须直接反映到原文件上 —— 不是只活在 SQLite 里。
 *
 * 本模块负责把「库里的状态」落回磁盘，共两件事：
 *   ① 改名：视频文件 + 同名 sidecar（.nfo / .jpg / -poster.jpg），并同步库内 filePath/fileName/cleanName
 *   ② 写 NFO：把库里的标题/简介/片商/日期/导演/系列/女优/标签写回 .nfo
 *
 * 安全纪律：
 *   - 只处理视频类（jav / film / cartoon / anime），漫画/小说是目录结构，不在这里动；
 *   - 源文件不存在（NAS 掉线、移动硬盘没插）→ **跳过改名**，如实回报，不假装成功；
 *   - 目标文件已存在 → 不覆盖，回报冲突原因；
 *   - 改名失败（文件被播放器占用等）→ 捕获异常回报，数据库改动保留但不谎称已落盘；
 *   - 只在本目录内改名，绝不移动文件到其他目录。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getMovieById, getMovieActresses, db } = require('./db');

const VIDEO_TYPES = new Set(['jav', 'film', 'cartoon', 'anime']);

// round133：真实文件名里有大量「非标准连字符」（U+2011 不断行连字符最常见，
// 形如 `WAAA‑674`），只认 ASCII `-` 会导致番号前缀认不出来、生成 `WAAA‑674 WAAA‑674 …`
// 这种重复名。统一归一成 ASCII `-`（U+2015 长破折号保留，它在日文标题里是正常标点）。
const DASH_NORM = /[\u2010\u2011\u2012\u2013\u2014\u2212\uFF0D]/g;

function sanitizeStem(s) {
    return String(s == null ? '' : s)
        .replace(DASH_NORM, '-')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 标题开头若自带番号（"MNGS-072 片名"），返回番号正文结束位置 + 其后分隔符结束位置 */
function avidPrefixPos(value, avid) {
    const s = String(value || '');
    const na = String(avid || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s || !na) return null;
    if (s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, na.length) !== na) return null;
    let seen = 0, end = 0;
    for (let i = 0; i < s.length; i++) {
        if (/[A-Z0-9]/i.test(s[i])) { seen++; if (seen === na.length) { end = i + 1; break; } }
    }
    if (!end) return null;
    let after = end;
    while (after < s.length && /[\s\-–—_·|]/.test(s[after])) after++;
    return { end, after };
}

/**
 * 生成「番号 标题」文件名主干，规则与前端 suggestFileNameStem / round47 自动重命名一致。
 * 缺谁都行：有番号没标题 → 只要番号；只有标题 → 只要标题。
 *
 * ★ round133：真实库里有 610 条标题自带 `[番号]` 前缀（形如
 *   `[ABP-367](ABP-367)俺だけの尻コス娘`），旧逻辑只砍「开头裸番号」，
 *   结果生成 `ABP-367 ](ABP-367)俺だけ...` 这种更糟的名字（批量改名预演里
 *   535 条番号重复、446 条括号残片）。这里先在标题里把番号的各种包裹形态剥干净。
 */
function planStem(avidRaw, titleRaw) {
    const avid = sanitizeStem(avidRaw);
    let title = stripAvidNoise(sanitizeStem(titleRaw), avid);
    if (avid && title) {
        const p = avidPrefixPos(title, avid);
        if (p) title = title.slice(p.end).replace(/^[\s\-–—_·|]+/, '').trim();
    }
    const stem = sanitizeStem(avid && title ? (avid + ' ' + title) : (avid || title));
    // 与前端/rename-service 保持同一长度闸（Windows 路径总长保护）
    return stem.slice(0, 180).trim().replace(/[.\s]+$/, '');
}

/**
 * 把标题里「被 []【】()（） 包裹的番号」和「开头的裸番号」全部剥掉。
 * 只在能匹配到该片番号时才动手 —— 绝不误删正常标题内容。
 * 反复剥到稳定，处理 `[ABP-367](ABP-367)标题` 这种多层包裹。
 */
function stripAvidNoise(title, avid) {
    let s = String(title || '').trim();
    const na = String(avid || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s || na.length < 3) return s;
    // 番号宽松匹配：每个字符之间允许 - _ 空格（ABP-367 / ABP 367 / ABP367 都能命中）
    const loose = na.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-_ ]?');
    const wrapped = new RegExp('[\\[【(（]\\s*' + loose + '\\s*[\\]】)）]', 'gi');
    const bareHead = new RegExp('^\\s*' + loose + '[\\s\\-_·|]*', 'i');
    for (let i = 0; i < 5; i++) {
        const before = s;
        s = s.replace(wrapped, ' ').replace(bareHead, ' ').replace(/\s+/g, ' ').trim();
        s = s.replace(/^[\s\-–—_·|]+/, '').trim();
        if (s === before) break;
    }
    return s;
}


function readEditSyncCfg() {
    const c = config.editSync || {};
    return {
        // 总开关：用户没有明确配置时默认开启（这正是用户要求的默认行为）
        enabled: c.syncToDisk !== false,
        renameFile: c.renameFile !== false,
        writeNfo: c.writeNfo !== false
    };
}

/**
 * 把一部影片的库内状态落回磁盘。
 * @param {number|string} id 影片 id
 * @param {Object} opts { renameFile, writeNfo, reason }
 * @returns {{ ok, renamed, oldFileName, newFileName, nfoPath, skipped, error }}
 */
async function syncOneMovie(id, opts = {}) {
    const cfg = Object.assign(readEditSyncCfg(), opts);
    const out = {
        ok: false,
        renamed: false,
        oldFileName: '',
        newFileName: '',
        nfoPath: '',
        skipped: [],
        error: ''
    };

    let movie;
    try {
        movie = getMovieById.get(id);
    } catch (e) {
        out.error = '读取影片失败：' + e.message;
        return out;
    }
    if (!movie) { out.error = '影片不存在'; return out; }

    out.oldFileName = movie.fileName || path.basename(movie.filePath || '');
    out.newFileName = out.oldFileName;

    const type = movie.type || 'jav';
    if (!VIDEO_TYPES.has(type)) {
        out.skipped.push(`类型 ${type} 不是视频文件，磁盘结构不同，跳过落盘`);
        out.ok = true;
        return out;
    }
    if (!movie.filePath) {
        out.error = '这条记录没有文件路径';
        return out;
    }

    const ext = path.extname(movie.filePath);
    const dir = path.dirname(movie.filePath);
    let basePath = movie.filePath;
    let baseStem = path.basename(movie.filePath, ext);

    // ---------- ① 改名 ----------
    if (cfg.renameFile !== false) {
        const stem = planStem(movie.avid, movie.title);
        if (!stem) {
            out.skipped.push('没有番号也没有标题，无法生成文件名');
        } else if (stem === baseStem) {
            // 名字本来就一致，不需要动
        } else if (!fs.existsSync(basePath)) {
            // ★ 这条最重要：源文件不在（NAS 掉线/移动硬盘没插）时绝不能假装改过
            out.skipped.push('原文件当前不在磁盘上（可能 NAS 掉线或外置盘未连接），已跳过改名');
        } else {
            const newPath = path.join(dir, stem + ext);
            if (fs.existsSync(newPath)) {
                out.skipped.push(`目标文件名已存在，未覆盖：${stem + ext}`);
            } else {
                try {
                    fs.renameSync(basePath, newPath);
                    // sidecar 一并改名，否则 NFO / 同名封面会成为孤儿文件
                    for (const suffix of ['.nfo', '.jpg', '-poster.jpg']) {
                        const oldSide = path.join(dir, baseStem + suffix);
                        const newSide = path.join(dir, stem + suffix);
                        try {
                            if (fs.existsSync(oldSide) && !fs.existsSync(newSide)) fs.renameSync(oldSide, newSide);
                        } catch (e) {
                            out.skipped.push(`sidecar ${suffix} 改名失败：${e.message}`);
                        }
                    }
                    basePath = newPath;
                    baseStem = stem;
                    out.renamed = true;
                    out.newFileName = stem + ext;

                    const newFile = stem + ext;
                    const { cleanMovieName } = require('./poster-fetcher');
                    let newClean = baseStem;
                    try { newClean = cleanMovieName(newFile); } catch (e) { /* 清洗失败就用 stem */ }
                    db.prepare('UPDATE movies SET filePath = ?, fileName = ?, cleanName = ? WHERE id = ?')
                        .run(newPath, newFile, newClean, id);
                } catch (e) {
                    const reason = /EPERM|EBUSY|EACCES/i.test(e.message)
                        ? '文件正被其他程序占用（比如播放器还开着）'
                        : e.message;
                    out.error = '改名失败：' + reason;
                }
            }
        }
    } else {
        out.skipped.push('已关闭「改写磁盘文件名」');
    }

    // ---------- ② 写 NFO ----------
    // 用户手工编辑的字段优先级高于旧 NFO，所以这里是无条件重写（不是「只补空」）。
    // ★ 必须确认目标目录/视频确实在线：generateNfo 会 mkdir -p，
    //   如果 NAS 掉线时照写，它会在本地凭空建出一整条不存在的目录树。
    if (cfg.writeNfo !== false && config.export && config.export.enableNfoExport) {
        if (!fs.existsSync(basePath) || !fs.existsSync(dir)) {
            out.skipped.push('视频文件不在磁盘上，已跳过写 NFO');
        } else {
            try {
                let actresses = [];
                try { actresses = (getMovieActresses.all(id) || []).map(a => a.name).filter(Boolean); } catch (e) { }
                let genres = [];
                if (movie.genres) genres = String(movie.genres).split(',').map(s => s.trim()).filter(Boolean);
                if (!genres.length) {
                    try {
                        const rows = db.prepare('SELECT t.name FROM movie_tag mt JOIN tags t ON t.id = mt.tagId WHERE mt.movieId = ?').all(id);
                        genres = rows.map(r => r.name).filter(Boolean);
                    } catch (e) { }
                }
                const { generateNfo } = require('./nfo_utils');
                const nfoPath = path.join(dir, baseStem + '.nfo');
                generateNfo(Object.assign({}, movie, {
                    actresses,
                    genres,
                    // 改名后 filePath 已更新，posterPath 用库内缓存图（scanner 同款口径）
                    posterPath: movie.posterPath || ''
                }), nfoPath);
                out.nfoPath = nfoPath;
            } catch (e) {
                out.skipped.push('写 NFO 失败：' + e.message);
            }
        }
    } else if (cfg.writeNfo !== false) {
        out.skipped.push('设置里关闭了 NFO 导出，未写 NFO');
    }

    out.ok = !out.error;
    return out;
}

/**
 * round133 · 存量文件名对齐专用：算出「最不丢信息」的目标主干。
 *
 * 与 planStem 的区别：planStem 完全以标题为准（编辑保存时用户刚改的就是标题），
 * 而存量数据里 610 条标题自带 `[番号]` 前缀、还有一批标题只剩「电车」这种残句，
 * 直接按标题重建会把原本完整的文件名（`【SONE-099】痴●に堕ちたスレンダーOL…`）砍成
 * `SONE-099 电车`。所以这里取「原文件名正文」与「标题正文」中**更完整**的一个：
 *   · 文件名正文 —— 剥离开头番号包裹后剩下的部分，通常是用户/下载源写的全名；
 *   · 标题正文 —— 剥掉 `[番号]`/`【番号】`/裸番号后的部分。
 * 长度明显更长的那个才算"更完整"（阈值 15% + 8 字，避免仅差几个字就换源）。
 */
function planMigrationTarget(movie) {
    const filePath = movie.filePath || '';
    const ext = path.extname(filePath);
    const stemNow = path.basename(filePath, ext);
    const avid = sanitizeStem(movie.avid);

    // 原名正文：先把各种包裹番号剥掉
    let bodyNow = stripAvidNoise(sanitizeStem(stemNow), avid);
    // 标题正文：
    let bodyTitle = stripAvidNoise(sanitizeStem(movie.title), avid);
    if (bodyTitle && bodyTitle.toUpperCase().replace(/[^A-Z0-9]/g, '') === avid.toUpperCase().replace(/[^A-Z0-9]/g, '')) {
        bodyTitle = '';   // 标题就是番号本身，没有额外信息
    }

    // 多分片标记：从原文件名里认 CD1/CD2/CD1A…（放宽到任意位置），避免同番号两片撞名。
    // ★ 幂等：先把正文里已有的 CD 标记摘掉，再统一追加一次；否则每跑一遍就多一个 CD1A。
    const cdMatch = String(stemNow).match(/(?:^|[^a-z])cd\s?(\d+)([a-z]?)(?![a-z0-9])/i);
    const cdPart = cdMatch ? ' CD' + cdMatch[1].toUpperCase() + (cdMatch[2] ? cdMatch[2].toUpperCase() : '') : '';
    if (cdMatch) {
        // ★ 必须在「选正文」之前摘 —— 先摘再比长度，否则 `OFJE-255CD1A` 的正文会被当成
        //   空串（只剩 CD1A），标题明明有内容却被丢掉，最后退化成 `OFJE-255 CD1A`。
        const stripCd = s => String(s).replace(/[\s\-_]*(?:cd\s?\d+[a-z]?)\s*$/i, '').trim();
        bodyNow = stripCd(bodyNow);
        bodyTitle = stripCd(bodyTitle);
    }

    let body = bodyNow;
    if (bodyTitle.length > bodyNow.length * 1.15 + 8) body = bodyTitle;
    if (!body) body = bodyTitle || bodyNow;

    const base = sanitizeStem(avid && body ? (avid + ' ' + body) : (avid || body));
    const stem = (base + cdPart).slice(0, 180).trim().replace(/[.\s]+$/, '');
    if (!stem) return null;
    return {
        ext,
        stemNow,
        targetStem: stem,
        targetFile: stem + ext,
        changed: stem !== stemNow,
        source: body === bodyTitle && bodyTitle ? 'title' : 'fileName'
    };
}

module.exports = {
    syncOneMovie,
    planStem,
    planMigrationTarget,
    stripAvidNoise,
    sanitizeStem,
    avidPrefixPos,
    VIDEO_TYPES
};
