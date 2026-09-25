/**
 * 夸克网盘爬虫
 * 功能：文件列表、搜索、下载、在线播放
 * 
 * API文档（逆向自QuarkPan项目）：
 * - 基础URL: https://drive-pc.quark.cn/1/clouddrive
 * - 必须参数: pr=ucpro&fr=pc&uc_param_str=&__t=时间戳&__dt=1000
 * - 文件列表: /file/sort
 * - 文件详情: /file/info
 * - 下载链接: /file/download
 * - 视频播放: /file/play
 * - 搜索: /file/search
 */

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('../config');

class QuarkCrawler {
  constructor(options = {}) {
    // 夸克 API 只存在于 drive-pc.quark.cn；配置里若填了网页域名（pan.quark.cn），
    // 拼出来的是网页路径，只会拿到 HTML 风控页 → 一律回落默认 API 域名
    const API_BASE = 'https://drive-pc.quark.cn/1/clouddrive';
    const rawBase = options.baseUrl || config.sources?.quark?.baseUrl;
    this.baseUrl = /drive-pc\.quark\.cn/.test(rawBase || '') ? rawBase : API_BASE;
    this.webUrl = options.webUrl || 'https://pan.quark.cn';
    this.cookie = options.cookie || config.sources?.quark?.cookie || '';
    this.loggedIn = !!this.cookie;
    // 夸克是国内站点，默认直连；要经代理时在 config 里设 sources.quark.useProxy=true。
    // （代理挂掉会造成"扫码登录成功、却一个文件都读不到"的假故障）
    this.proxy = config.sources?.quark?.useProxy ? config.network?.proxyServer : null;
    this.timeout = config.network?.timeout || 15000;
  }

  /**
   * 构建请求参数
   */
  _buildParams(params = {}) {
    return {
      pr: 'ucpro',
      fr: 'pc',
      uc_param_str: '',
      __t: Date.now().toString(),
      __dt: '1000',
      ...params
    };
  }

  /**
   * 构建请求头
   */
  _buildHeaders(extraHeaders = {}) {
    return {
      'Cookie': this.cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Safari/537.36 Core/1.94.225.400 QQBrowser/12.2.5544.400',
      'Referer': `${this.webUrl}/`,
      'Origin': this.webUrl,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json',
      ...extraHeaders
    };
  }

  /**
   * 发送GET请求
   */
  async _get(path, params = {}) {
    try {
      const urlParams = new URLSearchParams(this._buildParams(params));
      const url = `${this.baseUrl}${path}?${urlParams.toString()}`;
      
      const options = {
        method: 'GET',
        headers: this._buildHeaders()
      };
      
      if (this.proxy) {
        options.agent = new HttpsProxyAgent(this.proxy);
      }
      
      const response = await fetch(url, options);
      const text = await response.text();
      
      if (response.status === 401) {
        this.loggedIn = false;
        throw new Error('认证失败，请重新设置Cookie');
      }
      
      try {
        const json = JSON.parse(text);
        if (json.code && json.code !== 0) {
          throw new Error(json.message || 'API错误');
        }
        return json;
      } catch (e) {
        if (e.message.includes('API错误') || e.message.includes('认证失败')) {
          throw e;
        }
        throw new Error(`响应不是有效的JSON格式 (HTTP ${response.status}, 原文前120字符: ${text.slice(0,120).replace(/\s+/g, ' ')})`);
      }
    } catch (e) {
      console.log('[夸克网盘] 请求失败:', e.message);
      throw e;
    }
  }

  /**
   * 发送POST请求
   */
  async _post(path, data = {}, params = {}) {
    try {
      const urlParams = new URLSearchParams(this._buildParams(params));
      const url = `${this.baseUrl}${path}?${urlParams.toString()}`;
      
      const options = {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(data)
      };
      
      if (this.proxy) {
        options.agent = new HttpsProxyAgent(this.proxy);
      }
      
      const response = await fetch(url, options);
      const text = await response.text();
      
      if (response.status === 401) {
        this.loggedIn = false;
        throw new Error('认证失败，请重新设置Cookie');
      }
      
      try {
        const json = JSON.parse(text);
        if (json.code && json.code !== 0) {
          throw new Error(json.message || 'API错误');
        }
        return json;
      } catch (e) {
        if (e.message.includes('API错误') || e.message.includes('认证失败')) {
          throw e;
        }
        throw new Error(`响应不是有效的JSON格式 (HTTP ${response.status}, 原文前120字符: ${text.slice(0,120).replace(/\s+/g, ' ')})`);
      }
    } catch (e) {
      console.log('[夸克网盘] 请求失败:', e.message);
      throw e;
    }
  }

