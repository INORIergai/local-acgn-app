/**
 * utils/agent/trace.js —— Agent 运行轨迹（可追溯）
 * ============================================================================
 * 目标：每一次 Agent 运行都留下「谁、什么时候、因为什么、调了哪个工具、参数是什么、
 *      结果是什么、用了多久、谁批准的」的完整记录，既能给界面展示，也能事后复盘。
 *
 * 落盘：<runtime>/logs/agent-runs/YYYY-MM-DD.jsonl（一行一个事件，追加写）
 * 内存：最近 40 次运行（供界面「最近任务」秒开，不必扫盘）
 *
 * 设计取舍：
 *   · 不落 SQLite —— 轨迹是高频小写入，塞进主库会跟 FTS/事务抢锁；
 *   · 一行一事件而不是一行一运行 —— 中途崩溃也保住已完成步骤（追加写不会毁掉整条）；
 *   · 参数做脱敏 + 截断（≤800 字符），避免把整篇简介或密钥写进日志。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { configPath } = require('../config');

const LOG_DIR = path.join(path.dirname(path.resolve(configPath)), 'logs', 'agent-runs');
const MAX_RUNS_IN_MEMORY = 40;
const MAX_ARG_CHARS = 800;
const MAX_RESULT_CHARS = 1200;

/** runId -> run 对象 */
const runs = new Map();

function ensureDir() {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* 目录建不出来就只留内存 */ }
}

function dayFile(ts) {
    const d = new Date(ts || Date.now());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return path.join(LOG_DIR, `${y}-${m}-${day}.jsonl`);
}

function clip(v, max) {
    if (v == null) return v;
    let s;
    try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
    if (s == null) return '';
    return s.length > max ? s.slice(0, max) + `…[截断 ${s.length - max} 字]` : s;
}

/** 脱敏：把明显的密钥形态抹掉，避免写进审计日志 */
function redact(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') {
        return obj
            .replace(/(sk-[A-Za-z0-9]{8})[A-Za-z0-9\-_]+/g, '$1***')
            .replace(/(Bearer\s+)[A-Za-z0-9\-_.]+/i, '$1***')
            .replace(/("?(?:apiKey|password|token|secret)"?\s*[:=]\s*")([^"]{4})[^"]*(")/gi, '$1$2***$3');
    }
    if (Array.isArray(obj)) return obj.map(redact);
    if (typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (/^(apiKey|password|token|secret|authorization)$/i.test(k)) { out[k] = '***'; continue; }
            out[k] = redact(v);
        }
        return out;
    }
    return obj;
}

function append(run, event) {
    ensureDir();
    const line = JSON.stringify(Object.assign({ runId: run.id, ts: Date.now() }, event));
    try { fs.appendFileSync(dayFile(run.startedAt), line + '\n', 'utf8'); } catch (e) { /* 写盘失败不影响主流程 */ }
}

