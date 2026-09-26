/**
 * Kmoe (KOOBONE) 漫画爬虫
 * 网站：kzo.moe / kxx.moe / kzz.moe / koz.moe
 * 功能：搜索、详情、章节、下载、在线阅读
 */

const Request = require('./base').Request;
const config = require('../config');

class KmoeCrawler {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://kzo.moe';
    this.cookie = options.cookie || '';
    this.loggedIn = false;

    // 镜像列表：kzo/kxx/kzz/koz 是同一套站点的多个入口，
    // 实测会偶发「Client network socket disconnected before secure TLS」，
    // 单挂一个域名会让整轮扫描卡死，所以保留备选做失败转移。
    const mirrors = options.mirrors || ['https://kzo.moe', 'https://kxx.moe', 'https://kzz.moe', 'https://koz.moe'];
    this.mirrors = [...new Set([this.baseUrl, ...mirrors])];

    this.request = new Request({
      baseUrl: this.baseUrl,
      proxy: config.network?.proxyServer,
      timeout: config.network?.timeout || 15000,
      retryCount: config.network?.retryCount || 2
    });
    
    // 如果有cookie，直接设置
    if (this.cookie) {
      this.setCookie(this.cookie);
      this.loggedIn = true;
    }
  }

  /**
   * 换一个镜像重试。返回是否成功切换。
   * 只在调用方明确遇到网络层错误时用，避免无谓地打乱已有会话。
   */
  switchMirror() {
    const idx = this.mirrors.indexOf(this.baseUrl);
    const next = this.mirrors[(idx + 1) % this.mirrors.length];
    if (!next || next === this.baseUrl) return false;
    console.log(`[Kmoe] 镜像切换 ${this.baseUrl} -> ${next}`);
    this.baseUrl = next;
    this.request.baseUrl = next;
    // 换了域名，会话 cookie 需要重新拿
    this.loggedIn = false;
    this._loginAttempted = false;
    return true;
  }

  /** 判断是否是网络层错误（值得换镜像重试），而不是业务错误 */
  _isNetworkError(e) {
    const m = String(e && e.message || '');
    return /TLS|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|aborted/i.test(m);
  }

  /**
   * 设置Cookie
   */
  setCookie(cookieStr) {
    // 解析cookie字符串
    const cookies = {};
    cookieStr.split(';').forEach(pair => {
      const [key, ...valueParts] = pair.trim().split('=');
      if (key) {
        cookies[key.trim()] = valueParts.join('=');
      }
    });
    this.request.cookies = cookies;
    this.loggedIn = true;
    console.log('[Kmoe] Cookie已设置');
  }

  /**
   * 登录（使用邮箱密码）
   */
  async login(username, password) {
    try {
      if (!username || !password) {
        console.log('[Kmoe] 登录失败：缺少账号或密码');
        return false;
      }
      const url = `${this.baseUrl}/login_act.php`;

      const formData = {
        email: username,
        passwd: password
      };

      // postHtml 返回的是 cheerio 的 $ 对象（不是字符串！），
      // 之前直接对它调 .includes() 会抛
      // "result.includes is not a function"，登录永远失败且看不出原因。
      const raw = await this.request.postHtml(url, formData);
      const html = typeof raw === 'string'
        ? raw
        : (typeof raw?.html === 'function' ? raw.html() : String(raw ?? ''));

      // ⚠️ 站点把 JSON 包在 HTML 壳里返回：
      //   `<html><head></head><body>{"ret":1,"msg":"登錄成功。"}</body></html>`
      // 直接 JSON.parse 会失败 → 必须先剥掉标签再解析。
      const stripped = html.replace(/<[^>]*>/g, '').trim();

      // 1) 解析 JSON（优先用剥标签后的文本，退回原文）
      for (const candidate of [stripped, html]) {
        try {
          const json = JSON.parse(candidate);
          if (Number(json.ret) === 1) {
            this.loggedIn = true;
            console.log('[Kmoe] 登录成功:', json.msg || '');
            return true;
          }
          console.log('[Kmoe] 登录失败:', json.msg || JSON.stringify(json).slice(0, 120));
          return false;
        } catch (e) { /* 换下一个候选 */ }
      }

      // 2) 非 JSON：可能直接跳转了（登录态由 cookie 承载）
      if (/登錄成功|登录成功|主頁|mycomic|登出/.test(html)) {
        this.loggedIn = true;
        console.log('[Kmoe] 登录成功（跳转式响应）');
        return true;
      }
      console.log('[Kmoe] 登录失败：响应不是预期格式（可能是密码错误或站点改版）');
      return false;
    } catch (e) {
      console.log('[Kmoe] 登录失败:', e.message);
      return false;
    }
  }

  /**
   * 检查登录状态
   */
  async checkLogin() {
    try {
      const res = await this.request.get(this.baseUrl + '/');
      const html = await res.text();
      // 检查是否有个人主页链接（登录后才有）
      if (html.includes('/u/') && html.includes('主頁')) {
        this.loggedIn = true;
        return true;
      }
      this.loggedIn = false;
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * 搜索漫画
   * 站点已改为 /list.php?s=关键词 形式（旧的 /l/关键词,.../ 仍兼容但依赖登录态）
   */
  async search(keyword, page = 1) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 新格式：/list.php?s=关键词&page=页码
        const searchUrl = `${this.baseUrl}/list.php?s=${encodeURIComponent(keyword)}&page=${page}`;
        const results = await this._parseListPage(searchUrl);

        // 若新格式被登录墙拦截或为空，降级尝试旧格式
        if (results.length === 0) {
          const oldUrl = `${this.baseUrl}/l/${encodeURIComponent(keyword)},all,all,sortpoint,all,all,BL,${(page - 1) * 40},0/`;
          const oldResults = await this._parseListPage(oldUrl);
          if (oldResults.length > 0) return oldResults;
        }

        return results;
      } catch (e) {
        // 网络层错误（TLS 断连等）：换镜像再试一次，避免整轮扫描卡在单个域名上
        if (attempt === 0 && this._isNetworkError(e)) {
          if (this.switchMirror()) continue;
        }
        console.log('[Kmoe] 搜索失败:', e.message);
        return [];
      }
    }
    return [];
  }

  /**
   * 获取漫画详情
   */
  async getDetail(url) {
    try {
      const fullUrl = url.startsWith('http') ? url : this.baseUrl + url;
      const $ = await this.request.getHtml(fullUrl);

      const detail = {
        url: fullUrl,
        source: 'kmoe',
        chapters: []
      };

      // 标题：优先 h1，其次 meta name="og:title" / keywords 首段
      detail.title = $('h1').first().text().trim() ||
                     $('meta[name="og:title"]').attr('content') ||
                     $('meta[property="og:title"]').attr('content') || '';
      if (!detail.title) {
        const keywords = $('meta[name="keywords"]').attr('content') || '';
        detail.title = keywords.split(',')[0]?.trim() || '';
      }
      if (detail.title) detail.title = detail.title.replace(/\[.*?\]\s*$/g, '').replace(/\[kzo\.moe\]$/i, '').trim();

      // 封面：优先 meta name="og:image" / property="og:image"，其次旧选择器，最后取第一个 kmimg 封面图
      let cover = $('meta[name="og:image"]').attr('content') ||
                  $('meta[property="og:image"]').attr('content') || '';
      if (!cover) cover = $('img[alt*="封面"], img.book_cover').first().attr('src') || '';
      if (!cover) {
        $('img').each((i, el) => {
          const s = $(el).attr('src') || '';
          if (s.includes('kmimg.moex.ink/cover') || s.includes('cover/')) {
            cover = s;
            return false;
          }
        });
      }
      detail.cover = cover || '';
      if (detail.cover && !detail.cover.startsWith('http')) {
        detail.cover = this.baseUrl + detail.cover;
      }

      // 作者：优先 meta name="keywords" 第二段，其次旧选择器
      const keywords = $('meta[name="keywords"]').attr('content') || '';
      const kwParts = keywords.split(',').map(s => s.trim()).filter(Boolean);
      const authorFromMeta = kwParts.length >= 2 ? kwParts[1] : '';
      const authorMatch = $('td:contains("作者")').next().text().trim();
      detail.author = authorMatch || authorFromMeta;

      // 状态
      const statusMatch = $('td:contains("状态")').next().text().trim();
      if (statusMatch) detail.status = statusMatch;

      // 分类
      const categoryMatch = $('td:contains("分类")').next().text().trim();
      if (categoryMatch) detail.category = categoryMatch;

      // 简介
      const introMatch = $('td:contains("简介")').next().text().trim();
      if (introMatch) detail.intro = introMatch;

      // 评分
      const scoreMatch = $('font[color*="red"] b').first().text().trim();
      if (scoreMatch) detail.score = scoreMatch;

      // 章节列表
      $('a[href*="/read/"], a[href*="/down/"]').each((i, el) => {
        const $el = $(el);
        const chapterTitle = $el.text().trim();
        const chapterUrl = $el.attr('href') || '';

        if (chapterTitle && chapterUrl) {
          detail.chapters.push({
            title: chapterTitle,
            url: chapterUrl.startsWith('http') ? chapterUrl : this.baseUrl + chapterUrl,
            type: chapterUrl.includes('/down/') ? 'download' : 'read'
          });
        }
      });

      return detail;
    } catch (e) {
      console.log('[Kmoe] 获取详情失败:', e.message);
      return null;
    }
  }

  /**
   * 获取漫画的卷（volume）列表 —— 新作监视靠这个判断「最新一卷」。
   *
   * 站点结构说明（实测）：
   *  - 搜索/列表页给的是 `https://kzo.moe/c/{bid}.htm`，但那只是书架入口，
   *    里面没有章节 DOM；真正带卷列表的公开页是 `https://bookof.moe/b/{bid}.htm`。
   *  - b 页里的卷列表不是一个静态表格，而是由 JS 请求
   *    `https://bookof.moe/data_vol.php?h=<token>` 拿到的，
   *    h token 每次访问 b 页都会变（形如 `1790056537VX20798112351542f2de6`），
   *    必须现取现用。
   *  - data_vol.php 的返回是一串 `<script>parent.postMessage("...")</script>`，
   *    其中：
   *      `datacount-V={总数},{已出版},{其他}`   卷数汇总
   *      `datainfo-V={seq},{类型},{卷名},{?},{大图},{小图}`  单卷信息
   *    另外它的 HTML 里会直接漏出 SQL（`SELECT * FROM volumeinfo ...`），
   *    对我们无影响，但解析时要忽略。
   *
   * 注意：卷数完全可能是 0（例如站上「日月同錯」就是 0 卷）。
   * 那是站点真的没有上传，不是解析失败 —— 调用方要能区分。
   *
   * @param {string|number} comicIdOrUrl  漫画 id 或 kzo/bookof 详情页 URL
   * @returns {Promise<{total:number, published:number, volumes:Array<{seq:number,name:string,cover:string}>, latest:string, error?:string}>}
   */
  async getVolumes(comicIdOrUrl) {
    const empty = { total: 0, published: 0, volumes: [], cover: '', latest: '', latestSeq: 0 };
    try {
      // 归一化出 bookid
      let bid = '';
      const s = String(comicIdOrUrl || '').trim();
      if (/^\d+$/.test(s)) bid = s;
      else {
        const m = s.match(/\/c\/([A-Za-z0-9]+)\.htm/) || s.match(/\/b\/([A-Za-z0-9]+)\.htm/);
        if (m) bid = m[1];
      }
      if (!bid) return { ...empty, error: 'no-bookid' };

      // 先确保登录态（data_vol.php 需要会话）
      if (!this.loggedIn) await this.ensureLogin();

      // bookof.moe 才是带卷列表的公开页；kzo 的 c 页只是入口
      const bUrl = `https://bookof.moe/b/${bid}.htm`;
      const res = await this.request.get(bUrl);
      let html = await res.text();

      // Cookie 过期时会掉到登录墙，重登一次再试
      if (this._isLoginWall(html)) {
        const ok = await this.ensureLogin();
        if (ok) {
          const res2 = await this.request.get(bUrl);
          html = await res2.text();
        }
      }

      // 抓 h token（V 前缀的那个才是「卷」列表，C 是收藏）
      const tokens = [...new Set(
        [...html.matchAll(/data_vol\.php\?h=([A-Za-z0-9]+)/g)].map(m => m[1])
      )];
      const volToken = tokens.find(t => /VX|V(?=[A-Z]?\d)/.test(t)) ||
                       tokens.find(t => t.includes('VX')) || tokens[0];

      // ★ 封面签名是「按 URL + 会话」签的，data_vol.php 里那批 sign 拿到手就过期
      //   （直连一律 403 "Request Sign Error"）。
      //   但 b 页 HTML 里现成带的图片 URL 是**当前会话刚签好的**，直接抓它才下载得动。
      //   优先取 series 封面（!cover_l 大图），其次背景图。
      let seriesCover = '';
      const bImgs = [...html.matchAll(/https:\/\/kmimg\.[^"'\s)]+/g)].map(m => m[0]);
      seriesCover = bImgs.find(u => u.includes('!cover_l')) ||
                    bImgs.find(u => u.includes('!bgimg')) ||
                    bImgs.find(u => u.includes('!cover')) ||
                    '';

      if (!volToken) {
        // b 页没有 data_vol 引用：可能这本书没有卷，或页面形态变了
        return { ...empty, cover: seriesCover, error: 'no-vol-token' };
      }

      const dRes = await this.request.get(`https://bookof.moe/data_vol.php?h=${volToken}`);
      const dHtml = await dRes.text();

      // 卷数汇总：datacount-V=总数,已出版,其他
      let total = 0, published = 0;
      const cntM = dHtml.match(/datacount-V=(\d+),(\d+),(\d+)/);
      if (cntM) {
        total = Number(cntM[1]) || 0;
        published = Number(cntM[2]) || 0;
      }

      // 单卷：datainfo-V=seq,类型,卷名,?,大图,小图
      // 卷名里不会出现逗号（站点用的是「卷 01」这种），所以按逗号切 6 段是安全的；
      // 但为了稳一点，用带引号的整体匹配 + 手动切分尾部两段 URL。
      // 注意：这里的图片 URL 签名已经过期，下载会 403，所以只留作兜底，
      // 真正给前端用的一律换成 b 页现取的 seriesCover。
      const volumes = [];
      const infoRe = /datainfo-V=([^"]+?)"\s*,\s*"\*"\s*\)/g;
      let m;
      while ((m = infoRe.exec(dHtml)) !== null) {
        const parts = m[1].split(',');
        if (parts.length < 6) continue;
        const seq = Number(parts[0]) || 0;
        const name = String(parts[2] || '').trim();
        // 末尾两段是图片 URL（URL 里不含逗号，取最后两段即可）
        const coverSmall = parts[parts.length - 1].trim();
        const coverLarge = parts[parts.length - 2].trim();
        volumes.push({
          seq,
          name: name || `卷 ${String(seq).padStart(2, '0')}`,
          cover: seriesCover || coverSmall || coverLarge || ''
        });
      }
      // 按 seq 升序，便于取最大卷
      volumes.sort((a, b) => a.seq - b.seq);
      const latestVol = volumes.length ? volumes[volumes.length - 1] : null;

      return {
        total: total || volumes.length,
        published,
        volumes,
        cover: seriesCover,          // b 页现取的、签名有效的封面
        latest: latestVol ? latestVol.name : '',
        latestSeq: latestVol ? Number(latestVol.seq) : 0
      };
    } catch (e) {
      console.log('[Kmoe] 获取卷列表失败:', e.message);
      return { ...empty, error: e.message };
    }
  }

  /**
   * 获取热门漫画
   */
  async getHot(page = 1) {
    try {
      // 热度排序
      const url = `${this.baseUrl}/l/all,all,all,count_push,all,all,BL,${(page - 1) * 40},0/`;
      return await this._parseListPage(url);
    } catch (e) {
      console.log('[Kmoe] 获取热门失败:', e.message);
      return [];
    }
  }

  /**
   * 获取最新更新
   */
  async getLatest(page = 1) {
    try {
      // 最近更新
      const url = `${this.baseUrl}/l/all,all,all,lastupdate,all,all,BL,${(page - 1) * 40},0/`;
      return await this._parseListPage(url);
    } catch (e) {
      console.log('[Kmoe] 获取最新更新失败:', e.message);
      return [];
    }
  }

  /**
   * 获取分类列表
   */
  async getCategories() {
    try {
      const categories = [
        { name: '全部', value: 'all' },
        { name: '幽默', value: 'CAT*幽默' },
        { name: '愛情', value: 'CAT*愛情' },
        { name: '競技', value: 'CAT*競技' },
        { name: '熱血', value: 'CAT*熱血' },
        { name: '格鬥', value: 'CAT*格鬥' },
        { name: '冒險', value: 'CAT*冒險' },
        { name: '恐怖', value: 'CAT*恐怖' },
        { name: '生存', value: 'CAT*生存' },
        { name: '懸疑', value: 'CAT*懸疑' },
        { name: '偵探', value: 'CAT*偵探' },
        { name: '歷史', value: 'CAT*歷史' },
        { name: '戰爭', value: 'CAT*戰爭' },
        { name: '生活', value: 'CAT*生活' },
        { name: '勵志', value: 'CAT*勵志' },
        { name: '校園', value: 'CAT*校園' },
        { name: '職場', value: 'CAT*職場' },
        { name: '美食', value: 'CAT*美食' },
        { name: '音樂舞蹈', value: 'CAT*音樂' },
        { name: '機戰', value: 'CAT*機戰' },
        { name: '科幻', value: 'CAT*科幻' },
        { name: '魔幻', value: 'CAT*魔幻' },
        { name: '魔法', value: 'CAT*魔法' },
        { name: '奇幻', value: 'CAT*奇幻' },
        { name: '神鬼', value: 'CAT*神鬼' },
        { name: '武俠', value: 'CAT*武俠' },
        { name: '仙俠', value: 'CAT*仙俠' },
        { name: '治癒', value: 'CAT*治癒' },
        { name: '萌系', value: 'CAT*萌系' },
        { name: '宅系', value: 'CAT*宅系' },
        { name: '青年', value: 'CAT*青年' },
        { name: '少年', value: 'CAT*少年' },
        { name: '少女', value: 'CAT*少女' },
        { name: '後宮', value: 'CAT*後宮' },
        { name: '百合', value: 'CAT*百合' },
        { name: '偽娘', value: 'CAT*偽娘' },
        { name: '性轉換', value: 'CAT*性轉' },
        { name: 'TL', value: 'CAT*青戀' },
        { name: '耽美', value: 'CAT*耽美' },
        { name: '轉生', value: 'CAT*轉生' },
        { name: '穿越', value: 'CAT*穿越' },
        { name: '童話', value: 'CAT*童話' },
        { name: '東方', value: 'CAT*東方' },
        { name: '四格', value: 'CAT*四格' },
        { name: '繪本', value: 'CAT*繪本' },
        { name: '藝術', value: 'CAT*藝術' },
        { name: '雜誌', value: 'CAT*雜誌' },
        { name: '輕小說改編', value: 'CAT*輕改' },
        { name: '連環畫', value: 'CAT*連環畫' }
      ];
      
      return categories;
    } catch (e) {
      return [];
    }
  }

  /**
   * 按分类获取漫画
   */
  async getByCategory(category, page = 1) {
    try {
      const url = `${this.baseUrl}/l/${category},all,all,sortpoint,all,all,BL,${(page - 1) * 40},0/`;
      return await this._parseListPage(url);
    } catch (e) {
      console.log('[Kmoe] 按分类获取失败:', e.message);
      return [];
    }
  }

  /**
   * 解析列表页
   */
  async _parseListPage(url) {
    try {
      // 获取原始HTML
      const res = await this.request.get(url);
      const html = await res.text();

      // 检测登录墙：页面是登录表单则无结果。
      // 此时用配置里的账号密码自动重登一次（cookie 会过期，但密码长期有效），
      // 重登成功后让调用方重试 —— 否则每个请求都要人工去设置页贴 Cookie。
      if (this._isLoginWall(html)) {
        const relogged = await this.ensureLogin();
        if (relogged) {
          console.log('[Kmoe] Cookie 已过期，已用账号密码自动重登，本次请求重试');
          const res2 = await this.request.get(url);
          const html2 = await res2.text();
          if (!this._isLoginWall(html2)) return this._extractFromHtml(html2);
        }
        console.log('[Kmoe] ⚠️ 需要登录，Cookie无效且自动重登失败，请到设置页更新Kmoe账号密码');
        return [];
      }

      return this._extractFromHtml(html);
    } catch (e) {
      console.log('[Kmoe] 解析列表页失败:', e.message);
      return [];
    }
  }

  /** 判断页面是否是登录墙 */
  _isLoginWall(html) {
    return typeof html === 'string' && html.includes('Kmoe 登錄') && !html.includes('disp_divinfo');
  }

  /**
   * 保证处于登录态：cookie 失效时用账号密码兜底重登。
   * 有 `_loginAttempted` 防止一个进程内反复登录被打风控。
   */
  async ensureLogin() {
    const cfg = config.sources?.kmoe || {};
    if (!cfg.username || !cfg.password) return false;
    if (this._loginAttempted) return false;
    this._loginAttempted = true;
    const ok = await this.login(cfg.username, cfg.password);
    if (!ok) this._loginAttempted = false;   // 失败了允许下次再试
    return ok;
  }

  /** 从列表页 HTML 里抽漫画条目 */
  _extractFromHtml(html) {
    const results = [];

    try {
      // 用正则表达式匹配 disp_divinfo 调用
      // disp_divinfo( "div_info_"+"1", "url", "cover", "color", "tag_jp", "tag_en", "tag_end", "tag_brk", "score", "name", "author", "status", "update" )
      const regex = /disp_divinfo\(\s*[^,]+,\s*["']([^"']+)["'],\s*["']([^"']+)["'],\s*[^,]+,\s*["']([^"']*)["'],\s*["']([^"']*)["'],\s*["']([^"']*)["'],\s*["']([^"']*)["'],\s*["']([^"']*)["'],\s*["']([^"']+)["'],\s*["']([^"']+)["'],\s*["']([^"']*)["'],\s*["']([^"']*)["']\s*\)/g;
      
      let match;
      while ((match = regex.exec(html)) !== null) {
        const bookUrl = match[1];
        const coverUrl = match[2];
        const tagJp = match[3];
        const tagEn = match[4];
        const tagEnd = match[5];
        const tagBrk = match[6];
        const score = match[7];
        const bookName = match[8];
        const bookAuthor = match[9];
        const wordStatus = match[10];
        const wordUpdate = match[11];
        
        if (bookName && bookUrl) {
          // 去掉标题里的HTML标签
          const cleanTitle = bookName.replace(/<[^>]+>/g, '').trim();
          
          // 判断状态
          let status = '连载中';
          if (tagEnd === '' || tagEnd === 'none') {
            status = '已完结';
          }
          
          // 判断语言
          let language = '中文';
          if (tagJp !== 'none') {
            language = '日语';
          } else if (tagEn !== 'none') {
            language = '英语';
          }
          
          results.push({
            title: cleanTitle,
            cover: coverUrl,
            url: bookUrl,
            author: bookAuthor,
            status: wordStatus,
            score: score,
            language: language,
            updateTime: wordUpdate,
            source: 'kmoe'
          });
        }
      }
      
      return results;
    } catch (e) {
      console.log('[Kmoe] 解析条目失败:', e.message);
      return results;
    }
  }

  /**
   * 获取章节图片列表（在线阅读）
   */
  async getChapterImages(chapterUrl) {
    try {
      const fullUrl = chapterUrl.startsWith('http') ? chapterUrl : this.baseUrl + chapterUrl;
      const $ = await this.request.getHtml(fullUrl);
      
      const images = [];
      
      // 查找所有图片
      $('img.comic_img, img.read_img, #images img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (src) {
          images.push(src.startsWith('http') ? src : this.baseUrl + src);
        }
      });
      
      // 如果没找到，尝试从JS里提取
      if (images.length === 0) {
        const scriptText = $('script').text();
        const imgRegex = /["']([^"']*?\.(jpg|jpeg|png|gif|webp)["'])/gi;
        let match;
        while ((match = imgRegex.exec(scriptText)) !== null) {
          let imgUrl = match[1].replace(/["']/g, '');
          if (imgUrl.includes('comic') || imgUrl.includes('manga')) {
            images.push(imgUrl.startsWith('http') ? imgUrl : this.baseUrl + imgUrl);
          }
        }
      }
      
      return images;
    } catch (e) {
      console.log('[Kmoe] 获取章节图片失败:', e.message);
      return [];
    }
  }

  /**
   * 获取下载链接
   */
  async getDownloadUrl(comicUrl) {
    try {
      const detail = await this.getDetail(comicUrl);
      if (!detail || !detail.chapters) return null;
      
      // 找下载链接
      const downloadChapter = detail.chapters.find(c => c.type === 'download');
      if (downloadChapter) {
        return downloadChapter.url;
      }
      
      return null;
    } catch (e) {
      console.log('[Kmoe] 获取下载链接失败:', e.message);
      return null;
    }
  }
}

module.exports = KmoeCrawler;
