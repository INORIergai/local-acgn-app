/**
 * Hanime1.me 动漫爬虫
 * 用于刮削动漫封面、标题、简介、标签等元数据
 */

const { Request } = require('./base');
const { load } = require('cheerio');
const config = require('../config');

class HanimeCrawler {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://shturl.cc/8oNVNJ7R';
    this.req = new Request({
      uaType: 'chrome',
      ...options
    });
  }

  /**
   * 搜索动漫
   * @param {string} keyword 搜索关键词
   * @returns {Promise<Array>} 搜索结果列表
   */
  async search(keyword) {
    try {
      const url = `${this.baseUrl}/search?q=${encodeURIComponent(keyword)}`;
      console.log(`[Hanime] 搜索URL: ${url}`);

      // 使用_doFetch获取response对象，拿到跳转之后真实url
      const res = await this.req._doFetch(url);
      const html = await res.text();
      const realFinalUrl = res.url; // 跟随跳转后的真实页面地址
      console.log(`[Hanime] 跳转后真实页面地址：${realFinalUrl}`);
      // 打印页面头部片段，用于调试页面结构
      console.log("[Hanime] HTML片段:", html.substring(0, 1200));

      const $ = load(html);
      const results = [];

      // 尝试多种选择器，适配不同页面结构
      const selectors = [
        // 常见视频卡片选择器
        '.video-block',
        '.video-card',
        '.video-item',
        '.card-video',
        '.card',
        '.item',
        '.search-result',
        '.result-item',
        '.grid-item',
        '.thumb-block',
        '.thumb',
        'article',
        // 模糊匹配
        '[class*="video"]',
        '[class*="card"]',
        '[class*="thumb"]',
        '[class*="item"]'
      ];

      for (const selector of selectors) {
        const elements = $(selector);
        if (elements.length > 0) {
          console.log(`[Hanime] 选择器 "${selector}" 匹配到 ${elements.length} 个元素`);

          elements.each((i, el) => {
            const $el = $(el);

            // 提取标题 - 尝试多种方式
            let title = '';
            const titleSelectors = [
              '.title', '.video-title', '.name', '.video-name',
              'h3', 'h4', 'h2', 'a', '.card-title'
            ];
            for (const ts of titleSelectors) {
              const text = $el.find(ts).first().text().trim();
              if (text && text.length > 1 && text.length < 200) {
                title = text;
                break;
              }
            }
            // 兜底：从 img alt 或 a title 获取
            if (!title) {
              title = $el.find('img').attr('alt') || $el.find('a').attr('title') || '';
            }

            // 提取封面 - 尝试多种属性
            let cover = '';
            const $img = $el.find('img').first();
            const imgAttrs = ['src', 'data-src', 'data-original', 'data-lazy', 'data-url', 'data-bg'];
            for (const attr of imgAttrs) {
              const val = $img.attr(attr);
              if (val && val.length > 5 && !val.includes('data:')) {
                cover = val;
                break;
              }
            }
            // 兜底：从 style background-image 提取
            if (!cover) {
              const style = $el.attr('style') || $el.find('[style*="background"]').attr('style') || '';
              const bgMatch = style.match(/url\(['"]?([^'")]+)['"]?\)/);
              if (bgMatch) cover = bgMatch[1];
            }

            // 提取链接
            let link = $el.find('a').first().attr('href') || '';
            if (!link && $el.is('a')) {
              link = $el.attr('href') || '';
            }

            // 验证结果有效性
            if (title && cover && title.length > 1) {
              // 使用跳转后的真实页面url做基准，而不是原始短链baseUrl
              const realBase = new URL(realFinalUrl).origin;

              const fullCover = cover.startsWith('http') ? cover :
                cover.startsWith('//') ? 'https:' + cover :
                  cover.startsWith('/') ? `${realBase}${cover}` : cover;

              const fullUrl = link ? (
                link.startsWith('http') ? link :
                  link.startsWith('//') ? 'https:' + link :
                    link.startsWith('/') ? `${realBase}${link}` : link
              ) : null;

              results.push({
                title: title.trim(),
                cover: fullCover,
                url: fullUrl,
                source: 'hanime'
              });
            }
          });

          if (results.length > 0) {
            console.log(`[Hanime] 选择器 "${selector}" 提取到 ${results.length} 个有效结果`);
            break;
          }
        }
      }

      // 如果上面的选择器都没找到，尝试直接找所有带图片的链接
      if (results.length === 0) {
        console.log('[Hanime] 常规选择器未找到结果，尝试兜底匹配...');
        const realBase = new URL(realFinalUrl).origin;
        $('a').each((i, el) => {
          const $el = $(el);
          const href = $el.attr('href') || '';
          const $img = $el.find('img').first();

          if (!href || !$img.length) return;

          // 只匹配视频相关链接
          const isVideoLink = /\/(video|watch|v|play|view)\//i.test(href) ||
            /\/hentai\//i.test(href) ||
            /\/search\?/.test(href) === false && href.includes('/');

          if (!isVideoLink) return;

          let title = $img.attr('alt') || $el.attr('title') || '';
          if (!title) {
            title = $el.text().trim().substring(0, 100);
          }

          let cover = '';
          const imgAttrs = ['src', 'data-src', 'data-original', 'data-lazy', 'data-url'];
          for (const attr of imgAttrs) {
            const val = $img.attr(attr);
            if (val && val.length > 5 && !val.includes('data:')) {
              cover = val;
              break;
            }
          }

          if (cover && title && title.length > 1) {
            const fullCover = cover.startsWith('http') ? cover :
              cover.startsWith('//') ? 'https:' + cover :
                cover.startsWith('/') ? `${realBase}${cover}` : cover;

            const fullUrl = href.startsWith('http') ? href :
              href.startsWith('//') ? 'https:' + href :
                href.startsWith('/') ? `${realBase}${href}` : href;

            results.push({
              title: title.trim(),
              cover: fullCover,
              url: fullUrl,
              source: 'hanime'
            });
          }
        });

        console.log(`[Hanime] 兜底匹配找到 ${results.length} 个结果`);
      }

      console.log(`[Hanime] 搜索 "${keyword}"，最终找到 ${results.length} 个结果`);
      if (results.length > 0) {
        console.log(`[Hanime] 第一个结果: title="${results[0].title.substring(0, 50)}", cover="${results[0].cover.substring(0, 80)}"`);
      }

      return results;
    } catch (e) {
      console.log(`[Hanime] 搜索失败: ${e.message}`);
      return [];
    }
  }

  /**
   * 根据文件名搜索（自动提取关键词）
   * @param {string} fileName 文件名
   * @returns {Promise<Object|null>} 最佳匹配结果
   */
  async searchByFileName(fileName) {
    try {
      // 清理文件名，提取关键词
      let keyword = fileName
        .replace(/\.[^.]+$/, '') // 去掉扩展名
        .replace(/[\[\]【】()（）{}「」『』]/g, ' ') // 去掉括号
        .replace(/[！？〇★☆◆■●]/g, ' ') // 清除干扰搜索特殊符号：全角感叹号、特殊圆圈〇等
        .replace(/[0-9]{3,4}[pP]/g, '') // 去掉分辨率 (1080p, 720p)
        .replace(/x26[45]|hevc|h\.?26[45]|xvid|divx|神画質/gi, '') // 去掉编码/画质标记
        .replace(/[0-9]{4}[-/][0-9]{2}[-/][0-9]{2}/g, '') // 去掉日期
        .replace(/[0-9]{4}年/g, '') // 去掉年份
        .replace(/(CHS|CHT|JP|EN|SUB|UNC|BD|BluRay|WEB‑DL|WEBRip|HD|FHD|4K|UHD)/gi, '') // 去掉常见标记
        .replace(/\d+/g, ' ') // 剔除纯数字片段
        .replace(/[-_.]/g, ' ') // 替换分隔符
        .replace(/\s+/g, ' ')
        .trim();

      console.log(`[Hanime] 从文件名提取关键词: "${keyword}" (原文件名: ${fileName})`);

      // 如果关键词太短，直接返回null
      if (keyword.length < 2) {
        console.log('[Hanime] 关键词太短，跳过搜索');
        return null;
      }

      // hanime1 后端对超长query兼容性差，超过22字符优先做截断降级
      let results;
      if (keyword.length > 22) {
        const wordList = keyword.split(' ').filter(w => w.length > 1);
        // 优先取前3个词
        const shortKey = wordList.slice(0, 3).join(' ');
        console.log(`[Hanime] 关键词过长(${keyword.length})，降级简短搜索词:"${shortKey}"`);
        results = await this.search(shortKey);
        if (results.length === 0 && wordList.length >= 2) {
          const shortKey2 = wordList.slice(0, 2).join(' ');
          console.log(`[Hanime] 第一轮无结果，再次降级关键词:"${shortKey2}"`);
          results = await this.search(shortKey2);
        }
      } else {
        // 第一次搜索：完整关键词
        results = await this.search(keyword);
      }

      if (results.length > 0) {
        return results[0];
      }

      // 第二次搜索：如果关键词包含空格，用前几个词搜索
      const words = keyword.split(' ').filter(w => w.length > 1);
      if (words.length >= 2) {
        const firstWords = words.slice(0, 2).join(' ');
        if (firstWords.length > 2 && firstWords !== keyword) {
          console.log(`[Hanime] 尝试用前两个词搜索: "${firstWords}"`);
          results = await this.search(firstWords);
          if (results.length > 0) {
            return results[0];
          }
        }
      }

      // 第三次搜索：用前15个字符搜索
      if (keyword.length > 15) {
        const shortKeyword = keyword.substring(0, 15);
        console.log(`[Hanime] 尝试用缩短关键词搜索: "${shortKeyword}"`);
        results = await this.search(shortKeyword);
        if (results.length > 0) {
          return results[0];
        }
      }

      // 第四次搜索：用前10个字符搜索
      if (keyword.length > 10) {
        const shortKeyword = keyword.substring(0, 10);
        console.log(`[Hanime] 尝试用更短关键词搜索: "${shortKeyword}"`);
        results = await this.search(shortKeyword);
        if (results.length > 0) {
          return results[0];
        }
      }

      console.log('[Hanime] 所有搜索策略均未找到结果');
      return null;
    } catch (e) {
      console.log(`[Hanime] 按文件名搜索失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 获取动漫详情
   * @param {string} url 详情页URL
   * @returns {Promise<Object|null>} 详情数据
   */
  async getDetail(url) {
    try {
      console.log(`[Hanime] 获取详情: ${url}`);

      const res = await this.req._doFetch(url);
      const html = await res.text();
      const $ = load(html);

      // 标题
      let title = '';
      const titleSelectors = [
        'h1', '.title', '.video-title', '.page-title',
        '.name', '.video-name', '.entry-title',
        '[class*="title"]', '[class*="name"]'
      ];
      for (const sel of titleSelectors) {
        const text = $(sel).first().text().trim();
        if (text && text.length > 2 && text.length < 300) {
          title = text;
          break;
        }
      }
      // 兜底：从 og:title 获取
      if (!title) {
        const ogTitle = $('meta[property="og:title"]').attr('content');
        if (ogTitle) title = ogTitle.trim();
      }

      // 封面
      let cover = null;

      // 1. 从 og:image 获取（最可靠）
      const ogImage = $('meta[property="og:image"]').attr('content');
      if (ogImage) {
        cover = ogImage;
        console.log(`[Hanime] 从 og:image 获取封面: ${cover.substring(0, 80)}`);
      }

      // 2. 从各种图片元素获取
      if (!cover) {
        const coverSelectors = [
          '.video-preview img', '.cover img', '.poster img', '.video‑cover img',
          '.thumbnail img', '.preview img', '.thumb img',
          '.player img', '.video‑player img',
          'img[alt*="cover"]', 'img[alt*="poster"]', 'img[alt*="thumb"]',
          '.video‑thumbnail img', '.image img',
          '[class*="cover"] img', '[class*="poster"] img',
          '[class*="thumb"] img', '[class*="image"] img'
        ];
        for (const sel of coverSelectors) {
          const $el = $(sel).first();
          if ($el.length === 0) continue;

          const imgAttrs = ['src', 'data‑src', 'data‑original', 'data‑lazy', 'data‑url', 'data‑bg'];
          for (const attr of imgAttrs) {
            const val = $el.attr(attr);
            if (val && val.length > 5 && !val.includes('data:')) {
              cover = val;
              console.log(`[Hanime] 从选择器 "${sel}" 的 ${attr} 属性获取封面`);
              break;
            }
          }
          if (cover) break;
        }
      }

      // 3. 兜底：找页面上最大的图片
      if (!cover) {
        console.log('[Hanime] 尝试找页面上最大的图片...');
        let maxImg = null;
        let maxArea = 0;
        $('img').each((i, el) => {
          const $img = $(el);
          const src = $img.attr('src') || $img.attr('data‑src') || '';
          const width = parseInt($img.attr('width')) || 0;
          const height = parseInt($img.attr('height')) || 0;
          const area = width * height;

          if (src && area > maxArea && !src.includes('data:') && src.length > 10) {
            maxImg = src;
            maxArea = area;
          }
        });
        if (maxImg) {
          cover = maxImg;
          console.log(`[Hanime] 从最大图片获取封面: ${cover.substring(0, 80)}`);
        }
      }

      // 处理封面URL
      if (cover) {
        if (cover.startsWith('//')) {
          cover = 'https:' + cover;
        }
      }

      // 简介
      let overview = '';
      const descSelectors = [
        '.description', '.summary', '.overview', '.plot',
        '.info', '.details', '.content',
        '[class*="desc"]', '[class*="summary"]', '[class*="info"]'
      ];
      for (const sel of descSelectors) {
        const text = $(sel).first().text().trim();
        if (text && text.length > 5 && text.length < 2000) {
          overview = text;
          break;
        }
      }
      // 兜底：从 og:description 获取
      if (!overview) {
        const ogDesc = $('meta[property="og:description"]').attr('content');
        if (ogDesc) overview = ogDesc.trim();
      }

      // 提取标签
      const tags = [];
      const tagSelectors = [
        '.tags a', '.genres a', '.tag', '.category a',
        '.categories a', '.label', '.labels a',
        '[class*="tag"] a', '[class*="genre"] a',
        '[class*="category"] a', '[class*="label"] a'
      ];
      for (const sel of tagSelectors) {
        $(sel).each((i, el) => {
          const tag = $(el).text().trim();
          if (tag && tag.length > 0 && tag.length < 20 && !tags.includes(tag)) {
            tags.push(tag);
          }
        });
        if (tags.length > 0) break;
      }

      const result = {
        title,
        cover,
        overview,
        tags,
        source: 'hanime'
      };

      console.log(`[Hanime] 详情提取完成: title="${title.substring(0, 50)}", cover=${cover ? '有' : '无'}, tags=${tags.length}个`);

      return result;
    } catch (e) {
      console.log(`[Hanime] 获取详情失败: ${e.message}`);
      return null;
    }
  }
}

// ---------------- 对外导出给 poster‑fetcher 使用的函数 ----------------
let _crawlerInstance = null;

function getInstance() {
  if (!_crawlerInstance) {
    const srcCfg = config.sources?.hanime || {};
    _crawlerInstance = new HanimeCrawler({
      baseUrl: srcCfg.baseUrl || "https://shturl.cc/8oNVNJ7R"
    });
  }
  return _crawlerInstance;
}

/**
 * poster‑fetcher 调用入口
 * @param {string} keyword 清洗后的搜索关键词
 * @returns {Promise<object|null>}
 */
async function searchHanimeByName(keyword) {
  if (!keyword || keyword.trim().length === 0) return null;
  const crawler = getInstance();
  const list = await crawler.search(keyword.trim());
  if (!Array.isArray(list) || list.length === 0) return null;

  const first = list[0];
  if (!first?.url) {
    return {
      title: first.title || "",
      originalTitle: first.title || "",
      cover: first.cover || "",
      releaseDate: "",
      genres: [],
      overview: ""
    };
  }

  const detail = await crawler.getDetail(first.url);
  if (!detail) {
    return {
      title: first.title || "",
      originalTitle: first.title || "",
      cover: first.cover || "",
      releaseDate: "",
      genres: [],
      overview: ""
    };
  }

  return {
    title: detail.title || first.title,
    originalTitle: detail.title || first.title,
    cover: detail.cover || first.cover,
    releaseDate: "",
    genres: detail.tags || [],
    overview: detail.overview || ""
  };
}

module.exports = {
  HanimeCrawler,
  searchHanimeByName
};