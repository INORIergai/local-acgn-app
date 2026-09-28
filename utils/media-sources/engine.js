/**
 * 站点解析器引擎（round36 批次B）
 * ------------------------------------------------------------------
 * 把「在线观看」从「内嵌别人的网页」升级为「自己解析别人的网页」：
 *   搜番（多源并发）→ 选集 → 抽出 m3u8/mp4 → 应用内 hls.js 播放 + 弹幕
 *
 * 源定义格式直接沿用 animeko 官方订阅仓库（creamycake-anime/animeko-subs）的
 * **声明式 JSON**：一份 JSON 描述「搜哪个 URL、用哪些 CSS 选择器、怎么抽真流地址」，
 * 不写一行站点专用代码。改版时刷新订阅就能跟上，不用等应用发版。
 *
 * 支持两类 factoryId：
 *   web-selector —— 网页站（v2 格式：subjectFormat / channelFormat / matchVideo）
 *   rss          —— BT 聚合站的 RSS（AnimeGarden 等），只出磁力链接
 *
 * 两条硬经验（round35 留下的）：
 *   1) 请求必须「代理失败→直连」双路。本机代理经常是死的，只走代理会把好站全探成坏站。
 *   2) 解析出的 m3u8 几乎都带 Referer 校验，浏览器 <video> 又不能自定义请求头，
 *      所以流必须走后端代理（见 routes/media-source.js 的 /stream、/seg）。
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const config = require('../config');

// 内置源定义目录（随应用打包）
const BUILTIN_DIR = path.join(__dirname, 'subs');
// 订阅刷新下来的覆盖目录（应用可写；exe 装在只读目录时也走得通）
const OVERRIDE_DIR = path.join(__dirname, '..', '..', 'data', 'media-sources', 'subs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ==================================================================
// 网络层：代理 / 直连 双路
// ==================================================================
let _proxyDispatcher = null;
function proxyDispatcher() {
    const px = config.network && config.network.proxyServer;
    if (!px) return undefined;
    if (!_proxyDispatcher) {
        try {
            const { ProxyAgent } = require('undici');
            _proxyDispatcher = new ProxyAgent(px);
        } catch (e) {
            _proxyDispatcher = false;   // undici 不可用 → 只走直连
        }
    }
    return _proxyDispatcher || undefined;
}

/**
 * 抓一个 URL，返回 { ok, status, buf, text, headers, error }。
 * 代理配了就先走代理；代理层炸了（拒连 / 502 / 超时 / SSL 被掐）立刻直连补一发。
 */
async function grab(url, opts = {}) {
    const timeout = opts.timeout || 15000;
    const headers = Object.assign({ 'User-Agent': UA, 'Accept': '*/*' }, opts.headers || {});
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.cookie) headers.Cookie = opts.cookie;
    const init = { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) };

    let lastErr = null;
    const attempts = [];
    const px = proxyDispatcher();
    if (px) attempts.push({ ...init, dispatcher: px });
    attempts.push(init);

    for (const a of attempts) {
        try {
            const r = await fetch(url, a);
            const buf = Buffer.from(await r.arrayBuffer());
            const ctype = r.headers.get('content-type') || '';
            return { ok: r.status < 400, status: r.status, buf, ctype, text: decode(buf, ctype), headers: r.headers };
        } catch (e) {
            lastErr = e;
        }
    }
    return { ok: false, status: 0, buf: null, ctype: '', text: '', error: (lastErr && lastErr.message) || 'network error' };
}

/** 按 Content-Type / meta charset 解码（国内站相当一部分还是 GBK，硬按 utf-8 解会全是豆腐块） */
function decode(buf, ctype) {
    let cs = '';
    const m = /charset=([\w-]+)/i.exec(ctype || '');
    if (m) cs = m[1];
    if (!cs) {
        const head = buf.slice(0, 2048).toString('latin1');
        const m2 = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head);
        if (m2) cs = m2[1];
    }
    cs = (cs || 'utf-8').toLowerCase();
    try {
        if (iconv.encodingExists(cs)) return iconv.decode(buf, cs);
    } catch (e) { /* 落到 utf-8 */ }
    return buf.toString('utf8');
}

