/**
 * utils/agent/jobs.js —— 后台作业（批量任务）
 * ============================================================================
 * 为什么需要它：单工具沙箱 90 秒，而「1477 张待修海报」按 3~20 秒/张要好几小时。
 * 放进工具里同步跑，必然被熔断；放进循环里一步步调，会吃掉 maxSteps 而且中途断了没法续。
 *
 * 作业模型（最朴素但可用的那一档）：
 *   · 一次只跑一个作业（串行），避免把刮削源打爆；
 *   · 每条之间 sleep（默认 400ms），失败不中断，逐条记结果；
 *   · 作业进度存在内存 + 逐条追加到 <runtime>/logs/agent-jobs/YYYY-MM-DD.jsonl；
 *   · 支持取消：标志位在两条之间检查，正在跑的那一条不打断（避免半个文件）；
 *   · **不做断点续跑**：应用重启后作业就从内存消失，日志还在。
 *     这是有意的取舍 —— 续跑要落库+幂等键，复杂度远高于收益，先把「可观察 + 可取消 + 可复盘」做扎实。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { configPath } = require('../config');

const LOG_DIR = path.join(path.dirname(path.resolve(configPath)), 'logs', 'agent-jobs');
const MAX_JOBS_IN_MEMORY = 20;

const jobs = new Map();
let seq = 0;

function ensureDir() {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { }
}

function dayFile(ts) {
    const d = new Date(ts || Date.now());
    return path.join(LOG_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
}

function append(job, ev) {
    ensureDir();
    try { fs.appendFileSync(dayFile(job.createdAt), JSON.stringify(Object.assign({ jobId: job.id, ts: Date.now() }, ev)) + '\n', 'utf8'); }
    catch (e) { /* 写盘失败不影响作业 */ }
}

