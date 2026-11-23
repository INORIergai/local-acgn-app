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
const doh = require('./doh');

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
 * round181：清洗播放器 JS 拼出的畸形 URL。
 * 实测叽哔动漫的播放器把 `//cdn.xxx/?url=...` 拼到当前域名后，变成
 * `https://www.jibi.cchttps//cdn.xxx/?url=...`（域名与协议粘在一起），
 * 直接代理会 404。这里把被粘连的真协议头抠出来重构成合法 URL。
 */
function sanitizeStreamUrl(u) {
    let s = String(u || '').trim();
    // round181b：跳转壳 `cdn.xxx/?url=<编码后的真m3u8>` —— 真地址就在 url 参数里，
    // 解出来直接用，比再开一次浏览器稳（壳用 MSE blob:，二次嗅探也抓不到 .m3u8 请求）。
    try {
        const q = new URL(s).searchParams.get('url');
        // 真地址就在 url 参数里；Referer 仍需用壳域名（调用方另取）
        if (q && /\.(m3u8|mp4|mkv|flv|ts)(\?|$)/i.test(q)) return q;
    } catch (e) { /* 不是合法 URL，继续下面的粘连清洗 */ }
    // 形如 https://hostXhttps//realhost/... 或 https://hostXhttp//realhost/...
    const m = /^https?:\/\/[^/]*?(https?)\/\/([^\s]+)$/i.exec(s);
    if (m) s = m[1] + '://' + m[2];
    // 形如 hostXhttps://realhost（没吞掉协议冒号的情况）
    const m2 = /^https?:\/\/[^/]*?(https?:\/\/[^\s]+)$/i.exec(s);
    if (m2) s = m2[1];
    return s;
}

// ==================================================================
// round185 · json-api 工厂的底座：受限 JSONPath / 模板 / 请求头
// ==================================================================
/**
 * 受限 JSONPath 求值，**只认** `$` / `.key` / `[*]` 三种语法。
 * 明确拒绝：过滤器 `[?(...)]`、递归 `..`、切片 `[0:2]`、函数调用、脚本表达式。
 * 订阅规则来自第三方仓库，本质是外部输入 —— 不能给它 eval 的能力。
 * 返回**始终是数组**（表达式取到单值也包一层），调用方用 jpathFirst 取首个。
 */
function jpathAll(root, expr) {
    if (typeof expr !== 'string') return [];
    const p = expr.trim();
    if (!p.startsWith('$')) return [];
    // 沙箱闸：出现这些一律当非法表达式，宁可这条源不出结果，也不执行外部语法
    if (/\[\?|\.\.|\[\s*-?\d*\s*:\s*-?\d*\s*\]|\(|\)|\{|\}|=>|;\s*\w/.test(p)) return [];
    let cur = [root];
    for (const seg of p.slice(1).split('.')) {
        if (!seg) continue;
        const m = /^([^\[\]]*)((?:\[\*\])*)$/.exec(seg);
        if (!m) return [];
        const key = m[1];
        if (key) {
            cur = cur.map((v) => (v == null ? null : v[key])).filter((v) => v !== undefined && v !== null);
        }
        if (m[2]) cur = cur.flat().filter((v) => v !== undefined && v !== null);
    }
    return cur;
}
function jpathFirst(root, expr) {
    const a = jpathAll(root, expr);
    return a.length ? a[0] : '';
}

/** `apikey: xxx\nOrigin: yyy` 文本 → 对象（订阅规则里 headers 就是这种换行格式） */
function parseHeaderText(t) {
    const out = {};
    String(t || '').split(/\r?\n/).forEach((line) => {
        const i = line.indexOf(':');
        if (i <= 0) return;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k) out[k] = v;
    });
    return out;
}

/**
 * json-api 请求头。
 * ★ 坑：grab 默认只带 UA/Accept，非 GET 请求缺 Content-Type 时 fetch 会按 text/plain
 * 发出去，Supabase 那类 RPC 网关会**静默忽略 body 并返回默认列表** —— 表现为
 * 「搜什么都能搜到，但结果跟关键词毫无关系」，比报错还难查。
 */
function apiHeaders(sc, req) {
    const h = Object.assign(parseHeaderText((sc && sc.headers) || ''), parseHeaderText((req && req.headers) || ''));
    const m = String((req && req.method) || 'GET').toUpperCase();
    if (m !== 'GET' && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
        h['Content-Type'] = 'application/json';
    }
    return h;
}

/** URL 模板：值按 percent-encoding（{keyword} 进 query 必须编码） */
function fillUrlTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : encodeURIComponent(String(vars[k]))));
}
/** Body 模板：字符串按 JSON 转义（关键词带引号不能把 body 拼坏），数字原样 */
function fillBodyTemplate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => {
        if (vars[k] == null) return m;
        const v = vars[k];
        if (typeof v === 'number' && isFinite(v)) return String(v);
        return JSON.stringify(String(v)).slice(1, -1);
    });
}

