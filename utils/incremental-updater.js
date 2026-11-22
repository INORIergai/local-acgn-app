/**
 * incremental-updater.js — 增量热更新客户端（Task 3 / M2，不切换）
 *
 * 职责：
 *   - diffLocal(current, target)      : 两份 manifest 的差异（added/modified/removed）
 *   - detectLocalChanges(root, cur)   : 用 baseline manifest 找出被用户改过/缺失的文件
 *   - canonical(payload) / verifyPatch(buf, pubkeyPem, cur)
 *                                     : canonical 签名字节重建 + 验签 + zip-slip 防护 + 逐文件 sha256
 *   - stagePatch(buf, opts)           : 解压到 staging 并写 pending-switch.json（不覆盖任何运行文件）
 *
 * 安全契约（controller 裁定，load-bearing）：
 *   - canonical 签名字节必须与 Python `_cv_patch_lib._canonical()` 完全一致：
 *     仅 {version,added,modified,removed,sha256} 五个字段、键按字母序（含嵌套）、无空格、UTF-8。
 *   - zip-slip：每个条目解析后必须落在 staging 目录内，拒绝 ../、绝对路径、盘符、UNC。
 *   - 只写 staging 与 pending-switch.json，绝不覆盖任何运行文件，也不执行 patch 内容。
 *   - URL 安全复用 utils/updater.js 的 assertSafeUrl()/candidateDownloadUrls()/request()，不另起实现。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { assertSafeUrl, candidateDownloadUrls, request } = require('./updater');

/* ================================================================ diff */

function diffLocal(current, target) {
    const a = (current && current.files) || {};
    const b = (target && target.files) || {};
    const added = Object.keys(b).filter(k => !(k in a)).sort();
    const removed = Object.keys(a).filter(k => !(k in b)).sort();
    const modified = Object.keys(b).filter(k => (k in a) && a[k].sha256 !== b[k].sha256).sort();
    return { added, modified, removed };
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 被用户改过（哈希不符）或缺失的文件；供上层告警/跳过，不得静默覆盖。 */
function detectLocalChanges(root, manifest) {
    const bad = [];
    for (const [rel, meta] of Object.entries((manifest && manifest.files) || {})) {
        const p = path.join(root, rel);
        if (!fs.existsSync(p)) { bad.push(rel); continue; }
        if (sha256File(p) !== meta.sha256) bad.push(rel);
    }
    return bad;
}

/* ============================================================ canonical */

/** Python sort_keys 按 Unicode 码点排序；JS 默认按 UTF-16 码元，两者对 BMP 一致，
 *  用逐码点比较消除增补平面字符的差异，保证与发布端字节完全一致。 */
function pyCompare(a, b) {
    const ca = Array.from(String(a)), cb = Array.from(String(b));
    const n = Math.min(ca.length, cb.length);
    for (let i = 0; i < n; i++) {
        const x = ca[i].codePointAt(0), y = cb[i].codePointAt(0);
        if (x !== y) return x - y;
    }
    return ca.length - cb.length;
}

/** 深度递归排序对象的键（数组保序），对齐 Python json.dumps(sort_keys=True)。 */
function deepSort(value) {
    if (Array.isArray(value)) return value.map(deepSort);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort(pyCompare)) out[k] = deepSort(value[k]);
        return out;
    }
    return value;
}

/** 构造签名载荷的 canonical 字节：只取五字段、键字母序、无空格、UTF-8。
 *  与 Python `_cv_patch_lib._canonical({k: meta[k] for k in _SIGN_FIELDS})` 一致。 */
function canonical(payload) {
    const SIGN_FIELDS = ['version', 'added', 'modified', 'removed', 'sha256'];
    const picked = {};
    for (const k of SIGN_FIELDS) picked[k] = payload && payload[k];
    return JSON.stringify(deepSort(picked));
}

/* =========================================================== verifyPatch */

