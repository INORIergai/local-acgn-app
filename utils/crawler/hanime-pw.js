const { load } = require('cheerio');
const { chromium } = require('playwright');
const config = require('../config');
const userBrowser = require('./user-browser');

// 全局浏览器实例，复用，避免频繁启停浏览器
let browser = null;
let context = null;
let cdpMode = false; // 当前是否工作于 CDP 用户浏览器模式

/**
 * 初始化浏览器上下文
 * 优先使用 CDP 连接真实用户浏览器（可绕过 Cloudflare），失败降级为 headless
 */
async function initBrowser() {
    if (browser) return browser;

    // ===== 优先：CDP 用户浏览器 =====
    if (config.network?.cdp?.enabled !== false) {
        try {
            const cdpBrowser = await userBrowser.ensureBrowser();
            const contexts = cdpBrowser.contexts();
            if (contexts.length > 0) {
                browser = cdpBrowser;
                context = contexts[0];
                cdpMode = true;
                console.log('[Hanime-PW] 使用 CDP 用户浏览器模式（可绕过 Cloudflare）');
                return browser;
            }
        } catch (e) {
            console.log(`[Hanime-PW] CDP 模式不可用: ${e.message}，降级 headless`);
        }
    }

    // ===== 降级：headless playwright =====
    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage'
        ]
    };

    const proxyServer = config.network?.proxyServer;
    if (proxyServer) {
        console.log(`[Hanime-PW] 使用代理: ${proxyServer}`);
        launchOptions.proxy = { server: proxyServer };
    }

    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        acceptDownloads: false
    });
    cdpMode = false;
    console.log('[Hanime-PW] 使用 headless 模式（可能被 Cloudflare 拦截）');
    return browser;
}

/**
 * 释放浏览器资源，程序退出调用
 */
async function closeBrowser() {
    // CDP 模式：只关自己拉起的实例，不打扰用户浏览器
    if (cdpMode) {
        await userBrowser.closeBrowser();
        browser = null;
        context = null;
        cdpMode = false;
        return;
    }
    if (context) await context.close();
    if (browser) await browser.close();
    browser = null;
    context = null;
}