  /**
   * 设置 cookie
   */
  setCookie(cookie) {
    this.cookie = cookie;
    this.loggedIn = true;
  }

  /**
   * 检查登录状态
   */
  async checkLogin() {
    try {
      // 直接请求根目录文件列表来验证登录状态（getFileList 会吞掉异常，这里用 _get 以区分认证失败）
      const result = await this._get('/file/sort', {
        pdir_fid: '0',
        page: '1',
        page_size: '1',
        order: 'file_type',
        desc: 'false'
      });
      return !!(result && result.data && result.data.list);
    } catch (e) {
      this.loggedIn = false;
      return false;
    }
  }

  /**
   * 获取文件列表
   * @param {string} fid 文件夹ID，默认为0（根目录）
   * @param {number} page 页码
   * @param {number} pageSize 每页数量
   * @param {string} order 排序方式：file_type, file_name, size, updated_at
   * @param {boolean} desc 是否降序
   */
  async getFileList(fid = '0', page = 1, pageSize = 100, order = 'file_type', desc = false) {
    try {
      // 夸克真正的分页参数是 _page/_size（写 page/page_size 会被无视，只返回默认 10 条），
      // _fetch_total=1 才会把总数带回来
      const result = await this._get('/file/sort', {
        pdir_fid: fid,
        _page: page.toString(),
        _size: pageSize.toString(),
        _fetch_total: '1',
        _sort: `${order}:${desc ? 'desc' : 'asc'},updated_at:desc`
      });
      
      const list = result.data?.list || [];
      const total = Number(result.data?.total ?? result.metadata?._total ?? 0) || list.length;
      return {
        list,
        total,
        page,
        pageSize,
        hasMore: (page - 1) * pageSize + list.length < total
      };
    } catch (e) {
      console.log('[夸克网盘] 获取文件列表失败:', e.message);
      return { list: [], total: 0, page, pageSize, hasMore: false };
    }
  }

  /**
   * 搜索文件
   * @param {keyword} 搜索关键词
   * @param {number} page 页码
   * @param {number} pageSize 每页数量
   */
  async search(keyword, page = 1, pageSize = 50) {
    try {
      const result = await this._get('/file/search', {
        q: keyword,
        _page: page.toString(),
        _size: pageSize.toString(),
        _fetch_total: '1'
      });
      
      return {
        list: result.data?.list || [],
        total: result.data?.total || 0,
        page,
        pageSize,
        hasMore: result.data?.list?.length >= pageSize
      };
    } catch (e) {
      console.log('[夸克网盘] 搜索失败:', e.message);
      return { list: [], total: 0, page, pageSize, hasMore: false };
    }
  }

  /**
   * 获取文件详情
   * @param {string} fid 文件ID
   */
  async getFileDetail(fid) {
    try {
      const result = await this._get('/file/info', {
        fid
      });
      
      return result.data || null;
    } catch (e) {
      console.log('[夸克网盘] 获取文件详情失败:', e.message);
      return null;
    }
  }

  /**
   * 获取下载链接
   * @param {string} fid 文件ID
   */
  async getDownloadUrl(fid) {
    this.lastDownloadError = null;
    try {
      const result = await this._post('/file/download', 
        { fids: [fid] },
        {
          sys: 'win32',
          ve: '2.5.56',
          ut: '',
          guid: ''
        }
      );
      
      if (result && result.data && result.data.length > 0) {
        return result.data[0]?.download_url || null;
      }
      return null;
    } catch (e) {
      // 记下失败原因：非会员大文件会返回 "download file size limit"
      this.lastDownloadError = e.message;
      console.log('[夸克网盘] 获取下载链接失败:', e.message);
      return null;
    }
  }

  /**
   * 批量获取下载链接
   * @param {Array<string>} fids 文件ID列表
   */
  async getDownloadUrls(fids) {
    try {
      const result = await this._post('/file/download', 
        { fids },
        {
          sys: 'win32',
          ve: '2.5.56',
          ut: '',
          guid: ''
        }
      );
      
      const downloadUrls = {};
      if (result.data && result.data.length > 0) {
        for (const item of result.data) {
          if (item.fid && item.download_url) {
            downloadUrls[item.fid] = item.download_url;
          }
        }
      }
      return downloadUrls;
    } catch (e) {
      console.log('[夸克网盘] 批量获取下载链接失败:', e.message);
      return {};
    }
  }

