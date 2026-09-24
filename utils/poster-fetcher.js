const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');

const { searchJavDBByAvid } = require('./crawler/javdb');
const { searchJavBusByAvid } = require('./crawler/javbus');
const { searchJav321ByAvid } = require('./crawler/jav321');
const { searchDmmByAvid } = require('./crawler/dmm');
const { searchD2PassByAvid } = require('./crawler/d2pass');
const { searchHeyzoByAvid } = require('./crawler/heyzo');
const { searchFc2ByAvid } = require('./crawler/fc2');
const { searchAvsoxByAvid } = require('./crawler/avsox');
const { searchNetflavByAvid } = require('./crawler/netflav');
const { searchOnejavByAvid } = require('./crawler/onejav');
const { searchJavclByAvid } = require('./crawler/javcl');
const { searchJableByAvid } = require('./crawler/jable');
const { searchJavmenuByAvid } = require('./crawler/javmenu');
const { searchDongmanByName, searchDongmanAll } = require('./crawler/dongman');
// ========== 动漫库主力封面源：AniList（JSON 接口，不需要浏览器，isAdult 可拿里番） ==========
const { searchAniListByName, searchAniListAll } = require('./crawler/anilist');
// ========== FANZA 官方 API（里番动画的官方封面源，需在 config 填 api_id/affiliate_id） ==========
const { searchFanzaByName, searchFanzaAll, available: fanzaAvailable } = require('./crawler/fanza');
// ========== 新增hanime爬虫引入，请确认你存在 ./crawler/hanime-pw 模块 ==========
const { searchHanimeByName } = require('./crawler/hanime-pw');
// ========== 漫画/小说爬虫（按库硬分流） ==========
const KmoeCrawler = require('./crawler/kmoe');
const ZLibraryCrawler = require('./crawler/zlibrary');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';
const TMDB_TIMEOUT = 4000;

// 海报缓存目录
const POSTER_CACHE_DIR = path.join(__dirname, '../cache/posters');

// 确保缓存目录存在
if (!fs.existsSync(POSTER_CACHE_DIR)) {
  fs.mkdirSync(POSTER_CACHE_DIR, { recursive: true });
}

/**
 * 根据海报URL生成缓存文件名（去重用）
 * 相同URL的海报只下载一次
 */
function getPosterCacheName(posterUrl) {
  if (!posterUrl) return null;
  const hash = crypto.createHash('md5').update(posterUrl).digest('hex');
  // 尝试从URL获取扩展名
  let ext = '.jpg';
  const urlLower = posterUrl.toLowerCase();
  if (urlLower.includes('.png')) ext = '.png';
  else if (urlLower.includes('.webp')) ext = '.webp';
  else if (urlLower.includes('.jpeg')) ext = '.jpeg';
  return hash + ext;
}

/**
 * 检查海报是否已缓存
 */
function isPosterCached(posterUrl) {
  const cacheName = getPosterCacheName(posterUrl);
  if (!cacheName) return false;
  const cachePath = path.join(POSTER_CACHE_DIR, cacheName);
  return fs.existsSync(cachePath);
}

/**
 * 基础文件名清洗 —— JAV/普通电影
 */
function cleanMovieName(filename) {
  let name = filename.replace(/\.[^.]+$/, '');
  name = name.replace(/\[.*?\]/g, '');
  name = name.replace(/【.*?】/g, '');
  name = name.replace(/\(.*?\)/g, '');
  name = name.replace(/\d{4}/g, '');
  name = name.replace(/(1080p|2160p|720p|x264|x265|hevc|hdr|bluray|webrip)/gi, '');
  name = name.replace(/[-_.]/g, ' ');
  name = name.trim().replace(/\s+/g, ' ');
  return name;
}

/**
 * hanime动漫专用文件名清洗
 * 移除字幕组标记、分辨率、FPS、末尾序号、特殊符号、全角标点、特殊圆圈〇
 */
function cleanHanimeName(filename) {
  let name = filename.replace(/\.[^.]+$/, '');
  // 移除方括号、【】、()内容
  name = name.replace(/\[[^\]]*\]/g, '');
  name = name.replace(/【[^】]*】/g, '');
  name = name.replace(/\(\d+\)$/g, '');
  // 画质帧率标记
  name = name.replace(/4K|1080P|720P|120FPS|60FPS|HEVC|x264|x265|神画質/gi, '');
  // 重点：清除干扰搜索的特殊符号：全角！？、特殊圆圈〇、各种符号
  name = name.replace(/[！？〇★☆◆■●]/g, ' ');
  // 剔除纯数字片段（100連発 → 保留連発，数字删掉）
  name = name.replace(/\d+/g, ' ');
  name = name.trim().replace(/\s+/g, ' ');
  return name;
}

/**
 * 动漫库「搜索关键词」构造（比 cleanHanimeName 更稳）
 *
 * cleanHanimeName 会把方括号里的内容**整段删掉**，遇到
 *   `[HSsub][Bloods～淫落の血族2～][02][704x396][H264_AAC].mkv`
 * 这种「标题本身就在方括号里」的文件名，会直接清洗成空串，于是永远搜不到。
 * 这里做三级兜底：
 *   1. 先用 cleanHanimeName；
 *   2. 结果太短 → 取所有方括号里「汉字/假名最多」的那一段当关键词；
 *   3. 还不行 → 只删掉「像字幕组/编码/分辨率」的方括号，其余保留。
 */
