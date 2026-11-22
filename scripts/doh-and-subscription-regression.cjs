/* DoH 兜底 + 订阅 schema 门禁的纯逻辑回归：不联网、不启服务、不读写用户数据。
 * 从源文件抽取纯函数做隔离断言（这些函数不依赖网络/文件系统）。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 1) doh.js 的 IP 判定与端点白名单（直接 require，模块加载无网络副作用）
const dohSrc = fs.readFileSync(path.join(root, 'utils', 'media-sources', 'doh.js'), 'utf8');
const dohFn = require(path.join(root, 'utils', 'media-sources', 'doh.js'));
const D = dohFn.isBlockedIp;
for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fc00::1']) {
    assert.equal(D(ip), true, '应拦截: ' + ip);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.114.4', '223.5.5.5']) {
    assert.equal(D(ip), false, '应放行: ' + ip);
}
assert.ok(dohSrc.includes('https://dns.alidns.com/resolve'), '应含国内阿里 DoH 端点');
assert.ok(dohSrc.includes('https://doh.pub/dns-query'), '应含国内腾讯 DoH 端点');
assert.ok(!dohSrc.includes('http://'), 'DoH 源码不应含 http:// 端点（仅 https）');

// 2) engine.js 的 schemaSupported 门禁
const engineSrc = fs.readFileSync(path.join(root, 'utils', 'media-sources', 'engine.js'), 'utf8');
const m = engineSrc.match(/const FACTORY_MAX_VERSION = Object\.freeze\([^;]+\);[\s\S]*?function schemaSupported\(def\) \{[\s\S]*?\n\}/);
assert.ok(m, 'engine.js 应含 FACTORY_MAX_VERSION 与 schemaSupported');
const schemaSupported = new Function(m[0] + '\nreturn schemaSupported;')();

assert.equal(schemaSupported({ factoryId: 'web-selector', version: 2 }), true, 'web-selector v2 支持');
assert.equal(schemaSupported({ factoryId: 'web-selector', version: 3 }), false, 'web-selector v3 超上限');
assert.equal(schemaSupported({ factoryId: 'json-api', version: 1 }), true, 'json-api v1 支持');
assert.equal(schemaSupported({ factoryId: 'json-api', version: 2 }), false, 'json-api v2 超上限');
assert.equal(schemaSupported({ factoryId: 'rss', version: 1 }), true, 'rss v1 支持');
assert.equal(schemaSupported({ factoryId: 'web-selector', schemaVersion: 4 }), false, 'schemaVersion 优先且超上限');
assert.equal(schemaSupported({ factoryId: 'web-selector' }), true, '无版本字段兼容');
assert.equal(schemaSupported({ factoryId: 'web-selector', version: 'x' }), false, '非数字版本拒绝');

// 3) 现有内置源都应通过门禁（防止门禁过严误伤）
const subsDir = path.join(root, 'utils', 'media-sources', 'subs');
function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.json')) out.push(p);
    }
    return out;
}
const defs = walk(subsDir, []);
assert.ok(defs.length > 0, '应能找到内置源定义');
for (const f of defs) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(schemaSupported(d), true, '内置定义不应被门禁拒绝: ' + path.relative(root, f));
}

console.log('PASS DoH 安全判定、schemaVersion 门禁、内置源兼容（' + defs.length + ' 份定义）');