// ==================================================================
// 源定义加载
// ==================================================================
let _sources = null;

function walk(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (name.endsWith('.json')) out.push(p);
    }
    return out;
}

/**
 * 加载全部源。override 目录（订阅刷新下来的）覆盖同名的内置源 —— 按文件路径的
 * 相对部分去重，所以刷新后新版本立刻生效，不用重启也不用发版。
 */
function loadSources(force) {
    if (_sources && !force) return _sources;
    const files = [];
    walk(BUILTIN_DIR, files);
    const over = [];
    walk(OVERRIDE_DIR, over);

    const map = new Map();
    const addFile = (file, baseDir, origin) => {
        const rel = path.relative(baseDir, file).replace(/\\/g, '/');
        let def;
        try {
            def = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return;
        }
        const args = def.arguments || {};
        const sc = args.searchConfig || {};
        const host = hostOf(sc.searchUrl || '');
        const rec = {
            id: rel.replace(/\.json$/, ''),
            name: args.name || rel.replace(/\.json$/, ''),
            description: args.description || '',
            iconUrl: args.iconUrl || '',
            factoryId: def.factoryId,
            version: def.version || 1,
            kind: def.factoryId === 'rss' ? 'bt' : 'web',
            tier: typeof args.tier === 'number' ? args.tier : 9,
            host,
            searchUrl: sc.searchUrl || '',
            origin,
            def
        };
        // override 覆盖 builtin：后写的赢
        if (origin === 'override' || !map.has(rec.id)) map.set(rec.id, rec);
    };
    files.forEach((f) => addFile(f, BUILTIN_DIR, 'builtin'));
    over.forEach((f) => addFile(f, OVERRIDE_DIR, 'override'));

    _sources = Array.from(map.values()).sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'web' ? -1 : 1;
        if (a.tier !== b.tier) return a.tier - b.tier;
        return a.name.localeCompare(b.name, 'zh');
    });
    return _sources;
}

function getSource(id) {
    return loadSources().find((s) => s.id === id);
}

function hostOf(u) {
    try { return new URL(u).host; } catch (e) { return ''; }
}

