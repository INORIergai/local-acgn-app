/**
 * utils/tests/incremental-updater.test.js — Task 3 (M2) 增量更新客户端单测
 *
 * 覆盖 controller 裁定的安全面：
 *   - diffLocal / detectLocalChanges（本地改动不静默覆盖）
 *   - verifyPatch：验签（canonical 字节必须与 Python _cv_patch_lib._canonical() 完全一致）
 *                + zip-slip 防护 + 逐文件 sha256
 *   - Python 签 → Node 验 的真实 roundtrip
 *   - stagePatch：只写 staging / pending-switch.json，不覆盖任何运行文件
 *   - 路由：增量失败回退全量（A 方案兼容）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');

const iu = require('../incremental-updater');
const updater = require('../updater');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iu-'));
const BS = String.fromCharCode(92); // 反斜杠，避开 shell/字面量转义歧义

function makeZip(entries) {
    const z = new AdmZip();
    for (const [n, b] of Object.entries(entries)) z.addFile(n, Buffer.from(b));
    return z.toBuffer();
}

/** 生成临时 ed25519 keypair（不算硬编码密钥，符合凭据约束） */
function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { pub: publicKey, priv: privateKey };
}

/** Node 侧构造一个「合法签名」的 patch zip（changed/** 内容与 sha256 自洽） */
function makeSignedPatch(privPem, opts = {}) {
    const changed = opts.changed || { 'public/js/app.js': 'console.log(1)' };
    const sha256 = {};
    for (const [rel, content] of Object.entries(changed)) sha256[rel] = sha(content);
    const payload = {
        version: opts.version || '6.8.3',
        added: opts.added || Object.keys(changed),
        modified: opts.modified || [],
        removed: opts.removed || [],
        sha256: opts.sha256 || sha256,
    };
    const sig = crypto.sign(null, Buffer.from(iu.canonical(payload), 'utf8'), privPem).toString('base64');
    const meta = Object.assign({}, payload, { signature: opts.signature === undefined ? sig : opts.signature });
    const entries = {
        'patch.json': JSON.stringify(meta),
        'removed.json': JSON.stringify(payload.removed),
    };
    for (const [rel, content] of Object.entries(changed)) entries['changed/' + rel] = content;
    return { buf: makeZip(entries), meta, payload };
}

/**
 * 把 zip 内一个等长的良性文件名替换成恶意名（同时命中 local + central header），
 * 造出 adm-zip addFile 无法产生的真实 zip-slip（addFile 会先 sanitize）。
 */
function rawRenameZip(buf, oldName, newName) {
    const oldB = Buffer.from(oldName, 'utf8');
    const newB = Buffer.from(newName, 'utf8');
    assert.equal(newB.length, oldB.length, 'rawRenameZip: 两边字节数须相等');
    const out = Buffer.from(buf);
    let hits = 0;
    for (let i = 0; i <= out.length - oldB.length; i++) {
        if (out.subarray(i, i + oldB.length).equals(oldB)) { newB.copy(out, i); hits++; }
    }
    assert.ok(hits >= 2, 'rawRenameZip: 未在 zip 中找到文件名（local/central header）');
    return out;
}

/** 与恶意名等长的良性名（长度按 UTF-8 字节计，因为 zip 文件名以字节存储）。 */
function benignFor(malicious) {
    const len = Buffer.byteLength(malicious, 'utf8') - Buffer.byteLength('changed/', 'utf8') - 3; // ".js"
    return 'changed/' + '0'.repeat(len) + '.js';
}

/* ------------------------------------------- checkUpdate manifest 字段转换裁定 */

test('normalizeManifest converts publisher snake_case fields into camelCase', () => {
    const raw = {
        version: '6.8.3',
        generated_at: '2026-11-22T00:00:00Z',
        files: { 'public/js/app.js': { sha256: sha('x'), size: 1 } },
        binary_dirs: ['bin/'],
        full_fallback: { 'a.exe': 'url' },
    };
    const m = updater.normalizeManifest(raw);
    assert.equal(m.version, '6.8.3');
    assert.equal(m.generatedAt, '2026-11-22T00:00:00Z');
    assert.deepEqual(m.files, { 'public/js/app.js': { sha256: sha('x'), size: 1 } });
    assert.deepEqual(m.binaryDirs, ['bin/']);
    assert.deepEqual(m.fullFallback, { 'a.exe': 'url' });
    assert.equal(updater.manifestAssetName('v6.8.3'), 'cv-manifest-6.8.3.json');
});

