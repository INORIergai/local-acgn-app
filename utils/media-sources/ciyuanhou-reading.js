/**
 * 次元狗动漫（acgndog.com）资源索引适配器
 * ------------------------------------------------------------------
 * 站点是 WordPress 网盘资源索引站：有最新/热门列表和详情元数据，
 * 但**没有章节、没有在线阅读**（下载项由 nonce AJAX 注入、可能会员墙）。
 * 因此本适配器只做：最新列表 + 详情元数据 + 原站跳转；下载链接不抓不缓存。
 * 安全：仅 https + 固定 host 白名单 + 拒绝内网/回环。
 */
'use strict';

const net = require('node:net');
const HOSTS = new Set(['www.acgndog.com', 'acgndog.com', 'www.acgmh.com', 'acgmh.com']);

function isBlockedIp(a) {
    const x = String(a || '').toLowerCase();
    if (net.isIPv6(x)) return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
    if (!net.isIPv4(x)) return false;
    const p = x.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254)
        || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] >= 224;
}
function assertSafeHost(u) {
    const url = new URL(String(u || ''));
    if (url.protocol !== 'https:') throw new Error('仅允许 https');
    const h = url.hostname.toLowerCase();
    if (isBlockedIp(h)) throw new Error('拒绝内网地址');
    if (!HOSTS.has(h)) throw new Error('源不在白名单');
    return url;
}

module.exports = function register(deps) {
    const { page, clean, abs, imgProxy } = deps;
    const adapter = {
        id: 'ciyuanhou',
        name: '次元狗(资源索引)',
        kind: 'novel',
        external: true,
        catalogUrl: 'https://www.acgndog.com/',
        async catalog() {
            assertSafeHost(this.catalogUrl);
            const { $, base } = await page(this.catalogUrl, { timeout: 25000 });
            const items = [];
            const seen = new Set();
            // 用 filter(attr includes) 代替 .class 选择器：cheerio 对双下划线复合 class 匹配不稳
            $('article').filter((i, el) => ($(el).attr('class') || '').includes('inn-homebox__item')).each((i, el) => {
                const a = $(el).find('a').filter((j, x) => ($(x).attr('class') || '').includes('inn-homebox__item__title__link')).first();
                let href = a.attr('href') || '';
                if (!/\/\d+\.html$/.test(href)) return;
                const url = abs(base, href);
                if (seen.has(url)) return;
                seen.add(url);
                const name = clean(a.attr('title') || a.text());
                if (!name) return;
                const img = $(el).find('img').filter((j, x) => ($(x).attr('class') || '').includes('inn-homebox__item__thumbnail__img')).first();
                const coverRaw = img.attr('data-src') || img.attr('src') || '';
                const cover = coverRaw ? imgProxy(abs(base, coverRaw), base) : '';
                const latest = clean($(el).find('time').first().attr('title') || $(el).find('time').first().text()).slice(0, 24);
                items.push({ name, url, cover, latest });
            });
            return items.slice(0, 36);
        },
        async chapters(detailUrl) {
            assertSafeHost(detailUrl);
            const { $, base } = await page(detailUrl, { timeout: 25000 });
            const art = $('article[id^="post-"]').first();
            const title = clean(art.find('h1').first().text()) || clean($('title').text()).replace(/\s*–\s*次元狗.*$/, '');
            const og = $('meta[property="og:image"]').attr('content') || '';
            const cover = og ? imgProxy(abs(base, og), base) : '';
            // 无章节，只给一个「前往原站查看资源」的伪章节
            return {
                title, cover,
                chapters: [{ name: '前往原站查看网盘资源 ↗', url: detailUrl }],
                external: true,
                sourceUrl: detailUrl,
                summary: clean(art.find('.inn-singular__post__body__content').first().text()).slice(0, 600),
            };
        },
        async read(chapterUrl) {
            assertSafeHost(chapterUrl);
            // 外链源不抓正文；返回一个带原站链接的提示页（前端 iframe/新窗打开均可）
            return {
                title: '次元狗 · 资源索引',
                isHtml: true,
                external: true,
                sourceUrl: chapterUrl,
                content: '<div style="padding:24px;line-height:1.8">'
                    + '<h3>该站为网盘资源索引，不提供在线阅读</h3>'
                    + '<p>请到原站查看简介、网盘链接与提取码：</p>'
                    + '<p><a href="' + chapterUrl + '" target="_blank" rel="noopener">打开原站资源页 ↗</a></p></div>',
                chars: 40,
            };
        }
    };
    deps.ADAPTERS[adapter.id] = adapter;
    return adapter;
};