function animeSearchKey(fileName, filePath) {
  const raw = String(fileName || '').replace(/\.[^.]+$/, '');

  // 归一化后若「有效字符」不足 2 个，直接判定为无法搜索
  // （如 `9.mp4`、`02.mp4`，拿个位数去搜 AniList 会随机命中一堆不相干的条目，
  //   实测 `9.mp4` 被配上了《21時の女》——绝不能容忍的错配）
  const valid = (s) => s.replace(/[^\u3040-\u30ff\u4e00-\u9fffA-Za-z]/g, '').length >= 2;

  const k = cleanHanimeName(fileName);
  if (valid(k)) return k;

  // 2) 方括号里最长的一段（含 ≥2 个汉字/假名才算）
  const segs = [...raw.matchAll(/[\[【]([^\]】]+)[\]】]/g)]
    .map(m => m[1].trim())
    .filter(t => (t.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length >= 2);
  if (segs.length) {
    const s = segs.sort((a, b) => b.length - a.length)[0].replace(/\s+/g, ' ').trim();
    if (valid(s)) return s;
  }

  // 3) 只删「字幕组 / 编码 / 分辨率」这类方括号
  const s = raw.replace(/[\[【]([^\]】]*)[\]】]/g, (m, inner) => {
    const t = String(inner).trim();
    const isGroup = /sub|字幕|汉化|漢化|翻譯|翻译|组|組|raw|压制|壓制|发布|發布|mkv|mp4/i.test(t);
    const isCodec = /^\d{3,4}[xX]\d{3,4}$/.test(t) || /^(x264|x265|h264|h265|hevc|avc|aac|10bit|8bit)$/i.test(t);
    return (isGroup || isCodec) ? ' ' : ' ' + t + ' ';
  })
    .replace(/\([^)]*\)/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/[！？〇★☆◆■●〜～~]/g, ' ')
    .replace(/\b(\d{3,4}[xX]\d{3,4}|x264|x265|h264|h265|hevc|avc|aac|4K|1080P|720P|120FPS|60FPS|PSP)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (valid(s)) return s;

  // 4) 文件名本身没信息（`7.mp4` / `1.mp4` / `8320124-720p.mp4`）
  //    → 用**父文件夹名**当作品名。本库很常见：/media/anime/エロ店長/7.mp4
  if (filePath) {
    const parts = String(filePath).replace(/\\/g, '/').split('/').filter(Boolean);
    const folder = (parts.length >= 2 ? parts[parts.length - 2] : '') || '';
    const c = folder.replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (valid(c) && !/排雷|垃圾|废弃|廢棄|测试|測試|temp|新建|未分类|未分類|其他|合集/i.test(c)) return c;
  }

  return '';
}
/**
 * 根据文件路径判断资源类型（通过扫描文件夹配置）
 * 优先级：animeFolders > comicFolders > novelFolders > scanFolders(jav)
 * @param {string} filePath 文件完整路径
 * @returns {string} 'jav' | 'anime' | 'comic' | 'novel'
 */
function detectTypeByPath(filePath) {
  if (!filePath) return 'jav';
  
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  
  // 动漫文件夹
  const animeFolders = (config.animeFolders || []).map(f => f.replace(/\\/g, '/').toLowerCase());
  for (const folder of animeFolders) {
    if (normalizedPath.startsWith(folder)) {
      return 'anime';
    }
  }
  
  // 漫画文件夹
  const comicFolders = (config.comicFolders || []).map(f => f.replace(/\\/g, '/').toLowerCase());
  for (const folder of comicFolders) {
    if (normalizedPath.startsWith(folder)) {
      return 'comic';
    }
  }
  
  // 小说文件夹
  const novelFolders = (config.novelFolders || []).map(f => f.replace(/\\/g, '/').toLowerCase());
  for (const folder of novelFolders) {
    if (normalizedPath.startsWith(folder)) {
      return 'novel';
    }
  }
  
  // 影片文件夹（默认）
  return 'jav';
}

/**
 * 判断文件是否为hanime动漫
 * 规则：没有高置信JAV番号，文件名包含日文假名/日文汉字 或者 中文标题（无番号）
 * 排除：漫画文件（包含[Kmoe]、全一冊、epub/cbz等漫画标记）
 */
function isHanimeAnime(filename) {
  const avidRet = extractAvId(filename);
  // 存在高置信度JAV番号 → 不是hanime动漫
  if (avidRet && avidRet.confidence === 'high') return false;

  // 排除漫画文件特有的标记
  const comicMarkers = /\[kmoe\]|全一冊|全一册|漫画|comic|\.epub$|\.cbz$|\.cbr$|\.zip$/i;
  if (comicMarkers.test(filename)) return false;

  // ===== 重点！！全部使用普通ASCII减号 `-`，不要复制带特殊符号的旧代码 =====
  // 日文假名(平假名 \u3040-\u309F  + 片假名 \u30A0-\u30FF )
  const kanaRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
  // CJK中日汉字
  const kanjiRegex = /[\u4E00-\u9FFF]/;

  const hasKana = kanaRegex.test(filename);
  const hasCnJpChar = kanjiRegex.test(filename);

  // 清洗文件名，去掉后缀、括号、数字符号，得到纯文本
  const pureText = filename.replace(/\.[^.]+$/, '').replace(/\[|\]|【|】|\(|\)|\_|\-|\d+/g, '').trim();
  const longText = pureText.length >= 4;

  return hasKana || (hasCnJpChar && longText);
}

/**
 * 提取番号（支持带横杠/无分隔符连写格式，兼容中文后缀）
 * 优化：增加常见前缀验证，减少误匹配
 */
