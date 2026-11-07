/**
 * utils/tts/fishaudio-engine.js —— Fish Audio 云端 TTS 引擎（在线 API）
 * ============================================================================
 * 为什么直接写：本地两个引擎（Breeze / GPT-SoVITS / VITS）都要几 GB 显存 +
 * 几十秒冷启动；而「AI 伴侣说话 / 阅读器朗读 / 通知播报」这类场景更需要
 * 开箱即用、不占 GPU。Fish Audio 的 S2.1 云端模型正是这个定位：
 *   · 首音 ~0.8s（流式 wav）
 *   · 多语种自动识别，无需 lang 参数
 *   · 音色用 reference_id（公共音色或自建克隆模型）
 *
 * 协议（与 Alife 项目 Azuma.FishAudioTTS 插件同源，已验证可用）：
 *   POST https://api.fish.audio/v1/tts
 *   Authorization: Bearer <apiKey>
 *   model: s2.1-pro-free | s2.1-pro | s1
 *   body: { text, reference_id, format, temperature, chunk_length, prosody:{speed,volume} }
 *   响应：audio/wav 或 audio/mpeg 二进制
 *
 * ★ 国内直连不通（实测 ETIMEDOUT），必须走 HTTP 代理；代理不通时给出明确错因，
 *   而不是让用户看到一句 "fetch failed"。
 * ★ 绝不在响应里回传 apiKey（设置页只显示是否已配置）。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const API_HOST = 'api.fish.audio';
const API_PATH = '/v1/tts';

/** 默认音色。
 * ★ round145 正名：`da6a6205c31d451fabb28c3d139adfa8` 曾经被标成「魅魔」，
 *   实测与 Alife 项目「爱弥斯」角色配置里的 ReferenceId **完全相同**
 *   （Alife.Client/Storage/Character/爱弥斯/.../Azuma.FishAudioTTS.FishAudioSpeechModel.json），
 *   也就是说用户一直听到的是爱弥斯，只是名字写错了 —— 「选了别的音色还是爱弥斯」
 *   的困惑有一半来自这里。现在按事实标注，并保留 id 不变（换了 id 等于换了用户的模型）。 */
const DEFAULT_VOICE = {
    id: 'da6a6205c31d451fabb28c3d139adfa8',
    name: '爱弥斯（自建克隆）',
    note: '与 Alife「爱弥斯」角色同一 reference_id'
};

/**
 * 内置音色预设（reference_id）。
 * ★ 只放**已验证可用**的 ID：Fish Audio 的音色 ID 是模型级 ID，编造的 ID 会在
 *   合成时报 "Reference not found"。之前放的三个占位 ID 全是假的，实测全部失败，
 *   会把「换音色」变成一条必然报错的路径 —— 已移除。
 * ★ round145：搜索接口通了以后，这里只是「离线兜底」；真正的音色来自
 *   `/api/tts/fishaudio/search`（在线搜全站公开音色）。
 */
const PRESET_VOICES = [
    { id: 'da6a6205c31d451fabb28c3d139adfa8', name: '爱弥斯（自建克隆）', tag: '默认' }
];

/** Fish Audio 的 reference_id 是 32 位十六进制；不是这个形状的一律不当 id 用 */
function isVoiceId(s) {
    return /^[0-9a-f]{32}$/i.test(String(s || '').trim());
}

function maskKey(k) {
    const s = String(k || '');
    if (!s) return '';
    if (s.length <= 8) return '****';
    return s.slice(0, 6) + '…' + s.slice(-3);
}

class FishAudioEngine {
    constructor(cfg = {}) {
        this.cfg = cfg;
        this.name = 'fishaudio';
        this.state = 'ready';        // 云端引擎：只要配置齐就是 ready
        this.port = 0;
        this.lastError = '';
        this.progressMsg = '云端引擎（无需加载模型）';
        this.cacheDir = cfg.cacheDir || path.resolve(__dirname, '../../cache/tts-cache');
        try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch (e) { }
    }

    /* ---------------- 配置读取（每次都从最新 cfg 取，支持热改） ---------------- */

