/**
 * utils/ingest-ensure.js —— 入库后置自愈流水线（round131）
 * ============================================================================
 * 背景：
 *   用户问「每次新内容入库有没有做 ①信息补全 ②海报刮削匹配 ③信息完整度校验
 *   ④完整打标，不要让用户还要再去确认」。实测真库 2848 条的现状是：
 *     无简介 2590（91%）、无发行日期 1965（69%）、无标签 2342（82%）、
 *     无厂商 1984、海报待修 1477 —— 说明入库只做了"刮到多少算多少"。
 *
 * 本模块把四件事串成一条**入库后立即自动跑**的流水线，用户不需要再点确认：
 *   ①信息补全   只填空字段，绝不覆盖已有值（标题仅在"纯番号"时替换）
 *   ②海报匹配   复用 poster-health.repairOne：搜候选 → 逐张判几何质量 →
 *                只接受 ok 级 → 落库 → 回收旧图。宁缺勿错，保留原图优于此。
 *   ③完整度校验 每次入库都算一遍缺失项，写 posterHealth 三列，可被清单/巡检复用
 *   ④完整打标   有 genres 但没标签行 → 直接建标签（零成本）；
 *                连 genres 都没有 → AI 生成题材标签（有次数上限）
 *
 * 纪律：
 *   · 全部 try/catch 包裹，任何一步失败都不得影响入库本身；
 *   · 串行 + 节流（默认每条间隔 1.5s），避免把刮削源打成封禁；
 *   · 熔断：连续 5 条网络刮削失败就停掉"补全"环节，只做本地校验；
 *   · 尊重 posterLocked（用户手动锁定的封面不自动换），除非显式 includeLocked；
 *   · 开关在 config.ingest：autoEnsure / repairPoster / aiTagging / maxPerRun 等。
 * ============================================================================
 */
'use strict';

const config = require('./config');
const dbModule = require('./db');
const db = dbModule.db;

const posterHealth = require('./poster-health');
const { titleIsCodeOnly } = require('./poster-fetcher');

/* ---------------- 运行状态（供设置页/未来的 AI 工具查询） ---------------- */
const state = {
    queued: 0,
    running: false,
    done: 0,
    filled: 0,
    postersFixed: 0,
    tagged: 0,
    failed: 0,
    lastRunAt: 0,
    lastReport: null,
    consecutiveNetFail: 0
};

const queue = [];
let draining = false;

/* 扫描忙闲闸：大批量扫描期间先攒队列、不并发跑（否则两条网络链路互抢，
   既拖慢扫描又容易被刮削源判定为高频）。scanner 启动时注入检查函数。 */
let isBusy = () => false;
let busySince = 0;
function setBusyChecker(fn) {
    isBusy = (typeof fn === 'function') ? fn : () => false;
}
function busyNow() {
    let busy = false;
    try { busy = !!isBusy(); } catch (e) { busy = false; }
    if (!busy) { busySince = 0; return false; }
    if (!busySince) busySince = Date.now();
    // 兜底：扫描状态卡死超过 15 分钟就不再等，避免自愈永远不跑
    if (Date.now() - busySince > 15 * 60 * 1000) {
        console.log('[入库自愈] 扫描状态超过 15 分钟仍未结束，解除等待继续处理队列');
        busySince = 0;
        return false;
    }
    return true;
}

function getOptions() {
    const c = (config && config.ingest) || {};
    return {
        enabled: c.autoEnsure !== false,
        repairPoster: c.repairPoster !== false,
        aiTagging: c.aiTagging !== false,
        includeLocked: !!c.includeLocked,
        maxPerRun: Math.max(1, Math.min(2000, Number(c.maxPerRun) || 200)),
        delayMs: Math.max(0, Math.min(30000, Number(c.delayMs) || 1500)),
        aiTagBudget: Math.max(0, Math.min(100, Number(c.aiTagBudget) || 20))
    };
}

function getStatus() {
    return Object.assign({}, state, { pending: queue.length, options: getOptions() });
}

/* ---------------- ③ 完整度校验（纯本地、零网络、可单独调用） ---------------- */

/**
 * 判定一条记录的完整度。
 * @param {object} movie movies 表的一行
 * @returns {{level:'ok'|'partial'|'poor', missing:string[], posterLevel:string, posterReason:string}}
 */
