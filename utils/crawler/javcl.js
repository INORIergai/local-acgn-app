/**
 * JavCL（javcl.com）番号搜索
 *
 * 免登录就能用：`/movie/<番号小写>` 会 301 到它的 slug 页（例如
 * /ssis-823-im-standing-upright-...），node-fetch 默认跟跳转，所以一次 GET 就拿到影片页。
 * 页面自带 og:image / og:title，解析 meta 就够了 —— 别去抓他们的 DOM。
 */
const { load } = require('cheerio');
const { Request } = require('./base');
const config = require('../config');

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function searchJavclByAvid(avid) {
  if (!avid) return null;
  const baseUrl = config.sources?.javcl?.baseUrl || 'https://javcl.com';
  const req = new Request({ timeout: 20000 });

  const res = await req.get(`${baseUrl}/movie/${encodeURIComponent(String(avid).toLowerCase())}`);
  if (res.status === 404) return null;               // 站上没有这个番号，不是错误
  if (!res.ok) throw new Error(`javcl HTTP ${res.status}`);
  const $ = load(await res.text());

  const title = ($('meta[property="og:title"]').attr('content') || '').trim();
  const cover = ($('meta[property="og:image"]').attr('content') || '').trim();

  // 站内搜不到时会跳到首页/搜索页，标题里没有番号 —— 不当命中
  if (!cover || !norm(title).includes(norm(avid))) return null;

  // og:description 形如 "... by S1 NO.1 STYLE production, has Miru, Sakamichi Miru actor, ..."
  const desc = ($('meta[property="og:description"]').attr('content') || '').trim();
  const producer = (desc.match(/by (.+?) production/i) || [])[1] || '';
  const actress = [];
  const hasPart = (desc.match(/\bhas (.+?) actor/i) || [])[1];
  if (hasPart) hasPart.split(',').forEach((n) => {
    const name = n.trim();
    if (name && !actress.includes(name)) actress.push(name);
  });

  return {
    num: avid,
    title: title.replace(/&#0?39;/g, "'"),
    originalTitle: title.replace(/&#0?39;/g, "'"),
    cover,
    releaseDate: '',
    producer,
    publisher: '',
    director: '',
    serial: '',
    score: 0,
    actress,
    genres: [],
    duration: 0,
    overview: desc,
    sampleImages: [],
    source: 'javcl',
    detailUrl: res.url || `${baseUrl}/movie/${avid}`
  };
}

module.exports = { searchJavclByAvid };
