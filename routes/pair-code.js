/**
 * routes/pair-code.js — 电脑端签发一次性配对码
 *
 * POST /api/app/pair-code
 *   - 访问密码开启时：必须是已登录的电脑端会话；
 *   - 未开启时：返回 pairCode:null，手机拿纯 URL 就能连。
 * 该路由挂在 /api/app 下，本身处于免登录前缀，所以在这里自行校验会话。
 */
const express = require('express');
const {
    COOKIE_NAME,
    validateSession,
    isAuthEnabled
} = require('../utils/auth');
const { issuePairCode } = require('../utils/pair-store');

const router = express.Router();

router.post('/pair-code', (req, res) => {
    try {
        if (!isAuthEnabled()) {
            return res.json({ code: 0, data: { pairCode: null, required: false, expiresIn: 0 } });
        }
        const session = req.cookies && req.cookies[COOKIE_NAME];
        if (!validateSession(session)) {
            return res.status(401).json({ code: -1, msg: '请先在电脑端登录，再生成配对二维码' });
        }
        const issued = issuePairCode();
        res.json({
            code: 0,
            data: { pairCode: issued.pairCode, required: true, expiresIn: issued.expiresIn }
        });
    } catch (e) {
        res.status(500).json({ code: -1, msg: e.message });
    }
});

module.exports = router;
