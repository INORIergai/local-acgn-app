/**
 * utils/agent/approvals.js —— 单步审批队列（Human-in-the-loop）
 * ============================================================================
 * 为什么不用「全局布尔 + 重发整条消息」（旧实现）：
 *   ① 批准一次等于把整轮对话重跑一遍，模型可能第二次生成**不同的**调用，
 *      用户批的是 A，实际执行的是 B；
 *   ② 同一条消息里多个高危调用无法只批其中一个；
 *   ③ 批准之后没有留痕，事后说不清「谁批的、批的是哪一次调用」。
 *
 * 现在：每个高危 tool_call 生成一个独立 approvalId，Agent 循环在原地 await，
 * 用户在界面上点「允许/拒绝」，只放行这一次调用；超时自动拒绝。
 *
 * 边界：
 *   · 一个 run 最多同时挂 8 个待审批（防止模型一次吐几十个高危调用淹没用户）；
 *   · 默认 180s 超时，超时按「拒绝」处理并继续（不卡死整个会话）；
 *   · 同一 approval 只能被裁决一次（幂等），重复裁决返回当前状态。
 */
'use strict';

const MAX_PENDING_PER_RUN = 8;
const DEFAULT_TTL_MS = 180000;

/** approvalId -> entry */
const pending = new Map();

function newId() {
    return 'apr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function countByRun(runId) {
    let n = 0;
    for (const e of pending.values()) if (!e.settled && e.runId === runId) n++;
    return n;
}

/**
 * 申请一次授权，返回 Promise<{approved:boolean, reason:string, decidedBy:string}>。
 * 调用方（runtime）会在这里挂起，直到有人裁决或超时。
 */
function requestApproval({ runId, callId, tool, label, args, warning, risk, ttlMs = DEFAULT_TTL_MS }) {
    if (countByRun(runId) >= MAX_PENDING_PER_RUN) {
        return Promise.resolve({ approved: false, reason: 'too_many_pending', decidedBy: 'system' });
    }
    const id = newId();
    let resolveFn = null;
    const promise = new Promise(resolve => { resolveFn = resolve; });

    const entry = {
        id, runId, callId, tool, label: label || tool, args: args || {},
        warning: warning || '该操作会修改数据或文件，需要你确认',
        risk: risk || 'high',
        createdAt: Date.now(),
        settled: false,
        approved: null,
        decidedBy: '',
        resolve: (payload) => {
            if (entry.settled) return false;
            entry.settled = true;
            entry.approved = !!payload.approved;
            entry.decidedBy = payload.decidedBy || 'user';
            clearTimeout(entry.timer);
            resolveFn(payload);
            // 保留 60s 供前端补拉状态，然后清掉
            setTimeout(() => pending.delete(id), 60000);
            return true;
        }
    };

    entry.timer = setTimeout(() => {
        entry.resolve({ approved: false, reason: 'timeout', decidedBy: 'system' });
    }, Math.max(5000, ttlMs));

    pending.set(id, entry);

    return {
        id,
        promise,
        info: {
            id,
            runId,
            callId,
            tool,
            label: entry.label,
            args: entry.args,
            warning: entry.warning,
            risk: entry.risk,
            ttlMs,
            createdAt: entry.createdAt
        }
    };
}

/**
 * 裁决。返回 { ok, status: 'approved'|'rejected'|'already'|'not_found' }
 */
function resolve(id, { approved = false, decidedBy = 'user' } = {}) {
    const entry = pending.get(id);
    if (!entry) return { ok: false, status: 'not_found' };
    if (entry.settled) {
        return { ok: false, status: 'already', approved: entry.approved };
    }
    entry.resolve({ approved: !!approved, decidedBy });
    return { ok: true, status: approved ? 'approved' : 'rejected' };
}

/** 一个 run 被中止时，把它所有待审批全部按拒绝收尾 */
function cancelRun(runId, reason = 'aborted') {
    let n = 0;
    for (const e of pending.values()) {
        if (e.runId === runId && !e.settled) {
            e.resolve({ approved: false, reason, decidedBy: 'system' });
            n++;
        }
    }
    return n;
}

function list(runId) {
    const out = [];
    for (const e of pending.values()) {
        if (runId && e.runId !== runId) continue;
        out.push({
            id: e.id, runId: e.runId, tool: e.tool, label: e.label,
            args: e.args, warning: e.warning, risk: e.risk,
            createdAt: e.createdAt, settled: e.settled, approved: e.approved
        });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
}

module.exports = { requestApproval, resolve, cancelRun, list, MAX_PENDING_PER_RUN, DEFAULT_TTL_MS };