class HanimePwCrawler {
    constructor(options = {}) {
        let baseUrl = options.baseUrl || "https://hanime1.me";
        // 移除末尾的斜杠，避免URL拼接时出现双斜杠
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    
    /**
     * 拼接URL
     * @param {string} path 
     * @returns {string}
     */
    buildUrl(path) {
        if (path.startsWith('http')) return path;
        if (path.startsWith('/')) return this.baseUrl + path;
        return this.baseUrl + '/' + path;
    }

    /**
     * 访问页面，自动等待CF验证完成，返回完整html
     * @param {string} url
     * @returns {Promise<{html:string,finalUrl:string}>}
     */
    async fetchPage(url) {
        await initBrowser();

        // CDP 模式：直接交给 user-browser 处理（含 CF 等待）
        if (cdpMode) {
            return await userBrowser.fetchPage(url, { cfWaitMs: 45000 });
        }

        const page = await context.newPage();
        try {
            console.log(`[Hanime‑PW] 访问: ${url}`);
            // 访问，等待网络空闲，CF验证自动完成
            await page.goto(url, {
                timeout: 30000,
                waitUntil: 'networkidle'
            });
            // 额外等待，防止CF还在弹窗
            await page.waitForTimeout(1200);
            const html = await page.content();
            const finalUrl = page.url();
            return { html, finalUrl };
        } finally {
            await page.close();
        }
    }

    /**
     * 搜索
     * @param {string} keyword
     * @returns {Promise<Array>}
     */
    async search(keyword) {
        try {
            const searchUrl = `${this.baseUrl}/search?q=${encodeURIComponent(keyword)}`;
            const { html, finalUrl } = await this.fetchPage(searchUrl);

            // 判断是否还在CF拦截页
            if (html.includes('Attention Required! | Cloudflare')) {
                console.log('[Hanime‑PW] ⚠️仍然被Cloudflare拦截');
                return [];
            }

            const $ = load(html);
            const results = [];
            const realBase = new URL(finalUrl).origin;

            // ========== 广告/无关结果过滤 ==========
            const isAdHref = (href) => !href || /erodalabs|juicyads|exoclick|clk\./i.test(href) || !(href.includes('/watch/') || href.includes('/watch?v='));

            // ========== 新版选择器（hanime1.me 当前 DOM：video-item-container） ==========
            const selectors = [
                {
                    card: 'div.video-item-container',
                    title: '.video-link .title, .horizontal-card .title',
                    img: '.main-thumb, .thumb-container img',
                    link: 'a.video-link',
                    containerTitle: true
                },
                {
                    card: 'div.video-list-item',
                    title: '.video-list-item__title a',
                    img: '.video-list-item__thumbnail img',
                    link: '.video-list-item__title a'
                },
                {
                    card: 'div.video-block',
                    title: '.video-title a',
                    img: '.video-thumb img',
                    link: '.video-title a'
                },
                {
                    card: 'div.card',
                    title: '.card-title a',
                    img: '.card-img-top img, .card-image img',
                    link: '.card-title a'
                },
                {
                    card: 'div.item',
                    title: '.item-title a',
                    img: '.item-thumb img',
                    link: '.item-title a'
                },
                {
                    card: 'div.video-item',
                    title: '.video-name a',
                    img: '.video-cover img',
                    link: '.video-name a'
                },
                {
                    card: 'article',
                    title: 'h2 a, h3 a, .title a',
                    img: 'img',
                    link: 'h2 a, h3 a, .title a'
                }
            ];

            let matchedSelector = null;
            for (const sel of selectors) {
                const count = $(sel.card).length;
                console.log(`[Hanime‑PW] 选择器 ${sel.card}: ${count} 个`);
                if (count > 0) {
                    matchedSelector = sel;
                    break;
                }
            }

            if (!matchedSelector) {
                console.log('[Hanime‑PW] ⚠️没有匹配到任何卡片选择器，尝试通用fallback');
                // fallback: 找所有带图片的链接
                $('a').each((_, el) => {
                    const $el = $(el);
                    const href = $el.attr('href') || '';
                    const $img = $el.find('img');
                    const imgSrc = $img.attr('data-src') || $img.attr('src') || '';
                    const title = $img.attr('alt') || $el.text().trim() || '';
                    
                    if (href && imgSrc && title && (href.includes('/video/') || href.includes('/watch/') || href.includes('/watch?v='))) {
                        const fullCover = imgSrc.startsWith('http') ? imgSrc :
                            imgSrc.startsWith('/') ? `${realBase}${imgSrc}` : `${realBase}/${imgSrc}`;
                        const fullUrl = href.startsWith('http') ? href :
                            href.startsWith('/') ? `${realBase}${href}` : `${realBase}/${href}`;
                        
                        results.push({
                            title: title.trim(),
                            cover: fullCover,
                            url: fullUrl,
                            source: 'hanime'
                        });
                    }
                });
            } else {
                const { card, title: titleSel, img: imgSel, link: linkSel, containerTitle } = matchedSelector;
                $(card).each((_, el) => {
                    const $el = $(el);
                    const $a = $el.find(linkSel).first();
                    const linkHref = $a.attr('href') || '';

                    // 过滤广告（erodalabs 等外链）
                    if (isAdHref(linkHref)) return;

                    // 封面图：优先懒加载data-src，其次src
                    const $img = $el.find(imgSel).first();
                    let coverSrc = $img.attr('data-src') || $img.attr('src') || '';

                    // 标题：优先读取容器title属性（video-item-container title="xxx"），其次a标签文本，其次img alt
                    let title = '';
                    if (containerTitle) title = $el.attr('title') || '';
                    if (!title) title = $a.text().trim();
                    if (!title) title = $img.attr('alt') || '';

                    if (!title || !coverSrc || !linkHref) return;

                    // 补全url
                    const fullCover = coverSrc.startsWith('http') ? coverSrc :
                        coverSrc.startsWith('//') ? 'https:' + coverSrc :
                        coverSrc.startsWith('/') ? `${realBase}${coverSrc}` : `${realBase}/${coverSrc}`;

                    const fullUrl = linkHref.startsWith('http') ? linkHref :
                        linkHref.startsWith('/') ? `${realBase}${linkHref}` : `${realBase}/${linkHref}`;

                    // 只保留 hanime1.me 站内 watch 链接
                    if (!fullUrl.includes('/watch/') && !fullUrl.includes('/watch?v=')) return;

                    results.push({
                        title: title.trim(),
                        cover: fullCover,
                        url: fullUrl,
                        source: 'hanime'
                    });
                });
            }

            console.log(`[Hanime‑PW] 搜索"${keyword}"，获取有效结果：${results.length}`);
            return results;
        } catch (e) {
            console.log(`[Hanime‑PW] search异常：${e.message}`);
            return [];
        }
    }

    /**
     * 从搜索结果中挑选与关键词最匹配的一项（按标题包含度打分）
     * 原因：hanime1.me 搜索页会混入大量"最新视频"，直接取 list[0] 经常匹配到无关内容。
     */
    pickBestMatch(results, keyword) {
        if (!results || results.length === 0) return null;
        if (results.length === 1) return results[0];

        const kw = keyword.toLowerCase();
        // 关键词拆词：去空格后的整词 + 每个长度>=2的片段 + CJK二元组
        const whole = kw.replace(/\s+/g, '');
        const parts = kw.split(/\s+/).filter(p => p.length >= 2);
        // 对中文/日文关键词额外生成二元组（如 "隱性傲嬌" → 隱性/性傲/傲嬌）
        const bigrams = new Set();
        for (const p of kw.split(/\s+/)) {
            if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(p)) {
                for (let i = 0; i < p.length - 1; i++) {
                    bigrams.add(p.slice(i, i + 2));
                }
            }
        }

        let best = results[0];
        let bestScore = -1;

        for (const r of results) {
            const title = (r.title || '').toLowerCase();
            if (!title) continue;
            let score = 0;
            // 整词包含（去空格）权重最高
            if (whole && title.replace(/\s+/g, '').includes(whole)) score += 10;
            // 逐词包含
            for (const p of parts) {
                if (title.includes(p)) score += 3;
            }
            // CJK 二元组命中
            for (const g of bigrams) {
                if (title.includes(g)) score += 2;
            }
            // 短标题微加分
            if (title.length <= keyword.length + 8) score += 1;
            if (score > bestScore) {
                bestScore = score;
                best = r;
            }
        }
        return best;
    }