/* ---------------------------------------------------------------- Step 16 */

test('diffLocal reports added/modified/removed', () => {
    const cur = { files: { 'a.js': { sha256: '1' }, 'b.js': { sha256: '2' }, 'c.js': { sha256: '3' } } };
    const tgt = { files: { 'a.js': { sha256: '1' }, 'b.js': { sha256: '9' }, 'd.js': { sha256: '4' } } };
    assert.deepEqual(iu.diffLocal(cur, tgt), { added: ['d.js'], modified: ['b.js'], removed: ['c.js'] });
});

test('diffLocal tolerates missing manifests and sorts deterministically', () => {
    const tgt = { files: { 'z.js': { sha256: '1' }, 'a.js': { sha256: '2' } } };
    assert.deepEqual(iu.diffLocal(null, tgt), { added: ['a.js', 'z.js'], modified: [], removed: [] });
    assert.deepEqual(iu.diffLocal(tgt, null), { added: [], modified: [], removed: ['a.js', 'z.js'] });
});

test('detectLocalChanges flags user-edited and missing files', () => {
    const dir = mkdtemp();
    fs.writeFileSync(path.join(dir, 'a.js'), 'edited');
    const manifest = { files: { 'a.js': { sha256: sha('orig') } } };
    assert.deepEqual(iu.detectLocalChanges(dir, manifest), ['a.js']);

    // 文件缺失也要报出来（不能静默当作「无需改动」）
    assert.deepEqual(iu.detectLocalChanges(dir, {
        files: { 'a.js': { sha256: sha('edited') }, 'gone.js': { sha256: sha('x') } },
    }), ['gone.js']);
    assert.deepEqual(iu.detectLocalChanges(dir, { files: { 'a.js': { sha256: sha('edited') } } }), []);
});

/* --------------------------------------------------- Step 20/21: verifyPatch */

test('verifyPatch accepts a correctly signed patch', () => {
    const { pub } = genKey();
    const { buf, payload } = makeSignedPatch(genKey().priv);
    // 用同一个私钥签、对应公钥验
    const k = genKey();
    const signed = makeSignedPatch(k.priv);
    const r = iu.verifyPatch(signed.buf, k.pub, { files: {} });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.files, signed.payload.sha256);
    assert.deepEqual(r.removed, []);
    void buf; void payload; void pub;
});

test('verifyPatch rejects bad signature / missing signature / missing pubkey', () => {
    const k = genKey();
    const { buf } = makeSignedPatch(k.priv, { signature: '!!!not-base64!!!' });
    assert.equal(iu.verifyPatch(buf, k.pub, { files: {} }).ok, false);

    const { buf: noSig } = makeSignedPatch(k.priv, { signature: '' });
    assert.equal(iu.verifyPatch(noSig, k.pub, { files: {} }).ok, false);
    assert.equal(iu.verifyPatch(makeSignedPatch(k.priv).buf, '', { files: {} }).ok, false);

    // brief 逐字用法：无签名 + 空串 signature 的畸形 patch
    const raw = makeZip({
        'patch.json': JSON.stringify({ version: '6.8.3', added: [], modified: [], removed: [], sha256: {}, signature: '' }),
    });
    assert.equal(iu.verifyPatch(raw, k.pub, { files: {} }).ok, false);
});

