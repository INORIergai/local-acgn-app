// ================================================================
// routes/acg.js —— ACG 热度榜接口（round33）
//   GET  /api/acg/rank?source=acghub|fankuhub|all&force=1
//   GET  /api/acg/cover?u=<图片URL>          —— 封面本地缓存代理
//   POST /api/acg/refresh                     —— 强制刷新缓存
// ================================================================

const express = require('express');
const router = express.Router();
const acg = require('../utils/acg-rank');

// 榜单：单个来源或全部；round42 支持 period=day|month|year（走 AniList 高清源）
// v1.3 四类榜：cat=manga|novel → AniList 漫画/轻小说；cat=gal → VNDB galgame（sort=rating|votes）
router.get('/rank', async (req, res) => {
    try {
        const source = (req.query.source || 'all').toString();
        const period = (req.query.period || 'week').toString();
        const cat = (req.query.cat || 'anime').toString();
        const force = req.query.force === '1' || req.query.force === 'true';
        if (cat === 'manga' || cat === 'novel') {
            // r46：人气/高分双口径走 Bangumi 书籍榜（bgm 网页标题即中文，AniList 池被风控弃用）
            const sort = req.query.sort === 'score' ? 'score' : 'heat';
            const r = await acg.getRank('bgmbook:' + cat + ':' + sort, { force });
            return res.json({ code: 0, data: r });
        }
        if (cat === 'gal') {
            // round46：sort=cngal → CnGal 精选；daily 走 /daily；其余 rating|votes 走 VNDB
            if (req.query.sort === 'cngal') {
                const r = await acg.getRank('cngal:hot', { force });
                return res.json({ code: 0, data: r });
            }
            const sort = req.query.sort === 'votes' ? 'votes' : 'rating';
            const r = await acg.getRank('vndb:' + sort, { force });
            return res.json({ code: 0, data: r });
        }
        if (['day', 'month', 'year'].includes(period)) {
            const r = await acg.getRank('anilist:' + period, { force });
            return res.json({ code: 0, data: r });
        }
        if (source === 'all') {
            const r = await acg.getBoth({ force });
            return res.json({ code: 0, data: r.data, errors: r.errors });
        }
        if (source !== 'acghub' && source !== 'fankuhub') {
            return res.json({ code: -1, msg: '未知榜单来源：' + source });
        }
        const r = await acg.getRank(source, { force });
        res.json({ code: 0, data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 封面代理（本地缓存）
router.get('/cover', async (req, res) => {
    try {
        const u = (req.query.u || '').toString();
        if (!/^https?:\/\//i.test(u)) {
            return res.status(400).json({ code: -1, msg: '图片地址无效' });
        }
        const r = await acg.getCover(u);
        const ext = (u.match(/\.(webp|png|jpe?g|gif)(\?|$)/i) || [])[1] || 'img';
        const mime = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[ext] || 'image/*';
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(r.bytes);
    } catch (e) {
        res.status(502).json({ code: -1, msg: '封面抓取失败：' + e.message });
    }
});

// 详情（round34 批次B）：榜单条目点开 → 应用内详情弹窗
// v1.3：source=anilist 支持 type=manga|novel（漫画/轻小说）；source=vndb 走 VNDB kana
// round46：条目带 bgmId 时优先走 Bangumi 详情（中文简介/中文链接），失败回退原源
router.get('/detail', async (req, res) => {
    try {
        const source = (req.query.source || '').toString();
        const id = (req.query.id || '').toString();
        const scope = (req.query.scope || '').toString();
        const type = (req.query.type || '').toString();
        const bgmId = (req.query.bgmId || '').toString();
        if (!id) return res.json({ code: -1, msg: '缺少 id' });
        let d = null;
        const bgmErr = [];
        if (bgmId && (source === 'anilist' || source === 'vndb')) {
            try { d = await acg.fetchBgmDetail(bgmId); } catch (e) { bgmErr.push(e.message); }
        }
        if (!d) {
            d = source === 'bgm'
                ? await acg.fetchBgmDetail(id)
                : source === 'fankuhub'
                ? await acg.fetchFankuDetail(id)
                : source === 'anilist'
                    ? await acg.fetchAnilistDetail(id, type || (scope === 'novel' ? 'novel' : scope === 'manga' ? 'manga' : 'anime'))
                    : source === 'vndb'
                        ? await acg.fetchVndbDetail(id)
                        : source === 'cngal'
                            ? await acg.fetchCngalDetail(id)
                            : await acg.fetchAcghubDetail(id, scope);
        }
        res.json({ code: 0, data: d });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// galgame 每日推荐（v1.3 四类榜）：VNDB 高分池按日期轮换，GET /api/acg/daily?force=1
router.get('/daily', async (req, res) => {
    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const r = await acg.getGalDaily({ force });
        res.json({ code: 0, data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 强制刷新
router.post('/refresh', async (req, res) => {
    try {
        const r = await acg.getBoth({ force: true });
        res.json({ code: 0, data: r.data, errors: r.errors });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== 新番放送时间表（round36 P0-2） ==========
// GET /api/acg/calendar?force=1 → { source, days:[{date,label,items:[{title,episode,airingAt,cover,source}]}] }
router.get('/calendar', async (req, res) => {
    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const data = await require('../utils/acg-calendar').getCalendar(force);
        res.json({ code: 0, data });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
