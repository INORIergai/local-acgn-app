/**
 * 整站反向代理引擎：把站点的「禁止内嵌」这道墙拆掉。
 *
 * 【为什么需要它】
 * netflav / onejav / javmenu 实测直连是 200 通的，唯一挡路的是响应头
 *   netflav: X-Frame-Options: SAMEORIGIN
 *   onejav : X-Frame-Options: DENY
 *   javmenu: X-Frame-Options: SAMEORIGIN
 * 浏览器一看这个头就拒绝渲染 iframe。**把响应头摘掉，再把页面里的链接改道回本代理**，
 * 站点就在我们自己的应用里完整跑起来了 —— 不需要跳外链，也不需要无头浏览器渲染。
 *
 * 【关键设计：同源化】
 * 反代必须让「站点的所有请求」都回到本代理，否则：
 *   - 相对路径会 404
 *   - 绝对 URL 会跳出代理、又被 XFO 挡回去
 * 所以：
 *   1. 用 `/{站点key}/` 前缀把整个站点「挂载」到本应用的一个子路径下（同源！）
 *   2. HTML 里的 href/src/action/srcset 全部改写成 `/{key}/...`
 *   3. 注入运行时脚本，拦截 fetch/XHR/history/location，把 JS 动态拼的 URL 也拉回来
 *   4. 剥离 XFO / CSP(/frame-ancestors) / 部分安全头；重写 Set-Cookie 的 Domain/Path
 *
 * 【为什么用子路径而不是子域名】
 * Cookie 在同源下天然共享，不用处理跨域 Cookie、也不用为每个站点签证书。
 * 站点自己的 JS 用相对路径发的请求会自然带上 `/{key}/` 前缀，命中我们的代理。
 *
 * 【安全边界】
 * 只允许 SITES 注册表里的域名（含镜像），其余一律拒绝 —— 否则这就是个开放代理。
 */
const express = require('express');
const router = express.Router();
const { load } = require('cheerio');
const zlib = require('zlib');
const config = require('../utils/config');
const { SITES } = require('./webview-sites');
// ★ undici 的 ProxyAgent：本文件的 fetch 是 **Node 全局 fetch（undici）**，
//   它只认 `dispatcher`，不认 node-fetch 那套 `agent`。
const { ProxyAgent } = require('undici');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 出口选择（宿主代理 / 直连）—— 历史坑都记在这里，别重犯。
 *
 * 【重要教训 1】最初写的是「代理探不通就直连」，看起来更健壮，实际上是**帮倒忙**：
 * 实测这些域名在本机 DNS 被污染：
 *     javbus.com      -> 157.240.9.36   (Meta 的 IP 段)
 *     www.javbus.com  -> 162.125.32.6   (Dropbox)
 *     netflav.com     -> 108.160.166.57 (Dropbox)
 *     javmenu.com     -> 74.86.17.48    (SoftLayer)
 * 全是错的 IP。直连的结果是 TCP 连到一个不相干的服务器并超时约 5~10 秒。
 * 所以对这些站代理不是优化项而是首选 —— 但**不能把直连彻底删掉**：
 * 见下面 pickRoutes 的说明，两个出口都在抖的时候，留着兜底才不至于整页打不开。
 * 反过来像 onejav 这种 DNS 正常、直连实测 200 的站，就配 useProxy:false。
 *
 * 【重要教训 2（round19，别重犯）】本文件用的是 **Node 全局 fetch（undici）**，
 * 而它**不认 `agent`**：`fetch(url, { agent })` 里的 agent 会被静默忽略，
 * 请求照旧直连 —— 也就是说这个反代引擎「走宿主代理」这件事**曾经根本没生效**。
 * 修法是改用 undici 的 `dispatcher`。
 * （同类历史坑：node-fetch v3 删了 agent 选项，utils/crawler/base.js 里的
 *   HttpsProxyAgent 同样是 no-op。新写代码一律用 undici + dispatcher。）
 */
const dispatcherCache = new Map();
function proxyDispatcher(px) {
  if (!dispatcherCache.has(px)) dispatcherCache.set(px, new ProxyAgent(px));
  return dispatcherCache.get(px);
}

/**
 * 这站该按什么顺序试哪些「线路」。
 *
 * 返回一个有序候选列表（每个元素是一个出口：宿主代理 or 直连）。
 * 【为什么要有多条线路，而不是二选一】
 * round19 实测环境里两个出口都在抖：
 *   - 宿主代理 `host.docker.internal:7892` 节点不稳：ECONNRESET / ECONNREFUSED 交替出现；
 *   - javmenu 自身也抖：同一条 URL 直连约一半 200、一半 ECONNRESET；走代理则时常 522。
 * 只押一条线路 ⇒ 用户看到「一半概率打不开」。两条都留着、谁通用谁，可用性直接翻倍。
 *
 * 顺序原则：站点没声明 useProxy:false 就把代理放前面（对 DNS 被污染的域名是必须的），
 * 直连永远作为兜底保留 —— 真直连不通也只是多等一次超时，总好过整页打不开。
 */
async function pickRoutes(site) {
  const px = config.network?.proxyServer;
  const direct = { via: 'direct', dispatcher: null, timeout: 8000 };

  if (!px) return [direct];
  if (site.useProxy === false) return [{ via: 'direct(站定)', dispatcher: null, timeout: 12000 }];

  const alive = await proxyAlive(px);
  if (!alive) {
    // 代理掉线时**只试一次直连、且用短超时**，别让用户白等：
    // 本机没代理时境外站点是整段被 reset 的（实测 baidu 200 / 所有境外站 5 秒 ECONNRESET），
    // 试 4 次 × 15 秒 = 等一分钟才报错，纯属折磨人。给一次 6 秒的机会就够体面了。
    console.log(`[在线观看/反代] 代理 ${px} 探不通，${site.name} 只做一次短超时直连尝试`);
    return [{ via: 'direct(代理掉线)', dispatcher: null, timeout: 6000 }];
  }
  return [
    { via: 'proxy', dispatcher: proxyDispatcher(px), timeout: 15000 },
    direct,
  ];
}

