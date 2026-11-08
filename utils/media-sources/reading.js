/**
 * 在线阅读适配器（r155 · 阶段3）
 * ------------------------------------------------------------------
 * 和引擎里「视频」那套（剧集 + m3u8）并列，这里只做两件事：
 *   catalogOf(sourceId)              → 源站目录条目
 *   readChapter(sourceId, url, ...)  → 一章的结构化内容（漫画图片数组 / 小说正文 HTML）
 *
 * 适配器按 sourceId 注册，站点改版只改一个适配器的选择器，不动路由与前端。
 *
 * ★ 为什么不用 webview 的无头浏览器：实测 dm5 / kmoe / ESJ 直连就能拿到
 *   完整 HTML（含带 key 的真实图片地址），用引擎的 grab 走 undici + 代理
 *   已经够用，冷启动从 10~20s 降到 0.3~1s。
 */
const cheerio = require('cheerio');
const engine = require('./engine');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 抓页面；相对地址统一按最终 URL 解析 */
async function page(url, opts = {}) {
    const r = await engine.grab(url, {
        timeout: opts.timeout || 20000,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        referer: opts.referer || url
    });
    if (!r.ok || !r.text) {
        throw new Error(r.error || ('HTTP ' + r.status));
    }
    return { $: cheerio.load(r.text), base: url, html: r.text, buf: r.buf };
}

function abs(base, href) {
    try { return new URL(href, base).href; } catch (e) { return ''; }
}

function clean(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

/** 图片统一走同源字节代理：源站有 Referer / UA 防盗链，浏览器 <img> 带不上 */
function imgProxy(u, referer, ticket) {
    return '/api/media-source/seg?u=' + encodeURIComponent(u) + '&ref=' + encodeURIComponent(referer || '')
        + (ticket ? '&xt=' + encodeURIComponent(ticket) : '');
}

async function apiJson(url, opts = {}) {
    const r = await engine.grab(url, {
        method: opts.method,
        body: opts.body,
        timeout: opts.timeout || 20000,
        headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json,*/*' }, opts.headers || {}),
        referer: opts.referer || url
    });
    if (!r.ok || !r.text) throw new Error(r.error || ('HTTP ' + r.status));
    const j = JSON.parse(r.text);
    if (j.errno !== undefined && j.errno !== 0) throw new Error(j.errmsg || '接口返回错误');
    return j;
}

// ==================================================================
// 适配器：DM5（动漫屋）
// ==================================================================
const dm5 = {
    id: 'dm5',
    name: '动漫屋',
    kind: 'manga',
    catalogUrl: 'https://www.dm5.com/manhua-new/',
    async catalog() {
        const { $, base } = await page(this.catalogUrl, { timeout: 25000 });
        const seen = new Set();
        const items = [];
        // 页面有两套卡片：顶部特装卡 <a><p.mh-cover>…，以及更新列表
        // <div.mh-item><p.mh-cover>…<h2.title><a>。旧代码只遍历 <a> 内部，
        // 更新列表的封面在兄弟节点里，所以只抓到顶部 7 条。
        $('a[href^="/manhua-"][title]').each((i, el) => {
            const href = $(el).attr('href') || '';
            if (!/^\/manhua-[a-z0-9]+\/?$/.test(href) || seen.has(href)) return;
            const card = $(el).closest('li, .swiper-slide');
            const scope = card.length ? card : $(el).parent();
            const img = scope.find('img').first();
            const bg = /url\((['"]?)([^'")]+)\1\)/.exec(scope.find('.mh-cover').attr('style') || '');
            const cover = abs(base, img.attr('data-src') || img.attr('src') || (bg && bg[2]) || '');
            const name = clean($(el).attr('title') || $(el).text() || img.attr('alt') || '');
            if (!name || !cover || /mrtx|loading|qrcode|logo/i.test(cover)) return;
            seen.add(href);
            items.push({
                name,
                url: abs(base, href),
                cover: imgProxy(cover, base),
                latest: clean(scope.find('.chapter').text() || scope.find('.zl').text()).slice(0, 40)
            });
        });
        return items.slice(0, 36);
    },
    async chapters(detailUrl) {
        const { $, base } = await page(detailUrl, { timeout: 25000 });
        // h1/h2 在详情页被「登录」「看过…还看过」占了，书名只在 <title> 里最稳
        const title = clean($('title').text()).split('漫画_')[0] || clean($('h1, h2').first().text());
        const bg = /url\((['"]?)([^'")]+)\1\)/.exec($('.mh-cover, .detail-cover').first().attr('style') || '');
        const cover = abs(base, $('.detail-cover img, .banner img').first().attr('src') || (bg && bg[2]) || $('meta[property="og:image"]').attr('content') || '');
        const seen = new Set();
        const chapters = [];
        $('a[href]').each((i, el) => {
            const href = $(el).attr('href') || '';
            if (!/^\/m\d+\/?$/.test(href) || seen.has(href)) return;
            const label = clean($(el).text());
            if (!/第\s*\d+/.test(label)) return;
            seen.add(href);
            chapters.push({ name: label.split(/\s{2,}/)[0], url: abs(base, href) });
        });
        // 站点默认倒序（最新在前），阅读顺序翻回正序
        const num = (s) => parseFloat((/第\s*(\d+(?:\.\d+)?)/.exec(s) || [])[1] || 0);
        chapters.sort((a, b) => num(a.name) - num(b.name));
        return { title, cover: cover ? imgProxy(cover, base) : '', chapters };
    },
    async read(chapterUrl) {
        const { $, base, html } = await page(chapterUrl, { timeout: 25000 });
        const title = clean($('title').text()).split('_')[0] || clean($('.read_title').text());
        const imgs = [];
        const seen = new Set();
        $('img').each((i, el) => {
            const src = abs(base, el.attribs['data-src'] || el.attribs.src || '');
            if (!/^https?:/.test(src) || seen.has(src)) return;
            if (/mrtx|loading|qrcode|logo|icon|banner/i.test(src)) return;
            // 章节图带 ?cid=…&key=…，别丢 query
            if (!/cdndm5\.com|cdndm\d*\.com|\/m?\d+\//i.test(src) && !/\.(jpe?g|png|webp)$/i.test(src)) return;
            seen.add(src);
            imgs.push(imgProxy(src, base));
        });
        // 有的页把图塞在 script 里，兜一层
        if (!imgs.length) {
            const m = html.match(/var\s+chapterImages\s*=\s*(\[[^\]]*\])/);
            if (m) {
                try {
                    JSON.parse(m[1].replace(/\\\//g, '/')).forEach((p) => {
                        if (p) imgs.push(imgProxy(abs(base, p), base));
                    });
                } catch (e) { /* 解析不了就给空，前端会提示 */ }
            }
        }
        return { title, pages: imgs };
    }
};

