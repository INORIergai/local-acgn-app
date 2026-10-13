/**
 * 本地影库 - 宿主机协议处理器
 *
 * 作用：当页面通过自定义协议唤起本地应用时，由本脚本在 Windows 宿主机上执行：
 *   - lmlplayer://open?p=<base64url>  -> 用 PotPlayer 播放指定视频
 *   - lmlfolder://open?p=<base64url>  -> 用资源管理器打开并选中指定文件/文件夹
 *
 * 其中 p 参数为「Windows 宿主机路径」经过 base64url(UTF-8) 编码后的值，
 * 由前端 / 后端在需要打开时生成。
 *
 * 说明：应用运行在 Docker（Linux 容器）内时无法直接唤起 Windows 程序，
 * 因此通过此协议在宿主机侧完成播放/打开文件夹的动作。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'protocol-handler.log');

function log(msg) {
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleString()}] ${msg}\n`);
    } catch (e) { /* 忽略日志错误 */ }
}

// 兼容旧版 Node 的 base64url 解码
function base64UrlDecode(str) {
    let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return Buffer.from(b64, 'base64').toString('utf8');
}

// 查找 PotPlayer 路径：1) 配置 2) 常见安装位置
function findPotPlayer() {
    const candidates = [];
    for (const cfg of [path.join(__dirname, '..', 'config.json'), path.join(__dirname, '..', 'config.docker.json')]) {
        try {
            const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
            if (c.player && c.player.potPlayerPath) candidates.push(c.player.potPlayerPath);
        } catch (e) { /* 忽略 */ }
    }
    candidates.push(
        'D:\\PotPlayer\\PotPlayerMini64.exe',
        'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
        'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
        'C:\\Program Files\\PotPlayer\\PotPlayerMini.exe',
        'C:\\Program Files (x86)\\PotPlayer\\PotPlayerMini.exe'
    );
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

function main() {
    const raw = process.argv[2] || '';
    log('收到调用: ' + raw);

    let url;
    try {
        url = new URL(raw);
    } catch (e) {
        log('URL 解析失败: ' + e.message);
        return;
    }

    const proto = url.protocol.replace(':', '').toLowerCase();
    const p = url.searchParams.get('p');
    if (!p) {
        log('缺少 p 参数');
        return;
    }
    const winPath = base64UrlDecode(p);
    log(`协议=${proto} 路径=${winPath}`);

    if (proto === 'lmlplayer') {
        const pot = findPotPlayer();
        if (!pot) {
            log('未找到 PotPlayer，请在「设置」中配置 PotPlayer 路径');
            return;
        }
        const child = spawn(pot, [winPath], { detached: true, stdio: 'ignore' });
        child.unref();
        log(`已启动 PotPlayer: ${pot}`);
    } else if (proto === 'lmlfolder') {
        /* ⚠️ 必须加 windowsVerbatimArguments：
           默认情况下 Node 会把含空格的参数整体加引号，命令行变成
             explorer "/select,E:\a b\影片.mp4"
           Explorer 解析不了这种写法，会回退打开「文档」文件夹。
           verbatim 模式下命令行是（无引号，explorer 取逗号后整段当路径）：
             explorer /select,E:\a b\影片.mp4
           这才是资源管理器认的 /select 语法。 */
        const child = spawn('explorer.exe', ['/select,' + winPath], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
        child.unref();
        log('已打开文件夹: ' + winPath);
    } else {
        log('未知协议: ' + proto);
    }
}

main();
