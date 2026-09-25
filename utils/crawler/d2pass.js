const { Request } = require('./base');
const config = require('../config');
const cheerio = require('cheerio');

const SITES = {
  '1pondo': 'https://www.1pondo.tv/dyn/phpauto/movie_details/movie_id/{id}.json',
  'caribbeancom': 'https://b.caribbeancom.com/dyn/phpauto/movie_details/movie_id/{id}.json',
  '10musume': 'https://www.10musume.com/dyn/phpauto/movie_details/movie_id/{id}.json',
};

const SITE_DETAIL_URL = {
  '1pondo': 'https://www.1pondo.tv/movies/{id}/',
  'caribbeancom': 'https://www.caribbeancom.com/moviepages/{id}/index.html',
  '10musume': 'https://www.10musume.com/moviepages/{id}/index.html',
};

function getConfig() {
  return config.sources?.d2pass || {};
}

/**
 * 根据番号格式检测站点尝试顺序
 * DDMMYY-NNN → Caribbeancom first
 * DDMMYY_NNN → 1Pondo first
 * DDMMYY_NN → 10musume first
 */
function detectSiteOrder(number) {
  if (/^\d{6}-\d{2,3}$/.test(number)) {
    return ['caribbeancom', '1pondo', '10musume'];
  } else if (/^\d{6}_\d{3}$/.test(number)) {
    return ['1pondo', 'caribbeancom', '10musume'];
  } else if (/^\d{6}_\d{2}$/.test(number)) {
    return ['10musume', '1pondo', 'caribbeancom'];
  }
  return ['1pondo', 'caribbeancom', '10musume'];
}

/**
 * 解析 D2Pass JSON
 */
function parseJson(data, site, movieId) {
  if (!data.Status) return null;

  const title = data.Title || data.TitleEn || '';
  if (!title) return null;

  // 女优
  let actressNames = data.ActressesJa || data.ActressesEn || [];
  if (!actressNames.length && data.ActressesList) {
    actressNames = Object.values(data.ActressesList)
      .map(v => v.NameJa || v.NameEn || '')
      .filter(n => n);
  }

  // 封面
  let cover = data.ThumbHigh || data.MovieThumb || '';
  if (!cover && site === 'caribbeancom') {
    cover = `https://www.caribbeancom.com/moviepages/${movieId}/images/l_l.jpg`;
  }
  if (!cover && site === '1pondo') {
    cover = `https://www.1pondo.tv/assets/sample/${movieId}/str.jpg`;
  }

  // 标签
  let tags = data.UCNAME || data.UCNAMEEn || [];
  tags = tags.filter(t => !/^\d+p$/.test(t));

  // 评分
  let score = 0;
  if (data.AvgRating !== undefined && data.AvgRating !== null) {
    const avg = parseFloat(data.AvgRating);
    if (avg <= 5) score = avg;
  }

  // 时长
  let duration = 0;
  if (data.Duration !== undefined && data.Duration !== null) {
    try {
      duration = Math.floor(parseInt(data.Duration) / 60);
    } catch (e) {}
  }

  // 系列
  const series = data.Series || data.SeriesJa || data.SeriesEn || '';

  // 简介
  const overview = data.Desc || '';

  // 截图
  const sampleImages = data.SampleImages || [];

  const detailUrl = SITE_DETAIL_URL[site].replace('{id}', movieId);

  return {
    title,
    originalTitle: title,
    cover,
    releaseDate: data.Release || '',
    producer: '',
    publisher: '',
    director: '',
    serial: series,
    score,
    actress: actressNames,
    genres: tags,
    duration,
    overview,
    sampleImages,
    source: `d2pass-${site}`,
    detailUrl
  };
}

/**
 * 从 Caribbeancom HTML 提取 gallery 图片
 */
async function fetchGalleryFromHtml(req, site, movieId) {
  if (site !== 'caribbeancom') return [];
  
  try {
    const htmlUrl = SITE_DETAIL_URL[site].replace('{id}', movieId);
    const res = await req.get(htmlUrl);
    if (!res.ok) return [];
    const html = await res.text();
    
    const nums = html.match(/images\/l\/(\d{3})\.jpg/g) || [];
    const seen = new Set();
    const images = [];
    const base = `https://www.caribbeancom.com/moviepages/${movieId}/images/l`;
    
    for (const numStr of nums) {
      const num = numStr.match(/(\d{3})/)[1];
      if (!seen.has(num)) {
        seen.add(num);
        images.push(`${base}/${num}.jpg`);
      }
    }
    return images;
  } catch (e) {
    return [];
  }
}

/**
 * Caribbeancom HTML fallback（JSON API 404 时用）
 */
