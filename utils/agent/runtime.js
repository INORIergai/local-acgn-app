/**
 * utils/agent/runtime.js —— Agent 执行运行时（有界自主 + 真流式 + 单步审批 + 全轨迹）
 * ============================================================================
 * 为什么不再用 LangGraph 跑这条链路：
 *   ① 旧入口 `streamCinemaAgent` 是「整图跑完再把 token 回放」的假流式，
 *      刮一张海报要 20 秒，界面在这 20 秒里是死的；
 *   ② 审批是全局布尔 + 重发整条消息，用户批的是 A、实际可能执行 B；
 *   ③ 图的内部状态对界面不透明，用户看不到「现在第几步、在做什么、花了多久」。
 *
 * 现在的循环（一步一个回合，全部落 trace）：
 *   while (step < maxSteps && 未超时 && toolCalls < 上限)
 *     ① 流式请求模型（文本增量实时下发，工具调用分片在流结束后拼装）
 *     ② 有 tool_calls → 逐个：审批（若需要）→ 沙箱执行 → 结果回填 → 事件下发
 *     ③ 无 tool_calls → 本轮文本即最终回答，结束
 *
 * 有界性（缺一个都算事故）：
 *   · maxSteps 默认 8（config.ai.agent.maxSteps 可调，硬上限 16）
 *   · 墙钟 180s（硬上限，超时把已有回答交出去，不卡界面）
 *   · 单轮工具调用累计 12 次
 *   · 单个工具执行 12~90s（见 tools.js 的 timeoutMs）
 *   · 审批 180s 无响应 → 按拒绝处理，继续对话（不冻结会话）
 */
'use strict';

const trace = require('./trace');
const approvals = require('./approvals');
const { executeSandboxedTool, PRIVILEGE } = require('./sandbox');
const { TOOL_MAP, getOpenAIToolsSchema } = require('./tools');
const config = require('../config');

const HARD_MAX_STEPS = 16;
const HARD_WALL_MS = 180000;
const HARD_MAX_TOOL_CALLS = 12;
const TOOL_MSG_MAX_CHARS = 3000;

function agentCfg() {
    const a = (config.ai && config.ai.agent) || {};
    return {
        maxSteps: Math.min(HARD_MAX_STEPS, Math.max(1, Number(a.maxSteps) || 8)),
        approveLevel: a.approveLevel || 'destructive',   // destructive | mutating | all
        ttlMs: Math.max(10000, Number(a.approvalTtlMs) || approvals.DEFAULT_TTL_MS),
        // token 预算：没有它，一次跑飞就是真金白银。默认 6 万 tokens/轮
        maxTokens: Math.min(500000, Math.max(2000, Number(a.maxTokens) || 60000))
    };
}

/* 可重试的错误形态：网络抖动、超时、网关 5xx/429。
 * 只对**只读工具**自动重试 —— 写操作重试可能产生重复副作用（改两次名、换两次图），
 * 宁可让模型看到错误、由它决定换方案，也不让框架偷偷再来一遍。 */
const RETRYABLE_RE = /(超时|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|429|500|502|503|504)/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function execWithRetry(meta, args, ctx, onRetry) {
    const maxAttempts = meta.privilege === PRIVILEGE.READ_ONLY ? 3 : 1;
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const out = await executeSandboxedTool(meta, args, ctx);
        if (out && out.ok) return Object.assign(out, { attempts: attempt });
        last = out || { ok: false, error: '未知错误' };
        const canRetry = attempt < maxAttempts && RETRYABLE_RE.test(String(last.error || ''));
        if (!canRetry) return Object.assign(last, { attempts: attempt });
        // 退避 + 抖动：400ms 起，避免多个工具同时重试把上游打穿
        const wait = 400 * attempt + Math.floor(Math.random() * 400);
        if (typeof onRetry === 'function') onRetry(attempt, last.error, wait);
        await sleep(wait);
    }
    return Object.assign(last || { ok: false, error: '未知错误' }, { attempts: maxAttempts });
}

