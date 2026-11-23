/**
 * utils/media-sources/kazumi.js —— Kazumi 规则工厂（factoryId: 'kazumi'）
 * ---------------------------------------------------------------------------
 * 直接消费 Predidit/KazumiRules 的原始规则 JSON，不转换成 web-selector：
 *   · 以后能从 KazumiRules 拉最新规则自动救源（站点改版只需更新规则）
 *   · 搜索/剧集支持 Kazumi 的 XPath 1.0 与 JSON API 两种模式
 *   · 播放复用本项目已有的浏览器嗅探（与 Kazumi 的 WebView 嗅探同思路）
 *
 * 安全：
 *   · 规则里的请求地址只允许 https（拒绝明文，防止规则被篡改后降级）；
 *   · URL 一律用 URL 对象 + searchParams 组装，不做字符串拼接；
 *   · 只读解析，不执行规则里的任何 JS（captchaScript 一律忽略）；
 *   · 实际网络请求仍走 engine 的 grab（带协议/SSRF 校验）。
 */
const { JSDOM } = (() => {
    // 增量更新只覆盖源码、不含 node_modules：旧版本热更上来时可能还没有 jsdom。
    // 这里做优雅降级——XPath 源给出明确提示，API 源照常工作，不让整个追番崩掉。
    try { return require('jsdom'); } catch (e) { return { JSDOM: null }; }
})();

const MAX_API_LEVEL = 9;

/* ------------------------------------------------------------ 字符工具 */
/** 标识符字符：[A-Za-z0-9_$-] 与中文。逐字符判断，避免动态正则。 */
function isNameChar(ch) {
    const c = ch.charCodeAt(0);
    return (c >= 48 && c <= 57)      // 0-9
        || (c >= 65 && c <= 90)      // A-Z
        || (c >= 97 && c <= 122)     // a-z
        || c === 95 || c === 36 || c === 45
        || (c >= 0x4e00 && c <= 0x9fa5);
}

function isIdentName(s) {
    if (!s) return false;
    const c0 = s.charCodeAt(0);
    const startsAlpha = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
    if (!startsAlpha) return false;
    for (let i = 1; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return false;
    }
    return true;
}

function textOf(node) {
    if (!node) return '';
    return String(node.textContent || '').replace(/\s+/g, ' ').trim();
}

function attrOf(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return '';
    return node.getAttribute(name) || '';
}

function absUrl(href, base) {
    const h = String(href || '').trim();
    if (!h) return '';
    try {
        const u = new URL(h, base || undefined);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        return u.toString();
    } catch (e) { return ''; }
}

/* -------------------------------------------------------------- XPath */
function makeDom(html) {
    if (!JSDOM) throw new Error('XPath 源需要完整更新到最新版（缺少 jsdom 依赖）');
    return new JSDOM(String(html || ''), { contentType: 'text/html' });
}

