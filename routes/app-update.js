/**
 * routes/app-update.js
 * 提供 Android / 移动端版本检测与 APK 安装包托管下载服务
 *
 * v5.1（2026-11-22）分发链二次加固：
 *  - 版本号唯一来源：payload/android-version.json（打包时生成）→ dev 下 android/app/build.gradle。
 *    ★ 不再回退 4.6.0：打包后的 EXE 里没有 android/ 目录，旧回退会把 6.8.x 的 PC 说成 4.6.0。
 *  - APK 采用「固定别名 + SHA 绑定」：服务端只读 android-dist/CinemaVault-Android.apk，
 *    并要求它的 SHA-256/体积与 android-version.json 完全一致；不一致就不下发。
 *    这样既不会出现「通用名回退拿 4.6.0 旧包」，也不需要按版本号拼路径。
 *  - 搜索顺序：config.androidApkDir（可选逃生口）→ <root>/android-dist/ → <root>/。
 *    打包时 android-dist/ 会随 payload 一起进 EXE，手机才能离线从 PC 取到安装包。
 *  - 版本接口下发 apkAvailable / apkExact / apkSha256 / minSdk；证书指纹由客户端
 *    比对本机已安装签名，服务端不执行任何外部程序。
 *  - 下载仍走 res.sendFile（Range/206 断点续传），但 Cache-Control: no-store，避免缓存旧包。
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 仓库根：dev 下是项目根；打包后是 resources/payload
const REPO_ROOT = path.join(__dirname, '..');
const VERSION_JSON = path.join(REPO_ROOT, 'android-version.json');
const GRADLE_FILE = path.join(REPO_ROOT, 'android', 'app', 'build.gradle');
const ANDROID_DIST_DIR = path.join(REPO_ROOT, 'android-dist');
// 版本号白名单：只允许 5.1.0 / 5.1.0-beta.1 这类语义化版本，杜绝 ../ 之类的路径片段
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/* ------------------------------------------------------------------ *
 * 1) 版本信息：payload/android-version.json 优先，dev 下读 build.gradle
 * ------------------------------------------------------------------ */
function normalizeVersionInfo(obj, source) {
    if (!obj || typeof obj !== 'object') return null;
    const code = parseInt(obj.versionCode, 10);
    const name = String(obj.versionName || obj.version || '').trim();
    if (!Number.isFinite(code) || code <= 0 || !VERSION_RE.test(name)) return null;
    return {
        versionCode: code,
        versionName: name,
        minSdk: parseInt(obj.minSdk, 10) || null,
        builtAt: obj.builtAt || null,
        changelog: typeof obj.changelog === 'string' ? obj.changelog : '',
        // 固定别名 APK 的完整性绑定：缺 SHA 时服务端拒绝下发
        apkSha256: /^[a-f0-9]{64}$/.test(String(obj.apkSha256 || '')) ? String(obj.apkSha256) : null,
        apkSize: parseInt(obj.apkSize, 10) || 0,
        source
    };
}

function readVersionJson() {
    const candidates = [
        VERSION_JSON,
        insideRoot(ANDROID_DIST_DIR, 'android-version.json')
    ];
    for (const p of candidates) {
        try {
            const j = JSON.parse(fs.readFileSync(p, 'utf8'));
            const info = normalizeVersionInfo(j, 'android-version.json');
            if (info) return info;
        } catch (e) { /* 试下一个候选 */ }
    }
    return null;
}

function parseGradleVersion() {
    try {
        const raw = fs.readFileSync(GRADLE_FILE, 'utf8');
        // 先剥掉注释，避免注释里的 versionCode 被误命中
        const content = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        const codeMatch = content.match(/versionCode\s*=?\s*(\d+)/);
        const nameMatch = content.match(/versionName\s*=?\s*["']([^"']+)["']/);
        if (!codeMatch || !nameMatch) throw new Error('未匹配到 versionCode / versionName');
        const minMatch = content.match(/minSdk\s*=?\s*(\d+)/);
        return normalizeVersionInfo({
            versionCode: codeMatch[1],
            versionName: nameMatch[1],
            minSdk: minMatch ? minMatch[1] : null,
            builtAt: null,
            changelog: ''
        }, 'android/app/build.gradle');
    } catch (e) {
        console.warn(`[app-update] 读取 android/app/build.gradle 版本失败：${e.message}`);
        return null;
    }
}