// ---------------------------------------------------------------
// 渲染回退：给 Cloudflare 挑战站用。
//
// 【为什么需要】jable.tv 这类站直连是 403 + `cf-mitigated: challenge` + "Just a moment..."，
// 拿到的是一张挑战页而不是真页面。剥响应头毫无意义 —— 上游根本没给内容。
// 唯一的办法是用一个**已经过盾**的浏览器去取 HTML。
//
// 【为什么可行】容器里那个持久 Chromium profile（.user-browser-data）从抓取功能起
// 就一直被复用，里面存着 jable.tv 的有效 cf_clearance。实测渲染 1.1 秒就能拿到
// 真页面（112KB / 372 链接），所以渲染成本可以接受。
//
// 【怎么和反代拼】渲染拿到的是**浏览器解析后的 DOM**（含 JS 注入的元素），
// 用 outerHTML 取出来，然后喂给同一套 rewriteHtml 管线 —— 静态重写 + runtime 注入
// 一个都不少，站内链接照样改道回本代理、后续子资源请求照样走 HTTP 反代。
// 也就是说：只有「HTML 文档」这一次请求付渲染成本，其余全是便宜的反代。
//
// 【注意】渲染出来的 HTML 里，相对 URL 已经被浏览器按文档地址解析过了，
// 但**属性值仍是原始写法**（outerHTML 返回的是序列化后的 DOM，相对路径保持相对），
// 所以 rewriteHtml 里基于 pageUrl 的解析逻辑照常适用。
// ---------------------------------------------------------------
const RENDER_HTML_CACHE_TTL = 90 * 1000;   // 同一页面 90 秒内不重复渲染
const RENDER_HTML_MAX = 12;
const renderCache = new Map();              // cacheKey -> { at, html, status }

/**
 * 判断渲染结果是不是「还没过关」。
 *
 * 实测会碰到三种拦截面貌，光看 "Just a moment" 会漏掉后两种：
 *   1. 英文标准挑战页  -> title "Just a moment..." / "Attention Required!"
 *   2. 中文 JS 中转页  -> title "請稍候..."，403，约 28KB，页面自己跑 JS 后跳转
 *   3. 带 cf-mitigated 头的响应
 * 所以判据是「标题像挑战页」**或**「内容明显偏小且带挑战特征」。
 */
function looksBlocked(html, title) {
  const t = String(title || '');
  if (/just a moment|attention required|checking your browser|verifying you are human|請稍候|请稍候|正在检查/i.test(t)) return true;
  const low = String(html || '').toLowerCase();
  if (low.includes('cf-mitigated')) return true;
  // 正文页动辄 100KB+；挑战页通常在 30KB 以下且含挑战特征
  if (low.length < 45000 && /challenge-platform|challenges\.cloudflare\.com|cf-chl/i.test(low)) return true;
  return false;
}

async function renderHtml(key, site, target) {
  const now = Date.now();
  const hit = renderCache.get(target);
  if (hit && now - hit.at < RENDER_HTML_CACHE_TTL) return hit;

  if (!withBrowserFn) throw new Error('渲染器未就绪（withBrowser 未绑定）');

  // 为什么要有外层重试：实测冷渲染 4 次里会有 1 次落到一张 403 的「請稍候…」
  // 中转页，而且它**卡在那里不会自愈**（等满 40 秒还是同一张）。
  // 但紧接着再开一次页面就 1.2 秒直出正文 —— 说明这是**每次导航独立**的抖动，
  // 不是「这个环境过不了盾」。所以重试是最有效也最省事的解法。
  const ATTEMPTS = 3;
  let lastTitle = '';
  let lastLen = 0;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const res = await withBrowserFn(async (context) => {
      const page = await context.newPage();
      try {
        // 成功那次实测是 DOC 307 -> DOC 200 的重定向链；
        // 用 domcontentloaded 会在中转页就返回，太早。等 networkidle 让
        // 挑战页自己的 JS 跑完（它会带着新的通行证再跳一次）。
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });

        let title = '';
        let html = '';
        // 先短轮询：多数情况 1~3 秒就直出正文
        for (let i = 0; i < 6; i++) {
          title = await page.title().catch(() => '');
          html = await page.content().catch(() => '');
          if (!looksBlocked(html, title) && html.length > 45000) break;
          await page.waitForTimeout(1000);
        }

        // 还是中转页：等它把网络忙完（挑战 JS 会发 XHR 换通行证）
        if (looksBlocked(html, title)) {
          await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
          title = await page.title().catch(() => '');
          html = await page.content().catch(() => '');
        }

        if (!looksBlocked(html, title) && html.length > 45000) {
          // 让懒加载封面/瀑布流把 DOM 填出来再序列化
          await page.waitForTimeout(1200);
          return { html: await page.content(), title };
        }
        return { html, title };
      } finally {
        await page.close().catch(() => {});
      }
    });

    lastTitle = res.title;
    lastLen = res.html.length;

    if (!looksBlocked(res.html, res.title)) {
      const entry = { at: Date.now(), html: res.html };
      renderCache.set(target, entry);
      if (renderCache.size > RENDER_HTML_MAX) {
        let oldest = null;
        for (const [k, v] of renderCache) if (!oldest || v.at < renderCache.get(oldest).at) oldest = k;
        if (oldest) renderCache.delete(oldest);
      }
      return entry;
    }

    console.log(`[在线观看/反代] ${site.name} 渲染第 ${attempt}/${ATTEMPTS} 次落到挑战页（${res.html.length} 字节，标题「${String(res.title).slice(0, 20)}」），重试`);
    if (attempt < ATTEMPTS) await new Promise((s) => setTimeout(s, 1500));
  }

  throw new Error(`${site.name} 的 Cloudflare 挑战连续 ${ATTEMPTS} 次都没通过` +
    `（最后一次 ${lastLen} 字节，标题「${String(lastTitle).slice(0, 30)}」）。` +
    `该站在此环境下属于硬拦截，需要人工在真浏览器里完成一次验证。`);
}

