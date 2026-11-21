/**
 * packaging/tests/incremental-switch.test.js — Task 4 (M3) 主进程原子切换 + 回滚单测
 *
 * 覆盖：
 *   - 成功切换：备份原文件 → 覆盖 → 重启 → 删 pending → 写 update-state(done)
 *   - 失败回滚：restart 抛错 / 替换中途抛错 → 恢复原文件与 removed 文件
 *   - 成功后写 baseline-manifest.json（供下次 startIncremental 当 baseline）
 *   - 幂等：无 pending 时跳过；并发时跳过
 *   - 路径安全：拒绝 zip-slip 风格的 rel（上游 Task3 已防，这里是纵深防御）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sw = require('../incremental-switch');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 构造一套 runtime + updates/staging 场景。
 * @param {object} o {target, files:{rel:content}, originals:{rel:content}, removed:[rel], patchMissing:[rel]}
 */
function scenario(o) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
    const runtime = path.join(root, 'runtime');
    const updates = path.join(root, 'updates');
    const target = o.target || '6.8.3';
    const staging = path.join(updates, 'staging-' + target);

    fs.mkdirSync(path.join(runtime, 'public'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'changed', 'public'), { recursive: true });

    // 原始文件
    for (const [rel, content] of Object.entries(o.originals || {})) {
        const p = path.join(runtime, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    // 被 removed 的文件（切换前存在于 runtime）
    for (const rel of o.removed || []) {
        const p = path.join(runtime, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, 'removed-original:' + rel);
    }
    // staging 里的新文件
    for (const [rel, content] of Object.entries(o.files || {})) {
        const p = path.join(staging, 'changed', rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    if (o.noPending) return { root, runtime, updates, staging, target };

    const files = {};
    for (const [rel, content] of Object.entries(o.files || {})) files[rel] = { sha256: sha(content) };
    const pending = {
        target,
        stagingPath: staging,
        files,
        removed: o.removed || [],
        backupDir: path.join(updates, 'rollback-' + target),
        createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(updates, 'pending-switch.json'), JSON.stringify(pending, null, 2));
    return { root, runtime, updates, staging, target, pending };
}

/* ------------------------------- Step 25 (brief verbatim) ------------------------------- */

test('applies patch and backs up originals', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
    const runtime = path.join(root, 'runtime');
    const updates = path.join(root, 'updates');
    const staging = path.join(updates, 'staging-6.8.3');
    fs.mkdirSync(path.join(runtime, 'public'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'changed', 'public'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'public', 'a.js'), 'old');
    fs.writeFileSync(path.join(staging, 'changed', 'public', 'a.js'), 'new');
    fs.writeFileSync(path.join(updates, 'pending-switch.json'), JSON.stringify({
        target: '6.8.3', stagingPath: staging,
        files: { 'public/a.js': { sha256: crypto.createHash('sha256').update('new').digest('hex') } },
        removed: []
    }));
    let restarted = 0;
    const r = await sw.checkAndApply({ runtimeDir: runtime, updatesDir: updates, restart: async () => { restarted++; }, blog: () => { } });
    assert.equal(r.applied, true);
    assert.equal(fs.readFileSync(path.join(runtime, 'public', 'a.js'), 'utf8'), 'new');
    assert.equal(restarted, 1);
    assert.ok(fs.existsSync(path.join(updates, 'rollback-6.8.3')));
});

/* ----------------------------- Step 28 (brief verbatim intent) ----------------------------- */

test('rolls back when restart fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
    const runtime = path.join(root, 'runtime');
    const updates = path.join(root, 'updates');
    const staging = path.join(updates, 'staging-6.8.3');
    fs.mkdirSync(path.join(runtime, 'public'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'changed', 'public'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'public', 'a.js'), 'old');
    fs.writeFileSync(path.join(staging, 'changed', 'public', 'a.js'), 'new');
    fs.writeFileSync(path.join(updates, 'pending-switch.json'), JSON.stringify({
        target: '6.8.3', stagingPath: staging,
        files: { 'public/a.js': { sha256: crypto.createHash('sha256').update('new').digest('hex') } },
        removed: []
    }));
    let restarted = 0;
    const r = await sw.checkAndApply({
        runtimeDir: runtime, updatesDir: updates,
        restart: async () => { restarted++; if (restarted === 1) throw new Error('boom'); },
        blog: () => { },
    });
    assert.equal(restarted, 2, '第一次重启失败后，回滚应再重启一次');
    assert.equal(r.applied, false);
    assert.equal(r.rolledBack, true);
    assert.equal(fs.readFileSync(path.join(runtime, 'public', 'a.js'), 'utf8'), 'old');
    assert.ok(fs.existsSync(path.join(updates, 'rollback-6.8.3', 'public', 'a.js')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(updates, 'update-state.json'), 'utf8')).phase, 'rolled_back');
    assert.equal(fs.existsSync(path.join(updates, 'pending-switch.json')), false,
        '回滚成功后应删除 pending，避免每 15s 反复重试');
});

