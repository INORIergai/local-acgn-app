/**
 * routes/pair-claim.js — 手机用配对码兑换会话
 *
 * POST /api/app/pair  { pairCode }
 *   - 已启用访问密码：校验配对码（120s、单次），签发 lml_session cookie；
 *   - 未启用：直接返回 paired:false / auth_disabled，手机走普通连接。
 * 二维码里不出现访问密码；配对码由电脑端已登录会话签发。
 */
const express = require('express');
const {
    COOKIE_NAME,
    SESSION_TTL,
    createSession,
    isAuthEnabled
} = require('../utils/auth');
const { consumePairCode } = require('../utils/pair-store');

const router = express.Router();

router.post('/pair', (req, res) => {
    try {
        if (!isAuthEnabled()) {
            return res.json({ code: 0, data: { paired: false, reason: 'auth_disabled' } });
        }
        const pairCode = String((req.body && req.body.pairCode) || '');
        if (!consumePairCode(pairCode)) {
            return res.status(401).json({ code: -1, msg: '配对码已失效，请在电脑上刷新后重试' });
        }
        const session = createSession();
        // 会话值由服务端生成；直接写 Set-Cookie，不依赖 res.cookie 的隐式行为
        const cookie = `${COOKIE_NAME}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`;
        res.setHeader('Set-Cookie', cookie);
        res.json({ code: 0, data: { paired: true } });
    } catch (e) {
        res.status(500).json({ code: -1, msg: e.message });
    }
});

module.exports = router;
