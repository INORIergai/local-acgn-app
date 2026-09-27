#!/usr/bin/env node
/**
 * poster-relay.js —— 宿主机侧「海报中转」小服务
 *
 * 为什么需要它：
 *   本库跑在 Docker 容器里（`local-movie-library`）。实测这个容器的出网被掐得很死 ——
 *   除了极少数国内站（如 mzh.moegirl.org.cn）以外，打任何外网域名都在 ~5s 后被 RST。
 *   而**宿主机**的出网明显更宽（实测 AniList 200 / Jikan 200 / anime1.me 200）。
 *   所以让容器把请求交给宿主机代发，就白嫖了宿主机的网络出口。
 *
 * 起法：双击 tools/启动海报中转.bat，或  node tools/poster-relay.js
 * 配置：config.docker.json → network.relay { enabled, url, token, port }
 *
 * 接口：
 *   GET /health                         → { ok, ts, upstream, chromium }
 *   GET /proxy?url=<enc>&referer=<enc>  → 原样转发（图片 / HTML 都能取）
 *   GET /anilist?q=<kw>&limit=<n>       → AniList 搜索，返回归一化的动画列表（含封面）
 *
 * 安全：默认只监听 0.0.0.0（容器要走 host.docker.internal 过来），所以必须带 token。
 *       token 在 config.docker.json 的 network.relay.token 里，改掉就会同步失效。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');

// ---------- 配置 ----------
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.docker.json'), 'utf8')); } catch (e) { }
const RELAY = (CFG.network && CFG.network.relay) || {};

const PORT = Number(process.env.RELAY_PORT || RELAY.port || 8787);
const BIND = process.env.RELAY_HOST || '0.0.0.0';
const TOKEN = process.env.RELAY_TOKEN || RELAY.token || '';

// 上游代理：留空 = 直连。填了就先直连、直连失败再走它。
// （本机那个 http://host.docker.internal:7892 现在对所有上游返回 502，节点挂了，
//   所以默认不启用；等你的代理能用了，在 network.relay.upstreamProxy 里填上即可）
const UPSTREAM = process.env.RELAY_PROXY || RELAY.upstreamProxy || '';

let HttpsProxyAgent = null;
try { HttpsProxyAgent = require(path.join(ROOT, 'node_modules', 'https-proxy-agent')).HttpsProxyAgent; } catch (e) { }

const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT = 20000;
const MAX_REDIRECT = 4;

// ---------- 工具 ----------
function log(...a) {
  console.log('[' + new Date().toLocaleTimeString('zh-CN') + ']', ...a);
}

/** 单次请求（可带代理），把响应整体读回来 */
function once(url, { referer, proxy, timeout = TIMEOUT, method = 'GET', body, headers } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('url 不合法: ' + url)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('只允许 http/https'));

    const mod = u.protocol === 'http:' ? http : https;
    const t0 = Date.now();
    const opts = {
      method,
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7'
      }, referer ? { Referer: referer } : {}, headers || {}),
    };
    if (proxy) opts.agent = new HttpsProxyAgent(proxy);

    const req = mod.request(url, opts, (res) => {
      // 重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (req.__hop || 0) < MAX_REDIRECT) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        const hop = (req.__hop || 0) + 1;
        return once(next, { referer, proxy, timeout, method: res.statusCode === 303 ? 'GET' : method, body, headers })
          .then(r => { r.hops = hop; resolve(r); })
          .catch(reject);
      }
      const chunks = [];
      let n = 0;
      const abort = () => { res.destroy(); reject(new Error('响应超过 ' + (MAX_BYTES / 1048576) + 'MB')); };
      res.on('data', (c) => { n += c.length; if (n > MAX_BYTES) return abort(); chunks.push(c); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        buf: Buffer.concat(chunks),
        ms: Date.now() - t0,
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('TIMEOUT ' + timeout + 'ms')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 直连优先，失败再试上游代理 */
async function fetchUrl(url, opts = {}) {
  const attempts = [{ tag: 'direct', proxy: null }];
  if (UPSTREAM) attempts.push({ tag: 'proxy', proxy: UPSTREAM });
  let lastErr = null;
  for (const a of attempts) {
    try {
      const r = await once(url, Object.assign({}, opts, { proxy: a.proxy }));
      r.via = a.tag;
      return r;
    } catch (e) {
      lastErr = e;
      log('  取数失败(' + a.tag + '):', url.slice(0, 90), '→', e.code || e.message);
    }
  }
  throw lastErr || new Error('取数失败');
}

/** AniList GraphQL */
const ANILIST_Q = `
query ($s: String, $n: Int) {
  Page(page: 1, perPage: $n) {
    media(search: $s, type: ANIME, sort: SEARCH_MATCH) {
      id
      title { native romaji english }
      startDate { year month day }
      coverImage { extraLarge large color }
      bannerImage
      siteUrl
      episodes
      format
    }
  }
}`;

async function anilistSearch(q, n) {
  const payload = JSON.stringify({ query: ANILIST_Q, variables: { s: q, n } });
  const r = await fetchUrl('https://graphql.anilist.co/', {
    method: 'POST',
    body: payload,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 15000,
  });
  if (r.status !== 200) throw new Error('AniList HTTP ' + r.status);
  const j = JSON.parse(r.buf.toString('utf8'));
  const media = (j.data && j.data.Page && j.data.Page.media) || [];
  return media.map(m => ({
    title: (m.title && (m.title.native || m.title.romaji || m.title.english)) || '',
    titleRomaji: (m.title && m.title.romaji) || '',
    titleEnglish: (m.title && m.title.english) || '',
    year: m.startDate && m.startDate.year || null,
    cover: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '',
    banner: m.bannerImage || '',
    color: (m.coverImage && m.coverImage.color) || '',
    url: m.siteUrl || '',
    episodes: m.episodes || null,
    format: m.format || '',
    source: 'anilist',
  })).filter(x => x.cover);
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function authed(req, u) {
  if (!TOKEN) return true;
  const t = req.headers['x-relay-token'] || u.searchParams.get('token') || '';
  return t === TOKEN;
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { return sendJson(res, 400, { ok: false, msg: 'bad url' }); }

  try {
    if (u.pathname === '/health') {
      return sendJson(res, 200, { ok: true, ts: Date.now(), upstream: UPSTREAM || null, port: PORT, tokenRequired: !!TOKEN });
    }

    if (!authed(req, u)) return sendJson(res, 401, { ok: false, msg: 'token 不对' });

    if (u.pathname === '/proxy') {
      const target = u.searchParams.get('url');
      if (!target) return sendJson(res, 400, { ok: false, msg: '缺少 url' });
      const referer = u.searchParams.get('referer') || '';
      const r = await fetchUrl(target, { referer });
      res.writeHead(r.status, {
        'Content-Type': r.headers['content-type'] || 'application/octet-stream',
        'Content-Length': r.buf.length,
        'Cache-Control': 'public, max-age=86400',
        'X-Relay-Via': r.via || '',
        'X-Relay-Ms': String(r.ms),
      });
      return res.end(r.buf);
    }

    if (u.pathname === '/anilist') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { ok: false, msg: '缺少 q' });
      const n = Math.min(Math.max(Number(u.searchParams.get('limit') || 6), 1), 20);
      const list = await anilistSearch(q, n);
      log('AniList 搜索 "' + q + '" → ' + list.length + ' 条');
      return sendJson(res, 200, { code: 0, data: list });
    }

    return sendJson(res, 404, { ok: false, msg: '未知接口：' + u.pathname });
  } catch (e) {
    log('处理失败:', u.pathname, e.code || e.message);
    return sendJson(res, 502, { ok: false, msg: (e.code || e.message || 'unknown') });
  }
});

server.listen(PORT, BIND, () => {
  log('海报中转已启动');
  log('  监听   : http://' + BIND + ':' + PORT);
  log('  容器用 : http://host.docker.internal:' + PORT);
  log('  token  : ' + (TOKEN ? TOKEN.slice(0, 8) + '…' : '(未设置，谁都能访问)'));
  log('  上游代理: ' + (UPSTREAM || '(直连)'));
});

process.on('SIGINT', () => { log('收到 Ctrl+C，退出'); process.exit(0); });