function auditMovie(movie) {
    const missing = [];
    if (!movie) return { level: 'poor', missing: ['记录不存在'], posterLevel: 'unknown', posterReason: '' };

    const type = movie.type || 'jav';
    const title = String(movie.title || '').trim();
    const avid = String(movie.avid || '').trim();

    // 标题：空 / 纯番号 / 与番号完全相同 ⇒ 视为缺
    const titleIsJunk = !title || titleIsCodeOnly(title) || (avid && title.toUpperCase() === avid.toUpperCase());
    if (titleIsJunk) missing.push('标题');

    if (!String(movie.overview || '').trim()) missing.push('简介');
    if (!String(movie.releaseDate || '').trim()) missing.push('发行日期');
    if (type === 'jav' && !String(movie.producer || '').trim()) missing.push('厂商');

    // 关联表：标签 / 女优
    let tagN = 0, actN = 0;
    try { tagN = db.prepare('SELECT COUNT(*) c FROM movie_tag WHERE movieId = ?').get(movie.id).c; } catch (e) { }
    try { actN = db.prepare('SELECT COUNT(*) c FROM movie_actress WHERE movieId = ?').get(movie.id).c; } catch (e) { }
    if (!tagN) missing.push('标签');
    if (type === 'jav' && !actN) missing.push('女优');

    // 海报：交给已有的几何体检（截帧/低清/文件缺失都能识别）
    let posterLevel = 'unknown', posterReason = '';
    try {
        const j = posterHealth.judgeMovie(movie);
        posterLevel = j.level;
        posterReason = j.reason || '';
        if (j.level !== 'ok') missing.push('海报(' + (j.reason || j.level) + ')');
    } catch (e) {
        posterReason = '体检异常: ' + e.message;
    }

    const hardMissing = missing.filter(x => !x.startsWith('海报'));
    const level = hardMissing.length === 0 && posterLevel === 'ok'
        ? 'ok'
        : (hardMissing.length >= 3 ? 'poor' : 'partial');

    return { level, missing, posterLevel, posterReason };
}

/* ---------------- ① 信息补全（只填空，不覆盖） ---------------- */

/**
 * 对缺字段的记录补一次网络刮削。只写空字段。
 * @returns {Promise<{ok:boolean, filled:string[], error?:string}>}
 */
