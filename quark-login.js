/**
 * 夸克网盘 Cookie 一键续期
 *
 * 为什么在宿主机上跑：容器内 / 桌面版的服务端都碰不到你的浏览器。
 * 本脚本用宿主机上的 Playwright 打开夸克登录页（手机夸克 App 扫码即可），
 * 登录成功后把 cookie 通过 HTTP 推给正在运行的影库并落盘。
 *
 *   node quark-login.js                              自动找到在跑的影库 → 打开登录页 → 写入并校验
 *   node quark-login.js --check                      只报告，不动浏览器
 *   node quark-login.js --app http://127.0.0.1:3517   指定实例，跳过端口探测
 *   node quark-login.js --password 6799               指定访问密码（默认从该实例自己的 config 读）
 *   node quark-login.js --prefer docker               同时跑着多个实例时优先 Docker（默认优先本地）
 *
 * 双击「夸克登录.bat」等效于第一条。
 *
 * ── round26 续：为什么把「写死 3002」改掉 ────────────────────────────
 * 旧版 `APP = process.env.APP_URL || 'http://localhost:3002'` 把目标锁死在
 * Docker 的映射端口上，读密码也固定读 config.docker.json。用户改用免安装 exe
 * 之后，只要 Docker 没开，双击 bat 就只会得到一句「出错: fetch failed」——
 * 既不知道要连谁，也不知道该启动哪个。
 * 现在改成「先探测、再登录」：扫一遍本机端口，谁是活的就跟谁走，
 * 密码从**该实例自己的** config 里取（找不到才用其它 config 兜底）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.quark-login-profile');
const WAIT_MS = Number(process.env.WAIT_MS || 5 * 60 * 1000);
const PROBE_TIMEOUT = 1200;      // 单端口探测超时（本机连接，1.2s 足够）

/* ================= 命令行参数 ================= */
const argv = process.argv.slice(2);
function argVal(name) {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const eq = argv.find(a => a.startsWith(name + '='));
    return eq ? eq.slice(name.length + 1) : '';
}
const ARG_APP = argVal('--app') || process.env.APP_URL || '';
const ARG_PWD = argVal('--password');
const PREFER = (argVal('--prefer') || 'local').toLowerCase();
const CHECK_ONLY = argv.includes('--check');

/* ================= 各形态的 config 路径 ================= */
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const CFG = {
    desktopRuntime: path.join(APPDATA, 'CinemaVault', 'runtime', 'config.json'),
    desktopPortable: path.join(ROOT, 'exe', '免安装目录', 'win-unpacked', 'CinemaVault-Data', 'runtime', 'config.json'),
    dev: path.join(ROOT, 'config.json'),
    docker: path.join(ROOT, 'config.docker.json'),
};
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function pwdOf(p) { const c = readJson(p); return (c && c.auth && c.auth.password) || ''; }

/* ================= 候选实例 =================
 * 说明：桌面版的端口是主进程 findFreePort() 选出来的，config 里的 serverPort
 *      不一定等于实际端口，所以「读 config」和「扫一段」都要做。 */
function buildCandidates() {
    const out = [];
    const seen = new Set();
    const push = (port, label, kind, cfgs) => {
        port = Number(port);
        if (!port || port < 1 || port > 65535 || seen.has(port)) return;
        seen.add(port);
        out.push({ port, label, kind, cfgs });
    };

    if (ARG_APP) {
        try {
            const u = new URL(ARG_APP);
            push(u.port || (u.protocol === 'https:' ? 443 : 80), '命令行/环境变量指定 (' + ARG_APP + ')',
                'auto', Object.values(CFG));
        } catch (e) {
            console.log('[警告] --app / APP_URL 不是合法 URL：' + ARG_APP);
        }
    }

    const rt = readJson(CFG.desktopRuntime);
    if (rt && rt.serverPort) push(rt.serverPort, '桌面版（免安装 exe）', 'local', [CFG.desktopRuntime, CFG.desktopPortable]);
    for (let p = 3510; p <= 3530; p++) push(p, '桌面版（端口自动选）', 'local', [CFG.desktopRuntime, CFG.desktopPortable]);

    const dk = readJson(CFG.docker);
    if (dk && dk.lan && dk.lan.port) push(dk.lan.port, 'Docker 容器（lan.port）', 'docker', [CFG.docker]);
    push(3002, 'Docker 容器（默认映射）', 'docker', [CFG.docker]);
    push(3001, 'Docker 容器（备用映射）', 'docker', [CFG.docker]);

    const dev = readJson(CFG.dev);
    if (dev && dev.serverPort) push(dev.serverPort, '开发树 (node server.js)', 'local', [CFG.dev]);
    push(3000, '开发树 (node server.js)', 'local', [CFG.dev]);
    return out;
}