/** 绝对化：相对链接按 searchUrl 的 origin 或 rawBaseUrl 拼 */
function absUrl(link, source) {
    if (!link) return '';
    if (/^https?:\/\//i.test(link)) return link;
    const sc = source.def.arguments.searchConfig || {};
    const base = sc.rawBaseUrl || (sc.searchUrl || '');
    try { return new URL(link, base).href; } catch (e) { return link; }
}

// ==================================================================
// 搜索
// ==================================================================
function firstWord(kw) {
    const k = String(kw || '').trim();
    const m = k.split(/[\s　]+/);
    return m[0] || k;
}

/** 从 HTML/文本里抽 URL 候选（用于 nested url 与视频地址） */
function urlCandidates(text) {
    const out = [];
    const re = /https?:\/\/[^\s'"<>\\)\]]+/g;
    let m;
    while ((m = re.exec(text))) {
        let u = m[0].replace(/[,;]+$/, '');
        // JS 里常见的转义斜杠
        u = u.replace(/\\\//g, '/');
        out.push(u);
    }
    return out;
}

async function searchOn(source, keyword, opts = {}) {
    const sc = source.def.arguments.searchConfig || {};
    if (!sc.searchUrl) return { items: [], error: '该源没有搜索地址' };

    const kw = sc.searchUseOnlyFirstWord ? firstWord(keyword) : String(keyword || '').trim();
    let url = sc.searchUrl.replace('{keyword}', encodeURIComponent(kw));
    /* URL 里剩下的非法字符必须全部编码掉，两处坑：
     *   ① BT 源的 filter 是 JSON（含方括号/引号/中文），原样发出去 undici 直接抛
     *      "Cannot convert argument to a ByteString"（中文字符 > 255）；
     *   ② 空格不编码会把请求切成两半。 */
    url = url.replace(/[^\x21-\x7E]/g, (c) => encodeURIComponent(c))
        .replace(/[\[\]{}"<>\\^`| ]/g, (c) => encodeURIComponent(c));

    const r = await grab(url, { timeout: opts.timeout || 15000, referer: url });
    if (!r.ok || !r.text) return { items: [], error: r.error || ('HTTP ' + r.status) };

    if (source.factoryId === 'rss') return parseRss(r.text, source, kw);

    const items = parseSearchPage(r.text, source, url);
    return { items, error: items.length ? '' : '选择器没匹配到条目（站点可能改版）' };
}

function parseSearchPage(html, source, pageUrl) {
    const $ = cheerio.load(html);
    const sc = source.def.arguments.searchConfig || {};
    const fmt = sc.subjectFormatId || 'a';
    const out = [];

    const push = (name, link) => {
        if (!link) return;
        const u = absUrl(link, source);
        if (!/^https?:\/\//i.test(u)) return;
        const n = String(name || '').replace(/\s+/g, ' ').trim();
        if (!n) return;
        if (out.some((x) => x.url === u)) return;
        out.push({ name: n, url: u });
    };

    if (fmt === 'indexed') {
        const sel = sc.selectorSubjectFormatIndexed || {};
        const names = $(sel.selectNames || '');
        const links = $(sel.selectLinks || '');
        const n = Math.min(names.length, links.length);
        for (let i = 0; i < n; i++) {
            push($(names[i]).text(), $(links[i]).attr('href'));
        }
    } else if (fmt === 'jsonPathIndexed') {
        // 简易 JSONPath：$[*]['url','link'] 这类「数组 -> 多候选字段」的形式
        const sel = sc.selectorSubjectFormatJsonPathIndexed || {};
        try {
            const data = JSON.parse(html.trim());
            const arr = Array.isArray(data) ? data : (data.data || data.list || data.items || []);
            const pick = (keys) => {
                const k = String(keys || '').replace(/^\$\[\*\]\.?/, '').replace(/[[\]']/g, '');
                return k.split(',').map((s) => s.trim()).filter(Boolean);
            };
            const linkKeys = pick(sel.selectLinks);
            const nameKeys = pick(sel.selectNames);
            arr.forEach((it) => {
                let link = '', name = '';
                linkKeys.forEach((k) => { if (!link && it[k]) link = it[k]; });
                nameKeys.forEach((k) => { if (!name && it[k]) name = it[k]; });
                push(name, link);
            });
        } catch (e) { /* 不是 JSON → 没有结果 */ }
    } else {
        const sel = sc.selectorSubjectFormatA || {};
        const list = $(sel.selectLists || '');
        list.each((i, el) => {
            const $el = $(el);
            push($el.text(), $el.attr('href'));
        });
    }

    return out.map((it) => ({
        name: it.name,
        url: it.url,
        sourceId: source.id,
        sourceName: source.name,
        tier: source.tier,
        kind: 'web'
    }));
}

function parseRss(xml, source, kw) {
    const items = [];
    const blocks = xml.split(/<item[\s>]/i).slice(1);
    for (const b of blocks) {
        const seg = b.split(/<\/item>/i)[0];
        // RSS 里的一切都是 XML 转义过的：磁力链接中的 & 会写成 &amp;，
        // 不还原的话复制出去的链接是坏的（点开直接报无效链接）。
        const unesc = (s) => String(s || '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
            .replace(/&amp;/g, '&');
        const pick = (tag) => {
            const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(seg);
            if (!m) return '';
            return unesc(m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim());
        };
        const title = pick('title');
        const link = pick('link');
        const enc = /<enclosure[^>]+url=["']([^"']+)["']/i.exec(seg);
        const magnet = [link, enc && unesc(enc[1]), pick('guid')].find((x) => x && /^magnet:/i.test(x)) || '';
        const date = pick('pubDate');
        const desc = pick('description');
        const size = (/([\d.]+\s*[KMGT]i?B)/i.exec(desc || '') || [])[1] || '';
        if (!title) continue;
        items.push({
            name: title,
            url: magnet || link,
            magnet,
            size,
            date,
            sourceId: source.id,
            sourceName: source.name,
            tier: source.tier,
            kind: 'bt'
        });
    }
    // RSS 站自己不过滤关键词，这里补一道（否则搜什么都是同一页最新资源）
    const kwl = String(kw || '').toLowerCase();
    const filtered = kwl ? items.filter((it) => it.name.toLowerCase().includes(kwl)) : items;
    return { items: (filtered.length ? filtered : items).slice(0, 60), error: '' };
}

// ==================================================================
// 剧集
// ==================================================================
async function episodesOf(source, detailUrl, opts = {}) {
    const r = await grab(detailUrl, { timeout: opts.timeout || 15000 });
    if (!r.ok || !r.text) return { episodes: [], error: r.error || ('HTTP ' + r.status) };

    const $ = cheerio.load(r.text);
    const sc = source.def.arguments.searchConfig || {};
    const args = source.def.arguments || {};
    const flat = sc.selectorChannelFormatFlattened;
    const noCh = sc.selectorChannelFormatNoChannel;
    const episodes = [];

    const epSort = (name) => {
        const re = flat && flat.matchEpisodeSortFromName ? flat.matchEpisodeSortFromName
            : (noCh && noCh.matchEpisodeSortFromName) || '';
        if (!re) return NaN;
        try {
            const m = new RegExp(re).exec(String(name || ''));
            if (m && m.groups && m.groups.ep != null) {
                const n = parseFloat(String(m.groups.ep).replace(/[^\d.]/g, ''));
                return isNaN(n) ? NaN : n;
            }
            if (m && m[1] != null) {
                const n = parseFloat(String(m[1]).replace(/[^\d.]/g, ''));
                return isNaN(n) ? NaN : n;
            }
        } catch (e) { /* 正则不合法 → 当无序号 */ }
        return NaN;
    };

    const add = (name, href, channel) => {
        const u = absUrl(href, source);
        if (!u) return;
        const tiers = args.channelTiers || {};
        const channelTier = (channel && tiers[channel] != null) ? tiers[channel] : 0;
        episodes.push({
            name: String(name || '').replace(/\s+/g, ' ').trim() || `第${episodes.length + 1}集`,
            sort: epSort(name),
            channel: channel || '',
            channelTier,
            url: u
        });
    };

    if (flat) {
        const chEls = $(flat.selectChannelNames || '');
        const listEls = $(flat.selectEpisodeLists || '');
        const channels = [];
        chEls.each((i, el) => channels.push($(el).text().replace(/\s+/g, ' ').trim()));

        if (flat.matchChannelName) {
            try {
                const cre = new RegExp(flat.matchChannelName);
                for (let i = channels.length - 1; i >= 0; i--) {
                    const m = cre.exec(channels[i]);
                    if (!m) channels.splice(i, 1);
                }
            } catch (e) { /* 正则不合法 → 不过滤 */ }
        }

        if (!channels.length) {
            // 没有频道 tab：所有列表里的集数都算同一部
            listEls.each((li, listEl) => {
                $(listEl).find(flat.selectEpisodesFromList || 'a').each((i, a) => {
                    add($(a).text(), $(a).attr('href'), '');
                });
            });
        } else if (sc.channelFormatId === 'index-grouped' || channels.length === listEls.length) {
            // 频道 i ↔ 列表 i
            for (let i = 0; i < channels.length && i < listEls.length; i++) {
                const ch = channels[i];
                $(listEls[i]).find(flat.selectEpisodesFromList || 'a').each((j, a) => {
                    add($(a).text(), $(a).attr('href'), ch);
                });
            }
        } else {
            // 扁平：所有列表合并（频道名只作标记）
            listEls.each((li, listEl) => {
                $(listEl).find(flat.selectEpisodesFromList || 'a').each((i, a) => {
                    add($(a).text(), $(a).attr('href'), channels[0] || '');
                });
            });
        }
    } else if (noCh) {
        $(noCh.selectEpisodes || '').each((i, a) => {
            add($(a).text(), $(a).attr('href'), '');
        });
    }

    if (!episodes.length) {
        // 兜底：页面里所有「第N集/第N话」的链接
        $('a').each((i, a) => {
            const t = $(a).text().trim();
            if (/第\s*[\d.]+\s*[话集]/.test(t)) add(t, $(a).attr('href'), '');
        });
    }

    // 同序号去重（多频道会重复出同一集），保留 tier 更优（数值更小）的频道
    const best = new Map();
    episodes.forEach((e) => {
        const key = (isNaN(e.sort) ? e.name : '#' + e.sort);
        const old = best.get(key);
        if (!old || e.channelTier < old.channelTier) best.set(key, e);
    });
    const list = Array.from(best.values()).sort((a, b) => {
        if (!isNaN(a.sort) && !isNaN(b.sort)) return a.sort - b.sort;
        return a.name.localeCompare(b.name, 'zh', { numeric: true });
    });
    return { episodes: list, error: list.length ? '' : '没解析到剧集（站点可能改版）' };
}

// ==================================================================
// 解析真流地址
// ==================================================================
async function resolveVideo(source, episodeUrl, opts = {}) {
    const sc = source.def.arguments.searchConfig || {};
    const mv = sc.matchVideo || {};
    const cookie = mv.cookies || '';

    let r = await grab(episodeUrl, { timeout: opts.timeout || 15000, cookie, referer: episodeUrl });
    if (!r.ok || !r.text) return { url: '', error: r.error || ('HTTP ' + r.status) };

    let text = r.text;
    let finalUrl = episodeUrl;

    // 1) 嵌套：播放页里往往只是个 iframe / 跳转，真地址在下一层
    if (mv.enableNestedUrl && mv.matchNestedUrl && !/^\$\^$/.test(mv.matchNestedUrl)) {
        let nestedRe = null;
        try { nestedRe = new RegExp(mv.matchNestedUrl); } catch (e) { nestedRe = null; }
        if (nestedRe) {
            const cand = urlCandidates(text).filter((u) => nestedRe.test(u));
            if (cand.length) {
                const nr = await grab(cand[0], { timeout: 15000, cookie, referer: episodeUrl });
                if (nr.ok && nr.text) {
                    text = text + '\n' + nr.text;
                    finalUrl = cand[0];
                }
            }
        }
    }

    // 2) 抽流地址
    if (!mv.matchVideoUrl) return { url: '', error: '该源没有配置地址正则' };
    let re;
    try { re = new RegExp(mv.matchVideoUrl, 'g'); } catch (e) { return { url: '', error: '地址正则不合法：' + e.message }; }

    // 优先 m3u8（可自适应码率、能走 hls.js），其次 mp4
    const found = [];
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 200) {
        const v = (m.groups && m.groups.v) ? m.groups.v : m[0];
        if (v && /^https?:\/\//i.test(v)) found.push(v);
    }
    if (!found.length) {
        // 正则带命名组但整段匹配带前缀时（比如 url=xxx），退回候选 URL 里挑视频后缀
        const cand = urlCandidates(text).filter((u) => /\.(m3u8|mp4|mkv|flv)(\?|$)/i.test(u) || /bilivideo|akamaized|mime_type=video/i.test(u));
        found.push(...cand);
    }

    /* ★ 正则抽不到 ≠ 没资源：实测 18 个源里 18 个的播放地址都由混淆过的播放器 JS
     * 现算（苹果 CMS 的 player_aaaa encrypt=3），HTTP 静态抓是抓不到的。
     * 这时开真浏览器把页面跑起来，监听它实际发出的视频请求。
     * 成本高（几秒到十几秒），只在静态解析失败时兜底；opts.browser=false 可关掉。 */
    if (!found.length && opts.browser !== false) {
        try {
            const { resolveByBrowser } = require('./browser-resolve');   // 延迟 require，避免两模块循环依赖
            const br = await resolveByBrowser(episodeUrl, { timeout: opts.timeout || 25000 });
            if (br.url) {
                return {
                    url: br.url,
                    headers: { Referer: br.referer || episodeUrl, 'User-Agent': br.ua || UA },
                    cookie: cookie || '',
                    referer: br.referer || episodeUrl,
                    ua: br.ua || UA,
                    from: br.from || episodeUrl,
                    via: 'browser'
                };
            }
            return { url: '', error: br.error || '浏览器也没等到视频请求', via: 'browser' };
        } catch (e) {
            return { url: '', error: '浏览器解析失败：' + (e.message || e) };
        }
    }
    if (!found.length) return { url: '', error: '没抽到播放地址（可能要先过人机验证，或站点已改版）' };

    found.sort((a, b) => (/\.m3u8(\?|$)/i.test(b) ? 1 : 0) - (/\.m3u8(\?|$)/i.test(a) ? 1 : 0));
    const url = found[0];

    const headers = {};
    const h = mv.addHeadersToVideo || {};
    if (h.referer) headers.Referer = h.referer;
    else headers.Referer = finalUrl;
    if (h.userAgent) headers['User-Agent'] = h.userAgent;
    else headers['User-Agent'] = UA;

    return { url, headers, cookie: cookie || '', referer: headers.Referer, ua: headers['User-Agent'], from: finalUrl };
}

// ==================================================================
// 源状态灯 + 订阅刷新
// ==================================================================
const statusCache = new Map();     // id -> { ok, ms, at, error }
const STATUS_TTL = 10 * 60 * 1000;

async function probeSource(source, force) {
    const hit = statusCache.get(source.id);
    if (!force && hit && Date.now() - hit.at < STATUS_TTL) return hit;
    const t0 = Date.now();
    const base = source.searchUrl ? (source.searchUrl.split('?')[0] || source.searchUrl) : '';
    let res;
    if (!base) res = { ok: false, ms: 0, error: '无搜索地址' };
    else {
        const r = await grab(base, { timeout: 10000 });
        res = { ok: r.ok, ms: Date.now() - t0, error: r.ok ? '' : (r.error || ('HTTP ' + r.status)) };
    }
    res.at = Date.now();
    statusCache.set(source.id, res);
    return res;
}

function statusMap(force) {
    return Promise.all(loadSources().map(async (s) => {
        const st = await probeSource(s, force);
        return { id: s.id, ok: !!st.ok, ms: st.ms || 0, error: st.error || '' };
    }));
}

const SUB_REPO_API = 'https://api.github.com/repos/creamycake-anime/animeko-subs/git/trees/main?recursive=1';
const SUB_REPO_RAW = 'https://raw.githubusercontent.com/creamycake-anime/animeko-subs/main/';

/**
 * 订阅刷新：把最新的源定义抓到 override 目录。
 * 站点改版往往只是选择器变了，刷新订阅就能救回来，不必等应用发版。
 */
async function refreshSubscription() {
    const tree = await grab(SUB_REPO_API, { timeout: 20000 });
    let paths = [];
    if (tree.ok && tree.text) {
        try {
            const j = JSON.parse(tree.text);
            paths = (j.tree || []).filter((t) => t.type === 'blob' && /^subs\/.+\.json$/.test(t.path)).map((t) => t.path);
        } catch (e) { /* 下面走 fallback */ }
    }
    if (!paths.length) return { updated: 0, error: '拿不到订阅仓库文件列表（GitHub 不可达或被限流）' };

    fs.mkdirSync(OVERRIDE_DIR, { recursive: true });
    let updated = 0, failed = 0;
    for (const p of paths) {
        const r = await grab(SUB_REPO_RAW + p, { timeout: 20000 });
        if (!r.ok || !r.text) { failed++; continue; }
        try {
            JSON.parse(r.text);   // 必须能解析，别把 HTML 错误页写成源定义
        } catch (e) { failed++; continue; }
        const out = path.join(OVERRIDE_DIR, p.replace(/^subs\//, ''));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, r.text, 'utf8');
        updated++;
    }
    loadSources(true);
    return { updated, failed, error: '' };
}

module.exports = {
    loadSources,
    getSource,
    searchOn,
    episodesOf,
    resolveVideo,
    probeSource,
    statusMap,
    refreshSubscription,
    grab,
    absUrl,
    OVERRIDE_DIR,
    BUILTIN_DIR
};