async function fillMissingFields(movie) {
    const filled = [];
    let info = null;
    try {
        const { searchMovie } = require('./poster-fetcher');
        const fileName = movie.fileName || '';
        const type = movie.type || 'jav';
        info = await searchMovie(movie.cleanName || fileName, fileName, type, movie.filePath || '');
    } catch (e) {
        return { ok: false, filled, error: e.message };
    }
    if (!info) return { ok: false, filled, error: '所有源未命中' };

    const sets = [];
    const args = [];
    const put = (col, val) => { sets.push(col + ' = ?'); args.push(val); };

    // 标题：仅当现有标题是纯番号/空时才用网络真标题
    const curTitle = String(movie.title || '').trim();
    const netTitle = String(info.title || '').trim();
    if (netTitle && !titleIsCodeOnly(netTitle) && (!curTitle || titleIsCodeOnly(curTitle))) {
        put('title', netTitle); filled.push('标题');
    }
    if (!String(movie.originalTitle || '').trim() && info.original_title) {
        put('originalTitle', info.original_title); filled.push('原名');
    }
    if (!String(movie.overview || '').trim() && String(info.overview || '').trim()) {
        put('overview', info.overview); filled.push('简介');
    }
    if (!String(movie.releaseDate || '').trim() && info.release_date) {
        put('releaseDate', info.release_date); filled.push('发行日期');
    }
    if (!String(movie.producer || '').trim()) {
        const maker = info.maker || (info._extra && info._extra.producer) || '';
        if (maker) { put('producer', maker); filled.push('厂商'); }
    }
    if (!String(movie.serial || '').trim()) {
        const serial = info.serial || (info._extra && info._extra.serial) || '';
        if (serial) { put('serial', serial); filled.push('系列'); }
    }
    if (!String(movie.avid || '').trim()) {
        const avid = (info._extra && info._extra.avid) || '';
        if (avid && movie.fileName && String(movie.fileName).toUpperCase().includes(String(avid).toUpperCase())) {
            put('avid', avid); filled.push('番号');
        }
    }
    // genres：只补空，且只在标签行也为空时才有意义（由打标环节消费）
    if (!String(movie.genres || '').trim()) {
        const g = (info.genres || []).map(x => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
        if (g.length) { put('genres', g.join(',')); filled.push('题材'); }
    }

    if (sets.length) {
        try {
            db.prepare('UPDATE movies SET ' + sets.join(', ') + ' WHERE id = ?').run(...args, movie.id);
        } catch (e) {
            return { ok: false, filled: [], error: '写库失败: ' + e.message };
        }
    }
    // 女优：无关联行时补建
    try {
        const actN = db.prepare('SELECT COUNT(*) c FROM movie_actress WHERE movieId = ?').get(movie.id).c;
        const names = (info._extra && info._extra.actress) || info.actress || [];
        const list = (Array.isArray(names) ? names : []).map(n => (typeof n === 'string' ? n : n && n.name)).filter(Boolean);
        if (!actN && list.length) {
            const { updateMovieRelations } = dbModule;
            const tags = String(movie.genres || '').split(',').filter(Boolean);
            updateMovieRelations(movie.id, { tags, actresses: list.map(name => ({ name })) });
            filled.push('女优');
        }
    } catch (e) {
        // 关系写入失败不算致命
    }

    // ok 语义：网络源打通即成功。"源里没有该字段"不是失败 —— 简介在很多 JAV
    // 源上本来就缺，硬编一段 AI 生成的简介会污染事实字段，宁可留空并记原因。
    return {
        ok: true,
        hit: true,
        filled,
        source: (info && (info.source || info._source)) || '',
        noFieldFromSource: filled.length === 0
    };
}

/* ---------------- ④ 完整打标 ---------------- */

async function ensureTags(movie, opts) {
    const filled = [];
    let tagN = 0;
    try { tagN = db.prepare('SELECT COUNT(*) c FROM movie_tag WHERE movieId = ?').get(movie.id).c; } catch (e) { }
    if (tagN > 0) return { ok: true, filled };

    const genres = String(movie.genres || '').split(',').map(s => s.trim()).filter(Boolean);
    if (genres.length) {
        // 零成本路径：题材字段已有，只是没建成标签行
        try {
            dbModule.updateMovieRelations(movie.id, { tags: genres.slice(0, 8), actresses: [] });
            filled.push('标签(题材直建 ' + Math.min(8, genres.length) + ')');
            return { ok: true, filled };
        } catch (e) {
            return { ok: false, filled, error: e.message };
        }
    }

    // 题材也没有：AI 生成（有预算限制，且必须拿到真标题才有意义）
    if (!opts.aiTagging) return { ok: true, filled };
    if (state.aiTaggedThisRun >= opts.aiTagBudget) return { ok: true, filled, skipped: 'AI 打标已达本轮预算' };
    if (titleIsCodeOnly(movie.title || '')) return { ok: true, filled, skipped: '标题仍是番号，AI 无从打标' };

    try {
        const { generateGenreTagsOnly } = require('./ai-service');
        const tags = await generateGenreTagsOnly(movie);
        if (tags && tags.length) {
            dbModule.updateMovieRelations(movie.id, { tags, actresses: [] });
            state.aiTaggedThisRun++;
            filled.push('标签(AI ' + tags.join('/') + ')');
        }
    } catch (e) {
        return { ok: false, filled, error: e.message };
    }
    return { ok: true, filled };
}

state.aiTaggedThisRun = 0;

/* ---------------- ② 海报匹配（复用 poster-health） ---------------- */

async function ensurePoster(movie, opts) {
    if (!opts.repairPoster) return { ok: true, action: 'skipped(开关关闭)' };
    if (Number(movie.posterLocked || 0) === 1 && !opts.includeLocked) {
        return { ok: true, action: 'skipped(封面已锁定)' };
    }
    let judge;
    try { judge = posterHealth.judgeMovie(movie); } catch (e) { return { ok: false, action: 'judge-error', error: e.message }; }

    // 记录体检结果（即使不修也落库，供清单/巡检使用）
    try {
        db.prepare('UPDATE movies SET posterHealth = ?, posterHealthReason = ?, posterHealthAt = ? WHERE id = ?')
            .run(judge.level, judge.reason || '', Date.now(), movie.id);
    } catch (e) { }

    if (judge.level === 'ok' || judge.level === 'suspect') {
        return { ok: true, action: 'healthy(' + judge.level + ')' };
    }

    try {
        const r = await posterHealth.repairOne(db, movie, { maxCands: 3, force: true });
        return { ok: !!r.ok, action: r.strategy + (r.source ? '/' + r.source : ''), detail: r.reason };
    } catch (e) {
        return { ok: false, action: 'repair-error', error: e.message };
    }
}

/* ---------------- 单条总控 ---------------- */

/**
 * 对一条记录跑完全部四步。
 * @param {number} movieId
 * @param {object} [opts] 覆盖默认开关
 * @returns {Promise<object>} 结构化报告
 */
async function ensureOne(movieId, opts) {
    const o = Object.assign(getOptions(), opts || {});
    const movie = (() => {
        try { return db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId); } catch (e) { return null; }
    })();
    if (!movie) return { movieId, ok: false, error: '记录不存在' };

    const before = auditMovie(movie);
    const report = {
        movieId,
        title: movie.title || movie.fileName || '',
        type: movie.type || 'jav',
        before,
        steps: {},
        filled: [],
        posterFixed: false
    };

    // ① 补全：只在该补的时候才碰网络
    const needFill = before.missing.some(m =>
        ['标题', '简介', '发行日期', '厂商'].includes(m) || m.startsWith('女优'));
    if (needFill && state.consecutiveNetFail < 5) {
        const f = await fillMissingFields(movie);
        report.steps.fill = f;
        report.filled = report.filled.concat(f.filled || []);
        state.consecutiveNetFail = f.ok ? 0 : state.consecutiveNetFail + 1;
    } else {
        report.steps.fill = { ok: true, filled: [], skipped: needFill ? '网络连续失败熔断' : '字段已齐' };
    }

    // 重读（补全可能改了行）
    const mid = (() => { try { return db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId); } catch (e) { return movie; } })();

    // ④ 打标（依赖 ① 补到的 genres）
    const t = await ensureTags(mid, o);
    report.steps.tag = t;
    report.filled = report.filled.concat(t.filled || []);

    // ② 海报（放最后：补全可能改了 avid/title，影响候选检索质量）
    const p = await ensurePoster(mid, o);
    report.steps.poster = p;
    if (p.ok && p.action.indexOf('replaced') === 0) report.posterFixed = true;

    // ③ 复核
    const after = (() => {
        try { return auditMovie(db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId)); } catch (e) { return before; }
    })();
    report.after = after;

    const changed = report.filled.length > 0 || report.posterFixed;
    if (changed) state.filled += report.filled.length;
    if (report.posterFixed) state.postersFixed++;
    if (report.filled.some(x => x.indexOf('标签') === 0)) state.tagged++;

    report.ok = after.level !== 'poor' || !changed;
    return report;
}

