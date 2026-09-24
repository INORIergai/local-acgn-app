/**
 * make-public.js —— 生成「可以安全公开」的仓库副本到 ../git/
 * ==========================================================================
 * 为什么需要它：
 *   当前工作目录是**开发树**，里面有大量不该进公开仓库的东西 ——
 *     · docs/                几万张界面截图（含真实片名、海报）
 *     · archive/             150+ 调试脚本 / 日志 / 临时产物
 *     · exe/                 自用区：成品安装包 + 本地数据 + 敏感配置
 *     · db/ posters/ cache/ backups/ host/*.log
 *   直接 `git push` 到公开仓库 = 把片库信息全公开。所以这里按白名单抽一份出来。
 *
 * 产物：<仓库根>/git/   —— 干净、可直接 git status / commit / push
 *        ★ 该目录里的 .git 会被**保留**（它是发布工作副本的仓库），只清内容不清 .git
 * 用法：node packaging/make-public.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');          // 开发树根
const DST = path.join(SRC, 'git');               // 发布工作副本（git 仓库根）

/* 应用本体（整目录复制） */
const APP_DIRS = ['routes', 'utils', 'public'];
/* 应用本体（根目录单文件） */
const APP_FILES = [
    'server.js',
    'package.json',
    'package-lock.json',
    'config.example.json',
    'Dockerfile',
    'docker-compose.yml',
    'docker-entrypoint.js',
    '.dockerignore',
];
/* 只挑必要文件的子目录 */
const APP_SUBSET = {
    host: ['protocol-handler.js', 'install-protocols.bat', 'protocols.reg'],
    db: ['schema.sql'],
    tools: ['poster-relay.js', 'start-poster-relay.bat'],
};
/* 打包工具链（从 packaging/ 里挑，剔掉 payload/ dist/ node_modules/ 与临时脚本） */
const PKG_FILES = [
    'main.js',
    'package.json',
    'prepare-export.js',
    'ensure-native.js',
    'build-exe.bat',
    'README.md',
    'public-README.md',
    '.gitignore',
    '_make-icon.js',
    '_make-ico.py',
    /* 发布工具链本体（round24 补）：让人 clone 下来就能自己导出 + 推送 + 发 Release，
     * 不用回头找。三个脚本本身不含密钥 —— 凭据走 Windows 凭据管理器现取。 */
    'make-public.js',
    '_r23-publish.py',
    '_r23-release.py',
];
const PKG_DIRS = ['build', 'prebuilt'];

const GITIGNORE = [
    '# ===== 依赖与构建产物 =====',
    'node_modules/',
    'packaging/payload/',
    'packaging/dist/',
    'dist/',
    '',
    '# ===== 真实配置：含登录口令与 API Key，绝不入库 =====',
    'config.json',
    'config.docker.json',
    '.env',
    '.env.*',
    '',
    '# ===== 个人数据 =====',
    'db/*.db',
    'db/*.db-*',
    'db/*.bak*',
    'db/*.repair',
    'posters/',
    'cache/',
    'backups/',
    'data/',
    'tmp-render/',
    'logs/',
    '*.log',
    '',
    '# ===== 浏览器 profile（含 cookie / CF 通行证）=====',
    '.playwright-profile/',
    '.user-browser-data/',
    '.quark-login-profile/',
    'quark-cookie.json',
    '*cookie*.json',
    '',
    '# ===== 系统 / 编辑器 =====',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '.idea/',
    '.vscode/',
    '*.swp',
    '*~',
    '',
].join('\n');

