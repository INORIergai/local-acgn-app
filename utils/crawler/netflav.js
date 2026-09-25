/**
 * Netflav（netflav.com）番号搜索
 *
 * 站点是 Next.js，搜索结果直接 SSR 在页面里的 __NEXT_DATA__ JSON 中，
 * 所以解析 JSON 就够，不用抓 DOM（DOM 会随他们改版失效）。
 *
 * ponytail: 只走 type=id 按番号精确搜；要关键词搜再加 type=title。
 */
const { Request } = require('./base');
const config = require('../config');

async function searchNetflavByAvid(avid) {
  if (!avid) return null;
  const baseUrl = config.sources?.netflav?.baseUrl || 'https://netflav.com';
  const url = `${baseUrl}/search?type=id&keyword=${encodeURIComponent(avid)}`;

  const req = new Request({ timeout: 20000 });
  const res = await req.get(url);
  if (!res.ok) throw new Error(`netflav HTTP ${res.status}`);
  const html = await res.text();

  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('netflav 页面结构变了：找不到 __NEXT_DATA__');

  let docs = [];
  try {
    docs = JSON.parse(m[1])?.props?.initialState?.search?.docs || [];
  } catch (e) {
    throw new Error(`netflav __NEXT_DATA__ 解析失败: ${e.message}`);
  }
  if (!docs.length) return null;

  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const doc = docs.find((d) => norm(d.code) === norm(avid)) || docs[0];

  const title = String(doc.title || doc.title_zh || doc.title_en || doc.code || '').replace(/^\[[^\]]*\]/, '').trim();
  const actors = Array.isArray(doc.actors) ? doc.actors.filter((a) => !/^[a-z]{2}:/.test(a)) : [];

  return {
    num: doc.code || avid,
    title,
    originalTitle: doc.title_en || title,
    cover: doc.preview_hp || doc.preview || '',
    releaseDate: doc.sourceDate ? String(doc.sourceDate).slice(0, 10) : '',
    producer: '',
    publisher: '',
    director: '',
    serial: '',
    score: 0,
    actress: [...new Set(actors)],
    genres: doc.isNs1 || doc.isNs2 ? ['無修正'] : [],
    duration: 0,
    overview: '',
    sampleImages: doc.previewImagesUrl ? [doc.previewImagesUrl] : [],
    previewVideo: doc.previewVideo || '',
    source: 'netflav',
    detailUrl: `${baseUrl}/video/${doc.videoId || doc._id || ''}`
  };
}

module.exports = { searchNetflavByAvid };