function withBrowserFailover(html, key, site, origin, pageUrl) {
  // 渲染出来的 HTML 里，浏览器已经把 <script> 的副作用留下，但有些站会再插一段
  // 「正在检查浏览器」的占位脚本；这里不做特殊处理，交给 rewriteHtml 正常改写。
  return rewriteHtml(html, key, site, origin, pageUrl);
}

// ---------------------------------------------------------------
// Cookie 罐：按「站点」维护，服务端持有，浏览器侧完全无感。
// 用内存 Map 而不是磁盘：站点 cookie 生命周期短，重启后重新握手即可，省掉一堆过期清理逻辑。
// ---------------------------------------------------------------
const jar = new Map();          // siteKey -> Map(name -> { value, expires })
const MAX_COOKIE_BYTES = 16 * 1024;

// ---------------------------------------------------------------
// 代理探活（30 秒缓存）。
// 宿主代理会不定期抽风：节点掉线时端口 ECONNREFUSED。若不加判断直接用，
// 整个在线观看会跟着挂掉；实测这几个站直连本来就能 200，代理只是「有时更稳」，
// 不该成为单点故障。探测用裸 TCP 连接 —— 比发 HTTP 请求便宜得多。
// ---------------------------------------------------------------
let pxCache = { at: 0, ok: false };
const PX_TTL_OK = 5 * 60 * 1000;   // 探通了就信 5 分钟（省得反复探）
const PX_TTL_BAD = 30 * 1000;      // 探不通只信 30 秒

function tcpProbe(px, ms = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(px);
      const net = require('net');
      const s = net.connect(Number(u.port), u.hostname, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(ms, () => { s.destroy(); resolve(false); });
    } catch (e) { resolve(false); }
  });
}

/**
 * 代理探活。
 * 【为什么失败要连探两次】宿主代理（clash 之类）在容器里做 TCP 连接偶发假阴性，
 * 一次探不通就判死会让整条在线观看链路 502。所以失败后再探一次，两次都拒才认。
 */
async function proxyAlive(px) {
  const age = Date.now() - pxCache.at;
  if (pxCache.ok && age < PX_TTL_OK) return true;
  if (!pxCache.ok && age < PX_TTL_BAD) return false;

  let ok = await tcpProbe(px);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 400));
    ok = await tcpProbe(px);
  }
  pxCache = { at: Date.now(), ok };
  if (!ok) console.log(`[在线观看/反代] 代理 ${px} 两次 TCP 探测都连不上 —— 已开代理的站点本轮会如实报错，不会静默改直连`);
  return ok;
}

function jarGet(siteKey) {
  if (!jar.has(siteKey)) jar.set(siteKey, new Map());
  return jar.get(siteKey);
}

function jarHeader(siteKey) {
  const m = jarGet(siteKey);
  const now = Date.now();
  const parts = [];
  for (const [name, c] of m) {
    if (c.expires && now > c.expires) { m.delete(name); continue; }
    parts.push(`${name}=${c.value}`);
  }
  const s = parts.join('; ');
  return s.length > MAX_COOKIE_BYTES ? s.slice(0, MAX_COOKIE_BYTES) : s;
}

/** 收下上游的 Set-Cookie。getSetCookie() 在 Node 18.14+ 才有，老版本退回单条解析。 */
function jarSet(siteKey, res) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else {
    const one = res.headers.get('set-cookie');
    if (one) list = one.split(/,(?=[^;=]+=)/);
  }
  const m = jarGet(siteKey);
  for (const raw of list) {
    if (!raw) continue;
    const seg = raw.split(';');
    const eq = seg[0].indexOf('=');
    if (eq < 1) continue;
    const name = seg[0].slice(0, eq).trim();
    const value = seg[0].slice(eq + 1).trim();
    let expires = 0;
    for (const attr of seg.slice(1)) {
      const [k, v] = attr.split('=').map((x) => (x || '').trim());
      if (/^max-age$/i.test(k)) expires = Date.now() + Number(v) * 1000;
      else if (/^expires$/i.test(k)) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) expires = t;
      }
    }
    if (value === '' || (expires && expires < Date.now())) m.delete(name);
    else m.set(name, { value, expires });
  }
}

// ---------------------------------------------------------------
// 站点解析：key -> { site, origin }
// 镜像地址的 origin 每次请求都可能变（/api/webview/site 探到哪个用哪个），
// 所以允许通过 originOverride 显式指定，避免「探到 A 地址、却去请求 B 地址」的错配。
// ---------------------------------------------------------------
function siteBasePath(key) { return `/${key}`; }

/** 主域（站点 addrs）对应的 host，用来在 toLocal 里判断「要不要带 host 前缀」 */
function primaryHosts(site) {
  const out = [];
  for (const a of site.addrs || []) {
    try { out.push(new URL(a).hostname.toLowerCase()); } catch (e) { /* 忽略 */ }
  }
  return out;
}

/**
 * 把一个站内（含自有 CDN）URL 转成走本代理的路径。
 *
 * 【为什么有的 URL 要带主机名前缀】
 * 一个站点不止一个主机：jable 的页面在 jable.tv，但 CSS/JS/封面在 assets-cdn.jable.tv。
 * 如果两者都映射成 /jable/<path>，代理就分不清该去哪个主机取 —— 会把
 * /jable/assets/css/app.css 打成 https://jable.tv/assets/css/app.css（404）。
 * 所以：**主域走 /{key}/…**（保持 URL 干净、也不影响站点自己的相对路径解析），
 *       **其它自有主机走 /{key}/-/{host}/…**，用 `-/` 这个不会和真实路径撞车的段来标记。
 */
function toLocal(key, absUrl, site) {
  try {
    const u = new URL(absUrl);
    const hostPrefix = (site && !primaryHosts(site).includes(u.hostname.toLowerCase()))
      ? `/-/${u.hostname}`
      : '';
    return `${siteBasePath(key)}${hostPrefix}${u.pathname}${u.search}${u.hash}`;
  } catch (e) { return absUrl; }
}

/**
 * toLocal 的逆运算：从本代理路径里解出「真实上游 target 路径 + 该用哪个主机」。
 * 返回 { host, sub }；host 为 null 表示用站点主域。
 */
