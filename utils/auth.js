/**
 * 服务端会话鉴权
 *
 * 此前的"密码保护"只是前端 cookie 摆设（isLogin=true 控制台可伪造），
 * 所有 /api/* 完全裸奔。这里改为服务端签发 httpOnly 会话 token：
 *   - 登录成功 → 签发随机 token，内存保存 30 天
 *   - 后续请求凭 cookie lml_session 校验
 *
 * ★ 访问密码是「可选」的（config.auth.enabled）：
 *   - enabled=false             → 本模块整体放行，进入影库不需要密码
 *   - enabled=true + password   → 全站（影片/动漫/漫画/小说）都要先登录
 * 未写 enabled 的老配置按「有 password 就启用」兼容，行为与改动前一致。
 *
 * 为什么必须做成「要么全要密码、要么全不要」：
 * 之前是影片/动漫要登录、漫画/小说免密。结果从免密入口进来时，
 * 页面本身放行了、但 /api/* 全返 401 —— 界面是「半死」的：
 * 左侧计数全是 0，点「设置」更是一片空白（设置页要 /api/config）。
 * 见 docs/reports/round22-需求达成报告.md。
 */
const crypto = require('crypto');
const config = require('./config');

const COOKIE_NAME = 'lml_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

const sessions = new Map(); // token -> { createdAt, expiresAt }

function defaultPassword() {
    return (config.auth && config.auth.password) || 'admin123';
}

/**
 * 是否启用访问密码。
 * enabled 是显式布尔时以它为准（且必须有密码才有意义）；
 * 老配置没有 enabled 字段 → 退化成「有密码即启用」。
 */
function isAuthEnabled() {
    const a = config.auth || {};
    if (typeof a.enabled === 'boolean') return a.enabled === true && !!a.password;
    return !!a.password;
}

/** 兼容旧调用方：语义等同于「当前是否需要登录」 */
function isAuthConfigured() {
    return isAuthEnabled();
}

function checkPassword(input) {
    if (!input) return false;
    if (!isAuthEnabled()) return false;   // 没启用密码时，登录接口不认任何输入
    const expected = defaultPassword();
    const a = Buffer.from(String(input));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
    return token;
}

function destroySession(token) {
    if (token) sessions.delete(token);
}

function validateSession(token) {
    if (!token) return false;
    const s = sessions.get(token);
    if (!s) return false;
    if (Date.now() > s.expiresAt) {
        sessions.delete(token);
        return false;
    }
    return true;
}

// 定期清理过期会话
setInterval(() => {
    const now = Date.now();
    for (const [token, s] of sessions) {
        if (now > s.expiresAt) sessions.delete(token);
    }
}, 60 * 60 * 1000).unref();

/** Express 中间件：校验 lml_session cookie（未启用访问密码时一律放行） */
function sessionMiddleware(req, res, next) {
    if (!isAuthEnabled()) return next();
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (validateSession(token)) return next();
    res.status(401).json({ code: -1, msg: '未登录或会话已过期' });
}

module.exports = {
    COOKIE_NAME,
    SESSION_TTL,
    checkPassword,
    createSession,
    destroySession,
    validateSession,
    sessionMiddleware,
    isAuthEnabled,
    isAuthConfigured
};