function extractAvId(filename) {
  let name = filename.replace(/\.[^.]+$/, '');
  // 过滤垃圾字段
  const filterRegs = [
    /(144|240|360|480|720|1080|2160)[Pp]/g,
    /[248][Kk]/g,
    /\w+2048\.com/g,
    /Carib(beancom)?/g,
    /[^a-z\d](f?hd|lt|uncensored|leak|cracked)[^a-z\d]/gi,
    /(x264|x265|hevc|h264|h265|aac|ac3|dts)/gi,
    /(bluray|webrip|web‑dl|hdrip|dvdrip)/gi,
    /(repack|proper|internal|limited)/gi
  ];
  filterRegs.forEach(reg => name = name.replace(reg, ''));

  // 常见番号前缀白名单（用于验证）
  const validPrefixes = [
    'ABP', 'ADN', 'AGEMIX', 'AUKG', 'AVOP', 'AWT',
    'BBI', 'BF', 'BGN', 'BIJN', 'BLK', 'BMD', 'BOKD',
    'CESD', 'CHERD', 'CLO', 'CMI', 'CRWD',
    'DANDY', 'DASD', 'DDK', 'DEEP', 'DIGI', 'DLDSS', 'DMM', 'DOCP', 'DPMI', 'DPSH', 'DSS',
    'DVAJ',
    'EBOD', 'ECB', 'EDGD', 'EKDV', 'EMRD', 'ENCODE', 'EYAN',
    'FCDC', 'FSDSS', 'FSD', 'FTKD',
    'GAS', 'GDTM', 'GENM', 'GNAX', 'GNE', 'GS', 'GVH',
    'HAG', 'HANB', 'HAR', 'HAVD', 'HEYZO', 'HMN', 'HODV', 'HUNT',
    'IENF', 'IESP', 'IKU', 'IMB', 'IPX', 'IPZ', 'IQQQ', 'ISRD',
    'JAV', 'JFB', 'JUL',
    'KAGP', 'KAI', 'KBI', 'KDMI', 'KIR', 'KMHRS', 'KTRA',
    'LULU', 'LXVS',
    'MADM', 'MANE', 'MCSR', 'MEYD', 'MFC', 'MFOD', 'MIAE', 'MIDE', 'MIDV', 'MIGD', 'MIAA', 'MIAB', 'MISM', 'MIST', 'MIUM', 'MIZD', 'MKMP', 'MMKZ', 'MNYG', 'MOGI', 'MOND', 'Mosaic', 'MRHP', 'MRE', 'MRSS', 'MST', 'MTALL', 'MUKC', 'MURE', 'MVSD', 'MXGS',
    'NACR', 'NAGL', 'NASH', 'NBB', 'NEXUS', 'NGOD', 'NHDTB', 'NHMS', 'NIMA', 'NKKD', 'NOA', 'NPS', 'NTRD', 'NUD',
    'OAE', 'OBA', 'OBOK', 'OIGS', 'ONEZ', 'OREB', 'OREC', 'OREX', 'ORWK',
    'Paco', 'PAIO', 'PARM', 'PBD', 'PCHN', 'PD', 'PEP', 'PGD', 'PHE', 'PHK', 'PIYO', 'PKPD', 'PLA', 'PMV', 'PNME', 'PONDO', 'PPPE', 'PPPD', 'PRBY', 'PRED', 'PRIN', 'PZE',
    'RAW', 'REAL', 'REBD', 'REXD', 'RKI', 'RM', 'RUSHE',
    'S2M', 'SACE', 'SAIT', 'SAMA', 'SAVR', 'SBW', 'SDAB', 'SDDE', 'SDMF', 'SDMM', 'SDMUA', 'SDN', 'SGA', 'SHK', 'SHMO', 'SIVR', 'SKJK', 'SKMJ', 'SLN', 'SM', 'SMAC', 'SMA', 'SMD', 'SMDV', 'SMM', 'SMP', 'SNN', 'SNTM', 'SOAN', 'SONE', 'SPRO', 'SQTE', 'SRMC', 'SSNI', 'SSIS', 'STAR', 'STARS', 'STCV', 'STKO', 'SUJI', 'SUPR', 'SW', 'SYBI', 'SYKH', 'SYKJ', 'SYK',
    'T28', 'TAM', 'TBD', 'TDMN', 'TDP', 'TEK', 'TEN', 'TIC', 'TKB', 'TMRD', 'TNN', 'TOEN', 'TOMN', 'TPP', 'TRUM', 'TSN', 'TSU', 'TTTV', 'TYOD',
    'T',
    'UMD', 'USBA', 'USSE',
    'VAGU', 'VEMA', 'VENUS', 'VDD', 'VFC', 'VIT', 'VRTM',
    'WANZ', 'WKD', 'WPE',
    'YST',
    'ZEX'
  ].map(p => p.toUpperCase());

  // 优化正则：1‑8位字母 + 可选1‑2位数字段（兼容 T28-650）+ 可选空格/横杠 + 3‑6位数字（兼容 T-38030、DVAJ 725）
  // 例如：SSIS-123 / T-38030 / T28-650 / DVAJ 725
  const match = name.match(/([A-Za-z]{1,8})\s*(\d{1,2})?\s*-?\s*(\d{3,6})/);
  if (match) {
    const prefixPart = match[1].toUpperCase();
    const num1 = match[2] || '';
    const num2 = match[3];
    // 前缀 = 字母段 + 短数字段（T28-650 → 前缀 T28；T-38030 → 前缀 T；DVAJ 725 → 前缀 DVAJ）
    const realPrefix = prefixPart + num1;

    // 验证前缀是否在白名单中（单字母前缀如 T 仅限白名单内，避免误匹配）
    const isValidPrefix = realPrefix.length === 1
      ? validPrefixes.includes(realPrefix)
      : validPrefixes.some(p => p === realPrefix || p.startsWith(realPrefix) || realPrefix.startsWith(p));

    // 统一使用普通 ASCII 连字符（与数据库存量数据及前端搜索输入保持一致）
    return {
      avid: `${realPrefix}-${num2}`,
      prefix: realPrefix,
      num: num2,
      confidence: isValidPrefix ? 'high' : 'low'
    };
  }
  return null;
}

/**
 * TMDB搜索
 */
async function searchFromTMDB(name) {
  try {
    const url = new URL(`${TMDB_BASE}/search/movie`);
    url.searchParams.set('api_key', config.tmdbApiKey);
    url.searchParams.set('query', name);
    url.searchParams.set('language', 'zh‑CN');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TMDB_TIMEOUT);
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    clearTimeout(timer);

    const data = await res.json();
    return data.results?.[0] || null;
  } catch (e) {
    console.log('[TMDB搜索异常]', e.message);
    return null;
  }
}