async function parseCaribbeancomHtml(req, movieId) {
  try {
    const htmlUrl = SITE_DETAIL_URL['caribbeancom'].replace('{id}', movieId);
    const res = await req.get(htmlUrl);
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // 标题
    const title = $('h1').first().text().trim();
    if (!title) return null;

    // 时长
    let duration = 0;
    const durMatch = html.match(/再生時間.*?(\d{2}):(\d{2}):(\d{2})/s);
    if (durMatch) {
      duration = parseInt(durMatch[1]) * 60 + parseInt(durMatch[2]);
    }

    // 系列
    let series = '';
    const seriesMatch = html.match(/シリーズ.*?<a[^>]*>([^<]+)<\/a>/s);
    if (seriesMatch) series = seriesMatch[1].trim();

    // 女优
    const actress = [];
    const actressMatch = html.match(/出演(.*?)<\/li>/s);
    if (actressMatch) {
      const names = actressMatch[1].match(/<a[^>]*>([^<]+)<\/a>/g) || [];
      for (const n of names) {
        const name = n.replace(/<[^>]+>/g, '').trim();
        if (name) actress.push(name);
      }
    }

    // 标签
    const genres = [];
    const tagsMatch = html.match(/タグ(.*?)<\/li>/s);
    if (tagsMatch) {
      const tags = tagsMatch[1].match(/<a[^>]*>([^<]+)<\/a>/g) || [];
      for (const t of tags) {
        const tag = t.replace(/<[^>]+>/g, '').trim();
        if (tag && !/^\d+p$/.test(tag)) genres.push(tag);
      }
    }

    // 截图
    const sampleImages = [];
    const galleryNums = html.match(/images\/l\/(\d{3})\.jpg/g) || [];
    const seen = new Set();
    const base = `https://www.caribbeancom.com/moviepages/${movieId}/images/l`;
    for (const numStr of galleryNums) {
      const num = numStr.match(/(\d{3})/)[1];
      if (!seen.has(num)) {
        seen.add(num);
        sampleImages.push(`${base}/${num}.jpg`);
      }
    }

    // 简介
    let overview = '';
    const descMatch = html.match(/<p[^>]*itemprop="description"[^>]*>(.*?)<\/p>/s);
    if (descMatch) {
      overview = descMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // 评分
    let score = 0;
    const ratingMatch = html.match(/meta-rating[^>]*>([^<]*)<\/span>/);
    if (ratingMatch) {
      const stars = (ratingMatch[1].match(/★/g) || []).length;
      if (stars > 0 && stars <= 5) score = stars;
    }

    const cover = `https://www.caribbeancom.com/moviepages/${movieId}/images/l_l.jpg`;
    const detailUrl = SITE_DETAIL_URL['caribbeancom'].replace('{id}', movieId);

    return {
      title,
      originalTitle: title,
      cover,
      releaseDate: '',
      producer: '',
      publisher: '',
      director: '',
      serial: series,
      score,
      actress,
      genres,
      duration,
      overview,
      sampleImages,
      source: 'd2pass-caribbeancom',
      detailUrl
    };
  } catch (e) {
    console.log(`[D2Pass] Caribbeancom HTML fallback 失败:`, e.message);
    return null;
  }
}

/**
 * D2Pass 搜索（1Pondo / Caribbeancom / 10musume 三合一）
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchD2PassByAvid(avid) {
  const movieId = avid.trim();
  const siteOrder = detectSiteOrder(movieId);

  const req = new Request({
    uaType: 'chrome',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ja-JP,ja;q=0.9',
      'Referer': 'https://www.1pondo.tv/',
    }
  });

  for (const site of siteOrder) {
    try {
      const url = SITES[site].replace('{id}', movieId);
      const res = await req.get(url);

      if (res.status === 404) {
        // Caribbeancom JSON API 404，尝试 HTML fallback
        if (site === 'caribbeancom') {
          const video = await parseCaribbeancomHtml(req, movieId);
          if (video) return video;
        }
        continue;
      }

      if (!res.ok) continue;

      const data = await res.json();
      const video = parseJson(data, site, movieId);
      
      if (video) {
        // Caribbeancom 补充 gallery 图片
        if (!video.sampleImages.length && site === 'caribbeancom') {
          const gallery = await fetchGalleryFromHtml(req, site, movieId);
          if (gallery.length) video.sampleImages = gallery;
        }
        return video;
      }

    } catch (e) {
      console.log(`[D2Pass] ${site} 失败 [${avid}]:`, e.message);
      continue;
    }
  }

  return null;
}

module.exports = { searchD2PassByAvid };