// ==================================================================
// 适配器：ESJ Zone（原创 / 翻译轻小说）
// ==================================================================
const esj = {
    id: 'esjzone',
    name: 'ESJ Zone',
    kind: 'novel',
    catalogUrl: 'https://www.esjzone.cc/list-1/',
    async catalog() {
        const { $, base } = await page(this.catalogUrl, { timeout: 25000 });
        // 同一本书有「封面链接 + 标题链接」两个 a，按 href 合并，别只看第一个空文本链接
        const byHref = new Map();
        $('a[href*="/detail/"]').each((i, el) => {
            const href = abs(base, $(el).attr('href') || '');
            if (!/\/detail\/\d+\.html$/.test(href)) return;
            const rec = byHref.get(href) || { name: '', url: href, cover: '', latest: '' };
            const card = $(el).closest('.card, article, li, .product-item');
            const scope = card.length ? card : $(el).closest('div');
            // 封面是 .lazyload[data-src] 的 div，不是 <img>（这就是之前整墙空白的原因）
            const lazy = scope.find('.lazyload[data-src], img[data-src], img').first();
            const rawCover = lazy.attr('data-src') || lazy.attr('src') || '';
            if (!rec.cover && rawCover) rec.cover = abs(base, rawCover);
            if (!rec.name) rec.name = clean($(el).text() || $(el).attr('title') || scope.find('.card-title').text());
            if (!rec.latest) rec.latest = clean(scope.find('.card-ep a').first().text()).slice(0, 40);
            byHref.set(href, rec);
        });
        const items = [];
        byHref.forEach((rec) => {
            if (!rec.name) return;
            const cover = rec.cover;
            items.push({
                name: rec.name, url: rec.url,
                cover: cover && !/placeholder|no-cover|empty\.jpg|\.html?$/i.test(cover) ? imgProxy(cover, base) : '',
                latest: rec.latest
            });
        });
        return items.slice(0, 36);
    },
    async chapters(detailUrl) {
        const { $, base } = await page(detailUrl, { timeout: 25000 });
        const title = clean($('h2').first().text()) || clean($('title').text()).split(' - ')[0];
        // ESJ 的 og:image 有时填的是详情页地址本身，别拿 HTML 去当封面
        const og = abs(base, $('meta[property="og:image"]').attr('content') || '');
        const cover = /\.(jpe?g|png|webp|gif)(\?|$)/i.test(og) && og !== detailUrl ? og : '';
        const chapters = [];
        $('#chapterList a[href]').each((i, el) => {
            const href = abs(base, $(el).attr('href') || '');
            if (!/\/forum\/\d+\/\d+\.html$/.test(href)) return;
            // 站内标题是「书名 - 第N章 xxx」，去掉书名前缀
            const label = clean($(el).text()).replace(/^.*?\s-\s/, '');
            chapters.push({ name: label, url: href });
        });
        return { title, cover: cover ? imgProxy(cover, base) : '', chapters };
    },
    async read(chapterUrl) {
        const { $, base } = await page(chapterUrl, { timeout: 30000 });
        const title = clean($('title').text()).split(' - ESJ')[0] || clean($('h2').first().text());
        const body = $('.forum-content').first();
        // 源站正文是第三方 HTML，进 innerHTML 前先掐掉脚本 / 内联事件 / 内嵌框架
        body.find('script, iframe, object, embed, link, style').remove();
        body.find('*').each((i, el) => {
            const attrs = el.attribs || {};
            Object.keys(attrs).forEach((k) => {
                if (/^on/i.test(k)) delete attrs[k];
                if (k === 'href' && /^javascript:/i.test(attrs[k] || '')) attrs[k] = '#';
            });
        });
        // 站内插图也是防盗链，换成同源代理
        body.find('img').each((i, el) => {
            const src = abs(base, el.attribs['data-src'] || el.attribs.src || '');
            if (src) $(el).attr('src', imgProxy(src, base)).removeAttr('data-src');
        });
        return {
            title,
            isHtml: true,
            content: body.html() || '',
            chars: body.text().trim().length
        };
    }
};