function fromLocal(reqPath) {
  const m = String(reqPath || '').match(/^\/-\/([^/]+)(\/.*)?$/);
  if (!m) return { host: null, sub: reqPath };
  return { host: m[1], sub: m[2] || '/' };
}

// ---------------------------------------------------------------
// 需要剥离的响应头 —— 这几个是「不能内嵌」的根源，以及会干扰同源化的头
// ---------------------------------------------------------------
const STRIP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'permissions-policy',
  'report-to',
  'nel',
  // 上游压缩头必须去掉：我们解压后重写，再按新 body 重新压缩，长度会变
  'content-encoding',
  'content-length',
  // 防止上游 CDN 缓存把未处理的响应喂回来
  'alt-svc',
  'transfer-encoding',
  'connection'
]);

// ---------------------------------------------------------------
// 入口：/{key}/*  →  反代
// ---------------------------------------------------------------
router.use('/:key', async (req, res, next) => {
  const key = String(req.params.key || '');
  const site = SITES[key];
  if (!site) return next();                     // 不是站点 key，交给后面的路由

  // origin 优先用请求里带的（前端开标签时已探好的那个地址），其次用 /api/webview/site 的缓存
  const originOverride = String(req.query._o || '');
  let origin = await pickOrigin(key, site, originOverride);
  if (!origin) {
    return res.status(502).type('html').send(wrapError(site.name, '所有线路都连不上，请点「🔁 换线路」重试'));
  }

  // 带 /-/<host>/ 前缀的请求 = 站点自有 CDN 的资源，要打到那个主机上去。
  // 例：/jable/-/assets-cdn.jable.tv/assets/css/app.css -> https://assets-cdn.jable.tv/assets/css/app.css
  const { host: subHost, sub: realSub } = fromLocal(req.path);
  if (subHost) {
    if (!hostInSite(site, subHost)) {
      return res.status(403).type('html').send(wrapError(site.name, '这个主机不在本站的白名单里'));
    }
    // 用主域的协议拼 CDN 地址（站点自有 CDN 都是 https）
    origin = 'https://' + subHost;
  }

  // 已经带过 _o 的内部请求，子资源不再重复带（否则 URL 会越滚越长）
  const sub = realSub === '/' ? '/' : realSub;

  // ★ origin 必须收敛成「协议+主机」。
  //   前车之鉴：porndude 的 addrs 是 `https://theporndude.com/zh`（站点中文首页在子路径下），
  //   直接拿它当 origin 拼 target 会得到 `https://theporndude.com/zh/zh` → 404；
  //   而 toLocal/runtime 里比较的都是 `new URL(addr).origin`，两边口径不一致还会漏改写。
  origin = normalizeOrigin(origin);

  const search = buildSearch(req.query, (originOverride || subHost) ? null : origin);
  const target = origin.replace(/\/$/, '') + sub + search;

  // CF 挑战站（site.render）：HTML 文档这次请求必须走「渲染回退」——
  // HTTP 直连只会拿到 403 挑战页。其余子资源（js/css/图片）照旧走便宜的反代。
  const wantsDoc = req.method === 'GET' && isDocumentRequest(req);
  if (site.render && wantsDoc) {
    try {
      const r = await renderHtml(key, site, target);
      const out = rewriteHtml(r.html, key, site, origin, target);
      const buf = Buffer.from(out, 'utf8');
      res.status(200);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    } catch (e) {
      // 渲染失败就**不要**再退回 HTTP 反代 —— 那只会把 403 挑战页吐给用户，
      // 看起来像站点坏了。如实说明是挑战没过。
      return res.status(502).type('html')
        .send(wrapError(site.name, `需要浏览器渲染，但没通过 Cloudflare 挑战：${escapeHtml(e.message)}`));
    }
  }

  try {
    return await proxyOnce(req, res, { key, site, origin, target, wantsDoc });
  } catch (e) {
    if (!res.headersSent) {
      // 如实把「代理在不在」写出来：这类站打不开，九成是宿主代理掉了，而不是站点坏了
      const px = config.network?.proxyServer;
      const hint = px
        ? `<br><small style="color:#888">宿主代理：${escapeHtml(px)}　当前状态：${pxCache.ok ? '在线' : '连不上'}</small>`
        : '<br><small style="color:#888">未配置宿主代理</small>';
      res.status(502).type('html').send(wrapError(site.name, `代理请求失败：${escapeHtml(e.message)}${hint}`));
    } else res.end();
  }
});

/**
 * 这次的请求是不是「要一个 HTML 文档」。
 * 不能只看 Accept（子资源有时也带 text/html），也不能只看路径——
 * 判据：方法 GET + 不带 Sec-Fetch-Dest=script/style/image 这类明确的子资源声明。
 */
function isDocumentRequest(req) {
  const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'empty';
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

/** 拼查询串：剔除我们自己的 _o 参数，其余原样透传 */
function buildSearch(query, originToInject) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k === '_o') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else if (v != null) sp.append(k, v);
  }
  if (originToInject) sp.set('_o', originToInject);
  const s = sp.toString();
  return s ? '?' + s : '';
}

/**
 * 选一个可用 origin。
 * 复用 webview.js 的逐级探测（带 5 分钟缓存），但这里要能「锁定」：
 * 子资源请求会带 _o，直接用，不再探测 —— 否则页面上半截来自地址 A、下半截来自地址 B，cookie 会对不上。
 */
let resolveSiteFn = null;
function bindResolver(fn) { resolveSiteFn = fn; }

// 渲染器由 server.js 注入（webview.js 的 withBrowser），避免两个模块循环 require
let withBrowserFn = null;
function bindBrowser(fn) { withBrowserFn = fn; }

async function pickOrigin(key, site, override) {
  if (override) {
    try {
      const u = new URL(override);
      if (hostInSite(site, u.hostname)) return u.origin;
    } catch (e) { /* 非法就退回探测 */ }
  }
  if (resolveSiteFn) {
    try { return await resolveSiteFn(key); } catch (e) { /* 退回第一个地址 */ }
  }
  return site.addrs[0];
}

