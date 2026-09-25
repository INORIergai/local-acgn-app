/**
 * 「在线观看」页用的探测接口。
 *
 * 只做一件事：告诉前端某个站点能不能被 iframe 内嵌。
 * 为什么要服务端探：浏览器里读不到跨域的 X-Frame-Options，等 iframe 白屏才发现太晚。
 *
 * 安全：URL 必须落在白名单域名内（这个接口会带着代理去请求任意外站，不限就只能打内网了）。
 */
const express = require('express');
const router = express.Router();
const { Request } = require('../utils/crawler/base');

// ============================================================
// 站点注册表已抽到 ./webview-sites.js —— 整站反代（webview-proxy）要共用同一份，
// 分开维护迟早会出现「代理认得的域名」和「抓取认得的域名」不一致的白名单漏洞。
// 背景：**每个站一串地址，直连能通的排前面，官方域名垫底**。逐级切换，结果缓存 5 分钟。
// （实测：91动漫 的 91dongman.net 从容器直连是 000，而 284.iffuglfyc.com / 9ed.nodgswul.cc 直连 200，
//   所以「地址级备份 + 直连优先」是真能省掉代理的，不是心理安慰。）
// ============================================================
const { SITES, LIST_SELECTORS, SCENE_SELECTORS, hostAllowed } = require('./webview-sites');

// 地址探测结果缓存：key -> { url, at }
const addrCache = new Map();
const ADDR_TTL = 5 * 60 * 1000;

// ★ 探测必须走代理：本文件用的是 **Node 全局 fetch（undici）**，它只认 `dispatcher`。
//   （历史坑：utils/crawler/base.js 的 `new Request()` 走 node-fetch v3 + HttpsProxyAgent，
//    而 v3 删了 agent 选项 ⇒ 那个代理是 no-op，探测实际是直连。）
//   这些站的域名在本机 DNS 被污染，直连要卡满 12 秒超时，冷启动整整慢一拍。
const { ProxyAgent } = require('undici');
let _probeDispatcher = null;
function probeDispatcher() {
  const px = config.network?.proxyServer;
  if (!px) return undefined;
  if (!_probeDispatcher) _probeDispatcher = new ProxyAgent(px);
  return _probeDispatcher;
}

/**
 * 逐级探测，返回第一个通的地址。
 * 全都探不通时**不要直接 判死**：Cloudflare 站（jable/hanime1）的普通 HTTP 探测本来就常失败，
 * 但容器里的真浏览器过得去 —— 所以退而返回第一个地址（best-effort），交给浏览器试。
 */
async function resolveSite(key, force = false) {
  const site = SITES[key];
  if (!site) return null;
  const hit = addrCache.get(key);
  if (!force && hit && Date.now() - hit.at < ADDR_TTL) return hit.url;

  // 只有一个地址的站（javmenu / netflav / onejav / jable / porndude …）不值得探：
  // 探到的必然是同一个地址，白等一轮超时。
  if (site.addrs.length === 1) {
    addrCache.set(key, { url: site.addrs[0], at: Date.now() });
    return site.addrs[0];
  }

  for (const addr of site.addrs) {
    try {
      const r = await fetch(addr, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
        redirect: 'manual',
        dispatcher: probeDispatcher(),
        signal: AbortSignal.timeout(12000),
      });
      if (r.status < 400) {
        addrCache.set(key, { url: addr, at: Date.now() });
        return addr;
      }
    } catch (e) { /* 试下一个 */ }
  }

  // 全都没通：先挑一个「看起来最可能」的地址让浏览器试，并记短缓存（1 分钟）避免反复探
  const fallback = site.addrs[0];
  addrCache.set(key, { url: fallback, at: Date.now() - ADDR_TTL + 60000 });
  return fallback;
}

/**
 * ★ 板块归属（第 16 轮）：把「在线观看」拆成四个板块，每个板块只显示自己那组站点。
 *   av     —— AV在线观看（原「在线观看」）
 *   anime  —— 动漫在线观看
 *   comic  —— 漫画在线观看
 *   hanime —— 里番在线观看
 * 放在这里而不是 webview-sites.js，是为了让站点表保持「只描述站点本身」的单一职责。
 */
