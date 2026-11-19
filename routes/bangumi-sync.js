// ================================================================
// routes/bangumi-sync.js —— round173e Bangumi 云同步接口
//   GET  /api/bangumi/status          连接状态
//   GET  /api/bangumi/me              验证 token，返回 Bangumi 用户信息
//   POST /api/bangumi/credentials     保存 OAuth client id/secret
//   POST /api/bangumi/token           手动填 access token（零门槛降级）
//   GET  /api/bangumi/authorize       生成授权 URL（返回 url 供前端打开）
//   GET  /api/bangumi/callback        OAuth 回调（Bangumi 302 回这里）
//   POST /api/bangumi/disconnect      断开（清 token）
//   POST /api/bangumi/pull            Bangumi → 本地
//   POST /api/bangumi/push            本地 → Bangumi
//   POST /api/bangumi/sync            双向
//   ★ 必须挂在整站反代（app.use('/', webviewProxy)）之前
// ================================================================

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const oauth = require('../utils/bangumi-oauth');
const sync = require('../utils/bangumi-sync');

const pendingStates = new Map();

router.get('/status', (req, res) => {
    try {
        const creds = oauth.getCredentials();
        const token = oauth.getToken();
        res.json({
            code: 0,
            data: {
                connected: !!token,
                hasToken: !!token,
                oauthConfigured: !!(creds.clientId && creds.clientSecret),
                clientId: creds.clientId ? creds.clientId.slice(0, 6) + '***' : '',
                mode: creds.clientId && creds.clientSecret ? 'oauth' : (token ? 'manual' : 'none'),
            }
        });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/me', async (req, res) => {
    try {
        if (!oauth.getToken()) return res.json({ code: -1, msg: '未连接 Bangumi' });
        const me = await oauth.me();
        res.json({ code: 0, data: { id: me.id, username: me.username, nickname: me.nickname, avatar: me.avatar && me.avatar.large } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/credentials', (req, res) => {
    try {
        oauth.saveCredentials(req.body.clientId, req.body.clientSecret);
        res.json({ code: 0, data: { saved: true } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/token', (req, res) => {
    try {
        const token = String(req.body.token || '').trim();
        if (!token) return res.json({ code: -1, msg: 'token 不能为空' });
        oauth.saveToken(token);
        res.json({ code: 0, data: { saved: true } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/authorize', (req, res) => {
    try {
        const creds = oauth.getCredentials();
        if (!creds.clientId) return res.json({ code: -1, msg: '请先保存 Bangumi Client ID / Secret' });
        const proto = req.protocol || 'http';
        const host = req.headers.host || '127.0.0.1:3517';
        const redirectUri = `${proto}://${host}/api/bangumi/callback`;
        const state = crypto.randomBytes(8).toString('hex');
        pendingStates.set(state, { ts: Date.now() });
        for (const [k, v] of pendingStates) if (Date.now() - v.ts > 10 * 60 * 1000) pendingStates.delete(k);
        res.json({ code: 0, data: { url: oauth.buildAuthorizeUrl(redirectUri, state), redirectUri, state } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    const html = (ok, title, msg) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;background:#f5f2ea;color:#333}
.box{max-width:460px;padding:38px 42px;border-radius:16px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.12);text-align:center}
h1{font-size:20px;margin:0 0 12px}p{font-size:14px;color:#666;line-height:1.8}a{color:#C08A2D}</style></head>
<body><div class="box"><h1>${ok ? '✅' : '❌'} ${title}</h1><p>${msg}</p>
<p style="margin-top:18px;font-size:13px;">完成后可关闭窗口，回到应用查看同步状态。</p></div>
${ok ? '<script>setTimeout(function(){try{window.close()}catch(e){}},2500)</script>' : ''}</body></html>`;
    try {
        if (error) return res.send(html(false, '授权被取消', (error_description || error) + '。'));
        if (!state || !pendingStates.has(state)) return res.send(html(false, 'state 校验失败', '回调与会话不匹配，请重新点授权。'));
        pendingStates.delete(state);
        if (!code) return res.send(html(false, '缺少授权码', '回调里没有 code。'));
        const proto = req.protocol || 'http';
        const host = req.headers.host || '127.0.0.1:3517';
        const redirectUri = `${proto}://${host}/api/bangumi/callback`;
        await oauth.exchangeCode(code, redirectUri);
        res.send(html(true, 'Bangumi 已连接', '授权成功，回到应用即可同步追番进度。'));
    } catch (e) {
        res.send(html(false, '授权失败', String(e.message)));
    }
});

router.post('/disconnect', (req, res) => {
    try { oauth.clearToken(); res.json({ code: 0, data: { disconnected: true } }); }
    catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/pull', async (req, res) => {
    try { res.json({ code: 0, data: await sync.pull({ createMissing: req.body.createMissing !== false }) }); }
    catch (e) { res.json({ code: -1, msg: e.message }); }
});
router.post('/push', async (req, res) => {
    try { res.json({ code: 0, data: await sync.push({ delayMs: 300 }) }); }
    catch (e) { res.json({ code: -1, msg: e.message }); }
});
router.post('/sync', async (req, res) => {
    try { res.json({ code: 0, data: await sync.sync({ delayMs: 300, strategy: req.body && req.body.strategy }) }); }
    catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
