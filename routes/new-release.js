/**
 * 新作监视 API
 * ============================================================
 *   GET  /api/new-release/timeline  近一月新作时间线（女优 + 漫画）
 *   GET  /api/new-release/actresses 顶部可点击的女优名（含近一月新作数）
 *   GET  /api/new-release/status    监视任务运行状态
 *   POST /api/new-release/check     触发检查 { scope: all|actress|comic, actressId, resetCursor }
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getChecker } = require('../utils/new-release-checker');
const { getChecker: getComicChecker } = require('../utils/comic-new-release');
const { downloadPoster, getPosterCacheName } = require('../utils/poster-fetcher');
const {
    getNotificationsByTypes,
    getNotificationActresses,
    getNotificationById,
    updateNotificationCover,
} = require('../utils/db');

const WINDOW_DAYS = 30;
const POSTER_DIR = path.resolve(__dirname, '../cache/posters');
const TYPE_MAP = {
    new_release: 'jav',
    comic_new_release: 'comic',
    novel_new_release: 'novel',
};

/** 把通知行补成前端好用的结构 */
function shapeNotification(n) {
    let extra = {};
    try { extra = JSON.parse(n.extra || '{}'); } catch (e) { extra = {}; }
    return {
        id: n.id,
        type: n.type,
        kind: TYPE_MAP[n.type] || 'other',
        title: n.title || '',
        content: n.content || '',
        url: n.url || '',
        cover: n.cover || '',
        read: n.read,
        createdAt: n.createdAt || 0,
        avid: extra.avid || '',
        actress: extra.actress || '',
        actressId: extra.actressId || null,
        actressAvatar: extra.actressAvatar || '',
        releaseDate: extra.releaseDate || '',
        dateSource: extra.dateSource || 'unknown',
        comicTitle: extra.comicTitle || '',
        comicId: extra.comicId || null,
        seriesName: extra.seriesName || extra.seriesKey || '',
        volume: extra.volume || '',
        source: extra.source || '',
    };
}

/**
 * 近一月时间线
 * ?kind=all|jav|comic|novel &days=30 &limit=600
 */