/** 从详情页 URL 抠出源站自己的条目 id（模板反解优先，退化为末段路径） */
function idFromDetailUrl(url, tpl) {
    const t = String(tpl || '');
    if (t && t.includes('{id}')) {
        const re = new RegExp('^' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{id\\}', '([^/?#]+)') + '$');
        const m = re.exec(String(url || ''));
        if (m && m[1]) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    }
    try {
        const p = new URL(url);
        const segs = p.pathname.split('/').filter(Boolean);
        const last = segs[segs.length - 1] || '';
        return decodeURIComponent(last.replace(/\.(html?|php|shtml)$/i, ''));
    } catch (e) { return ''; }
}

// ==================================================================
// round185 · 失败五态（pending / success / noResult / error / captcha）
// ==================================================================
/** 需要人机验证的特征词。命中就不是"站点改版"，救法也完全不同。 */
const CAPTCHA_RE = /(请输入验证码|人机验证|安全验证|滑动验证|请完成验证|访问验证|Just a moment|cf-challenge|challenge-platform|Enable JavaScript and cookies|Attention Required|Cloudflare)/i;

function classifyHttp(r) {
    if (!r) return { state: 'error', error: '无响应' };
    if (!r.status) return { state: 'error', error: r.error || '网络错误' };
    const head = (r.text || '').slice(0, 6000);
    if (r.status === 403 || r.status === 429 || r.status === 503) {
        const cap = CAPTCHA_RE.test(head);
        return { state: cap ? 'captcha' : 'error', error: 'HTTP ' + r.status + (cap ? '（需人机验证）' : '') };
    }
    if (r.status >= 400) return { state: 'error', error: 'HTTP ' + r.status };
    if (CAPTCHA_RE.test(head)) return { state: 'captcha', error: '需要人机验证' };
    return { state: 'success', error: '' };
}

// 源黑名单：连续失败 3 次冷却 24h，成功一次立即清零。
// 目的不是惩罚源，而是别让用户每次搜源都白等 20 个必挂的站。
const BLACKLIST_FILE = path.join(__dirname, '..', '..', 'data', 'media-sources', 'blacklist.json');

/* ---------------- 源启用偏好（对齐 Kazumi 的「自由选择要哪些源」） ----------------
 * 用户在追番页/设置页勾选想用的源，落盘 data/media-sources/prefs.json。
 * 只影响聚合搜索，不删规则文件——随时可再勾回来。 */
const PREFS_FILE = path.join(__dirname, '..', '..', 'data', 'media-sources', 'prefs.json');
let _prefs = null;

function loadPrefs() {
    if (_prefs) return _prefs;
    try {
        const j = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) || {};
        _prefs = { disabled: Array.isArray(j.disabled) ? j.disabled.map(String) : [] };
    } catch (e) {
        _prefs = { disabled: [] };
    }
    return _prefs;
}

function savePrefs(p) {
    _prefs = p;
    try {
        fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
        fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2), 'utf8');
    } catch (e) { /* 写盘失败只影响下次启动的偏好记忆 */ }
}

/** 某源是否被用户启用（默认启用）。 */
function isSourceEnabled(id) {
    const p = loadPrefs();
    return !p.disabled.includes(String(id));
}

/** 批量设置启用状态：on=false 加入禁用名单，on=true 移出。 */
function setSourceEnabled(id, on) {
    const p = loadPrefs();
    const s = new Set(p.disabled);
    if (on) s.delete(String(id));
    else s.add(String(id));
    p.disabled = Array.from(s);
    savePrefs(p);
    return !p.disabled.includes(String(id));
}

/** 一次性替换禁用名单（设置页"全选/全不选"用）。 */
function setDisabledSources(ids) {
    const uniq = Array.from(new Set((ids || []).map(String)));
    savePrefs({ disabled: uniq });
    return uniq;
}

// round185 A2：人机验证过后的 cookie。过验证用的是有头浏览器（见 verify.js），
// 过完把 storageState 的 cookies 落盘，之后 fetch 请求自动带上——否则用户白过一遍验证。
const COOKIE_DIR = path.join(__dirname, '..', '..', 'data', 'media-sources', 'cookies');

function cookieFileOf(sourceId) {
    return path.join(COOKIE_DIR, encodeURIComponent(String(sourceId)) + '.json');
}

/** 取某源的 Cookie 请求头（没有就返回空串） */
function sourceCookieHeader(sourceId) {
    try {
        const f = cookieFileOf(sourceId);
        if (!fs.existsSync(f)) return '';
        const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!Array.isArray(arr)) return '';
        const now = Date.now() / 1000;
        return arr
            .filter((c) => c && c.name && c.value && (!c.expires || c.expires < 0 || c.expires > now))
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
    } catch (e) { return ''; }
}

