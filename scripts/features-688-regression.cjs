/* 6.8.8 改进回归：搜索分类映射 / AI行为学习开关 / browse聚合 / 响应式CSS；不联网。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// 1) 搜索分类：app.js 的 viewType 映射包含各库，且首页不带 type
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
for (const v of ['jav:', 'anime:', 'comic:', 'novel:']) assert.ok(app.includes(v), '搜索映射应含 ' + v);
assert.ok(app.includes("params.set('type', viewType)"), '搜索应按视图带 type');
assert.ok(app.includes('scopeLabels[searchViewAtQuery]'), '结果应标注搜索范围');

// 2) AI 行为学习：后端开关字段 + 提炼函数 + 前端开关/按钮
const mem = require(path.join(root, 'utils', 'ai-memory.js'));
const s = mem.getMemorySettings();
assert.equal(typeof s.learnFromBehavior, 'boolean', '设置应含 learnFromBehavior');
assert.equal(typeof mem.learnFromBehavior, 'function', '应导出 learnFromBehavior');
const aiRoute = fs.readFileSync(path.join(root, 'routes', 'ai.js'), 'utf8');
assert.ok(aiRoute.includes("router.post('/learn-behavior'"), '应有手动提炼端点');
assert.ok(app.includes('memLearnFromBehavior'), '前端应有学习开关');
assert.ok(app.includes('learnBehaviorNow()'), '前端应有学习按钮');

// 3) browse 聚合：函数存在、结构合理（不实际打站，仅验证接口）
const browse = require(path.join(root, 'utils', 'media-sources', 'browse.js'));
assert.equal(typeof browse.browseLatest, 'function');
const msRoute = fs.readFileSync(path.join(root, 'routes', 'media-source.js'), 'utf8');
assert.ok(msRoute.includes("router.get('/browse'"), '应有 browse 端点');

// 4) 响应式 CSS：两处限宽已解除
const style = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const rh = fs.readFileSync(path.join(root, 'public', 'css', 'round160-read-hub.css'), 'utf8');
assert.ok(style.includes('.panel-section.ms-full { max-width: none; }'), 'ms-full 应解除 980px');
assert.ok(/max-width:\s*none/.test(rh.slice(rh.indexOf('.rh-shell'), rh.indexOf('.rh-shell') + 200)), 'rh-shell 应解除限宽');
assert.ok(fs.existsSync(path.join(root, 'public', 'css', 'online-browse.css')), '在线卡片区 CSS 应存在');

console.log('PASS 6.8.8 搜索分类、AI行为学习、browse聚合、响应式CSS');
