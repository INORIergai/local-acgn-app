/**
 * utils/wiki.js —— 萌娘百科（Moegirlpedia）资料层
 * ------------------------------------------------------------------
 * 站点能力（2026-11 实测）：
 *   · 主站 zh.moegirl.org.cn 只放行 opensearch / query(prop=extracts|pageimages)
 *     / meta=siteinfo；action=parse、list=search 被 MediaWiki 侧禁用
 *     （返回 action-notallowed，不是 Cloudflare，换 UA/POST 都无效）。
 *   · 镜像 moegirl.uk / moegirl.icu 的 action=parse、list=search 全可用；
 *     但镜像 /images/ 被 Cloudflare 403，图片要改写回 storage.moegirl.org.cn。
 *
 * 所以组合是：
 *   搜索 = 主站 opensearch（快）+ 镜像 list=search（补全/摘要）
 *   正文 = 镜像 parse&prop=text|sections（失败再试另一个镜像）
 *   封面 = 主站 pageimages（storage CDN 无水印挑战）
 *
 * HTML 在服务端清洗（去脚本/导航框/编辑链接/引用，重写图片与内链），
 * 前端只负责排版，不直接 innerHTML 未清洗的远程内容。
 * 正文缓存在进程内（LRU 40 篇 / 7 天），不落盘、不涉及用户可控路径。
 */
const cheerio = require('cheerio');
const { request } = require('./updater');

const MAIN = 'https://zh.moegirl.org.cn';
const MIRRORS = ['https://moegirl.uk', 'https://moegirl.icu'];
const STORAGE = 'https://storage.moegirl.org.cn/moegirl/commons';
const UA = 'CinemaVault/1.4 (local personal media library)';
const PAGE_TTL = 7 * 24 * 3600 * 1000;
const PAGE_CACHE_MAX = 40;

const pageCache = new Map();   // title -> { data, at }
const inflight = new Map();    // title -> Promise（并发点同一篇只打一次源站）

async function getText(url, opts = {}) {
    const r = await request(url, {
        headers: Object.assign({
            'User-Agent': UA,
            'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
        }, opts.headers || {}),
        timeout: opts.timeout || 15000,
        ...(opts.noProxy ? { noProxy: true } : {}),
    }, false, null);
    if (!r || r.status >= 400) throw new Error('HTTP ' + (r && r.status));
    return r.body || '';
}

async function getJson(url, opts) {
    return JSON.parse(await getText(url, opts));
}

/** 主站/镜像都试一遍：先走应用代理，失败再直连（镜像常在代理规则之外） */
async function getJsonBoth(url, timeout) {
    try { return await getJson(url, { timeout }); }
    catch (e) { return await getJson(url, { timeout, noProxy: true }); }
}