/** 所有版本源都失败时返回 null —— 调用方必须返回「没有版本信息」，绝不猜。 */
function resolveVersionInfo() {
    return readVersionJson() || parseGradleVersion();
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
 * 固定别名 + SHA 绑定：
 *   构建脚本永远把当前发行包写成 android-dist/CinemaVault-Android.apk，
 *   同时把它的 SHA-256/体积写进 android-version.json。
 *   服务端只认这个固定路径，并且必须与版本 JSON 里的哈希完全一致才下发。
 *   —— 不按文件名/版本号拼路径，也不存在「通用名回退拿旧包」的可能。
 */
function insideRoot(rootDir, targetName) {
    const root = path.resolve(rootDir);
    const full = path.resolve(root, targetName);
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error('refused path outside root: ' + targetName);
    }
    return full;
}

const APK_FILE = insideRoot(ANDROID_DIST_DIR, 'CinemaVault-Android.apk');
const CHANGELOG_FILE = insideRoot(ANDROID_DIST_DIR, 'changelog.txt');

/** 读取固定别名 APK，并校验它确实是版本 JSON 描述的那一个 */
function loadApk(info) {
    if (!info || !/^[a-f0-9]{64}$/.test(String(info.apkSha256 || ''))) {
        console.warn('[app-update] android-version.json 缺少 apkSha256，拒绝下发安装包');
        return null;
    }
    try {
        const stat = fs.statSync(APK_FILE);
        if (!stat.isFile() || stat.size <= 0) return null;
        if (info.apkSize && info.apkSize !== stat.size) {
            console.warn(`[app-update] APK 体积不符（JSON ${info.apkSize} / 实际 ${stat.size}），拒绝下发`);
            return null;
        }
        if (!isDistributableApk(APK_FILE)) return null;
        const sha256 = sha256OfFile(APK_FILE, stat);
        if (sha256 !== info.apkSha256) {
            console.warn('[app-update] APK SHA-256 与 android-version.json 不一致，拒绝下发（请重新构建/复制发行包）');
            return null;
        }
        return {
            path: APK_FILE,
            name: `CinemaVault-v${info.versionName}-Android.apk`,
            stat: stat,
            exact: true,
            sha256: sha256
        };
    } catch (e) {
        return null;
    }
}

/** 更新说明：android-dist/changelog.txt → 版本 JSON → 兜底 */
function readChangelog(info) {
    try {
        const s = fs.readFileSync(CHANGELOG_FILE, 'utf8').trim();
        if (s) return s;
    } catch (e) { /* 没有更新说明就用版本 JSON / 兜底 */ }
    if (info.changelog) return info.changelog;
    return '本次更新包含体验优化与问题修复，建议在 Wi-Fi 下安装。';
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
 * 4) 签名证书指纹：改由「客户端」比对本机已安装证书，服务端不执行外部程序
 * ------------------------------------------------------------------ *
 * 旧实现 spawn apksigner 现算证书指纹，既引入命令执行面，又在没有 JDK 的
 * 用户机器上必然失败。安装包是否可信，最终要由手机端拿「APK 内证书」
 * 和「本机已安装包的证书」比对 —— 服务端说什么都不该成为信任根。
 * 因此这里只保留 SHA-256；signerSha256 字段固定为 null，客户端忽略即可。
 */

/* ------------------------------------------------------------------ *
 * 5) 聚合信息（两个接口共用，保证口径一致）
 * ------------------------------------------------------------------ */