/**
 * kmoe 漫画搜索封装（按库硬分流使用）
 * 返回与 searchMovie 一致的结构
 */
async function searchFromKmoe(fileName) {
    if (!config.sources?.kmoe?.enabled) {
        console.log('[kmoe] 数据源未开启，跳过漫画刮削');
        return null;
    }
    // 清洗文件名：去扩展名、去 [字幕组] 前缀、去标签
    let keyword = fileName.replace(/\.[^.]+$/, '')
        .replace(/\[.*?\]/g, ' ')
        .replace(/\(.*?\)/g, ' ')
        .replace(/【.*?】/g, ' ')
        .replace(/(epub|mobi|pdf|txt|zip|rar|cbz|cbr|azw3|全一冊|全一册|第.*?卷|汉化组|自购)/gi, ' ')
        .replace(/[！？♥〜～\uFF01\uFF1F]/g, ' ')
        .replace(/[-_.]/g, ' ')
        .trim().replace(/\s+/g, ' ');
    if (keyword.length < 2) return null;

    console.log(`[kmoe搜索] 文件名: ${fileName}`);
    console.log(`[kmoe搜索] 清洗后关键词: ${keyword}`);

    try {
        const crawler = new KmoeCrawler(config.sources?.kmoe || {});
        const list = await crawler.search(keyword);
        if (!Array.isArray(list) || list.length === 0) {
            console.log('[kmoe] 未检索到结果');
            return null;
        }

        const first = list[0];
        const detail = await crawler.getDetail(first.url);
        const title = detail?.title || first.title;
        const cover = detail?.cover || first.cover || '';

        return {
            title: title || keyword,
            originalTitle: title || '',
            overview: detail?.intro || '',
            releaseDate: '',
            cover,
            genres: detail?.category ? [detail.category] : [],
            author: detail?.author || first.author || '',
            source: 'kmoe'
        };
    } catch (e) {
        console.log(`[kmoe搜索] 异常: ${e.message}`);
        return null;
    }
}

/**
 * zlibrary 小说搜索封装（按库硬分流使用）
 */
async function searchFromZlibrary(fileName) {
    if (!config.sources?.zlibrary?.enabled) {
        console.log('[zlibrary] 数据源未开启，跳过小说刮削');
        return null;
    }
    try {
        const crawler = new ZLibraryCrawler(config.sources?.zlibrary || {});
        const detail = await crawler.searchByFileName(fileName);
        if (!detail) {
            console.log('[zlibrary] 未检索到结果');
            return null;
        }
        return {
            title: detail.title || '',
            originalTitle: '',
            overview: detail.description || '',
            releaseDate: '',
            cover: detail.cover || '',
            genres: [],
            author: detail.author || '',
            source: 'zlibrary'
        };
    } catch (e) {
        console.log(`[zlibrary搜索] 异常: ${e.message}`);
        return null;
    }
}

/**
 * 统一搜索入口：按库类型硬分流
 * @param {string} cleanName 清洗后的名称
 * @param {string} fileName 原始文件名
 * @param {string} [type] 库类型：jav / anime / comic / novel。不传时保留旧逻辑（按文件名猜测）
 * @param {string} [filePath] 原始路径（动漫库用于「文件名无信息时取父文件夹名当标题」）
 */
