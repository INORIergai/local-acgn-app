/**
 * 轻小说文库（wenku8.cc 镜像）在线阅读适配器
 * ------------------------------------------------------------------
 * 主站 wenku8.net 被 Cloudflare 质询；.cc 镜像详情页/章节正文公开（GBK，由
 * engine.decode 按 meta charset 解码）。打包 TXT/UMD/JAR 在登录墙后，不接。
 * 安全：所有外链图片走 imgProxy；章节 href 只接受 /novel/ 相对路径。
 */
'use strict';
const net = require('node:net');

// 只允许 wenku8.cc 域名；仅 https + 拒绝内网/回环（SSRF 防线）
function assertWenkuHost(raw) {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') throw new Error('仅允许 https');
    const h = u.hostname.toLowerCase();
    if (h !== 'www.wenku8.cc' && h !== 'wenku8.cc') throw new Error('源不在白名单');
    if (net.isIP(h)) throw new Error('拒绝 IP 直连');
    return u;
}

module.exports = function registerWenku8(deps) {
    const { page, clean, abs, imgProxy } = deps;

    const adapter = {
        id: 'wenku8',
        name: '轻小说文库',
        kind: 'novel',
        catalogUrl: 'https://www.wenku8.cc/',
        async catalog() {
            const { $, base } = await page('https://www.wenku8.cc/sitemap.xml', { timeout: 25000 });
            const locs = $('loc').map((i, el) => clean($(el).text())).get();
            const seen = new Set();
            const items = [];
            for (const loc of locs) {
                const m = /\/book\/(\d+)\.htm$/.exec(loc);
                if (!m || seen.has(m[1])) continue;
                seen.add(m[1]);
                items.push({ name: '书籍 ' + m[1], url: abs(base, loc), cover: '', latest: '' });
                if (items.length >= 36) break;
            }
            return items;
        },
        async chapters(detailUrl) {
            assertWenkuHost(detailUrl);
            const { $, base } = await page(detailUrl, { timeout: 25000 });
            const title = clean($('title').text()).split(' - ')[0] || clean($('h1').first().text());
            const chapters = [];
            const seen = new Set();
            const chapterHref = /^\/novel\/\d+\/\d+\/\d+\.htm/;
            const addFrom = (doc) => {
                doc('a[href]').each((i, el) => {
                    const href = doc(el).attr('href') || '';
                    if (!chapterHref.test(href) || seen.has(href)) return;
                    seen.add(href);
                    chapters.push({ name: clean(doc(el).text()) || '正文', url: abs(base, href) });
                });
            };
            addFrom($);
            if (!chapters.length) {
                let idx = '';
                $('a[href]').each((i, el) => {
                    const href = $(el).attr('href') || '';
                    if (/^\/novel\/\d+\/\d+\/index\.htm/.test(href) && !idx) idx = abs(base, href);
                });
                if (idx) { const r = await page(idx, { timeout: 25000 }); addFrom(r.$); }
            }
            return { title, cover: '', chapters };
        },
        async read(chapterUrl) {
            assertWenkuHost(chapterUrl);
            const { $, base } = await page(chapterUrl, { timeout: 30000 });
            const title = clean($('title').text()).split(' - ')[0];
            const body = $('#content').first();
            body.find('script, iframe, object, embed, link, style').remove();
            body.find('*').each((i, el) => {
                const attrs = el.attribs || {};
                Object.keys(attrs).forEach((k) => {
                    if (/^on/i.test(k)) delete attrs[k];
                    if (k === 'href' && /^javascript:/i.test(attrs[k] || '')) attrs[k] = '#';
                });
            });
            body.find('img').each((i, el) => {
                const src = abs(base, el.attribs['data-src'] || el.attribs.src || '');
                if (src) $(el).attr('src', imgProxy(src, base)).removeAttr('data-src');
            });
            return { title, isHtml: true, content: body.html() || '', chars: body.text().trim().length };
        }
    };
    deps.ADAPTERS[adapter.id] = adapter;
    return adapter;
};