function buildSystemPrompt(ctx) {
    const base = (config.ai && config.ai.agentSystemPrompt) || '';
    return [
        base,
        '你是 CinemaVault（本地影视/动漫/漫画/小说库）的操作助手。你能真的读写这个库和它所在目录，不只是聊天。',
        '',
        '工作纪律（必须遵守）：',
        '1. 先查后改：任何修改前，先用 search_movies / find_missing_posters / list_files 拿到真实的 id 与路径，禁止编造 id。',
        '2. 一次只做一件事。多步任务要一步一步来，每步等结果再决定下一步。',
        '3. 高危操作（改名、移出文件、覆盖式刮削）会弹出用户确认；被拒绝就停下来说明原因，不要换个参数重试。',
        '4. 只读工具可以连续调用；写操作做完要复述「改了什么、改到哪个文件」。',
        '5. 做不到就说做不到。工具报错时如实转述错误，不要编造成功。',
        '6. 回复用中文，简洁，先给结论再给细节；不要输出工具调用的 JSON。',
        '7. 自修的边界：网络类错误（超时/连接失败/5xx）只读工具会自动重试，你不用重复调用；'
            + '参数类错误（缺字段、id 不存在、路径越界）要换方案，**同一个调用不要连续试第三次**。',
        '8. 批量任务用 batch_repair_posters 起作业，再用 get_job_status 查进度；不要逐条循环几十次。',
        '',
        ctx && ctx.hint ? ('本轮上下文：' + ctx.hint) : ''
    ].filter(Boolean).join('\n');
}

function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter(h => h && (h.role === 'user' || h.role === 'assistant') && String(h.content || '').trim())
        .slice(-12)
        .map(h => ({ role: h.role, content: String(h.content).slice(0, 1500) }));
}

function safeJson(s) {
    try { return JSON.parse(s || '{}') || {}; } catch (e) { return null; }
}

function summarizeArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = Object.keys(args);
    if (!keys.length) return '';
    return keys.map(k => {
        let v = args[k];
        if (typeof v === 'string' && v.length > 40) v = v.slice(0, 40) + '…';
        return `${k}=${typeof v === 'object' ? '[obj]' : v}`;
    }).join(' · ').slice(0, 160);
}

/**
 * 跑一次 Agent
 * @param {Object} opts { message, sessionId, history, hint, onEvent, signal }
 * @returns {Promise<{runId, content, steps, error, aborted}>}
 */
