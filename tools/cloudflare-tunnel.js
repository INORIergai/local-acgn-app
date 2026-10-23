const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CLOUDFLARED = 'D:\\apps\\cloudflared\\cloudflared.exe';

/* 端口不再写死 3517：桌面版用 findFreePort 从 3517 起向上找空闲端口，
   3517 被别的常驻程序占用时它其实跑在 3518~3557 上（这时写死 3517 只会得到 502）。
   优先级：命令行参数 > 环境变量 CV_PORT > 自动探测（config.json serverPort → 扫 3517~3557） */

function probe(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/auth/status', timeout: 1500 }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function detectPort() {
    // 1) 桌面版把实际端口写进了 runtime/config.json 的 serverPort
    try {
        const cfgFile = path.join(os.homedir(), 'AppData', 'Roaming', 'CinemaVault', 'runtime', 'config.json');
        const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        const p = Number(cfg && cfg.serverPort);
        if (p > 0 && (await probe(p))) return p;
    } catch (e) { /* 读不到就往下扫 */ }
    // 2) 扫描桌面版可能用到的端口段
    for (let p = 3517; p <= 3557; p++) {
        if (await probe(p)) return p;
    }
    return 0;
}

function startTunnel(port) {
    const target = 'http://127.0.0.1:' + port;
    const hostHeader = 'localhost:' + port;
    console.log('[2/3] 正在连接 Cloudflare 边缘网络建立隧道 → ' + target);

    const proc = spawn(CLOUDFLARED, ['tunnel', '--url', target, '--http-host-header', hostHeader], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
    });

    let urlFound = false;

    function checkLine(line) {
        const m = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !urlFound) {
            urlFound = true;
            const publicUrl = m[0];
            console.log('\n[3/3] 隧道创建成功！🎉  (目标 127.0.0.1:' + port + ')');
            console.log('----------------------------------------------------');
            console.log('【外网专属 HTTPS 网址】:');
            console.log('  ' + publicUrl);
            console.log('----------------------------------------------------');
            console.log('📱 手机在外面用移动数据流量时：');
            console.log('   打开手机上的 Cinema Vault App');
            console.log('   长按返回键（或首次启动时）将上面的网址填入连接即可！');
            console.log('----------------------------------------------------');
            console.log('⚠️ 提示：请保持本窗口开启（关闭本窗口穿透即停止）');
            console.log('⚠️ 提示：桌面版一旦关闭/重启，本网址立即失效，需重新运行本脚本\n');

            // 安全调用剪贴板写入，避免命令拼接
            try {
                spawnSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard', '-Value', publicUrl], { shell: false });
                console.log('✨ 已自动将外网网址复制到电脑剪贴板！');
            } catch (e) { /* 剪贴板失败不影响隧道 */ }
        }
    }

    proc.stdout.on('data', d => {
        d.toString().split('\n').forEach(checkLine);
    });

    proc.stderr.on('data', d => {
        d.toString().split('\n').forEach(checkLine);
    });

    proc.on('exit', (code) => {
        console.log(`穿透进程已退出 (code: ${code})`);
    });
}

async function main() {
    console.log('====================================================');
    console.log('       Cinema Vault · Cloudflare 快速内网穿透');
    console.log('====================================================');

    let port = String(process.argv[2] || process.env.CV_PORT || '').trim();
    if (port && !/^\d{2,5}$/.test(port)) {
        console.error('端口不合法：' + port);
        process.exit(1);
    }
    if (!port) {
        console.log('[1/3] 未指定端口，正在探测桌面版实际监听端口...');
        const found = await detectPort();
        if (!found) {
            console.error('❌ 没有探测到正在运行的 Cinema Vault 桌面版。');
            console.error('   请先启动桌面版（双击图标，或运行 packaging/start-desktop.ps1），再重跑本脚本。');
            process.exit(1);
        }
        port = String(found);
        console.log('      探测到桌面版在端口 ' + port);
    }
    if (!(await probe(Number(port)))) {
        console.error('❌ 端口 ' + port + ' 上没有 Cinema Vault 后端在响应（/api/auth/status 通不过）。');
        console.error('   隧道能建起来但一访问就是 502 —— 先启动桌面版再来。');
        process.exit(1);
    }
    startTunnel(port);
}

main();