const BOARD_OF = {
  javbus: 'av', jable: 'av', javmenu: 'av', netflav: 'av', onejav: 'av', porndude: 'av',
  dongman: 'hanime', hanime1: 'hanime', hanimetv: 'hanime',
  cycanime: 'anime',
  moxmoe: 'comic', komiic: 'comic', manhuagui: 'comic', wenku8: 'comic'
};

router.get('/sites', (req, res) => {
  res.json({
    code: 0,
    data: Object.entries(SITES).map(([key, s]) => ({
      key,
      name: s.name,
      addrs: s.addrs,
      listPath: s.listPath || null,
      canList: !!s.listPath,
      canSearch: !!s.searchPath,
      // proxy=true 的站点支持「整站反代」，可以真正在应用内完整使用（含登录、翻页、播放）
      canProxy: !!s.proxy,
      // 分类快捷入口：站点预设的常见分类路径（前端画成按钮）
      categories: s.categories || [],
      // 整站模式的首页入口（有的站首页不在 / —— porndude 的中文首页在 /zh）
      entryPath: s.entryPath || null,
      // 板块归属：前端按它过滤站点栏与标签
      board: BOARD_OF[key] || 'av'
    }))
  });
});

/** 前端开标签时调这个：拿「当前可用的地址 + 能不能内嵌」 */
router.get('/site', async (req, res) => {
  const key = String(req.query.key || '');
  const site = SITES[key];
  if (!site) return res.json({ code: -1, msg: '未知站点' });

  const url = await resolveSite(key, req.query.force === '1');
  const probe = await probeFrameable(url);
  return res.json({ code: 0, data: { key, name: site.name, url, canList: !!site.listPath, ...probe } });
});

/**
 * 探测一个 URL 能不能被内嵌。抽出来是因为 /site 和 /frameable 都要用。
 * 探测失败 ≠ 站点禁止内嵌：网络抖动很常见，失败时回 unknown，让前端照样放 iframe。
 */
async function probeFrameable(targetUrl) {
  let lastErr = '';
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
        redirect: 'manual',
        dispatcher: probeDispatcher(),
        signal: AbortSignal.timeout(15000),
      });
      const xfo = r.headers.get('x-frame-options') || '';
      const csp = r.headers.get('content-security-policy') || '';
      const frameAncestors = /frame-ancestors/i.test(csp);
      const challenged = /Just a moment|challenges\.cloudflare\.com/i.test(csp)
        || (r.status === 403 && /Just a moment/i.test(await r.text().catch(() => '')));
      const blockedByCsp = frameAncestors && !/frame-ancestors[^;]*'self'[^;]*$/.test(csp);

      let reason = '';
      if (challenged) reason = '站点被 Cloudflare 人机验证挡住（403），只有真实浏览器能过';
      else if (xfo) reason = `站点声明了 X-Frame-Options: ${xfo.replace(/\s+/g, '')}，浏览器禁止它被别的网站内嵌`;
      else if (blockedByCsp) reason = '站点的 CSP 里禁止被内嵌（frame-ancestors）';

      return { frameable: !reason, unknown: false, status: r.status, xfo, reason };
    } catch (e) {
      lastErr = e.message;
      if (i === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return { frameable: null, unknown: true, status: 0, reason: `探测失败：${String(lastErr).slice(0, 120)}` };
}

router.get('/frameable', async (req, res) => {
  const target = String(req.query.url || '');
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    return res.json({ code: -1, msg: 'URL 无效' });
  }
  if (!/^https?:$/.test(parsed.protocol) || !hostAllowed(parsed.hostname)) {
    return res.json({ code: -1, msg: '该域名不在允许列表内' });
  }
  return res.json({ code: 0, data: await probeFrameable(parsed.href) });
});

