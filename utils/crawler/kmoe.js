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

    // round112：把「这次请求到底是登录墙还是真的搜不到」暴露给调用方。
    // 旧实现两种都返回 []，扫描器无法判断源是否可用，只能每个文件都重试一遍
    // （实测每个文件烧 3~100 秒，几千个文件等于永远扫不完）。
    this.loginWall = false;
    this.lastError = '';

    // 镜像列表：kzo/kxx/kzz/koz 是同一套站点的多个入口，
    // 实测会偶发「Client network socket disconnected before secure TLS」，
    // 单挂一个域名会让整轮扫描卡死，所以保留备选做失败转移。
    const mirrors = options.mirrors || ['https://kzo.moe', 'https://kxx.moe', 'https://kzz.moe', 'https://koz.moe'];
    this.mirrors = [...new Set([this.baseUrl, ...mirrors])];

    this.request = new Request({
      baseUrl: this.baseUrl,
      // ★ kmoe 默认直连，不走全局代理：站点按 IP 绑定会话（实测同一 cookie
      //   直连是登录态、走 clash 代理出口就是匿名页），且 kzo.moe 国内可直连。
      //   确有需要时在 config.sources.kmoe.proxy 里显式指定代理。
      proxy: options.proxy !== undefined ? options.proxy : (config.sources?.kmoe?.proxy || null),
      timeout: config.network?.timeout || 15000,
      // round112：这里以前写的是 retryCount（Request 不认这个键），于是永远走
      // base.js 的默认 3 次重试 —— 站点不通时单次搜索要烧 3×10s。改成正确的 retry。
      retry: options.retry || config.network?.retryCount || 2
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
    // round112：错误状态以「一次 search」为单位累积。
    // 早期实现把重置写在 _parseListPage 开头 —— 新格式 URL 超时失败、旧格式 URL
    // 成功但 0 结果，结果一进门就把上一次的 lastError 冲掉了，扫描器看到的永远是
    // 「源是好的，只是没搜到」，熔断器根本不跳，于是每个文件都要白烧 33 秒。
    this.loginWall = false;
    this.lastError = '';
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
        this.loginWall = true;      // round112：让调用方可以熔断，而不是逐个文件重撞
        return [];
      }

      return this._extractFromHtml(html);
    } catch (e) {
      console.log('[Kmoe] 解析列表页失败:', e.message);
      this.lastError = (e && e.message) || String(e);
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

  // ==================================================================
  // round102：KOOB.ONE（koobone.com）在线阅读
  //
  // 【为什么是「换票」而不是「另登录一次」】
  //   站群同一套账号：kzo.moe 是下载站，koobone.com 才是官方在线阅读器
  //   （书页上那个「KOOBONE 在線漫畫閱讀器」链接就是 /authlogin_do.php?j=1&s=112）。
  //   点它会 302 到 `koobone.com/moeauth.php?ret=0&t=..&u=..&n=..&k=..&ka=0`，
  //   跟着走完这条链，koobone 侧就下发 VLIBSID（在线阅读会话）。
  //   ⇒ 只要配置里有 kzo.moe 的 cookie，就能零密码拿到 koobone 会话。
  //
  // 【数据从哪来（实测）】
  //   · 书库列表  GET https://koobone.com/vol_list.php?p=<页>&s=<关键词>
  //       → {"uin":11235154,"total":47,"nowpage":1,"totalpage":3,"data":[{...}]}
  //   · 每卷字段里有两个关键项：
  //       vol_seriesid = "KMOE:<kzo 的 bookid>"  ← 用它反查「这本漫画对应哪几卷」
  //       file_url     = https://dlN.koobone.com/dl.php?file=<md5>.epub&sign=..&time=..
  //                      ↑ 带签名的 EPUB 直链，支持 Range（实测 206），**不需要 cookie**
  //   ⇒ 所以「在线阅读」= 按 bookid 找到卷 → 拿 file_url → 拉 EPUB → 应用内 EPUB 阅读器渲染。
  // ==================================================================

  /** 从响应里收集 Set-Cookie（★ 必须用 getSetCookie 逐条取：
   *   headers.get('set-cookie') 只给第一条，且 Expires 里的逗号会把 naive split(',') 切碎，
   *   实测那样拼出来的 Cookie 头是 `tgw_l7_route=..; 11-Oct-2026 09:28:25 GMT; Path=/`
   *   —— VLIBSID 直接丢了，书库接口只会返回 uin:0） */
  _kbCollectCookies(res, jar) {
    let list = [];
    try { list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; } catch (e) { list = []; }
    if (!list || !list.length) {
      const one = res.headers.get('set-cookie');
      if (one) list = [one];
    }
    for (const raw of list) {
      const m = String(raw).match(/^\s*([^=;\s]+)=([^;]*)/);
      if (m) jar[m[1]] = m[2];
    }
    return jar;
  }

  /** koobone 直连 fetch（带重试）——实测 connect timeout 偶发，
   *  undici 默认连接超时 10s，一次失败不该让整个在线阅读功能不可用 */
  async _kbFetch(url, headers, tries = 3) {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        return await fetch(url, { headers, redirect: 'manual' });
      } catch (e) {
        lastErr = e;
        console.log(`[Kmoe/KOOBONE] 直连失败 第${i + 1}/${tries}次:`,
          e.cause ? e.cause.message : e.message);
        if (i < tries - 1) await new Promise(r => setTimeout(r, 900 * (i + 1)));
      }
    }
    throw lastErr;
  }

  /**
   * 换取并缓存 KOOB.ONE 在线阅读会话。
   * @param {boolean} force 忽略缓存重换
   * @returns {Promise<{uin:string,cookie:string,ts:number}|null>} 失败返回 null（原因见 this.kooboneError）
   */
  async kooboneSession(force = false) {
    const TTL = 15 * 60 * 1000;   // 换票链每次都新开一个会话，15 分钟内复用足够
    if (!force && this._kbSession && Date.now() - this._kbSession.ts < TTL) return this._kbSession;

    this.kooboneError = '';
    const kmoeCookie = Object.entries(this.request.cookies || {})
      .map(([k, v]) => `${k}=${v}`).join('; ');
    if (!kmoeCookie) {
      this.kooboneError = '未配置 Kmoe Cookie';
      return null;
    }
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

    // ① 用 kzo 登录态换一次性 ticket（不跟跳转，直接读 Location）
    let loc = '';
    try {
      const r = await this._kbFetch('https://kzo.moe/authlogin_do.php?j=1&s=112',
        { Cookie: kmoeCookie, 'User-Agent': UA, Referer: 'https://kzo.moe/' });
      this._kbCollectCookies(r, this.request.cookies);   // 站点会顺带刷新 VOLSESS
      loc = r.headers.get('location') || '';
    } catch (e) {
      this.kooboneError = '换取 KOOB.ONE 阅读凭证失败：' + e.message;
      console.log('[Kmoe/KOOBONE] 换票失败:', e.message, e.cause ? ('| ' + e.cause.message) : '');
      return null;
    }
    if (!/koobone\.com\/moeauth\.php/i.test(loc)) {
      // ret != 0 或直接回登录页 = kzo 登录态已失效（cookie 过期）
      this.kooboneError = 'Kmoe 登录状态已失效，请在「设置 → 授权Cookie → KOOB.ONE」重新填入 Cookie';
      return null;
    }

    // ② 跟着换票链走一圈，把 koobone 侧下发的 cookie 收进独立会话
    // ★ 必须**手动**逐跳跟：undici 的 fetch 没有 cookie 罐，redirect:'follow' 时
    //   中间那次 302 上的 Set-Cookie（VLIBSID 就在这里）根本拿不到，只剩最后一跳的头。
    const jar = {};
    try {
      let cur = loc;
      for (let hop = 0; hop < 5 && cur; hop++) {
        const hdrs = { 'User-Agent': UA, Referer: 'https://koobone.com/' };
        const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        if (ck) hdrs.Cookie = ck;
        const r = await this._kbFetch(cur, hdrs);
        this._kbCollectCookies(r, jar);
        await r.text().catch(() => '');
        if (r.status >= 300 && r.status < 400) {
          const nx = r.headers.get('location');
          if (!nx) break;
          cur = new URL(nx, cur).toString();
        } else break;
      }
    } catch (e) {
      this.kooboneError = '登录 KOOB.ONE 阅读器失败：' + e.message;
      console.log('[Kmoe/KOOBONE] 换票链失败:', e.message, e.cause ? ('| ' + e.cause.message) : '', '| hop=', loc);
      return null;
    }
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (!jar.VLIBSID) {
      this.kooboneError = 'KOOB.ONE 未下发阅读会话（VLIBSID 缺失，换票被拒）';
      console.log('[Kmoe/KOOBONE] 换票链未拿到 VLIBSID，jar=', JSON.stringify(jar));
      return null;
    }

    // ③ 顺带把 uin 记下来（vol_list 返回里也有，这里只做日志用）
    let uin = '';
    try {
      let s = new URL(loc).searchParams.get('u') || '';
      for (let i = 0; i < 2 && s; i++) {          // 站点是双层 base64
        const d = Buffer.from(s, 'base64').toString('utf8');
        if (!d || d === s) break;
        s = d.replace(/=+$/, '').trim();
        if (/^\d+$/.test(s)) { uin = s; break; }
      }
    } catch (e) { /* uin 只是日志用 */ }

    this._kbSession = { uin, cookie, ts: Date.now() };
    console.log(`[Kmoe/KOOBONE] 在线阅读会话就绪 (uin=${uin || '?'})`);
    return this._kbSession;
  }

  /** 带 KOOBONE 会话的 GET（会话失效自动重换一次） */
  async _kbGet(url, session) {
    const doIt = (s) => this._kbRaw(url, s);
    let s = session || await this.kooboneSession();
    if (!s) throw new Error(this.kooboneError || 'KOOB.ONE 会话不可用');
    let res = await doIt(s);
    let text = await res.text();
    // 掉登录态（返回空 uin / 落到 login）→ 强制重换一次再试
    if (!res.ok && res.status !== 200 || /<html[\s\S]*login\.htm/i.test(text) || /"uin"\s*:\s*0\b/.test(text)) {
      s = await this.kooboneSession(true);
      if (!s) throw new Error(this.kooboneError || 'KOOB.ONE 会话不可用');
      res = await doIt(s);
      text = await res.text();
    }
    return { res, text };
  }

  _kbRaw(url, session) {
    return fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8',
        'Referer': 'https://koobone.com/web.htm',
        'Cookie': session.cookie,
      },
      redirect: 'follow',
    });
  }

  /** 剥掉站点可能包裹的 HTML 壳，取出 JSON 体（返回 {uin,total,data} 或 null） */
  _kbJson(text) {
    if (!text) return null;
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try {
      const d = JSON.parse(text.slice(i, j + 1));
      return d && typeof d === 'object' ? d : null;
    } catch (e) { return null; }
  }

  /**
   * 该账号 KOOB.ONE 书库里的卷（自动翻页）。
   * @param {{search?:string, maxPages?:number, session?:object}} opts
   * @returns {Promise<Array>} 卷对象数组（含 file_url / vol_seriesid / vol_name / count_page）
   */
  async kooboneVolumes(opts = {}) {
    const search = opts.search ? String(opts.search) : '';
    const maxPages = Math.max(1, Number(opts.maxPages) || 6);
    const out = [];
    try {
      const session = opts.session || await this.kooboneSession();
      if (!session) return [];
      let page = 1, totalPages = 1;
      while (page <= maxPages) {
        const q = new URLSearchParams({ p: String(page) });
        if (search) q.set('s', search);
        const { text } = await this._kbGet('https://koobone.com/vol_list.php?' + q.toString(), session);
        const d = this._kbJson(text);
        if (!d) break;
        const rows = Array.isArray(d.data) ? d.data : [];
        for (const r of rows) {
          if (!r || !r.file_url) continue;
          out.push({ ...r, file_url: String(r.file_url).replace(/&amp;/g, '&') });
        }
        totalPages = Number(d.totalpage) || 1;
        if (page >= totalPages || rows.length === 0) break;
        page++;
      }
    } catch (e) {
      console.log('[Kmoe/KOOBONE] 取书库失败:', e.message);
    }
    return out;
  }

  /**
   * 从书页里取这本书的身份信息（KOOB.ONE 书库靠它们关联）。
   *  - key    = 书页 URL key（/c/<key>.htm，如 51215 / 0202ff）
   *  - id     = 页面 JS 里的数字 bookid（如 35388；URL key 不是数字时才是另一个键）
   *  - title / cover：顺带解析，避免调用方再抓一次页面
   * @returns {Promise<{key:string,id:string,title:string,cover:string}>}
   */
  async getBookIds(comicUrl) {
    const fullUrl = String(comicUrl || '').startsWith('http') ? String(comicUrl) : this.baseUrl + comicUrl;
    const out = { key: '', id: '', title: '', cover: '' };
    const m = fullUrl.match(/\/c\/([A-Za-z0-9]+)\.htm/i) || fullUrl.match(/\/b\/([A-Za-z0-9]+)\.htm/i);
    if (m) out.key = m[1];
    try {
      const $ = await this.request.getHtml(fullUrl);
      const html = $.root().html() || '';
      out.id = (html.match(/var\s+bookid\s*=\s*"(\d+)"/) || [])[1] || '';
      out.title = ($('h1').first().text().trim()
        || $('meta[name="og:title"]').attr('content')
        || $('meta[property="og:title"]').attr('content') || '')
        .replace(/\[.*?\]\s*$/g, '').trim();
      if (!out.title) {
        const kw = $('meta[name="keywords"]').attr('content') || '';
        out.title = (kw.split(',')[0] || '').trim();
      }
      out.cover = $('meta[name="og:image"]').attr('content')
        || $('meta[property="og:image"]').attr('content') || '';
    } catch (e) {
      console.log('[Kmoe] 取 bookid 失败:', e.message);
    }
    return out;
  }

  /**
   * 找到某本 kzo 漫画在 KOOB.ONE 书库里对应的卷。
   *
   * 匹配键：卷的 `vol_seriesid` 形如 `KMOE:51215`，冒号后是 kzo 书页的 **URL key**
   * （/c/<key>.htm 里的 <key>，例如 51215 / 0202ff —— 注意它不一定是纯数字：
   * 「一人之下」的 URL key 是 0202ff，而页面 JS 里的数字 bookid 是 35388）。
   * 所以命中判定优先用 URL key，其次用数字 bookid（有些卷只存了数字），
   * 最后退化为标题模糊匹配。
   *
   * @param {string} bookKey kzo 书页 URL key（/c/<key>.htm）
   * @param {string} [title] 漫画标题（兜底匹配）
   * @param {string} [bookId] 页面 JS 里的数字 bookid（可选第二匹配键）
   */
  async kooboneFindVolumes(bookKey, title = '', bookId = '') {
    const all = await this.kooboneVolumes({ maxPages: 8 });
    if (!all.length) return { volumes: [], library: 0 };
    const keys = [bookKey, bookId]
      .map(v => String(v || '').trim())
      .filter(Boolean)
      .map(v => v.toUpperCase());
    let hits = [];
    if (keys.length) {
      hits = all.filter(v => {
        const id = String(v.vol_seriesid || '').toUpperCase();
        return keys.some(k => id === 'KMOE:' + k || id.endsWith(':' + k));
      });
    }
    if (!hits.length && title) {
      const t = String(title).replace(/\[[^\]]*\]/g, '').trim();
      if (t) {
        hits = all.filter(v => String(v.vol_series || '').includes(t) || String(v.vol_name || '').includes(t));
      }
    }
    // 按卷号排序（卷01、卷02…）
    hits.sort((a, b) => String(a.vol_snumber || a.vol_name || '').localeCompare(String(b.vol_snumber || b.vol_name || ''), 'zh'));
    return { volumes: hits, library: all.length };
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