    /**
     * 配置读取（每次都从最新 cfg 取，支持热改）。
     * 代理优先级：fishAudio.proxyUrl（用户显式填）> 顶层 proxyServer（全局网络代理）> 直连。
     * ★ 曾经只读 fishAudio.proxyUrl，导致「全局配了代理、TTS 仍显示未配置」——
     *   而 api.fish.audio 国内直连必超时，这条链路就整个不可用。
     */
    cfgOf(over) {
        const base = this.cfg || {};
        const fa = Object.assign({}, base.fishAudio || {}, over || {});
        const explicitProxy = String(fa.proxyUrl || '').trim();
        const globalProxy = String(base.proxyServer || '').trim();
        return {
            apiKey: String(fa.apiKey || '').trim(),
            referenceId: String(fa.referenceId || '').trim() || DEFAULT_VOICE.id,
            model: String(fa.model || 's2.1-pro-free').trim(),
            format: String(fa.format || 'mp3').trim().toLowerCase(),
            temperature: clamp(Number(fa.temperature), 0.1, 2.0, 0.7),
            chunkLength: clamp(Number(fa.chunkLength), 100, 500, 300),
            speed: clamp(Number(fa.speed), 0.5, 2.0, 1.0),
            proxy: explicitProxy || globalProxy,
            timeoutMs: clamp(Number(fa.timeoutMs), 5000, 120000, 45000)
        };
    }

    isInstalled() {
        const c = this.cfgOf();
        return !!c.apiKey;
    }

    /** 状态（设置页/体检用；绝不回传 apiKey 原文） */
    status() {
        const c = this.cfgOf();
        return {
            engine: 'fishaudio',
            state: this.isInstalled() ? 'ready' : 'unconfigured',
            configured: !!c.apiKey,
            apiKeyMasked: maskKey(c.apiKey),
            referenceId: c.referenceId,
            voiceName: String((this.cfg && this.cfg.fishAudio && this.cfg.fishAudio.voiceName) || '') || DEFAULT_VOICE.name,
            model: c.model,
            format: c.format,
            proxy: c.proxy || '(直连)',
            lastError: this.lastError,
            message: this.isInstalled()
                ? '云端引擎就绪（不占本地 GPU）'
                : '未填写 Fish Audio API Key，无法合成'
        };
    }

    /**
     * 音色列表（**离线兜底**）：预设 + 用户当前手选的那个。
     * round145：真正「搜全站公开音色」走 `searchVoices()`，
     * 这里保持不打网络 —— 前端每次渲染面板都会调 /voices，接口要做到秒回。
     */
    voices() {
        const c = this.cfgOf();
        const list = PRESET_VOICES.map(v => ({
            id: v.id,
            name: v.name,
            group: v.tag === '默认' ? '推荐音色' : '内置预设',
            source: 'preset',
            note: v.note || ''
        }));
        // 当前 reference_id 不在预设里（用户搜到/手填的）→ 补一条，下拉才不会显示成预设名
        if (isVoiceId(c.referenceId) && !list.some(v => v.id === c.referenceId)) {
            const title = String((this.cfg && this.cfg.fishAudio && this.cfg.fishAudio.voiceName) || '').trim();
            list.push({
                id: c.referenceId,
                name: title || ('自定义音色 ' + c.referenceId.slice(0, 6)),
                group: '当前使用',
                source: 'current'
            });
        }
        return list;
    }