// ============================================================
// 「不内嵌、直接在应用里播」三件套：列表 → 解析流地址 → 流代理
// 站点不让 iframe，但容器里有真浏览器，所以让浏览器去开页面、把它的 .m3u8 嗅出来。
// ============================================================
const crypto = require('crypto');
const { Readable } = require('stream');
const { chromium } = require('playwright');
const config = require('../utils/config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 流代理的凭据：进程级随机密钥，重启即失效 —— 不用管配置和泄漏，
// 换来的是「代理只肯转发本服务刚解析出来的地址」，别人拿不到签名就用不了。
const STREAM_SECRET = crypto.randomBytes(32);
const signStream = (url, ref) => crypto.createHmac('sha256', STREAM_SECRET).update(`${url}|${ref}`).digest('hex').slice(0, 16);
const b64u = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const streamUrl = (url, ref) => `/api/webview/stream?u=${b64u(url)}&ref=${b64u(ref)}&sig=${signStream(url, ref)}`;

function pipeBody(body, res) {
  if (body && typeof body.pipe === 'function') return body.pipe(res);          // node-fetch / node 流
  if (body && typeof body.getReader === 'function') return Readable.fromWeb(body).pipe(res);
  return res.end();
}

/**
 * 浏览器：用**持久化 profile**（cookie/localStorage 落盘在 /app/cache/browser-profile），
 * 这样站点的登录态、Cloudflare 通行证能留到下次，不用每次都重新过挑战。
 * 同一个 profile 不能被两个 Chromium 同时打开，所以这里用一条 Promise 队列串行化。
 */
const PROFILE_DIR = '/app/cache/browser-profile';
let browserQueue = Promise.resolve();

/**
 * 代理可用性（带 30 秒缓存）。
 *
 * 【为什么必须探】宿主代理（clash 之类）会不定期抽风，端口直接 ECONNREFUSED。
 * 【为什么不通时要报错而不是直连】实测这些站点的域名在本机 DNS 被污染：
 *     javbus.com   -> 157.240.9.36   (Meta 的段)
 *     netflav.com  -> 108.160.166.57 (Dropbox)
 *     javmenu.com  -> 74.86.17.48    (SoftLayer)
 * 直连会连到不相干的服务器并卡满超时，比直接失败还慢，而且把「代理没开」
 * 这个真实原因伪装成「站点故障」。所以：代理不通 → 明确告知用户去开代理。
 */
let proxyOk = { at: 0, ok: false };
const PROXY_PROBE_TTL = 30 * 1000;

async function proxyUsable() {
  const px = config.network?.proxyServer;
  if (!px) return null;
  if (Date.now() - proxyOk.at < PROXY_PROBE_TTL) return proxyOk.ok ? px : null;

  let ok = false;
  try {
    const u = new URL(px);
    const net = require('net');
    ok = await new Promise((resolve) => {
      const s = net.connect(Number(u.port), u.hostname, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(3000, () => { s.destroy(); resolve(false); });
    });
  } catch (e) { ok = false; }

  proxyOk = { at: Date.now(), ok };
  if (!ok) console.log(`[在线观看] 代理 ${px} 连不上 —— 站点域名 DNS 被污染，没有代理取不到内容`);
  return ok ? px : null;
}

/** 代理不通时统一的报错文案（前端会把它显示在 pane 里） */
function noProxyError() {
  const px = (config.network && config.network.proxyServer) || '(未配置)';
  return `无法访问：站点域名需要走宿主代理 ${px}，但该代理当前连不上。` +
    `请检查代理软件是否已启动、端口是否为 ${px.split(':').pop()}。`;
}

function withBrowser(fn) {
  const run = async () => {
    const proxyServer = await proxyUsable();
    if (!proxyServer) throw new Error(noProxyError());
    const opts = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      userAgent: UA,
      viewport: { width: 1366, height: 800 },
      locale: 'zh-TW',
      proxy: { server: proxyServer }
    };
    try { require('fs').mkdirSync(PROFILE_DIR, { recursive: true }); } catch (e) { /* 已存在 */ }
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts);
    try {
      return await fn(ctx);
    } finally {
      await ctx.close().catch(() => {});
    }
  };
  const p = browserQueue.then(run, run);
  browserQueue = p.catch(() => {});
  return p;
}