function newRunId() {
    return 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function trimMemory() {
    if (runs.size <= MAX_RUNS_IN_MEMORY) return;
    const sorted = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    while (sorted.length > MAX_RUNS_IN_MEMORY) {
        const r = sorted.shift();
        runs.delete(r.id);
    }
}

/**
 * 开一次运行
 * @returns {Object} run 对象（后续 addStep/finishRun 都用它）
 */
function createRun({ sessionId = 'main', userMessage = '', model = '', routeName = '' } = {}) {
    const run = {
        id: newRunId(),
        sessionId,
        model,
        routeName,
        userMessage: clip(userMessage, 500),
        startedAt: Date.now(),
        endedAt: 0,
        status: 'running',      // running / done / error / aborted
        steps: [],
        reply: '',
        error: '',
        tokens: 0
    };
    runs.set(run.id, run);
    trimMemory();
    append(run, { type: 'run_start', sessionId, model, routeName, userMessage: run.userMessage });
    return run;
}

/**
 * 记一步。step 结构：
 *   { kind: 'phase'|'tool'|'approval'|'note', name, label, args, result, status, ok, costMs, summary }
 */
function addStep(run, step = {}) {
    const s = {
        seq: run.steps.length + 1,
        ts: Date.now(),
        kind: step.kind || 'note',
        name: step.name || '',
        label: step.label || step.name || '',
        args: redact(step.args || null),
        argsBrief: clip(redact(step.args || null), MAX_ARG_CHARS),
        status: step.status || 'done',
        ok: step.ok !== false,
        costMs: Number(step.costMs) || 0,
        summary: clip(step.summary || '', 300),
        resultBrief: clip(redact(step.result || ''), MAX_RESULT_CHARS),
        approvalId: step.approvalId || '',
        decidedBy: step.decidedBy || ''
    };
    run.steps.push(s);
    append(run, { type: 'step', step: s });
    return s;
}

/** 更新某一步（工具从 running → done 时用） */
function patchStep(run, seq, patch = {}) {
    const s = run.steps.find(x => x.seq === seq);
    if (!s) return null;
    Object.assign(s, {
        status: patch.status || s.status,
        ok: patch.ok === undefined ? s.ok : patch.ok,
        costMs: patch.costMs === undefined ? s.costMs : Number(patch.costMs),
        summary: patch.summary === undefined ? s.summary : clip(patch.summary, 300),
        resultBrief: patch.result === undefined ? s.resultBrief : clip(redact(patch.result), MAX_RESULT_CHARS),
        decidedBy: patch.decidedBy || s.decidedBy
    });
    append(run, { type: 'step_patch', seq, patch: { status: s.status, ok: s.ok, costMs: s.costMs, summary: s.summary } });
    return s;
}

function finishRun(run, { status = 'done', reply = '', error = '', tokens = 0 } = {}) {
    run.endedAt = Date.now();
    run.status = status;
    run.reply = clip(reply, 4000);
    run.error = clip(error, 500);
    run.tokens = Number(tokens) || 0;
    append(run, {
        type: 'run_end', status, error: run.error, tokens: run.tokens,
        durationMs: run.endedAt - run.startedAt, stepCount: run.steps.length,
        replyHead: clip(reply, 400)
    });
    return run;
}

function summarize(run) {
    return {
        id: run.id,
        sessionId: run.sessionId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
        stepCount: run.steps.length,
        durationMs: (run.endedAt || Date.now()) - run.startedAt,
        userMessage: run.userMessage,
        error: run.error,
        steps: run.steps.map(s => ({
            seq: s.seq, kind: s.kind, name: s.name, label: s.label,
            status: s.status, ok: s.ok, costMs: s.costMs, summary: s.summary
        }))
    };
}

/** 内存里取，取不到就回盘上找（跨进程重启后仍可追溯） */
function getRun(id) {
    if (!id) return null;
    if (runs.has(id)) {
        const r = runs.get(id);
        return Object.assign(summarize(r), { reply: r.reply, argsOf: r.steps.map(s => ({ seq: s.seq, argsBrief: s.argsBrief })) });
    }
    // 回盘：最近 3 天的日志
    for (let i = 0; i < 3; i++) {
        const f = dayFile(Date.now() - i * 86400000);
        if (!fs.existsSync(f)) continue;
        const found = readRunFromFile(f, id);
        if (found) return found;
    }
    return null;
}

function readRunFromFile(file, id) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    const run = { id, steps: [], status: 'unknown', startedAt: 0, endedAt: 0, userMessage: '', reply: '', error: '' };
    let hit = false;
    for (const line of text.split('\n')) {
        if (!line.trim() || line.indexOf(id) < 0) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.runId !== id) continue;
        hit = true;
        if (ev.type === 'run_start') { run.startedAt = ev.ts; run.userMessage = ev.userMessage || ''; run.model = ev.model || ''; }
        if (ev.type === 'step' && ev.step) run.steps.push(ev.step);
        if (ev.type === 'step_patch' && ev.seq) {
            const s = run.steps.find(x => x.seq === ev.seq);
            if (s) Object.assign(s, ev.patch || {});
        }
        if (ev.type === 'run_end') { run.status = ev.status; run.endedAt = ev.ts; run.error = ev.error || ''; }
    }
    if (!hit) return null;
    return run;
}

/** 从磁盘日志里重建最近运行（应用重启后内存是空的，但审计不能断） */
function scanDiskRuns(days = 3, limit = 30) {
    const map = new Map();
    for (let i = 0; i < days; i++) {
        const f = dayFile(Date.now() - i * 86400000);
        if (!fs.existsSync(f)) continue;
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let ev;
            try { ev = JSON.parse(line); } catch (e) { continue; }
            if (!ev || !ev.runId) continue;
            if (ev.type === 'run_start') {
                map.set(ev.runId, {
                    id: ev.runId, sessionId: ev.sessionId || '', userMessage: ev.userMessage || '',
                    startedAt: ev.ts, endedAt: 0, status: 'unknown',
                    stepCount: 0, durationMs: 0, error: '', steps: []
                });
                continue;
            }
            const r = map.get(ev.runId);
            if (!r) continue;
            if (ev.type === 'step' && ev.step) {
                r.steps.push(ev.step);
                r.stepCount = r.steps.length;
            } else if (ev.type === 'step_patch' && ev.seq) {
                const s = r.steps.find(x => x.seq === ev.seq);
                if (s) Object.assign(s, ev.patch || {});
            } else if (ev.type === 'run_end') {
                r.status = ev.status || 'done';
                r.endedAt = ev.ts;
                r.durationMs = ev.durationMs || (ev.ts - r.startedAt);
                r.error = ev.error || '';
            }
        }
    }
    return [...map.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

/** 内存 + 磁盘合并（同 id 以内存为准，内存里的状态更新） */
function listRuns(limit = 20) {
    const n = Math.max(1, Math.min(100, limit));
    const mem = [...runs.values()].map(summarize);
    const memIds = new Set(mem.map(r => r.id));
    const disk = scanDiskRuns(3, n + 20).filter(r => !memIds.has(r.id)).map(r => ({
        id: r.id, sessionId: r.sessionId, startedAt: r.startedAt, endedAt: r.endedAt,
        status: r.status, stepCount: r.stepCount, durationMs: r.durationMs,
        userMessage: r.userMessage, error: r.error,
        steps: r.steps.map(s => ({
            seq: s.seq, kind: s.kind, name: s.name, label: s.label,
            status: s.status, ok: s.ok, costMs: s.costMs, summary: s.summary
        }))
    }));
    return [...mem, ...disk].sort((a, b) => b.startedAt - a.startedAt).slice(0, n);
}

module.exports = {
    createRun,
    addStep,
    patchStep,
    finishRun,
    getRun,
    listRuns,
    redact,
    LOG_DIR
};
