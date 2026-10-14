const { Request } = require('./base');
const config = require('../config');

function getBaseUrl() {
  const src = config.sources?.javdb;
  return src?.mirror || src?.baseUrl || 'https://javdb.com';
}

/**
 * JavDB 搜索并获取详情
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchJavDBByAvid(avid) {
  const baseUrl = getBaseUrl();
  const req = new Request({
    uaType: 'chrome',
    referer: baseUrl + '/'
  });

  try {
    // 1. 搜索页面
    const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(avid)}&f=all`;
    const $ = await req.getHtml(searchUrl);

    // 找到精确匹配的番号
    let detailPath = null;
    const numberUpper = avid.toUpperCase().replace(/-/g, '');

    $('.movie-list .item').each((_, item) => {
      if (detailPath) return;
      const uid = $(item).find('.video-title strong').text().trim();
      const uidNorm = uid.toUpperCase().replace(/-/g, '');
      if (uidNorm === numberUpper) {
        const link = $(item).find('a[href^="/v/"]');
        if (link.length) {
          detailPath = link.attr('href');
        }
      }
    });

    if (!detailPath) {
      console.log(`[JavDB] 未找到番号: ${avid}`);
      return null;
    }

    // 2. 详情页
    const detailUrl = `${baseUrl}${detailPath}`;
    const $detail = await req.getHtml(detailUrl);

    // 标题
    const title = $detail('.video-detail h2, .title.is-4').first().text().trim()
      .replace(new RegExp(`^${avid}\\s*`, 'i'), '');

    // 封面
    let cover = $detail('.video-cover img, .column-video-cover img').first().attr('src') || '';
    // 小图转大图
    if (cover) {
      cover = cover.replace('ps.jpg', 'pl.jpg').replace('/pt/', '/pl/');
    }

    // 解析信息面板
    let releaseDate = '';
    let producer = '';
    let publisher = '';
    let director = '';
    let serial = '';
    let score = 0;
    const actress = [];
    const genres = [];

    $detail('.panel-block').each((_, panel) => {
      const label = $detail(panel).find('strong').text().trim();
      const value = $detail(panel).find('.value');

      if (label.includes('日期') && value.length) {
        releaseDate = value.text().trim();
      }
      if ((label.includes('片商') || label.includes('製作')) && !label.includes('日期')) {
        if (value.length) producer = value.text().trim();
      }
      if (label.includes('發行') && !label.includes('日期')) {
        if (value.length) publisher = value.text().trim();
      }
      if (label.includes('導演')) {
        if (value.length) director = value.text().trim();
      }
      if (label.includes('系列')) {
        if (value.length) serial = value.text().trim();
      }
      if (label.includes('評分') && value.length) {
        const m = value.text().match(/([0-9.]+)\s*分/);
        if (m) score = parseFloat(m[1]);
      }
      if (label.includes('演員')) {
        $detail(panel).find('a').each((_, a) => {
          const name = $detail(a).text().trim();
          if (!name) return;
          // 检查性别标记，跳过男优
          const next = $detail(a).next();
          const classes = next.attr('class') || '';
          if (classes.includes('male') && !classes.includes('female')) return;
          actress.push(name);
        });
      }
      if (label.includes('類別')) {
        $detail(panel).find('a').each((_, a) => {
          const tag = $detail(a).text().trim();
          if (tag) genres.push(tag);
        });
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
      publisher,
      director,
      serial,
      score,
      actress,
      genres,
      duration: 0,
      source: 'javdb',
      detailUrl
    };

  } catch (e) {
    console.log(`[JavDB] 爬取失败 [${avid}]:`, e.message);
    return null;
  }
}

/**
 * JavDB 按女优名搜索作品列表
 * @param {string} actressName 女优名
 * @param {number} page 页码
 * @returns {Array} 作品列表
 */
async function searchJavDBByActress(actressName, page = 1) {
  const baseUrl = getBaseUrl();
  const req = new Request({
    uaType: 'chrome',
    referer: baseUrl + '/'
  });

  try {
    const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(actressName)}&f=all&page=${page}`;
    const $ = await req.getHtml(searchUrl);

    const results = [];
    $('.movie-list .item').each((_, item) => {
      const $item = $(item);
      
      // 番号
      const num = $item.find('.video-title strong').text().trim();
      
      // 标题
      const title = $item.find('.video-title').text().trim().replace(num, '').trim();
      
      // 封面
      let cover = $item.find('.video-cover img, img').first().attr('src') || '';
      if (cover) {
        cover = cover.replace('ps.jpg', 'pl.jpg').replace('/pt/', '/pl/');
      }
      
      // 详情链接
      const link = $item.find('a[href^="/v/"]');
      const detailPath = link.attr('href') || '';
      const detailUrl = detailPath ? `${baseUrl}${detailPath}` : '';
      
      if (num && title) {
        results.push({
          num,
          title,
          cover,
          url: detailUrl,
          source: 'javdb'
        });
      }
    });

    console.log(`[JavDB] 搜索女优 "${actressName}"，第${page}页，找到 ${results.length} 个结果`);
    return results;

  } catch (e) {
    console.log(`[JavDB] 女优搜索失败 [${actressName}]:`, e.message);
    return [];
  }
}

module.exports = { searchJavDBByAvid, searchJavDBByActress };
