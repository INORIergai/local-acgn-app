/* 第二批回归：123云盘 app 模式后台自动续期 + 授权 UI 推荐路径。静态检查，不触网、不读真实凭据。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

const oauth = fs.readFileSync(path.join(root, 'routes/cloud-oauth.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

// 1) 后端 scheduler 有 token 自动保活逻辑
assert.ok(oauth.includes('token 自动保活'), 'scheduler 应含 token 保活逻辑');
assert.ok(oauth.includes("sec.authMode === 'app'"), '保活仅对 app 模式生效');
assert.ok(oauth.includes('await refreshToken(p)'), '保活应调用现成 refreshToken');
assert.ok(oauth.includes('6 * 60 * 60 * 1000'), '应提前 6 小时续期');
assert.ok(oauth.includes('!sec.refreshToken'), '无 refreshToken 应跳过');

// 2) refreshToken 仍只从服务端凭证读，不硬编码（安全）
assert.ok(oauth.includes("sec.clientSecret"), '续期用配置里的 client_secret');
assert.ok(!/client_secret:\s*['"][A-Za-z0-9]{8,}/.test(oauth), '不应硬编码 client_secret 字面量');

// 3) 前端 UI：app 模式为推荐、默认展开；快速授权降级为临时
assert.ok(app.includes('自建应用授权（自动续期，永久免登录）'), '应有推荐的自建应用授权块');
assert.ok(app.includes('<details open'), '推荐块应默认展开');
assert.ok(app.includes('临时授权（免注册开发者'), '快速授权应标为临时');
assert.ok(app.includes('后台自动续期'), '应说明后台自动续期');
assert.ok(app.includes('无需复制'), '应说明无需复制');

// 4) 无重复 DOM id（避免状态回填错乱）
for (const id of ['pan123ClientId', 'pan123ClientSecret', 'pan123Redirect', 'pan123AppStatus', 'pan123ManualCode', 'pan123QuickToken']) {
    const n = (app.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    assert.equal(n, 1, 'DOM id 应唯一: ' + id);
}

// 5) 关键授权端点/函数仍在
for (const fn of ['router.get(\'/authorize/:provider\'', 'router.get(\'/callback/:provider\'', 'router.post(\'/credentials/:provider\'']) {
    assert.ok(oauth.includes(fn), '后端端点应存在: ' + fn);
}
for (const fn of ['function oauthAuthorize', 'function oauthSaveCreds', 'function oauthManualCallback']) {
    assert.ok(app.includes(fn), '前端函数应存在: ' + fn);
}

console.log('PASS 123云盘授权自动化：后台自动续期 + UI 推荐路径 + 无重复 id');