router.get('/timeline', (req, res) => {
    try {
        const kind = String(req.query.kind || 'all');
        const days = Math.min(Math.max(Number(req.query.days) || WINDOW_DAYS, 1), 365);
        const limit = Math.min(Math.max(Number(req.query.limit) || 800, 1), 3000);
        const since = Date.now() - days * 24 * 60 * 60 * 1000;

        const types = kind === 'all'
            ? ['new_release', 'comic_new_release', 'novel_new_release']
            : Object.keys(TYPE_MAP).filter(k => TYPE_MAP[k] === kind);

        const rows = getNotificationsByTypes(types, { since, limit });

        // 时间线排序：优先用「发行日期」（真实发布时间），没有才用入库时间。
        // 这样即使某天批量扫描，时间线依然是按作品发行日从新到旧排的。
        const list = rows.map(shapeNotification).map(n => {
            const ts = n.releaseDate ? new Date(n.releaseDate + 'T00:00:00').getTime() : 0;
            return { ...n, sortTs: ts || n.createdAt };
        }).sort((a, b) => b.sortTs - a.sortTs);

        // 按天分组（前端直接渲染，不用再算）
        const byDay = new Map();
        for (const n of list) {
            const d = new Date(n.sortTs);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key).push(n);
        }
        const groups = [...byDay.entries()].map(([date, items]) => ({
            date,
            label: formatDayLabel(date),
            items,
        }));

        res.json({
            code: 0,
            data: {
                since,
                days,
                kind,
                total: list.length,
                groups,
            },
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/** 近一月有出新作的女优（顶部可点击的那排名字） */
router.get('/actresses', (req, res) => {
    try {
        const days = Math.min(Math.max(Number(req.query.days) || WINDOW_DAYS, 1), 365);
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        const rows = getNotificationActresses(['new_release'], { since, limit: 300 });
        res.json({
            code: 0,
            data: rows.map(r => ({
                name: r.actress,
                actressId: r.actressId,
                count: r.count,
                lastAt: r.lastAt,
            })),
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/** 某位女优近一月的新作 */
router.get('/actress/:id', async (req, res) => {
    try {
        const days = Math.min(Math.max(Number(req.query.days) || WINDOW_DAYS, 1), 365);
        const since = Date.now() - days * 24 * 60 * 60 * 1000;
        const rows = getNotificationsByTypes(['new_release'], { since, limit: 3000 })
            .map(shapeNotification)
            .filter(n => String(n.actressId) === String(req.params.id));
        res.json({ code: 0, data: rows });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/** 状态：两个监视任务跑到哪了 */
router.get('/status', (req, res) => {
    try {
        const a = getChecker();
        const c = getComicChecker();
        res.json({
            code: 0,
            data: {
                movie: { checking: a.checking, cursor: a.cursor, progress: a.progress },
                comic: { checking: c.checking, cursor: c.cursor, progress: c.progress },
            },
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/**
 * 触发检查
 * body: { scope: 'all' | 'actress' | 'comic', actressId, resetCursor, limit }
 */
router.post('/check', async (req, res) => {
    try {
        const { scope = 'all', actressId, resetCursor = false, limit } = req.body || {};
        const movieChecker = getChecker();
        const comicChecker = getComicChecker();

        const started = [];
        if (scope === 'comic') {
            if (comicChecker.checking) return res.json({ code: 0, msg: '漫画检查已在运行中', data: { started: [] } });
            started.push('comic');
        } else if (scope === 'actress') {
            if (movieChecker.checking) return res.json({ code: 0, msg: '女优检查已在运行中', data: { started: [] } });
            started.push('actress');
        } else {
            // all：两个一起跑（各自独立不阻塞）
            if (!movieChecker.checking) started.push('movie');
            if (!comicChecker.checking) started.push('comic');
        }

        res.json({
            code: 0,
            msg: started.length ? `已开始检查：${started.join(' + ')}` : '检查已在运行中',
            data: { started },
        });

        // 后台执行（响应先返回）
        if (scope === 'comic' || scope === 'all') {
            comicChecker.checkAll({ force: true, resetCursor, limit })
                .then(r => console.log('[API] 漫画新作检查完成:', JSON.stringify(r)))
                .catch(e => console.log('[API] 漫画新作检查失败:', e.message));
        }
        if (scope === 'actress') {
            movieChecker.checkAll({ actressId, resetCursor })
                .then(r => console.log('[API] 女优新作检查完成:', JSON.stringify(r)))
                .catch(e => console.log('[API] 女优新作检查失败:', e.message));
        } else if (scope === 'all') {
            movieChecker.checkAll({ resetCursor, limit })
                .then(r => console.log('[API] 女优新作检查完成:', JSON.stringify(r)))
                .catch(e => console.log('[API] 女优新作检查失败:', e.message));
        }
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

/**
 * 封面自愈：老通知里可能残留 javbus 外链封面（浏览器直连 403）。
 * 前端 onerror 打到这里，服务端带正确 Referer 抓一次、落盘、回写 DB、再把图片吐出去。
 * 抓到过就直接走本地文件，不再重复联网。
 */
router.get('/cover/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).end();
    try {
        const row = getNotificationById ? getNotificationById.get(id) : null;
        if (!row) return res.status(404).end();

        // 已经是本地路径：直接转交静态海报路由
        if (row.cover && row.cover.startsWith('/api/movie/poster/')) {
            return res.redirect(row.cover);
        }
        if (!row.cover || !/^https?:\/\//.test(row.cover)) {
            return res.status(404).end();
        }

        const name = getPosterCacheName(row.cover);
        if (!name) return res.status(404).end();
        const savePath = path.join(POSTER_DIR, name);

        if (!fs.existsSync(savePath)) {
            try {
                await downloadPoster(row.cover, savePath);
            } catch (e) {
                console.log(`[封面自愈] #${id} 下载失败:`, e.message);
            }
        }
        if (!fs.existsSync(savePath) || fs.statSync(savePath).size < 1024) {
            return res.status(404).end();
        }

        // 回写 DB，下次直接命中本地
        try { updateNotificationCover.run(`/api/movie/poster/${name}`, id); } catch (e) { /* 忽略 */ }

        res.set('Cache-Control', 'public, max-age=604800');
        return res.sendFile(savePath);
    } catch (e) {
        return res.status(500).end();
    }
});

function formatDayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((today - d) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays === 2) return '前天';
    if (diffDays < 7) return `${diffDays} 天前`;
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${wd}`;
}

module.exports = router;
