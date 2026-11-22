/**
 * DoH（DNS over HTTPS）兜底解析
 * ------------------------------------------------------------------
 * 国内网络对部分番站域名做 DNS 污染，系统 DNS 返回错误 IP，导致
 * engine.grab 的「代理→直连」两路都失败。这里提供最小 DoH 解析兜底。
 * 安全：仅 https、端点固定白名单、拒绝私网/环回/保留地址、不执行命令。
 */
'use strict';

const net = require('node:net');

// 固定白名单端点，预构造成 URL 对象；不接受任何外部传入端点。
// 国内端点在前（实测 0.3~1s 可达），境外端点兜底（部分网络不可达，约 5s 超时）。
const ALIDNS_DOH = new URL('https://dns.alidns.com/resolve');
const TENCENT_DOH = new URL('https://doh.pub/dns-query');
const CLOUDFLARE_DOH = new URL('https://cloudflare-dns.com/dns-query');
const GOOGLE_DOH = new URL('https://dns.google/resolve');
const DOH_ENDPOINTS = [ALIDNS_DOH, TENCENT_DOH, CLOUDFLARE_DOH, GOOGLE_DOH];

/** IP 是否在禁止网段（私网/环回/链路本地/保留）。用前缀判断，不拼接任何命令。 */
function isBlockedIp(addr) {
    const a = String(addr || '');
    if (a.startsWith('::1') || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8')
        || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true;
    if (!net.isIPv4(a)) return false;
    const blocked4 = ['0.', '10.', '127.', '169.254.', '192.168.', '100.6', '100.7',
        '100.8', '100.9', '100.10', '100.11', '100.12'];
    for (const pre of blocked4) if (a.startsWith(pre)) return true;
    // 172.16.x ~ 172.31.x
    if (a.startsWith('172.')) {
        const second = Number(a.split('.')[1]);
        if (second >= 16 && second <= 31) return true;
    }
    // 224.0.0.0/4 及以上为组播/保留
    if (Number(a.split('.')[0]) >= 224) return true;
    return false;
}

for (const endpoint of DOH_ENDPOINTS) {
    if (endpoint.protocol !== 'https:' || isBlockedIp(endpoint.hostname)) {
        throw new Error('DoH 白名单端点配置非法');
    }
}

/** 向单个白名单端点查询域名 A 记录，返回去重公网 IPv4 列表 */
async function queryOnce(endpoint, hostname, signal) {
    const h = String(hostname || '');
    if (!h || net.isIP(h)) return [];
    const target = new URL(endpoint.href);
    target.searchParams.set('name', h);
    target.searchParams.set('type', 'A');
    const r = await fetch(target, {
        headers: { Accept: 'application/dns-json' },
        signal: signal || AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const ips = [];
    for (const item of (j.Answer || [])) {
        const ip = String(item.data || '');
        if (item.type === 1 && net.isIPv4(ip) && !isBlockedIp(ip) && !ips.includes(ip)) ips.push(ip);
    }
    return ips;
}

/** 用 DoH 解析域名（依次尝试白名单端点，任一拿到公网 A 记录即返回） */
async function resolveViaDoh(hostname) {
    for (const endpoint of DOH_ENDPOINTS) {
        try {
            const ips = await queryOnce(endpoint, hostname);
            if (ips.length) return ips;
        } catch (e) { /* 换下一个端点 */ }
    }
    return [];
}

module.exports = { resolveViaDoh, isBlockedIp };