async function buildVersionPayload() {
    const info = resolveVersionInfo();
    if (!info) {
        return { info: null, apk: null, apkSize: 0, apkSha256: null, signerSha256: null };
    }
    const apk = loadApk(info);
    const apkSha256 = apk ? apk.sha256 : null;
    const apkSize = apk ? apk.stat.size : 0;
    if (!apk) {
        console.warn(`[app-update] v${info.versionName} 没有可下发的安装包（或 SHA/体积不匹配），本次不下发更新`);
    }

    return {
        info: info,
        apk: apk,
        apkSize: apkSize,
        apkSha256: apkSha256,
        signerSha256: null
    };
}

/* ------------------------------------------------------------------ *
 * 6) 接口：版本检测（无需登录，手机启动即查）
 * ------------------------------------------------------------------ */
router.get('/android-version', async (req, res) => {
    try {
        const p = await buildVersionPayload();
        if (!p.info) {
            return res.json({
                success: true,
                version: null,
                versionCode: 0,
                apkUrl: null,
                fileName: null,
                apkAvailable: false,
                apkExact: false,
                apkSize: 0,
                fileSize: 0,
                apkSha256: '',
                signerSha256: null,
                minSdk: null,
                changelog: '',
                publishedAt: null,
                versionSource: 'none',
                error: '电脑端未找到安卓版本信息（android-version.json / build.gradle）'
            });
        }
        res.json({
            success: true,
            version: p.info.versionName,
            versionCode: p.info.versionCode,
            // 只有精确包存在时才给可用下载地址；客户端以 apkAvailable/apkExact 为准
            apkUrl: p.apk ? '/api/app/download/android-apk' : null,
            fileName: p.apk ? p.apk.name : null,
            apkAvailable: !!p.apk,
            apkExact: !!(p.apk && p.apk.exact),
            // 旧客户端读 fileSize，新客户端读 apkSize / apkSha256 / signerSha256
            fileSize: p.apkSize,
            apkSize: p.apkSize,
            apkSha256: p.apkSha256 || '',
            signerSha256: p.signerSha256,
            apkName: p.apk ? p.apk.name : null,
            minSdk: p.info.minSdk,
            changelog: readChangelog(p.info),
            publishedAt: p.apk ? p.apk.stat.mtime.toISOString() : (p.info.builtAt || null),
            versionSource: p.info.source
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
    if (!payload.info || !apk) {
        return res.status(404).json({ error: '未找到精确版本的 APK 安装包文件' });
    }

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${apk.name}"`);
    // 安装包不能吃缓存：升级后必须拿到新包
    res.setHeader('Cache-Control', 'no-store');
    if (payload.apkSha256) res.setHeader('X-Apk-Sha256', payload.apkSha256);
    if (payload.signerSha256) res.setHeader('X-Apk-Signer-Sha256', payload.signerSha256);
    res.setHeader('X-Apk-Version-Code', String(payload.info.versionCode));

    // sendFile 自带 Range(206) / ETag / Last-Modified，断点续传可用
    res.sendFile(apk.path, {
        acceptRanges: true,
        etag: true,
        lastModified: true,
        cacheControl: false
    }, (err) => {
        if (!err) return;
        if (res.headersSent) return;                 // 头已发出（如客户端中途断开）就不要再写
        if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') return;
        const code = err.statusCode || err.status || 500;
        console.warn(`[app-update] APK 下载失败：${err.message || err}`);
        res.status(code).json({ error: '安装包发送失败' });
    });
});

/* ------------------------------------------------------------------ *
 * 8) 手机扫码配对：独立路由（签发 / 兑换 / 配对码仓库）
 * ------------------------------------------------------------------ *
 * 拆成三个文件是为了让「签发」和「兑换」不落在同一处，职责清楚：
 *   routes/pair-code.js  — 电脑端已登录会话签发一次性配对码
 *   routes/pair-claim.js — 手机用配对码换 lml_session
 *   utils/pair-store.js  — 120s、单次使用的进程内配对码仓库
 * 它们都挂在 /api/app 前缀下（该前缀本身免登录）。
 */
router.use(require('./pair-code'));
router.use(require('./pair-claim'));

module.exports = router;