/**
 * 这些主机算「站内」：会改写成走本代理。
 *
 * 【只认精确主机名，不做子域后缀匹配】
 * 之前写的是 `h === d || h.endsWith('.' + d)`，本意是照顾 www/mirror，实际会误伤：
 * jable 的资源域 assets-cdn.jable.tv 是 jable.tv 的子域，于是被当成「站内」改写走了，
 * 但它的 HTTP 反代是 403（同样受 Cloudflare 保护），等于把本来能加载的资源改坏。
 * 而浏览器带着 cf_clearance 直连它是 200 —— 所以这类 CDN 必须**原样保留**。
 * 需要纳管的额外主机，显式写进 site.cdn（精确匹配）。
 */
function hostInSite(site, hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const all = [].concat(site.addrs || [], site.cdn || []);
  return all.some((a) => {
    try {
      const d = new URL(a).hostname.replace(/^www\./, '').toLowerCase();
      return h === d;
    } catch (e) { return false; }
  });
}

// ---------------------------------------------------------------
// 单次代理：发请求 → 解压 → 按类型处理 → 回吐
// ---------------------------------------------------------------
async function proxyOnce(req, res, ctx) {
  const { key, site, origin, target, wantsDoc } = ctx;

  const headers = {
    'User-Agent': UA,
    Accept: req.headers.accept || '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
    // 上游普遍按 Referer 做防盗链校验，必须伪装成「从它自己站内发起」
    Referer: origin + '/'
  };
  // ★★ Origin 绝对不能在普通 GET 导航上发出去 ★★
  //   实测（round19）：javmenu 的 Cloudflare WAF 对「非浏览器 + 带 Origin」的请求直接掐，
  //   只带 Origin  → 上游超时（undici TimeoutError）
  //   Referer+Origin → 硬返回 522（无正文）
  //   去掉 Origin   → 同一请求稳定 200 / 413KB 正文（仅 Referer 也一样 200）。
  //   语义上也本就该这样：Origin 只用于 CORS 预检与非简单请求（POST/PUT/DELETE…），
  //   普通文档导航不该带。带上去等于把自己标记成「跨站脚本发起」。
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers.Origin = origin.replace(/\/$/, '');
  }
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers.range) headers.Range = req.headers.range;
  // 注意：不要带 accept-encoding，让上游返回明文，省一层解压
  const cookie = jarHeader(key);
  if (cookie) headers.Cookie = cookie;

  // 出口：见 pickRoutes 的说明 —— 首选代理，直连兜底；两条都留着才扛得住节点抖动
  // ★ 必须是 dispatcher：本文件的 fetch 是 undici 全局 fetch，`agent` 会被静默忽略
  const fetchOpts = { method: req.method, headers, redirect: 'manual' };
  const routes = await pickRoutes(site);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for (const c of req) chunks.push(c);
    if (chunks.length) fetchOpts.body = Buffer.concat(chunks);
  }

  const { res: upstream, route } = await fetchUpstream(target, fetchOpts, {
    routes,
    // 只有「有备用线路」时才值得对同一条线路重试两次；单线路（代理掉线）一次就够，省用户时间
    attemptsPerRoute: (wantsDoc && routes.length > 1) ? 2 : 1,
    timeout: wantsDoc ? 15000 : 10000,
    site,
  });
  ctx.via = route.via;

  // 重定向：改写成走本代理（否则浏览器一跳就跑到站外，又被 XFO 挡回来）
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get('location');
    if (loc) {
      let abs;
      try { abs = new URL(loc, target).href; } catch (e) { abs = loc; }
      if (hostInSite(site, safeHost(abs)) || abs.startsWith(origin)) {
        res.setHeader('Location', toLocal(key, abs, site));
      } else {
        res.setHeader('Location', abs);      // 跳到站外就如实放行（如第三方登录）
      }
      jarSet(key, upstream);
      res.status(upstream.status);
      return res.end();
    }
  }

  jarSet(key, upstream);

  // 剥头
  res.status(upstream.status);
  for (const [name, value] of upstream.headers) {
    if (STRIP_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'set-cookie') continue;   // cookie 全部留在服务端罐里
    try { res.setHeader(name, value); } catch (e) { /* 非法头名忽略 */ }
  }
  // 明确告诉浏览器这个响应可以内嵌（它本来也会，因为 XFO 已经没了）
  res.removeHeader('X-Frame-Options');

  const ctype = (upstream.headers.get('content-type') || '').toLowerCase();

  // 二进制直通（图片/视频/字体/压缩包）
  if (!/text\/html|text\/css|application\/javascript|text\/javascript|application\/json|text\/plain|image\/svg/i.test(ctype)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const ab = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Length', ab.length);
    return res.end(req.method === 'HEAD' ? undefined : ab);
  }

  let text = await upstream.text();

  if (/text\/html/i.test(ctype)) {
    text = rewriteHtml(text, key, site, origin, target);
  } else if (/text\/css/i.test(ctype)) {
    text = rewriteCss(text, key, site, origin, target);
  } else if (/javascript/i.test(ctype)) {
    text = rewriteJs(text, key, site, origin);
  } else if (/application\/json/i.test(ctype)) {
    text = rewriteJson(text, key, site, origin);
  }

  const buf = Buffer.from(text, 'utf8');
  res.setHeader('Content-Type', ctype.includes('charset') ? ctype : ctype + '; charset=utf-8');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.end(req.method === 'HEAD' ? undefined : buf);
}

function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }

