/* 更新重启闭环回归：下载幂等 / 安装退出信号 / 前端按钮状态 / 轮询终态。静态检查，不触网。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

const updater = fs.readFileSync(path.join(root, 'utils/updater.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'routes/update.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'packaging/main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

// 1) startDownload 幂等：done 且文件存在时复用，不重复整包下载
assert.ok(updater.includes("(!assetName || assetName === downloadState.assetName)"),
    'startDownload 应有同包复用判断');
assert.ok(updater.includes('reused: true'), '复用时应返回 reused 标记');

// 2) 安装退出信号：路由写 quit-for-install.json，主进程检查并 app.exit
assert.ok(route.includes("'quit-for-install.json'"), 'install 路由应写退出信号');
assert.ok(route.includes("r.mode === 'launch'"), '仅安装程序模式写信号');
assert.ok(main.includes("'quit-for-install.json'"), '主进程应检查退出信号');
assert.ok(main.includes('app.exit(0)'), '主进程应主动退出释放文件占用');

// 3) 前端按钮状态：下载中/完成禁用下载按钮，done 启用安装按钮
assert.ok(app.includes('function setUpdBtnsState'), '应有按钮状态管理函数');
assert.ok(app.includes('dlBtns.forEach(b => { b.disabled = busy || done; })'),
    '下载中/完成应禁用下载按钮');
assert.ok(app.includes('instBtn.disabled = !done'), '仅 done 时启用安装按钮');

// 4) 增量轮询：done/ready 等终态都停止轮询，避免空转
assert.ok(app.includes("|| dl.state === 'incremental-ready';"), '轮询应识别 ready 终态');
assert.ok(app.includes('if (terminal) { stopIncPolling(); return; }'), '终态应停轮询');

// 5) NSIS 配置确保安装后自动启动新版
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packaging/package.json'), 'utf8'));
assert.equal(pkg.build.nsis.runAfterFinish, true, 'NSIS 应配置安装后运行新版');

console.log('PASS 更新重启闭环：下载幂等 / 退出信号 / 按钮状态 / 轮询终态');
