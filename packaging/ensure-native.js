/**
 * ensure-native.js —— 确保 better-sqlite3 是「Electron ABI」版本
 * ==========================================================================
 * 【为什么必须管这件事】
 * Electron 和 Node 的 NODE_MODULE_VERSION 不一样（Electron 33 = 130，Node 22 = 127）。
 * 同一个 .node 二进制在两个运行时之间不能混用，用错会直接抛：
 *     Error: The module '...better_sqlite3.node' was compiled against a different
 *     Node.js version using NODE_MODULE_VERSION xxx.
 * 本项目后端进程是用 Electron 自带的 Node 跑的（ELECTRON_RUN_AS_NODE=1），
 * 所以 app/node_modules 里的 better-sqlite3 必须是 Electron ABI。
 *
 * 【做法】
 * 仓库里直接带了编好的二进制：prebuilt/better-sqlite3/<electron-vXXX>-<platform>-<arch>/better_sqlite3.node
 * 只 1.7MB，省掉「联网下载 prebuild」这一步（实测这一步最容易在 CI / 弱网下挂掉）。
 * 用 sha256 比对，不一致就覆盖 —— 幂等，重复跑没副作用。
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

const ELECTRON_ABI = 'electron-v130';            // Electron 33.x
const PLATFORM = 'win32-x64';

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findPrebuilt() {
    if (!fs.existsSync(PREBUILT_ROOT)) return null;
    const dirs = fs.readdirSync(PREBUILT_ROOT)
        .filter((d) => d.includes(ELECTRON_ABI) && d.includes(PLATFORM));
    for (const d of dirs) {
        const p = path.join(PREBUILT_ROOT, d, 'better_sqlite3.node');
        if (fs.existsSync(p)) return p;
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
        console.error(`❌ 找不到预编译包：prebuilt/better-sqlite3/*${ELECTRON_ABI}*${PLATFORM}*/better_sqlite3.node`);
        console.error('   若已用「ELECTRON ABI」装过依赖（npm_config_runtime=electron），可忽略本步。');
        process.exit(1);
    }

    const srcHash = sha256(src);
    if (fs.existsSync(TARGET) && sha256(TARGET) === srcHash) {
        console.log('✅ better-sqlite3 已是 Electron ABI 版本（哈希一致，无需操作）');
        return;
    }

    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.copyFileSync(src, TARGET);
    console.log(`✅ 已替换为 Electron ABI 版本 (${ELECTRON_ABI}) → ${path.relative(__dirname, TARGET)}`);
    console.log(`   ${(fs.statSync(TARGET).size / 1024).toFixed(0)}KB  sha256=${srcHash.slice(0, 16)}…`);
}

main();
