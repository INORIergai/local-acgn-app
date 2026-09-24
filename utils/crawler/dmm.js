const fs = require('fs');
const path = require('path');
const { Request } = require('./base');
const config = require('../config');

const API_URL = "https://api.video.dmm.co.jp/graphql";

// 缓存文件路径
const CACHE_DIR = path.join(__dirname, '../../cache');
const CACHE_FILE = path.join(CACHE_DIR, 'dmm_content_ids.json');
const PREFIX_FILE = path.join(CACHE_DIR, 'dmm_prefix_hints.json');

// GraphQL 查询
const DETAIL_QUERY = `
  query ContentPageData($id: ID!) {
    ppvContent(id: $id) {
      id
      title
      description
      packageImage { largeUrl }
      makerReleasedAt
      duration
      actresses { name }
      directors { name }
      series { name }
      maker { name }
      makerContentId
      genres { name }
      label { name }
      sampleImages { imageUrl }
    }
  }
`;

const SEARCH_QUERY = `
  query AvSearch($limit: Int!, $sort: ContentSearchPPVSort!, $queryWord: String) {
    legacySearchPPV(limit: $limit, sort: $sort, queryWord: $queryWord) {
      result { contents { id } }
    }
  }
`;

const REVIEW_QUERY = `
  query ProbeReview($contentId: ID!) {
    reviewSummary(contentId: $contentId) { average }
  }
`;

function getConfig() {
  return config.sources?.dmm || {};
}

// ========== 缓存管理 ==========

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

function loadCache() {
  return loadJson(CACHE_FILE);
}

function saveCache(number, contentId) {
  const cache = loadCache();
  cache[number.toUpperCase()] = contentId;
  saveJson(CACHE_FILE, cache);
}

function loadPrefixHints() {
  return loadJson(PREFIX_FILE);
}

function savePrefixHint(prefix, dmmPrefix) {
  const hints = loadPrefixHints();
  hints[prefix.toLowerCase()] = dmmPrefix;
  saveJson(PREFIX_FILE, hints);
}

// ========== 番号转换 ==========

function parseNumber(number) {
  number = number.toUpperCase().trim();
  const match = number.match(/^([A-Z]+)-?(\d+)$/);
  if (match) {
    return { prefix: match[1].toLowerCase(), num: match[2] };
  }
  return { prefix: '', num: '' };
}

/**
 * 用前缀映射转换番号
 * STARS-804 + hints={stars: "1"} → 1stars00804
 */
function convertWithHints(number) {
  const { prefix, num } = parseNumber(number);
  if (!prefix || !num) return '';

  const numPadded = num.padStart(5, '0');
  const hints = loadPrefixHints();
  const dmmPrefix = hints[prefix] || '';

  return `${dmmPrefix}${prefix}${numPadded}`;
}

/**
 * 从成功的 content_id 学习前缀映射
 * number=STARS-804, content_id=1stars00804 → 学习到 stars → "1"
 */
function learnPrefix(number, contentId) {
  const { prefix } = parseNumber(number);
  if (!prefix) return;

  const idx = contentId.toLowerCase().indexOf(prefix);
  if (idx > 0) {
    const dmmPrefix = contentId.substring(0, idx);
    savePrefixHint(prefix, dmmPrefix);
  }
}

// ========== GraphQL 请求 ==========

