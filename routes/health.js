/**
 * routes/health.js — 环境信息与网络自检（round36 P0-5 / P0-6）
 *
 * GET /api/health/env      → 关于页「构建信息」面板（版本/Electron/OS/库计数/代理），一键复制报 issue 用
 * GET /api/health/network  → 并行探测各刮削/弹幕/在线源，前端启动自检提示条 + 诊断面板共用
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();

const db = require('../utils/db').db;
const config = require('../utils/config');

// ---------- /env ----------
router.get('/env', (req, res) => {
    try {
        let appVersion = 'dev';
        try {
            // exe 形态下由主进程写入 runtime/app-version.json（round31 机制）
            const runtimeDir = process.env.CINEMAVAULT_RUNTIME
                || path.join(process.env.APPDATA || '', 'CinemaVault', 'runtime');
            const vp = path.join(runtimeDir, 'app-version.json');
            if (fs.existsSync(vp)) appVersion = JSON.parse(fs.readFileSync(vp, 'utf8')).version || appVersion;
        } catch (e) { /* 开发树无此文件，用 dev */ }

        const counts = {
            movies: db.prepare('SELECT COUNT(*) c FROM movies').get().c,
            actresses: (() => { try { return db.prepare('SELECT COUNT(*) c FROM actresses').get().c; } catch (e) { return -1; } })(),
            tags: (() => { try { return db.prepare('SELECT COUNT(*) c FROM tags').get().c; } catch (e) { return -1; } })(),
        };
        res.json({
            code: 0,
            data: {
                appVersion,
                electron: process.versions.electron || '-',
                chrome: process.versions.chrome || '-',
                node: process.versions.node || '-',
                platform: `${os.type()} ${os.release()} (${os.arch()})`,
                proxy: config.network?.proxyServer || '',
                danmakuConfigured: !!(config.danmaku?.appId && config.danmaku?.appSecret),
                counts,
            },
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- /network ----------
// 每个探测 6s 超时，全部并行；结果 { name, ok, ms, error }
const PROBES = [
    { name: 'TMDB', url: 'https://api.tmdb.org/3/configuration?api_key=x' },
    { name: 'AniList', url: 'https://graphql.anilist.co' },
    { name: 'Bangumi', url: (config.sources?.bangumi?.apiBase || 'https://api.bgm.tv') + '/calendar' },
    { name: '弹弹play', url: 'https://api.dandanplay.net/' },
    { name: '次元城', url: 'https://www.cycani.org/' },
    { name: '稀饭动漫', url: 'https://www.fanxinzhui.com/' },
];

async function probe(p) {
    const t0 = Date.now();
    try {
        const r = await fetch(p.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36' },
            redirect: 'manual',
            signal: AbortSignal.timeout(6000),
        });
        // 4xx 也算「可达」（TCP+TLS+HTTP 通了；挡在应用层是另一回事）
        return { name: p.name, ok: true, ms: Date.now() - t0, status: r.status };
    } catch (e) {
        return { name: p.name, ok: false, ms: Date.now() - t0, error: String(e.cause?.code || e.message).slice(0, 60) };
    }
}

// 自检结果缓存 3 分钟，避免前端轮询打爆
let netCache = { at: 0, data: null };

router.get('/network', async (req, res) => {
    try {
        if (req.query.force !== '1' && netCache.data && Date.now() - netCache.at < 3 * 60 * 1000) {
            return res.json({ code: 0, data: netCache.data });
        }
        const results = await Promise.all(PROBES.map(probe));
        const data = { results, checkedAt: Date.now(), dead: results.filter(r => !r.ok).map(r => r.name) };
        netCache = { at: Date.now(), data };
        res.json({ code: 0, data });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