async function searchMovie(cleanName, fileName, type, filePath) {
  // ========== 按库硬分流 ==========
  if (type === 'anime') {
    const animeKey = animeSearchKey(fileName, filePath);
    console.log(`[动漫搜索]清洗后关键词:${animeKey || '(空，放弃)'}`);
    if (!animeKey) return null;

    const { simScore, norm } = require('./crawler/title-match');
    const qn = norm(animeKey);
    /**
     * 相关性闸门：各源的「自己挑的那个结果」并不可信
     * （实测 hanime 搜「高潮股長」会返回 `[neNeG] HJM`，完全无关）。
     * 宁可不出封面（前端会提示手动上传 / 用视频截帧），也绝不写一张错图。
     */
    const gate = (r, srcName) => {
      if (!r || !r.cover) return null;
      const s = simScore(r.title || '', qn);
      if (s < 0.5) {
        console.log(`[相关性] 拒绝 ${srcName} 的「${r.title}」（相关度 ${s.toFixed(2)}，与文件名不符）`);
        return null;
      }
      return r;
    };

    // ===== 第一源：AniList（JSON 接口，无需浏览器，不受 CF 影响，isAdult 能拿里番）=====
    // 旧顺序是 hanime→91动漫，两个源一个被 Cloudflare 403 拦死、一个抓错了页面，
    // 结果就是「动漫库一个封面都刮不到」。AniList 实测命中率最高，放最前面。
    if (config.sources?.anilist?.enabled !== false) {
      const alResult = gate(await searchAniListByName(animeKey), 'AniList');
      if (alResult) {
        console.log('[AniList]命中:', alResult.title);
        return normalizeResult(alResult, 'anilist', null);
      }
      console.log('[AniList]未检索到结果，换 91动漫');
    }

    // ===== 第二源：FANZA 官方 API（里番动画的官方封面源）=====
    // 实测：DMM 的 GraphQL（dmm.js）只索引真人 AV 目录，里番厂商名全部 0 条；
    // 网页又对非日本 IP 区域封锁。唯一官方能拿里番封面的入口就是这个アフィリエイト API。
    // 没配 api_id/affiliate_id 时 available() 返回 false，静默跳过。
    if (fanzaAvailable()) {
      const fzResult = gate(await searchFanzaByName(animeKey, { floor: 'anime' }), 'FANZA');
      if (fzResult) {
        console.log('[FANZA]命中:', fzResult.title);
        return normalizeResult(fzResult, 'fanza', null);
      }
      console.log('[FANZA]未检索到结果，换 91动漫');
    }

    // ===== 第三源：91动漫（里番，走 /api/search?q= JSON 接口）=====
    if (config.sources?.dongman?.enabled) {
      const dmResult = gate(await searchDongmanByName(animeKey), '91动漫');
      if (dmResult) {
        console.log('[91动漫]命中:', dmResult.title);
        return normalizeResult(dmResult, 'hanime', null);
      }
      console.log('[91动漫]未检索到结果，换 hanime');
    }

    // ===== 第四源：hanime1.me（中文索引站；容器 IP 被 Cloudflare 拦，只能靠宿主机中转）=====
    if (config.sources?.hanime?.enabled) {
      const hanimeResult = gate(await searchHanimeByName(animeKey), 'hanime');
      if (hanimeResult) {
        return normalizeResult(hanimeResult, 'hanime', null);
      }
      console.log('[hanime爬虫]未检索到结果');
    }
    return null;
  }

  if (type === 'comic') {
    const comicResult = await searchFromKmoe(fileName);
    if (comicResult) {
      return normalizeResult(comicResult, 'kmoe', null);
    }
    return null;
  }

  if (type === 'novel') {
    const novelResult = await searchFromZlibrary(fileName);
    if (novelResult) {
      return normalizeResult(novelResult, 'zlibrary', null);
    }
    return null;
  }

  // ========== 兼容旧调用（type 未传）：保留 hanime 文件名猜测 ==========
  if (!type && isHanimeAnime(fileName)) {
    if (!config.sources?.hanime?.enabled) {
      console.log('[hanime] 数据源未开启，跳过刮削');
      return null;
    }
    const hanimeSearchKey = cleanHanimeName(fileName);
    console.log(`[hanime搜索]原始文件名:${fileName}`);
    console.log(`[hanime搜索]清洗后关键词:${hanimeSearchKey}`);
    const hanimeResult = await searchHanimeByName(hanimeSearchKey);
    if (hanimeResult) {
      return normalizeResult(hanimeResult, 'hanime', null);
    } else {
      console.log('[hanime爬虫]未检索到结果');
      return null;
    }
  }

  const priority = config.scraper?.sourcePriority || ['jav321', 'javbus', 'javdb', 'tmdb'];
  const avidResult = extractAvId(fileName);
  const avid = avidResult?.avid || null;
  const avidConfidence = avidResult?.confidence || 'low';

  // 低置信度番号不进行网络刮削，避免错误匹配
  if (avid && avidConfidence === 'low') {
    console.log(`[刮削] 番号 ${avid} 置信度低，跳过网络刮削`);
    return null;
  }

  for (const source of priority) {
    try {
      // 检查源是否启用
      const srcConfig = config.sources?.[source];
      if (srcConfig && srcConfig.enabled === false) continue;

      let result = null;

      switch (source) {
        case 'jav321':
          if (avid) result = await searchJav321ByAvid(avid);
          break;
        case 'javbus':
          if (avid) result = await searchJavBusByAvid(avid);
          break;
        case 'javdb':
          if (avid) result = await searchJavDBByAvid(avid);
          break;
        case 'dmm':
          if (avid) result = await searchDmmByAvid(avid);
          break;
        case 'd2pass':
          if (avid) result = await searchD2PassByAvid(avid);
          break;
        case 'heyzo':
          if (avid) result = await searchHeyzoByAvid(avid);
          break;
        case 'fc2':
          if (avid) result = await searchFc2ByAvid(avid);
          break;
        case 'avsox':
          if (avid) result = await searchAvsoxByAvid(avid);
          break;
        case 'netflav':
          if (avid) result = await searchNetflavByAvid(avid);
          break;
        case 'onejav':
          if (avid) result = await searchOnejavByAvid(avid);
          break;
        case 'javcl':
          if (avid) result = await searchJavclByAvid(avid);
          break;
        case 'jable':
          if (avid) result = await searchJableByAvid(avid);
          break;
        case 'javmenu':
          if (avid) result = await searchJavmenuByAvid(avid);
          break;
        case 'tmdb':
          result = await searchFromTMDB(cleanName);
          break;
        default:
          continue;
      }

      if (result) {
        // 验证搜索结果的番号是否匹配
        if (avid && result.num) {
          const resultAvid = result.num.toUpperCase().replace(/[^A‑Z0‑9]/g, '');
          const searchAvid = avid.toUpperCase().replace(/[^A‑Z0‑9]/g, '');
          if (resultAvid !== searchAvid) {
            console.log(`[刮削] ${source} 结果番号不匹配: 搜索 ${avid} vs 结果 ${result.num}，跳过`);
            continue;
          }
        }

        // 【2026-09-22】字段补全：第一个命中的源往往字段不全
        // （实测 jav321 有封面但常常缺导演/发行商/系列）。
        // 在拿到封面之后，再问一圈其它源，只把「空着的」字段补上，
        // 封面/标题一律保留首个命中源的，避免横生枝节。
        if (avid) {
          await enrichMissingFields(result, avid, source);
        }

        // 统一格式转换
        return normalizeResult(result, source, avid);
      }

      // 请求间隔
      await new Promise(r => setTimeout(r, config.network?.requestInterval || 1000));

    } catch (e) {
      console.log(`[刮削] ${source} 失败:`, e.message);
      continue;
    }
  }

  return null;
}

/**
 * 统一各数据源返回格式
 */