/* ================= 探测：本机这个端口上有影库吗 =================
 * /api/* 在「启用访问密码」时除 /api/auth 外一律要会话，
 * 所以 200 = 活着且免密、401 = 活着但要密码，都算命中。 */
async function probe(c) {
    const url = 'http://127.0.0.1:' + c.port;
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT);
        const r = await fetch(url + '/api/config', { signal: ctl.signal });
        clearTimeout(t);
        if (r.status === 200) return Object.assign({}, c, { url, alive: true, needAuth: false });
        if (r.status === 401) return Object.assign({}, c, { url, alive: true, needAuth: true });
        return null;
    } catch (e) {
        return null;
    }
}

/* ================= 登录：拿到会话 cookie ================= */
async function login(inst) {
    const tries = [];
    const add = (pwd, from) => { if (pwd) tries.push({ pwd, from }); };
    add(ARG_PWD, '--password');
    inst.cfgs.forEach(f => add(pwdOf(f), f));
    Object.values(CFG).forEach(f => add(pwdOf(f), '(兜底) ' + path.relative(ROOT, f)));

    const used = new Set();
    for (const t of tries) {
        if (used.has(t.pwd)) continue;
        used.add(t.pwd);
        try {
            const r = await fetch(inst.url + '/api/auth/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: t.pwd })
            });
            if (!r.ok) continue;
            const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
            const cookie = (raw || []).filter(Boolean).map(c => c.split(';')[0]).join('; ');
            if (!cookie) continue;
            return { session: cookie, from: t.from };
        } catch (e) { /* 试下一条 */ }
    }
    return null;
}

