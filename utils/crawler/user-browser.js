/**
 * user-browser.js —— CDP 用户浏览器模块
 * 
 * 用途：绕过 Cloudflare 等反爬验证。真实浏览器的指纹、cookie、TLS 指纹无法被 CF 轻易拦截。
 * 
 * 策略（两级）：
 *   1. 优先连接"已有调试实例"：如果主人日常浏览器已经用 --remote-debugging-port 启动，
 *      直接 connectOverCDP 复用其 cookie 与指纹。
 *   2. 否则自动拉起一个"独立浏览器实例"：使用项目内的 user-data-dir 持久化 cookie，
 *      首次需要主人手动通过一次 CF 验证（弹出真实浏览器窗口），之后全部自动。
 * 
 * 配置（config.json → network.cdp）：
 *   port:      调试端口，默认 9222
 *   enabled:   总开关，默认 true
 *   chromePath: 手动指定浏览器路径；为空时自动探测 Chrome/Edge
 *   headless:  是否无头（默认 false，首次过验证需要有窗口）
 *   userDataDir: 独立用户数据目录，默认项目下 .user-browser-data
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const config = require('../config');

const CDP_CFG = config.network?.cdp || {};
const DEFAULT_PORT = 9222;
const DEFAULT_USER_DATA_DIR = path.join(__dirname, '..', '..', '.user-browser-data');

// 浏览器路径候选（按优先级）
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows 本机
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '%USERPROFILE%\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  '%USERPROFILE%\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux / 容器
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
].filter(Boolean);

let _browser = null;      // playwright browser（CDP 连接）
let _spawned = null;      // 我们自己拉起的子进程（仅此情况才允许关闭）
let _starting = null;     // ensureBrowser 并发去重的 promise

function getPort() {
  return CDP_CFG.port || DEFAULT_PORT;
}

function getUserDataDir() {
  return CDP_CFG.userDataDir || DEFAULT_USER_DATA_DIR;
}

/** 探测可用的浏览器可执行文件 */
function findBrowserPath() {
  if (CDP_CFG.chromePath && fs.existsSync(CDP_CFG.chromePath)) return CDP_CFG.chromePath;
  for (const p of BROWSER_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  // ★ 兜底：容器里既没有 Chrome 也没有 Edge（本项目就是这个部署方式），
  //   但 Playwright 自带一份完整的 Chromium —— 直接拿它来当 CDP 浏览器。
  //   没有这一步，hanime 这类带 Cloudflare 的站在 Docker 部署下永远过不了验证。
  try {
    const p = require('playwright').chromium.executablePath();
    if (p && fs.existsSync(p)) {
      console.log('[user-browser] 未找到系统 Chrome/Edge，改用 Playwright 自带 Chromium: ' + p);
      return p;
    }
  } catch (e) {
    console.log('[user-browser] 取 Playwright Chromium 路径失败:', e.message);
  }
  return null;
}

/** 检测端口是否已有进程监听 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(800);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

/** 等待端口就绪（最多 waitMs） */
async function waitPort(port, waitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (await isPortOpen(port)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

/** 拉起独立浏览器实例（仅当端口无实例时） */
async function spawnBrowser() {
  const port = getPort();
  const browserPath = findBrowserPath();
  if (!browserPath) {
    throw new Error('[user-browser] 未找到 Chrome/Edge，请在 config.network.cdp.chromePath 指定浏览器路径');
  }

  const userDataDir = getUserDataDir();
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    '--disable-popup-blocking'
  ];

  // 容器（Linux/root）里 Chromium 必须加这两个参数才起得来
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  }

  // 代理（与刮削共用的本地代理）
  const proxy = config.network?.proxyServer;
  if (proxy) args.push(`--proxy-server=${proxy}`);

  // 默认无头后台运行（不弹窗打断用户操作）；仅当显式配置 headless=false 时弹窗
  // 手动初始化验证（initBrowserVerification）会强制有窗口模式
  if (CDP_CFG.headless !== false) args.push('--headless=new');

  console.log(`[user-browser] 拉起独立浏览器: ${browserPath}`);
  console.log(`[user-browser]   port=${port}, user-data-dir=${userDataDir}`);
  if (CDP_CFG.headless === false) {
    console.log('[user-browser]   有窗口模式：请在弹出的浏览器窗口手动通过 Cloudflare 验证（只需一次）');
  } else {
    console.log('[user-browser]   无头后台模式：静默运行，不会弹出窗口');
  }

  const child = spawn(browserPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  _spawned = child;

  const ready = await waitPort(port);
  if (!ready) {
    console.log('[user-browser] 浏览器启动超时，端口未就绪');
    return false;
  }
  return true;
}

/**
 * 确保存在可用的 CDP 浏览器连接
 * @returns {Promise<import('playwright').Browser>}
 */
async function ensureBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
  if (_starting) return _starting;

  _starting = (async () => {
    const { chromium } = require('playwright');
    const port = getPort();

    // 1. 已有调试实例 → 直接连接（复用主人浏览器的真实 cookie）
    if (await isPortOpen(port)) {
      try {
        _browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        console.log(`[user-browser] 已连接现有调试实例 (port ${port})`);
        return _browser;
      } catch (e) {
        console.log(`[user-browser] 连接现有实例失败: ${e.message}，尝试自建`);
      }
    }

    // 2. 无实例 → 自建
    const ok = await spawnBrowser();
    if (!ok) {
      // 端口竞争：等 2 秒再试一次连接
      await new Promise(r => setTimeout(r, 2000));
    }
    _browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    console.log('[user-browser] 已连接到自建浏览器实例');
    return _browser;
  })();

  try {
    return await _starting;
  } finally {
    _starting = null;
  }
}

/** 获取 CDP 浏览器的默认 context（含持久化 cookie） */
async function getContext() {
  const browser = await ensureBrowser();
  const contexts = browser.contexts();
  if (contexts.length > 0) return contexts[0];
  return browser.newContext();
}

/** 判断 HTML 是否为 Cloudflare 挑战页 */
function isCloudflareChallenge(html) {
  if (!html) return false;
  return html.includes('Attention Required! | Cloudflare')
    || html.includes('cf-challenge')
    || html.includes('cf-browser-verification')
    || html.includes('challenge-platform')
    || (html.includes('cloudflare') && (html.includes('verify') || html.includes('captcha')));
}

/**
 * 用真实浏览器访问页面，返回 { html, finalUrl }
 * @param {string} url
 * @param {Object} opts
 * @param {number} opts.cfWaitMs  遇到 CF 挑战时最多等待多少毫秒（留给真人手动验证），默认 45000
 */
async function fetchPage(url, opts = {}) {
  const { chromium } = require('playwright');
  const context = await getContext();
  const page = await context.newPage();
  try {
    console.log(`[user-browser] 访问: ${url}`);
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // 若命中 CF 挑战，等待真人手动完成（非 headless 时窗口可见）
    for (let i = 0; i < 3; i++) {
      const html = await page.content();
      if (!isCloudflareChallenge(html)) break;
      const waitMs = opts.cfWaitMs ?? 45000;
      console.log(`[user-browser] ⚠️ 检测到 Cloudflare 验证，请在浏览器窗口手动通过（等待最多 ${Math.round(waitMs / 1000)}s）...`);
      // 轮询等待挑战消失
      const start = Date.now();
      let passed = false;
      while (Date.now() - start < waitMs) {
        await page.waitForTimeout(1500);
        const cur = await page.content();
        if (!isCloudflareChallenge(cur)) { passed = true; break; }
      }
      if (passed) {
        console.log('[user-browser] ✅ Cloudflare 验证已通过');
        break;
      }
      if (i < 2) {
        console.log('[user-browser] 验证超时，刷新重试...');
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
    }

    // 等网络基本稳定，让懒加载/JS 渲染完成
    await page.waitForTimeout(1200);
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } finally {
    await page.close();
  }
}

/** 释放资源：只关闭自己拉起的实例；连接主人浏览器的实例不碰 */
async function closeBrowser() {
  if (_browser && _spawned) {
    try { await _browser.close(); } catch (e) { /* ignore */ }
  }
  _browser = null;
  if (_spawned) {
    try { _spawned.kill(); } catch (e) { /* ignore */ }
    _spawned = null;
  }
}

/**
 * 初始化浏览器验证（供设置页面调用）
 * 弹出有窗口的浏览器，打开指定URL，让用户手动通过一次CF验证
 * 验证完成后cookie会持久化保存，之后刮削可使用无头模式
 * @param {string} url 要打开的验证页面URL，默认hanime1.me
 * @param {number} timeoutMs 最多等待多少毫秒
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function initBrowserVerification(url = 'https://hanime1.me', timeoutMs = 120000) {
  try {
    // 强制使用有窗口模式
    const originalHeadless = CDP_CFG.headless;
    CDP_CFG.headless = false;

    // 关闭已有连接，重新拉起有窗口的浏览器
    if (_browser) {
      try { await _browser.close(); } catch (e) {}
      _browser = null;
    }
    if (_spawned) {
      try { _spawned.kill(); } catch (e) {}
      _spawned = null;
    }
    await new Promise(r => setTimeout(r, 1000));

    const browser = await ensureBrowser();
    const context = await getContext();
    const page = await context.newPage();

    console.log(`[user-browser] 初始化验证，打开: ${url}`);
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // 轮询检测验证是否通过
    const start = Date.now();
    let passed = false;
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const html = await page.content();
        if (!isCloudflareChallenge(html)) {
          passed = true;
          break;
        }
      } catch (e) {
        // 页面可能还在加载，忽略
      }
    }

    // 恢复headless设置
    CDP_CFG.headless = originalHeadless;

    if (passed) {
      console.log('[user-browser] ✅ 验证通过，cookie已持久化保存');
      // 不关闭浏览器，保持连接，后续刮削复用
      return { success: true, message: '验证通过，cookie已保存。后续刮削将自动使用，无需再次验证。' };
    } else {
      console.log('[user-browser] ⚠️ 验证超时');
      return { success: false, message: '验证超时，请在浏览器中完成Cloudflare验证后重试。' };
    }
  } catch (e) {
    console.error('[user-browser] 初始化验证失败:', e.message);
    return { success: false, message: '初始化失败: ' + e.message };
  }
}

/**
 * 检查当前浏览器cookie是否还有效（能否正常访问目标站点）
 * @param {string} url 测试URL
 * @returns {Promise<boolean>}
 */
async function checkCookieValid(url = 'https://hanime1.me') {
  try {
    const context = await getContext();
    const page = await context.newPage();
    try {
      await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 3000));
      const html = await page.content();
      return !isCloudflareChallenge(html);
    } finally {
      await page.close();
    }
  } catch (e) {
    console.log('[user-browser] cookie检查失败:', e.message);
    return false;
  }
}