// ---------------------------------------------------------------- 搜索
function stripTags(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/**
 * 标题/全文搜索。返回 [{title, snippet, source}]。
 * 主站 opensearch 只搜标题但快且无风控；镜像全文搜索补摘要与重定向后的条目。
 */
async function search(q) {
    const kw = String(q || '').trim();
    if (!kw) return [];
    const out = new Map();

    try {
        const j = await getJsonBoth(MAIN + '/api.php?action=opensearch&search=' + encodeURIComponent(kw) + '&limit=10&format=json', 10000);
        const titles = (j && j[1]) || [];
        const descs = (j && j[2]) || [];
        titles.forEach((t, i) => {
            if (!t) return;
            out.set(t, { title: t, snippet: stripTags(descs[i] || ''), source: 'moegirl' });
        });
    } catch (e) { /* opensearch 失败不阻塞 */ }

    for (const base of MIRRORS) {
        if (out.size >= 8) break;
        try {
            const j = await getJsonBoth(base + '/api.php?action=query&list=search&srsearch=' + encodeURIComponent(kw)
                + '&srlimit=10&srprop=snippet%7Ctitlesnippet&format=json&utf8=1', 15000);
            const rows = (j && j.query && j.query.search) || [];
            rows.forEach((s) => {
                if (!s || !s.title || out.has(s.title)) return;
                out.set(s.title, { title: s.title, snippet: stripTags(s.snippet || ''), source: 'moegirl' });
            });
            if (rows.length) break;
        } catch (e) { /* 下一个镜像 */ }
    }
    return [...out.values()].slice(0, 20);
}

// ---------------------------------------------------------------- 图片/链接改写
/** 镜像 /images/... → storage.moegirl.org.cn/moegirl/commons/...（镜像图片本身 403） */
function rewriteImage(src) {
    let u = String(src || '').trim();
    if (!u) return '';
    if (u.startsWith('//')) u = 'https:' + u;
    if (/^https?:\/\//i.test(u)) return u;
    const m = u.match(/^\/images\/(thumb\/)?([0-9a-fA-F])\/([0-9a-fA-F]{2})\/([^/?#]+)(?:\/([^?#]+))?/i);
    if (!m) return '';
    const kind = m[1] ? 'thumb/' : '';
    const tail = m[5] ? '/' + m[5] : '';
    return STORAGE + '/' + kind + m[2].toLowerCase() + '/' + m[3].toLowerCase() + '/' + m[4] + tail;
}

const SKIP_NS = /^(File|Image|Template|Category|Special|Help|MediaWiki|Talk|User|萌娘百科|模块|分类|文件|模板|帮助|特殊):/i;

/**
 * 服务端清洗 remote HTML：
 *   · 删除 script/style/meta/iframe/object/embed/form 与所有 on* 事件属性
 *   · 删除编辑链接、目录、导航框、引用、维护模板、消歧义提示
 *   · 图片改写为 storage CDN；内链改成 data-wiki-title，由前端走站内打开
 *   · 外链补 target=_blank rel=noopener
 */
function sanitizeArticle(html) {
    const $ = cheerio.load(String(html || ''), { decodeEntities: false });

    $('script, style, link, meta, noscript, iframe, object, embed, form, input, button').remove();
    $('.mw-editsection, .mw-editsection-bracket, #toc, .toc, .navbox, .navbox-styles,'
        + ' .reference, .references, .mw-references-wrap, .mw-cite-backlink,'
        + ' .ambox, .metadata, .noprint, .dablink, .hatnote, .zero-fill, .mw-empty-elt,'
        + ' .printfooter, .catlinks, .mw-hidden-catlinks,'
        + ' .infoBox-unfinished, .infoBox-notice, .infoBox-warning, .infoBox-outdated, .infoBox-stub,'
        + ' [typeof*="mw:Error"]').remove();
    $('table').each((i, el) => {
        const cls = $(el).attr('class') || '';
        if (/navbox|vertical-navbox|metadata/i.test(cls)) $(el).remove();
    });
    /* infoBox 不是资料框（资料框是 table.moe-infobox），而是维护/剧透提示条：
     * 只删「参与完善 / 编辑本条目 / 剧透 / 消歧义 / 施工中」这几类，避免误删正文。 */
    $('.infoBox').each((i, el) => {
        const t = $(el).text();
        if (/参与完善|编辑本条目|剧透成分|消歧义|正在施工|需要补充|内容含有/.test(t)) $(el).remove();
    });
    // Tab 组件：保留内容、去掉标签壳
    $('.TabLabelText').remove();

    $('*').each((i, el) => {
        const attrs = el.attribs || {};
        Object.keys(attrs).forEach((k) => {
            if (/^on/i.test(k)) $(el).removeAttr(k);
        });
    });

    $('img').each((i, el) => {
        const $el = $(el);
        if ($el.hasClass('mw-broken-media')) { $el.remove(); return; }
        const fixed = rewriteImage($el.attr('src'));
        if (!fixed) { $el.remove(); return; }
        $el.attr('src', fixed);
        $el.removeAttr('srcset');
        $el.attr('loading', 'lazy');
        $el.attr('referrerpolicy', 'no-referrer');
        $el.addClass('wiki-img');
    });

    $('a').each((i, el) => {
        const $el = $(el);
        const href = String($el.attr('href') || '').trim();
        if (!href || href.startsWith('#')) return;
        /* 红链/编辑链接/特殊页：只保留文字，不做成可点条目（否则会跳到 index.php） */
        if (/action=edit|redlink=1/i.test(href) || $el.hasClass('new') || /^\/index\.php/i.test(href)) {
            $el.replaceWith($el.text());
            return;
        }
        if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
            $el.attr('href', href.startsWith('//') ? 'https:' + href : href);
            $el.attr('target', '_blank');
            $el.attr('rel', 'noopener noreferrer');
            return;
        }
        if (!href.startsWith('/')) { $el.removeAttr('href'); return; }
        let t = href.slice(1).split('#')[0];
        try { t = decodeURIComponent(t); } catch (e) { /* 保留原样 */ }
        t = t.replace(/_/g, ' ').trim();
        if (!t || SKIP_NS.test(t)) { $el.removeAttr('href'); return; }
        $el.attr('href', '#');
        $el.attr('data-wiki-title', t);
        $el.addClass('wiki-link');
    });

    const body = $('.mw-parser-output').first();
    return (body.length ? body.html() : $.root().html()) || '';
}

// ---------------------------------------------------------------- 正文
async function fetchParse(title) {
    let lastErr = null;
    for (const base of MIRRORS) {
        try {
            const url = base + '/api.php?action=parse&page=' + encodeURIComponent(title)
                + '&prop=text%7Csections&redirects=1&format=json&utf8=1&disableeditsection=1';
            const j = await getJsonBoth(url, 25000);
            if (j && j.parse && j.parse.text && j.parse.text['*']) {
                return { base, parse: j.parse };
            }
            lastErr = new Error((j && j.error && j.error.info) || '镜像没有返回正文');
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error('萌娘百科镜像不可达');
}

/** 主站 extracts：镜像全挂时的纯文本兜底（只有导语） */
async function fetchExtracts(title) {
    const j = await getJsonBoth(MAIN + '/api.php?action=query&titles=' + encodeURIComponent(title)
        + '&prop=extracts&explaintext=1&format=json&redirects=1', 15000);
    const pages = (j && j.query && j.query.pages) || {};
    const first = Object.keys(pages).map((k) => pages[k])[0];
    return (first && first.extract) || '';
}

async function fetchCover(title) {
    try {
        const j = await getJsonBoth(MAIN + '/api.php?action=query&titles=' + encodeURIComponent(title)
            + '&prop=pageimages&pithumbsize=480&format=json&formatversion=2&redirects=1', 12000);
        const p = (j && j.query && j.query.pages && j.query.pages[0]) || {};
        return (p.thumbnail && p.thumbnail.source) || '';
    } catch (e) {
        return '';
    }
}

function readCache(title) {
    const hit = pageCache.get(title);
    if (!hit) return null;
    if (Date.now() - hit.at > PAGE_TTL) { pageCache.delete(title); return null; }
    // 命中后移到队尾（Map 保持插入顺序，实现简易 LRU）
    pageCache.delete(title);
    pageCache.set(title, hit);
    return hit.data;
}

function writeCache(title, data) {
    pageCache.set(title, { data, at: Date.now() });
    while (pageCache.size > PAGE_CACHE_MAX) {
        const oldest = pageCache.keys().next().value;
        pageCache.delete(oldest);
    }
}

/**
 * 取一篇文章的完整可渲染正文。
 * @returns {{title, html, sections, cover, sourceUrl, fetchedAt, cached, fallback}}
 */
async function page(titleIn) {
    const title = String(titleIn || '').trim();
    if (!title) throw new Error('缺少条目名');
    const hit = readCache(title);
    if (hit) return { ...hit, cached: true };
    if (inflight.has(title)) return inflight.get(title);

    const job = (async () => {
        const [{ base, parse }, cover] = await Promise.all([
            fetchParse(title),
            fetchCover(title),
        ]);
        const displayTitle = parse.title || title;
        const html = sanitizeArticle(parse.text['*']);
        const sections = (parse.sections || [])
            .filter((s) => s && (s.level === '2' || s.level === '3') && s.line
                && !/^(参考资料|注释|外部链接|导航|参见)$/.test(s.line))
            .slice(0, 60)
            .map((s) => ({ line: s.line, anchor: s.anchor || '', level: Number(s.level) || 2, number: s.number || '' }));
        const data = {
            title: displayTitle,
            requestedTitle: title,
            html,
            sections,
            cover,
            sourceUrl: base + '/' + encodeURIComponent(displayTitle),
            fetchedAt: Date.now(),
            fallback: false,
        };
        writeCache(title, data);
        if (displayTitle !== title) writeCache(displayTitle, data);
        return { ...data, cached: false };
    })().finally(() => inflight.delete(title));

    inflight.set(title, job);
    return job;
}

/** 正文兜底：镜像都挂时只给导语纯文本（仍按段落排版，不注入远程 HTML） */
async function pageFallback(titleIn) {
    const title = String(titleIn || '').trim();
    const text = await fetchExtracts(title);
    if (!text) throw new Error('没有取到条目内容');
    const html = text.split(/\n{2,}/).map((p) => '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;') + '</p>').join('');
    return {
        title,
        requestedTitle: title,
        html,
        sections: [],
        cover: await fetchCover(title),
        sourceUrl: MAIN + '/' + encodeURIComponent(title),
        fetchedAt: Date.now(),
        fallback: true,
    };
}

module.exports = { search, page, pageFallback, rewriteImage, sanitizeArticle };
