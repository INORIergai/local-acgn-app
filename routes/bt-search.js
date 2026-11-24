// ================================================================
// routes/bt-search.js —— round173h 阶段4 内容闭环：BT 搜索 + 夸克离线任务
//   GET /api/bt/search?kw=&source=    用 BT 源（AnimeGarden 等）搜带磁力的种子
//   GET /api/bt/sources               列出可用 BT 源
//   GET /api/bt/quark-tasks           夸克离线任务列表（只读）
//   POST /api/bt/quark-offline        推送磁力到夸克离线（探测性，失败如实报）
//
//   ★ 本应用只做「搜索 + 展示磁力 + 复制」，不下载种子内容、不托管资源。
//     下载交给用户自己的下载器/网盘；自动入库由 dir-watch 完成。
// ================================================================

const express = require('express');
const router = express.Router();
const engine = require('../utils/media-sources/engine');

router.get('/sources', (req, res) => {
    try {
        const list = engine.loadSources()
            .filter(s => s.kind === 'bt')
            .map(s => ({ id: s.id, name: s.name, tier: s.tier }));
        res.json({ code: 0, data: list });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/search', async (req, res) => {
    try {
        const kw = String(req.query.kw || req.query.q || '').trim();
        if (!kw) return res.json({ code: 0, data: [] });
        const only = String(req.query.source || '').trim();
        const timeout = Math.min(30000, Math.max(5000, Number(req.query.timeout) || 15000));
        let sources = engine.loadSources().filter(s => s.kind === 'bt');
        if (only) sources = sources.filter(s => s.id === only || s.name === only);
        const out = [];
        for (const s of sources) {
            let r = null;
            // ★ 冷启动时 EXE 在跑全库扫描/补封面，首次请求容易超时——失败重试一次（间隔 800ms）
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    r = await engine.searchOn(s, kw, { timeout });
                    if (r && (r.items || []).length) break;
                } catch (e) { /* 单源失败不影响其它源 */ }
                if (attempt === 0) await new Promise(res => setTimeout(res, 800));
            }
            for (const it of ((r && r.items) || [])) {
                out.push({
                    title: it.name,
                    magnet: it.magnet || it.url || '',
                    size: it.size || '',
                    date: it.date || '',
                    sourceName: s.name
                });
            }
        }
        // 按日期倒序（新番优先），去重
        const seen = new Set();
        const clean = out.filter(x => { const k = x.magnet || x.title; if (seen.has(k)) return false; seen.add(k); return true; });
        res.json({ code: 0, data: clean, query: kw });
    } catch (e) { res.json({ code: -1, msg: e.message, data: [] }); }
});

router.get('/quark-tasks', async (req, res) => {
    try {
        const QuarkCrawler = require('../utils/crawler/quark');
        const q = new QuarkCrawler();
        if (!q.loggedIn) return res.json({ code: -1, msg: '夸克未登录' });
        const r = await q._get('/task/list', { page: 1, size: 20 });
        const tasks = ((r.data && r.data.list) || []).map(t => ({
            taskId: t.task_id,
            title: (t.display_info && t.display_info.task_title) || t.task_title || '离线任务',
            status: t.status,
            progress: (t.display_info && t.display_info.progress_hint) || t.progress || 0,
            createdAt: t.created_at
        }));
        res.json({ code: 0, data: tasks });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/quark-offline', async (req, res) => {
    try {
        const magnet = String(req.body.magnet || '').trim();
        if (!/^magnet:/i.test(magnet)) return res.json({ code: -1, msg: '需要 magnet 链接' });
        const QuarkCrawler = require('../utils/crawler/quark');
        const q = new QuarkCrawler();
        if (!q.loggedIn) return res.json({ code: -1, msg: '夸克未登录' });
        // 夸克离线推送路径随版本变化，先试主流路径；失败如实返回让前端提示用户手动转存
        let lastErr = '';
        for (const p of ['/task/push', '/task/add']) {
            try {
                const r = await q._post(p, { task_url: magnet, pdir_fid: String(req.body.pdirFid || '0') });
                return res.json({ code: 0, data: r, path: p });
            } catch (e) { lastErr = e.message; }
        }
        res.json({ code: -1, msg: '夸克离线推送不可用（' + lastErr.slice(0, 80) + '），请复制磁力到夸克手动转存' });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