function trim() {
    if (jobs.size <= MAX_JOBS_IN_MEMORY) return;
    const sorted = [...jobs.values()].filter(j => j.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
    while (jobs.size > MAX_JOBS_IN_MEMORY && sorted.length) {
        jobs.delete(sorted.shift().id);
    }
}

function create({ type, total, meta = {} }) {
    const job = {
        id: 'job_' + (++seq) + '_' + Date.now().toString(36),
        type,
        status: 'queued',        // queued / running / done / cancelled / failed
        total: Number(total) || 0,
        processed: 0,
        ok: 0,
        failed: 0,
        skipped: 0,
        current: '',
        createdAt: Date.now(),
        startedAt: 0,
        endedAt: 0,
        cancelFlag: false,
        error: '',
        meta,
        // 逐条结果（只留最近 200 条，防止内存膨胀；全量在 JSONL 里）
        items: []
    };
    jobs.set(job.id, job);
    trim();
    append(job, { type: 'job_created', jobType: type, total: job.total, meta });
    return job;
}

function get(id) { return jobs.get(id) || null; }

function list(limit = 20) {
    return [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, Math.max(1, Math.min(50, limit)));
}

function cancel(id) {
    const j = jobs.get(id);
    if (!j) return { ok: false, msg: '作业不存在' };
    if (j.status !== 'running' && j.status !== 'queued') return { ok: false, msg: '作业已结束' };
    j.cancelFlag = true;
    j.status = j.status === 'queued' ? 'cancelled' : j.status;
    append(j, { type: 'job_cancel_requested' });
    return { ok: true, msg: '已请求取消（当前这一条跑完就停）' };
}

function progressOf(job) {
    const elapsed = (job.endedAt || Date.now()) - (job.startedAt || job.createdAt);
    const per = job.processed ? elapsed / job.processed : 0;
    const remain = job.total > job.processed ? Math.round(per * (job.total - job.processed) / 1000) : 0;
    return {
        id: job.id,
        type: job.type,
        status: job.status,
        total: job.total,
        processed: job.processed,
        percent: job.total ? Math.round(job.processed / job.total * 100) : 0,
        ok: job.ok,
        failed: job.failed,
        skipped: job.skipped,
        current: job.current,
        elapsedMs: elapsed,
        etaSec: remain,
        error: job.error,
        meta: job.meta,
        recent: job.items.slice(-20)
    };
}

/**
 * 跑一个批量海报修复作业
 * @param {Object} opt { level, limit, dryRun, delayMs, force, onItem }
 */
function startPosterRepair(opts = {}) {
    const level = opts.level || 'bad';
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 20));
    const dryRun = opts.dryRun !== false;
    const delayMs = Math.max(0, Number(opts.delayMs) || 400);
    const force = !!opts.force;

    // 先算出候选清单（只读，快），再决定作业总量
    const dbm = require('../db');
    const { auditAll, repairOne, judgeMovie } = require('../poster-health');

    const job = create({ type: 'poster_repair', total: 0, meta: { level, limit, dryRun, force } });

    (async () => {
        job.status = 'running';
        job.startedAt = Date.now();
        append(job, { type: 'job_started' });

        let targets = [];
        try {
            const audit = await auditAll(dbm.db, { log: () => { } });
            targets = (audit.items || []).filter(it => {
                if (level === 'all') return it.level !== 'ok';
                if (level === 'missing') return it.level === 'missing';
                return it.level === 'bad';
            }).slice(0, limit);
        } catch (e) {
            job.status = 'failed';
            job.error = '体检失败：' + e.message;
            job.endedAt = Date.now();
            append(job, { type: 'job_failed', error: job.error });
            return;
        }

        job.total = targets.length;
        append(job, { type: 'job_planned', total: job.total });

        if (!job.total) {
            job.status = 'done';
            job.endedAt = Date.now();
            append(job, { type: 'job_done', note: '没有需要处理的条目' });
            return;
        }

        for (const t of targets) {
            if (job.cancelFlag) break;
            job.current = `${t.title || t.avid || '#' + t.id}`;
            job.processed++;
            try {
                if (dryRun) {
                    job.skipped++;
                    job.items.push({ id: t.id, title: t.title, level: t.level, result: 'dry-run' });
                    append(job, { type: 'item', id: t.id, level: t.level, result: 'dry-run' });
                } else {
                    const movie = dbm.getMovieById.get(t.id);
                    if (!movie) {
                        job.failed++;
                        job.items.push({ id: t.id, result: 'missing-record' });
                        append(job, { type: 'item', id: t.id, result: 'missing-record' });
                    } else if (movie.posterLocked && !force) {
                        job.skipped++;
                        job.items.push({ id: t.id, title: movie.title, result: 'locked' });
                        append(job, { type: 'item', id: t.id, result: 'locked' });
                    } else {
                        const r = await repairOne(dbm.db, movie, { force, maxCands: 3 });
                        const done = !!(r && r.ok && r.strategy !== 'skip');
                        const after = judgeMovie(dbm.getMovieById.get(t.id) || movie);
                        if (done) { job.ok++; } else { job.failed++; }
                        const rec = {
                            id: t.id, title: movie.title,
                            result: done ? 'repaired' : (r && r.strategy) || 'failed',
                            reason: (r && r.reason || '').slice(0, 80),
                            after: after.level
                        };
                        job.items.push(rec);
                        if (job.items.length > 200) job.items.shift();
                        append(job, Object.assign({ type: 'item' }, rec));
                    }
                }
            } catch (e) {
                job.failed++;
                job.items.push({ id: t.id, result: 'exception', reason: e.message.slice(0, 80) });
                append(job, { type: 'item', id: t.id, result: 'exception', reason: e.message.slice(0, 80) });
            }
            if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        }

        job.status = job.cancelFlag ? 'cancelled' : 'done';
        job.endedAt = Date.now();
        job.current = '';
        append(job, {
            type: job.cancelFlag ? 'job_cancelled' : 'job_done',
            processed: job.processed, ok: job.ok, failed: job.failed, skipped: job.skipped
        });
    })().catch(e => {
        job.status = 'failed';
        job.error = e.message;
        job.endedAt = Date.now();
        append(job, { type: 'job_failed', error: e.message });
    });

    return job;
}

/* ============================================================================
 * round142：批量「横版截图 → 官方竖版海报」重刮作业
 * ----------------------------------------------------------------------------
 * 背景（实测数据，不是猜的）：
 *   库里 919 条有海报的里番中，**872 条是 640×360 / 420×236 的视频抽帧截图**，
 *   只有 43 条是 AniList 那种 460×638 官方竖版海报。用户明确要求「竖版」。
 *
 * 为什么做成后台作业：
 *   每条要打 AniList GraphQL（有 429 限流）+ 可能还要下载图片，
 *   844 条同步跑必然被工具/HTTP 超时熔断，所以必须走作业模型（可取消、可看进度）。
 *
 * 判定「横版截图」的候选来源：
 *   用 poster-health 已有的几何判据（isVideoMovie / healthOf），
 *   而不是只看 posterPath 是否为空 —— 截图字段非空，但它是错素材类型。
 * ========================================================================== */
