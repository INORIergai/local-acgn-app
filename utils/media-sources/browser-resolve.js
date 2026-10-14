/**
 * 浏览器兜底取流（round36 批次B）
 * ==================================================================
 * 为什么需要它：绝大多数「免费番剧站」的真播放地址**不在 HTML 里**。
 * 实测 18 个源全部如此：播放页只有一个加密字段（苹果 CMS 的 player_aaaa，
 * encrypt=3），真正解密并拉流的逻辑在**混淆过的播放器 JS**里执行。
 * 纯 HTTP + 正则抽不出来 —— 所以最后一步交给真浏览器：
 *   打开播放页（必要时拼出它的播放器 iframe 页）→ 等 JS 跑 → 监听它实际发出的视频请求。
 *
 * 落点：只抓「地址」，不下载内容。拿到地址后仍由 /api/media-source/stream 代理播放。
 *
 * 两条经验：
 *   1) 播放页本身常被广告脚本跳走（实测跳到百度），所以要**屏蔽广告域**并**优先直接打开播放器页**。
 *   2) 本机代理经常是死的：先直连，打不开再带配置里的代理重试一次。
 */
const { chromium } = require('playwright');
const engine = require('./engine');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VIDEO_RE = /\.(m3u8|mp4|mkv|flv|ts)(\?|$)|mime_type=video|bilivideo|akamaized|\/video\/tos\/|video_m3u8|\/api\/.*(m3u8|play|url=)/i;
// 广告/统计域：放过去只会把页面带跑偏，还会拖慢解析
const AD_RE = /(baidu\.com|google|doubleclick|googlesyndication|adnxs|360buyimg|alicdn|jd\.com|taboola|popads|adsmogo|yandex|umeng|cnzz|googletagmanager|facebook|twitter)/i;

/**
 * 苹果 CMS 系站点：播放页里 player_aaaa 带加密 url + 播放器名（from），
 * 真正的播放器页是 /static/player/{from}/?url={加密串}。
 * 直接打开这个页能绕开播放页的广告跳转，成功率明显更高。
 */
async function playerPageFrom(html, pageUrl) {
    if (!html) return '';
    const data = extractPlayerData(html);
    const from = data && data.from;
    const url = data && data.url;
    if (!from || !url) return '';
    let origin = '';
    try { origin = new URL(pageUrl).origin; } catch (e) { return ''; }

    /* from 往往**不是**播放器页，而是「播放器加载器」：
     * 实测 didahd 的 from=4kvm，而 /static/player/4kvm.js 的内容只是再嵌一个
     * <iframe src="/static/player/artplayer/?url=...">。所以要顺着这层找真正的播放器页，
     * 否则打开的是一个空壳（表现为「页面开了但永远等不到视频请求」）。 */
    let path = `/static/player/${from}/`;
    try {
        const jr = await engine.grab(`${origin}/static/player/${from}.js`, { timeout: 8000 });
        const m = /src\s*=\s*["']([^"']*?)\/\?url=/.exec(jr.text || '');
        if (m && m[1]) path = m[1] + '/';
    } catch (e) { /* 拿不到就用默认路径 */ }
    return `${origin}${path}?url=${encodeURIComponent(url)}`;
}

/**
 * 取 player_aaaa 这个 JSON。
 * ★ 不能偷懒用 /\{[\s\S]*?\}/ —— 它内部还嵌着 vod_data 对象，非贪婪会在第一个 `}` 就收尾，
 *   JSON.parse 直接失败（这条踩过：表现为「浏览器打开了页面却抓不到流」）。
 *   老老实实按花括号配平扫一遍，并跳过字符串里的括号。
 */
function extractPlayerData(html) {
    const key = html.indexOf('player_aaaa');
    if (key < 0) return null;
    const start = html.indexOf('{', key);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length && i < start + 20000; i++) {
        const c = html[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(html.slice(start, i + 1)); }
                catch (e) { return null; }
            }
        }
    }
    return null;
}

/** 等到抓到视频请求（或超时）为止；已经抓到就立刻返回 */
async function waitHit(page, hits, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (hits.size) return true;
        await page.waitForTimeout(500).catch(() => { });
    }
    return hits.size > 0;
}