// ==================================================================
// 适配器：再漫画（Nuxt 站，直接走公开 JSON 接口）
// ==================================================================
const zaimanhua = {
    id: 'zaimanhua',
    name: '再漫画',
    kind: 'manga',
    catalogUrl: 'https://manhua.zaimanhua.com/',
    apiBase: 'https://manhua.zaimanhua.com/api/v1',
    async catalog() {
        const j = await apiJson(this.apiBase + '/comic2/update_list?status&theme&zone&cate&firstLetter&sortType&page=1&size=36', { referer: this.catalogUrl });
        const list = (j.data && j.data.comicList) || [];
        return list.map((it) => ({
            name: clean(it.name),
            url: 'https://manhua.zaimanhua.com/details/' + it.id,
            cover: it.cover ? imgProxy(it.cover, this.catalogUrl) : '',
            latest: clean(it.last_update_chapter_name || '')
        }));
    },
    async chapters(detailUrl) {
        const id = (/(\d+)/.exec(String(detailUrl).split('/details/')[1] || '') || [])[1];
        if (!id) throw new Error('作品地址里没有 id');
        const j = await apiJson(this.apiBase + '/comic2/comic/detail?channel=pc&app_name=zmh&version=1.0.0&uid=0&id=' + id, { referer: detailUrl });
        const info = (j.data && j.data.comicInfo) || {};
        const chapters = [];
        (info.chapterList || []).forEach((group) => {
            (group.data || []).forEach((c) => {
                chapters.push({
                    name: clean(c.chapter_title),
                    url: 'https://manhua.zaimanhua.com/view/' + encodeURIComponent(info.comicPy) + '/' + info.id + '/' + c.chapter_id,
                    order: Number(c.chapter_order) || 0
                });
            });
        });
        chapters.sort((a, b) => a.order - b.order);
        return { title: clean(info.title), cover: '', chapters };
    },
    async read(chapterUrl) {
        const m = /\/view\/[^/]+\/(\d+)\/(\d+)/.exec(chapterUrl);
        if (!m) throw new Error('章节地址无法解析');
        const j = await apiJson(this.apiBase + '/comic2/chapter/detail?channel=pc&app_name=zmh&version=1.0.0&uid=0'
            + '&comic_id=' + m[1] + '&chapter_id=' + m[2], { referer: chapterUrl });
        const info = (j.data && j.data.chapterInfo) || {};
        const pages = (info.page_url || []).map((u) => imgProxy(u, 'https://manhua.zaimanhua.com/'));
        return { title: clean(info.title), pages };
    }
};