test('rolls back on mid-swap failure and re-restarts backend', async () => {
    const s = scenario({
        target: '6.9.0',
        originals: { 'public/a.js': 'old-a', 'public/b.js': 'old-b' },
        files: { 'public/a.js': 'new-a', 'public/b.js': 'new-b' },
    });
    let restarts = 0;
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { restarts++; },
        hooks: { beforeWrite: (rel) => { if (rel === 'public/b.js') throw new Error('disk full'); } },
        blog: () => { },
    });
    assert.equal(r.applied, false);
    assert.equal(r.rolledBack, true);
    assert.equal(restarts, 1, '文件恢复后必须再重启一次，让 live 进程回到旧代码');
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'a.js'), 'utf8'), 'old-a',
        '第一个已写入的文件必须被恢复');
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'b.js'), 'utf8'), 'old-b');
});

test('rolls back removed files and deletes patch-added files', async () => {
    const s = scenario({
        target: '6.9.1',
        originals: { 'public/keep.js': 'old-keep' },
        files: { 'public/keep.js': 'new-keep', 'public/added.js': 'brand-new' },
        removed: ['public/gone.js'],
    });
    assert.ok(fs.existsSync(path.join(s.runtime, 'public', 'gone.js')));
    let restarted = 0;
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { restarted++; if (restarted === 1) throw new Error('boom'); },
        blog: () => { },
    });
    assert.equal(r.applied, false);
    assert.equal(r.rolledBack, true);
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'keep.js'), 'utf8'), 'old-keep');
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'gone.js'), 'utf8'),
        'removed-original:public/gone.js', 'removed 文件必须恢复');
    assert.equal(fs.existsSync(path.join(s.runtime, 'public', 'added.js')), false,
        'patch 新增文件在回滚时必须删除');
});

/* -------------------------------- 成功路径附加断言 -------------------------------- */

test('success deletes pending, writes state=done and baseline-manifest.json', async () => {
    const s = scenario({
        target: '6.8.4',
        originals: { 'public/a.js': 'old' },
        files: { 'public/a.js': 'new', 'public/b.js': 'fresh' },
    });
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { },
        blog: () => { },
    });
    assert.equal(r.applied, true);
    assert.equal(r.error, null);
    assert.equal(fs.existsSync(path.join(s.updates, 'pending-switch.json')), false);
    const state = JSON.parse(fs.readFileSync(path.join(s.updates, 'update-state.json'), 'utf8'));
    assert.equal(state.phase, 'done');
    const baseline = JSON.parse(fs.readFileSync(path.join(s.updates, 'baseline-manifest.json'), 'utf8'));
    assert.equal(baseline.version, '6.8.4');
    assert.deepEqual(Object.keys(baseline.files).sort(), ['public/a.js', 'public/b.js']);
    assert.equal(baseline.files['public/a.js'].sha256, sha('new'));
    assert.equal(baseline.files['public/b.js'].sha256, sha('fresh'));
});

test('baseline write failure does NOT roll back a completed swap', async () => {
    const s = scenario({
        target: '6.8.5',
        originals: { 'public/a.js': 'old' },
        files: { 'public/a.js': 'new' },
    });
    // 预建一个同名目录 → writeFileSync 写文件失败（EISDIR）
    fs.mkdirSync(path.join(s.updates, 'baseline-manifest.json'));
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { },
        blog: () => { },
    });
    assert.equal(r.applied, true, 'baseline 写失败不应撤销已完成的文件切换');
    assert.equal(r.rolledBack, false);
    assert.ok(r.baselineError, '应在结果里记录 baselineError');
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'a.js'), 'utf8'), 'new');
});

/* -------------------------------- 幂等 / 并发 / 安全 -------------------------------- */

