/**
 * routes/app-update.js
 * 提供 Android / 移动端版本检测与 APK 安装包托管下载服务
 *
 * round117（v4.6.0）分发链加固：
 *  - 版本号唯一来源：android/app/build.gradle（解析失败才回退，且一定打警告日志）
 *  - APK 只认「exact 版本名」与通用名；禁止把 Gradle debug 产物当发行包（app-debug.apk 一律拒绝）
 *  - 版本接口下发 apkSha256 / apkSize / signerSha256，供原生下载后校验完整性 + 比对证书指纹
 *  - 下载改走 res.sendFile：自动获得 Range(206) / ETag / Last-Modified，断点续传可用
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

// 仓库根：只由 __dirname 推导，不再硬编码任何盘符/绝对路径
const REPO_ROOT = path.join(__dirname, '..');
const FALLBACK_VERSION = { versionCode: 4, versionName: '4.6.0' };
const SIGNER_CACHE_FILE = path.join(REPO_ROOT, 'cache', 'apk-signer-cache.json');

/* ------------------------------------------------------------------ *
 * 1) 版本信息：唯一来源 = android/app/build.gradle
 * ------------------------------------------------------------------ */
function parseVersionFromGradle() {
    const gp = path.join(REPO_ROOT, 'android', 'app', 'build.gradle');
    try {
        const raw = fs.readFileSync(gp, 'utf8');
        // 先剥掉注释，避免注释里的 versionCode 被误命中
        const content = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        const codeMatch = content.match(/versionCode\s*=?\s*(\d+)/);
        const nameMatch = content.match(/versionName\s*=?\s*["']([^"']+)["']/);
        if (!codeMatch || !nameMatch) {
            throw new Error('未在 build.gradle 中匹配到 versionCode / versionName');
        }
        return {
            versionCode: parseInt(codeMatch[1], 10),
            versionName: nameMatch[1],
            source: 'android/app/build.gradle'
        };
    } catch (e) {
        console.warn(`[app-update] 警告：读取 android/app/build.gradle 版本失败，回退 ${FALLBACK_VERSION.versionName}(code ${FALLBACK_VERSION.versionCode})：${e.message}`);
        return Object.assign({ source: 'fallback' }, FALLBACK_VERSION);
    }
}

/* ------------------------------------------------------------------ *
 * 2) 定位可分发 APK
 * ------------------------------------------------------------------ */
/** 发行包护栏：debug 产物、build/ 目录下的一律不认 */
function isDistributableApk(p) {
    const full = String(p).toLowerCase();
    const base = path.basename(full);
    if (base === 'app-debug.apk' || /-debug\.apk$/.test(base)) return false;
    if (/[\\/]build[\\/]/.test(full)) return false;
    return true;
}

/**
 * 候选文件名：exact 版本名优先，其次通用名。
 * 例：['CinemaVault-v4.6.0-Android.apk', 'CinemaVault-Android.apk']
 */
function apkCandidateNames(versionName) {
    const names = [];
    if (versionName) names.push(`CinemaVault-v${versionName}-Android.apk`);
    names.push('CinemaVault-Android.apk');
    return names;
}

function findApk(versionName) {
    for (const name of apkCandidateNames(versionName)) {
        const p = path.join(REPO_ROOT, name);
        if (!isDistributableApk(p)) continue;
        try {
            const stat = fs.statSync(p);
            if (!stat.isFile() || stat.size <= 0) continue;
            return { path: p, name: name, stat: stat, exact: name !== 'CinemaVault-Android.apk' };
        } catch (e) { /* 不存在就试下一个 */ }
    }
    return null;
}

/* ------------------------------------------------------------------ *
 * 3) SHA-256：按 mtime+size 缓存，避免每次请求都重算 7MB
 * ------------------------------------------------------------------ */
const shaCache = new Map();   // apkPath -> { mtimeMs, size, sha256 }