/* ---------------- 队列（扫描结束/单条入库后调用） ---------------- */

/**
 * 入队一条记录，异步自愈。绝不阻塞调用方。
 * @param {number} movieId
 * @param {string} [reason] 来源标记（scan / rescrape / manual）
 */
function enqueue(movieId, reason) {
    const o = getOptions();
    if (!o.enabled) return false;
    if (!movieId) return false;
    if (queue.length >= o.maxPerRun) {
        // 队列已满（大批量扫描）：丢弃最老的待办，避免内存膨胀
        queue.shift();
    }
    queue.push({ movieId: Number(movieId), reason: reason || 'scan', at: Date.now() });
    state.queued++;
    drain();
    return true;
}

async function drain() {
    if (draining) return;
    draining = true;
    state.running = true;
    const o = getOptions();
    const startedAt = Date.now();
    let processed = 0;
    const reports = [];

    try {
        while (queue.length && processed < o.maxPerRun) {
            if (busyNow()) break;   // 扫描进行中：留给 finally 里的重排
            const job = queue.shift();
            processed++;
            try {
                const rep = await ensureOne(job.movieId, {});
                state.done++;
                reports.push(rep);
                if (!rep.ok) state.failed++;
                if (rep.filled.length || rep.posterFixed) {
                    console.log('[入库自愈] #' + rep.movieId + ' ' + String(rep.title).slice(0, 26) +
                        ' → ' + (rep.filled.join('/') || '-') + (rep.posterFixed ? ' +海报' : ''));
                }
            } catch (e) {
                state.failed++;
                console.log('[入库自愈失败] #' + job.movieId + ': ' + e.message);
            }
            if (queue.length && o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
        }
    } finally {
        draining = false;
        state.running = false;
        state.lastRunAt = Date.now();
        state.lastReport = {
            processed,
            ms: Date.now() - startedAt,
            filled: reports.reduce((n, r) => n + (r.filled ? r.filled.length : 0), 0),
            posters: reports.filter(r => r.posterFixed).length,
            failed: reports.filter(r => !r.ok).length
        };
        if (processed > 0) {
            console.log('[入库自愈] 本轮 ' + processed + ' 条 / 耗时 ' + state.lastReport.ms + 'ms / 补全 ' +
                state.lastReport.filled + ' 项 / 换海报 ' + state.lastReport.posters + ' 张 / 失败 ' +
                state.lastReport.failed + ' 条 / 队列剩余 ' + queue.length);
        }
        // 队列里还有（超过单轮上限 / 扫描中）→ 稍后再继续，避免一次跑几千条
        if (queue.length) {
            const wait = busyNow() ? 5000 : 500;
            setTimeout(() => { drain(); }, wait);
        }
    }
}

/** 等队列清空（仅测试/停机用） */
function whenIdle() {
    return new Promise((resolve) => {
        const tick = () => {
            if (!draining && queue.length === 0) return resolve(true);
            setTimeout(tick, 200);
        };
        tick();
    });
}

module.exports = {
    auditMovie,
    ensureOne,
    enqueue,
    drain,
    whenIdle,
    getStatus,
    getOptions,
    setBusyChecker,
    fillMissingFields,
    ensureTags,
    ensurePoster,
    _state: state
};
