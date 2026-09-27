/**
 * 个性化定制接口（2026-09-22）
 * 背景图（主页 / banner）上传与清除，文件落盘 data/custom/，
 * 由 server.js 挂 /custom 静态服务对外访问。
 */
const router = require('express').Router();
const fs = require('fs');
const path = require('path');

const CUSTOM_DIR = path.join(__dirname, '..', 'data', 'custom');
const MAX_SIZE = 12 * 1024 * 1024; // 12MB
const TYPES = ['page', 'banner'];

function ensureDir() {
    if (!fs.existsSync(CUSTOM_DIR)) fs.mkdirSync(CUSTOM_DIR, { recursive: true });
}

// 删除某类型的旧背景图（任意扩展名）
function removeOld(type) {
    try {
        for (const f of fs.readdirSync(CUSTOM_DIR)) {
            if (f.startsWith(type + '-bg.')) {
                try { fs.unlinkSync(path.join(CUSTOM_DIR, f)); } catch (e) { /* 忽略 */ }
            }
        }
    } catch (e) { /* 目录不存在等，忽略 */ }
}

// 上传背景图（base64 data URL，同 upload-poster 的方式，免 multipart 依赖）
router.post('/wallpaper', (req, res) => {
    try {
        const { type, imageData } = req.body || {};
        if (!TYPES.includes(type)) return res.json({ code: -1, msg: '类型错误，只支持 page/banner' });
        const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/.exec(String(imageData || ''));
        if (!m) return res.json({ code: -1, msg: '图片格式不正确，需要 base64 data URL' });
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const buf = Buffer.from(m[2], 'base64');
        if (!buf.length) return res.json({ code: -1, msg: '图片数据为空' });
        if (buf.length > MAX_SIZE) return res.json({ code: -1, msg: '图片不能超过 12MB' });

        ensureDir();
        removeOld(type);
        const name = `${type}-bg.${ext}`;
        fs.writeFileSync(path.join(CUSTOM_DIR, name), buf);
        res.json({ code: 0, url: `/custom/${name}?v=${Date.now()}` });
    } catch (err) {
        console.error('[背景图上传失败]', err);
        res.json({ code: -1, msg: '上传失败：' + err.message });
    }
});

// 清除背景图
router.delete('/wallpaper/:type', (req, res) => {
    const { type } = req.params;
    if (!TYPES.includes(type)) return res.json({ code: -1, msg: '类型错误' });
    removeOld(type);
    res.json({ code: 0 });
});

module.exports = router;