async function runAgent(opts = {}) {
    const { message, sessionId = 'main', history = [], hint = '', onEvent = () => { }, signal = null } = opts;
    const cfg = agentCfg();
    const t0 = Date.now();
    const run = trace.createRun({
        sessionId,
        userMessage: message,
        model: (config.ai && (config.ai.custom && config.ai.custom.model || config.ai.openai && config.ai.openai.model)) || '',
        routeName: ''
    });

    const emit = (ev) => { try { onEvent(ev); } catch (e) { /* 前端断开不能拖死循环 */ } };

    emit({ type: 'run', runId: run.id, maxSteps: cfg.maxSteps, startedAt: run.startedAt });

    const { callAIAdvancedStream, getLastUsedRouteName } = require('../ai-service');
    const messages = [
        { role: 'system', content: buildSystemPrompt({ hint }) },
        ...normalizeHistory(history),
        { role: 'user', content: String(message || '') }
    ];
    const toolsSchema = getOpenAIToolsSchema();

    let step = 0, toolCallCount = 0, finalText = '', aborted = false, lastErr = '';
    let uiActions = [];
    // round136：成本与自愈
    let tokensUsed = 0, tokensFromApi = 0;
    let lastFailSig = '', lastFailCount = 0;
    const estimateTokens = (chars) => Math.ceil(chars / 2.5);   // 中文约 2.5 字/token，粗估

    const onAbort = () => {
        aborted = true;
        approvals.cancelRun(run.id, 'aborted');
    };
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
    }

    while (step < cfg.maxSteps && !aborted && Date.now() - t0 < HARD_WALL_MS) {
        step++;
        emit({ type: 'phase', step, phase: 'thinking', text: `第 ${step} 步 · 思考中` });

        let res;
        let turnChars = 0;
        try {
            res = await callAIAdvancedStream(messages, toolsSchema, (delta) => {
                turnChars += String(delta || '').length;
                emit({ type: 'token', token: delta, step });
            }, (usage) => {
                if (usage && Number(usage.total_tokens)) tokensFromApi += Number(usage.total_tokens);
            });
            // 预算记账：有 usage 用真值，没有就按字数估（偏保守）
            if (tokensFromApi > 0) tokensUsed = tokensFromApi;
            else tokensUsed += estimateTokens(turnChars + JSON.stringify(messages).length);
        } catch (e) {
            lastErr = e.message;
            trace.addStep(run, { kind: 'phase', name: 'llm_error', label: '模型调用失败', ok: false, summary: e.message });
            emit({ type: 'step', step: { seq: run.steps.length, kind: 'phase', label: '模型调用失败', ok: false, summary: e.message } });
            break;
        }

        run.routeName = getLastUsedRouteName() || '';
        if (aborted) break;

        // 预算闸：超了就停，但把已有的回答交出去（不吞掉用户已经看到的内容）
        if (tokensUsed > cfg.maxTokens) {
            lastErr = `本轮已用约 ${tokensUsed} tokens，超过预算 ${cfg.maxTokens}，已停下`;
            trace.addStep(run, { kind: 'phase', name: 'budget_exceeded', label: '超出 token 预算', ok: false, summary: lastErr });
            emit({ type: 'step', step: { seq: run.steps.length, kind: 'phase', label: '超出 token 预算', ok: false, summary: lastErr } });
            break;
        }

        const isToolTurn = res && typeof res === 'object' && res.type === 'tool_calls';
        if (!isToolTurn) {
            finalText = typeof res === 'string' ? res : (res && res.content) || '';
            trace.addStep(run, { kind: 'phase', name: 'answer', label: `第 ${step} 步 · 给出回答`, ok: true, summary: String(finalText).slice(0, 120) });
            break;
        }

        const toolCalls = (res.toolCalls || []).slice(0, HARD_MAX_TOOL_CALLS - toolCallCount);
        if (!toolCalls.length) { finalText = res.content || ''; break; }

        messages.push({ role: 'assistant', content: res.content || '', tool_calls: toolCalls });

        for (const tc of toolCalls) {
            if (aborted) break;
            const name = (tc.function && tc.function.name) || '';
            const meta = TOOL_MAP.get(name);
            const args = safeJson(tc.function && tc.function.arguments);

            if (!meta) {
                messages.push({
                    role: 'tool', tool_call_id: tc.id,
                    content: JSON.stringify({ error: `未知工具 ${name}，可用工具见系统提示` })
                });
                trace.addStep(run, { kind: 'tool', name, label: `未知工具 ${name}`, ok: false, summary: '模型调用了不存在的工具' });
                emit({ type: 'step', step: { seq: run.steps.length, kind: 'tool', name, label: `未知工具 ${name}`, ok: false, summary: '模型调用了不存在的工具' } });
                continue;
            }
            if (args === null) {
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: '参数不是合法 JSON，请重新生成' }) });
                trace.addStep(run, { kind: 'tool', name, label: `${meta.label}（参数非法）`, ok: false, summary: 'arguments 不是合法 JSON' });
                continue;
            }

            toolCallCount++;

            /* round136 · 重复失败护栏：
             * 模型有时会「同一条命令反复试」，尤其在参数错的情况下。连续 2 次同样的
             * 调用都失败之后，第 3 次直接拒绝执行并把原因回给它 —— 不执行就不算步数，
             * 也避免把 8 步预算全烧在一个死循环上。 */
            const callSig = name + ':' + JSON.stringify(args || {});
            if (callSig === lastFailSig && lastFailCount >= 2) {
                const msg = `同一个调用已经连续失败 ${lastFailCount} 次，已阻止重复执行。请换方案，或直接说明做不到。`;
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: msg }) });
                trace.addStep(run, { kind: 'tool', name, label: `${meta.label || name}（重复调用已拦截）`, args, ok: false, summary: msg });
                emit({ type: 'step', step: { seq: run.steps.length, kind: 'tool', name, label: `${meta.label || name}（重复调用已拦截）`, ok: false, status: 'failed', summary: msg } });
                continue;
            }

            const needApproval = meta.privilege === PRIVILEGE.DESTRUCTIVE
                || (meta.privilege === PRIVILEGE.MUTATING && cfg.approveLevel === 'mutating')
                || (cfg.approveLevel === 'all' && meta.privilege !== PRIVILEGE.READ_ONLY);

            const stepRec = trace.addStep(run, {
                kind: 'tool', name, label: meta.label || name, args,
                status: needApproval ? 'waiting_approval' : 'running',
                summary: summarizeArgs(args)
            });
            emit({
                type: 'step',
                step: {
                    seq: stepRec.seq, kind: 'tool', name, label: stepRec.label,
                    status: stepRec.status, summary: stepRec.summary,
                    privilege: meta.privilege, args
                }
            });

            let approved = !needApproval;
            let approvalId = '';
            if (needApproval) {
                const ap = approvals.requestApproval({
                    runId: run.id, callId: tc.id, tool: name,
                    label: meta.label || name, args,
                    warning: meta.warningMessage || '该操作会修改数据或文件，需要你确认',
                    risk: meta.privilege === PRIVILEGE.DESTRUCTIVE ? 'high' : 'medium',
                    ttlMs: cfg.ttlMs
                });
                approvalId = ap.id;
                trace.addStep(run, {
                    kind: 'approval', name, label: `等待授权：${meta.label || name}`,
                    args, status: 'waiting', summary: ap.info.warning, approvalId
                });
                emit({ type: 'approval', approval: ap.info });
                const decision = await ap.promise;
                approved = !!decision.approved;
                trace.patchStep(run, stepRec.seq, {
                    status: approved ? 'running' : 'rejected',
                    summary: approved ? '用户已批准，开始执行' : `用户${decision.reason === 'timeout' ? '未响应（超时）' : '拒绝'}`,
                    decidedBy: decision.decidedBy || 'user'
                });
                emit({
                    type: 'step_patch',
                    seq: stepRec.seq,
                    patch: { status: approved ? 'running' : 'rejected', summary: approved ? '已批准' : '已拒绝' },
                    approvalId
                });
                if (!approved) {
                    messages.push({
                        role: 'tool', tool_call_id: tc.id,
                        content: JSON.stringify({ error: '用户拒绝了这次操作，未执行。请说明为什么需要它，或改用只读方案。' })
                    });
                    continue;
                }
            }

            const out = await execWithRetry(meta, args, {
                runId: run.id, sessionId, userApproved: approved, approvalId
            }, (attempt, err, wait) => {
                // 重试也要留痕：用户能看到「第 2 次尝试（网络抖动）」
                const note = `第 ${attempt + 1} 次尝试（上一轮：${String(err).slice(0, 60)}）`;
                emit({ type: 'step_patch', seq: stepRec.seq, patch: { status: 'running', summary: note } });
                trace.patchStep(run, stepRec.seq, { summary: note });
            });

            // 失败签名记账（成功则清零）
            if (out && out.ok) { lastFailSig = ''; lastFailCount = 0; }
            else {
                if (callSig === lastFailSig) lastFailCount++;
                else { lastFailSig = callSig; lastFailCount = 1; }
            }

            const okFlag = !!out.ok;
            const summaryText = okFlag
                ? (out.data && (out.data.message || out.data.notice)) || '执行完成'
                : (out.error || '执行失败');

            trace.patchStep(run, stepRec.seq, {
                status: okFlag ? 'done' : 'failed',
                ok: okFlag,
                costMs: out.costMs || 0,
                summary: String(summaryText).slice(0, 200),
                result: out.data || out.error
            });
            emit({
                type: 'step_patch',
                seq: stepRec.seq,
                patch: {
                    status: okFlag ? 'done' : 'failed',
                    ok: okFlag,
                    costMs: out.costMs || 0,
                    summary: String(summaryText).slice(0, 200)
                }
            });

            if (okFlag && out.data && out.data.uiAction) {
                uiActions.push({ type: out.data.uiAction, payload: out.data });
            }

            let payload = out.ok ? (out.data || {}) : { error: out.error || '执行失败' };
            if (out.requiresApproval && !needApproval) payload = { error: '该操作需要用户授权，但当前未获得' };
            let content = JSON.stringify(payload);
            if (content.length > TOOL_MSG_MAX_CHARS) content = content.slice(0, TOOL_MSG_MAX_CHARS) + '…[结果已截断]';
            messages.push({ role: 'tool', tool_call_id: tc.id, content });
        }
    }

    // 收尾：超步数/超时但没有回答时，给一句如实的说明
    if (!finalText) {
        if (aborted) finalText = '已按你的要求中止本次操作。';
        else if (lastErr) finalText = `执行中断：${lastErr}`;
        else if (Date.now() - t0 >= HARD_WALL_MS) finalText = '这次任务超过了 3 分钟上限，已停下。可以把任务拆小一点再让我继续。';
        else finalText = '这次任务达到步数上限就停了。你可以让我继续，或者把目标拆得更具体。';
    }

    uiActions.forEach(a => emit({ type: 'action', action: a }));

    trace.finishRun(run, { status: aborted ? 'aborted' : (lastErr ? 'error' : 'done'), reply: finalText, error: lastErr });
    emit({
        type: 'done',
        runId: run.id,
        content: finalText,
        steps: run.steps.map(s => ({ seq: s.seq, kind: s.kind, name: s.name, label: s.label, ok: s.ok, status: s.status, costMs: s.costMs })),
        uiActions,
        durationMs: Date.now() - t0,
        aborted
    });

    return { runId: run.id, content: finalText, steps: run.steps, error: lastErr, aborted };
}

module.exports = { runAgent, buildSystemPrompt, agentCfg };
