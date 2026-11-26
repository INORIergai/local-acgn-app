/**
 * packaging/incremental-switch.js — Task 4 (M3) 主进程增量切换
 * ============================================================================
 * 职责：由 **Electron 主进程**（不占用 runtime 后端源码文件）消费 Task 3 写出的
 * `<updatesDir>/pending-switch.json`，执行备份 → 替换 → 重启；任一步失败则回滚。
 *
 * 绝不 require/spawn patch 内容；重启只调用注入的 restart()（main.js 里是 restartBackend）。
 * 不依赖 electron / adm-zip，纯 fs + path，便于 node:test 直接测。
 *
 * 相位文件 `<updatesDir>/update-state.json`：
 *   phase ∈ downloading | verifying | swapping | done | rolled_back
 *   本模块只写 swapping / done / rolled_back（downloading/verifying 属 Task 3 阶段，
 *   保留在枚举里方便排障时对照）。
 *
 * 并发/幂等：`<updatesDir>/.switch.lock` 文件锁（wx 原子创建），锁内写 PID+时间；
 *   超过 LOCK_STALE_MS 视为上次崩溃遗留，可接管。成功、以及**回滚成功**都会删
 *   pending-switch.json（避免每 15s 反复重试同一个坏 patch）；只有「回滚本身也失败」
 *   才保留 pending，便于下次启动重试修复半切换状态。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PENDING_NAME = 'pending-switch.json';
const STATE_NAME = 'update-state.json';
const LOCK_NAME = '.switch.lock';
const BASELINE_NAME = 'baseline-manifest.json';
const META_NAME = '_backup-meta.json';
const BACKUP_DONE_NAME = '_backup-complete';   // 备份阶段完整结束的标记（含 pending 签名）
const LOCK_STALE_MS = 10 * 60 * 1000;

/** 校验相对路径安全（纵深防御；上游 Task 3 verifyPatch 已拦 zip-slip）。
 *  接受 posix 风格 rel；拒绝绝对路径、盘符、UNC、任何 .. 段、以及越出 base 的解析结果。 */
function safeRel(rel, base) {
    if (typeof rel !== 'string' || !rel) return false;
    const norm = rel.replace(/\\/g, '/');
    if (norm.startsWith('/') || norm.startsWith('//') || /^[A-Za-z]:/.test(norm)) return false;
    if (norm.split('/').includes('..')) return false;
    if (!base) return true;
    const resolved = path.resolve(base, norm);
    const chk = path.relative(path.resolve(base), resolved);
    return !chk.startsWith('..') && !path.isAbsolute(chk);
}

/** 把 dir 限制在 updatesDir 内；不接受逃出 updatesDir 的 staging/backup 路径。 */
function confinedDir(candidate, updatesDir) {
    if (typeof candidate !== 'string' || !candidate) return null;
    const base = path.resolve(updatesDir);
    const resolved = path.resolve(candidate);
    const chk = path.relative(base, resolved);
    if (chk.startsWith('..') || path.isAbsolute(chk)) return null;
    return resolved;
}

function noop() { /* 默认日志：静默 */ }

/**
 * 检查并应用待切换 patch。
 *
 * @param {object} opts
 * @param {string} opts.runtimeDir                运行目录（后端源码所在，主进程不占用）
 * @param {string} opts.updatesDir                更新目录（含 pending-switch.json）
 * @param {function} opts.restart                 重启后端；必须返回 Promise 或同步成功
 * @param {function} [opts.blog]                  日志函数
 * @param {object} [opts.hooks]                   仅测试用 seam：{beforeWrite, beforeRestart, beforeRemove}
 * @returns {Promise<{applied:boolean, rolledBack:boolean, error:(string|null), [k:string]:any}>}
 */