/* ================= 主流程 ================= */
(async () => {
    console.log('== 查找正在运行的影库 ==');
    const cands = buildCandidates();
    const found = [];
    for (const c of cands) {
        const r = await probe(c);
        if (r) found.push(r);
    }

    // 同时跑着多个时排序：默认「本地优先」，--prefer docker 可反过来
    found.sort((a, b) => {
        const w = x => (x.kind === 'docker' ? 1 : 0);
        return PREFER === 'docker' ? w(b) - w(a) : w(a) - w(b);
    });

    if (!found.length) {
        console.log('✗ 本机没有探测到正在运行的影库');
        console.log('  已扫端口：' + cands.map(c => c.port).join(', '));
        console.log('  请先启动其中一个，再双击本脚本：');
        console.log('    · 桌面版：exe\\免安装目录\\win-unpacked\\CinemaVault.exe');
        console.log('    · Docker：docker-start.bat');
        process.exit(2);
    }

    const inst = found[0];
    console.log('→ 目标：' + inst.label + '  ' + inst.url);
    if (found.length > 1) {
        console.log('  （同时还在跑：' + found.slice(1).map(x => x.label + ' ' + x.url).join('、') +
            '；可加 --app 指定）');
    }

    /* ---- 登录（免密实例跳过）---- */
    let session = '';
    if (inst.needAuth) {
        const lg = await login(inst);
        if (!lg) {
            console.log('✗ 登录失败：没有一条已知密码能用。');
            console.log('  可核对实例自己的 config（auth.password），或加 --password 指定。');
            process.exit(3);
        }
        session = lg.session;
        console.log('  已用 ' + lg.from + ' 里的密码登录');
    } else {
        console.log('  该实例没开访问密码，跳过登录');
    }
    const authHeaders = session ? { Cookie: session, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    const authed = (url, opts = {}) =>
        fetch(inst.url + url, Object.assign({}, opts, { headers: Object.assign({}, authHeaders, opts.headers || {}) }));

    /* ---- 顺手确认一下实例形态（Docker 还是本机直跑）---- */
    try {
        const r = await authed('/api/config/lan-info');
        if (r.ok) {
            const j = await r.json();
            const dep = j.data && j.data.deployment;
            if (dep) console.log('  实例形态：' + (dep === 'docker' ? 'Docker 容器' : '本机直跑'));
        }
    } catch (e) { /* 不影响主流程 */ }

    /* ---- 夸克当前状态 ----
     * ★ 必须走 /health 而不是 /check-login：夸克 API 对过期 cookie 仍返回 200，
     *   只看 loggedIn 会误报「已登录」，要真取一次流才知道能不能读。 */
    const st = await (await authed('/api/cloud/quark/health')).json().catch(() => ({}));
    const sd = (st && st.data) || {};
    if (!sd.loggedIn) {
        console.log('当前夸克登录状态: 未登录 / cookie 已失效 ✗');
    } else if (sd.sessionValid === true) {
        console.log('当前夸克登录状态: 已登录且取流可用 ✓', sd.tested ? '（实测：' + sd.tested.name + '）' : '');
    } else if (sd.sessionValid === false) {
        console.log('当前夸克登录状态: 已登录，但**取流被拒** ✗ →', sd.msg || '');
    } else {
        console.log('当前夸克登录状态: 已登录（未能验证取流）→', sd.msg || '');
    }

    if (CHECK_ONLY) process.exit(0);

    /* ---- 打开登录页，扫码后写入 ---- */
    console.log('\n== 打开夸克登录页 ==');
    console.log('窗口里用手机夸克 App 扫码，或直接登录。登录成功后本脚本自动写入并校验。\n');
    const { chromium } = require('playwright');
    if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: null,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-features=TranslateUI']
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    const nav = await page.goto('https://pan.quark.cn', { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(e => ({ error: e.message }));
    console.log('页面:', page.url(), '|', await page.title().catch(() => ''),
        nav && nav.error ? '（加载异常: ' + nav.error + '）' : '');
    if (page.url().includes('login') || (await page.content()).includes('扫码')) {
        console.log('→ 请用手机夸克 App 扫码');
    }

    const KEY = ['ctoken', '__pus', '__puus', 'isQuark', 'tfstk'];
    const start = Date.now();
    let done = false, saidTicket = false, lastWarn = 0, tick = 0;
    const secs = () => Math.round((Date.now() - start) / 1000);
    while (Date.now() - start < WAIT_MS && !done) {
        await new Promise(r => setTimeout(r, 3000));
        tick++;
        let cookies = [];
        try { cookies = await ctx.cookies(); } catch (e) { continue; }
        const q = cookies.filter(c => /(^|\.)quark\.cn$/.test(c.domain.replace(/^\./, '')) && KEY.includes(c.name) && c.value);
        const quarkCookies = cookies.filter(c => /(^|\.)quark\.cn$/.test(c.domain.replace(/^\./, '')));

        if (!q.length) {
            if (tick % 5 === 0) console.log('  [' + secs() + 's] 等登录中…（已看到 ' + quarkCookies.length + ' 个夸克 cookie，还没出现登录票据）');
            continue;
        }
        if (!saidTicket) {
            console.log('  [' + secs() + 's] 检测到登录票据: ' + q.map(c => c.name).join(', ') + ' → 写入应用');
            saidTicket = true;
        }

        const cookieStr = quarkCookies.map(c => c.name + '=' + c.value).join('; ');
        const r = await (await authed('/api/cloud/quark/set-cookie', {
            method: 'POST', body: JSON.stringify({ cookie: cookieStr })
        })).json().catch(() => ({ code: -1, msg: '网络异常' }));
        if (r.code !== 0) { console.log('  [' + secs() + 's] ✗ 写入失败: ' + r.msg); continue; }

        // ★ 必须走 /health：它会真去取一次流。「已写入 cookie」≠「能下载/能在线阅读」
        const chk = await (await authed('/api/cloud/quark/health')).json().catch(() => ({}));
        const cd = (chk && chk.data) || {};
        if (cd.sessionValid === true) {
            console.log('\n✅ 登录成功，且**取流验证通过**（cookie ' + cookieStr.length + ' 字符）');
            console.log('   写入目标：' + inst.label + '  ' + inst.url);
            if (cd.tested) console.log('   实测文件：' + cd.tested.name + '（' + cd.tested.sizeMB + ' MB）→ HTTP ' + cd.tested.HTTP);
            console.log('   应用里可以直接浏览 / 下载 / 在线阅读网盘内容了。');
            done = true;
            break;
        }
        if (cd.loggedIn && cd.sessionValid === false) {
            console.log('  [' + secs() + 's] 已写入 cookie，但取流仍被拒：' + (cd.msg || '') + '（继续等，或稍后重跑本脚本）');
            saidTicket = false;
            continue;
        }
        if (Date.now() - lastWarn > 20000) {
            lastWarn = Date.now();
            console.log('  [' + secs() + 's] 已写入 ' + cookieStr.length + ' 字符，但夸克还说未登录，继续等（登录页可能还没跳完）');
        }
    }
    if (!done) console.log('\n⚠️ 超时未完成登录，重跑一次即可。');
    await ctx.close();
    process.exit(done ? 0 : 1);
})().catch(e => { console.error('出错:', e.message); process.exit(1); });
