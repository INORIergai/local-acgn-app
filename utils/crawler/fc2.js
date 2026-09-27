const { Request } = require('./base');
const config = require('../config');
const cheerio = require('cheerio');

function getBaseUrl() {
  const src = config.sources?.fc2;
  return src?.mirror || 'https://javten.com';
}

/**
 * 正规化 FC2 番号
 * FC2-PPV-1234567 → 1234567
 */
function normalizeFc2Number(number) {
  number = number.toUpperCase().trim();
  number = number.replace(/^FC2[-_]?PPV[-_]?/, '');
  number = number.replace(/^FC2[-_]?/, '');
  number = number.replace(/-/g, '').replace(/_/g, '');
  return number;
}

/**
 * 提取 JSON-LD 中的评分
 */
function getRating($) {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const data = JSON.parse($(scripts[i]).html());
      // 处理多种 JSON-LD 格式：dict、list、@graph
      let nodes = [];
      if (Array.isArray(data)) {
        nodes = data;
      } else if (typeof data === 'object') {
        nodes = [data];
        if (Array.isArray(data['@graph'])) {
          nodes = nodes.concat(data['@graph']);
        }
      }
      for (const node of nodes) {
        if (node && node.aggregateRating && node.aggregateRating.ratingValue) {
          return parseFloat(node.aggregateRating.ratingValue);
        }
      }
    } catch (e) {
      continue;
    }
  }
  return 0;
}

/**
 * FC2 搜索并获取详情（使用 javten.com 镜像站）
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchFc2ByAvid(avid) {
  const fc2Number = normalizeFc2Number(avid);
  if (!fc2Number || !/^\d+$/.test(fc2Number)) {
    console.log(`[FC2] 番号格式不匹配: ${avid}`);
    return null;
  }

  const baseUrl = getBaseUrl();
  const req = new Request({
    uaType: 'chrome',
    headers: {
      'Accept-Language': 'ja,en;q=0.9',
    }
  });

  try {
    // 1. 搜索
    const searchUrl = `${baseUrl}/search?kw=${fc2Number}`;
    const $search = await req.getHtml(searchUrl);

    // 找符合番号的链接
    let detailPath = null;
    const links = $search(`a[href*="id${fc2Number}"]`);
    
    if (links.length === 0) {
      console.log(`[FC2] 未找到番号: ${avid}`);
      return null;
    }

    // 优先选择日文版（排除 /tw/, /ko/, /en/）
    for (let i = 0; i < links.length; i++) {
      const href = $search(links[i]).attr('href') || '';
      if (!['/tw/', '/ko/', '/en/'].some(lang => href.includes(lang))) {
        detailPath = href;
        break;
      }
    }

    if (!detailPath) {
      detailPath = $search(links[0]).attr('href');
    }

    if (!detailPath) return null;

    // 2. 详情页
    const detailUrl = detailPath.startsWith('http') ? detailPath : baseUrl + detailPath;
    const $detail = await req.getHtml(detailUrl);

    // 标题（第二个 h1）
    const h1s = $detail('h1');
    let title = '';
    if (h1s.length > 1) {
      title = $detail(h1s[1]).text().trim();
    } else if (h1s.length === 1) {
      title = $detail(h1s[0]).text().trim();
    }

    if (!title) return null;

    // 封面
    let cover = '';
    const galleryLink = $detail('a[data-fancybox="gallery"]').first();
    if (galleryLink.length) {
      cover = galleryLink.attr('href') || '';
      if (cover.startsWith('//')) cover = 'https:' + cover;
    }

    // 剧照
    const sampleImages = [];
    $detail('div[style="padding: 0"] a').each((_, a) => {
      let href = $detail(a).attr('href') || '';
      if (href) {
        if (href.startsWith('//')) href = 'https:' + href;
        sampleImages.push(href);
      }
    });

    // 卖家（作为片商）
    let studio = '';
    const studioCol = $detail('.col-8').first();
    if (studioCol.length) {
      studio = studioCol.text().trim();
    }

    // 标签
    const tags = [];
    $detail('p.card-text a[href*="/tag/"]').each((_, a) => {
      const tag = $detail(a).text().trim();
      if (tag) tags.push(tag);
    });

    // 简介
    let overview = '';
    const desCol = $detail('.col.des').first();
    if (desCol.length) {
      overview = desCol.text().replace(/\\n/g, ' ').replace(/・/g, '').trim();
    }

    // 评分
    const score = getRating($detail);

    // 移除无修正标签
    const filteredTags = tags.filter(t => !['無修正', '无修正'].includes(t));

    return {
      title,
      originalTitle: title,
      cover,
      releaseDate: '',
      producer: studio,
      publisher: '',
      director: '',
      serial: '',
      score,
      actress: studio ? [studio] : [],
      genres: filteredTags,
      duration: 0,
      overview,
      sampleImages,
      source: 'fc2',
      detailUrl
    };

  } catch (e) {
    console.log(`[FC2] 爬取失败 [${avid}]:`, e.message);
    return null;
  }
}

module.exports = { searchFc2ByAvid };
