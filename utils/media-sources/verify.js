/**
 * utils/media-sources/verify.js —— round185 A2「人机验证救回」
 * ------------------------------------------------------------------
 * 背景：源站里有一批是 Cloudflare / 安全狗挡着的，fetch 拿到 403 + 验证页。
 * 这类源不是坏了，是**需要人过一次验证**。Kazumi 的做法是开 WebView 让用户点，
 * 点完复用同一会话的 Cookie。
 *
 * 我们的做法：
 *   1. launchPersistentContext（有头）打开源首页，用户自己过验证；
 *   2. 轮询页面内容，验证特征消失 = 过了；
 *   3. storageState 导出 cookies 落盘（engine.saveSourceCookies）；
 *   4. 之后 engine 的所有请求自动带这份 Cookie（sourceCookieHeader）。
 *
 * ★ 只在用户主动点「去验证」时调用，绝不后台偷偷弹窗。
 * ★ 同一时刻只允许一个验证窗口（多人点会抢焦点，反而过不去）。
 */
const path = require('path');
const engine = require('./engine');

let busySourceId = null;   // 互斥：当前正在验证哪个源

const CAPTCHA_RE = /(Just a moment|cf-challenge|challenge-platform|Enable JavaScript and cookies|Attention Required|请完成安全验证|人机验证|滑动验证|请输入验证码|访问验证)/i;

/**
 * 打开有头浏览器让用户过验证。
 * @returns {{ok:boolean, passed:boolean, cookies:number, reason?:string}}
 */
async function verifySource(sourceId, opts = {}) {
    if (busySourceId) {
        return { ok: false, passed: false, cookies: 0,
                 reason: `正在验证另一个源（${busySourceId}），请先完成或关闭那个窗口` };
    }
    const src = engine.getSource(sourceId);
    if (!src) return { ok: false, passed: false, cookies: 0, reason: '源不存在：' + sourceId };
    if (!src.host) return { ok: false, passed: false, cookies: 0, reason: '该源没有可访问域名，无法验证' };

    busySourceId = sourceId;
    const timeout = Math.min(Number(opts.timeout) || 120000, 240000);
    const target = opts.url || ('https://' + src.host + '/');
    const safeName = encodeURIComponent(String(sourceId)).replace(/[^\w.-]/g, '_');
    const profileDir = path.join(engine.COOKIE_DIR, 'profile-' + safeName);

    let ctx = null;
    try {
        const { chromium } = require('playwright');
        ctx = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            viewport: { width: 1280, height: 820 },
            locale: 'zh-CN',
            ignoreHTTPSErrors: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
        });
        const page = ctx.pages()[0] || await ctx.newPage();
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { /* 超时也继续等 */ });

        const deadline = Date.now() + timeout;
        let passed = false;
        let lastLen = 0;
        while (Date.now() < deadline) {
            await page.waitForTimeout(2500);
            let html = '';
            try {
                // 只取前 8000 字符判断，整页 content() 在长页面上很慢
                html = await page.evaluate(() => document.documentElement.outerHTML.slice(0, 8000));
            } catch (e) { /* 页面可能正在跳转 */ }
            lastLen = html.length;
            if (html && html.length > 1500 && !CAPTCHA_RE.test(html)) { passed = true; break; }
        }

        // 不管过没过都存一次：用户可能已经点过了但页面还挂着残留文案
        let cookies = [];
        try {
            const state = await ctx.storageState();
            cookies = (state && state.cookies) || [];
            if (cookies.length) engine.saveSourceCookies(sourceId, cookies);
        } catch (e) { /* 导出失败就当没验证成功 */ }

        return {
            ok: true, passed, cookies: cookies.length,
            reason: passed ? '' : (lastLen < 500
                ? '页面没加载出来（可能被墙或源站已关）'
                : '等待超时，未检测到验证通过。窗口里的内容可能还在挑战页，可重新点一次')
        };
    } catch (e) {
        return { ok: false, passed: false, cookies: 0, reason: '浏览器启动失败：' + (e.message || e) };
    } finally {
        busySourceId = null;
        if (ctx) { try { await ctx.close(); } catch (e) { /* 已关闭 */ } }
    }
}

function verifyBusy() {
    return busySourceId;
}

module.exports = { verifySource, verifyBusy };
