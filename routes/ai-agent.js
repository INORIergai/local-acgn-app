/**
 * routes/ai-agent.js —— Agent 运行时接口（SSE + 单步审批 + 轨迹查询）
 * ============================================================================
 * 与旧 /api/ai/chat(/stream) 的分工：
 *   旧接口 = 一次性问答（LangGraph 跑完再回放，兼容老调用方，保持不动）
 *   本接口 = 有界自主 Agent：真流式、单步审批、每步落轨迹，可回放
 *
 * 端点：
 *   POST /api/ai/agent/run      SSE 执行（事件：run/phase/token/step/step_patch/approval/action/done/error）
 *   POST /api/ai/agent/approve  裁决单次审批 { approvalId, approved }
 *   GET  /api/ai/agent/pending  当前待审批列表（页面刷新后仍能找回）
 *   GET  /api/ai/agent/runs     最近运行摘要
 *   GET  /api/ai/agent/runs/:id 单次运行完整轨迹（含每步参数摘要）
 *   GET  /api/ai/agent/jobs     最近后台作业（round136：「最近任务」面板）
 *   POST /api/ai/agent/jobs/:id/cancel  取消作业
 */
'use strict';

const express = require('express');
const router = express.Router();

const approvals = require('../utils/agent/approvals');
const trace = require('../utils/agent/trace');
const { runAgent } = require('../utils/agent/runtime');

router.post('/run', async (req, res) => {
    const body = req.body || {};
    const message = String(body.message || '').trim();
    if (!message) return res.status(400).json({ code: -1, msg: 'message 不能为空' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (ev) => {
        if (res.writableEnded) return;
        try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (e) { /* 客户端已断开 */ }
    };

    // 心跳：审批可能挂 3 分钟，中间没有任何事件时代理层容易掐断
    const hb = setInterval(() => {
        if (res.writableEnded) return;
        try { res.write(': ping\n\n'); } catch (e) { }
    }, 15000);

    const ac = new AbortController();
    let closed = false;
    res.on('close', () => {
        if (res.writableEnded) return;
        closed = true;
        ac.abort();
    });

    try {
        await runAgent({
            message,
            sessionId: body.sessionId || 'main',
            history: Array.isArray(body.history) ? body.history : [],
            hint: body.hint || '',
            onEvent: send,
            signal: ac.signal
        });
    } catch (e) {
        console.error('[Agent] 运行异常:', e.message);
        send({ type: 'error', error: e.message });
    } finally {
        clearInterval(hb);
        if (!closed && !res.writableEnded) res.end();
    }
});

router.post('/approve', (req, res) => {
    const { approvalId, approved, reason } = req.body || {};
    if (!approvalId) return res.json({ code: -1, msg: '缺少 approvalId' });
    const r = approvals.resolve(approvalId, { approved: !!approved, decidedBy: 'user' });
    if (r.status === 'not_found') return res.json({ code: -1, msg: '审批已过期或不存在' });
    if (r.status === 'already') return res.json({ code: 0, msg: '该操作已裁决过', data: { approved: r.approved } });
    console.log(`[Agent] 审批 ${approvalId} → ${r.status}${reason ? '（' + reason + '）' : ''}`);
    res.json({ code: 0, msg: r.status === 'approved' ? '已允许执行' : '已拒绝', data: { status: r.status } });
});

router.get('/pending', (req, res) => {
    res.json({ code: 0, data: approvals.list(req.query.runId || null) });
});

router.get('/runs', (req, res) => {
    const limit = Number(req.query.limit) || 20;
    res.json({ code: 0, data: trace.listRuns(limit) });
});

router.get('/runs/:id', (req, res) => {
    const run = trace.getRun(req.params.id);
    if (!run) return res.json({ code: -1, msg: '没有这次运行的记录' });
    res.json({ code: 0, data: run });
});

/* round136 · 后台作业（批量换海报等）。
 * 为什么单独开端点而不只走 get_job_status 工具：作业可以比对话活得更久
 * （用户关了抽屉、作业还在跑），界面需要一个不依赖某次 run 的查询口。 */
router.get('/jobs', (req, res) => {
    const jobs = require('../utils/agent/jobs');
    const limit = Number(req.query.limit) || 20;
    res.json({ code: 0, data: jobs.list(limit).map(j => jobs.progressOf(j)) });
});

router.post('/jobs/:id/cancel', (req, res) => {
    const jobs = require('../utils/agent/jobs');
    const r = jobs.cancel(req.params.id);
    res.json(r.ok ? { code: 0, msg: r.msg } : { code: -1, msg: r.msg });
});

module.exports = router;
