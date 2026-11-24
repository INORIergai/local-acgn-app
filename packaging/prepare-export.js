/**
 * prepare-export.js —— 生成「脱敏导出副本」到 packaging/payload/
 * --------------------------------------------------------------------------
 * 目录名刻意叫 payload 而不是 app：electron-builder 有个约定 —— 若项目根下存在
 * 名为 `app` 的目录，它会**把那个目录当成应用目录**去读 package.json，
 * 于是拿到 `main: server.js`（后端入口），打包时报
 *     Application entry file "...\resources\app\server.js" does not exist
 * 实测踩过。换个名字从此没这个坑。
 *
 * 用法: node prepare-export.js
 *
 * 只复制代码与静态资源；个人数据（数据库/海报/头像/缓存）、真实配置、
 * cookie、日志、调试脚本、参考截图一律不进导出目录。
 * 首次启动时应用会自动从 db/schema.sql 建空库。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const DST = path.join(__dirname, 'payload');
const ANDROID_DIST = path.join(SRC, 'android-dist');
const ANDROID_GRADLE = path.join(SRC, 'android', 'app', 'build.gradle');

// 目录白名单（整目录复制）
const COPY_DIRS = ['routes', 'utils', 'public'];
// 文件白名单（根目录单文件）
/* round29：项目只做 exe，Docker 脚手架已退役到 archive/docker-retired/。
 * 原来的 Dockerfile / docker-compose.yml / docker-entrypoint.js / .dockerignore 不再进 payload。
 * exe 的后端入口是 RUNTIME/server.js（packaging/main.js 直接 spawn），
 * 从来不是 docker-entrypoint.js ⇒ 移除对桌面版零影响。 */
const COPY_FILES = [
    'server.js',
    'package.json',
    'package-lock.json',
    'config.example.json',
];
// 增量更新验签公钥（公开信息，非凭据）：位于 packaging/ 下，随包携带，
// 主进程启动时部署到数据目录。它只在 packaging/ 有一份，不从项目根找。
const SIGNING_PUBLIC_KEY = path.join(__dirname, 'update-public-key.pem');
// host/ 与 db/ 与 tools/ 只挑干净文件
const SUBSET = {
    host: ['protocol-handler.js', 'install-protocols.bat', 'protocols.reg'],
    db: ['schema.sql'],
    tools: ['poster-relay.js', 'start-poster-relay.bat'],
};

// 额外排除（目录内的敏感/垃圾文件，双保险）
const EXTRA_SKIP = [
    'node_modules', '.git', 'data', 'cache', 'posters', 'docs', 'skills',
    'backups', 'backup-frontend.bat', 'restore-frontend.bat',
    /* 不要把 config.json 放这里：copyDir 按文件名匹配会跳过任意层级，
       实测会把 utils/tts/vits-runtime/model/config.json（VITS 模型参数）一起跳掉。
       项目根的 config.json / config.docker.json 不在 COPY_FILES 白名单里，本来就不会进包。 */
];

/**
 * 健壮删除：Windows 上杀毒/Windows Search/刚关的 EXE 会瞬时占用文件，
 * fs.rmSync 直接抛 EPERM 导致整个导出中断（实测「立刻重跑就好」）。
 * 这里对 EPERM/EBUSY 做有限退避重试，其它错误照抛（不吞真实故障）。
 */
function rm_rf(p) {
    const MAX = 6;
    for (let i = 0; i < MAX; i++) {
        try { fs.rmSync(p, { recursive: true, force: true }); return; }
        catch (e) {
            if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code) || i === MAX - 1) throw e;
            const ms = 120 * (i + 1);
            // 同步退避：不 spawn 任何外部命令（旧的 ping 写法会引入命令执行面）
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
            catch (_) { /* 退避失败也继续重试 */ }
        }
    }
}

/** 清空目录但保留指定项（node_modules 要留着：里面的原生模块是按 Electron ABI 编的，
 *  每次导出都删掉的话就得重新联网 + 重新编译，实测很容易卡在 prebuild 下载上） */
function cleanExcept(dst, keep) {
    if (!fs.existsSync(dst)) return;
    for (const name of fs.readdirSync(dst)) {
        if (keep.includes(name)) continue;
        rm_rf(path.join(dst, name));
    }
}

/* 不该进安装包的文件名：编辑器/手工备份、临时文件、系统垃圾、开发期验证台。
 * 实测踩过：public/js/app.js.bak-nr（改代码前留的档）被顺手复制进了 payload，
 * 于是 316KB 的旧源码跟着 exe 发到了用户机器上。
 * 2026-11：public/ 下的备份与 lab 页面已迁到 archive/public-cleanup/，
 * 这里再兜一层，防止以后又把 -backup / .backup- / _lab 之类的文件塞回 public。 */
