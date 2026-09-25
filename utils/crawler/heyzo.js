const { Request } = require('./base');
const config = require('../config');
const cheerio = require('cheerio');

function getBaseUrl() {
  const src = config.sources?.heyzo;
  return src?.mirror || 'https://www.heyzo.com';
}

function getEnUrl() {
  const src = config.sources?.heyzo;
  return src?.mirror?.replace('://', '://en.') || 'https://en.heyzo.com';
}

/**
 * 从番号提取 HEYZO 数字 ID
 * HEYZO-0783 → "0783"
 */
function extractHeyzoNum(number) {
  number = number.trim().toUpperCase();
  const match = number.match(/^HEYZO-(\d+)$/);
  if (match) return match[1];
  if (/^\d+$/.test(number)) return number;
  return null;
}

/**
 * 提取 JSON-LD
 */
function extractJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const data = JSON.parse($(scripts[i]).html());
      if (data && data['@type'] === 'Movie') {
        return data;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

/**
 * 从 HTML table 提取补充数据
 */
function extractTableData($, html) {
  const result = { series: '', tags: [], duration: null, sample_images: [] };

  // Series
  const seriesRow = $('table.movieInfo tr').filter((_, tr) => {
    return $(tr).find('td').first().text().includes('Series');
  });
  if (seriesRow.length) {
    let seriesText = seriesRow.find('td').eq(1).text().trim();
    if (seriesText && [...seriesText].every(c => c === '-')) {
      seriesText = '';
    }
    result.series = seriesText;
  }

  // Tags（Type 字段）
  const tagsRow = $('table.movieInfo tr').filter((_, tr) => {
    return $(tr).find('td').first().text().includes('Type');
  });
  if (tagsRow.length) {
    result.tags = tagsRow.find('td').eq(1).find('a').map((_, a) => $(a).text().trim()).get().filter(t => t);
  }

  // Duration - 从 JS 变量 heyzo.duration 提取
  const durMatch = html.match(/"full"\s*:\s*"(\d{2}):(\d{2}):(\d{2})"/);
  if (durMatch) {
    try {
      const h = parseInt(durMatch[1]);
      const m = parseInt(durMatch[2]);
      result.duration = h * 60 + m;
    } catch (e) {}
  }

  // Sample images - dir_gallery + thumbnail 连番
  const dirMatch = html.match(/dir_gallery\s*=\s*"(\/contents\/[^"]+)"/);
  if (dirMatch) {
    const dirGallery = dirMatch[1];
    const siIdx = html.indexOf('sample-images');
    if (siIdx >= 0) {
      const section = html.substring(siIdx, siIdx + 5000);
      const galleryNums = section.match(/thumbnail_(\d{3})\.jpg/g) || [];
      for (const numStr of galleryNums) {
        const num = numStr.match(/(\d{3})/)[1];
        result.sample_images.push(`https://en.heyzo.com${dirGallery}${num}.jpg`);
      }
    }
  }

  return result;
}

/**
 * HEYZO 搜索并获取详情
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchHeyzoByAvid(avid) {
  const heyzoNum = extractHeyzoNum(avid);
  if (!heyzoNum) {
    console.log(`[HEYZO] 番号格式不匹配: ${avid}`);
    return null;
  }

  const enUrl = `${getEnUrl()}/moviepages/${heyzoNum}/index.html`;
  const jaUrl = `${getBaseUrl()}/moviepages/${heyzoNum}/index.html`;

  const req = new Request({
    uaType: 'chrome',
    headers: {
      'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
    }
  });

  try {
    const res = await req.get(enUrl);
    if (!res.ok) {
      console.log(`[HEYZO] HTTP ${res.status}: ${avid}`);
      return null;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // 提取 JSON-LD
    const jsonLd = extractJsonLd($);
    if (!jsonLd) {
      console.log(`[HEYZO] JSON-LD 解析失败: ${avid}`);
      return null;
    }

    // 标题
    const title = jsonLd.name || '';
    if (!title) return null;

    // 女优
    let actressNames = [];
    const actorData = jsonLd.actor;
    if (actorData && typeof actorData === 'object' && !Array.isArray(actorData)) {
      if (actorData.name) actressNames = [actorData.name];
    } else if (Array.isArray(actorData)) {
      actressNames = actorData.map(a => a.name).filter(n => n);
    }

    // 日期
    let date = '';
    const dateCreated = jsonLd.dateCreated || '';
    if (dateCreated) date = dateCreated.substring(0, 10);

    // 封面
    let coverUrl = jsonLd.image || '';
    if (coverUrl.startsWith('//')) coverUrl = 'https:' + coverUrl;

    // 评分
    let rating = 0;
    const aggRating = jsonLd.aggregateRating;
    if (aggRating && aggRating.ratingValue) {
      rating = parseFloat(aggRating.ratingValue);
    }

    // 简介
    const summary = jsonLd.description || '';

    // 从 table 提取补充数据
    const tableData = extractTableData($, html);

    return {
      title,
      originalTitle: title,
      cover: coverUrl,
      releaseDate: date,
      producer: 'HEYZO',
      publisher: '',
      director: '',
      serial: tableData.series,
      score: rating,
      actress: actressNames,
      genres: tableData.tags,
      duration: tableData.duration || 0,
      overview: summary,
      sampleImages: tableData.sample_images,
      source: 'heyzo',
      detailUrl: jaUrl
    };

  } catch (e) {
    console.log(`[HEYZO] 爬取失败 [${avid}]:`, e.message);
    return null;
  }
}

module.exports = { searchHeyzoByAvid };