function sha256OfFile(p, stat) {
    const hit = shaCache.get(p);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.sha256;
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(p, 'r');
    try {
        const buf = Buffer.allocUnsafe(1024 * 1024);
        let n;
        // eslint-disable-next-line no-cond-assign
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    const sha256 = hash.digest('hex');
    shaCache.set(p, { mtimeMs: stat.mtimeMs, size: stat.size, sha256: sha256 });
    return sha256;
}

/* ------------------------------------------------------------------ *
 * 4) 签名证书指纹：build-tools/apksigner 现算 + 落盘缓存（失败一律 null）
 * ------------------------------------------------------------------ */
const signerMemory = new Map();           // apkSha256 -> signerSha256
let signerMissAt = 0;                     // 上次探测失败的时间（避免每次请求都 spawn）
let apksignerPath;                        // undefined=未探测过，null=找不到

function compareBuildToolsDesc(a, b) {
    const pa = String(a).split(/[.-]/).map(Number);
    const pb = String(b).split(/[.-]/).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return y - x;
    }
    return 0;
}

function findApksigner() {
    if (apksignerPath !== undefined) return apksignerPath;
    apksignerPath = null;
    const roots = [];
    if (process.env.ANDROID_HOME) roots.push(path.join(process.env.ANDROID_HOME, 'build-tools'));
    if (process.env.ANDROID_SDK_ROOT) roots.push(path.join(process.env.ANDROID_SDK_ROOT, 'build-tools'));
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'build-tools'));
    roots.push(path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'build-tools'));
    roots.push('/usr/lib/android-sdk/build-tools');
    for (const root of roots) {
        let versions = [];
        try { versions = fs.readdirSync(root); } catch (e) { continue; }
        versions.sort(compareBuildToolsDesc);
        for (const v of versions) {
            for (const exe of ['apksigner.bat', 'apksigner']) {
                const p = path.join(root, v, exe);
                try {
                    if (fs.statSync(p).isFile()) { apksignerPath = p; return apksignerPath; }
                } catch (e) { /* 继续找 */ }
            }
        }
    }
    return apksignerPath;
}

function runApksigner(apkPath) {
    return new Promise((resolve) => {
        const bin = findApksigner();
        if (!bin) return resolve(null);
        // Windows 的 apksigner 是 .bat，Node 不能 execFile 直接跑，统一用 exec + 全路径加引号
        const cmd = `"${bin}" verify --print-certs "${apkPath}"`;
        exec(cmd, { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = String(stdout || '') + '\n' + String(stderr || '');
            const m = out.match(/certificate SHA-256 digest:\s*([0-9a-fA-F:]{64,95})/);
            if (m) return resolve(m[1].replace(/:/g, '').toLowerCase());
            if (err) console.warn(`[app-update] apksigner 读取签名失败（signerSha256 返回 null）：${err.message}`);
            resolve(null);
        });
    });
}

async function resolveSignerSha256(apkPath, apkSha256) {
    if (signerMemory.has(apkSha256)) return signerMemory.get(apkSha256);
    // 落盘缓存：重启后不必再 spawn 一次 apksigner
    try {
        const j = JSON.parse(fs.readFileSync(SIGNER_CACHE_FILE, 'utf8'));
        if (j && j.apkSha256 === apkSha256 && j.signerSha256) {
            signerMemory.set(apkSha256, j.signerSha256);
            return j.signerSha256;
        }
    } catch (e) { /* 没缓存就现算 */ }
    if (Date.now() - signerMissAt < 5 * 60 * 1000) return null;   // 5 分钟内失败过就不再重试
    const signer = await runApksigner(apkPath);
    if (!signer) { signerMissAt = Date.now(); return null; }
    signerMemory.set(apkSha256, signer);
    try {
        fs.mkdirSync(path.dirname(SIGNER_CACHE_FILE), { recursive: true });
        fs.writeFileSync(SIGNER_CACHE_FILE, JSON.stringify({
            apkSha256: apkSha256, signerSha256: signer, at: new Date().toISOString()
        }, null, 2));
    } catch (e) { /* 缓存写不进去不影响主流程 */ }
    return signer;
}

/* ------------------------------------------------------------------ *
 * 5) 聚合信息（两个接口共用，保证口径一致）
 * ------------------------------------------------------------------ */