function xpathAll(dom, expr, ctxNode) {
    const exprStr = String(expr || '').trim();
    if (!exprStr) return [];
    const doc = dom.window.document;
    try {
        const XR = dom.window.XPathResult;
        const r = doc.evaluate(exprStr, ctxNode || doc, null, XR.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = [];
        for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
        return out;
    } catch (e) { return []; }
}

function xpathFirst(dom, expr, ctxNode) {
    const a = xpathAll(dom, expr, ctxNode);
    return a.length ? a[0] : null;
}

/* ----------------------------------------------------------- JSONPath */
/**
 * 受限 JSONPath：只支持 $ / .field / [n] / [*] / ['key']。
 * 手写字符扫描（不用正则），与 Kazumi 规则校验口径一致。
 */
function jpath(root, expr) {
    const p = String(expr || '').trim();
    if (p[0] !== '$') return { all: [], one: undefined };
    const tokens = [];
    let i = 1;
    while (i < p.length) {
        const ch = p[i];
        if (ch === '.') {
            i++;
            const start = i;
            while (i < p.length && isNameChar(p[i])) i++;
            if (i === start) return { all: [], one: undefined };
            tokens.push({ k: 'key', v: p.slice(start, i) });
        } else if (ch === '[') {
            i++;
            while (i < p.length && p[i] === ' ') i++;
            const c = p[i];
            if (c === '*') { tokens.push({ k: 'star' }); i++; }
            else if (c === "'" || c === '"') {
                const q = c;
                i++;
                const start = i;
                while (i < p.length && p[i] !== q) i++;
                tokens.push({ k: 'key', v: p.slice(start, i) });
                i++;
            } else {
                const start = i;
                while (i < p.length && p[i] >= '0' && p[i] <= '9') i++;
                if (i === start) return { all: [], one: undefined };
                tokens.push({ k: 'idx', v: Number(p.slice(start, i)) });
            }
            while (i < p.length && p[i] === ' ') i++;
            if (p[i] !== ']') return { all: [], one: undefined };
            i++;
        } else {
            return { all: [], one: undefined };
        }
    }

    let cur = [root];
    for (const t of tokens) {
        const next = [];
        for (const v of cur) {
            if (v == null) continue;
            if (t.k === 'key') { if (v[t.v] !== undefined) next.push(v[t.v]); }
            else if (t.k === 'idx') { if (Array.isArray(v) && v[t.v] !== undefined) next.push(v[t.v]); }
            else if (t.k === 'star') {
                if (Array.isArray(v)) next.push(...v);
                else if (typeof v === 'object') next.push(...Object.values(v));
            }
        }
        cur = next;
    }
    return { all: cur, one: cur.length ? cur[0] : undefined };
}

/* ------------------------------------------------------------- 模板 */
/** @keyword/@source/@episodeUrl/...；单独 "@var" 保留原类型。 */
function fillTemplate(value, vars) {
    if (value == null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    if (trimmed.length > 1 && trimmed[0] === '@') {
        const name = trimmed.slice(1);
        if (isIdentName(name) && Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    }
    const parts = value.split('@');
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) {
        const seg = parts[i];
        let j = 0;
        while (j < seg.length && isNameChar(seg[j]) && seg[j] !== '-' && seg[j] !== '$') j++;
        const name = seg.slice(0, j);
        if (name && isIdentName(name) && Object.prototype.hasOwnProperty.call(vars, name)) {
            const val = vars[name];
            out += (val == null ? '' : String(val));
        } else {
            out += '@';
        }
        out += seg.slice(j);
    }
    return out;
}

/** 从详情页 URL 按 sourceTemplate 的 @source 位置截取（纯字符串，不用正则）。 */
function sourceFromDetail(template, detailUrl) {
    const t = String(template || '');
    const u = String(detailUrl || '');
    const marker = '@source';
    if (!t || !u) return '';
    const at = t.indexOf(marker);
    if (at < 0) return '';
    const prefix = t.slice(0, at);
    const suffix = t.slice(at + marker.length);
    if (!u.startsWith(prefix) || !u.endsWith(suffix)) return '';
    const raw = u.slice(prefix.length, u.length - suffix.length);
    if (!raw) return '';
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

/** 兜底：取详情页 URL 里最后一个长度 >=2 的数字段。 */
function digSourceId(detailUrl) {
    const s = String(detailUrl || '');
    let best = '';
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 48 && c <= 57) { cur += s[i]; continue; }
        if (cur.length >= 2) best = cur;
        cur = '';
    }
    if (cur.length >= 2) best = cur;
    return best;
}

/* ------------------------------------------------------------- 请求 */
function headersOf(rule, req) {
    const h = {};
    const ua = String(rule.userAgent || '').trim();
    if (ua) h['User-Agent'] = ua;
    const ref = String(rule.referer || rule.baseURL || '').trim();
    if (ref) h.Referer = ref;
    if (req && req.headers && typeof req.headers === 'object') {
        for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string' && k) h[k] = fillTemplate(v, {});
        }
    }
    return h;
}

function assertHttps(url) {
    try { return new URL(url).protocol === 'https:'; } catch (e) { return false; }
}

function buildUrl(req, vars) {
    let u;
    try { u = new URL(String(fillTemplate(String(req.url || ''), vars))); } catch (e) { return ''; }
    const q = req.query && typeof req.query === 'object' ? req.query : {};
    for (const [k, v] of Object.entries(q)) {
        const val = fillTemplate(v, vars);
        if (val == null || val === '') continue;
        u.searchParams.set(k, String(val));
    }
    return u.toString();
}

function buildBody(req, vars, headers) {
    const bt = String(req.bodyType || 'none');
    if (bt === 'json') {
        headers['Content-Type'] = 'application/json';
        if (typeof req.body === 'string') return fillTemplate(req.body, vars);
        return JSON.stringify(req.body || {});
    }
    if (bt === 'form') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        if (typeof req.body === 'string') return fillTemplate(req.body, vars);
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(req.body || {})) sp.set(k, String(fillTemplate(v, vars)));
        return sp.toString();
    }
    return undefined;
}