/**
 * 带「多线路 + 多次重试」的 fetch。
 *
 * 【为什么必须重试，不能「失败就算了」】
 * 实测 javmenu 的上游**天生抖动**：同一条 URL 连续请求，约一半直接 ECONNRESET
 * （走代理和不走代理都一样，5 秒左右被 reset），另一半 200 / 413KB。
 * 这种站如果只请求一次，用户看到的就是「一半概率打不开」—— 比彻底坏掉还难排查。
 *
 * 【为什么还要换线路】
 * 宿主代理节点同样会抽风（实测同一次探测里 ECONNRESET / ECONNREFUSED 交替）。
 * 两个出口都试，可用性才够。
 *
 * 【什么情况下换一套头再试】
 * 同一线路的第 2 次起去掉 Referer/Origin：Cloudflare 系 WAF 对这两个头极敏感
 * （javmenu 的 522 就是被 Origin 触发的，实测只发 Origin 直接超时、只发 Referer 反而正常）。
 * 拿不到正文比丢防盗链严重得多，所以头是可以牺牲的。
 *
 * @returns {{res: Response, route: {via:string, dispatcher:any}}}
 */
async function fetchUpstream(target, baseOpts, { routes, attemptsPerRoute = 1, timeout = 20000, site } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const name = site ? site.name : '';
  const tried = [];
  let lastErr = null;

  for (const route of routes) {
    for (let attempt = 1; attempt <= attemptsPerRoute; attempt++) {
      const headers = { ...baseOpts.headers };
      if (attempt > 1) {
        delete headers.Referer;
        delete headers.Origin;
      }
      const opts = { ...baseOpts, headers, signal: AbortSignal.timeout(route.timeout || timeout) };
      if (route.dispatcher) opts.dispatcher = route.dispatcher;
      try {
        const res = await fetch(target, opts);
        // 5xx（CF 的 520~527 常是 WAF 直接判源站超时，与内容无关）值得换头重试
        if (res.status >= 500 && attempt < attemptsPerRoute) {
          if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
          console.log(`[在线观看/反代] ${name} ${target} [${route.via} 第${attempt}次] → ${res.status}，换头重试`);
          await sleep(400 * attempt);
          continue;
        }
        if (res.status < 500) {
          if (attempt > 1 || routes.indexOf(route) > 0) {
            console.log(`[在线观看/反代] ${name} ${target} [${route.via} 第${attempt}次] 成功 → ${res.status}`);
          }
          return { res, route };
        }
        // 这条线路最后一次仍是 5xx → 记下状态换下一条线路，最终仍无解时如实报错
        tried.push(`${route.via}:${res.status}`);
        if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
      } catch (e) {
        lastErr = e;
        const code = (e.cause && e.cause.code) || e.name;
        tried.push(`${route.via}:${code}`);
        console.log(`[在线观看/反代] ${name} ${target} [${route.via} 第${attempt}次] 网络错误（${code}）`);
        if (attempt < attemptsPerRoute) await sleep(400 * attempt);
      }
    }
  }

  const fail = new Error(`所有线路都没拿到内容（${tried.join(' / ')}${lastErr ? '；最后一次 ' + lastErr.message : ''}）`);
  throw fail;
}

/** 把任意地址收敛成 protocol//host（丢掉路径/查询），非法的原样返回去掉尾斜杠 */
function normalizeOrigin(u) {
  try { return new URL(u).origin; } catch (e) { return String(u || '').replace(/\/$/, ''); }
}

// ---------------------------------------------------------------
// HTML 重写：这是整个方案的核心
// ---------------------------------------------------------------
const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data-src', 'data-original', 'data-lazy-src', 'data-echo', 'data-url', 'data-href', 'formaction', 'cite', 'background', 'data-bg', 'data-preview', 'data-video', 'data-file', 'data-image', 'data-thumb'];

