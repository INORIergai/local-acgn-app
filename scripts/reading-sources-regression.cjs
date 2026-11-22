/* 第三批阅读源改造回归：新增适配器的注册 + 安全校验；不联网、不启服务。 */
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// 1) reading.js 里三个适配器都注册成功（含独立文件的两个）
const reading = require(path.join(root, 'utils', 'media-sources', 'reading.js'));
for (const id of ['dm5', 'zaimanhua', 'komiic', 'esjzone', 'lightnovel', 'wenku8', 'ciyuanhou']) {
    const a = reading.getAdapter(id);
    assert.ok(a, '适配器应注册: ' + id);
    assert.equal(typeof a.catalog, 'function', id + '.catalog');
    assert.equal(typeof a.chapters, 'function', id + '.chapters');
    assert.equal(typeof a.read, 'function', id + '.read');
}
assert.equal(reading.getAdapter('wenku8').kind, 'novel');
assert.equal(reading.getAdapter('ciyuanhou').external, true, '次元狗应标记为外链源');

// 2) wenku8 host 白名单校验（独立文件里的 assertWenkuHost，间接测：函数不可直接导出则从源码验证）
const w8src = require('fs').readFileSync(path.join(root, 'utils', 'media-sources', 'wenku8-reading.js'), 'utf8');
assert.ok(w8src.includes("h !== 'www.wenku8.cc'"), 'wenku8 应校验 host 白名单');
assert.ok(w8src.includes("u.protocol !== 'https:'"), 'wenku8 应仅允许 https');

// 3) ciyuanhou host 白名单：仅 https + 拒绝内网
const cysrc = require('fs').readFileSync(path.join(root, 'utils', 'media-sources', 'ciyuanhou-reading.js'), 'utf8');
assert.ok(cysrc.includes('www.acgndog.com'), '次元狗白名单应含 acgndog');
assert.ok(cysrc.includes("url.protocol !== 'https:'"), '次元狗应仅允许 https');
assert.ok(cysrc.includes('isBlockedIp(h)'), '次元狗应拒绝内网');

// 4) kmoe 下载 URL 白名单：仅 https + KOOBONE 域名 + 拒绝内网
const km = require(path.join(root, 'utils', 'kmoe-download.js'));
const pass = (u) => { try { km.assertSafeDownloadUrl(u); return true; } catch (e) { return false; } };
assert.equal(pass('https://dl3.koobone.com/dl.php?file=x&sign=y'), true, '合法 KOOBONE 直链应放行');
assert.equal(pass('http://dl.koobone.com/x'), false, 'http 应拒绝');
assert.equal(pass('https://evil.com/x'), false, '非白名单域名应拒绝');
assert.equal(pass('https://127.0.0.1/x'), false, '环回应拒绝');
assert.equal(pass('https://192.168.1.1/x'), false, '私网应拒绝');
assert.notEqual(km.safeName('A/B:C*D?"E|F'), 'A/B:C*D?"E|F', '文件名应清洗非法字符');

// 5) 增量进度阶段状态字段存在（后端写 note/phase）
const usrc = require('fs').readFileSync(path.join(root, 'utils', 'updater.js'), 'utf8');
for (const kw of ["incremental-' + phase", "setPhase('checking'", "setPhase('downloading'", "setPhase('verifying'", "setPhase('ready'"]) {
    assert.ok(usrc.includes(kw), 'updater 应含阶段: ' + kw);
}

console.log('PASS 阅读源适配器注册、host 白名单、kmoe 下载安全、增量阶段状态');