function saveSourceCookies(sourceId, cookies) {
    try {
        fs.mkdirSync(COOKIE_DIR, { recursive: true });
        fs.writeFileSync(cookieFileOf(sourceId), JSON.stringify(cookies || [], null, 2), 'utf8');
        return true;
    } catch (e) { return false; }
}

function clearSourceCookies(sourceId) {
    try {
        const f = cookieFileOf(sourceId);
        if (fs.existsSync(f)) fs.unlinkSync(f);
        return true;
    } catch (e) { return false; }
}
const FAIL_LIMIT = 3;
const COOLDOWN_MS = 24 * 3600 * 1000;

function loadBlacklist() {
    try { return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function saveBlacklist(o) {
    try {
        fs.mkdirSync(path.dirname(BLACKLIST_FILE), { recursive: true });
        fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(o, null, 2), 'utf8');
    } catch (e) { /* 写不进去不影响搜索，只是下次还得再等一次 */ }
}
/** 记一次失败。只有 error / captcha 计数；noResult 属于规则问题，不冷却（刷新订阅就能救） */
function noteFailure(sourceId, state) {
    if (!sourceId) return;
    if (state !== 'error' && state !== 'captcha') return;
    const all = loadBlacklist();
    const rec = all[sourceId] || { fails: 0 };
    rec.fails = (rec.fails || 0) + 1;
    rec.at = Date.now();
    rec.reason = state;
    if (rec.fails >= FAIL_LIMIT) rec.until = Date.now() + COOLDOWN_MS;
    all[sourceId] = rec;
    saveBlacklist(all);
}
function noteSuccess(sourceId) {
    if (!sourceId) return;
    const all = loadBlacklist();
    if (all[sourceId]) { delete all[sourceId]; saveBlacklist(all); }
}
/** 是否在冷却期。返回 { cooling, until, fails, reason } */
function cooldownOf(sourceId) {
    const rec = loadBlacklist()[sourceId];
    if (!rec) return { cooling: false, until: 0, fails: 0, reason: '' };
    const cooling = rec.until && rec.until > Date.now();
    return { cooling, until: rec.until || 0, fails: rec.fails || 0, reason: rec.reason || '' };
}
function clearCooldown(sourceId) {
    const all = loadBlacklist();
    if (sourceId) delete all[sourceId];
    else Object.keys(all).forEach((k) => delete all[k]);
    saveBlacklist(all);
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
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) init.body = opts.body;

    let lastErr = null;
    const attempts = [];
    const px = proxyDispatcher();
    if (px) attempts.push({ ...init, dispatcher: px });
    attempts.push(init);

    for (const a of attempts) {
        try {
            const r = await fetch(url, a);
            if (opts.stream) {
                return { ok: r.status < 400, status: r.status, body: r.body, ctype: r.headers.get('content-type') || '', headers: r.headers };
            }
            const buf = Buffer.from(await r.arrayBuffer());
            const ctype = r.headers.get('content-type') || '';
            return { ok: r.status < 400, status: r.status, buf, ctype, text: decode(buf, ctype), headers: r.headers };
        } catch (e) {
            lastErr = e;
        }
    }

    /* DoH 兜底：代理与直连都失败（典型是 DNS 污染拿到错误 IP）时，
     * 用 DoH 解析公网 IP，再让 undici 连这个 IP（SNI 仍是原域名）。
     * 仅对 http/https 的公网域名启用；IP 字面量/内网跳过。失败静默回原错误。 */
    if (opts.doh !== false) {
        try {
            const u = new URL(url);
            if ((u.protocol === 'https:' || u.protocol === 'http:') && !require('node:net').isIP(u.hostname)
                && !doh.isBlockedIp(u.hostname)) {
                const ips = await doh.resolveViaDoh(u.hostname);
                if (ips.length) {
                    const { Agent } = require('undici');
                    let idx = 0;
                    // lookup 回调：返回 DoH 解析出的 IP（轮转），TLS servername 由 undici 保留原 host
                    const lookup = (hostname, options, cb) => {
                        if (typeof options === 'function') { cb = options; options = {}; }
                        const ip = ips[idx++ % ips.length];
                        if (cb) cb(null, ip, options && options.family === 6 ? 6 : 4);
                        return ip;
                    };
                    const dispatcher = new Agent({ connect: { lookup } });
                    try {
                        const r = await fetch(url, { ...init, dispatcher });
                        if (opts.stream) {
                            return { ok: r.status < 400, status: r.status, body: r.body, ctype: r.headers.get('content-type') || '', headers: r.headers };
                        }
                        const buf = Buffer.from(await r.arrayBuffer());
                        const ctype = r.headers.get('content-type') || '';
                        return { ok: r.status < 400, status: r.status, buf, ctype, text: decode(buf, ctype), headers: r.headers };
                    } finally {
                        dispatcher.close();
                    }
                }
            }
        } catch (e) { lastErr = e; /* DoH 兜底失败不影响返回原错误 */ }
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
        // Kazumi 规则是「顶层字段」结构（name/baseURL/searchMode...），没有 arguments 包一层
        const isKazumi = String(def.factoryId || '') === 'kazumi';
        const args = def.arguments || (isKazumi ? def : {});
        const sc = args.searchConfig || {};
        // json-api 源没有 searchUrl，入口在 search.request.url；统一给一个「搜索地址」便于状态灯/UI
        const searchEntry = sc.searchUrl
            || String((sc.search && sc.search.request && sc.search.request.url) || '')
            || (isKazumi ? String(def.searchURL || (def.searchApiConfig && def.searchApiConfig.request && def.searchApiConfig.request.url) || '') : '');
        const host = hostOf(searchEntry);
        const rec = {
            id: rel.replace(/\.json$/, ''),
            name: args.name || rel.replace(/\.json$/, ''),
            description: args.description || '',
            iconUrl: args.iconUrl || '',
            factoryId: def.factoryId,
            version: def.version || 1,
            kind: def.factoryId === 'rss' ? 'bt' : 'web',
            tier: typeof args.tier === 'number' ? args.tier : (isKazumi ? 2 : 9),
            host,
            searchUrl: searchEntry,
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
    if (source.factoryId === 'json-api') return searchOnApi(source, keyword, opts);
    if (source.factoryId === 'kazumi') {
        // Kazumi 原生规则：XPath 或 JSON API，规则形态由 source.def 顶层字段决定
        const kz = require('./kazumi');
        const r = await kz.search(source.def, keyword, { grab, timeout: opts.timeout || 15000 });
        return {
            items: (r.items || []).map((it) => ({
                name: it.name, url: it.url,
                sourceId: source.id, sourceName: source.name,
                tier: source.tier, kind: 'web',
            })),
            error: r.error || '',
            state: r.state,
        };
    }
    const sc = source.def.arguments.searchConfig || {};
    if (!sc.searchUrl) return { items: [], error: '该源没有搜索地址', state: 'error' };

    const kw = sc.searchUseOnlyFirstWord ? firstWord(keyword) : String(keyword || '').trim();
    let url = sc.searchUrl.replace('{keyword}', encodeURIComponent(kw));
    /* URL 里剩下的非法字符必须全部编码掉，两处坑：
     *   ① BT 源的 filter 是 JSON（含方括号/引号/中文），原样发出去 undici 直接抛
     *      "Cannot convert argument to a ByteString"（中文字符 > 255）；
     *   ② 空格不编码会把请求切成两半。 */
    url = url.replace(/[^\x21-\x7E]/g, (c) => encodeURIComponent(c))
        .replace(/[\[\]{}"<>\\^`| ]/g, (c) => encodeURIComponent(c));

    const r = await grab(url, { timeout: opts.timeout || 15000, referer: url,
        cookie: opts.cookie || sourceCookieHeader(source.id) });
    const cls = classifyHttp(r);
    if (cls.state !== 'success') return { items: [], error: cls.error, state: cls.state };

    if (source.factoryId === 'rss') {
        const rr = parseRss(r.text, source, kw);
        return Object.assign(rr, { state: rr.items.length ? 'success' : 'noResult' });
    }

    const items = parseSearchPage(r.text, source, url);
    return { items, error: items.length ? '' : '选择器没匹配到条目（站点可能改版）',
             state: items.length ? 'success' : 'noResult' };
}

/**
 * round185 · json-api 工厂（稀饭动漫 Next 这类纯 RPC 源）。
 * 与 web-selector 的本质区别：没有可解析的 HTML，全部是 JSON 接口 + 受限 JSONPath。
 */
async function searchOnApi(source, keyword, opts = {}) {
    const sc = source.def.arguments.searchConfig || {};
    const cfg = sc.search || {};
    const req = cfg.request || {};
    if (!req.url) return { items: [], error: 'json-api 源缺少 search.request.url', state: 'error' };

    const pageSize = Number(cfg.pageSize) || 20;
    const vars = { keyword: String(keyword || '').trim(), page: 1, pageSize };
    const headers = apiHeaders(sc, req);
    const method = String(req.method || 'GET').toUpperCase();

    const r = await grab(fillUrlTemplate(req.url, vars), {
        timeout: opts.timeout || 15000,
        method,
        body: method === 'GET' ? undefined : fillBodyTemplate(req.body, vars),
        headers
    });
    const cls = classifyHttp(r);
    if (cls.state !== 'success') return { items: [], error: cls.error, state: cls.state };

    let data;
    try { data = JSON.parse(r.text); } catch (e) {
        return { items: [], error: '响应不是 JSON（可能被 WAF 拦截）', state: 'noResult' };
    }
    const list = jpathAll(data, cfg.selectItems || '$[*]');
    const items = [];
    for (const it of list) {
        const name = String(jpathFirst(it, cfg.selectName || '$.title') || '').replace(/\s+/g, ' ').trim();
        const id = jpathFirst(it, cfg.selectId || '$.id');
        if (!name || id === '') continue;
        const url = fillUrlTemplate(cfg.subjectUrlTemplate || '', { id });
        if (!/^https?:\/\//i.test(url)) continue;
        if (items.some((x) => x.url === url)) continue;
        items.push({ name, url, sourceId: source.id, sourceName: source.name,
                     tier: source.tier, kind: 'web', entryId: String(id) });
    }
    return { items, error: items.length ? '' : 'JSONPath 没取到条目（规则可能过期）',
             state: items.length ? 'success' : 'noResult' };
}

/**
 * r153 · D：源站目录/发现页。
 * 大多数声明式源只给了 searchUrl；把 {keyword} 抹空后请求，很多站会回全站列表。
 * 解析复用 parseSearchPage，所以站点改版只需改源定义，不用动这里。
 */
async function catalogOf(source, opts = {}) {
    const sc = source.def.arguments.searchConfig || {};
    if (source.factoryId === 'rss') return { items: [], error: 'BT 源不支持无词目录浏览' };
    const tpl = sc.catalogUrl || sc.searchUrl || '';
    if (!tpl) return { items: [], error: '该源没有目录地址' };
    let url = tpl.replace('{keyword}', '').replace(/\{page\}/g, String(opts.page || 1));
    url = url.replace(/[^\x21-\x7E]/g, (c) => encodeURIComponent(c))
        .replace(/[\[\]{}"<>\\^`| ]/g, (c) => encodeURIComponent(c));
    const r = await grab(url, { timeout: opts.timeout || 15000, referer: url });
    if (!r.ok || !r.text) return { items: [], error: r.error || ('HTTP ' + r.status) };
    let items = parseSearchPage(r.text, source, url);
    if (!items.length) return { items: [], error: '目录页没有匹配到条目（站点可能改版或必须带关键词）' };
    if (opts.limit) items = items.slice(0, opts.limit);
    return { items, error: '' };
}

function parseSearchPage(html, source, pageUrl) {
    const $ = cheerio.load(html);
    const sc = source.def.arguments.searchConfig || {};
    // 规则文件里 subjectFormatId 有 "json-path-indexed"（连字符）与 "jsonPathIndexed"（驼峰）
    // 两种写法；旧实现只认驼峰，3 个 JSON 源（girigiri/2k/Anime7）因此永远走错分支。
    const fmtRaw = String(sc.subjectFormatId || 'a').trim();
    const fmt = /^json-?path-?indexed$/i.test(fmtRaw) ? 'jsonPathIndexed'
        : fmtRaw;
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
        // JSON API 源：用真正的 JSONPath 解析，支持任意嵌套路径（如 $.info.rows[*]）。
        // 旧实现只认 data/list/items 三个平铺字段，girigiri 这类返回 info.rows 的源
        // 明明接口有数据却被判「站点改版」→ 整源静默失效（2026-11 追番搜不到的主因）。
        const sel = sc.selectorSubjectFormatJsonPathIndexed || {};
        try {
            const data = JSON.parse(html.trim());
            const links = jpathAll(data, sel.selectLinks);
            const names = jpathAll(data, sel.selectNames);
            const tpl = String(sel.linkTemplate || '');
            const n = Math.max(links.length, names.length);
            for (let i = 0; i < n; i++) {
                const rawLink = links[i];
                const name = names[i];
                if (rawLink === undefined && name === undefined) continue;
                let link = rawLink === undefined ? '' : String(rawLink);
                // 规则用 linkTemplate 把 id 拼成详情页（如 /GV{value}/、/voddetail/{value}.html）
                if (tpl && link) link = tpl.replace('{value}', encodeURIComponent(link));
                push(name, link);
            }
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
    if (source.factoryId === 'json-api') return episodesOfApi(source, detailUrl, opts);
    if (source.factoryId === 'kazumi') {
        const kz = require('./kazumi');
        const r = await kz.episodes(source.def, detailUrl, { grab, timeout: opts.timeout || 15000 });
        return {
            episodes: (r.episodes || []).map((e) => ({
                name: e.name || '',
                sort: Number.isFinite(e.sort) ? e.sort : NaN,
                channel: e.channel || '',
                channelTier: 0,
                url: e.url || '',
            })).filter((e) => e.url),
            error: r.error || '',
            state: r.state,
        };
    }
    const r = await grab(detailUrl, { timeout: opts.timeout || 15000,
        cookie: opts.cookie || sourceCookieHeader(source.id) });
    const cls = classifyHttp(r);
    if (cls.state !== 'success') return { episodes: [], error: cls.error, state: cls.state };
    if (!r.text) return { episodes: [], error: '响应为空', state: 'noResult' };

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
    if (!list.length && opts.browser !== false) {
        // round182 P0-2：静态选择器全失败 → 开浏览器跑 JS 渲染的详情页抓剧集链接
        try {
            const br = await require('./browser-resolve').resolveEpisodes(detailUrl, { timeout: opts.timeout || 20000 });
            if (br.episodes && br.episodes.length) {
                const lit = br.episodes.map((e, i) => {
                    const m = /第\s*([\d.]+)\s*[话集]/.exec(e.name || '');
                    return { name: e.name, sort: m ? parseFloat(m[1]) : i + 1,
                             channel: '', channelTier: 0, url: e.url };
                });
                return { episodes: lit, error: '', via: 'browser', state: 'success' };
            }
        } catch (e) { /* 浏览器也失败就走下面的空结果 */ }
    }
    return { episodes: list, error: list.length ? '' : '没解析到剧集（站点可能改版）',
             state: list.length ? 'success' : 'noResult' };
}

/** round185 · json-api 剧集：subject.request 拿详情 JSON，按 grouped 频道 + episodes 模板展开 */
async function episodesOfApi(source, detailUrl, opts = {}) {
    const sc = source.def.arguments.searchConfig || {};
    const subj = sc.subject || {};
    const req = subj.request || {};
    if (!req.url) return { episodes: [], error: 'json-api 源缺少 subject.request.url', state: 'error' };

    const subjectId = idFromDetailUrl(detailUrl, (sc.search && sc.search.subjectUrlTemplate) || '');
    if (!subjectId) return { episodes: [], error: '无法从详情页地址解析条目 id', state: 'error' };

    const headers = apiHeaders(sc, req);
    const method = String(req.method || 'GET').toUpperCase();
    const vars = { id: subjectId, subjectId };
    const r = await grab(fillUrlTemplate(req.url, vars), {
        timeout: opts.timeout || 15000,
        method,
        body: method === 'GET' ? undefined : fillBodyTemplate(req.body, vars),
        headers
    });
    const cls = classifyHttp(r);
    if (cls.state !== 'success') return { episodes: [], error: cls.error, state: cls.state };

    let data;
    try { data = JSON.parse(r.text); } catch (e) {
        return { episodes: [], error: '响应不是 JSON（可能被 WAF 拦截）', state: 'noResult' };
    }

    const ep = subj.episodes || {};
    const grouped = subj.channelFormatGrouped || {};
    const channelTiers = source.def.arguments.channelTiers || {};

    const mkEp = (e, i, ch) => {
        const name = String(jpathFirst(e, ep.selectName || '$.title') || '').trim();
        const id = jpathFirst(e, ep.selectId || '$.id');
        const sortRaw = jpathFirst(e, ep.selectSort || '$.episode_number');
        const sort = parseFloat(String(sortRaw).replace(/[^\d.]/g, ''));
        const url = fillUrlTemplate(ep.episodeUrlTemplate || '', { id, subjectId, sort, name });
        if (!id || !url) return null;
        const display = ep.nameTemplate
            ? fillBodyTemplate(ep.nameTemplate, { sort: isNaN(sort) ? i + 1 : sort, name })
            : (name || `第${isNaN(sort) ? i + 1 : sort}集`);
        return {
            name: String(display || '').trim() || `第${i + 1}集`,
            sort: isNaN(sort) ? NaN : sort,
            channel: ch || '',
            channelTier: (ch && channelTiers[ch] != null) ? channelTiers[ch] : 0,
            url
        };
    };

    /* ★ 关键：订阅规则的 episodes 选择器写的是「相对当前分组」(`$.episodes[*]`)，
     * 而真实响应是 { anime, sources: [{ name, episodes: [] }] } —— 必须先在组内求值，
     * 直接对顶层文档求值会一条都取不到（这是 round185 实测踩的坑）。 */
    const groups = grouped.selectChannels ? jpathAll(data, grouped.selectChannels) : [];
    const list = [];
    let seg = 0;
    const groupedWorked = groups.some((g) => jpathAll(g, ep.selectEpisodes || '$.episodes[*]').length > 0);
    if (groups.length && groupedWorked) {
        groups.forEach((g) => {
            const ch = String(jpathFirst(g, grouped.selectChannelName || '$.name') || '').trim();
            jpathAll(g, ep.selectEpisodes || '$.episodes[*]').forEach((e) => {
                const rec = mkEp(e, seg++, ch);
                if (rec) list.push(rec);
            });
        });
    } else {
        jpathAll(data, ep.selectEpisodes || '$.episodes[*]').forEach((e) => {
            const rec = mkEp(e, seg++, '');
            if (rec) list.push(rec);
        });
    }

    if (!list.length) return { episodes: [], error: 'JSONPath 没取到剧集（规则可能过期）', state: 'noResult' };

    // 同序号去重，保留 tier 更优的频道（与 web-selector 一致）
    const best = new Map();
    list.forEach((e) => {
        const key = isNaN(e.sort) ? e.name : '#' + e.sort;
        const old = best.get(key);
        if (!old || e.channelTier < old.channelTier) best.set(key, e);
    });
    const out = Array.from(best.values()).sort((a, b) => {
        if (!isNaN(a.sort) && !isNaN(b.sort)) return a.sort - b.sort;
        return a.name.localeCompare(b.name, 'zh', { numeric: true });
    });
    return { episodes: out, error: '', state: 'success' };
}

// ==================================================================
// 解析真流地址
// ==================================================================
async function resolveVideo(source, episodeUrl, opts = {}) {
    if (source.factoryId === 'json-api') return resolveVideoApi(source, episodeUrl, opts);
    if (source.factoryId === 'kazumi') {
        // Kazumi 规则不产出流地址，播放页交给浏览器嗅探（与 Kazumi 的 WebView 方案等价）
        const kz = require('./kazumi');
        return kz.resolve(source.def, episodeUrl, { timeout: opts.timeout || 40000 });
    }
    const sc = source.def.arguments.searchConfig || {};
    const mv = sc.matchVideo || {};
    // round185 A2：规则里写死的 cookie 优先，没有就用「过验证」时存下来的
    const cookie = mv.cookies || sourceCookieHeader(source.id) || '';

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
    // 规则正则来自 Dart 生态，常见内联修饰符 (?i)；JS 不支持，必须剥离并提升为 flag，
    // 否则 new RegExp 直接抛「Invalid regular expression」→ 该源永远解析不出播放地址。
    const rawPattern = String(mv.matchVideoUrl);
    const inlineIgnoreCase = /\(\?[a-z]*i[a-z]*\)/i.test(rawPattern);
    const cleanPattern = rawPattern.replace(/\(\?[a-z]*i[a-z]*\)/gi, '');
    let re;
    try { re = new RegExp(cleanPattern, inlineIgnoreCase ? 'gi' : 'g'); } catch (e) { return { url: '', error: '地址正则不合法：' + e.message }; }

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
                let finalUrl = sanitizeStreamUrl(br.url);
                // round181：有些站第一个抓到的是「跳转壳」（如 cdn.xxx/?url=...，返回 HTML
                // 再由 player.js 发真流）。壳的特征：URL 不以视频后缀结尾且带 url= 参数。
                // 再开一次浏览器跟进这个壳，抓它 JS 真正发出的 m3u8/mp4。
                const isShell = !/\.(m3u8|mp4|mkv|flv|ts)(\?|$)/i.test(finalUrl)
                    && /[?&]url=/i.test(finalUrl);
                if (isShell && opts.browser !== 'no-follow') {
                    try {
                        const br2 = await require('./browser-resolve').resolveByBrowser(finalUrl, {
                            timeout: opts.timeout || 25000, followShell: true
                        });
                        if (br2.url && br2.url !== finalUrl) {
                            finalUrl = sanitizeStreamUrl(br2.url);
                        }
                    } catch (e) { /* 跟进失败就用壳地址，至少不比原来差 */ }
                }
                return {
                    url: finalUrl,
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
    const url = sanitizeStreamUrl(found[0]);

    const headers = {};
    const h = mv.addHeadersToVideo || {};
    if (h.referer) headers.Referer = h.referer;
    else headers.Referer = finalUrl;
    if (h.userAgent) headers['User-Agent'] = h.userAgent;
    else headers['User-Agent'] = UA;

    return { url, headers, cookie: cookie || '', referer: headers.Referer, ua: headers['User-Agent'], from: finalUrl };
}

/** round185 · json-api 播放地址：play.request 签发 → candidates[].url，静态直出无需浏览器嗅探 */
async function resolveVideoApi(source, episodeUrl, opts = {}) {
    const sc = source.def.arguments.searchConfig || {};
    const play = sc.play || {};
    const req = play.request || {};
    if (!req.url) return { url: '', error: 'json-api 源缺少 play.request.url', state: 'error' };

    const episodeId = idFromDetailUrl(episodeUrl, (sc.subject && sc.subject.episodes && sc.subject.episodes.episodeUrlTemplate) || '');
    if (!episodeId) return { url: '', error: '无法从剧集地址解析 episode id', state: 'error' };

    const headers = apiHeaders(sc, req);
    const method = String(req.method || 'GET').toUpperCase();
    const vars = { id: episodeId, episodeId };
    const r = await grab(fillUrlTemplate(req.url, vars), {
        timeout: opts.timeout || 15000,
        method,
        body: method === 'GET' ? undefined : fillBodyTemplate(req.body, vars),
        headers,
        referer: play.referer || episodeUrl
    });
    const cls = classifyHttp(r);
    if (cls.state !== 'success') return { url: '', error: cls.error, state: cls.state };

    let data;
    try { data = JSON.parse(r.text); } catch (e) {
        return { url: '', error: '播放接口返回不是 JSON', state: 'noResult' };
    }
    const cands = jpathAll(data, play.selectCandidates || '$.candidates[*]');
    if (!cands.length) return { url: '', error: '播放接口没返回候选项（可能该集未上线）', state: 'noResult' };

    const pickUrl = (c) => String(jpathFirst(c, play.selectVideoUrl || '$.url') || '');
    let url = '';
    for (const c of cands) {
        const u = pickUrl(c);
        if (/^https?:\/\//i.test(u)) { url = sanitizeStreamUrl(u); break; }
    }
    if (!url) return { url: '', error: '候选项里没有可用地址', state: 'noResult' };

    const referer = play.referer || '';
    return {
        url,
        headers: { Referer: referer || episodeUrl, 'User-Agent': UA },
        cookie: '',
        referer: referer || episodeUrl,
        ua: UA,
        from: episodeUrl,
        via: 'json-api',
        state: 'success'
    };
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
    const sc0 = source.def.arguments.searchConfig || {};
    const base = source.searchUrl ? (source.searchUrl.split('?')[0] || source.searchUrl)
        : String((sc0.search && sc0.search.request && sc0.search.request.url) || '').replace(/^([^:]+:\/\/[^/]+).*$/, '$1');
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

/* 订阅 schema 门禁（对标 AniLiberty 的 schemaVersion）：
 * 本 engine 只理解下列 factory 的最高版本；上游若发布更高版本的定义，
 * 说明格式已变、本引擎解析会出错，必须跳过而不是写进 override 覆盖可用源。
 * 无版本字段的旧定义仍接受（向后兼容）。 */
const FACTORY_MAX_VERSION = Object.freeze({ 'web-selector': 2, 'json-api': 1, rss: 1 });
function schemaSupported(def) {
    if (!def || typeof def !== 'object') return false;
    const factory = String(def.factoryId || def.factory || '');
    const raw = def.schemaVersion != null ? def.schemaVersion : def.version;
    if (raw == null) return true;                       // 旧格式无版本字段：放行
    const v = Number(raw);
    if (!Number.isFinite(v)) return false;              // 版本号非数字：拒绝
    const max = FACTORY_MAX_VERSION[factory];
    if (max == null) return true;                       // 未知 factory 由加载器自行判定
    return v <= max;
}

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
    let updated = 0, failed = 0, skippedSchema = 0;
    for (const p of paths) {
        const r = await grab(SUB_REPO_RAW + p, { timeout: 20000 });
        if (!r.ok || !r.text) { failed++; continue; }
        let def;
        try {
            def = JSON.parse(r.text);   // 必须能解析，别把 HTML 错误页写成源定义
        } catch (e) { failed++; continue; }
        // schemaVersion 门禁：高于本 engine 支持上限的定义跳过，不覆盖可用源
        if (!schemaSupported(def)) { skippedSchema++; continue; }
        // 路径边界：订阅相对路径必须落在 OVERRIDE_DIR 内，拒绝 ../ 等越界
        const rel = p.replace(/^subs\//, '');
        if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) { failed++; continue; }
        const out = path.resolve(OVERRIDE_DIR, rel);
        const rootAbs = path.resolve(OVERRIDE_DIR);
        if (out !== rootAbs && !out.startsWith(rootAbs + path.sep)) { failed++; continue; }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, r.text, 'utf8');
        updated++;
    }
    loadSources(true);
    return { updated, failed, skippedSchema, error: '' };
}

/** round182 P0-3：订阅新鲜度——用 override 目录里最新 json 的 mtime 当"上次刷新时间" */
function subscriptionFreshness() {
    try {
        const files = [];
        walk(OVERRIDE_DIR, files);
        let latest = 0;
        for (const f of files) {
            const m = fs.statSync(f).mtimeMs;
            if (m > latest) latest = m;
        }
        const ageDays = latest ? (Date.now() - latest) / 86400000 : null;
        return { lastRefresh: latest || 0, ageDays: ageDays == null ? null : Math.round(ageDays * 10) / 10,
                 stale: ageDays == null || ageDays > 7, count: files.length };
    } catch (e) { return { lastRefresh: 0, ageDays: null, stale: true, count: 0, error: e.message }; }
}

module.exports = {
    loadSources,
    subscriptionFreshness,
    getSource,
    searchOn,
    catalogOf,
    episodesOf,
    resolveVideo,
    probeSource,
    statusMap,
    refreshSubscription,
    grab,
    absUrl,
    // round185：json-api 底座 + 失败五态 + 源黑名单
    jpathAll,
    jpathFirst,
    classifyHttp,
    cooldownOf,
    clearCooldown,
    noteFailure,
    noteSuccess,
    sourceCookieHeader,
    saveSourceCookies,
    clearSourceCookies,
    OVERRIDE_DIR,
    BUILTIN_DIR,
    BLACKLIST_FILE,
    COOKIE_DIR,
    // 源启用偏好（Kazumi 式自由选源）
    PREFS_FILE,
    isSourceEnabled,
    setSourceEnabled,
    setDisabledSources,
    loadPrefs
};
