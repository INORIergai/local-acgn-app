/**
 * Z-Library 爬虫
 * 世界上最大的电子图书馆
 *
 * 说明：
 *  - 搜索页为 JS 渲染，纯 HTTP 拿不到结果，需优先走浏览器（CDP user-browser）方案
 *  - 域名为动态镜像，构造函数接受 baseUrl，默认走 1lib.sk（当前可用）
 *  - 搜索卡片结构：div.book-item.resItemBoxBooks > z-bookcard[href][download] > img[data-src] + [slot=title]
 */

const { Request } = require('./base');
const cheerio = require('cheerio');

// 候选镜像（按优先级），避免单一域名失效导致刮削全挂
const MIRRORS = ['https://1lib.sk', 'https://z-lib.id', 'https://z-lib.io'];

class ZLibraryCrawler {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || 'https://1lib.sk').replace(/\/+$/, '');
    this.request = new Request(config);
    this.loggedIn = false;
  }

  /**
   * 尝试解析搜索页 HTML（支持 HTTP 与浏览器两种来源）
   */
  _parseSearchHtml(html, baseUrl) {
    const $ = cheerio.load(html);
    const results = [];

    // 新版卡片：div.book-item.resItemBoxBooks > z-bookcard
    $('.book-item.resItemBoxBooks').each((i, el) => {
      const $el = $(el);
      const card = $el.find('z-bookcard').first();
      const href = card.attr('href') || '';
      const download = card.attr('download') || '';
      const title = card.find('[slot="title"]').first().text().trim() ||
                    card.attr('title') || '';
      const author = card.find('[slot="author"]').first().text().trim() ||
                     card.attr('author') || '';
      const img = card.find('img').first();
      let cover = img.attr('data-src') || img.attr('src') || '';
      const year = card.attr('year') || '';
      const publisher = card.attr('publisher') || '';
      const extension = card.attr('extension') || '';
      const filesize = card.attr('filesize') || '';
      const rating = card.attr('rating') || '';

      if (!title) return;

      if (cover && !/^https?:/.test(cover)) cover = baseUrl + cover;
      const fullUrl = /^https?:/.test(href) ? href : baseUrl + href;

      results.push({
        title,
        cover,
        url: fullUrl,
        downloadUrl: download ? (baseUrl + download) : '',
        author,
        year,
        publisher,
        extension,
        filesize,
        rating,
        source: 'zlibrary'
      });
    });

    // 兼容旧版选择器
    if (results.length === 0) {
      $('.resItemBox, .book-item, .item, .result-item').each((i, el) => {
        const $el = $(el);
        const title = $el.find('.title, .name, h3, h2, .bookTitle').first().text().trim();
        const cover = $el.find('img').attr('data-src') || $el.find('img').attr('src') || '';
        const href = $el.find('a').first().attr('href') || '';
        const author = $el.find('.author, .writers, .bookAuthor').first().text().trim();
        const year = $el.find('.year, .bookYear').first().text().trim();
        const publisher = $el.find('.publisher, .bookPublisher').first().text().trim();
        if (title) {
          results.push({
            title,
            cover: cover ? (baseUrl + (cover.startsWith('/') ? cover : '/' + cover)) : '',
            url: /^https?:/.test(href) ? href : baseUrl + href,
            downloadUrl: '',
            author,
            year,
            publisher,
            extension: '',
            filesize: '',
            rating: '',
            source: 'zlibrary'
          });
        }
      });
    }

    return results;
  }

  /**
   * 浏览器搜索（CDP user-browser，JS 渲染后可拿到真实卡片）
   */
  async _searchByBrowser(keyword) {
    const userBrowser = require('./user-browser');
    for (const domain of [this.baseUrl, ...MIRRORS.filter(m => m !== this.baseUrl)]) {
      const base = domain.replace(/\/+$/, '');
      const url = `${base}/s/?q=${encodeURIComponent(keyword)}`;
      try {
        console.log(`[Z-Library] 浏览器搜索: ${url}`);
        const { html, finalUrl } = await userBrowser.fetchPage(url, { cfWaitMs: 30000 });
        if (finalUrl.includes('chromewebdata') || userBrowser.isCloudflareChallenge(html)) {
          console.log(`[Z-Library] ${base} 被拦截，尝试下一镜像`);
          continue;
        }
        const results = this._parseSearchHtml(html, base);
        if (results.length > 0) {
          this.baseUrl = base;
          console.log(`[Z-Library] 浏览器搜索成功，共 ${results.length} 条 (${base})`);
          return results;
        }
      } catch (e) {
        console.log(`[Z-Library] 浏览器搜索失败 ${base}: ${e.message.split('\n')[0]}`);
      }
    }
    return [];
  }

  /**
   * 搜索书籍
   */
  async search(keyword, options = {}) {
    // 1. 先尝试 HTTP 直连（部分镜像可能 SSR）
    const params = new URLSearchParams({ q: keyword, ...options });
    const url = `${this.baseUrl}/s/?${params.toString()}`;
    try {
      const res = await this.request.get(url);
      const html = await res.text();
      const httpResults = this._parseSearchHtml(html, this.baseUrl);
      if (httpResults.length > 0) {
        console.log(`[Z-Library] HTTP搜索成功，共 ${httpResults.length} 条`);
        return httpResults;
      }
    } catch (e) {
      console.log(`[Z-Library] HTTP搜索不可用: ${e.message.split('\n')[0]}`);
    }

    // 2. HTTP 拿不到 → 浏览器方案
    return this._searchByBrowser(keyword);
  }

  /**
   * 获取书籍详情
   */
  async getDetail(url) {
    try {
      const $ = await this.request.getHtml(url);

      const title = $('.book-title, h1, .title, #bookTitle, [slot="title"]').first().text().trim();
      let cover = $('.book-cover img, .cover img, #bookCoverImg, z-bookcard img').first().attr('data-src') ||
                  $('.book-cover img, .cover img, #bookCoverImg, z-bookcard img').first().attr('src') || '';
      if (cover && !/^https?:/.test(cover)) cover = this.baseUrl + cover;
      const description = $('.book-description, .description, .intro, #bookDescription').first().text().trim();
      const author = $('.author, .writers, .book-author, #bookAuthors, [slot="author"]').first().text().trim();

      const info = {};
      $('.info-item, .meta-item, .book-info li, .detail-info li, .property_item').each((i, el) => {
        const text = $(el).text().trim();
        const parts = text.split(/[:：]/);
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join(':').trim();
          info[key] = value;
        }
      });

      const downloadUrl = $('.download-btn a, #downloadButton').attr('href') || '';

      return {
        title,
        cover,
        description,
        author,
        info,
        downloadUrl,
        source: 'zlibrary',
        url
      };
    } catch (e) {
      console.log('[Z-Library] 获取详情失败:', e.message);
      return null;
    }
  }

  /**
   * 根据文件名搜索并获取最佳匹配
   */
  async searchByFileName(fileName) {
    let name = fileName.replace(/\.[^.]+$/, '');
    name = name.replace(/\[.*?\]/g, '');
    name = name.replace(/\(.*?\)/g, '');
    name = name.replace(/【.*?】/g, '');
    name = name.replace(/(epub|mobi|pdf|txt|azw3|docx|zip|rar|电子书|全本|完整版|精校版)/gi, '');
    name = name.replace(/[-_.]/g, ' ');
    name = name.trim().replace(/\s+/g, ' ');
    if (name.length < 2) return null;

    const results = await this.search(name);
    if (results.length === 0) return null;

    // 优先选标题包含关键词的最匹配项
    const kw = name.toLowerCase().replace(/\s+/g, '');
    let best = results[0];
    let bestScore = -1;
    for (const r of results) {
      const t = (r.title || '').toLowerCase().replace(/\s+/g, '');
      let score = 0;
      if (kw && t.includes(kw)) score += 10;
      const words = name.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
      for (const w of words) if (t.includes(w)) score += 2;
      if (score > bestScore) { bestScore = score; best = r; }
    }

    const detail = await this.getDetail(best.url);
    if (!detail) {
      return {
        title: best.title || name,
        originalTitle: best.title || '',
        description: '',
        author: best.author || '',
        cover: best.cover || '',
        releaseDate: best.year || '',
        genres: []
      };
    }

    return {
      title: detail.title || best.title,
      originalTitle: detail.title || '',
      description: detail.description || '',
      author: detail.author || best.author || '',
      cover: detail.cover || best.cover || '',
      releaseDate: best.year || '',
      genres: []
    };
  }
}

module.exports = ZLibraryCrawler;