const JUNK_RE = /(^\.DS_Store$|^Thumbs\.db$|^desktop\.ini$|\.(bak|old|orig|swp|swo|tmp|log|repair)$|\.bak-[\w.-]+$|\.v\d+-backup\.[a-z]+$|^\.backup-[\w.-]+$|^_[\w-]+-lab\.html$|^_magic-preview\.html$|~$)/i;

/* 个人路径脱敏（兜底）：即便某份源码忘了清，导出时也把写死的开发机路径替换成占位。
 * 只处理明确的个人目录/项目路径字面量，不碰普通文本，避免误伤业务字符串。 */
function sanitizeText(text) {
    return text
        // JS 源码里的双反斜杠形式：C:\\Users\\<用户>\\ 与 D:\\ai program\\local-movie-library\\
        .replace(/[A-Za-z]:\\\\Users\\\\[^\\"'\\s]+\\\\/g, '%USERPROFILE%\\\\')
        .replace(/[A-Za-z]:\\\\ai program\\\\local-movie-library\\\\/gi, '%INSTALLDIR%\\\\')
        // 纯文本/bat/注释里的单反斜杠形式
        .replace(/[A-Za-z]:\\Users\\[^\\"'\\s\\\n]+\\/g, '%USERPROFILE%\\')
        .replace(/[A-Za-z]:\ai program\local-movie-library\\/gi, '%INSTALLDIR%\\');
}

function copyFileSanitized(s, d) {
    // 只脱敏文本类代码/配置；二进制（node_modules/.node/图片等）原样复制
    if (!/\.(js|json|html|css|bat|reg|txt|md|yml|sql)$/i.test(s)) { fs.copyFileSync(s, d); return; }
    let text;
    try { text = fs.readFileSync(s, 'utf8'); }
    catch (e) { fs.copyFileSync(s, d); return; }
    fs.writeFileSync(d, sanitizeText(text), 'utf8');
}

function copyDir(src, dst, skip) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        if (skip && skip.includes(name)) continue;
        if (EXTRA_SKIP.includes(name)) continue;
        if (JUNK_RE.test(name)) continue;
        const s = path.join(src, name);
        const d = path.join(dst, name);
        const st = fs.statSync(s);
        if (st.isDirectory()) copyDir(s, d, skip);
        else copyFileSanitized(s, d);
    }
}

/**
 * 读取安卓版本号（唯一来源仍是 android/app/build.gradle）。
 * 打包后的 payload 里没有 android/ 目录，所以必须把版本固化进
 * payload/android-version.json，否则 PC 端的 /api/app/android-version
 * 会退化成「没有版本信息」或旧版的 4.6.0。
 */
function readAndroidVersion() {
    try {
        const raw = fs.readFileSync(ANDROID_GRADLE, 'utf8');
        const content = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        const code = content.match(/versionCode\s*=?\s*(\d+)/);
        const name = content.match(/versionName\s*=?\s*["']([^"']+)["']/);
        const minSdk = content.match(/minSdk\s*=?\s*(\d+)/);
        if (!code || !name) throw new Error('未匹配到 versionCode / versionName');
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(name[1])) throw new Error('版本号格式异常：' + name[1]);
        return {
            versionCode: parseInt(code[1], 10),
            versionName: name[1],
            minSdk: minSdk ? parseInt(minSdk[1], 10) : null,
            source: 'android/app/build.gradle'
        };
    } catch (e) {
        console.warn('  ⚠️ 读取安卓版本失败（Android 更新接口将不可用）：' + e.message);
        return null;
    }
}

/** 固化版本信息 + 把安装包带进 payload（手机更新走 PC 局域网，离线可用） */
function exportAndroid() {
    const info = readAndroidVersion();
    if (!info) return;

    // 优先用构建脚本产出的 android-dist/android-version.json（带 APK SHA/体积）；
    // 它不存在时才退回仅版本号（服务端会因缺 SHA 拒绝下发，不会误发旧包）。
    let meta = Object.assign({}, info, {
        builtAt: new Date().toISOString(),
        changelog: '',
        apkSha256: null,
        apkSize: 0
    });
    try {
        const raw = fs.readFileSync(path.join(ANDROID_DIST, 'android-version.json'), 'utf8').replace(/^\uFEFF/, '');
        const j = JSON.parse(raw);
        const shaOk = /^[a-f0-9]{64}$/i.test(String(j.apkSha256 || ''));
        if (j.versionName === info.versionName && Number(j.versionCode) === info.versionCode && shaOk) {
            meta = Object.assign({}, info, j, { source: 'android-dist/android-version.json' });
        } else {
            console.warn('  ⚠️ android-dist/android-version.json 与 build.gradle 版本/哈希不一致，忽略');
        }
    } catch (e) {
        console.warn('  ⚠️ 没有 android-dist/android-version.json（先跑 build-android.ps1 再打包 PC）');
    }
    fs.writeFileSync(path.join(DST, 'android-version.json'), JSON.stringify(meta, null, 2), 'utf8');
    console.log(`  ✓ android-version.json → v${info.versionName} (code ${info.versionCode})${meta.apkSha256 ? ' + SHA' : '（无 SHA，暂不可下发）'}`);

    if (!fs.existsSync(ANDROID_DIST)) {
        console.warn('  ⚠️ 缺少 android-dist/（手机端暂时拿不到安装包，但不会误发旧版）');
        return;
    }
    copyDir(ANDROID_DIST, path.join(DST, 'android-dist'));
    console.log('  ✓ android-dist/ → payload/android-dist/');
}

function main() {
    console.log('清理旧导出（保留 node_modules）...');
    fs.mkdirSync(DST, { recursive: true });
    cleanExcept(DST, ['node_modules']);

    console.log('复制白名单目录/文件 ...');
    for (const d of COPY_DIRS) copyDir(path.join(SRC, d), path.join(DST, d));
    for (const f of COPY_FILES) {
        const s = path.join(SRC, f);
        if (fs.existsSync(s)) copyFileSanitized(s, path.join(DST, f));
    }
    if (fs.existsSync(SIGNING_PUBLIC_KEY)) {
        fs.copyFileSync(SIGNING_PUBLIC_KEY, path.join(DST, 'update-public-key.pem'));
    } else {
        console.warn('  ⚠️ 缺少增量验签公钥 payload/update-public-key.pem（增量更新将回退全量）');
    }
    for (const [dir, files] of Object.entries(SUBSET)) {
        fs.mkdirSync(path.join(DST, dir), { recursive: true });
        for (const f of files) {
            const s = path.join(SRC, dir, f);
            if (fs.existsSync(s)) copyFileSanitized(s, path.join(DST, dir, f));
            else console.warn('  ⚠️ 缺少 ' + dir + '/' + f);
        }
    }

    // 安卓版本信息 + 安装包：随 PC 更新一起下发，手机才能离线从 PC 取更新
    console.log('导出安卓分发元数据 ...');
    exportAndroid();

    // 公开仓库的 .gitignore：绝不让真实配置/数据被提交
    fs.writeFileSync(path.join(DST, '.gitignore'), [
        '# 真实配置与个人数据绝不入库',
        'config.json',
        'config.docker.json',
        'data/',
        'db/*.db',
        'db/*.db-*',
        'db/*.bak*',
        'db/*.repair',
        'db/*.corrupt*',
        'cache/',
        'posters/',
        'host/*.log',
        '*.log',
        'tmp-render/',
        '.playwright-profile/',
        '.quark-login-profile/',
        '.user-browser-data/',
        'node_modules/',
    ].join('\n') + '\n');

    // 敏感信息最终扫描：确认导出里没有残留密钥/口令字样
    console.log('敏感信息扫描 ...');
    const danger = [];
    const scan = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            // node_modules 里全是第三方代码，既慢又有大量误报（测试文件里的假密钥），跳过
            if (name === 'node_modules' || name === '.git') continue;
            const st = fs.statSync(p);
            if (st.isDirectory()) { scan(p); continue; }
            if (!/\.(js|json|html|css|bat|reg|yml|md)$/.test(name)) continue;
            let text = '';
            try { text = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
            const patterns = [
                [/ghp_[A-Za-z0-9]{20,}/, 'GitHub PAT'],
                // 字符串字面量结尾必须紧跟 , ; } —— 排除 log('  token  : ' + x) 这类拼接误报
                [/(password|apiKey|api_key|token)\s*[:=]\s*["'][^"']{8,}["']\s*[,;}]/gi, '疑似密钥硬编码'],
                [/sk-[A-Za-z0-9]{20,}/, 'API Key'],
            ];
            for (const [re, label] of patterns) {
                if (re.test(text)) danger.push(label + ' → ' + path.relative(DST, p));
            }
        }
    };
    scan(DST);
    // config.example.json 的 CHANGE_ME 占位是允许的，排除误报
    const real = danger.filter(d => !(d.includes('config.example.json') && d.includes('疑似密钥')));
    if (real.length) {
        console.error('❌ 发现疑似敏感信息，禁止导出：');
        real.forEach(d => console.error('   ' + d));
        process.exit(1);
    }
    console.log('✅ 未见敏感信息');

    // 公开仓库 README（不出现任何个人路径/片名/站点账号信息）
    fs.writeFileSync(path.join(DST, 'README.md'), [
        '# Cinema Vault · 本地媒体库',
        '',
        '本地优先的私人媒体库：影片 / 动漫 / 漫画 / 小说四合一，自动扫描、刮削元数据与海报，',
        '自带阅读器、播放器、播放列表、新作监视、年度报告等模块。',
        '',
        '## 特性',
        '',
        '- 🎬 影片/动漫库：海报墙、详情抽屉、多源刮削、批量海报修复、播放进度记忆',
        '- 📚 漫画/小说库：目录树分栏、章节横滑阅读器、PDF/EPUB 封面自动兜底',
        '- 🆕 新作监视：女优/漫画系列更新追踪，封面本地落盘',
        '- 📊 年度报告：面积图 / 气泡图 / 比例条等可视化',
        '- 🎛️ 高度自定义：主页与 Banner 背景图上传、侧栏收缩、海报比例大小、播放器大小位置',
        '- 📱 单代码库响应式：桌面 / 移动端同一份代码，CSS 媒体查询全适配',
        '',
        '## 运行方式',
        '',
        '### 方式一：本地 Node（≥18）',
        '',
        '```bash',
        'npm install',
        'cp config.example.json config.json          # 填入扫描路径',
        'node server.js',
        '```',
        '',
        '### 方式二：桌面版 exe（GUI）',
        '',
        '到 Releases 页下载 `CinemaVault-Setup-*.exe`（安装版，会建桌面快捷方式）或',
        '`CinemaVault-Portable-*.exe`（免安装单文件）。双击即用，不需要装 Node、不需要 Docker。',
        '',
        '首次启动会：① 自动建库；② **默认不设密码，打开就能用**；',
        '③ 把可写数据放在下面这些位置（升级程序不会动它们）：',
        '',
        '- 安装版：`%APPDATA%\\CinemaVault\\`',
        '- 便携版：与 exe 同级的 `CinemaVault-Data\\`',
        '',
        '自己从源码打包：见 `packaging/build-exe.bat`。',
        '',
        '#### 可选：ffmpeg',
        '',
        '`ffmpeg` / `ffprobe` 不是必需，但缺了就没有「视频截帧取封面」和时长识别。',
        '想启用：把 `ffmpeg.exe` 与 `ffprobe.exe` 放进数据目录的 `bin\\` 子目录即可（下次启动自动生效）。',
        '',
        '## 配置',
        '',
        '复制 `config.example.json` 为 `config.json`，',
        '填入扫描路径等。访问密码可在应用内「设置 → 🔒 安全与通知」随时开关，**默认免密**。',
        '**真实配置文件已被 .gitignore 排除，请勿提交。**',
        '',
        '首次启动会自动从 `db/schema.sql` 建空库，无需手动初始化。',
        '',
        '## 目录结构',
        '',
        '```',
        'server.js          # Express 入口',
        'routes/            # API 路由',
        'utils/             # 扫描器 / 刮削器 / 数据层',
        'public/            # 前端（原生 HTML/JS/CSS，无框架）',
        'db/schema.sql      # 建库脚本（首次启动自动执行）',
        'host/              # Windows 宿主机协议处理器（lmlplayer:// lmlfolder://）',
        'packaging/         # Electron 打包（上级仓库提供，见 build-exe.bat）',
        '```',
        '',
        '## License',
        '',
        'MIT',
        '',
    ].join('\n') + '\n');

    fs.writeFileSync(path.join(DST, 'LICENSE'), [
        'MIT License',
        '',
        `Copyright (c) ${new Date().getFullYear()} Cinema Vault`,
        '',
        'Permission is hereby granted, free of charge, to any person obtaining a copy',
        'of this software and associated documentation files (the "Software"), to deal',
        'in the Software without restriction, including without limitation the rights',
        'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
        'copies of the Software, and to permit persons to whom the Software is',
        'furnished to do so, subject to the following conditions:',
        '',
        'The above copyright notice and this permission notice shall be included in all',
        'copies or substantial portions of the Software.',
        '',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
        'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
        'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
        'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
        'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
        'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
        'SOFTWARE.',
    ].join('\n') + '\n');

    console.log('\n导出完成 → ' + DST);
    console.log('下一步: 双击 build-exe.bat 打包 exe');
}

main();
