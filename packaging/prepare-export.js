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

// 目录白名单（整目录复制）
const COPY_DIRS = ['routes', 'utils', 'public'];
// 文件白名单（根目录单文件）
const COPY_FILES = [
    'server.js',
    'package.json',
    'package-lock.json',
    'config.example.json',
    'Dockerfile',
    'docker-compose.yml',
    'docker-entrypoint.js',
    '.dockerignore',
];
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
    'config.json', 'config.docker.json',
];

function rm_rf(p) {
    fs.rmSync(p, { recursive: true, force: true });
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

/* 不该进安装包的文件名：编辑器/手工备份、临时文件、系统垃圾。
 * 实测踩过：public/js/app.js.bak-nr（改代码前留的档）被顺手复制进了 payload，
 * 于是 316KB 的旧源码跟着 exe 发到了用户机器上。 */
const JUNK_RE = /(^\.DS_Store$|^Thumbs\.db$|^desktop\.ini$|\.(bak|old|orig|swp|swo|tmp|log|repair)$|\.bak-[\w.-]+$|~$)/i;

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
        else fs.copyFileSync(s, d);
    }
}

function main() {
    console.log('清理旧导出（保留 node_modules）...');
    fs.mkdirSync(DST, { recursive: true });
    cleanExcept(DST, ['node_modules']);

    console.log('复制白名单目录/文件 ...');
    for (const d of COPY_DIRS) copyDir(path.join(SRC, d), path.join(DST, d));
    for (const f of COPY_FILES) {
        const s = path.join(SRC, f);
        if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DST, f));
    }
    for (const [dir, files] of Object.entries(SUBSET)) {
        fs.mkdirSync(path.join(DST, dir), { recursive: true });
        for (const f of files) {
            const s = path.join(SRC, dir, f);
            if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DST, dir, f));
            else console.warn('  ⚠️ 缺少 ' + dir + '/' + f);
        }
    }

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
        '### 方式一：Docker',
        '',
        '```bash',
        'cp config.example.json config.docker.json   # 填入媒体目录挂载点',
        'docker compose up -d --build',
        '```',
        '',
        '### 方式二：本地 Node（≥18）',
        '',
        '```bash',
        'npm install',
        'cp config.example.json config.json          # 填入扫描路径',
        'node server.js',
        '```',
        '',
        '### 方式三：桌面版 exe（GUI）',
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
        '复制 `config.example.json` 为 `config.json`（本地）或 `config.docker.json`（容器），',
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
    console.log('下一步: 双击 build-exe.bat 打包 exe（或参照 README 用 Docker 跑导出副本）');
}

main();