// ==================================================================
// 适配器：Komiic（GraphQL，图片要带 X-Image-Ticket）
// ==================================================================
const komiic = {
    id: 'komiic',
    name: 'Komiic',
    kind: 'manga',
    catalogUrl: 'https://komiic.com/',
    async gql(query) {
        const j = await apiJson('https://komiic.com/api/query', {
            method: 'POST',
            body: JSON.stringify({ operationName: null, variables: {}, query }),
            headers: { 'Content-Type': 'application/json' },
            referer: 'https://komiic.com/',
            timeout: 25000
        });
        if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
        return j.data || {};
    },
    async catalog() {
        const d = await this.gql('query { recentUpdate(pagination:{limit:36,offset:0,orderBy:DATE_UPDATED,asc:false}) '
            + '{ id title imageUrl lastChapterUpdate authors { name } } }');
        return (d.recentUpdate || []).map((it) => ({
            name: clean(it.title),
            url: 'https://komiic.com/comics/' + it.id,
            cover: it.imageUrl ? imgProxy(it.imageUrl, 'https://komiic.com/') : '',
            latest: it.lastChapterUpdate ? ('更新至 ' + it.lastChapterUpdate) : '',
            author: clean(((it.authors || [])[0] || {}).name || '')
        }));
    },
    async chapters(detailUrl) {
        const comicId = (/\/(\d+)/.exec(String(detailUrl).replace(/^https?:\/\/[^/]+/, '')) || [])[1];
        if (!comicId) throw new Error('作品地址里没有 id');
        const d = await this.gql('query { comicById(comicId:"' + comicId + '") { title imageUrl description authors { name } } '
            + 'chaptersByComicId(comicId:"' + comicId + '") { id serial type size } }');
        const info = d.comicById || {};
        const chapters = (d.chaptersByComicId || []).map((c) => ({
            name: (c.type === 'volume' ? '卷 ' : '第 ') + clean(c.serial) + (c.type === 'volume' ? '' : ' 话'),
            url: 'https://komiic.com/comics/' + comicId + '/chapter/' + c.id,
            order: parseFloat(c.serial) || 0
        }));
        chapters.sort((a, b) => a.order - b.order);
        return {
            title: clean(info.title),
            cover: info.imageUrl ? imgProxy(info.imageUrl, 'https://komiic.com/') : '',
            chapters
        };
    },
    async read(chapterUrl) {
        const chapterId = (/\/(\d+)\/?$/.exec(chapterUrl) || [])[1];
        if (!chapterId) throw new Error('章节地址无法解析');
        const comicId = (/\/(\d+)\/chapter\//.exec(chapterUrl) || [])[1];
        const d = await this.gql('query { imagesByChapterId(chapterId:"' + chapterId + '") { kid orderNumber } '
            + (comicId ? 'chapterById(comicId:"' + comicId + '", chapterId:"' + chapterId + '") { serial type } ' : '')
            + 'imageTicketsByChapterId(chapterId:"' + chapterId + '") { kid ticket url } }');
        const tickets = {};
        (d.imageTicketsByChapterId || []).forEach((t) => { tickets[t.kid] = t; });
        const imgs = (d.imagesByChapterId || []).slice().sort((a, b) => a.orderNumber - b.orderNumber);
        const pages = imgs.map((im) => {
            const t = tickets[im.kid];
            return t
                ? imgProxy(t.url || ('https://komiic.com/api/image/' + im.kid), 'https://komiic.com/', t.ticket)
                : '';
        }).filter(Boolean);
        const ch = d.chapterById || {};
        const title = ch.serial
            ? (ch.type === 'volume' ? '卷 ' + clean(ch.serial) : '第 ' + clean(ch.serial) + ' 話')
            : '第 ' + chapterId + ' 話';
        return { title, pages };
    }
};

// ==================================================================
// 适配器：轻之国度（HTML 直取，正文在 .reader-text）
// ==================================================================
const lightnovel = {
    id: 'lightnovel',
    name: '轻之国度',
    kind: 'novel',
    catalogUrl: 'https://www.lightnovel.fun/',
    async catalog() {
        const { $, base } = await page(this.catalogUrl, { timeout: 25000 });
        const byId = new Map();
        $('a[href^="/book/"]').each((i, el) => {
            const href = abs(base, $(el).attr('href') || '');
            const id = (/\/book\/(\d+)/.exec(href) || [])[1];
            if (!id) return;
            const rec = byId.get(id) || { name: '', url: href, cover: '', latest: '' };
            const card = $(el).closest('article, .mini-book, li, .book-item');
            const scope = card.length ? card : $(el).closest('div');
            const img = scope.find('img.pc-book-cover-img, img').first();
            const rawCover = img.attr('src') || img.attr('data-src') || '';
            if (!rec.cover && rawCover) rec.cover = abs(base, rawCover);
            if (!rec.name) rec.name = clean($(el).text() || card.find('h1,h2,h3,.book-title').first().text());
            if (!rec.latest) rec.latest = clean(card.find('.book-status, .book-meta, .update').first().text()).slice(0, 40);
            byId.set(id, rec);
        });
        return Array.from(byId.values()).filter((it) => it.name).slice(0, 36).map((it) => ({
            ...it,
            cover: it.cover ? imgProxy(it.cover, base) : ''
        }));
    },
    async chapters(detailUrl) {
        const { $, base } = await page(detailUrl, { timeout: 25000 });
        const id = (/\/book\/(\d+)/.exec(detailUrl) || [])[1];
        const title = clean($('h1').first().text()) || clean($('meta[property="og:title"]').attr('content') || '').split('-轻之国度')[0];
        const cover = abs(base, $('meta[property="og:image"]').attr('content') || '');
        const seen = new Set();
        const chapters = [];
        $(`a[href*="/reader/${id}/"]`).each((i, el) => {
            const href = abs(base, $(el).attr('href') || '');
            if (!new RegExp('/reader/' + id + '/\\d+').test(href) || seen.has(href)) return;
            seen.add(href);
            chapters.push({ name: clean($(el).text()) || '正文', url: href });
        });
        return { title, cover: cover ? imgProxy(cover, base) : '', chapters };
    },
    async read(chapterUrl) {
        const { $, base } = await page(chapterUrl, { timeout: 30000 });
        const title = clean($('h1').first().text()) || clean($('title').text()).split('-轻之国度')[0];
        const body = $('.reader-text').first();
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
        return {
            title,
            isHtml: true,
            content: body.html() || '',
            chars: body.text().trim().length
        };
    }
};

const ADAPTERS = {};
[dm5, zaimanhua, komiic, esj, lightnovel].forEach((a) => { ADAPTERS[a.id] = a; });

// 目录页每次抓都要 2~13s，短缓存 5 分钟；打开阅读页时只等一次
const CAT_TTL = 5 * 60 * 1000;
const catCache = new Map();

async function catalogCached(id, force) {
    const ad = ADAPTERS[id];
    if (!ad) return null;
    const hit = catCache.get(id);
    if (!force && hit && Date.now() - hit.at < CAT_TTL) return hit.items;
    let items;
    try {
        items = await ad.catalog();
    } catch (e) {
        // 本机代理经常在生产服务的第一个请求上握手失败，直连补发已经由 engine 做过；
        // 目录只有一次机会的话整面墙会直接报错，这里再等半秒补一次。
        await new Promise((r) => setTimeout(r, 500));
        items = await ad.catalog();
    }
    // 空列表多半是代理/源站一次抽风，缓存 5 分钟会让整面墙一直空着。
    if (items && items.length) catCache.set(id, { at: Date.now(), items });
    return items;
}

function getAdapter(id) {
    return ADAPTERS[String(id || '').toLowerCase()] || null;
}

function listAdapters() {
    return Object.values(ADAPTERS).map((a) => ({ id: a.id, name: a.name, kind: a.kind, catalogUrl: a.catalogUrl }));
}

module.exports = { getAdapter, listAdapters, imgProxy, catalogCached };