/** 兼容旧调用：拿到一个 context 供内部使用（用完自己关，由 withBrowser 统一管理） */
async function launchBrowser() {
  const proxyServer = await proxyUsable();
  if (!proxyServer) throw new Error(noProxyError());
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    proxy: { server: proxyServer }
  };
  const browser = await chromium.launch(opts);
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 800 }, locale: 'zh-TW' });
  return { browser, context };
}

/** 等 Cloudflare 挑战自己过 */
async function waitChallenge(page, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await page.title().catch(() => '');
    if (t && !/just a moment|attention required/i.test(t)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

// 各站列表页的卡片选择器定义在文件上方（紧挨 SITES，改地址/选择器只动那两处）。

router.get('/list', async (req, res) => {
  const key = String(req.query.site || 'jable');
  const site = SITES[key];
  if (!site) return res.json({ code: -1, msg: `未知站点: ${key}` });
  if (!site.listPath) return res.json({ code: -1, msg: `${site.name} 没配列表页（只能嵌或新标签打开）` });

  const addr = await resolveSite(key);
  if (!addr) return res.json({ code: -1, msg: `${site.name} 的所有地址都连不上` });

  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = String(req.query.q || '').trim().slice(0, 80);
  const customPath = String(req.query.path || '').trim();

  const bare = addr.replace(/\/$/, '');
  let listUrl;

  if (q) {
    // 搜索：站点没配 searchPath 就说清楚，别静默返回首页当结果
    if (!site.searchPath) return res.json({ code: -1, msg: `${site.name} 不支持应用内搜索` });
    const sp = site.searchPath.replace('{q}', encodeURIComponent(q));
    listUrl = bare + sp + (page > 1 ? (sp.includes('?') ? '&' : '?') + 'page=' + page : '');
  } else if (customPath) {
    // 分类/自定义路径：只允许站内相对路径，避免被当成跳板
    if (/^https?:/i.test(customPath) || customPath.startsWith('//')) {
      return res.json({ code: -1, msg: '分类路径必须是站内相对路径' });
    }
    const cp = customPath.startsWith('/') ? customPath : '/' + customPath;
    listUrl = bare + cp + (page > 1 ? (cp.includes('?') ? '&' : '?') + 'page=' + page : '');
  } else {
    // 分页方式各站不同：jable 是路径式 /new-release/2/，其余按 ?page=N 拼
    listUrl = page > 1
      ? (site.pageStyle === 'path'
        ? `${bare}${site.listPath.replace(/\/$/, '')}/${page}/`
        : `${bare}${site.listPath}${site.listPath.includes('?') ? '&' : '?'}page=${page}`)
      : bare + site.listPath;
  }

  // 按场景挑选择器：搜索/分类页的结构可能和首页不同（onejav 就是典型）
  const scene = q ? 'search' : (customPath ? 'cat' : 'list');
  const sel = SCENE_SELECTORS[`${key}:${scene}`] || LIST_SELECTORS[key] || {};
  return withBrowser(async (context) => {
    try {
      const page_ = await context.newPage();
      const base = new URL(addr).origin;

    // 先过首页拿 cf 通行证，再进列表页（直接开列表页会停在挑战页）
    await page_.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitChallenge(page_))) throw new Error('列表页没过 Cloudflare 挑战');
    await page_.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitChallenge(page_, 12000);

    // 往下滚几次把「加载更多/无限滚动/懒加载封面」带出来。
    // 只抓第一页是用户反馈过的问题；滚不够则懒加载封面取不到（netflav 实测 60 格里会错 53 格）。
    for (let i = 0; i < 6; i++) {
      await page_.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page_.waitForTimeout(1200);
    }
    // 再等一轮图片解码，然后回顶部
    await page_.waitForTimeout(1500);
    await page_.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    const items = await page_.evaluate(({ cardSel, linkSel, imgSel, titleSel, limit }) => {
      const out = [];
      const seen = new Set();
      const seenTitle = new Set();
      const norm = (s) => String(s || '').replace(/\s+/g, '').slice(0, 40);
      // 封面取值的优先级：data-src（懒加载真图）> data-original > src。
      // 有的站（netflav 首页）src 是 data:base64 占位，真图只在 data-src 上。
      const pickCover = (img) => {
        if (!img || !img.getAttribute) return '';
        const cands = [
          img.getAttribute('data-src'),
          img.getAttribute('data-original'),
          img.getAttribute('data-lazy-src'),
          img.getAttribute('data-echo'),
          img.getAttribute('src')
        ];
        for (const c of cands) {
          if (c && !/^data:image/i.test(c)) return c;
        }
        return cands.find(Boolean) || '';
      };

      const push = (href, img, box, a) => {
        if (!href || seen.has(href)) return;
        const cover = pickCover(img);
        if (!cover) return;
        // 排掉导航/logo/占位图这类不是封面的东西
        if (/logo|placeholder|banner|avatar|icon|sprite|button_logo|favicon|website_building|data:image/i.test(cover)) return;
        const text = (box.innerText || '').replace(/\s+/g, ' ').trim();
        let title = ((a && a.getAttribute('title')) || '').trim();
        if (!title && titleSel) {
          const tn = box.querySelector(titleSel) || (a && a.querySelector && a.querySelector(titleSel));
          if (tn) title = (tn.innerText || '').trim();
        }
        if (!title) {
          const tn = box.querySelector('.dm-card__title, .card-title, .thumbnail-text, h3, h4');
          if (tn) title = (tn.innerText || '').trim();
        }
        if (!title) title = text;
        if (title.length < 4) return;
        const key = norm(title);
        if (key && seenTitle.has(key)) return;        // 同一部片常有多个链接，按标题去重
        seen.add(href);
        if (key) seenTitle.add(key);
        out.push({
          href,
          cover,
          title: title.slice(0, 120),
          duration: (text.match(/\d{1,2}:\d{2}:\d{2}/) || [''])[0]
        });
      };

      if (cardSel) {
        for (const box of document.querySelectorAll(cardSel)) {
          const a = linkSel ? box.querySelector(linkSel) : box;
          if (!a || !a.getAttribute) continue;
          // 图片按 imgSel 精细挑选（javmenu 要用 :not([alt="watermark"]) 跳过水印图）；
          // 没配 imgSel 时取卡片里第一个 / 卡片自身里的图。
          let img = imgSel ? box.querySelector(imgSel) : box.querySelector('img');
          // 卡片是 <a> 且图是它的兄弟/子节点时，往上兜一层（onejav 的 a 里有 img，正常走上面）
          if (!img && a.querySelector) img = a.querySelector('img');
          push(a.getAttribute('href') || '', img, box, a);
          if (out.length >= limit) break;
        }
        return out;
      }

      // 通用兜底：带图的目标页链接（排掉登录/标签/图片直链这类）
      const bad = /(login|register|signup|\/user|\/tag|\/tags|\/category|\/categories|\/search|javascript:|^#|t\.me|theporndude)/i;
      for (const a of document.querySelectorAll('a')) {
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('#') || bad.test(href)) continue;
        const img = a.querySelector('img');
        if (!img) continue;
        const box = a.closest('div') || a;
        if ((box.innerText || '').trim().length < 4) continue;
        push(href, img, box, a);
        if (out.length >= limit) break;
      }
      return out;
    }, { ...sel, limit });

    const data = items
      .slice(0, limit)
      .map((i) => ({
        ...i,
        href: i.href.startsWith('http') ? i.href : base + i.href,
        // 封面也走签名代理：很多站的 CDN 有防盗链，浏览器直接 <img> 拿不到（实测全白）
        cover: streamUrl(i.cover, base + '/')
      }));

    return res.json({ code: 0, data: { site: key, addr, page, q: q || null, path: customPath || null, count: data.length, items: data } });
    } catch (e) {
    return res.json({ code: -1, msg: e.message });
    }
    });
    });

    /** 打开影片页，嗅探真正的流地址，返回可直接播放的（已签名的）代理地址 */
    router.get('/resolve', async (req, res) => {
    const target = String(req.query.url || '');
    let parsed;
    try {
    parsed = new URL(target);
    } catch (e) {
    return res.json({ code: -1, msg: 'URL 无效' });
    }
    if (!/^https?:$/.test(parsed.protocol) || !hostAllowed(parsed.hostname)) {
    return res.json({ code: -1, msg: '该域名不在允许列表内' });
    }

    return withBrowser(async (context) => {
    try {
    const page = await context.newPage();
    const hits = [];
    page.on('request', (r) => {
      const u = r.url();
      if (/\.m3u8(\?|$)/i.test(u) || (/\.mp4(\?|$)/i.test(u) && !/thumb|preview|\.medium\./i.test(u))) hits.push(u);
    });

    await page.goto(parsed.origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitChallenge(page, 12000);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitChallenge(page, 10000);

    // 有的站不点一下不拉流
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.play && v.play().catch(() => {}); }
    }).catch(() => {});

    for (let i = 0; i < 15 && !hits.some((u) => /\.m3u8/i.test(u)); i++) await page.waitForTimeout(1000);

    const stream = hits.find((u) => /\.m3u8/i.test(u)) || hits[0];
    if (!stream) {
      return res.json({ code: -1, msg: '没嗅到视频流（可能需要在页面上先通过验证，或这条只有预览片段）' });
    }

    const ref = parsed.origin + '/';
    return res.json({
      code: 0,
      data: { url: streamUrl(stream, ref), raw: stream, referer: ref, kind: /\.m3u8/i.test(stream) ? 'hls' : 'video' }
    });
    } catch (e) {
    return res.json({ code: -1, msg: e.message });
    }
    });
    });