function normalizeResult(result, source, avid) {
  // hanime 格式分支
  if (source === 'hanime') {
    return {
      title: result.title || '',
      original_title: result.originalTitle || result.title || '',
      overview: result.overview || '',
      release_date: result.releaseDate || '',
      poster_path: result.cover || '',
      origin_country: ['JP'],
      genres: result.genres?.map(g => ({ name: g })) || [],
      _extra: {
        avid: null,
        source: 'hanime',
        actress: result.actress || [],
        genres: result.genres || [],
        duration: result.duration || 0,
        director: result.director || '',
        producer: '',
        publisher: '',
        serial: '',
        score: result.score || 0,
        sampleImages: result.sampleImages || [],
        detailUrl: result.detailUrl || ''
      }
    }
  }

  // TMDB 格式
  if (source === 'tmdb') {
    return {
      title: result.title || '',
      original_title: result.original_title || '',
      overview: result.overview || '',
      release_date: result.release_date || '',
      poster_path: result.poster_path || '',
      origin_country: result.origin_country || [],
      genres: result.genre_ids?.map(id => ({ name: String(id) })) || [],
      _extra: {
        avid,
        source: 'tmdb',
        actress: [],
        genres: [],
        duration: 0,
        director: '',
        producer: '',
        publisher: '',
        serial: '',
        score: 0
      }
    };
  }

  // JAV 站点统一格式
  return {
    title: result.title || '',
    original_title: result.originalTitle || result.title || '',
    overview: result.overview || '',
    release_date: result.releaseDate || '',
    poster_path: result.cover || '',
    origin_country: ['JP'],
    genres: result.genres?.map(g => ({ name: g })) || [],
    _extra: {
      avid,
      source: result.source || source,
      actress: result.actress || [],
      // 演员头像（javbus 影片页自带，零额外请求）
      actressAvatars: result.actressAvatars || [],
      genres: result.genres || [],
      duration: result.duration || 0,
      director: result.director || '',
      producer: result.producer || result.author || '',
      publisher: result.publisher || '',
      serial: result.serial || '',
      score: result.score || 0,
      sampleImages: result.sampleImages || [],
      detailUrl: result.detailUrl || ''
    }
  };
}

/**
 * 字段补全：首个命中源经常字段不全，再问几个源把空字段补齐
 * ------------------------------------------------------------------
 * 原则：
 *  - 只补空，不覆盖已有值（首个源的主字段优先）
 *  - 绝不动 cover / title（封面和标题必须来自同一个源，否则图文错配）
 *  - 只对「有番号的 JAV」生效，且最多再问 3 个源，控制耗时
 *  - 任一源失败都不影响主流程
 * @param {Object} result 首个源的结果（会被就地补全）
 * @param {string} avid
 * @param {string} fromSource 已经用过的源，跳过不再问
 */
const ENRICH_SOURCES = ['javbus', 'javdb', 'jav321', 'dmm'];
const ENRICH_FIELDS = ['director', 'producer', 'publisher', 'serial', 'releaseDate'];

async function enrichMissingFields(result, avid, fromSource) {
  try {
    // 哪些字段是空的？
    const need = ENRICH_FIELDS.filter(f => !result[f]);
    // 类型/标签也算空缺项（genres 为空数组同样需要补）
    const needGenres = !result.genres || result.genres.length === 0;
    if (need.length === 0 && !needGenres) return;

    const candidates = ENRICH_SOURCES.filter(s => s !== fromSource && config.sources?.[s]?.enabled !== false);
    let asked = 0;

    for (const src of candidates) {
      if (asked >= 3) break;
      // 问之前再看一眼还缺不缺，缺的都补上就可以收工
      const stillNeed = ENRICH_FIELDS.filter(f => !result[f]);
      if (stillNeed.length === 0 && (!needGenres || result.genres?.length)) break;
      asked++;

      try {
        let extra = null;
        if (src === 'javbus') extra = await searchJavBusByAvid(avid);
        else if (src === 'javdb') extra = await searchJavDBByAvid(avid);
        else if (src === 'jav321') extra = await searchJav321ByAvid(avid);
        else if (src === 'dmm') extra = await searchDmmByAvid(avid);
        if (!extra) continue;

        // 番号一致才敢用（javdb/javbus 返回对象里没有统一 num，此处以能搜到同番号为准）
        let filled = [];
        for (const f of stillNeed) {
          if (extra[f]) { result[f] = extra[f]; filled.push(f); }
        }
        if ((!result.genres || !result.genres.length) && extra.genres?.length) {
          result.genres = extra.genres;
          filled.push('genres');
        }
        // 演员：主源没给全时也补（只加不覆盖）
        if ((!result.actress || !result.actress.length) && extra.actress?.length) {
          result.actress = extra.actress;
          filled.push('actress');
        }
        // 演员头像：谁有就用谁的（javbus 才有）
        if ((!result.actressAvatars || !result.actressAvatars.length) && extra.actressAvatars?.length) {
          result.actressAvatars = extra.actressAvatars;
          filled.push('actressAvatars');
        }
        // 样本图
        if ((!result.sampleImages || !result.sampleImages.length) && extra.sampleImages?.length) {
          result.sampleImages = extra.sampleImages;
        }
        if (filled.length) {
          console.log(`[字段补全] ${avid} ← ${src}: ${filled.join(', ')}`);
        }
      } catch (e) {
        // 补全失败无所谓
      }
      await new Promise(r => setTimeout(r, config.network?.requestInterval || 800));
    }
  } catch (e) {
    // 补全过程整体异常也不影响主流程
  }
}

/**
 * 下载海报到本地缓存（支持去重：相同URL只下载一次）
 * 返回缓存的文件名
 */
