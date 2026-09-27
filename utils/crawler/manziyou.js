/**
 * 漫自由 mhx12 漫画爬虫
 * epub/Kindle 漫画下载站
 */

const Request = require('./base');
const cheerio = require('cheerio');

class ManziyouCrawler {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://www.mhx12.com';
    this.request = new Request(config);
  }

  /**
   * 搜索漫画
   * @param {string} keyword 关键词
   * @returns {Promise<Array>} 搜索结果
   */
  async search(keyword) {
    try {
      const url = `${this.baseUrl}/search?q=${encodeURIComponent(keyword)}`;
      const $ = await this.request.getHtml(url);
      
      const results = [];
      
      // 解析搜索结果列表
      $('.comic-item, .book-item, .item, .list-item').each((i, el) => {
        const $el = $(el);
        const title = $el.find('.title, .name, h3, h2').first().text().trim();
        const cover = $el.find('img').attr('src') || '';
        const href = $el.find('a').first().attr('href') || '';
        const url = href.startsWith('http') ? href : this.baseUrl + href;
        
        if (title) {
          results.push({
            title,
            cover,
            url,
            source: 'manziyou'
          });
        }
      });
      
      return results;
    } catch (e) {
      console.log('[漫自由] 搜索失败:', e.message);
      return [];
    }
  }

  /**
   * 获取漫画详情
   * @param {string} url 漫画详情页URL
   * @returns {Promise<Object>} 详情信息
   */
  async getDetail(url) {
    try {
      const $ = await this.request.getHtml(url);
      
      const title = $('.comic-title, .book-title, h1, .title').first().text().trim();
      const cover = $('.comic-cover img, .book-cover img, .cover img').first().attr('src') || '';
      const description = $('.comic-desc, .book-desc, .description, .intro').first().text().trim();
      
      // 提取信息
      const info = {};
      $('.info-item, .meta-item, .comic-info li, .detail-info li').each((i, el) => {
        const text = $(el).text().trim();
        const parts = text.split(/[:：]/);
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join(':').trim();
          info[key] = value;
        }
      });
      
      // 提取章节/卷列表
      const chapters = [];
      $('.chapter-list a, .volume-list a, .episodes a, .book-list a').each((i, el) => {
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
        info,
        chapters,
        source: 'manziyou',
        url
      };
    } catch (e) {
      console.log('[漫自由] 获取详情失败:', e.message);
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
    name = name.replace(/(epub|mobi|pdf|zip|rar|kindle)/gi, '');
    name = name.trim();
    
    const results = await this.search(name);
    if (results.length === 0) return null;
    
    return await this.getDetail(results[0].url);
  }
}

module.exports = ManziyouCrawler;