function startPortraitRescrape(opts = {}) {
    const rawLimit = opts.limit !== undefined ? Number(opts.limit) : 100;
    const limit = rawLimit === 0 ? 0 : Math.min(5000, Math.max(1, rawLimit || 100));
    const dryRun = opts.dryRun !== false;          // 默认试跑，不写库
    const delayMs = Math.max(200, Number(opts.delayMs) || 700);   // 防 AniList 429
    const force = !!opts.force;                    // 连 posterLocked 也重刮

    const dbm = require('../db');
    const health = require('../poster-health');

    const job = create({
        type: 'portrait_rescrape',
        total: 0,
        meta: { limit, dryRun, delayMs, force }
    });

    (async () => {
        job.status = 'running';
        job.startedAt = Date.now();
        append(job, { type: 'job_started' });

        /* ---------- 1. 挑候选：anime 库里「海报是横版/截图」的条目 ---------- */
        let targets = [];
        const attemptedFile = path.join(LOG_DIR, 'rescrape-attempted.json');
        let attempted = {};
        if (opts.skipAttempted !== false && !force) {
            try { attempted = JSON.parse(fs.readFileSync(attemptedFile, 'utf8')); } catch (e) { }
        }
        try {
            const rows = dbm.db.prepare(
                "SELECT * FROM movies WHERE type='anime' AND posterPath IS NOT NULL AND posterPath<>''"
            ).all();
            for (const m of rows) {
                if (!force && m.posterLocked === 1) { job.skipped++; continue; }
                if (attempted[m.id] && attempted[m.id].result === 'no-match') {
                    // 已确认无官方条目的跳过，实现真正的秒级断点续跑
                    job.skipped++;
                    continue;
                }
                let j = null;
                /* judgeMovie(movie) 才是正确入口：内部会 resolvePosterPath + 判断是否视频库，
                   返回 { level, w, h, ratio, bytes }。直接调 healthOf 需要绝对路径。 */
                try { j = health.judgeMovie(m); } catch (e) { }
                if (!j || !j.w || !j.h) continue;
                // 只处理「横版」形态的；已经是竖版的跳过（说明已经是官方海报）
                if ((j.w / j.h) < 0.85) continue;
                targets.push({ m, j });
                if (limit > 0 && targets.length >= limit) break;
            }
        } catch (e) {
            job.status = 'failed';
            job.error = '筛选候选失败：' + e.message;
            job.endedAt = Date.now();
            append(job, { type: 'job_failed', error: job.error });
            return;
        }

        job.total = targets.length;
        append(job, { type: 'job_planned', total: job.total });
        if (!job.total) {
            job.status = 'done';
            job.endedAt = Date.now();
            append(job, { type: 'job_done', note: '没有需要重刮的横版海报' });
            return;
        }

        const { searchAniListByName } = require('../crawler/anilist');
        const { downloadPoster } = require('../poster-fetcher');

        /* ---------- 2. 逐条：AniList 搜索 → 校验竖版 → 下载 → 写库 ---------- */
        for (const { m, j } of targets) {
            if (job.cancelFlag) break;
            job.current = String(m.title || m.fileName || '#' + m.id).slice(0, 60);
            job.processed++;

            const rec = {
                id: m.id,
                title: String(m.title || '').slice(0, 40),
                before: j.w && j.h ? `${j.w}x${j.h}` : '?',
                result: '',
                after: ''
            };

            try {
                if (dryRun) {
                    rec.result = 'dry-run';
                    job.skipped++;
                } else {
                    let hit = null;
                    try {
                        hit = await searchAniListByName(String(m.title || m.fileName || ''));
                    } catch (e) {
                        /* 限流 ≠ 没有条目。绝不能把限流记成 no-match，
                           否则用户看到「重刮失败 800 条」，实际只是被限速。 */
                        if (e && e.code === 'ANILIST_RATE_LIMITED') {
                            // 撞限流就歇久一点，尝试一次就地重试
                            await new Promise(r => setTimeout(r, 8000));
                            try {
                                hit = await searchAniListByName(String(m.title || m.fileName || ''));
                            } catch (e2) {
                                if (e2 && e2.code === 'ANILIST_RATE_LIMITED') {
                                    rec.result = 'rate-limited';
                                    rec.reason = 'AniList 限流，稍后重试';
                                    job.skipped++;
                                    job.items.push(rec);
                                    if (job.items.length > 200) job.items.shift();
                                    append(job, Object.assign({ type: 'item' }, rec));
                                    await new Promise(r => setTimeout(r, 5000));
                                    continue;
                                }
                                throw e2;
                            }
                        } else {
                            throw e;
                        }
                    }
                    if (!hit || !hit.cover) {
                        rec.result = 'no-match';
                        job.failed++;
                    } else {
                        // 先下载到临时位置，校验确实竖版才写库
                        const tmp = path.join(require('os').tmpdir(), `rescrape_${m.id}_${Date.now()}.img`);
                        try {
                            await downloadPoster(hit.cover, tmp);
                            /* round142 修复：imageSize() 返回的是 { w, h }，
                               之前误写成 sz.width/sz.height —— 恒为 undefined，
                               于是「下载成功」的每一张都被判 not-portrait 全部丢弃
                               （实测 50 条跑完 ok=0 的真正原因，不是 AniList 没图）。 */
                            const sz = health.imageSize(tmp);
                            const isPortrait = !!(sz && sz.w && sz.h && (sz.w / sz.h) < 0.85);
                            rec.after = sz ? `${sz.w}x${sz.h}` : '?';
                            if (!isPortrait) {
                                rec.result = 'not-portrait';
                                job.failed++;
                                try { fs.unlinkSync(tmp); } catch (e) { }
                            } else {
                                const ext = path.extname(hit.cover).toLowerCase() === '.png' ? 'png' : 'jpg';
                                const name = `anilist_${m.id}_${Date.now().toString(36)}.${ext}`;
                                const dest = path.join(health.POSTER_DIR, name);
                                try { fs.mkdirSync(health.POSTER_DIR, { recursive: true }); } catch (e) { }
                                fs.copyFileSync(tmp, dest);
                                try { fs.unlinkSync(tmp); } catch (e) { }
                                /* ★ 两列口径不同，别写成同一个值：
                                   · posterPath    = **纯文件名**（前端走 /api/movie/poster/{name}，
                                     `router.get('/poster/:hash')` 的 :param 不吃路径分隔符，
                                     带前缀必 404 → 「重刮成功但满屏破图」，实测过）；
                                   · localPosterPath = **相对形式 cache/posters/<name>**
                                     （routes/movie.js 删封面/修封面是 path.join('../', localPosterPath)）。 */
                                const relPath = name;
                                const localRel = 'cache/posters/' + name;
                                dbm.db.prepare(
                                    'UPDATE movies SET posterPath = ?, localPosterPath = ?, posterHealth = ?, posterHealthReason = ?, posterHealthAt = ?, posterLocked = 0 WHERE id = ?'
                                ).run(relPath, localRel, 'ok', 'AniList 竖版海报', Date.now(), m.id);
                                rec.result = 'replaced';
                                rec.file = name;
                                rec.matched = String(hit.title || '').slice(0, 30);
                                job.ok++;
                            }
                        } catch (e) {
                            rec.result = 'download-failed';
                            rec.reason = e.message.slice(0, 80);
                            job.failed++;
                        }
                    }
                }
            } catch (e) {
                rec.result = 'exception';
                rec.reason = String(e.message || e).slice(0, 80);
                job.failed++;
            }

            job.items.push(rec);
            if (job.items.length > 200) job.items.shift();
            append(job, Object.assign({ type: 'item' }, rec));
            if (!dryRun && rec.result && rec.result !== 'rate-limited') {
                try {
                    attempted[m.id] = { ts: Date.now(), result: rec.result, title: rec.title };
                    fs.writeFileSync(attemptedFile, JSON.stringify(attempted, null, 2), 'utf8');
                } catch (e) { }
            }
            if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        }

        job.status = job.cancelFlag ? 'cancelled' : 'done';
        job.endedAt = Date.now();
        job.current = '';
        append(job, {
            type: job.cancelFlag ? 'job_cancelled' : 'job_done',
            processed: job.processed, ok: job.ok, failed: job.failed, skipped: job.skipped
        });
    })().catch(e => {
        job.status = 'failed';
        job.error = e.message;
        job.endedAt = Date.now();
        append(job, { type: 'job_failed', error: e.message });
    });

    return job;
}

module.exports = {
    create, get, list, cancel, progressOf, startPosterRepair, startPortraitRescrape, LOG_DIR
};
