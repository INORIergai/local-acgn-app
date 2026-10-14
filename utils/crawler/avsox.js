const { Request } = require('./base');
const config = require('../config');

const BASE_DOMAINS = [
  "https://avsox.click",
  "https://avsox.monster",
  "https://avsox.website",
];

// 缓存工作域名和 CSRF token
let workingDomain = null;
let csrfToken = null;

function getConfig() {
  return config.sources?.avsox || {};
}

/**
 * 确保 session 可用：遍历域名，抓取 CSRF token
 */
async function ensureSession(req) {
  if (workingDomain && csrfToken) {
    return { domain: workingDomain, token: csrfToken };
  }

  const srcConfig = getConfig();
  const domains = srcConfig.mirror ? [srcConfig.mirror] : BASE_DOMAINS;

  for (const domain of domains) {
    try {
      const res = await req.get(`${domain}/cn`);
      if (!res.ok) continue;

      const html = await res.text();
      const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
      if (!match) continue;

      const token = match[1];
      workingDomain = domain;
      csrfToken = token;
      return { domain, token };
    } catch (e) {
      console.log(`[AVSOX] 域名 ${domain} 不可用:`, e.message);
      continue;
    }
  }

  return { domain: null, token: null };
}

/**
 * 调用 AVSOX API
 */
async function apiPost(req, domain, token, path, body) {
  const url = `${domain}${path}`;
  const headers = {
    'x-csrf-token': token,
    'x-requested-with': 'XMLHttpRequest',
    'content-type': 'application/json',
  };

  const res = await req._doFetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });

  if (res.status === 403) {
    throw new Error('CSRF_EXPIRED');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.code !== 200) {
    throw new Error('CSRF_EXPIRED');
  }

  return data;
}

/**
 * 番号比对（忽略大小写、-PPV、连字符/下划线差异）
 */
function numberMatch(a, b) {
  const normalize = (s) => s.toUpperCase().replace('-PPV', '').replace(/-/g, '').replace(/_/g, '');
  return normalize(a) === normalize(b);
}

/**
 * 搜索 movieId
 */
async function searchMovieId(req, domain, token, number) {
  const result = await apiPost(req, domain, token, '/javu/data/api/search', [
    { search: number, lang: 'cn' },
    60,
    1
  ]);

  const data = result.data || [];
  for (const d of data) {
    const fanHao = d.movieFanHao || '';
    if (numberMatch(fanHao, number)) {
      return d.movieId;
    }
  }
  return null;
}

/**
 * 获取影片详情
 */
async function getMovie(req, domain, token, movieId) {
  const result = await apiPost(req, domain, token, '/javu/data/api/getMovie', [movieId, 'cn']);
  return result.data;
}

/**
 * 构建 Video 对象
 */
function buildVideo(number, domain, data) {
  const maker = (data.studio || {}).studioName || '';
  const series = (data.series || {}).seriesName || '';
  
  const actress = (data.star || [])
    .map(s => s.starName)
    .filter(n => n);
  
  const genres = (data.genre || [])
    .map(g => g.genreName)
    .filter(g => g);

  const detailUrl = `${domain}/cn/movies/${data.movieId}`;

  return {
    title: data.title_ja || '',
    originalTitle: data.title_ja || '',
    cover: data.posterLarge || '',
    releaseDate: data.releaseDate || '',
    producer: maker,
    publisher: '',
    director: '',
    serial: series,
    score: 0,
    actress,
    genres,
    duration: data.length || 0,
    overview: '',
    sampleImages: [],
    source: 'avsox',
    detailUrl
  };
}

/**
 * 核心查找流程
 */
async function lookup(req, domain, token, number) {
  const movieId = await searchMovieId(req, domain, token, number);
  if (!movieId) return null;
  
  const data = await getMovie(req, domain, token, movieId);
  return buildVideo(number, domain, data);
}

/**
 * AVSOX 搜索并获取详情
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchAvsoxByAvid(avid) {
  const number = avid.trim();

  const req = new Request({
    uaType: 'chrome',
    headers: {
      'Accept': 'application/json, text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
  });

  try {
    // 第一次尝试
    let { domain, token } = await ensureSession(req);
    if (!domain) {
      console.log('[AVSOX] 所有域名都不可用');
      return null;
    }

    try {
      return await lookup(req, domain, token, number);
    } catch (e) {
      if (e.message === 'CSRF_EXPIRED') {
        // token 失效，清缓存重试一次
        workingDomain = null;
        csrfToken = null;
        
        const retry = await ensureSession(req);
        if (!retry.domain) return null;
        
        return await lookup(req, retry.domain, retry.token, number);
      }
      throw e;
    }

  } catch (e) {
    console.log(`[AVSOX] 爬取失败 [${avid}]:`, e.message);
    return null;
  }
}

module.exports = { searchAvsoxByAvid };