/**
 * 流代理：只转发「本服务刚签名过的地址」。
 * m3u8 里的分片和密钥都要重写成再走这里 —— 密钥 URI 常是**相对名**且伪装成 .ts，
 * 只替换绝对 URL 会漏掉它，播放会在解密那一步卡死。
 */
router.get('/stream', async (req, res) => {
  const target = unb64u(req.query.u || '');
  const ref = unb64u(req.query.ref || '');
  if (!/^https?:\/\//.test(target)) return res.status(400).json({ code: -1, msg: '地址无效' });
  if (req.query.sig !== signStream(target, ref)) {
    return res.status(403).json({ code: -1, msg: '链接签名无效或已过期（服务重启后需重新解析）' });
  }

  try {
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (ref) {
      headers.Referer = ref;
      headers.Origin = ref.replace(/\/$/, '');
    }
    if (req.headers.range) headers.Range = req.headers.range;

    const resp = await fetch(target, { headers, redirect: 'follow' });
    if (!resp.ok && resp.status !== 206) {
      return res.status(resp.status).json({ code: -1, msg: `上游返回 HTTP ${resp.status}` });
    }

    const ctype = resp.headers.get('content-type') || '';
    if (/mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(target)) {
      const text = await resp.text();
      const rewrite = (line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          // #EXT-X-KEY / #EXT-X-MAP 里的 URI 可能是相对名，必须一起代理
          return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${streamUrl(new URL(uri, target).href, ref)}"`)
            .replace(/https?:\/\/[^\s",]+/g, (abs) => streamUrl(abs, ref));
        }
        return streamUrl(new URL(t, target).href, ref);
      };
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(text.split('\n').map(rewrite).join('\n'));
    }

    res.status(resp.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = resp.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    pipeBody(resp.body, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ code: -1, msg: e.message });
    else res.end();
  }
});

// 整站反代（webview-proxy.js）复用同一套地址探测 + 5 分钟缓存：
// 它自己再探一遍是浪费，而且两边探到的镜像可能不同，会导致 cookie 罐串味。
module.exports = router;
module.exports.resolveSite = resolveSite;
// P1-b：CF 挑战站的反代回退要复用这个持久 Chromium（已带代理 + 挑战通行证）
module.exports.withBrowser = withBrowser;