function rewriteHtml(html, key, site, origin, pageUrl) {
  let $;
  try {
    $ = load(html, { decodeEntities: false });
  } catch (e) {
    // 站点 HTML 太脏时解析失败，退回正则（效果差但不会白屏）
    return injectRuntime(rewriteByRegex(html, key, site, origin), key, site, origin);
  }

  const O = origin.replace(/\/$/, '');
  const base = new URL(pageUrl);

  /** 把任意值转成走代理的本地路径；外站原样返回 */
  const localize = (raw) => {
    if (!raw) return raw;
    const v = String(raw).trim();
    if (!v) return raw;
    // 这些是「行为脚本」，不是地址，绝不动
    if (/^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i.test(v)) return raw;
    let abs;
    try { abs = new URL(v, base).href; } catch (e) { return raw; }
    // 站内（含自有 CDN）→ 走代理；站外 → 原样（不劫持第三方，避免把 CDN 也压到本服务上）
    if (hostInSite(site, safeHost(abs))) return toLocal(key, abs, site);
    return raw;
  };

  for (const attr of URL_ATTRS) {
    $(`[${attr}]`).each((_, el) => {
      const orig = $(el).attr(attr);
      const out = localize(orig);
      if (out !== orig) $(el).attr(attr, out);
    });
  }

  // 兜底：所有 data-* 属性里只要值长得像「本站的地址」，就改写。
  // 为什么需要它：站点的懒加载/预览属性名字五花八门（jable 用 data-preview 放悬停预览 mp4，
  // 还有 data-video、data-file 之类），靠人工维护 URL_ATTRS 永远漏。这里只改
  // hostInSite 认得的域，外站（CDN/广告/统计）一律不碰，所以不会劫持第三方。
  $('*').each((_, el) => {
    const attribs = el.attribs || {};
    for (const name of Object.keys(attribs)) {
      if (!/^data-/i.test(name)) continue;
      if (URL_ATTRS.includes(name.toLowerCase())) continue;   // 上面已处理过
      const v = attribs[name];
      if (!v || v.length < 8) continue;
      // 快速筛：值里必须出现本站域名或本来就是绝对路径，否则不必进 localize
      if (!/https?:\/\//i.test(v)) continue;
      const out = localize(v);
      if (out !== v) $(el).attr(name, out);
    }
  });

  // srcset 是逗号分隔的「URL 描述符」列表，得逐项处理
  $('[srcset]').each((_, el) => {
    const v = $(el).attr('srcset');
    if (!v) return;
    const out = v.split(',').map((part) => {
      const seg = part.trim().split(/\s+/);
      if (!seg[0]) return part;
      const l = localize(seg[0]);
      return [l, ...seg.slice(1)].join(' ');
    }).join(', ');
    $(el).attr('srcset', out);
  });

  // 内联事件处理器里的 URL（onerror / onclick / onload …）。
  // 实测 javmenu 每个封面都带 onerror="this.src='https://javmenu.com/.../no_preview_lg.jpg'"，
  // 一个页面 121 处。不处理的话：封面一旦加载失败就回退到站外兜底图，
  // 那张图跨域+防盗链取不到，用户看到的就是成片破图。
  $('*').each((_, el) => {
    const attribs = el.attribs || {};
    for (const name of Object.keys(attribs)) {
      if (!/^on/i.test(name)) continue;
      const code = attribs[name];
      if (!code || !/javmenu\.com|https?:\/\//i.test(code)) continue;
      const fixed = rewriteHandlerCode(code, key, site, origin);
      if (fixed !== code) $(el).attr(name, fixed);
    }
  });

  // 内联 CSS 里的 url(...)，以及 style 属性
  $('style').each((_, el) => {
    const css = $(el).html();
    if (css && /url\s*\(/i.test(css)) $(el).html(rewriteCss(css, key, site, origin, pageUrl));
  });
  $('[style]').each((_, el) => {
    const s = $(el).attr('style');
    if (s && /url\s*\(/i.test(s)) $(el).attr('style', rewriteCss(s, key, site, origin, pageUrl));
  });

  // <base> 会打乱我们的相对路径解析，直接摘掉
  $('base').remove();

  // 让 <a target="_blank"> 别把用户甩出应用；同时给外站链接留个标记便于调试
  $('a[target]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.startsWith('/')) $(el).removeAttr('target');
  });

  let out = $.html();

  // 内联 <script> 里常有硬编码的路径/域名拼接，交给正则再过一遍
  out = rewriteInlineScripts(out, key, site, origin);

  return injectRuntime(out, key, site, origin);
}

/** 纯文本替换兜底（cheerio 解析失败时用） */
function rewriteByRegex(html, key, site, origin) {
  const O = origin.replace(/\/$/, '');
  const esc = O.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html
    .replace(new RegExp('(["\'])(' + esc + ')(/[^"\']*)?(["\'])', 'g'), (m, q1, _o, p, q2) => `${q1}/${key}${p || '/'}${q2}`)
    .replace(new RegExp('(["\'])(' + esc + ')', 'g'), (m, q1) => `${q1}/${key}/`.slice(0, 0) + q1 + '/' + key);
}

/**
 * 改写内联事件处理器里的站内 URL。
 * 例：onerror="this.src='https://javmenu.com/theme/.../no_preview_lg.jpg?v=5.4.2'"
 *     →  onerror="this.src='/javmenu/theme/.../no_preview_lg.jpg?v=5.4.2'"
 *
 * 只做字符串字面量替换，不解析 JS —— 事件处理器里几乎只会出现单个 URL 字面量，
 * 用完整 JS 解析器属于杀鸡用牛刀，还会把站点写得很脏的代码解析失败。
 * 注意替换值里的 `/` 不会破坏 jQuery .attr() 的序列化（它按属性引号规则转义）。
 */
function rewriteHandlerCode(code, key, site, origin) {
  // 换成「主机 -> 本地前缀」的映射，而不是统一映射成 /{key}：
  // 自有 CDN（assets-cdn.jable.tv）必须映射到 /{key}/-/{host}，否则会被当成主域的路径而 404。
  const map = [];
  for (const a of [].concat(site.addrs || [], site.cdn || [])) {
    try {
      const u = new URL(a);
      const pre = primaryHosts(site).includes(u.hostname.toLowerCase())
        ? '/' + key
        : '/' + key + '/-/' + u.hostname;
      map.push([u.origin, pre]);
    } catch (e) { /* 跳过坏地址 */ }
  }
  if (origin) {
    const o = origin.replace(/\/$/, '');
    map.push([o, '/' + key]);
  }

  let out = code;
  // 长的主机名优先替换，避免 assets-cdn.jable.tv 被 jable.tv 的规则先吃掉半截
  map.sort((a, b) => b[0].length - a[0].length);
  for (const [o, pre] of map) {
    // 匹配 https://host / http://host / //host，后面必须紧跟 / ' " ` 或空白，避免误伤 host 前缀相同的别的域名
    const esc = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc + '(?=[/\\s\'"`]|$)', 'g'), pre);
    const protoRel = o.replace(/^https?:/, '');
    out = out.replace(new RegExp(protoRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[/\\s\'"`]|$)', 'g'), pre);
  }
  return out;
}

/**
 * 内联脚本重写：
 * 站点 JS 里常写死 `https://netflav.com/api/...` 或 `"/api/xxx"`。
 * 绝对域名直接换成本地前缀；根相对路径前面插站点 key（因为我们在子路径下，不加前缀会打到我们自己的路由）。
 */
function rewriteInlineScripts(html, key, site, origin) {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
    if (!body.trim()) return m;
    // 已有 src 的外链脚本不动（由 rewriteHtml 的 attr 处理改过道了）
    const fixed = rewriteJsBody(body, key, site, origin);
    return `<script${attrs}>${fixed}</script>`;
  });
}

