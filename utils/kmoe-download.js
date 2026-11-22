/**
 * KMoe/KOOBONE 签名 EPUB → 应用漫画目录（第四批阅读源改造）
 * ------------------------------------------------------------------
 * 只接受固定的 koobone 下载域名（白名单 + 仅 https + 拒绝内网/回环），
 * 流式写到 config.comicFolders 下，以「系列标识 + 卷号」去重，
 * 绝不保存带 sign/time 的签名直链到数据库。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('node:net');
const pathGuard = require('./path-guard');

// 下载源白名单（KOOBONE 分发域名，按现有代码 dlN.koobone.com）
const DL_HOST_ALLOW = new Set(['dl.koobone.com', 'dl1.koobone.com', 'dl2.koobone.com',
    'dl3.koobone.com', 'dl4.koobone.com', 'dl5.koobone.com']);

function isBlockedIp(addr) {
    const a = String(addr || '').toLowerCase();
    if (net.isIPv6(a)) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
    if (!net.isIPv4(a)) return false;   // 域名交给白名单判断，不当 IP 处理
    const parts = a.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const x = parts[0], y = parts[1];
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254)
        || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || x >= 224;
}

/** 校验下载 URL：仅 https、固定白名单 host、拒绝内网 */
function assertSafeDownloadUrl(raw) {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') throw new Error('下载协议不是 https');
    const h = u.hostname.toLowerCase();
    if (isBlockedIp(h)) throw new Error('下载目标含内网地址');
    if (!DL_HOST_ALLOW.has(h)) throw new Error('下载目标不在 KOOBONE 白名单');
    return u;
}

/** 清洗书名做目录名：去掉 Windows 非法字符，限制长度 */
function safeName(s, fallback) {
    const cleaned = String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return cleaned || fallback || 'unknown';
}

/**
 * 把签名 EPUB 保存到应用漫画目录。
 * @param {object} opts { fetchImpl, fileUrl, title, seq, seriesId, comicFolder }
 * @returns {Promise<{ saved:boolean, filePath:string, skipped:boolean }>}
 */
async function saveEpubToComicFolder(opts) {
    const url = assertSafeDownloadUrl(opts.fileUrl);
    const roots = pathGuard.allowedRoots().filter(r => (configComicFolders()).some(c => path.resolve(c) === path.resolve(r)));
    const base = opts.comicFolder || roots[0];
    if (!base) throw new Error('未配置漫画目录（comicFolders）');
    // 目标必须在允许的扫描目录内
    if (!pathGuard.isPathAllowed(base)) throw new Error('目标目录不在允许的扫描目录内');

    const series = safeName(opts.seriesId || opts.title, 'kmoe');
    const vol = safeName('卷' + (opts.seq || '1'), 'vol');
    const dir = path.join(base, 'KMoe', series);
    const filePath = path.join(dir, vol + '.epub');
    const finalPath = path.resolve(filePath);
    if (!pathGuard.isPathAllowed(finalPath)) throw new Error('目标文件路径越界');
    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) {
        return { saved: false, filePath: finalPath, skipped: true };
    }

    const resp = await opts.fetchImpl(url.href, { redirect: 'follow' });
    if (!resp.ok || !resp.body) throw new Error('下载 EPUB 失败：HTTP ' + resp.status);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = finalPath + '.part';
    const chunks = [];
    for await (const chunk of resp.body) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    // EPUB 是 zip 容器，校验 PK 魔数，避免把 HTML 错误页写成 epub
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error('下载内容不是 EPUB（可能是签名过期或错误页）');
    }
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, finalPath);
    return { saved: true, filePath: finalPath, skipped: false };
}

function configComicFolders() {
    return require('./config').comicFolders || [];
}

module.exports = { saveEpubToComicFolder, assertSafeDownloadUrl, safeName, DL_HOST_ALLOW };
