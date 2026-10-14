/**
 * ensure-native.js —— 确保 better-sqlite3 是「Electron ABI」版本
 * ==========================================================================
 * 【为什么必须管这件事】
 * Electron 和 Node 的 NODE_MODULE_VERSION 不一样（Electron 33 = 130，Node 22 = 127，
 * Electron 38 = 139）。同一个 .node 二进制在两个运行时之间不能混用，用错会直接抛：
 *     Error: The module '...better_sqlite3.node' was compiled against a different
 *     Node.js version using NODE_MODULE_VERSION xxx.
 * 本项目后端进程是用 Electron 自带的 Node 跑的（ELECTRON_RUN_AS_NODE=1），
 * 所以 payload/node_modules 里的 better-sqlite3 必须是 Electron ABI。
 *
 * 【做法】
 * 仓库里直接带了编好的二进制：prebuilt/better-sqlite3/<electron-vXXX>-<platform>-<arch>/better_sqlite3.node
 * 只 1~2MB，省掉「联网下载 prebuild」这一步（实测这一步最容易在 CI / 弱网下挂掉）。
 * 用 sha256 比对，不一致就覆盖 —— 幂等，重复跑没副作用。
 *
 * 【r60 修复】ABI 不再写死 electron-v130 —— 从 packaging/node_modules/electron 的
 * 实际版本经映射表推导（38.8.6 → electron-v139）。历史教训：Electron 33→38 升级时
 * 这里没跟着改，v2.4.0 首个构建带着 v130 二进制发出去，新装用户必崩（后端起不来）。
 * 升级 Electron 的固定动作：把新 ABI 的 better_sqlite3.node 放进
 * prebuilt/better-sqlite3/electron-vXXX-win32-x64/，并在 ELECTRON_ABI_MAP 补一行。
 *
 * 用法：node ensure-native.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_NM = path.join(__dirname, 'payload', 'node_modules');
const TARGET = path.join(APP_NM, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const PREBUILT_ROOT = path.join(__dirname, 'prebuilt', 'better-sqlite3');
const PLATFORM = 'win32-x64';

/* Electron major → NODE_MODULE_VERSION（prebuilt 目录名用）。升级 Electron 在此补行。 */
const ELECTRON_ABI_MAP = {
    33: 'electron-v130',
    38: 'electron-v139'
};

function expectedAbiTag() {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
        const major = Number(String(v).split('.')[0]);
        return ELECTRON_ABI_MAP[major] || null;
    } catch (e) {
        return null;
    }
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findPrebuilt() {
    if (!fs.existsSync(PREBUILT_ROOT)) return null;
    const tag = expectedAbiTag();
    const order = [];
    if (tag) order.push(tag);
    // 兜底：映射表没覆盖的新版本，按目录名里的 ABI 号从新到旧排（配合启动报错提示人工补表）
    try {
        fs.readdirSync(PREBUILT_ROOT)
            .map((d) => (d.match(/electron-v(\d+)/) || [0, 0])[1])
            .filter(Boolean)
            .sort((a, b) => Number(b) - Number(a))
            .forEach((n) => {
                const t = 'electron-v' + n;
                if (!order.includes(t)) order.push(t);
            });
    } catch (e) { /* 目录读不到就走主流程的报错 */ }

    for (const t of order) {
        const p = path.join(PREBUILT_ROOT, t + '-' + PLATFORM, 'better_sqlite3.node');
        if (fs.existsSync(p)) {
            if (tag && t !== tag) {
                console.log(`   ⚠ prebuilt 里没有 ${tag}-${PLATFORM}，暂用 ${t}（启动若报 ABI 不匹配，请放入对应二进制并补 ELECTRON_ABI_MAP）`);
            }
            return p;
        }
    }
    return null;
}

function main() {
    if (!fs.existsSync(path.join(APP_NM, 'better-sqlite3'))) {
        console.error('❌ app/node_modules/better-sqlite3 不存在。');
        console.error('   先跑：cd app && npm install --no-audit --no-fund');
        process.exit(1);
    }

    const src = findPrebuilt();
    if (!src) {
        const tag = expectedAbiTag();
        console.error(`❌ 找不到预编译包：prebuilt/better-sqlite3/${tag || 'electron-vXXX'}-${PLATFORM}/better_sqlite3.node`);
        console.error('   若已用「ELECTRON ABI」装过依赖（npm_config_runtime=electron），可忽略本步。');
        process.exit(1);
    }

    const usedTag = path.basename(path.dirname(src)).replace('-' + PLATFORM, '');
    const srcHash = sha256(src);
    if (fs.existsSync(TARGET) && sha256(TARGET) === srcHash) {
        console.log(`✅ better-sqlite3 已是 Electron ABI 版本（${usedTag}，哈希一致，无需操作）`);
        return;
    }

    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.copyFileSync(src, TARGET);
    console.log(`✅ 已替换为 Electron ABI 版本 (${usedTag}) → ${path.relative(__dirname, TARGET)}`);
    console.log(`   ${(fs.statSync(TARGET).size / 1024).toFixed(0)}KB  sha256=${srcHash.slice(0, 16)}…`);
}

main();
