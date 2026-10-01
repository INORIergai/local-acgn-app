/**
 * OneJAV（onejav.com）番号搜索
 *
 * 注意两点：
 * 1. 搜索页是**模糊**的（搜 SSIS-823 会连带返回 ssis873 / ssis883），必须自己按番号精确比对。
 * 2. 内页 id 不带横杠：/torrent/ssis873，所以要从搜索页拿到的真实 href 进去，别自己拼。
 */
const { load } = require('cheerio');
const { Request } = require('./base');
const config = require('../config');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function searchOnejavByAvid(avid) {
  if (!avid) return null;
  const baseUrl = config.sources?.onejav?.baseUrl || 'https://onejav.com';
  const req = new Request({ timeout: 20000 });

  const res = await req.get(`${baseUrl}/search/${encodeURIComponent(avid)}`);
  if (res.status === 404) return null;               // 搜不到就是没结果
  if (!res.ok) throw new Error(`onejav HTTP ${res.status}`);
  const $ = load(await res.text());

  let href = '';
  $('a[href^="/torrent/"]').each((i, el) => {
    if (href) return;
    const h = $(el).attr('href') || '';
    const m = h.match(/^\/torrent\/([^/?#]+)/);
    if (m && norm(m[1]) === norm(avid)) href = `/torrent/${m[1]}`;
  });
  if (!href) return null;

  const detail = await req.get(baseUrl + href);
  if (!detail.ok) throw new Error(`onejav 详情 HTTP ${detail.status}`);
  const $$ = load(await detail.text());

  const cover = $$('img.image').first().attr('src') || '';
  const title = ($$('title').text() || '').split(' - OneJAV')[0].trim() || avid;
  const actress = [];
  $$('a[href^="/actress/"]').each((i, el) => {
    const n = $$(el).text().trim();
    // 页面上有个 "Actresses" 小标题也指向 /actress/，别把它当人名
    if (n && n.length >= 2 && !/^actress/i.test(n) && !actress.includes(n)) actress.push(n);
  });

  return {
    num: avid,
    title,
    originalTitle: title,
    cover,
    releaseDate: '',
    producer: '',
    publisher: '',
    director: '',
    serial: '',
    score: 0,
    actress,
    genres: [],
    duration: 0,
    overview: '',
    sampleImages: [],
    source: 'onejav',
    detailUrl: baseUrl + href
  };
}

module.exports = { searchOnejavByAvid };
