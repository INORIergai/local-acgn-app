/**
 * routes/harmony-update.js — 鸿蒙端应用内更新（纯增量）
 *
 * GET /api/app/harmony-version       → 扫描构建目录里最新的 CinemaVault-vX-unsigned.hap 出元数据
 * GET /api/app/download/harmony-hap   → 下载该 hap（sendFile 自带 Range/206 断点续传）
 *
 * 构建目录：config.harmonyBuildDir，缺省 D:/cv-harmony（本机 CLI 构建产物目录）。
 * 侧载应用无系统安装权限，客户端下载后引导用户经 Hokit/文件管理器安装（同签名证书覆盖安装免卸载）。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../utils/config');

const router = express.Router();

function buildDir() {
    return config.harmonyBuildDir || 'D:/cv-harmony';
}

/** 扫目录：CinemaVault-v1.2.3-unsigned.hap → 取版本号最大（语义化比较）者 */
function latestHap() {
    const dir = buildDir();
    if (!fs.existsSync(dir)) return null;
    const cands = [];
    for (const name of fs.readdirSync(dir)) {
        const m = name.match(/^CinemaVault-v(\d+)\.(\d+)\.(\d+)-unsigned\.hap$/i);
        if (!m) continue;
        const full = path.join(dir, name);
        try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            cands.push({
                name,
                path: full,
                major: +m[1], minor: +m[2], patch: +m[3],
                versionName: `${m[1]}.${m[2]}.${m[3]}`,
                versionCode: (+m[1]) * 1000000 + (+m[2]) * 1000 + (+m[3]),
                size: st.size,
                mtime: st.mtime
            });
        } catch (e) { /* 跳过不可读项 */ }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.major - a.major || b.minor - a.minor || b.patch - a.patch);
    return cands[0];
}

router.get('/harmony-version', (req, res) => {
    try {
        const hap = latestHap();
        if (!hap) {
            return res.status(404).json({ success: false, error: '构建目录里没有鸿蒙安装包' });
        }
        res.json({
            success: true,
            version: hap.versionName,
            versionCode: hap.versionCode,
            hapUrl: '/api/app/download/harmony-hap',
            fileName: hap.name,
            fileSize: hap.size,
            publishedAt: hap.mtime.toISOString(),
            versionSource: 'pc-build-dir',
            changelog: '以构建目录最新产物为准；下载后用 Hokit / 文件管理器安装（同证书覆盖安装，进度与配置不丢）。'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/download/harmony-hap', (req, res) => {
    try {
        const hap = latestHap();
        if (!hap) {
            return res.status(404).json({ error: '未找到鸿蒙安装包文件' });
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${hap.name}"`);
        res.sendFile(hap.path);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