    /**
     * 获取详情页
     * @param {string} url
     * @returns {Promise<object|null>}
     */
    async getDetail(url) {
        try {
            const { html } = await this.fetchPage(url);
            if (html.includes('Attention Required! | Cloudflare')) {
                console.log('[Hanime‑PW] 详情页CF拦截');
                return null;
            }
            const $ = load(html);

            // og meta优先拿，并清洗掉站点后缀 " - Hanime1.me"
            let title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
            if (title) title = title.replace(/[\s\-]*Hanime1\.me\s*$/, '').replace(/[\s\-]*H動漫.*$/, '').trim();
            if (!title) title = $('title').text().replace(/\s*-\s*H動漫.*$/, '').trim();
            const cover = $('meta[property="og:image"]').attr('content') || '';
            const overview = $('meta[property="og:description"]').attr('content') || '';

            // 标签：当前站点结构为 <span class="tag">JK (1)</span> 形式，用模糊 [class*="tag"] 匹配
            const tags = [];
            $('[class*="tag"]').each((_, el) => {
                const t = $(el).text().trim().replace(/\s*\(\d+\)\s*$/, '');
                if (t && t.length > 0 && t.length < 20 && !tags.includes(t)) {
                    tags.push(t);
                }
            });

            return {
                title: title?.trim() || '',
                cover: cover || '',
                overview: overview?.trim() || '',
                tags
            };
        } catch (e) {
            console.log(`[Hanime‑PW] getDetail异常：${e.message}`);
            return null;
        }
    }

    /**
     * 文件名清洗搜索（修复旧逻辑：不要把数字全部删除，日文标题经常带数字）
     * @param {string} fileName
     * @returns {Promise<object|null>}
     */
    async searchByFileName(fileName) {
        try {
            // 修复：不再全局删除所有数字，只清理分辨率、编码标记
            let keyword = fileName
                .replace(/\.[^.]+$/, '')
                .replace(/[\[\]【】()（）{}「」『』]/g, ' ')
                .replace(/[！？〇★☆◆■●]/g, ' ')
                .replace(/[0-9]{3,4}[pP]/g, '')
                .replace(/x26[45]|hevc|h\.?26[45]|xvid|divx|神画質/gi, '')
                .replace(/[0-9]{4}[-/][0-9]{2}[-/][0-9]{2}/g, '')
                .replace(/(CHS|CHT|JP|EN|SUB|UNC|BD|BluRay|WEB‑DL|WEBRip|HD|FHD|4K|UHD)/gi, '')
                .replace(/[-_.]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            console.log(`[Hanime‑PW]清洗后关键词: "${keyword}"`);
            if (keyword.length < 2) return null;

            let list = await this.search(keyword);
            // 搜索失败，降级缩短关键词
            if (list.length === 0 && keyword.length > 12) {
                const shortKey = keyword.substring(0, 18).trim();
                console.log(`[Hanime‑PW]降级搜索关键词: "${shortKey}"`);
                list = await this.search(shortKey);
            }

            if (list.length === 0) return null;

            const first = this.pickBestMatch(list, keyword);
            const detail = await this.getDetail(first.url);

            if (!detail) {
                return {
                    title: first.title,
                    originalTitle: first.title,
                    cover: first.cover,
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
        } catch (e) {
            console.log(`[Hanime‑PW] searchByFileName异常: ${e.message}`);
            return null;
        }
    }
}

let _pwInstance = null;
function getPwInstance() {
    if (!_pwInstance) {
        const srcCfg = config.sources?.hanime || {};
        _pwInstance = new HanimePwCrawler({
            baseUrl: srcCfg.baseUrl || "https://shturl.cc/5wWPJc4j"
        });
    }
    return _pwInstance;
}

// poster‑fetcher调用入口
async function searchHanimeByName(keyword) {
    if (!keyword?.trim()) return null;
    const crawler = getPwInstance();
    const list = await crawler.search(keyword.trim());
    if (!Array.isArray(list) || list.length === 0) return null;

    const first = crawler.pickBestMatch(list, keyword.trim());
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
    HanimePwCrawler,
    getPwInstance,
    searchHanimeByName,
    initBrowser,
    closeBrowser
};