const { Request } = require('./base');
const config = require('../config');

function getBaseUrl() {
  const src = config.sources?.jav321;
  return src?.mirror || src?.baseUrl || 'https://www.jav321.com';
}

function _forceHttps(url) {
  if (url && url.startsWith('http://')) {
    return 'https://' + url.slice('http://'.length);
  }
  return url;
}

/**
 * Jav321 搜索并获取详情
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchJav321ByAvid(avid) {
  const baseUrl = getBaseUrl();
  const req = new Request({ uaType: 'chrome' });

  try {
    // POST 搜索
    const searchUrl = `${baseUrl}/search`;
    const $search = await req.postHtml(searchUrl, { sn: avid });

    let $detail = $search;
    let detailUrl = '';

    // 检查是否直接跳转到详情页
    const htmlStr = $search.html();
    if (!htmlStr.includes('/video/') || !$search('h3').length) {
      // 解析搜索结果，找第一个匹配
      const link = $search('.row a[href*="/video/"]').first();
      if (!link.length) {
        console.log(`[Jav321] 未找到番号: ${avid}`);
        return null;
      }
      const href = link.attr('href') || '';
      detailUrl = new URL(href, baseUrl).href;
      $detail = await req.getHtml(detailUrl);
    } else {
      detailUrl = `${baseUrl}/video/${avid.toLowerCase()}`;
    }

    // 标题
    let title = $detail('h3').first().text().trim();
    title = title.replace(new RegExp(`^${avid}\\s*`, 'i'), '');

    // 封面
    let cover = $detail('.col-md-3 img').first().attr('src') || '';
    if (cover && !cover.startsWith('http')) {
      cover = new URL(cover, baseUrl).href;
    }
    // DMM 小图转大图
    if (cover) {
      cover = cover.replace('ps.jpg', 'pl.jpg').replace('/pt/', '/pl/');
      cover = _forceHttps(cover);
    }

    // 演员（去重）
    const actress = [];
    const seenNames = new Set();
    $detail('a[href*="/star/"]').each((_, a) => {
      const name = $detail(a).text().trim();
      if (name && !seenNames.has(name)) {
        actress.push(name);
        seenNames.add(name);
      }
    });

    // 日期（从全文匹配）
    let releaseDate = '';
    const dateMatch = htmlStr.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) releaseDate = dateMatch[1];

    // 标签
    const genres = [];
    $detail('a[href*="/genre/"]').each((_, a) => {
      const tag = $detail(a).text().trim();
      if (tag) genres.push(tag);
    });

    // 解析 col-md-9 区块的详细字段
    let producer = '';
    let duration = 0;
    let serial = '';
    let score = 0;
    let overview = '';

    const col9 = $detail('.col-md-9').first();
    if (col9.length) {
      col9.find('b').each((_, b) => {
        const label = $detail(b).text().trim();
        
        // 片商
        if (label === 'メーカー') {
          let next = b.nextSibling;
          while (next && next.type !== 'tag') next = next.nextSibling;
          if (next && next.name === 'a') {
            producer = $detail(next).text().trim();
          }
        }
        
        // 时长
        if (label === '収録時間') {
          let next = b.nextSibling;
          if (next) {
            const text = next.type === 'text' ? next.data : '';
            const m = text.match(/(\d+)/);
            if (m) duration = parseInt(m[1]);
          }
        }
        
        // 系列
        if (label === 'シリーズ') {
          let next = b.nextSibling;
          while (next && next.type !== 'tag') next = next.nextSibling;
          if (next && next.name === 'a') {
            serial = $detail(next).text().trim();
          }
        }
        
        // 评分
        if (label === '平均評価') {
          let next = b.nextSibling;
          if (next) {
            const text = next.type === 'text' ? next.data : '';
            const m = text.match(/([0-9.]+)/);
            if (m) score = parseFloat(m[1]);
          }
        }
      });

      // 简介
      const mainPanel = col9.find('.panel-body').first();
      if (mainPanel.length) {
        mainPanel.find('.row .col-md-12').each((_, col) => {
          if (overview) return;
          const text = $detail(col).text().trim();
          if (text && text.length > 20) {
            overview = text;
          }
        });
      }
    }

    // 截图（跳过封面第0张）
    const sampleImages = [];
    $detail('a[href*="/snapshot/"]').each((_, a) => {
      const href = $detail(a).attr('href') || '';
      if (href.endsWith('/0')) return;
      const img = $detail(a).find('img');
      let src = img.attr('src') || '';
      if (src) {
        if (src.startsWith('http')) {
          sampleImages.push(_forceHttps(src));
        } else {
          sampleImages.push(_forceHttps(new URL(src, baseUrl).href));
        }
      }
    });

    if (!title && !cover) {
      return null;
    }

    return {
      title,
      originalTitle: title,
      cover,
      releaseDate,
      producer,
      publisher: '',
      director: '',
      serial,
      score,
      actress,
      genres,
      duration,
      overview,
      sampleImages,
      source: 'jav321',
      detailUrl: detailUrl || `${baseUrl}/video/${avid.toLowerCase()}`
    };

  } catch (e) {
    console.log(`[Jav321] 爬取失败 [${avid}]:`, e.message);
    return null;
  }
}

module.exports = { searchJav321ByAvid };
