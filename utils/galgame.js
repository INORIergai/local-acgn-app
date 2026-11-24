/**
 * utils/galgame.js —— GALGAME 资料层（Kungal 主源 / InariGal 直链补充）
 * ------------------------------------------------------------------
 * 站点选择（2026-11 实测）：
 *   · Kungal  www.kungal.com/api/v1/*  → 匿名 JSON，无 CF 挑战，分页/排序/详情/
 *     资源/下载发券全可用。作品元数据来自其 Catalog 服务（id 就是 work id）。
 *     robots.txt 明确 Disallow /api，所以这里只做「按需 + 进程内缓存」，不批量爬。
 *   · InariGal inarigal.com/api/*      → Nuxt 同源 JSON，无 CF；列表/详情/搜索/
 *     下载榜可用，下载是 302 直链文件。列表/详情是 POST JSON。
 *   · TouchGal touchgal.ink            → 整站 Cloudflare Managed Challenge（含 /api），
 *     纯 HTTP 与无头浏览器都是 403；只作为外部入口展示，等用户配置开发者 Token
 *     后再接 developer.touchgal.com。
 *
 * 所有远程内容只在本模块归一化；正文简介是纯文本（Kungal 的 intro / Inari 的
 * content 都是文本，不含 HTML），前端按段落排版，不注入远程 HTML。
 */
const { request } = require('./updater');

const KUNGAL = 'https://www.kungal.com';
const INARI = 'https://inarigal.com';
const UA = 'CinemaVault/1.4 (local personal media library)';
const LIST_TTL = 10 * 60 * 1000;
const DETAIL_TTL = 30 * 60 * 1000;

const cache = new Map();

function cached(key, ttl, loader) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
    return loader().then((data) => {
        cache.set(key, { at: Date.now(), data });
        while (cache.size > 120) cache.delete(cache.keys().next().value);
        return data;
    });
}

async function getJson(url, opts = {}) {
    const r = await request(url, {
        headers: Object.assign({
            'User-Agent': UA,
            'Accept': 'application/json',
        }, opts.headers || {}),
        timeout: opts.timeout || 20000,
        ...(opts.noProxy ? { noProxy: true } : {}),
    }, false, null);
    if (!r || r.status >= 400) throw new Error('HTTP ' + (r && r.status));
    let j;
    try { j = JSON.parse(r.body || ''); } catch (e) { throw new Error('响应不是 JSON'); }
    return j;
}

/** 代理/直连双试：Kungal 与 Inari 都有被代理规则绕过的可能 */
async function getJsonBoth(url, opts = {}) {
    try { return await getJson(url, opts); }
    catch (e) { return await getJson(url, Object.assign({}, opts, { noProxy: true })); }
}

async function postJson(url, body, opts = {}) {
    const r = await request(url, {
        method: 'POST',
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body || {}),
        timeout: opts.timeout || 20000,
        ...(opts.noProxy ? { noProxy: true } : {}),
    }, false, null);
    if (!r || r.status >= 400) throw new Error('HTTP ' + (r && r.status));
    try { return JSON.parse(r.body || ''); } catch (e) { throw new Error('响应不是 JSON'); }
}

async function postJsonBoth(url, body, opts = {}) {
    try { return await postJson(url, body, opts); }
    catch (e) { return await postJson(url, body, Object.assign({}, opts, { noProxy: true })); }
}

function fixUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (s.startsWith('//')) return 'https:' + s;
    return s;
}