async function openAndCatch(target, { timeout = 25000, waitMs = 9000, launchArgs = [] } = {}) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required', '--mute-audio', ...launchArgs]
    });
    try {
        const ctx = await browser.newContext({
            userAgent: UA, viewport: { width: 1280, height: 768 }, locale: 'zh-CN', ignoreHTTPSErrors: true
        });
        await ctx.route('**/*', (route) => (AD_RE.test(route.request().url()) ? route.abort() : route.continue()));

        const hits = new Map();
        ctx.on('request', (r) => {
            const u = r.url();
            if (VIDEO_RE.test(u)) {
                hits.set(u, { url: u, ref: (r.headers() || {}).referer || '' });
            }
        });

        const page = await ctx.newPage();
        page.on('popup', (p) => p.close().catch(() => { }));
        let opened = false;
        try {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
            opened = true;
        } catch (e) { /* 超时也继续：可能资源没加载完但视频请求已经发出 */ }
        await page.waitForTimeout(Math.min(4000, waitMs));

        // 播放器常常要等一次用户手势/点击才拉流，这里把常见按钮挨个点一下
        for (const sel of ['.MacPlayer', '#player', '#player-box', '.player-box', 'video', '.dplayer-video-wrap', '.play-btn', '.btn-play']) {
            try { await page.click(sel, { timeout: 800 }); break; } catch (e) { /* 没有就算了 */ }
        }
        try {
            await page.evaluate(() => {
                const v = document.querySelector('video');
                if (v) { v.muted = true; v.play().catch(() => { }); }
            });
        } catch (e) { }
        // 轮询而不是死等：地址一出现就收工，别让用户白等满 7 秒
        await waitHit(page, hits, waitMs);

        // 主页面没抓到 → 播放器可能在 iframe 里，逐个打开子 frame 再等
        if (!hits.size) {
            const frames = page.frames().filter((f) => f !== page.mainFrame() && /^https?:/.test(f.url()));
            // 最多试两个子 frame：再多就要让用户等一分钟了，宁可失败让人换源
            for (const f of frames.slice(0, 2)) {
                if (AD_RE.test(f.url())) continue;
                const p2 = await ctx.newPage();
                try { await p2.goto(f.url(), { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (e) { }
                try {
                    await p2.evaluate(() => {
                        const v = document.querySelector('video');
                        if (v) { v.muted = true; v.play().catch(() => { }); }
                    });
                } catch (e) { }
                await waitHit(p2, hits, waitMs);
                await p2.close().catch(() => { });
                if (hits.size) break;
            }
        }

        // 择优：m3u8（可自适应码率）> mp4 > 其它
        const list = Array.from(hits.values());
        const score = (u) => (/\.m3u8(\?|$)|video_m3u8/i.test(u) ? 3 : /\.(mp4|mkv|flv)(\?|$)/i.test(u) ? 2 : 1);
        list.sort((a, b) => score(b.url) - score(a.url));
        return { opened, hit: list[0] || null, all: list };
    } finally {
        await browser.close().catch(() => { });
    }
}

/**
 * 用浏览器把一个「剧集播放页」解析成真实视频地址。
 * @returns {Promise<{url:string, referer:string, ua:string, via:string}>} 失败时 url 为空串
 */
/** 代理端口能不能连上（1.5 秒判死）：连不上就别让 Chromium 带着它白等一轮 */
function proxyAlive(px) {
    if (!px) return Promise.resolve(false);
    return new Promise((resolve) => {
        try {
            const net = require('net');
            const u = new URL(px);
            const s = net.connect(Number(u.port), u.hostname, () => { s.destroy(); resolve(true); });
            s.on('error', () => resolve(false));
            s.setTimeout(1500, () => { s.destroy(); resolve(false); });
        } catch (e) { resolve(false); }
    });
}

async function resolveByBrowser(pageUrl, opts = {}) {
    const timeout = opts.timeout || 25000;
    const waitMs = opts.waitMs || 7000;

    // 1) 能直接打开播放器页就别开播放页（播放页有广告跳转）
    let target = pageUrl;
    try {
        const r = await engine.grab(pageUrl, { timeout: 12000 });
        const pp = await playerPageFrom(r.text, pageUrl);
        if (pp) target = pp;
    } catch (e) { /* 拿不到就直接用原页 */ }
    if (opts.debug) console.log('[browser-resolve] 目标页:', target);

    // 2) 直连优先；打不开再带代理重试（本机代理经常是死的，但用户环境可能需要它）
    const cfg = require('../config');
    const px = cfg && cfg.network && cfg.network.proxyServer;
    const attempts = [{ args: ['--no-proxy-server'], proxy: null }];
    if (px && await proxyAlive(px)) attempts.push({ args: [], proxy: px });

    let lastErr = '';
    for (const a of attempts) {
        try {
            const r = await openAndCatch(target, { timeout, waitMs, launchArgs: a.args });
            if (r.hit) {
                return {
                    url: r.hit.url,
                    referer: r.hit.ref || target,
                    ua: UA,
                    via: 'browser',
                    from: target
                };
            }
            if (!r.opened) lastErr = '页面打不开';
            else lastErr = '页面已打开，但没等到视频请求（可能要手动点播放，或资源已失效）';
        } catch (e) {
            lastErr = e.message || String(e);
        }
    }
    return { url: '', referer: target, ua: UA, via: 'browser', error: lastErr };
}

module.exports = { resolveByBrowser, playerPageFrom };