/* ------------------------------------------------------------- 搜索 */
async function search(rule, keyword, opts = {}) {
    const grab = opts.grab;
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], error: '', state: 'noResult' };

    if (String(rule.searchMode || 'xpath') === 'api') {
        const cfg = rule.searchApiConfig || {};
        const req = cfg.request || {};
        const vars = { keyword: kw };
        const url = buildUrl(req, vars);
        if (!assertHttps(url)) return { items: [], error: '规则请求不是 https，已拒绝', state: 'error' };
        const headers = headersOf(rule, req);
        const body = buildBody(req, vars, headers);
        const r = await grab(url, {
            timeout: opts.timeout || 15000,
            method: String(req.method || 'GET').toUpperCase(),
            body,
            headers,
        });
        if (!r.ok || !r.text) {
            return { items: [], error: r.error || ('HTTP ' + r.status), state: (r.status === 403 || r.status === 429) ? 'captcha' : 'error' };
        }
        let data;
        try { data = JSON.parse(r.text); } catch (e) {
            return { items: [], error: '响应不是 JSON（可能被 WAF 拦截）', state: 'noResult' };
        }
        const list = jpath(data, cfg.listPath || '$.data[*]').all;
        const namePath = cfg.namePath || '$.name';
        const srcPath = cfg.sourcePath || '$.url';
        const tpl = cfg.sourceTemplate || '';
        const out = [];
        for (const it of list) {
            const rawName = jpath(it, namePath).one;
            const name = String(rawName == null ? '' : rawName).replace(/\s+/g, ' ').trim();
            const src = jpath(it, srcPath).one;
            if (!name || src == null) continue;
            const rawUrl = tpl ? String(fillTemplate(tpl, { source: src })) : String(src);
            const abs = absUrl(rawUrl, rule.baseURL);
            if (!abs || out.some((x) => x.url === abs)) continue;
            out.push({ name, url: abs });
        }
        return { items: out, error: out.length ? '' : 'JSONPath 没取到条目', state: out.length ? 'success' : 'noResult' };
    }

    const url = String(fillTemplate(String(rule.searchURL || ''), { keyword: encodeURIComponent(kw) }));
    if (!assertHttps(url)) return { items: [], error: '规则请求不是 https，已拒绝', state: 'error' };
    const r = await grab(url, { timeout: opts.timeout || 15000, headers: headersOf(rule, null) });
    if (!r.ok || !r.text) {
        return { items: [], error: r.error || ('HTTP ' + r.status), state: (r.status === 403 || r.status === 429) ? 'captcha' : 'error' };
    }
    const dom = makeDom(r.text);
    const nodes = xpathAll(dom, rule.searchList);
    const out = [];
    for (const n of nodes) {
        const nameNode = xpathFirst(dom, rule.searchName, n);
        const resExpr = String(rule.searchResult || '.').trim();
        const resNode = resExpr === '.' ? n : xpathFirst(dom, rule.searchResult, n);
        const href = attrOf(resNode, 'href') || attrOf(n, 'href');
        const abs = absUrl(href, rule.baseURL);
        const name = textOf(nameNode) || textOf(n);
        if (!abs || !name) continue;
        if (out.some((x) => x.url === abs)) continue;
        out.push({ name, url: abs });
    }
    return { items: out, error: out.length ? '' : 'XPath 没匹配到条目（站点可能改版）', state: out.length ? 'success' : 'noResult' };
}

/* ------------------------------------------------------------- 剧集 */
function splitDelimited(roadNames, roadEps, cfg) {
    const sepRoad = cfg.roadSeparator || '$$$';
    const sepEp = cfg.episodeSeparator || '#';
    const sepField = cfg.fieldSeparator || '$';
    const names = String(roadNames || '').split(sepRoad);
    const roads = String(roadEps || '').split(sepRoad);
    const out = [];
    roads.forEach((roadStr, ri) => {
        const channel = String(names[ri] || ('线路' + (ri + 1))).trim();
        String(roadStr).split(sepEp).forEach((seg) => {
            const parts = String(seg).split(sepField);
            const name = String(parts[0] || '').trim();
            const page = String(parts[1] || '').trim();
            if (!page) return;
            out.push({ name: name || ('第' + (out.length + 1) + '集'), page, channel });
        });
    });
    return out;
}

