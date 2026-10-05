/**
 * round74 · TTS 公共进程 / 端口管理
 *
 * 为什么单独抽出来：GPT-SoVITS 要起一个 HTTP 服务（有端口、会撞车、会有僵尸残留），
 * VITS 虽然无端口但同样要 spawn/杀 Python 进程。两者共用同一套「起进程、探活、
 * 查占用、顺延端口、净化环境」的底座，避免两份实现各自踩坑。
 *
 * ⚠️ 本文件里所有的 Windows 细节都是从 Alife 的实战教训来的：
 *   - PATH 污染会让 torchaudio 报 Errno 22（必须净化，见 cleanEnvPath）
 *   - 端口被 Hyper-V/WSL 保留时 netstat 看不到占用，但 bind 就是失败
 *     （必须真的 try-bind 才能发现，见 isBindable）
 *   - 端口占用后「等 2 秒再重连」是拍脑袋没用（Alife 注释原话），必须换端口
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

/* ---------------- 端口探测 ---------------- */

/** 该端口是否有 LISTENING 监听 */
function isPortListening(port, host = '127.0.0.1', timeout = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (e) { } resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
  });
}

/**
 * 这个端口能不能被 bind。
 * ★ 关键：Hyper-V / WSL 的「保留端口」用 netstat 查不到任何占用，但 bind 会失败
 *   （WinError 10013）。所以判断端口可用**必须真的去 bind 一下**，不能只看 netstat。
 */
function isBindable(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const fin = (v, err) => {
      if (done) return;
      done = true;
      try { srv.close(); } catch (e) { }
      resolve(err ? { ok: false, code: err.code || '' } : { ok: true, code: '' });
    };
    srv.once('error', e => fin(false, e));
    srv.once('listening', () => fin(true, null));
    srv.listen({ port, host, exclusive: true });
    setTimeout(() => { try { srv.close(); } catch (e) { } }, timeout);
  });
}

/** 查端口占用进程的 { pid, name, exe }（拿不到返回 null） */
function getPortOwner(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split(/\r?\n/).find(l =>
        new RegExp('^\\s*TCP\\s+\\S+:' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$', 'i').test(l));
      if (!line) return resolve(null);
      const m = line.match(/LISTENING\s+(\d+)/i);
      if (!m) return resolve(null);
      const pid = parseInt(m[1], 10);
      if (!Number.isFinite(pid) || pid <= 0) return resolve({ pid: 0, name: '?', exe: '' });
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true },
        (e2, so2) => {
          const first = String(so2 || '').split(/\r?\n/)[0] || '';
          const cells = first.split('","').map(s => s.replace(/^"|"$/g, ''));
          resolve({ pid, name: cells[0] || '?', exe: cells[1] || '' });
        });
    });
  });
}

/** 杀进程（只杀自己确认过的；不传 pid 时什么都不做） */
function killProcess(pid, { force = true } = {}) {
  const p = parseInt(pid, 10);
  if (!Number.isFinite(p) || p <= 0) return Promise.resolve({ ok: false, reason: 'pid 非法' });
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(p), force ? '/F' : '/T'], { timeout: 8000, windowsHide: true },
      (err, so) => resolve({ ok: !err, out: String(so || '').trim() }));
  });
}

/**
 * 从 start 起找一个「可 bind」的端口。
 * @param {number} start
 * @param {number} end
 * @param {(port:number)=>Promise<boolean>} [isBusy] 可选的额外占用判定（如该端口上跑着别的东西）
 */
async function findFreePort(start, end = 9999, isBusy) {
  for (let p = start; p <= end; p++) {
    if (isBusy && await isBusy(p)) continue;
    const r = await isBindable(p);
    if (r.ok) return { port: p, reason: '' };
    // 记下原因，供诊断报告用
    if (r.code === 'EACCES' || r.code === 'EADDRINUSE') continue;
  }
  return { port: 0, reason: `${start}~${end} 范围内没有可用端口` };
}

/* ---------------- 环境净化 ---------------- */

/**
 * 净化 PATH。
 * ★ 这条是 Alife 用实测换来的：宿主进程（Electron）的 PATH 里可能含其他 Python 的
 *   Scripts/DLL 目录，会污染 GPT-SoVITS 自带的 Python 运行时，
 *   表现为 torchaudio 读到错误的 libsndfile → "Errno 22 Invalid argument"，
 *   而手动开一个干净终端启动却完全正常。
 * 这里不依赖 .NET 的 EnvironmentVariableTarget，改为**剔除已知污染模式**：
 *   路径里同时含 "python" 且含 "Scripts"，基本就是别的 Python 的 Scripts 目录。
 *
 * @param {string[]} keep 需要优先保留的目录（如整合包自身的 runtime）
 * @param {NodeJS.ProcessEnv} [base] 基础环境
 */
