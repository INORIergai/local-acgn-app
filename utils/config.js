/**
 * 统一配置加载器
 * 与 server.js 保持一致的加载逻辑：
 *   - 若设置了环境变量 CONFIG_FILE（Docker 场景为 /app/config.docker.json），则加载该文件
 *   - 否则加载项目根目录的 config.json（宿主机直跑场景）
 *
 * 修复问题：此前各模块硬编码 require('../config.json')，在 Docker 容器内
 * 拿到的是宿主机配置（代理指向 127.0.0.1、扫描目录为 Windows 路径），
 * 导致爬虫/刮削全部连不上宿主机代理、设置页读写错误文件等。
 */
const fs = require('fs');
const path = require('path');

const configPath = process.env.CONFIG_FILE
    ? path.resolve(process.env.CONFIG_FILE)
    : path.join(__dirname, '..', 'config.json');

let config = {};
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.error(`[config] 无法加载配置文件 ${configPath}: ${e.message}`);
}

module.exports = config;
module.exports.configPath = configPath;
/**
 * 探测本机局域网 IP（手机与电脑连同一 WiFi 时可访问的那个网段）。
 * 历史坑（round106）：os.networkInterfaces() 的枚举顺序里，Hyper-V
 * 「Default Switch」等虚拟网卡（172 段）可能排在真实网卡之前，
 * 旧逻辑取"第一个非内部 IPv4"会选中虚拟网段，手机扫码/输地址都打不开。
 * 策略：
 *   1. Windows：取默认路由出口网卡的 IP（route print -4 活动路由第 4 列），
 *      该网卡才是本机访问外网、也是手机可达的真实入口；并校验该 IP 当前仍挂在网卡上；
 *   2. 兜底枚举：按名字排除虚拟网卡（vEthernet/VMware/VirtualBox/WSL/Docker/Teredo…），
 *      跳过 169.254.*（APIPA 自动私网），按 192.168 段 > 10 段 > 172 段优先级挑选。
 */
function detectLanIp() {
    const os = require('os');
    const { execSync } = require('child_process');

    // 当前所有非内部 IPv4（用于校验路由结果 + 枚举兜底）
    const interfaces = os.networkInterfaces();
    const alive = new Set();
    const candidates = [];
    for (const [name, list] of Object.entries(interfaces)) {
        for (const iface of list) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            if (iface.address.startsWith('169.254.')) continue; // APIPA 自动私网，手机不可达
            alive.add(iface.address);
            candidates.push({ name, address: iface.address });
        }
    }

    // 1) 默认路由出口网卡（仅 Windows；route print -4 输出为本地化中文也不影响，只取数字列）
    if (process.platform === 'win32') {
        try {
            const out = execSync('route print -4', {
                encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
            });
            for (const line of out.split(/\r?\n/)) {
                const cols = line.trim().split(/\s+/);
                // 活动路由: 0.0.0.0  0.0.0.0  <网关>  <接口IP>  <跃点数>
                if (cols.length >= 5 && cols[0] === '0.0.0.0' && cols[1] === '0.0.0.0'
                    && /^\d{1,3}(\.\d{1,3}){3}$/.test(cols[3]) && alive.has(cols[3])) {
                    return cols[3];
                }
            }
        } catch (e) { /* route 不可用则走枚举兜底 */ }
    }

    // 2) 枚举兜底：排除虚拟网卡名，按常见局域网网段优先级
    const VIRTUAL = /vEthernet|VirtualBox|VMware|WSL|vbox|docker|Teredo|isatap|Pseudo-Interface/i;
    const real = candidates.filter(c => !VIRTUAL.test(c.name)).map(c => c.address);
    const rank = ip =>
        ip.startsWith('192.168.') ? 0 :
        ip.startsWith('10.') ? 1 :
        ip.startsWith('172.') ? 2 : 3;
    real.sort((a, b) => rank(a) - rank(b));
    return real[0] || null;
}

function lanInfo() {
    const ip = (config.lan && config.lan.host) || detectLanIp() || '127.0.0.1';
    const port = (config.lan && config.lan.port) || config.serverPort || 3000;
    return {
        ip,
        port,
        url: `http://${ip}:${port}`,
        localUrl: `http://localhost:${port}`
    };
}

module.exports.lanInfo = lanInfo;

