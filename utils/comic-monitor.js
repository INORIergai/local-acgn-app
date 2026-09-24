/**
 * 漫画新作监控
 * 定期检查本地漫画在kmoe上有没有新的卷/章节上传
 */

const { getAllMovies, addNotification } = require('./db');
const config = require('./config');
const KmoeCrawler = require('./crawler/kmoe');

class ComicNewReleaseChecker {
  constructor() {
    this.checking = false;
    this.crawler = null;
  }

  /**
   * 获取kmoe爬虫实例
   */
  getCrawler() {
    if (!this.crawler) {
      const kmoeConfig = config.sources?.kmoe || {};
      this.crawler = new KmoeCrawler({
        baseUrl: kmoeConfig.baseUrl || 'https://kzo.moe',
        username: kmoeConfig.username || '',
        password: kmoeConfig.password || '',
        cookie: kmoeConfig.cookie || ''
      });
    }
    return this.crawler;
  }

  /**
   * 检查所有本地漫画的新作
   */
  async checkAll() {
    if (this.checking) {
      console.log('[漫画新作监控] 正在检查中，跳过...');
      return;
    }

    // 检查kmoe是否启用
    if (!config.sources?.kmoe?.enabled) {
      console.log('[漫画新作监控] kmoe数据源未开启，跳过');
      return 0;
    }

    this.checking = true;
    console.log('[漫画新作监控] 开始检查漫画新作...');

    try {
      // 获取所有本地漫画
      const allMovies = getAllMovies.all();
      const comics = allMovies.filter(m => (m.type || 'jav') === 'comic');
      console.log(`[漫画新作监控] 共 ${comics.length} 部本地漫画`);

      if (comics.length === 0) {
        console.log('[漫画新作监控] 没有漫画，跳过');
        return 0;
      }

      let newCount = 0;
      const crawler = this.getCrawler();

      // 为了避免请求太多，只检查前20部最新添加的漫画
      const comicsToCheck = comics
        .sort((a, b) => (b.addedTime || 0) - (a.addedTime || 0))
        .slice(0, 20);

      for (const comic of comicsToCheck) {
        try {
          const newWorks = await this.checkSingleComic(comic, crawler);
          newCount += newWorks.length;

          // 为每部新作生成通知
          for (const work of newWorks) {
            const extra = JSON.stringify({
              comicTitle: comic.title,
              volume: work.volume || '',
              source: 'kmoe'
            });
            addNotification.run(
              'comic_new_release',
              `漫画更新：${comic.title}`,
              `${work.title}\n${work.description || ''}`,
              work.url || '',
              work.cover || '',
              extra,
              Date.now()
            );
          }

          // 避免请求太快
          await new Promise(r => setTimeout(r, config.network.requestInterval || 2000));
        } catch (e) {
          console.log(`[漫画新作监控] 检查 ${comic.title} 失败:`, e.message);
        }
      }

      console.log(`[漫画新作监控] 检查完成，发现 ${newCount} 部新作`);
      if (newCount > 0) {
        const { push } = require('./push');
        push('漫画更新提醒', `追更的漫画有 ${newCount} 个新章节上架，打开漫画库查看`);
      }
      return newCount;
    } catch (e) {
      console.log('[漫画新作监控] 检查失败:', e.message);
      return 0;
    } finally {
      this.checking = false;
    }
  }

