/**
 * 个性化定制接口（2026-09-22）
 * 背景图（主页 / banner）上传与清除，文件落盘 data/custom/，
 * 由 server.js 挂 /custom 静态服务对外访问。
 */
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');

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

/* ==========================================================================
 * 动画自定义（round38）：启动动画 / AI 对话框待机动画 / AI 输入框输入动画
 * 文件落盘 data/custom/anim-<type>.<ext>，由 server.js 挂的 /custom 静态服务访问。
 * 默认素材在 public/media/animations/（startup.mp4 / idle.webp / typing.webp），
 * 前端优先用这里的自定义文件，没有就回退默认。
 * ========================================================================== */
const ANIM_TYPES = ['startup', 'idle', 'typing', 'idleScreen', 'loader'];   // loader：round58 全局耗时任务加载动画
const ANIM_MAX_SIZE = 36 * 1024 * 1024; // 36MB（express.json limit 50mb，base64 膨胀 4/3 后的上限）
// 允许的类型：视频直接播；图片（gif/webp/png 动图）按 <img> 播
const ANIM_MIME_EXT = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'image/gif': 'gif',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/apng': 'apng',
};

function findAnimFile(type) {
    try {
        for (const f of fs.readdirSync(CUSTOM_DIR)) {
            if (f.startsWith('anim-' + type + '.')) return f;
        }
    } catch (e) { /* 目录不存在等，忽略 */ }
    return null;
}

function removeAnim(type) {
    const f = findAnimFile(type);
    if (f) { try { fs.unlinkSync(path.join(CUSTOM_DIR, f)); } catch (e) { /* 忽略 */ } }
}

// 查询三 类动画的自定义状态（前端据此决定用自定义还是默认素材）
router.get('/animation', (req, res) => {
    const data = {};
    for (const t of ANIM_TYPES) {
        const f = findAnimFile(t);
        data[t] = f ? { custom: true, url: '/custom/' + f + '?v=' + Date.now() } : { custom: false };
    }
    // round39：启动动画开关在服务端 config —— EXE 主进程要在建窗前读它
    data.splashOff = !!(config.animations && config.animations.splashOff);
    data.idleScreenOff = !!(config.animations && config.animations.idleScreenOff);
    // round49：UI_anime 动效库已适配特效的开关状态（如 {notify:true, parallax:false}）
    data.effects = (config.animations && config.animations.effects) || {};
    res.json({ code: 0, data });
});

// 启动动画开关（round39）：persist 到 config.json animations.splashOff，立即生效
router.post('/animation/settings', (req, res) => {
    try {
        const { splashOff, idleScreenOff, effects } = req.body || {};
        const cfg = JSON.parse(fs.readFileSync(config.configPath, 'utf8'));
        const patch = {};
        if (splashOff !== undefined) patch.splashOff = !!splashOff;
        if (idleScreenOff !== undefined) patch.idleScreenOff = !!idleScreenOff;
        if (effects && typeof effects === 'object' && !Array.isArray(effects)) patch.effects = effects;   // round49
        cfg.animations = Object.assign({}, cfg.animations, patch);
        fs.writeFileSync(config.configPath, JSON.stringify(cfg, null, 4), 'utf8');
        config.animations = cfg.animations;
        res.json({ code: 0, splashOff: !!splashOff, effects: (config.animations && config.animations.effects) || {} });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 上传自定义动画（base64 data URL，同背景图方式）
router.post('/animation', (req, res) => {
    try {
        const { type, fileData } = req.body || {};
        if (!ANIM_TYPES.includes(type)) return res.json({ code: -1, msg: '类型错误，不支持该动画类型' });
        const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/.exec(String(fileData || ''));
        if (!m) return res.json({ code: -1, msg: '格式不正确，需要 base64 data URL' });
        const mime = m[1].toLowerCase();
        const ext = ANIM_MIME_EXT[mime];
        if (!ext) return res.json({ code: -1, msg: '只支持 mp4 / webm / mov 视频，或 gif / png / webp 动图' });
        const buf = Buffer.from(m[2], 'base64');
        if (!buf.length) return res.json({ code: -1, msg: '文件数据为空' });
        if (buf.length > ANIM_MAX_SIZE) return res.json({ code: -1, msg: '文件不能超过 36MB' });

        ensureDir();
        removeAnim(type);

        // round58：加载动画上传后端自动处理逻辑（智能背景抠像 + 居中缩放 + 转为高质量透明 WebP 动图）
        if (type === 'loader') {
            const rawPath = path.join(CUSTOM_DIR, `anim-loader-raw.${ext}`);
            fs.writeFileSync(rawPath, buf);
            const scriptPath = path.join(__dirname, '..', 'utils', 'loader-preprocessor.py');
            const { execSync } = require('child_process');

            try {
                execSync(`python "${scriptPath}" "${rawPath}" "${CUSTOM_DIR}"`, { timeout: 45000 });
                try { fs.unlinkSync(rawPath); } catch (e) {}

                const outWebp = path.join(CUSTOM_DIR, 'anim-loader.webp');
                const targetWebp = path.join(__dirname, '..', 'public', 'img', 'extras', 'walk-character.webp');
                const targetWebm = path.join(__dirname, '..', 'public', 'img', 'extras', 'walk-reel.webm');

                if (fs.existsSync(outWebp)) {
                    try { fs.copyFileSync(outWebp, targetWebp); } catch (e) {}
                    try { fs.copyFileSync(outWebp, targetWebm); } catch (e) {}
                    return res.json({ code: 0, url: `/custom/anim-loader.webp?v=${Date.now()}` });
                }
            } catch (e) {
                console.warn('[Loader 自动处理报错]', e.message);
            }

            // 兜底降级
            const fallbackName = `anim-loader.${ext}`;
            fs.writeFileSync(path.join(CUSTOM_DIR, fallbackName), buf);
            return res.json({ code: 0, url: `/custom/${fallbackName}?v=${Date.now()}` });
        }

        const name = `anim-${type}.${ext}`;
        fs.writeFileSync(path.join(CUSTOM_DIR, name), buf);
        res.json({ code: 0, url: `/custom/${name}?v=${Date.now()}` });
    } catch (err) {
        console.error('[动画上传失败]', err);
        res.json({ code: -1, msg: '上传失败：' + err.message });
    }
});

// 恢复默认（删除自定义文件）
router.delete('/animation/:type', (req, res) => {
    const { type } = req.params;
    if (!ANIM_TYPES.includes(type)) return res.json({ code: -1, msg: '类型错误' });
    removeAnim(type);

    if (type === 'loader') {
        const defaultChar = path.join(__dirname, '..', 'public', 'img', 'extras', 'walk-character.webm');
        const walkReel = path.join(__dirname, '..', 'public', 'img', 'extras', 'walk-reel.webm');
        try {
            if (fs.existsSync(defaultChar)) fs.copyFileSync(defaultChar, walkReel);
        } catch (e) {}
    }

    res.json({ code: 0 });
});

module.exports = router;
