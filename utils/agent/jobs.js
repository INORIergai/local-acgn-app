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

module.exports = { create, get, list, cancel, progressOf, startPosterRepair, LOG_DIR };