/** 浏览器直连 Kungal 图床会被热链策略拦掉（元素在，图裂），统一走服务端图片代理 */
function imgProxy(u) {
    const s = fixUrl(u);
    if (!/^https?:\/\//i.test(s)) return '';
    return '/api/acg/cover?u=' + encodeURIComponent(s);
}

// ================================================================
// Kungal
// ================================================================
function kungalLocalized(w, lang) {
    if (!w || !w.localized) return '';
    const v = w.localized[lang];
    return (v && v.value) ? String(v.value) : '';
}

function kungalScore(w) {
    if (w && typeof w.rating_score === 'number' && w.rating_score > 0) {
        return { score: Number(w.rating_score.toFixed(1)), count: Number(w.rating_count) || 0, site: 'kungal' };
    }
    const ext = (w && w.external_ratings) || [];
    const vndb = ext.find((x) => x && x.site === 'vndb' && typeof x.rating_value === 'number');
    if (vndb) return { score: Number(vndb.rating_value.toFixed(1)), count: Number(vndb.vote_count) || 0, site: 'vndb' };
    return null;
}

function kungalWork(w) {
    const cover = imgProxy((w.cover_sfw && w.cover_sfw.url) || (w.cover && w.cover.url) || '');
    const banner = imgProxy((w.banner && w.banner.url) || '');
    const maker = w.maker ? (w.maker.display_name || '') : '';
    return {
        source: 'kungal',
        id: String(w.id || ''),
        title: kungalLocalized(w, 'zh-Hans') || w.display_name || '',
        titleJp: kungalLocalized(w, 'ja') || w.display_name || '',
        titleEn: kungalLocalized(w, 'en') || '',
        cover,
        banner,
        nsfw: !!w.is_nsfw || w.content_rating === 'r18',
        date: w.release_date || '',
        maker,
        platforms: w.resource_platforms || [],
        languages: w.resource_languages || [],
        views: Number(w.view_count) || 0,
        likes: Number(w.like_count) || 0,
        rating: kungalScore(w),
    };
}

function docText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(docText).join('');
    if (typeof node === 'object') {
        if (typeof node.value === 'string') return node.value;
        return docText(node.children || []);
    }
    return '';
}

function kungalResource(r) {
    const typeMap = {
        game: '本体', patch: '补丁', collection: '合集', crack_fix: '破解修正',
        mod: 'MOD', tool: '工具', walkthrough: '攻略', ost: 'OST',
        voice: '语音', cg: 'CG', wallpaper: '壁纸', artbook: '画集',
        video: '视频', other: '其他',
    };
    return {
        source: 'kungal',
        id: String(r.id || ''),
        title: String(r.title || '') || ((typeMap[r.resource_type] || '资源') + (r.version_label ? ' · ' + r.version_label : '')),
        type: r.resource_type || '',
        typeLabel: typeMap[r.resource_type] || r.resource_type || '资源',
        languages: (r.resource_languages || []).map((x) => ({ 'zh-cn': '中文', 'zh-hans': '中文', 'zh-tw': '繁中', 'zh-hant': '繁中', ja: '日语', 'ja-jp': '日语', en: '英语' }[String(x).toLowerCase()] || x)),
        platforms: (r.resource_platforms || []).map((x) => ({ win: 'Windows', mac: 'macOS', android: 'Android', ios: 'iOS', linux: 'Linux', web: '网页' }[String(x).toLowerCase()] || x)),
        size: String(r.size || ''),
        providers: r.provider_names || [],
        state: r.state || '',
        downloads: Number(r.download_count) || 0,
        createdAt: r.created_at || '',
        note: docText(r.content || '').trim().slice(0, 300),
    };
}

async function kungalList({ page = 1, limit = 24, sort = 'resource_updated_desc', q = '', nsfw = false } = {}) {
    const p = Math.max(1, Number(page) || 1);
    const n = Math.max(1, Math.min(60, Number(limit) || 24));
    const key = `k:list:${p}:${n}:${sort}:${q}:${nsfw ? 1 : 0}`;
    return cached(key, LIST_TTL, async () => {
        const common = 'page=' + encodeURIComponent(String(p)) + '&limit=' + encodeURIComponent(String(n))
            + '&include_nsfw=' + (nsfw ? 'true' : 'false');
        let j;
        if (q) {
            j = await getJsonBoth(KUNGAL + '/api/v1/search/works?q=' + encodeURIComponent(q)
                + '&' + common + '&sort=' + encodeURIComponent('relevance_desc'));
        } else {
            j = await getJsonBoth(KUNGAL + '/api/v1/works?' + common + '&sort=' + encodeURIComponent(sort));
        }
        return {
            source: 'kungal',
            page: p,
            total: Number(j.total) || 0,
            items: (j.items || []).map(kungalWork).filter((x) => x.id && x.title),
        };
    });
}