test('verifyPatch rejects tampered file sha256', () => {
    const k = genKey();
    const { buf, payload } = makeSignedPatch(k.priv);
    // 改 changed/** 内容但保留原签名 → 签名仍对，但 sha256 不符
    const z = new AdmZip(buf);
    z.updateFile('changed/public/js/app.js', Buffer.from('tampered'));
    const r = iu.verifyPatch(z.toBuffer(), k.pub, { files: {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /校验失败|sha256/i);
    assert.deepEqual(payload.added, ['public/js/app.js']);
});

test('verifyPatch rejects raw zip-slip paths (../, absolute, drive, UNC)', () => {
    const k = genKey();
    for (const malicious of ['../../../../evil.js', '/abs/evil.js', 'C:/abs/evil.js', BS + BS + 'srv' + BS + 'share' + BS + 'e.js']) {
        const benign = benignFor(malicious);                // 完整条目名 "changed/xxxx.js"
        const rel = benign.slice('changed/'.length);        // makeSignedPatch 要的是去掉前缀的 rel
        const base = makeSignedPatch(k.priv, { changed: { [rel]: 'x' } });
        const evil = rawRenameZip(base.buf, benign, malicious);
        const r = iu.verifyPatch(evil, k.pub, { files: {} });
        assert.equal(r.ok, false, '应拒绝: ' + malicious);
        assert.match(r.error, /非法路径|路径/);
    }
});

/* -------------------------------------------- canonical 字节一致性（Python↔Node） */

test('canonical() produces keys sorted recursively, no spaces, UTF-8', () => {
    const meta = { version: '6.8.3', sha256: { 'z/b.js': '2', 'a/中.js': '1' }, added: [], removed: [], modified: [] };
    const s = iu.canonical(meta);
    assert.equal(s, '{"added":[],"modified":[],"removed":[],"sha256":{"a/中.js":"1","z/b.js":"2"},"version":"6.8.3"}');
});

/**
 * 真实 roundtrip：用临时脚本调发布端 `_cv_patch_lib._canonical()` + `sign_payload()`
 * 生成签名，再交给 Node 的 iu.canonical() + crypto.verify 验。
 * 脚本运行时写入临时目录，用 `python -I` 隔离模式执行；密钥为临时生成，不硬编码。
 */
test('Python _canonical signs → Node canonical+verify roundtrip (byte-exact)', () => {
    const packagingDir = path.join(__dirname, '..', '..', 'packaging');
    assert.ok(fs.existsSync(path.join(packagingDir, '_cv_patch_lib.py')), '发布端库应存在');

    const script = path.join(mkdtemp(), 'cv-roundtrip-probe.py');
    fs.writeFileSync(script, [
        'import sys, json, base64',
        'sys.path.insert(0, sys.argv[1])',
        'from _cv_patch_lib import _canonical, sign_payload',
        'from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey',
        'from cryptography.hazmat.primitives import serialization',
        'payload = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))',
        'key = Ed25519PrivateKey.generate()',
        'pub = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode("ascii")',
        'canonical = _canonical(payload)',
        'sig = sign_payload(canonical, key)',
        'print(json.dumps({"pub": pub, "sig": sig, "canonicalHex": canonical.hex()}))',
    ].join('\n'));

    const changed = { 'public/js/新.js': 'console.log(1)', 'routes/数据.js': 'module.exports={}' };
    const sha256 = {};
    for (const [rel, c] of Object.entries(changed)) sha256[rel] = sha(c);
    const payload = {
        version: '6.8.3',
        added: Object.keys(changed),
        modified: [],
        removed: ['public/旧/删除.js'],
        sha256,
    };
    const arg = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const out = JSON.parse(execFileSync('python', ['-I', script, packagingDir, arg], { encoding: 'utf8', windowsHide: true }));

    // 1) canonical 字节必须完全一致（含中文/嵌套 key 排序）
    const nodeBytes = Buffer.from(iu.canonical(payload), 'utf8');
    assert.equal(nodeBytes.toString('hex'), out.canonicalHex, 'Node canonical 必须与 Python _canonical() 字节一致');

    // 2) Node crypto.verify 用 Python 的公钥/签名验 Node 重建的字节
    assert.equal(crypto.verify(null, nodeBytes, out.pub, Buffer.from(out.sig, 'base64')), true);

    // 3) 端到端：把 Python 签名塞进 patch.json，verifyPatch 应整包通过
    const meta = Object.assign({}, payload, { signature: out.sig });
    const entries = { 'patch.json': JSON.stringify(meta), 'removed.json': JSON.stringify(payload.removed) };
    for (const [rel, c] of Object.entries(changed)) entries['changed/' + rel] = c;
    const r = iu.verifyPatch(makeZip(entries), out.pub, { files: {} });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.files, sha256);
    assert.deepEqual(r.removed, payload.removed);
});

/* --------------------------------------------- Step 23: staging / pending 信号 */

test('stagePatch writes staging + pending-switch.json only, never touches runtime files', () => {
    const k = genKey();
    const root = mkdtemp();
    const runtime = path.join(root, 'runtime');
    const updates = path.join(root, 'updates');
    const staging = path.join(updates, 'staging-6.8.3');
    fs.mkdirSync(path.join(runtime, 'public', 'js'), { recursive: true });
    const live = path.join(runtime, 'public', 'js', 'app.js');
    fs.writeFileSync(live, 'OLD-LIVE');

    const { buf, payload } = makeSignedPatch(k.priv);
    const baseline = { files: { 'public/js/app.js': { sha256: sha('OLD-LIVE') } } };
    const r = iu.stagePatch(buf, {
        pubkeyPem: k.pub, stagingDir: staging, updatesDir: updates,
        target: '6.8.3', runtimeDir: runtime, verifyAgainst: baseline,
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.readFileSync(live, 'utf8'), 'OLD-LIVE', '不得覆盖运行文件');
    assert.equal(fs.readFileSync(path.join(staging, 'changed', 'public', 'js', 'app.js'), 'utf8'), 'console.log(1)');

    const pending = JSON.parse(fs.readFileSync(path.join(updates, 'pending-switch.json'), 'utf8'));
    assert.equal(pending.target, '6.8.3');
    assert.equal(pending.stagingPath, staging);
    assert.deepEqual(pending.files, { 'public/js/app.js': { sha256: sha('console.log(1)') } });
    assert.deepEqual(pending.removed, []);
    assert.ok(pending.backupDir && /rollback-6\.8\.3/.test(pending.backupDir), '含备份标记');
    assert.deepEqual(payload.added, ['public/js/app.js']);
});

test('stagePatch rejects an unsafe patch without creating pending-switch.json', () => {
    const k = genKey();
    const root = mkdtemp();
    const updates = path.join(root, 'updates');
    const staging = path.join(updates, 'staging-6.8.3');
    const malicious = '../../../../evil.js';
    const benign = benignFor(malicious);
    const { buf } = makeSignedPatch(k.priv, { changed: { [benign.slice('changed/'.length)]: 'x' } });
    const evil = rawRenameZip(buf, benign, malicious); // 等长
    const r = iu.stagePatch(evil, {
        pubkeyPem: k.pub, stagingDir: staging, updatesDir: updates, target: '6.8.3',
    });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(updates, 'pending-switch.json')), false);
});