async function episodes(rule, detailUrl, opts = {}) {
    const grab = opts.grab;
    const base = rule.baseURL || '';

    if (String(rule.chapterMode || 'xpath') === 'api') {
        const cfg = rule.chapterApiConfig || {};
        const req = cfg.request || {};
        const src = sourceFromDetail((rule.searchApiConfig || {}).sourceTemplate, detailUrl) || digSourceId(detailUrl);
        const vars = { source: src, episodeUrl: detailUrl };
        const url = buildUrl(req, vars);
        if (!assertHttps(url)) return { episodes: [], error: '规则请求不是 https，已拒绝', state: 'error' };
        const headers = headersOf(rule, req);
        const body = buildBody(req, vars, headers);
        const r = await grab(url, { timeout: opts.timeout || 15000, method: String(req.method || 'GET').toUpperCase(), body, headers });
        if (!r.ok || !r.text) return { episodes: [], error: r.error || ('HTTP ' + r.status), state: 'error' };
        let data;
        try { data = JSON.parse(r.text); } catch (e) { return { episodes: [], error: '响应不是 JSON', state: 'noResult' }; }

        const eps = [];
        if (String(cfg.format || 'delimited') === 'nested') {
            const roads = jpath(data, cfg.roadsPath || '$[*]').all;
            const epPath = cfg.episodesPath || '$.episodes[*]';
            roads.forEach((road, ri) => {
                const chRaw = jpath(road, cfg.roadNamePath || '$.name').one;
                const channel = String(chRaw || ('线路' + (ri + 1)));
                const list = jpath(road, epPath).all;
                list.forEach((e, ei) => {
                    const nRaw = jpath(e, cfg.episodeNamePath || '$.title').one;
                    const name = String(nRaw || ('第' + (ei + 1) + '集'));
                    const raw = jpath(e, cfg.episodeUrlPath || '$.url').one;
                    if (raw == null) return;
                    let page;
                    if (cfg.episodePage && cfg.episodePage.url) {
                        page = String(fillTemplate(String(cfg.episodePage.url), {
                            source: src, episodeUrl: raw, roadIndex: ri, roadNumber: ri + 1,
                            episodeIndex: ei, episodeNumber: ei + 1,
                        }));
                    } else {
                        page = String(raw);
                    }
                    const abs = absUrl(page, base);
                    if (abs) eps.push({ name, page: abs, channel });
                });
            });
        } else {
            const names = jpath(data, cfg.roadNamesPath || '$.info.vod_play_from').one;
            const roadEps = jpath(data, cfg.roadEpisodesPath || '$.info.vod_play_url').one;
            eps.push(...splitDelimited(names, roadEps, cfg));
            if (cfg.episodePage && cfg.episodePage.url) {
                for (const e of eps) {
                    e.page = String(fillTemplate(String(cfg.episodePage.url), { source: src, episodeUrl: e.page }));
                }
            }
        }
        const out = eps.map((e) => ({
            name: e.name, sort: NaN, channel: e.channel, url: absUrl(e.page, base),
        })).filter((e) => e.url);
        return { episodes: out, error: out.length ? '' : 'API 章节为空', state: out.length ? 'success' : 'noResult' };
    }

    const r = await grab(detailUrl, { timeout: opts.timeout || 15000, headers: headersOf(rule, null) });
    if (!r.ok || !r.text) return { episodes: [], error: r.error || ('HTTP ' + r.status), state: 'error' };
    const dom = makeDom(r.text);
    const roads = xpathAll(dom, rule.chapterRoads);
    const out = [];
    roads.forEach((road, ri) => {
        const links = xpathAll(dom, rule.chapterResult, road);
        links.forEach((a) => {
            const abs = absUrl(attrOf(a, 'href'), base);
            const name = textOf(a) || ('第' + (out.length + 1) + '集');
            if (abs) out.push({ name, sort: NaN, channel: '线路' + (ri + 1), url: abs });
        });
    });
    return { episodes: out, error: out.length ? '' : 'XPath 没匹配到剧集（站点可能改版）', state: out.length ? 'success' : 'noResult' };
}

/* ------------------------------------------------------------- 播放 */
/**
 * Kazumi 规则本身不产出 m3u8：它把播放页交给 WebView 嗅探。
 * 这里复用本项目 browser-resolve（Playwright 监听媒体请求），思路一致。
 */
async function resolve(rule, episodeUrl, opts = {}) {
    const br = require('./browser-resolve');
    const referer = String(rule.referer || rule.baseURL || '');
    const r = await br.resolveByBrowser(episodeUrl, { timeout: opts.timeout || 40000, referer });
    if (r && r.url) {
        return { url: r.url, headers: { Referer: referer }, via: 'kazumi-browser' };
    }
    return { url: '', error: (r && r.error) || '浏览器没嗅到视频流（可能需要人机验证）' };
}

module.exports = {
    MAX_API_LEVEL,
    search,
    episodes,
    resolve,
    _jpath: jpath,
    _fillTemplate: fillTemplate,
    _sourceFromDetail: sourceFromDetail,
    _splitDelimited: splitDelimited,
};