async function graphqlPost(req, query, variables) {
  const payload = { query, variables };
  const res = await req._doFetch(API_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return await res.json();
}

// ========== 搜索 ==========

/**
 * 用搜索 API 查找 content_id
 */
async function searchContentId(req, number) {
  const queryWord = number.toUpperCase().replace('-', '');
  const { prefix } = parseNumber(number);
  if (!prefix) return null;

  try {
    const data = await graphqlPost(req, SEARCH_QUERY, {
      limit: 5,
      sort: 'RELEASE_DATE',
      queryWord,
    });

    if (!data.data || !data.data.legacySearchPPV) return null;

    const contents = data.data.legacySearchPPV.result.contents;
    if (!contents || !contents.length) return null;

    // 找包含番号前缀的结果
    for (const content of contents) {
      const cid = content.id;
      if (cid.toLowerCase().includes(prefix)) {
        return cid;
      }
    }

    // 没找到匹配的，返回第一个
    return contents[0].id;

  } catch (e) {
    console.log(`[DMM] 搜索失败:`, e.message);
    return null;
  }
}

// ========== 获取详情 ==========

async function fetchById(req, contentId) {
  if (!contentId) return null;

  try {
    const data = await graphqlPost(req, DETAIL_QUERY, { id: contentId });

    if (!data.data || !data.data.ppvContent) return null;

    const item = data.data.ppvContent;

    // 女优
    const actress = (item.actresses || []).map(a => a.name).filter(n => n);

    // 发行日期
    let releaseDate = item.makerReleasedAt || '';
    if (releaseDate && releaseDate.includes('T')) {
      releaseDate = releaseDate.split('T')[0];
    }

    // 标签
    const genres = (item.genres || []).map(g => g.name).filter(g => g);

    // 发行商
    const publisher = (item.label || {}).name || '';

    // 导演
    const directors = item.directors || [];
    const director = directors[0]?.name || '';

    // 时长（秒 → 分钟）
    let duration = 0;
    if (item.duration) {
      duration = Math.floor(item.duration / 60);
    }

    // 系列
    const series = (item.series || {}).name || '';

    // 片商
    const producer = (item.maker || {}).name || '';

    // 封面
    const cover = (item.packageImage || {}).largeUrl || '';

    // 截图
    const sampleImages = (item.sampleImages || [])
      .map(s => s.imageUrl)
      .filter(u => u)
      .map(u => u.replace(/(?<!jp)-(\d+)\.jpg$/, 'jp-$1.jpg'));

    // 简介
    const overview = item.description || '';

    // 评分（单独请求）
    let score = 0;
    try {
      const reviewData = await graphqlPost(req, REVIEW_QUERY, { contentId });
      const summary = reviewData.data?.reviewSummary;
      if (summary && summary.average) {
        score = parseFloat(summary.average);
      }
    } catch (e) {
      // 评分获取失败不影响主流程
    }

    const detailUrl = `https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=${contentId}/`;

    return {
      title: item.title || '',
      originalTitle: item.title || '',
      cover,
      releaseDate,
      producer,
      publisher,
      director,
      serial: series,
      score,
      actress,
      genres,
      duration,
      overview,
      sampleImages,
      source: 'dmm',
      detailUrl
    };

  } catch (e) {
    console.log(`[DMM] 获取详情失败 [${contentId}]:`, e.message);
    return null;
  }
}

/**
 * DMM 搜索并获取详情（官方 GraphQL API）
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchDmmByAvid(avid) {
  const number = avid.trim().toUpperCase();

  // 不支持 FC2
  if (number.includes('FC2')) return null;

  const req = new Request({
    uaType: 'chrome',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Language': 'ja-JP,ja;q=0.9',
    }
  });

  try {
    // 1. 查缓存（最快）
    const cache = loadCache();
    if (cache[number]) {
      const result = await fetchById(req, cache[number]);
      if (result) return result;
    }

    // 2. 用前缀映射转换（快）
    const convertedCid = convertWithHints(number);
    if (convertedCid) {
      const result = await fetchById(req, convertedCid);
      if (result) {
        saveCache(number, convertedCid);
        return result;
      }
    }

    // 3. 搜索 API 发现（慢，但会学习）
    const discoveredCid = await searchContentId(req, number);
    if (discoveredCid) {
      const result = await fetchById(req, discoveredCid);
      if (result) {
        saveCache(number, discoveredCid);
        learnPrefix(number, discoveredCid); // 学习新前缀
        return result;
      }
    }

    return null;

  } catch (e) {
    console.log(`[DMM] 爬取失败 [${avid}]:`, e.message);
    return null;
  }
}

module.exports = { searchDmmByAvid };