  /**
   * 获取视频播放地址（夸克转码后的 m3u8）
   * 必须带 resolution，否则接口直接报 "Bad Parameter: resolution is empty"
   * @param {string} fid
   * @param {string} resolution low / normal / 720p ...
   */
  async getVideoUrl(fid, resolution = 'low') {
    try {
      const result = await this._get('/file/play', {
        fid,
        resolution,
        support_types: '1,2,3,4,5'
      });

      const list = (result.data && result.data.video_list) || [];
      return (list[0] && list[0].url) || null;
    } catch (e) {
      console.log('[夸克网盘] 获取视频地址失败:', e.message);
      return null;
    }
  }

  /**
   * 统一的"能播/能读地址"入口
   * 优先直链；非会员超过约 50MB 拿不到直链，视频退回转码 m3u8
   * @returns {Promise<{url:string, kind:'direct'|'hls'}|null>}
   */
  async getStreamUrl(fid, { isVideo = false } = {}) {
    const direct = await this.getDownloadUrl(fid);
    if (direct) return { url: direct, kind: 'direct' };

    if (isVideo) {
      const hls = await this.getVideoUrl(fid);
      if (hls) return { url: hls, kind: 'hls' };
    }
    return null;
  }

  /**
   * 获取分类文件（漫画、小说、视频等）
   * @param {string} category 分类：comic, novel, video, anime
   * @param {number} page 页码
   * @param {number} pageSize 每页数量
   */
  async getFilesByCategory(category, page = 1, pageSize = 50) {
    try {
      // 根据分类搜索对应类型的文件
      const keywords = {
        'comic': ['漫画', 'epub', 'mobi', 'pdf', 'cbz', 'cbr'],
        'novel': ['小说', 'txt', 'epub', 'pdf', 'mobi'],
        'video': ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv'],
        'anime': ['动漫', '动画', 'mp4', 'mkv']
      };
      
      const keywordList = keywords[category] || [];
      let allResults = [];
      
      for (const keyword of keywordList) {
        const results = await this.search(keyword, page, pageSize);
        allResults = allResults.concat(results.list || []);
      }
      
      // 去重
      const seen = new Set();
      const uniqueResults = allResults.filter(item => {
        if (seen.has(item.fid)) return false;
        seen.add(item.fid);
        return true;
      });
      
      return {
        list: uniqueResults,
        total: uniqueResults.length,
        page,
        pageSize,
        hasMore: false
      };
    } catch (e) {
      console.log('[夸克网盘] 获取分类文件失败:', e.message);
      return { list: [], total: 0, page, pageSize, hasMore: false };
    }
  }

  /**
   * 获取存储空间信息
   */
  async getStorageInfo() {
    try {
      const result = await this._get('/capacity');
      return result.data || null;
    } catch (e) {
      console.log('[夸克网盘] 获取存储空间信息失败:', e.message);
      return null;
    }
  }

  /**
   * 创建文件夹
   * @param {string} name 文件夹名称
   * @param {string} parentId 父文件夹ID
   */
  async createFolder(name, parentId = '0') {
    try {
      const result = await this._post('/file/create', {
        file_name: name,
        pdir_fid: parentId,
        dir: true
      });
      
      return result.data || null;
    } catch (e) {
      console.log('[夸克网盘] 创建文件夹失败:', e.message);
      return null;
    }
  }

  /**
   * 删除文件
   * @param {Array<string>} fids 文件ID列表
   */
  async deleteFiles(fids) {
    try {
      const result = await this._post('/file/delete', {
        fids
      });
      
      return result.data || null;
    } catch (e) {
      console.log('[夸克网盘] 删除文件失败:', e.message);
      return null;
    }
  }

  /**
   * 重命名文件
   * @param {string} fid 文件ID
   * @param {string} name 新名称
   */
  async renameFile(fid, name) {
    try {
      const result = await this._post('/file/rename', {
        fid,
        file_name: name
      });
      
      return result.data || null;
    } catch (e) {
      console.log('[夸克网盘] 重命名文件失败:', e.message);
      return null;
    }
  }

  /**
   * 移动文件
   * @param {Array<string>} fids 文件ID列表
   * @param {string} targetFid 目标文件夹ID
   */
  async moveFiles(fids, targetFid) {
    try {
      const result = await this._post('/file/move', {
        fids,
        to_pdir_fid: targetFid
      });
      
      return result.data || null;
    } catch (e) {
      console.log('[夸克网盘] 移动文件失败:', e.message);
      return null;
    }
  }
}

module.exports = QuarkCrawler;