async function downloadPoster(posterUrl, savePath) {
  if (!posterUrl) throw new Error('海报地址为空');

  // 先检查是否已经缓存了（去重）
  const cacheName = getPosterCacheName(posterUrl);
  if (cacheName) {
    const cachePath = path.join(POSTER_CACHE_DIR, cacheName);
    if (fs.existsSync(cachePath)) {
      // 已经缓存了，直接复制到目标路径
      try {
        fs.copyFileSync(cachePath, savePath);
        return cacheName;
      } catch (e) {
        // 复制失败，继续下载
      }
    }
  }

  const { downloadImage } = require('./crawler/base');
  const fullUrl = posterUrl.startsWith('http') ? posterUrl : POSTER_BASE + posterUrl;

  // 根据域名选择 referer
  // ⚠️ javbus 对 Referer 极其挑剔：必须是带**结尾斜杠**的站点根（`https://www.javbus.com/`），
  //    少了那个斜杠一律 403（实测：`.../com` → 403，`.../com/` → 200）。
  let referer = '';
  const withSlash = (u) => (u || '').replace(/\/+$/, '') + '/';
  if (posterUrl.includes('javbus')) referer = withSlash(config.sources?.javbus?.baseUrl || 'https://www.javbus.com');
  if (posterUrl.includes('javdb')) referer = config.sources?.javdb?.baseUrl || 'shturl.cc/vIPYOk0';
  if (posterUrl.includes('jav321')) referer = config.sources?.jav321?.baseUrl || 'https://www.jav321.com';
  if (posterUrl.includes('dmm.co.jp')) referer = 'https://www.dmm.co.jp/';
  if (posterUrl.includes('1pondo')) referer = 'https://www.1pondo.tv/';
  if (posterUrl.includes('caribbeancom')) referer = 'shturl.cc/XblISxDiU1CoUAzZIjX';
  if (posterUrl.includes('10musume')) referer = 'shturl.cc/r1IbqDc5A9gLQ7Z';
  if (posterUrl.includes('heyzo')) referer = 'https://www.heyzo.com/';
  if (posterUrl.includes('javten')) referer = config.sources?.fc2?.mirror || 'shturl.cc/ZZjh4V78';
  if (posterUrl.includes('avsox')) referer = config.sources?.avsox?.mirror || 'https://avsox.click';
  if (posterUrl.includes('hanime')) referer = config.sources?.hanime?.baseUrl || 'shturl.cc/ERyRKemx';
  if (posterUrl.includes('anilist')) referer = 'https://anilist.co/';
  if (posterUrl.includes('tuafjz.cn') || posterUrl.includes('iffuglfyc')) referer = withSlash(config.sources?.dongman?.baseUrl || 'https://91dongman.net');
  if (posterUrl.includes('moex.ink') || posterUrl.includes('kmimg')) referer = config.sources?.kmoe?.baseUrl || 'https://kzo.moe';

  // 兜底：如果上面的规则没命中，但图片来源是 javbus 的图片路径（/pics/...），也补上带斜杠的 referer
  if (!referer && /\/pics\//.test(posterUrl)) referer = withSlash(config.sources?.javbus?.baseUrl || 'https://www.javbus.com');

  let result;
  try {
    result = await downloadImage(fullUrl, savePath, referer);
  } catch (e) {
    // 代理/防盗链失败时的兜底：改用直连 + 浏览器UA + 以图片站自身域为 Referer 再试一次
    console.log(`[海报下载] 代理路径失败(${e.message})，尝试直连兜底: ${fullUrl.slice(0, 60)}`);
    const origin = (() => { try { return new URL(fullUrl).origin; } catch (x) { return ''; } })();
    const r = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': referer || (origin ? origin + '/' : '')
      },
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const arr = await r.arrayBuffer();
    // ★ 同样要过「是不是真图片」这一关：91动漫 图床返回的是 AES-CBC 密文，
    //   不校验就落盘 -> 前端白框（历史事故）。这里能解密就解密，不能就丢掉。
    const { ensureRealImage } = require('./crawler/image-guard');
    const realBuf = ensureRealImage(Buffer.from(arr));
    if (!realBuf) throw new Error(`兜底路径返回的不是图片（${arr.byteLength}B，加密或防盗链页）`);
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(savePath, realBuf);
    result = savePath;   // ★ 原代码漏了这句，走兜底成功时函数返回 undefined
  }

  // 下载成功后，保存一份到缓存（去重用）
  if (cacheName && fs.existsSync(savePath)) {
    try {
      const cachePath = path.join(POSTER_CACHE_DIR, cacheName);
      if (!fs.existsSync(cachePath)) {
        fs.copyFileSync(savePath, cachePath);
      }
    } catch (e) {
      // 缓存失败不影响主流程
    }
  }

  return result;
}

/**
 * 搜索番号的所有可用海报（用于手动更换海报）
 * 改动：按库类型硬分流（type：jav/anime/comic/novel）；不传时保留文件名猜测兼容旧调用
 */
