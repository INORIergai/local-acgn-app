/* 增量更新修复回归：baseline 版本校验 / 镜像优先 / android-dist 口径一致。不触网、不碰真实用户数据。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../utils/updater');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-inc-fix-'));
try {
    // 1) 扫描前缀与发布端 ALLOWED 口径一致（含 android-dist）
    assert.ok(updater.INCREMENTAL_FILE_PREFIXES.includes('android-dist/'),
        'INCREMENTAL_FILE_PREFIXES 应含 android-dist/');

    // 2) synthesizeBaseline 能扫到 android-dist 文件
    const rt = path.join(tmp, 'runtime');
    fs.mkdirSync(path.join(rt, 'android-dist'), { recursive: true });
    fs.mkdirSync(path.join(rt, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(rt, 'package.json'), JSON.stringify({ version: '6.8.9' }));
    fs.writeFileSync(path.join(rt, 'android-dist', 'CinemaVault-Android.apk'), 'APK');
    fs.writeFileSync(path.join(rt, 'routes', 'app.js'), 'x');
    const syn = updater.synthesizeBaseline(rt, '6.8.9');
    assert.ok(syn.files['android-dist/CinemaVault-Android.apk'], 'baseline 应含 android-dist APK');
    assert.ok(syn.files['routes/app.js'], 'baseline 应含 routes 文件');
    assert.equal(syn.version, '6.8.9');

    // 3) 核心 bug：磁盘 baseline 版本过期（6.8.5）时，ensureBaseline 必须现场重合成，
    //    而不是直接返回过期 baseline（否则拼错 patch 名 → 404 → 回退全量）。
    const stale = path.join(tmp, 'baseline-manifest.json');
    fs.writeFileSync(stale, JSON.stringify({
        version: '6.8.5',
        files: { 'package.json': { sha256: 'deadbeef', size: 1 } },
    }));
    const fixed = updater.ensureBaseline({ runtimeDir: rt, baselinePath: stale, version: '6.8.9' });
    assert.equal(fixed.version, '6.8.9', '过期 baseline 应被重合成为当前版本');
    assert.equal(fixed.files['package.json'].sha256 !== 'deadbeef', true,
        '重合成后 package.json 哈希应来自磁盘实际文件');

    // 4) 版本一致时可直接复用磁盘 baseline（避免每次重扫）
    fs.writeFileSync(stale, JSON.stringify({
        version: '6.8.9',
        files: { 'package.json': { sha256: 'abc123', size: 1 } },
    }));
    const reused = updater.ensureBaseline({ runtimeDir: rt, baselinePath: stale, version: '6.8.9' });
    assert.equal(reused.files['package.json'].sha256, 'abc123', '版本一致应复用磁盘 baseline');

    // 5) 候选下载 URL：镜像必须排在官方原站之前（加速优先）
    const asset = { downloadUrl: 'https://github.com/o/r/releases/download/v1/f.exe' };
    const urls = updater.candidateDownloadUrls({
        downloadPrefix: '',
        mirrorPrefixes: ['https://mirror-a.example/', 'https://mirror-b.example/'],
    }, asset);
    const labels = urls.map(u => u.label);
    const originIdx = labels.indexOf('官方原站');
    assert.ok(originIdx > 0, '官方原站不应排第一');
    assert.ok(labels.slice(0, originIdx).every(l => l.startsWith('加速镜像')),
        '原站之前应全是加速镜像');
    assert.equal(labels[labels.length - 1], '官方原站', '原站应兜底在最后');

    console.log('PASS 增量修复：baseline 版本校验 / 镜像优先 / android-dist 口径');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