function cleanEnvPath(keep = [], base = process.env) {
  const raw = base.PATH || base.Path || '';
  const parts = raw.split(';').map(s => s.trim()).filter(Boolean);
  const kept = keep.filter(Boolean);
  const isForeignPythonScripts = (p) =>
    /python/i.test(p) && /scripts/i.test(p) && !kept.some(k => p.toLowerCase().startsWith(k.toLowerCase()));
  const rest = parts.filter(p => !isForeignPythonScripts(p));
  return kept.concat(rest.filter(p => !kept.includes(p))).join(';');
}

/**
 * 构造给子进程用的干净环境
 * @param {string} [pythonPath] 即将 spawn 的解释器 —— **它的 Scripts 目录必须保留**。
 *   实测踩过：净化规则会把「含 python 且含 scripts」的路径全剔掉，
 *   连我们正要用的这个 Python 自己的 Scripts 也被误伤，torch 直接 import 失败。
 *   所以这里把目标解释器的 Scripts 显式加进 keep，不参与剔除。
 * @param {string[]} [extraPath] 其它需要优先保留的目录（如整合包自身 runtime）
 */
function buildChildEnv(pythonPath, extraPath = [], base = process.env) {
  const env = { ...base };
  const keep = [];
  if (pythonPath) {
    const root = path.dirname(pythonPath);
    keep.push(root, path.join(root, 'Scripts'), path.join(root, 'DLLs'), path.join(root, 'Lib'));
  }
  keep.push(...extraPath);
  env.PATH = cleanEnvPath(keep.filter(Boolean), base);
  env.Path = env.PATH;                       // Windows 上大小写两个键都写
  // ★ Python 管道通信的三个必需变量，少一个就会乱码/缓冲/同步问题
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.PYTHONUNBUFFERED = '1';
  return env;
}

/* ---------------- 进程管理 ---------------- */

/**
 * 启动一个可管理的常驻子进程（带自动退出回收）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, name?:string, idleExitMs?:number}} opt
 * @returns {{proc: import('child_process').ChildProcess, kill: () => void}}
 */
function spawnManaged(cmd, args, opt = {}) {
  const stdio = opt.stdio || ['pipe', 'pipe', 'pipe'];
  const proc = spawn(cmd, args, {
    cwd: opt.cwd,
    env: opt.env || process.env,
    windowsHide: true,
    stdio,
  });
  const state = { name: opt.name || cmd, startedAt: Date.now(), lastOutput: '' };
  proc.__managed = state;
  if (proc.stdout) proc.stdout.on('data', d => { state.lastOutput = (state.lastOutput + d).slice(-4000); });
  if (proc.stderr) proc.stderr.on('data', d => { state.lastOutput = (state.lastOutput + d).slice(-4000); });

  /* ★ 管道型 worker（VITS 的协议就是 stdin 逐行 JSON）：
     如果 stdin 用 'ignore'，Python 侧 `for line in sys.stdin` 立刻拿到 EOF → 进程秒退。
     所以默认必须是 pipe。但 pipe 的 stdin 是活跃句柄，不 unref 会吊住宿主进程退出，
     所以这里立刻 unref —— 只解除「阻止宿主退出」，读写功能不变。 */
  if (proc.stdin) {
    try { proc.stdin.unref(); } catch (e) { }
  }

  let timer = null;
  const reset = () => {
    if (opt.idleExitMs && proc.exitCode === null) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { try { proc.kill(); } catch (e) { } }, opt.idleExitMs);
      if (timer.unref) timer.unref();
    }
  };
  proc.on('data', reset);
  if (proc.stdout) proc.stdout.on('data', reset);
  proc.on('exit', () => { if (timer) clearTimeout(timer); });

  return {
    proc,
    state,
    kill() { if (timer) clearTimeout(timer); try { proc.kill(); } catch (e) { } },
  };
}

/* ---------------- 小工具 ---------------- */

/** 递归找候选目录（用于自动定位 VITS / GPT-SoVITS 安装位置） */
function findDirs(roots, matcher, maxDepth = 4) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= 20) return;
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      if (!it.isDirectory()) continue;
      const full = path.join(dir, it.name);
      if (matcher(full)) out.push(full);
      walk(full, depth + 1);
    }
  };
  for (const r of roots) { try { if (fs.existsSync(r)) walk(r, 0); } catch (e) { } }
  return out;
}

function human(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

module.exports = {
  isPortListening, isBindable, getPortOwner, killProcess, findFreePort,
  cleanEnvPath, buildChildEnv, spawnManaged, findDirs, human,
};
