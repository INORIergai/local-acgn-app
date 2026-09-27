const express = require('express');
const router = express.Router();
const {
    COOKIE_NAME,
    SESSION_TTL,
    checkPassword,
    createSession,
    destroySession,
    validateSession,
    isAuthEnabled,
    isAuthConfigured
} = require('../utils/auth');
const config = require('../utils/config');

/** 把当前访问密码设置写回 config.json，并同步运行时内存对象（立即生效，不用重启） */
function persistAuth(patch) {
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(config.configPath, 'utf8'));
    cfg.auth = Object.assign({}, cfg.auth, patch);
    fs.writeFileSync(config.configPath, JSON.stringify(cfg, null, 4), 'utf8');
    config.auth = cfg.auth;
    return cfg.auth;
}

/** 调用者是否有权改「访问密码」设置：已登录，或当前压根没启用密码（此时本就全开放） */
function canManageAuth(req) {
    if (!isAuthEnabled()) return true;
    return validateSession(req.cookies && req.cookies[COOKIE_NAME]);
}

// 登录
router.post('/login', (req, res) => {
    if (!isAuthEnabled()) {
        return res.json({ code: 0, msg: '未启用访问密码，无需登录' });
    }
    const { password } = req.body || {};
    if (!checkPassword(password)) {
        return res.status(401).json({ code: -1, msg: '密码错误' });
    }
    const token = createSession();
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL
    });
    res.json({ code: 0, msg: '登录成功' });
});

// 登出
router.post('/logout', (req, res) => {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    destroySession(token);
    res.clearCookie(COOKIE_NAME);
    res.json({ code: 0, msg: '已退出登录' });
});

/**
 * 访问密码设置（设置页「🔒 访问密码」用这个）
 *
 *   { enabled: false }                              → 关闭密码，全站免密
 *   { enabled: true, password: 'xxxx' }             → 开启 / 修改密码
 *   { enabled: true } 或 { enabled: true, password: '' }
 *                                                   → 已启用时只保证启用，不改密码
 *
 * 关闭时会把明文 password 一并清空，不在磁盘上留残留。
 *
 * ★ 二次确认：当前已启用密码时，改动（换密码 / 关密码）都必须带上
 *   currentPassword 并校验通过。「已登录」只证明能进来，不证明是本人 ——
 *   手机端登录后随手放桌上，别人就能把密码直接关掉。
 */
router.post('/access', (req, res) => {
    try {
        if (!canManageAuth(req)) {
            return res.status(401).json({ code: -1, msg: '请先登录后再修改访问密码' });
        }
        const { enabled, password, currentPassword } = req.body || {};

        if (isAuthEnabled() && !checkPassword(currentPassword)) {
            return res.status(403).json({ code: -1, msg: '当前密码不正确' });
        }

        if (enabled === false) {
            persistAuth({ enabled: false, password: '' });
            return res.json({ code: 0, msg: '已关闭访问密码，现在进入影库无需密码', enabled: false });
        }

        const next = password === undefined ? '' : String(password).trim();
        if (next) {
            if (next.length < 4) return res.json({ code: -1, msg: '密码至少 4 位' });
            persistAuth({ enabled: true, password: next });
            /* 开启密码的同时把「当前这个请求」登录上。
             * 不然会有一个很别扭的瞬间：用户刚在设置页打开密码并保存，
             * 本页还没有会话 → 紧接着任何 /api/* 都 401 → 设置页当场变成
             * 「加载失败」。而这个动作本身已经证明调用者有权限
             * （免密状态下本来就全开放；已启用状态下必须已登录才走得到这里）。 */
            if (!validateSession(req.cookies && req.cookies[COOKIE_NAME])) {
                res.cookie(COOKIE_NAME, createSession(), {
                    httpOnly: true,
                    sameSite: 'lax',
                    maxAge: SESSION_TTL
                });
            }
            return res.json({ code: 0, msg: '访问密码已更新', enabled: true });
        }

        // 没传新密码：当前已有密码就只是保持启用，否则提示必须设一个
        if (!config.auth || !config.auth.password) {
            return res.json({ code: -1, msg: '请设置一个密码' });
        }
        persistAuth({ enabled: true });
        res.json({ code: 0, msg: '访问密码已启用', enabled: true });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 修改密码（旧接口，保留兼容：等价于 access 的「开启并改密」）
router.post('/change-password', (req, res) => {
    try {
        if (!canManageAuth(req)) {
            return res.status(401).json({ code: -1, msg: '请先登录后再修改密码' });
        }
        const { oldPassword, newPassword } = req.body || {};
        if (isAuthEnabled() && !checkPassword(oldPassword)) {
            return res.status(403).json({ code: -1, msg: '当前密码不正确' });
        }
        if (!newPassword || String(newPassword).length < 4) {
            return res.json({ code: -1, msg: '新密码至少4位' });
        }
        persistAuth({ enabled: true, password: String(newPassword) });
        res.json({ code: 0, msg: '密码已修改' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 会话状态（免鉴权，登录页与前端都要用它判断要不要拦）
router.get('/status', (req, res) => {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    const enabled = isAuthEnabled();
    res.json({
        code: 0,
        data: {
            authEnabled: enabled,
            loggedIn: enabled ? validateSession(token) : true,
            passwordIsDefault: enabled ? config.auth.password === 'admin123' : false
        }
    });
});

module.exports = router;
