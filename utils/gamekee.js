/**
 * utils/gamekee.js —— GameKee（www.gamekee.com）资料层
 * ------------------------------------------------------------------
 * GameKee 全站是 SPA（HTML 只有壳），但 /v1/** JSON API 全开放：
 *   · 只需要 Game-Id（任意正整数即可，不是鉴权）或 Game-Alias
 *   · 无签名、无 cookie、无 CF 挑战（/v1 由 nginx 直出）
 *   · 游戏库只有 ~466 款（GameKee 自建 wiki 的游戏），用 limit=500 一次拉全量
 *     在本地做名称/别名过滤；没有站级游戏搜索接口。
 *   · 文章正文有两种：data.content（旧 HTML）与 data.content_json（新版块数组）。
 *
 * 所有内容在服务端清洗/转义后再交给前端；缓存只在进程内，不落盘。
 */
const cheerio = require('cheerio');
const { request } = require('./updater');

const KEE = 'https://www.gamekee.com';
const GAME_ID = '50128';
const UA = 'CinemaVault/1.4 (local personal media library)';
const GAMES_TTL = 24 * 3600 * 1000;
const ARTICLE_TTL = 30 * 60 * 1000;

let gamesCache = { at: 0, list: [] };
const articleCache = new Map();
const inflight = new Map();

function fixUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (s.startsWith('//')) return 'https:' + s;
    return s;
}

/** GameKee CDN 对本机直连返回 567，必须走服务端图片代理（带应用代理、落盘缓存） */
function imgProxy(u) {
    const s = fixUrl(u);
    if (!/^https?:\/\//i.test(s)) return '';
    return '/api/acg/cover?u=' + encodeURIComponent(s);
}

async function getJson(pathname, opts = {}) {
    const r = await request(KEE + pathname, {
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Game-Id': GAME_ID,
            'Lang': 'zh-cn',
            'Referer': KEE + '/',
            ...(opts.headers || {}),
        },
        timeout: opts.timeout || 15000,
        ...(opts.noProxy ? { noProxy: true } : {}),
    }, false, null);
    if (!r || r.status >= 400) throw new Error('GameKee HTTP ' + (r && r.status));
    let j;
    try { j = JSON.parse(r.body || ''); } catch (e) { throw new Error('GameKee 响应不是 JSON'); }
    if (j && j.code != null && Number(j.code) !== 0) {
        throw new Error(j.msg || ('GameKee 错误码 ' + j.code));
    }
    return j;
}

// ---------------------------------------------------------------- 游戏库
async function games(force) {
    if (!force && gamesCache.list.length && Date.now() - gamesCache.at < GAMES_TTL) return gamesCache.list;
    const j = await getJson('/v1/gameInfo/pageList?page=1&limit=500');
    const list = (j.data || []).map((g) => ({
        id: Number(g.id),
        name: String(g.name || ''),
        alias: String(g.alias || ''),
        icon: imgProxy(g.icon),
        followCount: Number(g.follow_count) || 0,
    })).filter((g) => g.id && g.name);
    gamesCache = { at: Date.now(), list };
    return list;
}

function norm(s) {
    return String(s || '').toLowerCase().replace(/[\s·・:：\-_]+/g, '');
}

/** 本地过滤（GameKee 无站级搜索）：名称/别名包含关键词，最多 30 条 */
async function searchGames(q, force) {
    const kw = norm(q);
    const list = await games(force);
    if (!kw) return list.slice(0, 30);
    const hit = list.filter((g) => norm(g.name).includes(kw) || norm(g.alias).includes(kw));
    hit.sort((a, b) => (norm(a.name) === kw ? -1 : 0) - (norm(b.name) === kw ? -1 : 0));
    return hit.slice(0, 30);
}

async function game(id) {
    const gid = Number(id);
    if (!gid) throw new Error('缺少 game id');
    const j = await getJson('/v1/gameInfo/detail?id=' + encodeURIComponent(String(gid)));
    const d = j.data || {};
    const g = d.game || {};
    const ext = d.ext || {};
    return {
        game: {
            id: Number(g.id) || gid,
            name: String(g.name || ''),
            alias: String(g.alias || ''),
            icon: imgProxy(g.icon),
            wikiCreatedAt: Number(g.wiki_created_at) || 0,
        },
        ext: {
            developer: String(ext.developer || ''),
            pubAt: Number(ext.pub_at) || 0,
            pubArea: String(ext.pub_area || ''),
            desc: String(ext.desc || ''),
            screenshots: (ext.screen_shot || []).map((s) => imgProxy(s && s.url)).filter(Boolean).slice(0, 12),
        },
        news: (d.news_list || []).slice(0, 10).map((n) => ({
            id: Number(n.id) || 0,
            title: String(n.title || ''),
            type: Number(n.type) || 0,
            updatedAt: Number(n.updated_at) || 0,
        })),
    };
}

/** 目录树（懒加载）：pid=0 为根；点节点再请求下一层 */
async function tree(gameId, pid) {
    const gid = Number(gameId);
    if (!gid) throw new Error('缺少 game id');
    const p = Number(pid) || 0;
    const j = await getJson('/v1/entry/treesByPid?game_id=' + encodeURIComponent(String(gid)) + '&pid=' + encodeURIComponent(String(p)));
    return (j.data || []).map((n) => ({
        id: Number(n.id) || 0,
        name: String(n.name || ''),
        pid: Number(n.pid) || 0,
        type: Number(n.type) || 0,
        contentId: Number(n.content_id) || 0,
        icon: fixUrl(n.icon),
        sort: Number(n.sort) || 0,
        hasChildren: Number(n.type) !== 1 || false,
    })).filter((n) => n.id && n.name);
}