/** 纯字符串层 zip-slip 防护（不依赖 staging 目录，便于独立测试）。 */
function isSafeEntryName(rawName) {
    if (typeof rawName !== 'string' || !rawName) return false;
    const n = rawName.replace(/\\/g, '/');          // 反斜杠变体统一
    if (n.startsWith('/')) return false;             // 绝对路径 / UNC (//server/share)
    if (/^[A-Za-z]:/.test(n)) return false;          // Windows 盘符 C:
    if (n.split('/').includes('..')) return false;   // 目录穿越
    // 再用 path.resolve 做等价校验：解析后必须仍在基准目录内
    const base = path.resolve(path.sep, 'cv-staging-root');
    const resolved = path.resolve(base, n);
    const rel = path.relative(base, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return true;
}

/**
 * 验签 + zip-slip + sha256（纯函数，不写盘、不执行内容）。
 * @returns {{ok:boolean, files?:object, removed?:string[], meta?:object, error?:string, localChanges?:string[]}}
 */
function verifyPatch(patchBuffer, pubkeyPem, currentManifest) {
    let zip;
    try { zip = new AdmZip(Buffer.isBuffer(patchBuffer) ? patchBuffer : Buffer.from(patchBuffer)); }
    catch (e) { return { ok: false, error: 'patch 不是有效 zip' }; }

    // 1) zip-slip：所有条目解析后必须落在安全相对路径内
    for (const e of zip.getEntries()) {
        if (!isSafeEntryName(e.entryName)) return { ok: false, error: 'patch 含非法路径: ' + e.entryName };
    }

    const metaBuf = zip.readFile('patch.json');
    if (!metaBuf) return { ok: false, error: 'patch 缺 patch.json' };
    let meta;
    try { meta = JSON.parse(metaBuf.toString('utf-8')); }
    catch (e) { return { ok: false, error: 'patch.json 解析失败' }; }

    // 2) 验签：无签名或签名错误一律拒绝（防篡改，不能因 sha256 对得上就信任）
    if (!meta.signature || !pubkeyPem) return { ok: false, error: 'patch 未签名' };
    let sigOk = false;
    try {
        sigOk = crypto.verify(null, Buffer.from(canonical(meta), 'utf8'), pubkeyPem,
            Buffer.from(meta.signature, 'base64'));
    } catch (e) { sigOk = false; }
    if (!sigOk) return { ok: false, error: 'patch 签名验证失败' };

    // 3) sha256：逐文件校验 changed/** 内容
    const sha256 = meta.sha256 || {};
    for (const rel of [...(meta.added || []), ...(meta.modified || [])]) {
        const data = zip.readFile('changed/' + rel);
        if (!data) return { ok: false, error: 'patch 缺文件 ' + rel };
        const h = crypto.createHash('sha256').update(data).digest('hex');
        if (h !== sha256[rel]) return { ok: false, error: '文件校验失败 ' + rel };
    }

    // 4) 本地改动检测（若提供 baseline）：用户改过 diff 范围内文件 → 列出，不静默覆盖
    let localChanges = [];
    if (currentManifest && currentManifest.files) {
        const scope = [...(meta.added || []), ...(meta.modified || []), ...(meta.removed || [])];
        for (const rel of scope) {
            const m = currentManifest.files[rel];
            if (!m) continue;
            const localPath = path.join(currentManifest.root || '', rel);
            if (fs.existsSync(localPath) && sha256File(localPath) !== m.sha256) localChanges.push(rel);
        }
    }

    return { ok: true, files: sha256, removed: meta.removed || [], meta, localChanges };
}

/* ============================================================ stagePatch */

/**
 * 把校验通过的 patch 写入 staging，并写出待切换信号文件；绝不覆盖任何运行文件。
 * @param {object} opts {pubkeyPem, stagingDir, updatesDir, target, runtimeDir?, verifyAgainst?}
 */
function stagePatch(patchBuffer, opts) {
    const o = opts || {};
    if (!o.stagingDir || !o.updatesDir || !o.target) {
        return { ok: false, error: 'stagePatch 缺少 stagingDir/updatesDir/target' };
    }
    const verifyAgainst = o.verifyAgainst
        ? Object.assign({}, o.verifyAgainst, { root: o.runtimeDir || o.verifyAgainst.root || '' })
        : null;
    const v = verifyPatch(patchBuffer, o.pubkeyPem, verifyAgainst);
    if (!v.ok) return v;

    // 用户改过 diff 范围内的文件 → 拒绝，交上层告警/回退，不得静默覆盖
    if (v.localChanges && v.localChanges.length) {
        return { ok: false, error: '检测到本地改动，已跳过增量: ' + v.localChanges.join(', '), localChanges: v.localChanges };
    }

    const stagingDir = path.resolve(o.stagingDir);
    const updatesDir = path.resolve(o.updatesDir);
    const patchRoot = path.join(stagingDir, 'changed');

    // 解压每个条目前复核：path.resolve 后必须仍在 staging/changed 内（zip-slip 二次防线）
    const z = new AdmZip(Buffer.isBuffer(patchBuffer) ? patchBuffer : Buffer.from(patchBuffer));
    for (const e of z.getEntries()) {
        if (!isSafeEntryName(e.entryName)) return { ok: false, error: 'patch 含非法路径: ' + e.entryName };
    }

    try {
        fs.mkdirSync(patchRoot, { recursive: true });
        for (const rel of [...(v.meta.added || []), ...(v.meta.modified || [])]) {
            if (!isSafeEntryName(rel)) return { ok: false, error: 'patch 含非法路径: ' + rel };
            const dest = path.resolve(patchRoot, rel);
            const chk = path.relative(patchRoot, dest);
            if (chk.startsWith('..') || path.isAbsolute(chk)) {
                return { ok: false, error: 'patch 文件越出 staging 目录: ' + rel };
            }
            const data = z.readFile('changed/' + rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, data);   // 只写 staging，不执行、不落运行目录
        }

        fs.mkdirSync(updatesDir, { recursive: true });
        const pending = {
            target: o.target,                       // Task 4 依赖：目标版本号
            stagingPath: stagingDir,
            files: {},                              // {rel:{sha256}} — Task 4 据此备份/覆盖
            removed: v.removed,
            backupDir: path.join(updatesDir, 'rollback-' + o.target),  // 备份标记
            createdAt: new Date().toISOString(),
        };
        for (const [rel, h] of Object.entries(v.files)) pending.files[rel] = { sha256: h };
        fs.writeFileSync(path.join(updatesDir, 'pending-switch.json'),
            JSON.stringify(pending, null, 2), 'utf8');

        return { ok: true, stagingPath: stagingDir, pending, localChanges: v.localChanges };
    } catch (e) {
        return { ok: false, error: '写入 staging 失败: ' + (e && e.message) };
    }
}

/* --------------------------------------------------------- 下载 patch 字节 */

/** 复用 A 方案的 request(stream) 下载 patch（二进制；非 stream 模式会 utf8 解码损坏内容）。
 *  URL 安全由 request 内部的 assertSafeUrl 负责（含 DNS 与 302 复检），此处不绕过。 */
async function downloadPatchBytes(cfg, asset, onProgress) {
    const candidates = candidateDownloadUrls(cfg, asset);
    if (!candidates.length) throw new Error('没有可用的 patch 下载源');
    const errors = [];
    for (const entry of candidates) {
        try {
            const r = await request(entry.url, { timeout: 30000 }, true);
            if (r.status !== 200) { errors.push(entry.label + ': HTTP ' + r.status); continue; }
            const total = Number(r.length) || 0;
            let received = 0;
            const chunks = [];
            await new Promise((resolve, reject) => {
                r.stream.on('data', (d) => {
                    chunks.push(d);
                    received += d.length;
                    if (typeof onProgress === 'function') onProgress(received, total, entry.label);
                });
                r.stream.on('end', resolve);
                r.stream.on('error', reject);
            });
            return Buffer.concat(chunks);
        } catch (e) {
            errors.push(entry.label + ': ' + (e && e.message));
        }
    }
    throw new Error('patch 下载失败：' + errors.join('；'));
}

/* ================================================================ 导出 */

module.exports = {
    diffLocal,
    detectLocalChanges,
    sha256File,
    canonical,
    isSafeEntryName,
    verifyPatch,
    stagePatch,
    downloadPatchBytes,
    assertSafeUrl,          // 重新导出，方便调用方复用同一份实现
};
