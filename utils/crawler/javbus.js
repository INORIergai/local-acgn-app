const { Request } = require('./base');
const config = require('../config');

const FIELD_LABELS = {
  'zh-tw': {
    number: '識別碼', date: '發行日期', duration: '長度',
    director: '導演', maker: '製作商', label: '發行商',
    series: '系列', tags: '類別', actresses: '演員',
  },
  'ja': {
    number: '品番', date: '発売日', duration: '収録時間',
    director: '監督', maker: 'メーカー', label: 'レーベル',
    series: 'シリーズ', tags: 'ジャンル', actresses: '出演者',
  },
  'en': {
    number: 'ID', date: 'Release Date', duration: 'Length',
    director: 'Director', maker: 'Studio', label: 'Label',
    series: 'Series', tags: 'Genre', actresses: 'JAV Idols',
  },
};

const LANG_PREFIX = { 'zh-tw': '', 'ja': '/ja', 'en': '/en' };

function getBaseUrl() {
  const src = config.sources?.javbus;
  return src?.mirror || src?.baseUrl || 'https://www.javbus.com';
}

function getLang() {
  return config.sources?.javbus?.lang || 'zh-tw';
}

/**
 * JavBus 搜索并获取详情
 * @param {string} avid 番号
 * @returns {Object|null} 影片信息
 */
async function searchJavBusByAvid(avid) {
  const baseUrl = getBaseUrl();
  const lang = getLang();
  const prefix = LANG_PREFIX[lang] || '';
  const labels = FIELD_LABELS[lang] || FIELD_LABELS['zh-tw'];

  const req = new Request({
    uaType: 'safari',
    headers: {
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    }
  });

  try {
    const url = `${baseUrl}${prefix}/${avid}`;
    const $ = await req.getHtml(url);

    // 验证是详情页
    const info = $('.col-md-3.info');
    if (!info.length) {
      console.log(`[JavBus] 未找到番号: ${avid}`);
      return null;
    }

    // 标题
    let title = $('h3').first().text().trim();
    if (!title) {
      const bigImg = $('.bigImage').first();
      if (bigImg.length) {
        const img = bigImg.find('img[title]');
        if (img.length) title = img.attr('title') || '';
      }
    }
    // 去除番号前缀
    title = title.replace(new RegExp(`^${avid}\\s*`, 'i'), '');

    // 封面
    let cover = '';
    const bigImage = $('.bigImage').first();
    if (bigImage.length) {
      cover = bigImage.attr('href') || '';
      if (cover && !cover.startsWith('http')) {
        cover = baseUrl + cover;
      }
    }

    // 解析 info 区块
    const paragraphs = info.find('p');
    const parsed = {
      date: '', duration: '', director: '', maker: '',
      label: '', series: '', tags: [], actresses: [],
    };

    let i = 0;
    while (i < paragraphs.length) {
      const p = $(paragraphs[i]);
      const text = p.text().trim();

      // 单值字段
      for (const field of ['date', 'director', 'maker', 'label', 'series']) {
        const lbl = labels[field];
        if (lbl && text.includes(lbl)) {
          const a = p.find('a');
          if (a.length) {
            parsed[field] = a.text().trim();
          } else {
            let value = text;
            for (const char of [lbl, ':', '：']) {
              value = value.replace(char, '');
            }
            parsed[field] = value.trim();
          }
          break;
        }
      }

      // 时长
      if (labels.duration && text.includes(labels.duration)) {
        parsed.duration = text;
      }

      // 标签
      if (labels.tags && text.includes(labels.tags)) {
        let tagLinks = p.find('a');
        if (!tagLinks.length && i + 1 < paragraphs.length) {
          tagLinks = $(paragraphs[i + 1]).find('a');
          i++;
        }
        parsed.tags = tagLinks.map((_, a) => $(a).text().trim()).get().filter(t => t);
      }

      // 演员
      if (labels.actresses && text.includes(labels.actresses)) {
        let actressLinks = p.find('a');
        if (!actressLinks.length && i + 1 < paragraphs.length) {
          actressLinks = $(paragraphs[i + 1]).find('a');
          i++;
        }
        const seen = new Set();
        actressLinks.each((_, a) => {
          const name = $(a).text().trim();
          if (name && !seen.has(name)) {
            parsed.actresses.push(name);
            seen.add(name);
          }
        });
      }

      i++;
    }

    // 时长转数字
    let duration = 0;
    if (parsed.duration) {
      const m = parsed.duration.match(/(\d+)/);
      if (m) duration = parseInt(m[1]);
    }

    // 截图
    const sampleImages = [];
    const sampleSection = $('#sample-waterfall, .sample-waterfall').first();
    if (sampleSection.length) {
      sampleSection.find('a[href]').each((_, a) => {
        let imgUrl = $(a).attr('href') || '';
        if (imgUrl && !imgUrl.startsWith('http')) {
          imgUrl = baseUrl + imgUrl;
        }
        if (imgUrl) sampleImages.push(imgUrl);
      });
    }

    // 演员头像「搭车」抓取：影片详情页本身就带 .avatar-box，每个演员一张头像。
    // 这一步不产生额外 HTTP 请求，是给女优库补头像最划算的来源。
    const actressAvatars = [];
    const seenAvatarNames = new Set();
    $('.avatar-box').each((_, box) => {
      const img = $(box).find('img');
      const aName = (img.attr('title') || '').trim();
      let aSrc = (img.attr('src') || '').trim();
      if (!aName || !aSrc || seenAvatarNames.has(aName)) return;
      seenAvatarNames.add(aName);
      if (!aSrc.startsWith('http')) {
        aSrc = baseUrl + (aSrc.startsWith('/') ? aSrc : '/' + aSrc);
      }
      actressAvatars.push({ name: aName, avatar: aSrc });
    });

    if (!title && !cover) {
      return null;
    }

    return {
      title,
      originalTitle: title,
      cover,
      releaseDate: parsed.date,
      producer: parsed.maker,
      publisher: parsed.label,
      director: parsed.director,
      serial: parsed.series,
      score: 0,
      actress: parsed.actresses,
      actressAvatars,
      genres: parsed.tags,
      duration,
      sampleImages,
      source: 'javbus',
      detailUrl: url
    };

  } catch (e) {
    console.log(`[JavBus] 爬取失败 [${avid}]:`, e.message);
    return null;
  }
}