async function articles(gameId, page, limit) {
    const gid = Number(gameId);
    if (!gid) throw new Error('缺少 game id');
    const p = Math.max(1, Number(page) || 1);
    const n = Math.max(1, Math.min(40, Number(limit) || 20));
    const j = await getJson('/v1/content/pageList?game_id=' + encodeURIComponent(String(gid))
        + '&page=' + encodeURIComponent(String(p)) + '&limit=' + encodeURIComponent(String(n)));
    const meta = (j.meta && j.meta.pagination) || {};
    return {
        page: p,
        total: Number(meta.total) || 0,
        items: (j.data || []).map((a) => ({
            id: Number(a.id) || 0,
            title: String(a.title || ''),
            summary: String(a.summary || ''),
            thumb: imgProxy(a.thumb || ''),
            type: Number(a.type) || 0,
            viewCount: Number(a.view_count) || 0,
            likeCount: Number(a.like_count) || 0,
            createdAt: Number(a.created_at) || 0,
            updatedAt: Number(a.updated_at) || 0,
        })).filter((a) => a.id && a.title),
    };
}

// ---------------------------------------------------------------- 正文清洗

function safeImage(src) {
    // 统一走图片代理：源站 CDN 对本机直连返回 567，浏览器直连拿不到图
    return imgProxy(src);
}

/** 旧版 HTML 正文：去脚本/内联事件/危险协议，图片补 https、外链新窗口 */
function sanitizeHtml(html) {
    const $ = cheerio.load(String(html || ''), { decodeEntities: false });
    $('script, style, link, meta, iframe, object, embed, form, input, button, video, audio').remove();
    $('*').each((i, el) => {
        const attrs = el.attribs || {};
        Object.keys(attrs).forEach((k) => {
            if (/^on/i.test(k)) $(el).removeAttr(k);
        });
        if (el.name === 'a') {
            const href = String($(el).attr('href') || '');
            if (/^\s*javascript:/i.test(href)) $(el).removeAttr('href');
        }
    });
    $('img').each((i, el) => {
        const $el = $(el);
        const u = safeImage($el.attr('src'));
        if (!u) { $el.remove(); return; }
        $el.attr('src', u);
        $el.removeAttr('srcset');
        $el.attr('loading', 'lazy');
        $el.addClass('gk-img');
    });
    $('a').each((i, el) => {
        const $el = $(el);
        const href = String($el.attr('href') || '');
        if (/^https?:\/\//i.test(href)) {
            $el.attr('target', '_blank');
            $el.attr('rel', 'noopener noreferrer');
        }
    });
    return $.root().html() || '';
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/** 新版块 JSON：paragraph/image/heading 三种，文本全部转义 */
function renderBlocks(raw) {
    let blocks;
    try { blocks = JSON.parse(raw); } catch (e) { return ''; }
    if (!Array.isArray(blocks)) return '';
    return blocks.map((b) => {
        if (!b || typeof b !== 'object') return '';
        if (b.type === 'image') {
            const u = safeImage(b.src);
            return u ? '<p class="gk-figure"><img class="gk-img" src="' + esc(u) + '" loading="lazy" alt=""></p>' : '';
        }
        const children = Array.isArray(b.children) ? b.children : [];
        const inner = children.map((c) => {
            if (!c || typeof c !== 'object') return '';
            if (c.type === 'image') {
                const u = safeImage(c.src);
                return u ? '<img class="gk-img" src="' + esc(u) + '" loading="lazy" alt="">' : '';
            }
            const text = esc(c.text || '');
            if (!text) return '';
            return c.bold ? '<strong>' + text + '</strong>' : text;
        }).join('');
        if (!inner.trim()) return '';
        if (b.type === 'heading' || b.type === 'title') return '<h3>' + inner + '</h3>';
        return '<p>' + inner + '</p>';
    }).join('');
}

async function article(id) {
    const cid = Number(id);
    if (!cid) throw new Error('缺少文章 id');
    const key = String(cid);
    const hit = articleCache.get(key);
    if (hit && Date.now() - hit.at < ARTICLE_TTL) return hit.data;
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
        const j = await getJson('/v1/content/detail/' + encodeURIComponent(String(cid)));
        const d = j.data || {};
        const html = String(d.content || '').trim()
            ? sanitizeHtml(d.content)
            : renderBlocks(d.content_json || '');
        const data = {
            id: cid,
            title: String(d.title || (d.seo && d.seo.title) || ''),
            html,
            thumb: imgProxy(d.thumb || ''),
            video: fixUrl(d.video || ''),
            wordCount: Number(d.word_count) || 0,
            updatedAt: Number(d.updated_at) || 0,
            entryId: Number(d.entry_id) || 0,
        };
        articleCache.set(key, { data, at: Date.now() });
        while (articleCache.size > 60) articleCache.delete(articleCache.keys().next().value);
        return data;
    })().finally(() => inflight.delete(key));

    inflight.set(key, job);
    return job;
}

module.exports = { games, searchGames, game, tree, articles, article, sanitizeHtml, renderBlocks };
