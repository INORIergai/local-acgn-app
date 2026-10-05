/**
 * round77 · VITS 模型按需下载
 * ==========================================================================
 * 背景：VITS 权重 G_953000.pth 有 479MB（804 音色公开模型），直接塞进安装包
 *       会让 Setup/Portable 从 163MB 膨胀到 640MB+，不用的用户白付下载成本。
 * 方案：
 *   · 推理代码（147KB，纯 Python）随包体自带 —— utils/tts/vits-runtime/
 *   · 权重作为 GitHub Release v4.0 的独立资产，应用内按需下载到数据目录，
 *     支持断点续传（HTTP Range）+ 进度上报 + 取消。
 *   · 用户自己有 VITS 目录（如 Alife 整合包）时优先用用户的，不触发下载。
 *
 * 挂载：由 routes/tts.js 暴露 /api/tts/model/status | /download | /cancel
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const MODEL_NAME = 'G_953000.pth';
const MODEL_BYTES = 479276657;                 // 服务端校验用（CDN 返回的也是这个值）
const MODEL_URL = 'https://github.com/INORIergai/local-acgn-app/releases/download/v4.0/' + MODEL_NAME;
const TIMEOUT_MS = 30000;

/**
 * 数据目录：开发树=项目根；运行时=<DATA_ROOT>（%APPDATA%\CinemaVault）。
 * 刻意不放进 runtime/ —— 那个目录会被 ensureRuntime 按 build-stamp 整体同步覆盖，
 * 479MB 的权重放那儿有被清掉的风险（updates/ 同理放在数据根）。
 */
function dataRoot() {
    const r = path.join(__dirname, '..', '..');    // prod: <DATA_ROOT>/runtime ; dev: <项目根>
    return path.basename(r).toLowerCase() === 'runtime' ? path.dirname(r) : r;
}

/** 模型工作目录（代码 + 权重），最终作为 vitsDir 交给 worker */
function runtimeDir() { return path.join(dataRoot(), 'vits-runtime'); }
function modelFile() { return path.join(runtimeDir(), 'model', MODEL_NAME); }
function partFile() { return modelFile() + '.part'; }

let state = {
    state: 'idle',        // idle | downloading | done | error
    percent: 0,
    received: 0,
    total: MODEL_BYTES,
    speed: 0,             // B/s
    error: '',
    file: '',
};
let cancelFlag = false;

/** 把包体自带的代码同步到工作目录（缺/变才拷，不覆盖已下载的权重） */
function ensureRuntime() {
    const src = path.join(__dirname, 'vits-runtime');
    const dst = runtimeDir();
    if (!fs.existsSync(src)) return { ok: false, msg: '包体缺少 vits-runtime 代码' };
    const cp = (s, d) => {
        try {
            fs.mkdirSync(path.dirname(d), { recursive: true });
            const a = fs.statSync(s), b = fs.existsSync(d) ? fs.statSync(d) : null;
            if (!b || a.size !== b.size) fs.copyFileSync(s, d);
        } catch (e) { /* 单个文件失败不算致命 */ }
    };
    const walk = (s, d) => {
        for (const f of fs.readdirSync(s)) {
            const sp = path.join(s, f), dp = path.join(d, f);
            const st = fs.statSync(sp);
            if (st.isDirectory()) walk(sp, dp); else cp(sp, dp);
        }
    };
    try { walk(src, dst); } catch (e) { return { ok: false, msg: e.message }; }
    try { fs.mkdirSync(path.join(dst, 'model'), { recursive: true }); } catch (e) { }
    return { ok: true, dir: dst };
}

function installed() {
    try {
        const st = fs.statSync(modelFile());
        // 允许 CDN 有零头差异，99% 即视为完整
        return st.size >= Math.floor(MODEL_BYTES * 0.99);
    } catch (e) { return false; }
}

/** 用户自带目录里是否已有权重（有 → 无需下载，直接用他的） */
function hasExternal(cfgDir) {
    if (!cfgDir) return false;
    try { return fs.existsSync(path.join(cfgDir, 'model', MODEL_NAME)); } catch (e) { return false; }
}

