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
 * 局域网访问地址（设置页二维码 / 启动日志用）
 * Docker 容器里 os.networkInterfaces() 拿到的是容器网段（172.x，手机不可达），
 * 端口也是容器内的 3000 而不是映射出去的 3002。所以允许 config.lan 覆盖，缺省才自动探测。
 * 家庭宽带下的电脑 IP 会变；想固定就写进 config.lan.host（或在路由器里做 IP 保留）。
 */
function lanInfo() {
    const os = require('os');
    let ip = (config.lan && config.lan.host) || null;
    if (!ip) {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break; }
            }
            if (ip) break;
        }
    }
    const port = (config.lan && config.lan.port) || config.serverPort || 3000;
    return {
        ip: ip || '127.0.0.1',
        port,
        url: `http://${ip}:${port}`,
        localUrl: `http://localhost:${port}`
    };
}

module.exports.lanInfo = lanInfo;