/**
 * JavBus 女优作品列表（带真实发行日期）
 * ============================================================
 * javdb 的搜索页只有番号/标题，**没有发行日期**，做不了「近一月」时间线。
 * javbus 的 `/star/{starId}` 页面每个条目都带 `<date>` 里的发行日期，
 * 且默认按发行日期倒序排列 —— 正是新作监视需要的形态。
 *
 * 流程：
 *   1. `/searchstar/{名字}` 拿到 starId（页面上混有「有碼/無碼/歐美」多类条目，
 *      它们的链接同样走 /star/，但可能没有头像 → 只取带 <img> 的那个）
 *   2. `/star/{starId}/{page}` 翻页，解析 `.movie-box`
 *      → 每个 box 里有两个 <date>：第一个是番号，第二个是发行日期
 *   3. 遇到明确早于 `since` 的日期就停（列表是倒序的，后面只会更早）
 *
 * @param {string} actressName 女优名（日文原名）
 * @param {Object} opts
 * @param {number} opts.sinceTs 只要这个时间戳之后的作品（0 = 不限）
 * @param {number} opts.maxPages 最多翻几页（默认 3，每页 30 条）
 * @returns {Promise<Array<{num,title,cover,url,releaseDate,releaseTs,source}>>}
 */
async function searchJavBusByActress(actressName, opts = {}) {
  const baseUrl = getBaseUrl().replace(/\/+$/, '');
  const sinceTs = Number(opts.sinceTs) || 0;
  const maxPages = Math.max(1, Number(opts.maxPages) || 3);

  const req = new Request({
    uaType: 'safari',
    headers: {
      'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    },
  });

  try {
    // ---- 1) 拿 starId ----
    const searchUrl = `${baseUrl}/searchstar/${encodeURIComponent(actressName)}`;
    const $s = await req.getHtml(searchUrl);

    // 只认「带 img 的 /star/ 链接」，并剥离「有碼/無碼/歐美」这类显示后缀
    const candidates = [];
    $s('a[href*="/star/"]').each((_, el) => {
      const $a = $s(el);
      const href = $a.attr('href') || '';
      const img = $a.find('img').attr('src') || '';
      const rawText = $a.text().trim();
      if (!href || !img) return;
      // 头像缺失的占位图（dmm nowprinting）不算有效条目
      if (/nowprinting/i.test(img)) return;
      const id = (href.match(/\/star\/([^/?#]+)/) || [])[1];
      if (!id) return;
      candidates.push({ id, rawText });
    });

    if (!candidates.length) {
      return [];
    }

    // 精确名字优先：把显示文本里的分类后缀去掉后与原名比对
    const norm = (s) => String(s || '')
      .replace(/(有碼|無碼|欧美|歐美|有码|无码)/g, '')
      .trim();
    let starId = candidates.find(c => norm(c.rawText) === actressName)?.id;
    // 退一步用「包含」
    if (!starId) starId = candidates.find(c => norm(c.rawText).includes(actressName))?.id;
    if (!starId) starId = candidates[0].id;

    // ---- 2) 翻作品列表 ----
    const out = [];
    const seen = new Set();

    for (let page = 1; page <= maxPages; page++) {
      const listUrl = page === 1
        ? `${baseUrl}/star/${starId}`
        : `${baseUrl}/star/${starId}/${page}`;
      const $ = await req.getHtml(listUrl);
      const boxes = $('.movie-box');
      if (!boxes.length) break;

      let hitOlderThanWindow = false;

      boxes.each((_, el) => {
        const $el = $(el);
        const href = $el.attr('href') || '';
        const img = $el.find('img').attr('src') || '';
        const dates = $el.find('date').map((__, d) => $(d).text().trim()).get();
        // dates[0] = 番号，dates[1] = 发行日期（YYYY-MM-DD）
        const num = String(dates[0] || '').trim();
        const dateStr = String(dates[1] || '').trim();

        if (!num || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;

        const ts = new Date(dateStr + 'T00:00:00').getTime();
        if (sinceTs && ts < sinceTs) {
          hitOlderThanWindow = true;
          return;
        }
        const key = num.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);

        out.push({
          num,
          title: num,               // javbus 列表页没有标题文本，用番号占位
          cover: img ? (img.startsWith('http') ? img : baseUrl + img) : '',
          url: href ? (href.startsWith('http') ? href : baseUrl + href) : '',
          releaseDate: dateStr,
          releaseTs: ts,
          source: 'javbus',
        });
      });

      // 列表按日期倒序：本页已经出现早于窗口的条目，后面的页只会更早
      if (hitOlderThanWindow) break;
    }

    console.log(`[JavBus] 女优 "${actressName}"(star ${starId}) 找到 ${out.length} 部窗口内作品`);
    return out;
  } catch (e) {
    console.log(`[JavBus] 女优搜索失败 [${actressName}]:`, e.message);
    return [];
  }
}

module.exports = { searchJavBusByAvid, searchJavBusByActress };

