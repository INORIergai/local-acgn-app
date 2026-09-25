const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
// ★ 容错加载：https-proxy-agent v9 是 ESM-only，用 CommonJS 的 require() 引它
//   需要 Node >= 20.19（那之后才默认开启 require(esm)）。
//   · Docker 容器      → Node 20.20.2 ✅
//   · Electron 33 内置 → Node 20.18.3 ❌ 抛 ERR_REQUIRE_ESM
//   桌面版已经用 NODE_OPTIONS=--experimental-require-module 把这个能力提前打开
//   （见 packaging/main.js），这里再兜一层：真拿不到就退化成「不支持代理」，
//   直连逻辑丝毫不受影响 —— 总好过整个后端起不来。
let HttpsProxyAgent = null;
try {
  ({ HttpsProxyAgent } = require('https-proxy-agent'));
} catch (e) {
  console.warn('[爬虫] https-proxy-agent 加载失败（' + (e.code || e.message) + '），代理功能不可用，将一律直连');
}
const { load } = require('cheerio');
const config = require('../config');
// ★ 图片守门员：校验魔数 + 自动解密（91动漫 图床返回的是 AES-CBC 密文，不是图片）
const { ensureRealImage } = require('./image-guard');

// 多套浏览器 UA 指纹，不同源用不同的，降低被封概率
const UA_POOL = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
};

const DEFAULT_TIMEOUT = config.network?.timeout || 15000;
const DEFAULT_RETRY = config.network?.retryCount || 3;

class Request {
  constructor(options = {}) {
    this.uaType = options.uaType || 'chrome';
    this.headers = {
      'User-Agent': UA_POOL[this.uaType] || UA_POOL.chrome,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en-US;q=0.7,en;q=0.6,ja;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      ...options.headers
    };
    this.cookies = options.cookies || {};
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.proxy = config.network?.proxyServer || null;
    this.referer = options.referer || null;
    this._agent = null;

    // 初始化代理（HttpsProxyAgent 可能没加载成功，见文件头的容错说明）
    if (this.proxy && HttpsProxyAgent) {
      try {
        this._agent = new HttpsProxyAgent(this.proxy);
      } catch (e) {
        console.log('[爬虫] 代理配置无效，将使用直连:', e.message);
      }
    }
  }

  setReferer(url) {
    this.referer = url;
    this.headers['Referer'] = url;
  }

  setCookie(name, value) {
    this.cookies[name] = value;
  }

  async _doFetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const cookieStr = Object.entries(this.cookies).map(([k,v]) => `${k}=${v}`).join('; ');
      const finalHeaders = { ...this.headers, ...options.headers };
      if (cookieStr) finalHeaders.Cookie = cookieStr;
      if (this.referer && !finalHeaders.Referer) finalHeaders.Referer = this.referer;

      const fetchOpts = {
        headers: finalHeaders,
        signal: controller.signal,
        redirect: 'follow',
        ...options
      };

      if (this._agent) {
        fetchOpts.agent = this._agent;
      }

      const res = await fetch(url, fetchOpts);
      
      // 提取响应 cookie
      const setCookies = res.headers.get('set-cookie');
      if (setCookies) {
        setCookies.split(',').forEach(c => {
          const match = c.match(/^([^=]+)=([^;]+)/);
          if (match) this.cookies[match[1].trim()] = match[2].trim();
        });
      }

      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async get(url) {
    let lastErr = null;
    for (let i = 0; i < this.retry; i++) {
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 1000 * i));
        return await this._doFetch(url);
      } catch (e) {
        lastErr = e;
        console.log(`[爬虫] GET失败 第${i+1}/${this.retry}次: ${url.split('?')[0]} - ${e.message}`);
      }
    }
    throw lastErr;
  }

  async post(url, data) {
    let lastErr = null;
    for (let i = 0; i < this.retry; i++) {
      try {
        if (i > 0) await new Promise(r => setTimeout(r, 1000 * i));
        const body = new URLSearchParams(data).toString();
        return await this._doFetch(url, {
          method: 'POST',
          body,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...this.headers
          }
        });
      } catch (e) {
        lastErr = e;
        console.log(`[爬虫] POST失败 第${i+1}/${this.retry}次: ${url.split('?')[0]} - ${e.message}`);
      }
    }
    throw lastErr;
  }

  async getHtml(url) {
    const res = await this.get(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return load(html, { baseUrl: url });
  }

  async postHtml(url, data) {
    const res = await this.post(url, data);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return load(html, { baseUrl: url });
  }

  async head(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: this.headers,
        signal: controller.signal,
        agent: this._agent
      });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
}

async function downloadImage(url, savePath, referer, uaType = 'chrome') {
  const maxRetry = config.network?.retryCount || 3;
  let lastErr = null;

  for (let i = 0; i < maxRetry; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      if (i > 0) await new Promise(r => setTimeout(r, 1000 * i));

      const headers = { 
        'User-Agent': UA_POOL[uaType] || UA_POOL.chrome,
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      };
      if (referer) headers.Referer = referer;

      const agent = (config.network?.proxyServer && HttpsProxyAgent)
        ? new HttpsProxyAgent(config.network.proxyServer)
        : undefined;
      
      const res = await fetch(url, { 
        headers, 
        signal: controller.signal,
        agent
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const buf = await res.arrayBuffer();
      // ★ 落盘前必须确认拿到的是「真图片」：
      //   91动漫 的图床（pic.tuafjz.cn 等）返回的是 AES-128-CBC 密文，
      //   直接写盘会让前端显示白框/破图（历史事故：19 个封面全是密文）。
      //   这里先按魔数判断，不是图片就尝试解密；两者都不行就**当作失败，不落盘**。
      const rawBuf = Buffer.from(buf);
      const realBuf = ensureRealImage(rawBuf);
      if (!realBuf) {
        throw new Error(`返回内容不是图片（${rawBuf.length}B，加密或防盗链页），已丢弃`);
      }
      if (realBuf !== rawBuf) {
        console.log(`[图片] AES 解密成功: ${url.split('?')[0].slice(-52)}`);
      }
      const saveDir = path.dirname(savePath);
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
      fs.writeFileSync(savePath, realBuf);
      return savePath;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      console.log(`[下载] 失败 第${i+1}/${maxRetry}次: ${url.split('?')[0].substring(0, 60)}... - ${err.message}`);
    }
  }
  throw lastErr;
}

module.exports = { Request, downloadImage, UA_POOL };