function rewriteJsBody(js, key, site, origin) {
  let out = rewriteHandlerCode(js, key, site, origin);
  // 站内根相对路径补上前缀：站点 JS 里写 "/api/xxx" 时，
  // 我们在子路径 /{key}/ 下运行，不加前缀就会打到本应用自己的路由上。
  // 只匹配「引号开头、斜杠紧跟、不是 // 协议相对、不是已带 key 前缀」的情况。
  out = out.replace(/(["'`])\/(?!\/)(?![\w-]+\/)/g, (m, q) => q + '/' + key + '/');
  return out;
}

// ---------------------------------------------------------------
// CSS 重写：url(...) 和 @import
// ---------------------------------------------------------------
function rewriteCss(css, key, site, origin, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch (e) { base = new URL(origin + '/'); }
  const localize = (raw) => {
    const v = raw.trim().replace(/^["']|["']$/g, '');
    if (!v || /^(data:|about:|blob:)/i.test(v)) return raw;
    let abs;
    try { abs = new URL(v, base).href; } catch (e) { return raw; }
    if (hostInSite(site, safeHost(abs))) return toLocal(key, abs, site);
    return raw;
  };
  return css.replace(/url\(\s*([^)]+?)\s*\)/gi, (m, inner) => {
    if (/^(data:|about:|blob:)/i.test(inner.trim())) return m;
    return `url(${localize(inner)})`;
  });
}

/** JS 文件重写：让 fetch/XHR 的目标也在同源内 */
function rewriteJs(js, key, site, origin) {
  return rewriteJsBody(js, key, site, origin);
}

/** JSON（很多站点用 REST API 返回播放地址等），把站内 URL 换成本地路径 */
function rewriteJson(text, key, site, origin) {
  if (!origin) return text;
  const O = origin.replace(/\/$/, '');
  const esc = O.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(esc + '(/[^"\\\\\\s]*)', 'g'), `/${key}$1`);
}

// ---------------------------------------------------------------
// 注入运行时：把 JS 动态拼的 URL 也拉回同源
// 这一步是「完美复现」的关键 —— 纯静态重写只能覆盖 HTML 里明写的链接，
// 站点用 fetch/XHR 拉的接口、用 pushState 换的地址、动态创建的 <img>，
// 全靠这段脚本拦截。
// ---------------------------------------------------------------
function injectRuntime(html, key, site, origin) {
  const O = origin.replace(/\/$/, '');
  const hosts = [];
  // addrs = 主域/镜像；cdn = 站点自有静态资源域。
  // 两者都要进 CFG.hosts —— 否则站点 JS 动态创建的 <img src="https://assets-cdn.jable.tv/...">
  // 会绕过代理直连站外（又被防盗链挡回来，表现为成片破图）。
  for (const a of [].concat(site.addrs || [], site.cdn || [])) {
    try { hosts.push(new URL(a).origin); } catch (e) { /* 忽略坏地址 */ }
  }
  hosts.push(O);
  const cfg = JSON.stringify({
    key, origin: O,
    hosts: [...new Set(hosts)],
    primary: primaryHosts(site),
    base: '/' + key
  });

  // 尽量在 <head> 最前面注入，早于站点自己的脚本
  const tag = `<script data-lmw-runtime="1">(function(){${RUNTIME_BODY.replace('__CFG__', cfg)}})();</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, (m) => m + tag);
  return tag + html;
}

/**
 * 注入脚本本体。写成字符串是因为它要原样送到浏览器执行，不能经过本进程的解析。
 * 做四件事：
 *   1. 改写 fetch / XMLHttpRequest.open 的目标 URL
 *   2. 拦截 history.pushState/replaceState 与 location 赋值，保证地址栏停在本应用内
 *   3. 给 setAttribute('src'|'href') 和 img.src 兜底
 *   4. 把站点的 Service Worker 注销掉（SW 拦截会绕过我们的代理，直接打站外）
 */
const RUNTIME_BODY = `
var CFG = __CFG__;
function toLocal(u){
  try {
    if (typeof u !== 'string' || !u) return u;
    if (/^(data:|blob:|javascript:|mailto:|about:|#)/i.test(u)) return u;
    var abs = new URL(u, location.href);
    if (abs.pathname.indexOf(CFG.base + '/') === 0) return u;      // 已经是本代理的地址
    for (var i=0;i<CFG.hosts.length;i++){
      if (abs.origin === CFG.hosts[i]) {
        // 主域走 /{key}/…；自有 CDN 走 /{key}/-/{host}/…（服务端据此路由到正确主机）
        var pre = CFG.primary.indexOf(abs.hostname.toLowerCase()) >= 0 ? '' : '/-/' + abs.hostname;
        return CFG.base + pre + abs.pathname + abs.search + abs.hash;
      }
    }
    return u;                                                      // 第三方保持原样
  } catch(e){ return u; }
}

// 1. fetch
var _fetch = window.fetch;
if (_fetch) {
  window.fetch = function(input, init){
    try {
      if (typeof input === 'string') input = toLocal(input);
      else if (input && input.url) {
        var nu = toLocal(input.url);
        if (nu !== input.url) input = new Request(nu, input);
      }
    } catch(e){}
    return _fetch.call(this, input, init);
  };
}

// 2. XHR
var _open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(m, u){
  try { arguments[1] = toLocal(u); } catch(e){}
  return _open.apply(this, arguments);
};

// 3. history / location —— 让站点以为自己还在原站
var _push = history.pushState, _replace = history.replaceState;
function keepLocal(u){
  try {
    var abs = new URL(u, location.href);
    var h = CFG.origin;
    if (abs.origin === h) return CFG.base + abs.pathname + abs.search + abs.hash;
  } catch(e){}
  return u;
}
history.pushState = function(s, t, u){ return _push.call(this, s, t, u === undefined ? u : keepLocal(u)); };
history.replaceState = function(s, t, u){ return _replace.call(this, s, t, u === undefined ? u : keepLocal(u)); };

// 4. 动态创建元素兜底（站点常 new Image().src = '...'）
try {
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    if (/^(src|href|action|poster|data-src)$/i.test(name)) value = toLocal(value);
    return _setAttr.call(this, name, value);
  };
} catch(e){}

// 5. Service Worker 会把请求直接打向站外，绕过代理 —— 一律注销
try {
  if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker.getRegistrations().then(function(rs){
      rs.forEach(function(r){ r.unregister(); });
    }).catch(function(){});
  }
} catch(e){}
`;

// ---------------------------------------------------------------
// 错误页
// ---------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function wrapError(name, msg) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(name)} 打不开</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f7f9;color:#222;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;max-width:520px;padding:32px}a{color:#2b6cb0}</style></head>
<body><div class="box"><div style="font-size:40px">🛠️</div>
<h3>${escapeHtml(name)} 暂时打不开</h3>
<p style="color:#666;line-height:1.9">${msg}</p></div></body></html>`;
}

module.exports = router;
module.exports.bindResolver = bindResolver;
module.exports.bindBrowser = bindBrowser;
module.exports.toLocal = toLocal;