async function buildVersionPayload() {
    const info = parseVersionFromGradle();
    const apk = findApk(info.versionName);
    if (apk && !apk.exact) {
        console.warn(`[app-update] 警告：未找到 CinemaVault-v${info.versionName}-Android.apk，回退到通用名 ${apk.name}（请确认它确实是 v${info.versionName} 的包）`);
    }

    let apkSha256 = null;
    let signerSha256 = null;
    let apkSize = 0;
    if (apk) {
        apkSize = apk.stat.size;
        apkSha256 = sha256OfFile(apk.path, apk.stat);
        signerSha256 = await resolveSignerSha256(apk.path, apkSha256);
    }

    return {
        info: info,
        apk: apk,
        apkSize: apkSize,
        apkSha256: apkSha256,
        signerSha256: signerSha256
    };
}

/* ------------------------------------------------------------------ *
 * 6) 接口：版本检测（无需登录，手机启动即查）
 * ------------------------------------------------------------------ */
router.get('/android-version', async (req, res) => {
    try {
        const p = await buildVersionPayload();
        res.json({
            success: true,
            version: p.info.versionName,
            versionCode: p.info.versionCode,
            apkUrl: '/api/app/download/android-apk',
            fileName: `CinemaVault-v${p.info.versionName}-Android.apk`,
            // 旧客户端读 fileSize，新客户端读 apkSize / apkSha256 / signerSha256
            fileSize: p.apkSize,
            apkSize: p.apkSize,
            apkSha256: p.apkSha256 || '',
            signerSha256: p.signerSha256,
            apkName: p.apk ? p.apk.name : null,
            changelog: [
                '1.【加载提速】静态资源与接口响应启用 gzip 压缩，弱网首屏明显更快',
                '2.【更新校验】安装包下载完成后自动校验 SHA-256 与签名证书，杜绝安装被替换的包',
                '3.【断点续传】更新包支持 Range 续传，切后台或掉线后可继续下载',
                '4.【版本统一】版本号与安装包强绑定，修复旧包被当成新版下发的问题',
                '5.【稳定性】修复若干移动端兼容与细节体验问题'
            ].join('\n'),
            publishedAt: p.apk ? p.apk.stat.mtime.toISOString() : new Date().toISOString(),
            versionSource: p.info.source,
            apkExact: p.apk ? p.apk.exact : false
        });
    } catch (e) {
        console.error('[app-update] 版本接口异常：', e && (e.stack || e.message || e));
        res.status(500).json({ success: false, error: '版本信息读取失败' });
    }
});

/* ------------------------------------------------------------------ *
 * 7) 接口：APK 下载（sendFile → Range/206/ETag/Last-Modified）
 * ------------------------------------------------------------------ */
router.get('/download/android-apk', async (req, res) => {
    let payload;
    try {
        payload = await buildVersionPayload();
    } catch (e) {
        console.error('[app-update] 下载接口解析版本失败：', e && (e.message || e));
        return res.status(500).json({ error: '安装包信息读取失败' });
    }
    const apk = payload.apk;
    if (!apk) {
        return res.status(404).json({ error: '未找到 APK 安装包文件' });
    }

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="CinemaVault-v${payload.info.versionName}-Android.apk"`);
    if (payload.apkSha256) res.setHeader('X-Apk-Sha256', payload.apkSha256);
    if (payload.signerSha256) res.setHeader('X-Apk-Signer-Sha256', payload.signerSha256);

    // sendFile 自带 Range(206) / ETag / Last-Modified，断点续传与协商缓存都可用
    res.sendFile(apk.path, {
        acceptRanges: true,
        etag: true,
        lastModified: true,
        cacheControl: true,
        maxAge: '5m'
    }, (err) => {
        if (!err) return;
        if (res.headersSent) return;                 // 头已发出（如客户端中途断开）就不要再写
        if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') return;
        const code = err.statusCode || err.status || 500;
        console.warn(`[app-update] APK 下载失败：${err.message || err}`);
        res.status(code).json({ error: '安装包发送失败' });
    });
});

module.exports = router;