    /**
     * round145 · 在线搜索 Fish Audio 全站公开音色。
     * 端点与 Alife 插件（Azuma.FishAudioTTS / FishAudioModelUI.SearchVoicesAsync）同源已验证：
     *   GET https://api.fish.audio/model?page_size=&page_number=&sort_by=[&title=]
     *   Authorization: Bearer <apiKey>
     *   响应 { total, items:[{_id,title,description,tags[],task_count,samples[{audio}]}] }
     * ★ 必须走代理（国内直连超时）；代理没开时把话说明白，别只抛 fetch failed。
     */
    async searchVoices(opt = {}) {
        const c = this.cfgOf();
        if (!c.apiKey) throw new Error('未配置 Fish Audio API Key（设置 → 语音朗读 → Fish Audio）');
        const q = String(opt.q || opt.title || '').trim();
        const page = Math.max(1, Number(opt.page) || 1);
        const pageSize = clamp(Number(opt.pageSize), 1, 50, 20);
        const sortBy = String(opt.sortBy || 'score').trim();
        let apiPath = `/model?page_size=${pageSize}&page_number=${page}&sort_by=${encodeURIComponent(sortBy)}`;
        if (q) apiPath += '&title=' + encodeURIComponent(q);

        const t0 = Date.now();
        const json = await this.apiJson(apiPath, { timeoutMs: c.timeoutMs });
        const items = Array.isArray(json && json.items) ? json.items : [];
        const voices = items.map(it => {
            const tags = Array.isArray(it.tags) ? it.tags.filter(Boolean).map(String) : [];
            let sample = '';
            if (Array.isArray(it.samples) && it.samples.length && it.samples[0]) {
                sample = String(it.samples[0].audio || '');
            }
            if (!sample && it.cover_image) { /* 封面与试听分开，前端只放试听 */ }
            return {
                id: String(it._id || it.id || ''),
                name: String(it.title || it.name || '').trim() || String(it._id || ''),
                desc: String(it.description || '').slice(0, 160),
                tags,
                uses: Number(it.task_count) >= 0 ? Number(it.task_count) : -1,
                sample
            };
        }).filter(v => isVoiceId(v.id));

        return {
            total: Number(json && json.total) || voices.length,
            page, pageSize, sortBy, q,
            voices,
            costMs: Date.now() - t0
        };
    }

    /** 兼容旧调用名：音色库 = 搜索第一页（按热度） */
    async fetchMyVoices() {
        const r = await this.searchVoices({ page: 1, pageSize: 20, sortBy: 'task_count' });
        return r.voices;
    }

