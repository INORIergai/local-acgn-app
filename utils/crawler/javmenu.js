/**
 * JavMenu（javmenu.com）番号搜索
 *
 * 和 javcl 一样省事：**不用搜索**，`https://javmenu.com/<番号>` 直接就是影片页（大小写都行），
 * 封面和标题都在 og 标签里：
 *   og:title → "SSIS-823 鸡鸡被屁屁夹住了啦！SSIS-823 藍井優太 | Complete Japanese AV Database"
 *   og:image → 封面（可能落在 jdbstatic 或 666.9989641.xyz 的图片/视频缩略图）
 *
 * 注意：搜索页 `/search/<番号>` 的第一张卡经常是 Telegram 广告（"色站搭建服務"），
 * 所以这里干脆不走搜索页。
 */
const { load } = require('cheerio');
const { Request } = require('./base');
const config = require('../config');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function searchJavmenuByAvid(avid) {
  if (!avid) return null;
  const baseUrl = (config.sources?.javmenu?.baseUrl || 'https://javmenu.com').replace(/\/$/, '');
  const req = new Request({ timeout: 20000 });

  const res = await req.get(`${baseUrl}/${encodeURIComponent(String(avid).toUpperCase())}`);
  if (res.status === 404) return null;               // 站上没有这个番号，不是错误
  if (!res.ok) throw new Error(`javmenu HTTP ${res.status}`);
  const $ = load(await res.text());

  const ogTitle = ($('meta[property="og:title"]').attr('content') || '').trim();
  const cover = ($('meta[property="og:image"]').attr('content') || '').trim();

  // 页面标题里必然带番号；没有就说明这个番号在站上不存在
  if (!cover || !norm(ogTitle).includes(norm(avid))) return null;

  // "SSIS-823 标题… SSIS-823 女优名 | Complete Japanese AV Database"
  const body = ogTitle.split('|')[0].replace(new RegExp(`^${avid}\\s*`, 'i'), '').trim();
  const last = body.split(/\s{1,}/).pop() || '';
  const actress = last && last !== body && norm(last) !== norm(avid) ? [last] : [];

  return {
    num: avid,
    title: body || avid,
    originalTitle: body || avid,
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
    source: 'javmenu',
    detailUrl: `${baseUrl}/${avid}`
  };
}

module.exports = { searchJavmenuByAvid };
