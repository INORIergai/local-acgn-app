/**
 * Jable（jable.tv）番号搜索 —— 必须用真浏览器
 *
 * 这个站全站在 Cloudflare 人机验证后面：curl/node-fetch 无论带什么 UA 都是 403
 * （页面是 "Just a moment..."）。只有真实 Chromium 能过，所以这里用 Playwright。
 *
 * 两个关键动作，缺一不可：
 *   1. **先访问首页**把 cf 挑战过掉（同一 context 里后续请求就带通行证了）；
 *   2. 搜索页的卡片是 `.video-img-box`，图在 `img[data-src]`。
 *
 * 海报是它的预览截图（`preview.jpg`，横版），质量不如 DMM 的竖版海报，
 * 所以这个源在 sourcePriority 里排在最后、只当兜底（见 references/scraper-sources.md）。
 */
const { chromium } = require('playwright');
const config = require('../config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** 等 Cloudflare 挑战自己过：标题不再是 "Just a moment..." 就算过了 */
async function waitChallenge(page, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await page.title().catch(() => '');
    if (t && !/just a moment|attention required/i.test(t)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function launch() {
  const opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  };
  const proxyServer = config.network?.proxyServer;
  if (proxyServer) opts.proxy = { server: proxyServer };
  const browser = await chromium.launch(opts);
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 800 }, locale: 'zh-TW' });
  return { browser, context };
}

async function searchJableByAvid(avid) {
  if (!avid) return null;
  const baseUrl = (config.sources?.jable?.baseUrl || 'https://jable.tv').replace(/\/$/, '');
  const { browser, context } = await launch();
  try {
    const page = await context.newPage();

    // 1. 首页过挑战（拿到 cf 通行证）
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitChallenge(page))) throw new Error('jable 首页没过 Cloudflare 挑战');

    // 2. 搜索页找精确命中
    await page.goto(`${baseUrl}/search/${encodeURIComponent(avid)}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!(await waitChallenge(page))) throw new Error('jable 搜索页没过 Cloudflare 挑战');

    const hit = await page.evaluate((want) => {
      const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (const box of document.querySelectorAll('.video-img-box')) {
        const a = box.querySelector('a[href*="/videos/"]');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        const title = (box.innerText || '').replace(/\s+/g, ' ').trim();
        if (norm(href).includes(norm(want)) || norm(title).includes(norm(want))) {
          const img = box.querySelector('img');
          return { href, title, thumb: (img && (img.getAttribute('data-src') || img.src)) || '' };
        }
      }
      return null;
    }, avid);
    if (!hit) return null;

    // 3. 进影片页取 og:image（比列表缩略图大）
    const detailUrl = hit.href.startsWith('http') ? hit.href : baseUrl + hit.href;
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitChallenge(page, 12000);

    const detail = await page.evaluate(() => {
      const mp = (p) => (document.querySelector(`meta[property="${p}"]`) || {}).content || '';
      const text = document.body.innerText || '';
      return {
        ogTitle: mp('og:title'),
        ogImage: mp('og:image'),
        duration: (text.match(/\d{1,2}:\d{2}:\d{2}/) || [''])[0],
        actresses: [...document.querySelectorAll('a[href*="/models/"]')]
          .map((a) => a.innerText.trim())
          .filter((n) => n && n.length >= 2 && !n.includes('按') && !n.includes('女優'))
          .slice(0, 5)
      };
    });

    const durationSec = (() => {
      const p = (detail.duration || '').split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0;
    })();

    return {
      num: avid,
      title: detail.ogTitle || hit.title || avid,
      originalTitle: hit.title || detail.ogTitle || avid,
      cover: detail.ogImage || hit.thumb,
      releaseDate: '',
      producer: '',
      publisher: '',
      director: '',
      serial: '',
      score: 0,
      actress: detail.actresses,
      genres: [],
      duration: durationSec,
      overview: '',
      sampleImages: [],
      source: 'jable',
      detailUrl
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { searchJableByAvid };