/**
 * 拉起有窗口浏览器打开登录页，等待用户手动登录后抓取指定域名的 cookie
 * 参照 initBrowserVerification 的模式，但抓取的是 cookie（用于夸克网盘等登录）。
 * @param {string} url 登录页URL
 * @param {Object} opts
 * @param {number} opts.timeoutMs 最长等待毫秒，默认 180000
 * @param {string|RegExp} opts.domain 域名过滤（如 'quark.cn'，匹配该域名及其子域）
 * @param {Array<string>} opts.triggerCookieNames 判定"疑似登录成功"的cookie名（命中后才触发验证）
 * @param {(cookieStr: string) => Promise<boolean>} opts.verify 最终校验函数（如调用后端API验证cookie有效性）
 * @returns {Promise<{success: boolean, cookie: string, message: string}>}
 */
async function openAndCaptureCookies(url, opts = {}) {
  const { timeoutMs = 180000, domain = null, triggerCookieNames = [], verify = null } = opts;
  const originalHeadless = CDP_CFG.headless;
  CDP_CFG.headless = false;
  try {
    // 关闭已有连接，重新拉起有窗口的浏览器（登录需要用户可视操作）
    if (_browser) {
      try { await _browser.close(); } catch (e) {}
      _browser = null;
    }
    if (_spawned) {
      try { _spawned.kill(); } catch (e) {}
      _spawned = null;
    }
    await new Promise(r => setTimeout(r, 1000));

    const context = await getContext();
    const page = await context.newPage();
    try {
      console.log(`[user-browser] 打开登录页: ${url}`);
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });

      const client = await page.context().newCDPSession(page);
      const start = Date.now();
      let lastCookieStr = '';

      while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 3000));

        let allCookies = [];
        try {
          const res = await client.send('Network.getAllCookies');
          allCookies = res.cookies || [];
        } catch (e) {
          continue;
        }

        // 过滤出目标域名的 cookie
        const filtered = allCookies.filter(c => {
          if (!c || !c.name || !c.value) return false;
          if (!domain) return true;
          if (typeof domain === 'string') return c.domain === domain || c.domain.endsWith('.' + domain);
          return domain.test(c.domain);
        });

        const cookieStr = filtered.map(c => `${c.name}=${c.value}`).join('; ');
        if (!cookieStr) continue;

        // 未命中登录特征 cookie 时继续等待
        const triggered = triggerCookieNames.length === 0
          || triggerCookieNames.some(n => filtered.some(c => c.name === n && c.value));
        if (!triggered) continue;

        // cookie 无变化时跳过校验，避免频繁请求
        if (cookieStr === lastCookieStr) continue;
        lastCookieStr = cookieStr;

        if (verify) {
          let ok = false;
          try { ok = await verify(cookieStr); } catch (e) { ok = false; }
          if (ok) {
            console.log('[user-browser] ✅ 登录成功，cookie已抓取');
            return { success: true, cookie: cookieStr, message: '登录成功' };
          }
        } else {
          return { success: true, cookie: cookieStr, message: '已获取cookie' };
        }
      }

      console.log('[user-browser] ⚠️ 登录等待超时');
      return { success: false, cookie: '', message: '登录超时，请在弹出的浏览器中完成登录后重试' };
    } finally {
      await page.close();
    }
  } catch (e) {
    console.error('[user-browser] 登录抓取失败:', e.message);
    return { success: false, cookie: '', message: '登录失败: ' + e.message };
  } finally {
    CDP_CFG.headless = originalHeadless;
  }
}

module.exports = {
  ensureBrowser,
  getContext,
  fetchPage,
  closeBrowser,
  isCloudflareChallenge,
  findBrowserPath,
  isPortOpen,
  getPort,
  getUserDataDir,
  initBrowserVerification,
  checkCookieValid,
  openAndCaptureCookies
};