  /**
   * 检查单部漫画的新作
   */
  async checkSingleComic(comic, crawler) {
    const newWorks = [];

    try {
      const title = comic.title || comic.fileName || '';
      if (!title) return newWorks;

      // 清洗标题，去掉卷号、分辨率等信息
      const cleanTitle = this.cleanComicTitle(title);
      if (!cleanTitle || cleanTitle.length < 2) return newWorks;

      console.log(`[漫画新作监控] 搜索: ${cleanTitle}`);

      // 在kmoe上搜索
      const searchResults = await crawler.search(cleanTitle, 1);
      if (!searchResults || searchResults.length === 0) {
        console.log(`  未找到结果`);
        return newWorks;
      }

      console.log(`  找到 ${searchResults.length} 个结果`);

      // 找最匹配的（标题相似度最高的）
      let bestMatch = null;
      let bestScore = 0;

      for (const result of searchResults) {
        const score = this.calcSimilarity(cleanTitle, result.title || '');
        if (score > bestScore && score >= 0.6) {
          bestScore = score;
          bestMatch = result;
        }
      }

      if (!bestMatch) {
        console.log(`  没有足够匹配的结果`);
        return newWorks;
      }

      console.log(`  最佳匹配: ${bestMatch.title} (相似度: ${bestScore.toFixed(2)})`);

      // 获取详情，看看有多少卷
      try {
        const detail = await crawler.getDetail(bestMatch.url);
        if (detail && detail.chapters && detail.chapters.length > 0) {
          console.log(`  kmoe上有 ${detail.chapters.length} 卷/章节`);

          // 简单判断：如果kmoe上的卷数 > 1，且本地只有1个文件，可能有新卷
          // 更精确的判断需要解析本地漫画的卷号，这里先做简单版本
          const localCount = this.countLocalVolumes(title);
          console.log(`  本地约有 ${localCount} 卷`);

          if (detail.chapters.length > localCount) {
            const newVolCount = detail.chapters.length - localCount;
            console.log(`  发现 ${newVolCount} 个新卷！`);

            // 取最新的几个卷作为新作
            const newChapters = detail.chapters.slice(0, Math.min(newVolCount, 3));
            for (const chapter of newChapters) {
              newWorks.push({
                title: chapter.title || '新卷',
                description: `kmoe上共有 ${detail.chapters.length} 卷，本地约有 ${localCount} 卷`,
                url: bestMatch.url,
                source: 'kmoe'
              });
            }
          }
        }
      } catch (e) {
        console.log(`  获取详情失败: ${e.message}`);
        // 即使获取详情失败，只要搜索到了，也生成一个通知
        newWorks.push({
          title: bestMatch.title,
          description: '在kmoe上搜索到同名漫画，可能有新卷更新',
          url: bestMatch.url,
          source: 'kmoe'
        });
      }

    } catch (e) {
      console.log(`[漫画新作监控] 检查失败:`, e.message);
    }

    return newWorks;
  }

  /**
   * 清洗漫画标题，去掉卷号、分辨率等信息
   */
  cleanComicTitle(title) {
    let clean = title;
    // 去掉文件扩展名
    clean = clean.replace(/\.(cbz|cbr|zip|rar|pdf|epub)$/i, '');
    // 去掉卷号：第X卷、Vol.X、Volume X、卷X
    clean = clean.replace(/第\s*\d+\s*卷/g, '');
    clean = clean.replace(/Vol\.?\s*\d+/gi, '');
    clean = clean.replace(/Volume\s*\d+/gi, '');
    clean = clean.replace(/卷\s*\d+/g, '');
    // 去掉话数：第X话、Ch.X、Chapter X
    clean = clean.replace(/第\s*\d+\s*话/g, '');
    clean = clean.replace(/Ch\.?\s*\d+/gi, '');
    clean = clean.replace(/Chapter\s*\d+/gi, '');
    // 去掉分辨率、格式等
    clean = clean.replace(/\d{3,4}p/gi, '');
    clean = clean.replace(/\d+x\d+/gi, '');
    clean = clean.replace(/\[(.*?)\]/g, '');
    clean = clean.replace(/\((.*?)\)/g, '');
    // 去掉特殊字符
    clean = clean.replace(/[【】\[\]()（）]/g, '');
    // 去掉首尾空格和特殊符号
    clean = clean.trim();
    clean = clean.replace(/^[-_\s]+|[-_\s]+$/g, '');
    
    return clean;
  }

  /**
   * 计算标题相似度（简单版本）
   */
  calcSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    
    if (s1 === s2) return 1;
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;
    
    // 简单的字符重合度计算
    const set1 = new Set(s1.split(''));
    const set2 = new Set(s2.split(''));
    let common = 0;
    for (const char of set1) {
      if (set2.has(char)) common++;
    }
    const total = new Set([...set1, ...set2]).size;
    return total > 0 ? common / total : 0;
  }

  /**
   * 估算本地有多少卷（简单版本）
   */
  countLocalVolumes(title) {
    // 简单判断：如果标题里有卷号，就是1卷
    // 更精确的需要扫描同目录下的其他文件，这里先简单处理
    if (/第\s*\d+\s*卷|Vol\.?\s*\d+/i.test(title)) {
      return 1;
    }
    // 默认1卷
    return 1;
  }
}

// 单例
let checker = null;

function getChecker() {
  if (!checker) {
    checker = new ComicNewReleaseChecker();
  }
  return checker;
}

module.exports = {
  getChecker,
  ComicNewReleaseChecker
};