async function kungalDetail(id) {
    const wid = String(id || '');
    if (!/^\d+$/.test(wid)) throw new Error('id 不合法');
    return cached('k:detail:' + wid, DETAIL_TTL, async () => {
        const w = await getJsonBoth(KUNGAL + '/api/v1/works/' + wid);
        const base = kungalWork(w);
        const intro = (w.intros || []).find((x) => x && /^zh/i.test(String(x.locale || '')))
            || (w.intros || []).find((x) => x && /^en/i.test(String(x.locale || '')))
            || (w.intros || [])[0];
        return Object.assign(base, {
            intro: intro ? String(intro.value || '').trim() : '',
            aliases: w.aliases || [],
            tags: (w.tags || []).map((t) => t && t.display_name).filter(Boolean).slice(0, 14),
            companies: (w.companies || []).map((c) => c && c.display_name).filter(Boolean).slice(0, 6),
            screenshots: (w.screenshots || []).map((s) => imgProxy(s && s.image && s.image.url)).filter(Boolean).slice(0, 12),
            contentRating: w.content_rating || '',
            resourceTypes: w.resource_types || [],
        });
    });
}

async function kungalResources(id, page = 1, limit = 30) {
    const wid = String(id || '');
    if (!/^\d+$/.test(wid)) throw new Error('id 不合法');
    return cached(`k:res:${wid}:${page}:${limit}`, LIST_TTL, async () => {
        const j = await getJsonBoth(KUNGAL + '/api/v1/works/' + wid + '/resources?page='
            + encodeURIComponent(String(page)) + '&limit=' + encodeURIComponent(String(limit)));
        return {
            total: Number(j.total) || 0,
            items: (j.items || []).map(kungalResource).filter((x) => x.id),
        };
    });
}

async function kungalDownload(resourceId) {
    const rid = String(resourceId || '');
    if (!/^\d+$/.test(rid)) throw new Error('资源 id 不合法');
    const j = await postJsonBoth(KUNGAL + '/api/v1/galgame-resources/' + rid + '/downloads', {});
    return {
        source: 'kungal',
        urls: (j.download_urls || []).map(fixUrl).filter(Boolean),
        expired: (j.expired_download_urls || []).map(fixUrl).filter(Boolean),
        code: String(j.extraction_code || ''),
        password: String(j.archive_password || ''),
    };
}

// ================================================================
// InariGal
// ================================================================
function inariWork(a) {
    return {
        source: 'inari',
        id: String(a.id || ''),
        title: String(a.title_cn || a.title || ''),
        titleJp: String(a.title_jp || ''),
        cover: imgProxy(a.cover_url || ''),
        banner: '',
        nsfw: String(a.nsfw || 'no') !== 'no',
        date: '',
        maker: Array.isArray(a.developer_name) ? a.developer_name.join(' / ') : String(a.developer_name || ''),
        platforms: [],
        languages: [],
        views: Number(a.scan_count) || 0,
        likes: 0,
        downloads: Number(a.download_count) || 0,
        rating: null,
    };
}

async function inariList({ page = 1, pageSize = 24, q = '' } = {}) {
    const key = `i:list:${page}:${pageSize}:${q}`;
    return cached(key, LIST_TTL, async () => {
        const j = q
            ? await postJsonBoth(INARI + '/api/search', { q, page, pageSize })
            : await postJsonBoth(INARI + '/api/home/list', { page, pageSize });
        const d = j.data || {};
        const rows = d.list || j.list || [];
        return {
            source: 'inari',
            page: Number(page) || 1,
            total: Number((d.pagination && d.pagination.total) || j.total) || 0,
            items: rows.map(inariWork).filter((x) => x.id && x.title),
        };
    });
}

