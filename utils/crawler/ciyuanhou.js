/**
 * 次元狗 轻小说爬虫
 */

const Request = require('./base');
const cheerio = require('cheerio');

class CiyuanhouCrawler {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://www.ciyuanhou.com';
    this.request = new Request(config);
  }

  /**
   * 搜索轻小说
   * @param {string} keyword 关键词
   * @returns {Promise<Array>} 搜索结果
   */
  async search(keyword) {
    try {
      const url = `${this.baseUrl}/search?q=${encodeURIComponent(keyword)}`;
      const $ = await this.request.getHtml(url);
      
      const results = [];
      
      // 解析搜索结果列表
      $('.novel-item, .book-item, .item, .list-item').each((i, el) => {
        const $el = $(el);
        const title = $el.find('.title, .name, h3, h2').first().text().trim();
        const cover = $el.find('img').attr('src') || '';
        const href = $el.find('a').first().attr('href') || '';
        const url = href.startsWith('http') ? href : this.baseUrl + href;
        const author = $el.find('.author, .writer').first().text().trim();
        
        if (title) {
          results.push({
            title,
            cover,
            url,
            author,
            source: 'ciyuanhou'
          });
        }
      });
      
      return results;
    } catch (e) {
      console.log('[次元狗] 搜索失败:', e.message);
      return [];
    }
  }

  /**
   * 获取小说详情
   * @param {string} url 小说详情页URL
   * @returns {Promise<Object>} 详情信息
   */
  async getDetail(url) {
    try {
      const $ = await this.request.getHtml(url);
      
      const title = $('.novel-title, .book-title, h1, .title').first().text().trim();
      const cover = $('.novel-cover img, .book-cover img, .cover img').first().attr('src') || '';
      const description = $('.novel-desc, .book-desc, .description, .intro, .summary').first().text().trim();
      const author = $('.author, .writer, .novel-author').first().text().trim();
      
      // 提取信息
      const info = {};
      $('.info-item, .meta-item, .novel-info li, .detail-info li').each((i, el) => {
        const text = $(el).text().trim();
        const parts = text.split(/[:：]/);
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join(':').trim();
          info[key] = value;
        }
      });
      
      // 提取章节列表
      const chapters = [];
      $('.chapter-list a, .volume-list a, .catalog a, .chapter-item a').each((i, el) => {
        const $el = $(el);
        const name = $el.text().trim();
        const href = $el.attr('href') || '';
        const chapterUrl = href.startsWith('http') ? href : this.baseUrl + href;
        
        if (name) {
          chapters.push({ name, url: chapterUrl });
        }
      });
      
      return {
        title,
        cover,
        description,
        author,
        info,
        chapters,
        source: 'ciyuanhou',
        url
      };
    } catch (e) {
      console.log('[次元狗] 获取详情失败:', e.message);
      return null;
    }
  }

  /**
   * 根据文件名搜索并获取最佳匹配
   * @param {string} fileName 文件名
   * @returns {Promise<Object|null>} 最佳匹配结果
   */
  async searchByFileName(fileName) {
    let name = fileName.replace(/\.[^.]+$/, '');
    name = name.replace(/\[.*?\]/g, '');
    name = name.replace(/\(.*?\)/g, '');
    name = name.replace(/(epub|mobi|pdf|txt|zip|rar|轻小说|完结|全本)/gi, '');
    name = name.trim();
    
    const results = await this.search(name);
    if (results.length === 0) return null;
    
    return await this.getDetail(results[0].url);
  }
}

module.exports = CiyuanhouCrawler;
