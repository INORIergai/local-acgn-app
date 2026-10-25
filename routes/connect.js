/**
 * routes/connect.js — 移动端扫码连接支持（纯增量，不影响既有功能）
 *
 * GET /api/connect/info  → 局域网所有可用地址 + 端口（供 connect.html 展示与二维码生成）
 * GET /api/connect/qr    → 二维码 PNG（?text= 默认第一个地址；供 connect.html <img>）
 *
 * 手机端（CinemaVault HarmonyOS / Android）扫码即得 http://IP:PORT，免手输。
 */
const express = require('express');
const os = require('os');
const config = require('../utils/config');
/* round127：qrcode 改成**按需加载**。
 * 原先是顶层 require —— EXE 运行区的 node_modules 由打包时决定，缺这个包时
 * 整个路由文件加载即抛错，server.js 的 uncaughtException 兜不住启动阶段的这次 throw，
 * 结果就是「双击 EXE 什么都不发生，3517 端口从不起来」。
 * 一个只有扫码页才用得到的可选依赖，不该有把整个服务带下线的权力。 */
let _qrcode = null;
let _qrcodeErr = null;
function loadQrCode() {
    if (_qrcode) return _qrcode;
    if (_qrcodeErr) throw _qrcodeErr;
    try {
        _qrcode = require('qrcode');
        return _qrcode;
    } catch (e) {
        _qrcodeErr = e;
        throw e;
    }
}

const router = express.Router();

/** 枚举本机所有非内部网卡的 IPv4 地址 → http://ip:port 列表（去重、排除 127.*） */
function lanAddresses() {
    const port = config.serverPort || 3000;
    const out = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const it of (ifaces[name] || [])) {
            if (it.family !== 'IPv4' || it.internal) continue;
            if (it.address.startsWith('127.')) continue;
            const url = `http://${it.address}:${port}`;
            if (!out.includes(url)) out.push(url);
        }
    }
    return out;
}

router.get('/info', (req, res) => {
    try {
        res.json({ code: 0, data: { port: config.serverPort || 3000, addresses: lanAddresses() } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.get('/qr', async (req, res) => {
    try {
        let QRCode;
        try { QRCode = loadQrCode(); } catch (e) {
            /* 没有二维码渲染依赖不影响扫码页本身：前端可退化成纯文本地址 */
            return res.status(503).json({ code: -1, msg: '二维码模块不可用：' + e.message });
        }
        const list = lanAddresses();
        const text = String(req.query.text || list[0] || '');
        if (!/^https?:\/\/[^\s]+$/.test(text)) {
            return res.status(400).json({ code: -1, msg: '缺少有效地址' });
        }
        const buf = await QRCode.toBuffer(text, {
            type: 'png',
            width: 480,
            margin: 2,
            color: { dark: '#0B0E14', light: '#FFFFFF' }
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.send(buf);
    } catch (e) {
        res.status(500).json({ code: -1, msg: e.message });
    }
});

module.exports = router;