async function inariRank() {
    return cached('i:rank', LIST_TTL, async () => {
        const j = await getJsonBoth(INARI + '/api/ranking/downloads');
        const rows = j.data || [];
        return { source: 'inari', items: rows.map(inariWork).filter((x) => x.id && x.title).slice(0, 30) };
    });
}

const INARI_GROUP_LABEL = {
    translated: '汉化版', original: '原版', ai_translated: 'AI 翻译', patch: '补丁',
    attachment: '附件', other: '其他',
};

async function inariDetail(id) {
    const gid = Number(id);
    if (!gid) throw new Error('id 不合法');
    return cached('i:detail:' + gid, DETAIL_TTL, async () => {
        const j = await postJsonBoth(INARI + '/api/pages/detail', { id: gid });
        const d = j.data || {};
        const a = d.article || {};
        const base = inariWork(a);
        const groups = d.downloads || {};
        const resources = [];
        Object.keys(groups).forEach((g) => {
            (groups[g] || []).forEach((r) => {
                resources.push({
                    source: 'inari',
                    id: String(r.id || ''),
                    group: g,
                    groupLabel: INARI_GROUP_LABEL[g] || g,
                    title: String(r.resource_title || '') || (INARI_GROUP_LABEL[g] || '资源'),
                    note: String(r.resource_content || '').trim().slice(0, 300),
                    size: String(r.size || ''),
                    downloads: Number(r.download_count) || 0,
                    password: String(r.unzip_password || ''),
                    platforms: ['pc', 'apk', 'krkr', 'tyranornext', 'renpy', 'ons', 'ar']
                        .filter((k) => r['is_' + k]).map((k) => k === 'pc' ? 'PC' : k.toUpperCase()),
                    state: 'valid',
                });
            });
        });
        return Object.assign(base, {
            intro: String(a.content || '').trim(),
            aliases: [],
            tags: (Array.isArray(d.pageTags) ? d.pageTags : [])
                .map((t) => t && (t.name || t.nameCn)).filter(Boolean).slice(0, 14),
            companies: [],
            screenshots: [],
            characters: (Array.isArray(d.characters) ? d.characters : []).slice(0, 12).map((c) => ({
                name: c.displayName || c.translatedName || c.originalName || '',
                image: imgProxy(c.imagePath || ''),
                role: c.role || '',
                desc: String(c.description || '').slice(0, 200),
            })),
            resources,
            contentRating: base.nsfw ? 'r18' : '',
        });
    });
}

/** Inari 直链：/api/getdownload/{id} 是 302 到 CDN 文件 */
async function inariDownloadUrl(resourceId) {
    const rid = Number(resourceId);
    if (!rid) throw new Error('资源 id 不合法');
    const url = INARI + '/api/getdownload/' + rid;
    try {
        const r = await fetch(url, {
            redirect: 'manual',
            headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': INARI + '/' },
            signal: AbortSignal.timeout(20000),
        });
        const loc = r.headers.get('location');
        if (loc) return /^https?:\/\//i.test(loc) ? loc : new URL(loc, INARI).href;
        if (r.status >= 200 && r.status < 300) return url;
        throw new Error('HTTP ' + r.status);
    } catch (e) {
        // 拿不到跳转地址时把源站入口交给前端（浏览器点开同样会 302）
        return url;
    }
}

// ================================================================
// 对外
// ================================================================
async function sourcesStatus() {
    return {
        kungal: { available: true, label: 'Kungal', note: '社区作品库 · 匿名 API · 网盘下载' },
        inari: { available: true, label: 'InariGal', note: '资料库 · 直链下载' },
        touchgal: {
            available: false,
            label: 'TouchGal',
            note: '整站 Cloudflare 挑战，需要 developer.touchgal.com 的 tgal_ Token 才能接入',
            url: 'https://www.touchgal.ink/',
        },
    };
}

module.exports = {
    kungalList, kungalDetail, kungalResources, kungalDownload,
    inariList, inariRank, inariDetail, inariDownloadUrl,
    sourcesStatus,
};