test('skips cleanly when there is no pending-switch.json', async () => {
    const s = scenario({ noPending: true, originals: { 'public/a.js': 'old' } });
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { throw new Error('should not restart'); },
        blog: () => { },
    });
    assert.equal(r.applied, false);
    assert.equal(r.rolledBack, false);
    assert.equal(r.skipped, true);
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'a.js'), 'utf8'), 'old');
});

test('does not apply twice (second call sees no pending)', async () => {
    const s = scenario({
        target: '6.8.6',
        originals: { 'public/a.js': 'old' },
        files: { 'public/a.js': 'new' },
    });
    let restarts = 0;
    const args = {
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { restarts++; },
        blog: () => { },
    };
    const r1 = await sw.checkAndApply(args);
    const r2 = await sw.checkAndApply(args);
    assert.equal(r1.applied, true);
    assert.equal(r2.applied, false);
    assert.equal(r2.skipped, true);
    assert.equal(restarts, 1);
});

test('skips when another switch holds the lock', async () => {
    const s = scenario({
        target: '6.8.7',
        originals: { 'public/a.js': 'old' },
        files: { 'public/a.js': 'new' },
    });
    fs.writeFileSync(path.join(s.updates, '.switch.lock'), JSON.stringify({ pid: 99999 }));
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { throw new Error('should not restart'); },
        blog: () => { },
    });
    assert.equal(r.applied, false);
    assert.equal(r.skipped, true);
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'a.js'), 'utf8'), 'old');
});

test('rejects unsafe rel paths (defense in depth; upstream verifyPatch already blocks)', async () => {
    const s = scenario({
        target: '6.8.8',
        originals: { 'public/a.js': 'old' },
        files: {},
    });
    s.pending.files = { '../evil.js': { sha256: sha('x') } };
    fs.writeFileSync(path.join(s.updates, 'pending-switch.json'), JSON.stringify(s.pending));
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { throw new Error('should not restart'); },
        blog: () => { },
    });
    assert.equal(r.applied, false);
    assert.equal(fs.existsSync(path.join(s.runtime, '..', 'evil.js')), false);
});

/* --------------------------- review round 1 regression --------------------------- */

test('CRITICAL: unsafe rel fails before backup — safe original is NOT deleted by rollback', async () => {
    // 构造：一个不安全 rel（触发 outer catch，早于备份阶段）+ 一个安全 rel（disk 上有原文件）
    const s = scenario({
        target: '6.9.9',
        originals: { 'public/keep.js': 'ORIGINAL-CONTENT' },
        files: {},
    });
    s.pending.files = {
        '../evil.js': { sha256: sha('x') },     // 不安全 → safeRel 校验抛错
        'public/keep.js': { sha256: sha('y') }, // 安全 → disk 上有原文件，备份阶段从未运行
    };
    fs.writeFileSync(path.join(s.updates, 'pending-switch.json'), JSON.stringify(s.pending));
    let restarts = 0;
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { restarts++; },
        blog: () => { },
    });
    assert.equal(r.applied, false);
    assert.equal(r.rolledBack, true);
    // 核心断言：安全 rel 的原文件绝不能被回滚误删（Critical #1）
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'keep.js'), 'utf8'), 'ORIGINAL-CONTENT',
        '回滚不得删除从未备份过的原始文件');
    assert.equal(fs.existsSync(path.join(s.runtime, '..', 'evil.js')), false);
    assert.equal(restarts, 1, 'restore-only 回滚后仍要重启一次');
});

test('rollback re-restart failure leaves rolledBack=false and retains pending', async () => {
    const s = scenario({
        target: '7.0.0',
        originals: { 'public/a.js': 'old' },
        files: { 'public/a.js': 'new' },
    });
    let attempts = 0;
    const r = await sw.checkAndApply({
        runtimeDir: s.runtime, updatesDir: s.updates,
        restart: async () => { attempts++; throw new Error('backend down'); }, // 两次都失败
        blog: () => { },
    });
    assert.equal(attempts, 2);
    assert.equal(r.applied, false);
    assert.equal(r.rolledBack, false, '回滚重启失败 → rolledBack=false');
    // 文件本身仍已恢复（restore 成功），只是 live 状态没恢复
    assert.equal(fs.readFileSync(path.join(s.runtime, 'public', 'a.js'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(s.updates, 'pending-switch.json')), true,
        '回滚不彻底 → 保留 pending 供下次重试');
});