/* --------------------------------------------------------------- 路由回退全量 */

test('POST /api/update/incremental falls back to startDownload on failure', async () => {
    const router = require('../../routes/update');
    let handler = null;
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === '/incremental' && layer.route.methods.post) {
            handler = layer.route.stack[0].handle;
        }
    }
    assert.ok(handler, '路由未注册');

    const origIncremental = updater.startIncremental;
    const origDownload = updater.startDownload;
    let downloadCalled = 0;
    let incrementalArg = null;
    updater.startIncremental = async (arg) => { incrementalArg = arg; throw new Error('无可用 patch'); };
    updater.startDownload = async (name) => { downloadCalled++; return { state: 'done', file: 'full-' + name, name }; };

    try {
        const req = { body: { assetName: 'CV-Setup.exe' } };
        const res = { json(o) { this.body = o; return this; } };
        await handler(req, res);
        assert.equal(downloadCalled, 1, '应回退到全量下载');
        assert.equal(res.body.code, 0);
        assert.equal(res.body.data.mode, 'full');
        assert.equal(res.body.data.file, 'full-CV-Setup.exe');
        assert.match(res.body.data.incrementalError, /无可用 patch/);
        assert.deepEqual(incrementalArg, req.body);
    } finally {
        updater.startIncremental = origIncremental;
        updater.startDownload = origDownload;
    }
});