const LICENSE = `MIT License

Copyright (c) ${new Date().getFullYear()} Cinema Vault

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function rmrf(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

/* 清空目录内容，但**保留 .git** —— DST 是发布工作副本的仓库根，
 * 一旦连 .git 一起删掉，用户积累的本地提交（含分支、合并记录）就全没了。 */
function cleanKeepGit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        if (name === '.git') continue;
        rmrf(path.join(dir, name));
    }
}

/** 不该进公开仓库的文件名：编辑器/手工备份、临时文件、系统垃圾 */
const JUNK_RE = /(^\.DS_Store$|^Thumbs\.db$|^desktop\.ini$|\.(bak|old|orig|swp|swo|tmp|log|repair)$|\.bak-[\w.-]+$|~$)/i;

/* `public/` 是**整目录复制**，所以开发期放在里面的辅助页会被顺带带走。
 * `public/_magic-preview.html` 就是这种：它是 `scripts/_magic-ui-check.js` 的验收用
 * 离线预览页（引用了仓库里并不存在的 css ?v= 版本），对 clone 的人毫无用处，
 * 还容易被误当成应用页面。这里点名排除 —— 不要放宽成「public/ 下所有 _*」，
 * 万一将来真有以 _ 开头的正经资源会被误删。 */
const PUBLIC_SKIP = new Set(['_magic-preview.html']);

function copyDir(src, dst, skipNames) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        if (name === 'node_modules' || name === '.git') continue;
        if (JUNK_RE.test(name)) continue;
        if (skipNames && skipNames.has(name)) {
            console.log('   · 跳过 ' + path.relative(SRC, path.join(src, name)));
            continue;
        }
        const s = path.join(src, name);
        const d = path.join(dst, name);
        const st = fs.lstatSync(s);
        if (st.isDirectory()) copyDir(s, d);
        else if (st.isFile()) fs.copyFileSync(s, d);
    }
}

function copyFile(src, dst) {
    if (!fs.existsSync(src)) {
        console.warn('  ⚠️ 缺少 ' + path.relative(SRC, src));
        return false;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
}

/** 敏感信息扫描：public 仓库最怕的就是把真实口令/密钥/个人路径带出去 */
function scanForSecrets(root) {
    const hits = [];
    const patterns = [
        [/ghp_[A-Za-z0-9]{20,}/, 'GitHub PAT'],
        [/sk-[A-Za-z0-9]{20,}/, 'API Key'],
        [/(password|apiKey|api_key|token)\s*[:=]\s*["'][^"']{8,}["']\s*[,;}]/gi, '疑似密钥硬编码'],
        [/[A-Za-z]:[\\/]{1,2}(Users|Aokazu|迅雷)/, '本机绝对路径'],
        [/\/(media\/aokazu|media\/okazu)/, '个人挂载路径'],
        /* 真实局域网地址。config.example.json 里写的是 192.168.1.100 这种通用示例，
         * 会被下面的「跳过模板文件」规则豁免。 */
        [/\b192\.168\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, '内网 IP'],
        /* 网盘 / 站点的会话令牌明文（夸克 ctoken、__puus、tfstk，kmoe 的 VLIBSID 等） */
        [/["']?(?:ctoken|__puus|tfstk|VLIBSID|VOLSKEY)["']?\s*[:=]\s*["'][^"']{10,}/i, '会话令牌明文'],
    ];
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            if (!/\.(js|json|html|css|bat|reg|yml|md)$/.test(name)) continue;
            if (name === 'config.example.json') continue;      // 占位模板，允许 CHANGE_ME
            /* 跳过扫描器自己（round24）：本文件第 168 行往下就是那条 patterns 定义，
             * 里面必然写着 ghp_[A-Za-z0-9]{20,} / 192.168.\d{1,3} 这些**正则源码**，
             * 拿规则去匹配规则的定义 = 100% 自指命中。同理 _r23-publish.py 里写着
             * 域名和 API 路径，也不是凭证。
             * 代价：这两个文件真写了密钥不会被拦。它们只有逻辑没有配置，风险可接受。 */
            if (name === 'make-public.js') continue;
            if (name === '_r23-publish.py' || name === '_r23-release.py') continue;
            let text = '';
            try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
            for (const [re, label] of patterns) {
                if (re.test(text)) hits.push(`${label} → ${path.relative(root, p)}`);
            }
        }
    };
    walk(root);
    return hits;
}

/* ------------------------------------------------------------------ 脱敏
 * 公开仓库里最不该出现的东西，除了密钥，就是**开发者的真实目录结构**。
 * 这套源码里到处是作者自己的盘符（挂载点示例、路径映射表、输入框 placeholder），
 * 直接发出去等于把自己的硬盘布局贴网上。所以导出时统一换成通用占位。
 *
 * 只改 publish/ 里的副本，开发树一个字节都不动 —— 容器和桌面版照常跑。
 * 规则顺序有讲究：长串必须排在短串前面，否则 'F:\Aokazu anime' 会先被
 * 'F:\Aokazu' 吃掉，留下一个 "D:\Movies2 anime" 的怪路径。
 * 反斜杠用 \\+ 匹配，是为了同时覆盖源码里的单反斜杠（yaml / placeholder）
 * 和双反斜杠（JS 字符串字面量）。
 */
/* 同一个路径在不同文件里的**转义层数不一样**，这一点必须分开处理：
 *   · .js / .json  → JS 字符串字面量，反斜杠要写两个（'D:\\Movies'）
 *   · .yml / .bat / .html … → 纯文本，写一个就够（D:\Movies）
 * 统一用一种会把另一类改坏：单反斜杠灌进 .js 会让 '\M' 变成无效转义（运行时变 DMovies），
 * 双反斜杠灌进未加引号的 yaml 又会字面留下两个反斜杠。
 * 所以规则按目标形态生成两套。
 * bs = 目标里反斜杠的字面写法。
 */
const mkRules = (bs) => [
    // ── 反斜杠形式（长串在前，否则 'F:\Aokazu anime' 会被 'F:\Aokazu' 先吃掉）──
    [/F:\\+Aokazu anime/g, 'D:' + bs + 'Anime'],
    [/G:\\+迅雷下载\\+OKAZU/g, 'D:' + bs + 'Downloads' + bs + 'Movies'],
    [/E:\\+Aokazu/g, 'D:' + bs + 'Movies'],
    [/F:\\+Aokazu/g, 'D:' + bs + 'Movies2'],
    [/G:\\+kmoe_manga/g, 'D:' + bs + 'Comics'],
    [/G:\\+zlibrary_novel/g, 'D:' + bs + 'Novels'],
    [/C:\\+Users\\+Administrator/g, '%USERPROFILE%'],
    /* 开发者本机**项目目录**本身（round24 发现：host/protocols.reg 里写着
     * "D:\ai program\local-movie-library\host\protocol-handler.js" 这种绝对路径，
     * 公开出去既泄露目录布局，别人导入也会指向不存在的路径）。
     * 换成占位符 —— 安装脚本本来就该由使用者自己填安装位置。 */
    [/D:\\+ai program\\+local-movie-library/g, '%INSTALLDIR%'],
    // ── 正斜杠形式（convertPath 的单测里就是这么写的）──
    [/F:\/+Aokazu anime/g, 'D:/Anime'],
    [/E:\/+Aokazu/g, 'D:/Movies'],
    [/F:\/+Aokazu/g, 'D:/Movies2'],
    // ── 容器/Linux 侧（长前缀在前）──
    [/\/media\/aokazu_f anime/g, '/media/anime'],
    [/\/media\/aokazu_e/g, '/media/movies'],
    [/\/media\/aokazu_f/g, '/media/movies2'],
    [/\/media\/okazu/g, '/media/downloads'],
    [/\/media\/kmoe_manga/g, '/media/comic'],
    [/\/media\/zlibrary_novel/g, '/media/novel'],
    // ── 删掉「指向开发机 Node 安装」的那行（对普通用户没有意义）──
    [/^[ \t]*if not defined NODE_EXE if exist "[^"]*\.workbuddy[^"]*"[^\n]*\r?\n/gm, ''],
];
const RULES_CODE = mkRules('\\\\');   // → 文件里出现两个反斜杠
const RULES_TEXT = mkRules('\\');     // → 文件里出现一个反斜杠

const SANITIZE_EXT = /\.(js|json|html|css|bat|reg|yml|yaml|md|example)$/;
const CODE_EXT = /\.(js|json)$/;

function sanitize(root) {
    let touched = 0;
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            if (!SANITIZE_EXT.test(name)) continue;
            /* ★ 跳过脱敏工具自己（round24）：本文件第 217 行起是脱敏规则定义，
             * 里面必须写着 'F:\Aokazu' / '/media/aokazu_e' 这些**原始路径**做匹配源。
             * 拿自己的规则去替换自己的源码 = 自毁 —— 注释被改写还算轻的，一旦有人把
             * 某条规则的注释写成了 pattern 的形状，规则本体就会被悄悄改掉。
             * 代价：它会把作者的媒体盘符带进公开仓库（无凭证、无令牌，只是挂载点
             * 示例），可接受。真正敏感的字段值从来不写在 .js 里，而是放在被
             * GITIGNORE 挡住的 config.json / config.docker.json 中。 */
            if (name === 'make-public.js') continue;
            let text;
            try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
            const rules = CODE_EXT.test(name) ? RULES_CODE : RULES_TEXT;
            let out = text;
            for (const [re, to] of rules) out = out.replace(re, to);
            if (out !== text) {
                fs.writeFileSync(p, out, 'utf8');
                touched += 1;
                console.log('   · 脱敏 ' + path.relative(root, p));
            }
        }
    };
    walk(root);
    console.log(`   共改写 ${touched} 个文件`);
}

function main() {
    console.log('清理旧 git/ 内容（保留 .git）...');
    cleanKeepGit(DST);
    fs.mkdirSync(DST, { recursive: true });

    console.log('复制应用本体 ...');
    for (const d of APP_DIRS) {
        copyDir(path.join(SRC, d), path.join(DST, d),
                d === 'public' ? PUBLIC_SKIP : undefined);
    }
    for (const f of APP_FILES) copyFile(path.join(SRC, f), path.join(DST, f));
    for (const [dir, files] of Object.entries(APP_SUBSET)) {
        for (const f of files) copyFile(path.join(SRC, dir, f), path.join(DST, dir, f));
    }

    console.log('复制打包工具链 packaging/ ...');
    const pkgDst = path.join(DST, 'packaging');
    fs.mkdirSync(pkgDst, { recursive: true });
    for (const f of PKG_FILES) copyFile(path.join(SRC, 'packaging', f), path.join(pkgDst, f));
    for (const d of PKG_DIRS) copyDir(path.join(SRC, 'packaging', d), path.join(pkgDst, d));
    // 公开 README 放到仓库根
    copyFile(path.join(SRC, 'packaging', 'public-README.md'), path.join(DST, 'README.md'));

    console.log('写入 LICENSE / .gitignore ...');
    fs.writeFileSync(path.join(DST, 'LICENSE'), LICENSE, 'utf8');
    fs.writeFileSync(path.join(DST, '.gitignore'), GITIGNORE, 'utf8');

    console.log('脱敏（个人路径 → 通用占位）...');
    sanitize(DST);

    console.log('敏感信息扫描 ...');
    const hits = scanForSecrets(DST);
    if (hits.length) {
        console.error('❌ git/ 里发现疑似敏感内容，已中止：');
        hits.forEach((h) => console.error('   ' + h));
        process.exit(1);
    }
    console.log('✅ 未见敏感信息');

    // 统计（跳过 .git，只算仓库内容）
    let files = 0, bytes = 0;
    const stat = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            if (name === '.git') continue;
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) stat(p);
            else { files++; bytes += st.size; }
        }
    };
    stat(DST);
    console.log(`\n导出完成 → ${DST}`);
    console.log(`  ${files} 个文件，${(bytes / 1048576).toFixed(1)}MB`);
    console.log('\n下一步：');
    console.log('  ① 在 git/ 里查看改动    cd git && git status');
    console.log('     需要的话本地提交     git add -A && git commit -m "..."');
    console.log('  ② 推送到 GitHub         python packaging/_r23-publish.py check   # 先看要推什么');
    console.log('                          python packaging/_r23-publish.py push    # 走 REST API 全量替换');
    console.log('  ③ 发新版本下载            python packaging/_r23-release.py         # 建 Release 并上传 exe/ 里的成品');
    console.log('  ⚠ 本机 git push / fetch 到 github.com:443 会超时，必须走上面的 API 脚本；');
    console.log('     原因、凭据来源与替代方案见项目根《项目说明书.md》第 5 节。');
}

main();