async function checkAndApply(opts) {
    const o = opts || {};
    const runtimeDir = o.runtimeDir ? path.resolve(o.runtimeDir) : '';
    const updatesDir = o.updatesDir ? path.resolve(o.updatesDir) : '';
    const restart = typeof o.restart === 'function' ? o.restart : null;
    const log = typeof o.blog === 'function' ? o.blog : noop;
    const hooks = o.hooks || {};

    const result = { applied: false, rolledBack: false, error: null };
    if (!runtimeDir || !updatesDir || !restart) {
        result.error = 'checkAndApply 缺少 runtimeDir/updatesDir/restart';
        log('[switch] ' + result.error);
        return result;
    }

    const pendingPath = path.join(updatesDir, PENDING_NAME);
    const statePath = path.join(updatesDir, STATE_NAME);
    const lockPath = path.join(updatesDir, LOCK_NAME);

    let lockFd = null;
    let locked = false;

    const writeState = (phase, extra) => {
        try {
            fs.mkdirSync(updatesDir, { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify(Object.assign({
                phase,
                updatedAt: new Date().toISOString(),
            }, extra || {}), null, 2), 'utf8');
        } catch (e) {
            log('[switch] 写 update-state.json 失败: ' + ((e && e.message) || e));
        }
    };

    /* -------------------------------------------------- 文件锁（防并发/重复切换） */
    try {
        fs.mkdirSync(updatesDir, { recursive: true });
        // 清掉过期锁（上次进程崩溃遗留）
        try {
            const st = fs.statSync(lockPath);
            if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockPath);
        } catch (e) { /* 锁不存在：正常 */ }

        try {
            lockFd = fs.openSync(lockPath, 'wx');
            fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
            locked = true;
        } catch (e) {
            if (e && e.code === 'EEXIST') {
                log('[switch] 已有切换任务在进行（锁存在），跳过本轮');
                result.skipped = true;
                return result;
            }
            throw e;
        }
    } catch (e) {
        result.error = '获取切换锁失败: ' + ((e && e.message) || e);
        log('[switch] ' + result.error);
        return result;
    }

    let pending = null;
    let target = '';
    let backupDir = '';
    let meta = null;          // {files:{rel:bool}, removed:[rel]}
    let backupComplete = false;   // 本轮备份阶段是否完整成功（只有它为真才允许回滚删除文件）

    /* 重试上限：跨进程持久化在 update-state.json 的 switchAttempts。
     * 旧行为是「切换失败 → 回滚也失败 → 保留 pending → 15s 后重来」，无限循环；
     * 用户侧表现为窗口每 15s 强制刷新一次、更新永远装不上。超过上限后放弃重试。 */
    const MAX_SWITCH_ATTEMPTS = 3;
    let switchAttempts = 0;
    const readAttempts = () => {
        try {
            const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (!st) return 0;
            // 同一 target 才继承计数；换了一个新 patch 重新给 3 次机会
            if (st.target && target && String(st.target) !== String(target)) return 0;
            return Number(st.switchAttempts) || 0;
        } catch (e) { return 0; }
    };

    /** 磁盘上的备份完成标记是否属于当前 pending（供跨进程/重试判断）。
     *  只有标记存在且 target/createdAt 对得上，回滚才敢删除 patch 新增文件。 */
    const markerMatches = () => {
        try {
            const raw = fs.readFileSync(path.join(backupDir, BACKUP_DONE_NAME), 'utf8');
            const marker = JSON.parse(raw);
            if (!marker || marker.target !== target) return false;
            if (pending && pending.createdAt && marker.createdAt !== pending.createdAt) return false;
            return true;
        } catch (e) { return false; }
    };

    /* 回滚：把 runtime 恢复到切换前的状态。
     * meta 是权威记录：files[rel]===true 表示原来有文件（从 backup 拷回）；
     * false 表示是 patch 新增的（回滚时删掉）。removed 列表里的文件从 backup 拷回。
     *
     * ★ 安全底线（review Critical #1）：只有「备份阶段完整成功」的标记存在时，
     *   才允许按 meta.files[rel]===false 删除文件。否则一律 restore-only：
     *   有备份就拷回，没备份就保持 dest 原样，绝不 unlink —— 防止误删用户原文件。 */
    const rollback = async (reason) => {
        let rollbackError = null;
        const allowDeletes = backupComplete || markerMatches();
        try {
            if (!meta && fs.existsSync(path.join(backupDir, META_NAME))) {
                try { meta = JSON.parse(fs.readFileSync(path.join(backupDir, META_NAME), 'utf8')); }
                catch (e) { meta = null; }
            }
            if (!meta && pending) {
                /* meta 丢失（通常是备份阶段之前就失败）→ 推断时强制 restore-only：
                 * files[rel] 一律按「有备份就恢复」处理，没有备份就保持不动，绝不删除。
                 * 同时在这里就套 safeRel，非法 rel 直接跳过（纵深防御）。 */
                meta = { files: {}, removed: [] };
                for (const rel of Object.keys(pending.files || {})) {
                    if (!safeRel(rel, runtimeDir)) continue;
                    meta.files[rel] = fs.existsSync(path.join(backupDir, rel));
                }
                for (const rel of (pending.removed || [])) {
                    if (!safeRel(rel, runtimeDir)) continue;
                    if (fs.existsSync(path.join(backupDir, rel))) meta.removed.push(rel);
                }
            }

            for (const [rel, hadOriginal] of Object.entries((meta && meta.files) || {})) {
                if (!safeRel(rel, runtimeDir)) continue;
                const dest = path.join(runtimeDir, rel);
                const backup = path.join(backupDir, rel);
                try {
                    if (hadOriginal) {
                        if (!fs.existsSync(backup)) throw new Error('备份缺失: ' + rel);
                        fs.mkdirSync(path.dirname(dest), { recursive: true });
                        fs.copyFileSync(backup, dest);
                    } else if (allowDeletes) {
                        // 只有备份完整成功过，才能确认这是 patch 新增文件并安全删除
                        if (fs.existsSync(dest)) fs.unlinkSync(dest);
                    } else {
                        // restore-only：无备份且无完整标记 → 保持 dest 原样，绝不删除
                        log('[switch] 回滚(restore-only) 保留未备份文件: ' + rel);
                    }
                } catch (e) {
                    rollbackError = rollbackError || ('恢复 ' + rel + ' 失败: ' + ((e && e.message) || e));
                }
            }
            for (const rel of (meta && meta.removed) || []) {
                if (!safeRel(rel, runtimeDir)) continue;
                const dest = path.join(runtimeDir, rel);
                const backup = path.join(backupDir, rel);
                try {
                    if (!fs.existsSync(backup)) throw new Error('备份缺失(removed): ' + rel);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.copyFileSync(backup, dest);
                } catch (e) {
                    rollbackError = rollbackError || ('恢复 removed ' + rel + ' 失败: ' + ((e && e.message) || e));
                }
            }
        } catch (e) {
            rollbackError = rollbackError || ((e && e.message) || String(e));
        }
        /* 文件恢复成功后必须再重启一次：否则 live 进程仍持有新/坏代码（或已死），
         * 磁盘恢复了但运行状态没恢复（review Important #2）。
         * 再重启失败 → rolledBack=false → 保留 pending 供下次重试。 */
        if (!rollbackError) {
            try {
                log('[switch] 文件已恢复，回滚重启后端');
                await restart();
                log('[switch] 回滚重启成功');
            } catch (e) {
                rollbackError = '回滚后重启失败: ' + ((e && (e.message || e)) || e);
                log('[switch] ' + rollbackError);
            }
        }
        result.rolledBack = !rollbackError;
        result.error = (result.error ? result.error + '；' : '') + (reason || '切换失败')
            + (rollbackError ? '；回滚未完成: ' + rollbackError : '');
        if (rollbackError) result.rollbackError = rollbackError;
        log('[switch] 回滚' + (result.rolledBack ? '完成' : '失败') + ': '
            + (reason || '切换失败') + (rollbackError ? ' / ' + rollbackError : ''));
        /* 回滚成功 → 删除 pending，避免每 15s 反复尝试同一个失败 patch（controller 裁定 #4）。
         * 回滚本身失败 → 正常情况下保留 pending，让下次启动/轮询仍能处理半切换状态；
         * 但连续失败达到上限时必须停手：否则主进程每 15s 重来一次（重启后端 + 刷新窗口），
         * 用户侧就是「界面被无限强制刷新、更新永远装不上」。 */
        if (result.rolledBack) {
            try { fs.unlinkSync(pendingPath); } catch (e) { /* 忽略 */ }
        } else if (switchAttempts >= MAX_SWITCH_ATTEMPTS) {
            try { fs.unlinkSync(pendingPath); } catch (e) { /* 忽略 */ }
            result.exhausted = true;
            result.error += '；已连续 ' + switchAttempts + ' 次失败，停止自动重试（请下载全量安装包）';
            log('[switch] 已连续 ' + switchAttempts + ' 次失败，停止自动重试并删除 pending-switch.json');
        }
        writeState('rolled_back', {
            target, applied: false, rolledBack: result.rolledBack,
            error: result.error, switchAttempts,
        });
        return result;
    };

    try {
        /* ---------------------------------------------------------- 读取 pending */
        let pendingRaw = '';
        try {
            pendingRaw = fs.readFileSync(pendingPath, 'utf8');
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                log('[switch] 无 pending-switch.json，跳过');
                result.skipped = true;
                return result;
            }
            throw e;
        }
        try {
            pending = JSON.parse(pendingRaw);
        } catch (e) {
            result.error = 'pending-switch.json 解析失败: ' + ((e && e.message) || e);
            log('[switch] ' + result.error);
            return result;   // 可能是写到一半，留着下次再读
        }

        target = String(pending.target || '').trim();
        const staging = confinedDir(pending.stagingPath, updatesDir);
        backupDir = confinedDir(pending.backupDir, updatesDir)
            || path.join(updatesDir, 'rollback-' + (target || 'unknown'));
        const files = (pending.files && typeof pending.files === 'object') ? pending.files : {};
        const removed = Array.isArray(pending.removed) ? pending.removed : [];

        if (!target || !staging || !Object.keys(files).length) {
            result.error = 'pending-switch.json 字段不完整（target/stagingPath/files）';
            log('[switch] ' + result.error);
            try { fs.unlinkSync(pendingPath); } catch (e) { /* 忽略 */ }
            writeState('rolled_back', { target, error: result.error, applied: false, rolledBack: false });
            return result;
        }
        // 纵深防御：rel 与 staging/backup 都必须落在预期目录内
        for (const rel of Object.keys(files)) {
            if (!safeRel(rel, runtimeDir) || !safeRel(rel, staging)) {
                throw new Error('patch 含不安全路径: ' + rel);
            }
        }
        for (const rel of removed) {
            if (!safeRel(rel, runtimeDir)) throw new Error('removed 含不安全路径: ' + rel);
        }

        switchAttempts = readAttempts() + 1;
        log('[switch] 开始切换 target=' + target + ' staging=' + staging + ' files='
            + Object.keys(files).length + ' removed=' + removed.length
            + '（第 ' + switchAttempts + '/' + MAX_SWITCH_ATTEMPTS + ' 次尝试）');
        writeState('swapping', {
            target, applied: false, rolledBack: false,
            startedAt: new Date().toISOString(), switchAttempts,
        });

        /* -------------------------------------------------------------- 备份阶段 */
        fs.mkdirSync(backupDir, { recursive: true });
        const metaPath = path.join(backupDir, META_NAME);
        if (fs.existsSync(metaPath)) {
            try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
            catch (e) { meta = null; }
        }
        if (!meta || !meta.files) {
            meta = { files: {}, removed: [] };
            for (const rel of Object.keys(files)) {
                const src = path.join(runtimeDir, rel);
                const dst = path.join(backupDir, rel);
                if (fs.existsSync(src)) {
                    // 已有备份时不覆盖：保留最初的原文件内容（给重试一个正确基线）
                    if (!fs.existsSync(dst)) {
                        fs.mkdirSync(path.dirname(dst), { recursive: true });
                        fs.copyFileSync(src, dst);
                    }
                    meta.files[rel] = true;
                } else {
                    meta.files[rel] = false;   // patch 新增文件：回滚时删除
                }
            }
            for (const rel of removed) {
                const src = path.join(runtimeDir, rel);
                const dst = path.join(backupDir, rel);
                if (fs.existsSync(src)) {
                    if (!fs.existsSync(dst)) {
                        fs.mkdirSync(path.dirname(dst), { recursive: true });
                        fs.copyFileSync(src, dst);
                    }
                    meta.removed.push(rel);
                }
            }
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        }
        /* 备份阶段完整成功 → 写完成标记。只有这时回滚才允许删除 patch 新增文件。
         * 标记带 target + createdAt，跨进程重试时只对同一 pending 生效。
         * 无论 meta 是本轮新建还是从上次重试加载，走到这里都表示备份阶段已完整成功。 */
        fs.writeFileSync(path.join(backupDir, BACKUP_DONE_NAME), JSON.stringify({
            target, createdAt: pending && pending.createdAt, completedAt: new Date().toISOString(),
        }, null, 2), 'utf8');
        backupComplete = true;

        /* -------------------------------------------------------------- 替换阶段 */
        for (const rel of Object.keys(files)) {
            const src = path.join(staging, 'changed', rel);
            const dest = path.join(runtimeDir, rel);
            if (!fs.existsSync(src)) throw new Error('staging 缺少文件: ' + rel);
            if (typeof hooks.beforeWrite === 'function') hooks.beforeWrite(rel, src, dest);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
        for (const rel of removed) {
            const dest = path.join(runtimeDir, rel);
            if (typeof hooks.beforeRemove === 'function') hooks.beforeRemove(rel, dest);
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
        }

        /* -------------------------------------------------------------- 重启阶段 */
        if (typeof hooks.beforeRestart === 'function') hooks.beforeRestart();
        log('[switch] 文件替换完成，重启后端');
        await restart();
        log('[switch] 重启调用成功');

        /* -------------------------------------------- 成功：删 pending + 写 state */
        try { fs.unlinkSync(pendingPath); } catch (e) { /* 忽略 */ }
        result.applied = true;
        result.target = target;
        writeState('done', {
            target, applied: true, rolledBack: false,
            finishedAt: new Date().toISOString(), switchAttempts: 0,
        });

        /* ------------------------------- 成功：写 baseline-manifest.json（Task3 OPEN） */
        try {
            let manifestFiles = {};
            for (const [rel, meta2] of Object.entries(files)) {
                const src = path.join(staging, 'changed', rel);
                let size = 0;
                try { size = fs.statSync(src).size; } catch (e) { /* 忽略 */ }
                manifestFiles[rel] = {
                    sha256: String((meta2 && meta2.sha256) || ''),
                    size,
                };
            }
            if (!Object.keys(manifestFiles).length) {
                // 兜底：从 staging 的 patch.json 读 sha256 清单
                try {
                    const pj = JSON.parse(fs.readFileSync(path.join(staging, 'patch.json'), 'utf8'));
                    for (const [rel, h] of Object.entries(pj.sha256 || {})) {
                        manifestFiles[rel] = { sha256: String(h || ''), size: 0 };
                    }
                } catch (e) { /* 忽略 */ }
            }
            const baseline = {
                version: target,
                generatedAt: new Date().toISOString(),
                files: manifestFiles,
                binaryDirs: [],
                fullFallback: {},
            };
            fs.mkdirSync(updatesDir, { recursive: true });
            fs.writeFileSync(path.join(updatesDir, BASELINE_NAME), JSON.stringify(baseline, null, 2), 'utf8');
            log('[switch] 已写 baseline-manifest.json (v' + target + ', ' + Object.keys(manifestFiles).length + ' files)');
        } catch (e) {
            // 按 controller 裁定 #3：baseline 写失败不回滚已完成的文件切换，仅记 error 日志
            result.baselineError = (e && e.message) || String(e);
            log('[switch] 写 baseline-manifest.json 失败（不影响已完成的切换）: ' + result.baselineError);
        }

        return result;
    } catch (e) {
        result.error = (e && (e.stack || e.message)) || String(e);
        log('[switch] 切换失败: ' + result.error);
        return rollback('切换异常');
    } finally {
        if (locked) {
            try { fs.closeSync(lockFd); } catch (e) { /* 忽略 */ }
            try { fs.unlinkSync(lockPath); } catch (e) { /* 忽略 */ }
        }
    }
}

module.exports = { checkAndApply, safeRel };