function status(cfgDir) {
    const f = modelFile();
    const ext = hasExternal(cfgDir);
    let size = 0;
    try { size = fs.statSync(installed() ? f : partFile()).size; } catch (e) { }
    return Object.assign({}, state, {
        installed: installed() || ext,
        external: ext,
        externalDir: ext ? cfgDir : '',
        dir: ext ? cfgDir : runtimeDir(),
        file: f,
        size: size,
        total: MODEL_BYTES,
        workspaceReady: fs.existsSync(path.join(runtimeDir(), 'model', 'config.json')),
    });
}

/** 单次 GET（自动跟随 GitHub 的 302 到对象存储） */
function get(url, headers, onData, onResp) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法')); }
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
            headers: Object.assign({ 'User-Agent': 'CinemaVault' }, headers || {}),
            timeout: TIMEOUT_MS,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return get(res.headers.location, headers, onData, onResp).then(resolve, reject);
            }
            if (onResp) onResp(res);
            res.on('data', (c) => onData(c));
            res.on('end', resolve);
            res.on('error', reject);
        });
        req.on('timeout', () => { req.destroy(new Error('连接超时')); });
        req.on('error', reject);
        req.end();
    });
}

/** 下载权重（断点续传） */
async function download(cfgDir) {
    if (state.state === 'downloading') return status(cfgDir);
    if (hasExternal(cfgDir)) { state = Object.assign(state, { state: 'done', percent: 100, error: '' }); return status(cfgDir); }
    if (installed()) { state = Object.assign(state, { state: 'done', percent: 100, received: MODEL_BYTES, error: '' }); return status(); }

    const rt = ensureRuntime();
    if (!rt.ok) { state = Object.assign(state, { state: 'error', error: rt.msg }); return status(); }

    cancelFlag = false;
    let start = 0;
    try { start = fs.existsSync(partFile()) ? fs.statSync(partFile()).size : 0; } catch (e) { }
    state = { state: 'downloading', percent: start ? Math.round(start / MODEL_BYTES * 100) : 0, received: start, total: MODEL_BYTES, speed: 0, error: '', file: modelFile() };

    const ws = fs.createWriteStream(partFile(), { flags: start ? 'a' : 'w' });
    let received = start, t0 = Date.now(), lastTick = Date.now();

    try {
        await get(MODEL_URL, start ? { Range: 'bytes=' + start + '-' } : {}, (chunk) => {
            if (cancelFlag) return;
            ws.write(chunk);
            received += chunk.length;
            const now = Date.now();
            if (now - lastTick >= 400) {
                state.speed = Math.round((received - start) / ((now - t0) / 1000));
                state.received = received;
                state.percent = Math.min(99, Math.round(received / MODEL_BYTES * 100));
                lastTick = now;
            }
        }, (res) => {
            if (start && res.statusCode !== 206) { start = 0; received = 0; ws.close(); }
        });
        await new Promise((r) => ws.end(r));
        if (cancelFlag) {
            try { fs.unlinkSync(partFile()); } catch (e) { }
            state = Object.assign(state, { state: 'idle', error: '已取消', percent: 0, received: 0 });
            return status();
        }
        const got = fs.statSync(partFile()).size;
        if (got < Math.floor(MODEL_BYTES * 0.99)) {
            throw new Error('文件不完整：' + got + '/' + MODEL_BYTES);
        }
        try { if (fs.existsSync(modelFile())) fs.unlinkSync(modelFile()); } catch (e) { }
        fs.renameSync(partFile(), modelFile());
        state = { state: 'done', percent: 100, received: got, total: MODEL_BYTES, speed: 0, error: '', file: modelFile() };
    } catch (e) {
        try { ws.end(); } catch (e2) { }
        state = Object.assign(state, { state: 'error', error: String(e.message || e).slice(0, 200) });
    }
    return status();
}

function cancel() { cancelFlag = true; return status(); }

/**
 * 解析真正要用的 VITS 目录：用户指定 > 内置工作区（代码+已下载权重）
 * @param {string} configured 配置里的 vitsDir
 */
function resolveDir(configured) {
    if (configured && fs.existsSync(configured)) return configured;
    const rt = runtimeDir();
    if (fs.existsSync(path.join(rt, 'model', 'config.json'))) return rt;
    return '';
}

module.exports = {
    MODEL_NAME, MODEL_BYTES, MODEL_URL,
    status, download, cancel, ensureRuntime, resolveDir, runtimeDir, modelFile, installed,
};