    /**
     * 通用 JSON 请求（GET/POST），复用同一套代理与错误人话化逻辑。
     * 合成走二进制流（requestTts），这里只服务 /model 这类 JSON 端点。
     */
    apiJson(apiPath, opt = {}) {
        const c = this.cfgOf();
        const method = opt.method || 'GET';
        const payload = opt.body ? Buffer.from(JSON.stringify(opt.body), 'utf8') : null;
        const timeoutMs = clamp(Number(opt.timeoutMs), 5000, 120000, c.timeoutMs);

        return new Promise((resolve, reject) => {
            let agent;
            if (c.proxy) {
                try { agent = new (require('https-proxy-agent').HttpsProxyAgent)(c.proxy); } catch (e) { }
            }
            const headers = {
                Authorization: 'Bearer ' + c.apiKey,
                Accept: 'application/json',
                'User-Agent': 'CinemaVault/4.7 FishAudioEngine'
            };
            if (payload) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = String(payload.length);
            }
            let settled = false;
            const fail = (e) => { if (!settled) { settled = true; reject(e); } };
            const req = https.request({
                hostname: API_HOST, port: 443, path: apiPath, method, agent, timeout: timeoutMs, headers
            }, (res) => {
                const chunks = [];
                res.on('data', d => chunks.push(d));
                res.on('end', () => {
                    if (settled) return;
                    const txt = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode !== 200) {
                        let msg = txt.slice(0, 200);
                        if (res.statusCode === 401 || res.statusCode === 403) msg = '鉴权失败（API Key 无效或已过期）：' + msg;
                        else if (res.statusCode === 402) msg = '额度不足：' + msg;
                        else if (res.statusCode === 429) msg = '触发限流，稍后再试：' + msg;
                        return fail(new Error(msg));
                    }
                    try { settled = true; resolve(JSON.parse(txt)); }
                    catch (e) { fail(new Error('Fish Audio 返回的不是 JSON：' + txt.slice(0, 120))); }
                });
                res.on('error', e => fail(new Error('接收响应失败：' + e.message)));
            });
            req.on('timeout', () => {
                req.destroy();
                fail(new Error(`Fish Audio 搜索超时（${timeoutMs}ms）。国内直连不通，请检查代理（当前：${c.proxy || '未配置'}）`));
            });
            req.on('error', e => fail(new Error(this.humanizeError(e, c))));
            if (payload) req.write(payload);
            req.end();
        });
    }

    /** 合成：返回 { path, cached, engine, costMs, bytes } */
    async synthesize(textOrOpt, maybeOpts = {}) {
        let text = '';
        let opts = {};
        if (typeof textOrOpt === 'string') { text = textOrOpt; opts = maybeOpts || {}; }
        else if (textOrOpt && typeof textOrOpt === 'object') { text = textOrOpt.text || ''; opts = textOrOpt; }

        text = String(text || '').trim();
        if (!text) throw new Error('合成文本为空');

        /* round145：voice 可能是「音色名」（breeze/gptsovits 的调用方习惯传中文名），
           绝不能直接当 reference_id 发出去 —— 那会变成 "Reference not found"。
           只认 32 位 hex 的 id，其余一律回落到设置里保存的 referenceId。 */
        const voiceArg = String(opts.voice || opts.referenceId || '').trim();
        const c = this.cfgOf({
            referenceId: isVoiceId(voiceArg) ? voiceArg : undefined,
            speed: opts.speed != null ? Number(opts.speed) : undefined
        });
        this.lastVoiceIgnored = !!voiceArg && !isVoiceId(voiceArg);

        if (!c.apiKey) throw new Error('未配置 Fish Audio API Key（设置 → 语音 里填写）');

        const t0 = Date.now();

        // 缓存：文本 + 音色 + 参数 一致就复用
        const hash = crypto.createHash('sha256')
            .update(`fish:${c.referenceId}:${c.model}:${c.format}:${c.speed}:${text}`)
            .digest('hex').slice(0, 32);
        const ext = c.format === 'wav' ? 'wav' : 'mp3';
        const cachePath = path.join(this.cacheDir, `${hash}.${ext}`);

        if (!opts.noCache && fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
            return { path: cachePath, cached: true, engine: 'fishaudio', costMs: Date.now() - t0, bytes: fs.statSync(cachePath).size };
        }

        const payload = {
            text,
            reference_id: c.referenceId,
            format: c.format,
            temperature: c.temperature,
            chunk_length: c.chunkLength,
            prosody: { speed: c.speed, volume: 0 }
        };

        const buf = await this.requestTts(c, payload);

        fs.writeFileSync(cachePath, buf);
        return { path: cachePath, cached: false, engine: 'fishaudio', costMs: Date.now() - t0, bytes: buf.length };
    }

    /* ---------------- HTTP（含代理与错误人话化） ---------------- */

    /**
     * 发 /v1/tts 请求并拿回音频 Buffer。
     * 国内直连 api.fish.audio 实测 ETIMEDOUT，所以优先走代理；
     * https-proxy-agent 已在依赖里且实测可用（返回 200 audio/mpeg）。
     */
    requestTts(c, payload) {
        return new Promise((resolve, reject) => {
            const body = Buffer.from(JSON.stringify(payload), 'utf8');
            const headers = this.headers(c, body);

            let agent = undefined;
            if (c.proxy) {
                try {
                    const { HttpsProxyAgent } = require('https-proxy-agent');
                    agent = new HttpsProxyAgent(c.proxy);
                } catch (e) {
                    /* 代理构造失败就走直连，错误由直连失败时报告 */
                }
            }

            let settled = false;
            const fail = (err) => { if (!settled) { settled = true; reject(err); } };
            const ok = (buf) => { if (!settled) { settled = true; resolve(buf); } };

            const req = https.request({
                hostname: API_HOST,
                port: 443,
                path: API_PATH,
                method: 'POST',
                agent,
                timeout: c.timeoutMs,
                headers
            }, (res) => this.collect(res, ok, fail, c));

            req.on('timeout', () => {
                req.destroy();
                fail(new Error(`Fish Audio 请求超时（${c.timeoutMs}ms）。国内直连 api.fish.audio 不通，请在设置里配置代理（当前：${c.proxy || '未配置'}）`));
            });
            req.on('error', (e) => fail(new Error(this.humanizeError(e, c))));
            req.end(body);
        });
    }

    headers(c, body) {
        return {
            'Content-Type': 'application/json',
            'Content-Length': String(body.length),
            Authorization: 'Bearer ' + c.apiKey,
            model: c.model,
            'User-Agent': 'CinemaVault/4.7 FishAudioEngine'
        };
    }

    collect(res, resolve, reject, c) {
        const type = String(res.headers['content-type'] || '');
        if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                let msg = Buffer.concat(chunks).toString('utf8').slice(0, 300);
                if (res.statusCode === 401 || res.statusCode === 403) {
                    msg = 'Fish Audio 鉴权失败（热 API Key 无效或已过期）：' + msg;
                } else if (res.statusCode === 402) {
                    msg = 'Fish Audio 额度不足：' + msg;
                } else if (res.statusCode === 429) {
                    msg = 'Fish Audio 触发限流，稍后再试：' + msg;
                } else if (/json/i.test(type)) {
                    try { msg = JSON.parse(msg).message || msg; } catch (e) { }
                }
                reject(new Error(msg));
            });
            return;
        }
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (!buf.length) return reject(new Error('Fish Audio 返回空音频'));
            const magic = buf.slice(0, 4).toString('hex').toLowerCase();
            const looksAudio = magic.startsWith('fffb') || magic.startsWith('fff3') || magic.startsWith('fff2')
                || magic.startsWith('494433')                 // ID3 / mp3
                || magic.startsWith('52494646');              // RIFF / wav
            if (!looksAudio) return reject(new Error('Fish Audio 返回的不是音频（格式不符）'));
            resolve(buf);
        });
        res.on('error', (e) => reject(new Error('接收音频流失败：' + e.message)));
    }

    /** 把网络错压成用户能看懂的一句话 */
    humanizeError(e, c) {
        const m = String(e && e.message || e);
        if (/ETIMEDOUT|timeout/i.test(m)) {
            return `Fish Audio 连接超时。国内直连 api.fish.audio 不通，请在设置里填写代理地址（当前：${c.proxy || '未配置'}）`;
        }
        if (/ENOTFOUND|EAI_AGAIN/i.test(m)) {
            return `Fish Audio 域名解析失败（DNS 不可达）：${m}`;
        }
        if (/ECONNREFUSED/i.test(m)) {
            return `代理拒绝连接（${c.proxy || '未配置'}）：代理没开或端口不对`;
        }
        return m;
    }

    /* ---------------- 管理 ---------------- */

    /** 云端引擎没有本地进程，「运行中」等价于「已配置」 */
    isRunning() { return this.isInstalled(); }

    /**
     * 健康探活（前端轮询走这里，所以要快、要不吵）。
     * 不真的发一次 TTS 请求 —— 那会产生费用；只检查配置完整性。
     * 想验证 key 是否有效，走 /api/tts/fishaudio/test。
     */
    async health(deep = false) {
        const c = this.cfgOf();
        if (!c.apiKey) {
            return {
                ok: false, state: 'unconfigured', engine: 'fishaudio',
                msg: '未填写 Fish Audio API Key'
            };
        }
        return {
            ok: true, state: 'ready', engine: 'fishaudio',
            msg: '云端引擎就绪（不占本机 GPU）',
            model: c.model, format: c.format, proxy: c.proxy || '(直连)'
        };
    }

    async start() {
        if (!this.isInstalled()) throw new Error('未填写 Fish Audio API Key');
        return { engine: 'fishaudio', state: 'ready', note: '云端引擎无需启动' };
    }

    async stop() { return { engine: 'fishaudio', state: 'ready', note: '云端引擎无本地进程可停' }; }

    info() { return this.status(); }
}

function clamp(v, lo, hi, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

module.exports = { FishAudioEngine, DEFAULT_VOICE, PRESET_VOICES };