async function searchAllPosters(avid, cleanName, fileName, type, filePath) {
  // 增加兜底，undefined/空值转为空字符串
  fileName = fileName ?? "";
  const results = [];

  // ===== 动漫库 → AniList / 91动漫 / hanime =====
  if (type === 'anime' || (!type && isHanimeAnime(fileName))) {
    const animeKey = animeSearchKey(fileName, filePath);
    console.log(`[动漫海报搜索]清洗后关键词:${animeKey || '(空，放弃)'}`);
    if (!animeKey) return results;
    const { simScore, norm } = require('./crawler/title-match');
    const qn = norm(animeKey);
    // 站点的图床/缩略图带签名或防盗链，浏览器直连会 403/过期 → 预览统一走本站代理
    const proxyDisplay = (u) => '/api/movie/poster/proxy?url=' + encodeURIComponent(u);

    // --- 1) AniList：一次给多条候选，用户自己挑（CDN 公开可直连，无需代理）---
    if (config.sources?.anilist?.enabled !== false) {
      try {
        const list = await searchAniListAll(animeKey);
        const ranked = list
          .map(c => ({ c, s: simScore(c.title, qn) }))
          .filter(x => x.s >= 0.3)
          .sort((a, b) => b.s - a.s);
        for (const { c } of ranked.slice(0, 8)) {
          results.push({
            source: 'anilist',
            url: c.cover,
            title: c.title + (c.year ? ` (${c.year})` : ''),
            num: ''
          });
        }
      } catch (e) {
        console.log('[AniList海报搜索异常]', e.message);
      }
    }

    // --- 2) FANZA 官方 API：里番动画的官方封面（需 config 填 api_id/affiliate_id）---
    if (fanzaAvailable()) {
      try {
        const list = await searchFanzaAll(animeKey, { floor: 'anime' });
        const ranked = list
          .map(c => ({ c, s: simScore(c.title, qn) }))
          .filter(x => x.s >= 0.45)
          .sort((a, b) => b.s - a.s);
        for (const { c } of ranked.slice(0, 5)) {
          results.push({
            source: 'fanza',
            url: c.cover,
            display: proxyDisplay(c.cover),
            title: c.title,
            num: ''
          });
        }
      } catch (e) {
        console.log('[FANZA海报搜索异常]', e.message);
      }
    }

    // --- 3) 91动漫：走 /api/search?q= JSON 接口，按相似度筛掉不相关的 ---
    // 阈值 0.45：实测 0.3 会放进「夏日小插曲MordredFans」这种噪声
    // （字符 Dice 被拉丁字母 s/e/r 与 sisters 撞上，虚高到 0.42）
    if (config.sources?.dongman?.enabled) {
      try {
        const list = await searchDongmanAll(animeKey);
        const ranked = list
          .map(c => ({ c, s: simScore(c.title, qn) }))
          .filter(x => x.s >= 0.45)
          .sort((a, b) => b.s - a.s);
        for (const { c } of ranked.slice(0, 5)) {
          results.push({
            source: '91dongman',
            url: c.cover,                    // 原始签名直链（change-poster 下载用）
            display: proxyDisplay(c.cover),  // 预览用本站代理，避免签名过期/防盗链
            title: c.title,
            num: ''
          });
        }
      } catch (e) {
        console.log('[91动漫海报搜索异常]', e.message);
      }
    }

    // --- 4) hanime1.me（Cloudflare 拦截严重，放最后）---
    if (config.sources?.hanime?.enabled) {
      let hanRes = null;
      try {
        hanRes = await searchHanimeByName(animeKey);
      } catch (err) {
        console.log('[hanime-pw海报搜索异常]', err.message);
        hanRes = null;
      }
      if (hanRes && hanRes.cover && simScore(hanRes.title || '', qn) >= 0.45) {
        results.push({
          source: 'hanime-pw',
          url: hanRes.cover,
          display: proxyDisplay(hanRes.cover),
          title: hanRes.title || animeKey,
          num: ''
        });
      }
    }

    return results;
  }

  // ===== 漫画库 → kmoe =====
  if (type === 'comic') {
    if (config.sources?.kmoe?.enabled) {
      const comicResult = await searchFromKmoe(fileName);
      if (comicResult && comicResult.cover) {
        results.push({
          source: 'kmoe',
          url: comicResult.cover,
          title: comicResult.title || cleanName,
          num: ''
        });
      }
    }
    return results;
  }

  // ===== 小说库 → zlibrary =====
  if (type === 'novel') {
    if (config.sources?.zlibrary?.enabled) {
      const novelResult = await searchFromZlibrary(fileName);
      if (novelResult && novelResult.cover) {
        results.push({
          source: 'zlibrary',
          url: novelResult.cover,
          title: novelResult.title || cleanName,
          num: ''
        });
      }
    }
    return results;
  }

  const priority = config.scraper?.sourcePriority || ['jav321', 'javbus', 'javdb', 'tmdb'];

  // 1.优先番号搜索
  if (avid) {
    for (const source of priority) {
      try {
        const srcConfig = config.sources?.[source];
        if (srcConfig && srcConfig.enabled === false) continue;
        // 「选封面」弹窗要等所有源都返回才渲染，浏览器源（jable）一次要十几秒，
        // 放进来会让弹窗每次都很慢；它只在主刮削流程里当兜底。
        if (source === 'jable') continue;

        let result = null;
        switch (source) {
          case 'jav321':
            result = await searchJav321ByAvid(avid);
            break;
          case 'javbus':
            result = await searchJavBusByAvid(avid);
            break;
          case 'javdb':
            result = await searchJavDBByAvid(avid);
            break;
          case 'dmm':
            result = await searchDmmByAvid(avid);
            break;
          case 'netflav':
            result = await searchNetflavByAvid(avid);
            break;
          case 'onejav':
            result = await searchOnejavByAvid(avid);
            break;
          case 'javcl':
            result = await searchJavclByAvid(avid);
            break;
          case 'jable':
            result = await searchJableByAvid(avid);
            break;
          case 'javmenu':
            result = await searchJavmenuByAvid(avid);
            break;
          default:
            continue;
        }

        if (result && result.cover) {
          results.push({
            source,
            url: result.cover,
            title: result.title || avid,
            num: result.num || avid
          });
        }
      } catch (e) {
        console.log(`[海报搜索] ${source} 失败:`, e.message);
      }
    }
  }

  // 2.兜底：没有番号，使用cleanName调用TMDB搜索
  if (results.length === 0 && cleanName && cleanName.trim() !== '') {
    console.log('[海报搜索]无番号，使用文本搜索：', cleanName);
    const tmdbRes = await searchFromTMDB(cleanName);
    if (tmdbRes && tmdbRes.poster_path) {
      results.push({
        source: 'tmdb',
        url: POSTER_BASE + tmdbRes.poster_path,
        title: tmdbRes.title || cleanName,
        num: ''
      })
    }
  }

  return results;
}

module.exports = {
  cleanMovieName,
  cleanHanimeName,
  animeSearchKey,
  isHanimeAnime,
  detectTypeByPath,
  extractAvId,
  searchMovie,
  downloadPoster,
  searchAllPosters,
  getPosterCacheName,
  isPosterCached,
  POSTER_BASE
};