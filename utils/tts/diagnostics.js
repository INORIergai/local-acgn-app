/**
 * round74 · TTS 一键体检（两个引擎共用）
 *
 * 设计原则：**输出必须是「可执行的结论」，不是一堆布尔值。**
 * 每一项都返回 { level, title, detail, fix: { label, kind, payload } }，
 * 前端据此渲染「✅/⚠️/❌ + 一句话说明 + 一个修复按钮」，而不是让用户看日志猜。
 *
 * level: 'ok' | 'warn' | 'bad'
 * fix.kind: 'setPath' | 'installPkgs' | 'rescan' | 'killPort' | 'switchPort'
 *            | 'retryStart' | 'cleanCache' | 'copyCmd' | 'none'
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./proc');
const player = require('./player');

const VITS_REQUIRED = ['torch', 'numba', 'librosa', 'scipy', 'numpy',
  'pypinyin', 'jieba', 'cn2an', 'Unidecode', 'phonemizer', 'gradio'];

/** 本机已知的好解释器（按优先级；避开 WindowsApps 别名） */
function candidatePythons() {
  const c = [];
  const add = (p) => { if (p && !/WindowsApps/i.test(p) && !c.includes(p)) c.push(p); };
  add('%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python312\\python.exe');
  add('%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python311\\python.exe');
  add('%USERPROFILE%\\AppData\\Local\\Programs\\Python\\Python310\\python.exe');
  // 从 PATH 里找，但排除 WindowsApps
  for (const d of (process.env.PATH || '').split(';')) {
    const p = path.join(d.trim(), 'python.exe');
    if (d.trim() && !/WindowsApps/i.test(d)) add(p);
  }
  return c;
}

/** 跑一段 python 代码，返回 { ok, stdout, stderr }（只读探测，不改环境） */
function runPy(python, code, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(python, ['-c', code], {
      timeout,
      env: P.buildChildEnv(python),
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, so, se) => resolve({ ok: !err, stdout: String(so || ''), stderr: String(se || '') }));
  });
}

/* ---------------- 单项检查 ---------------- */

async function checkPython() {
  const list = candidatePythons();
  for (const p of list) {
    try { if (!fs.existsSync(p)) continue; } catch (e) { continue; }
    const r = await runPy(p, 'import sys;print(sys.version.split()[0])', 8000);
    if (r.ok && r.stdout.trim()) {
      return {
        level: 'ok', title: 'Python 解释器', key: 'python',
        detail: `${p}（Python ${r.stdout.trim()}）`,
        python: p,
        fix: { label: '更换', kind: 'setPath', payload: { field: 'pythonPath' } },
      };
    }
  }
  return {
    level: 'bad', title: 'Python 解释器', key: 'python',
    detail: '未找到可用的 Python 3.10~3.12（VITS 需要 3.12，numba 不支持 3.13）',
    fix: { label: '指定路径', kind: 'setPath', payload: { field: 'pythonPath' } },
  };
}

async function checkVitsDeps(python) {
  if (!python) return { level: 'bad', title: 'VITS 依赖', key: 'vitsDeps', detail: '缺少可用的 Python 解释器，无法检查', fix: { label: '先修 Python', kind: 'none' } };
  const code = `import importlib.util as u,sys
miss=[n for n in ${JSON.stringify(VITS_REQUIRED)} if not (u.find_spec(n) or u.find_spec(n.lower()))]
print("MISS:"+",".join(miss))`;
  const r = await runPy(python, code, 20000);
  if (!r.ok) return { level: 'bad', title: 'VITS 依赖', key: 'vitsDeps', detail: '执行探测失败：' + r.stderr.slice(0, 80), fix: { label: '重试', kind: 'none' } };
  const line = (r.stdout.match(/MISS:(.*)/) || [])[1] || '';
  const miss = line ? line.split(',').filter(Boolean) : [];
  if (!miss.length) {
    return { level: 'ok', title: 'VITS 依赖', key: 'vitsDeps', detail: `${VITS_REQUIRED.length} 个包全部就绪`, fix: { label: '', kind: 'none' } };
  }
  return {
    level: 'warn', title: 'VITS 依赖', key: 'vitsDeps',
    detail: `缺 ${miss.length} 个：${miss.slice(0, 6).join(', ')}`,
    fix: { label: '一键安装', kind: 'installPkgs', payload: { python, pkgs: miss, requirements: path.join(VITS_HINT_DIR, 'requirements.txt') } },
  };
}

let VITS_HINT_DIR = 'D:\\ai program\\Alife_project\\Alife.Client\\VITS';

async function checkGpu(python) {
  if (!python) return { level: 'warn', title: 'GPU', key: 'gpu', detail: '未检测（缺 Python）', fix: { label: '', kind: 'none' } };
  const r = await runPy(python, 'import torch;print(torch.__version__, torch.cuda.is_available())', 25000);
  if (!r.ok) return { level: 'warn', title: 'GPU', key: 'gpu', detail: 'torch 不可用，VITS 会退回 CPU（慢但能用）', fix: { label: '', kind: 'none' } };
  const [ver, cuda] = r.stdout.trim().split(/\s+/);
  return {
    level: cuda === 'True' ? 'ok' : 'warn', title: 'GPU', key: 'gpu',
    detail: cuda === 'True' ? `torch ${ver}，CUDA 可用` : `torch ${ver}，无 CUDA（CPU 合成会慢 10~30 倍）`,
    fix: { label: '', kind: 'none' },
  };
}

/** @returns 字节数（注意名字容易误导，调用处请直接喂给 P.human） */
function dirSize(dir) {
  try {
    let total = 0;
    const walk = (d, depth) => {
      if (depth > 3) return;
      let items = [];
      try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const it of items) {
        const f = path.join(d, it.name);
        if (it.isDirectory()) walk(f, depth + 1);
        else { try { total += fs.statSync(f).size; } catch (e) { } }
      }
    };
    walk(dir, 0);
    return total;
  } catch (e) { return 0; }
}

function checkVitsModel(vitsDir) {
  // round77：目录解析与「代码已内置、权重待下载」的新状态
  const vitsModel = require('./vits-model');
  const dir = vitsModel.resolveDir(vitsDir) || vitsDir || '';
  const need = ['models.py', 'utils.py', 'speakers_list.txt', 'model/config.json'];
  if (!dir || !fs.existsSync(dir)) {
    return {
      level: 'bad', title: 'VITS 模型', key: 'vitsModel',
      detail: '未找到 VITS 目录（需要 models.py / speakers_list.txt / model/config.json）',
      fix: { label: '自动扫描', kind: 'rescan', payload: { field: 'vitsDir' } },
    };
  }
  const missing = need.filter(f => { try { return !fs.existsSync(path.join(dir, f)); } catch (e) { return true; } });
  if (missing.length) {
    return {
      level: 'bad', title: 'VITS 模型', key: 'vitsModel',
      detail: `目录存在但不完整，缺：${missing.join(', ')}`,
      fix: { label: '重新指定', kind: 'setPath', payload: { field: 'vitsDir' } },
    };
  }
  if (!vitsModel.installed()) {
    return {
      level: 'warn', title: 'VITS 权重', key: 'vitsModel',
      detail: '推理代码已内置，权重 ' + vitsModel.MODEL_NAME
        + '（' + P.human(vitsModel.MODEL_BYTES) + '）尚未下载',
      fix: { label: '⬇ 下载权重', kind: 'downloadModel' },
    };
  }
  let voices = 0;
  try { voices = fs.readFileSync(path.join(vitsDir, 'speakers_list.txt'), 'utf8').split(/\r?\n/).filter(Boolean).length; } catch (e) { }
  return {
    level: 'ok', title: 'VITS 模型', key: 'vitsModel',
    detail: `${vitsDir}（${P.human(dirSize(vitsDir))}，${voices} 个音色）`,
    fix: { label: '更换目录', kind: 'setPath', payload: { field: 'vitsDir' } },
  };
}

function checkGptSovitsDir(root) {
  if (!root || !fs.existsSync(root)) {
    return {
      level: 'bad', title: 'GPT-SoVITS 目录', key: 'gptDir',
      detail: '未找到整合包（需要 api_v2.py 与 GPT_SoVITS/configs/tts_infer.yaml）',
      fix: { label: '自动扫描', kind: 'rescan', payload: { field: 'gptSovitsDir' } },
    };
  }
  const need = [
    'api_v2.py',
    'GPT_SoVITS/configs/tts_infer.yaml',
  ];
  const missing = need.filter(f => { try { return !fs.existsSync(path.join(root, f)); } catch (e) { return true; } });
  if (missing.length) {
    return {
      level: 'bad', title: 'GPT-SoVITS 目录', key: 'gptDir',
      detail: `缺：${missing.join(', ')}`,
      fix: { label: '重新指定', kind: 'setPath', payload: { field: 'gptSovitsDir' } },
    };
  }
  // 情绪参考库
  let moods = [];
  try { moods = fs.readdirSync(path.join(root, 'ref')).filter(d => fs.statSync(path.join(root, 'ref', d)).isDirectory()); } catch (e) { }
  return {
    level: 'ok', title: 'GPT-SoVITS 目录', key: 'gptDir',
    detail: `${root}${moods.length ? `（情绪库 ${moods.length} 个：${moods.slice(0, 5).join('/')}…）` : '（未建 ref 情绪库）'}`,
    fix: { label: '更换目录', kind: 'setPath', payload: { field: 'gptSovitsDir' } },
  };
}

/**
 * ★ 端口检查（GPT-SoVITS 专属，也是用户最关心的「端口占用」）
 * 依次判断：正在监听 / 可被我们用 / 是 Hyper-V 保留 / 干脆不可用
 */
async function checkPort(port) {
  const listening = await P.isPortListening(port);
  const owner = listening ? await P.getPortOwner(port) : null;

  // 即使在监听，也先探一下是不是健康的 GPT-SoVITS
  let serviceOk = false, serviceVerdict = '';
  if (listening) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/openapi.json`, { signal: AbortSignal.timeout(3000) });
      const txt = await r.text();
      serviceOk = /\/tts/.test(txt);
      serviceVerdict = serviceOk ? '服务在线且接口正常' : '端口上有服务，但不是 GPT-SoVITS（无 /tts 接口）';
    } catch (e) {
      serviceVerdict = '端口有监听但无响应（僵尸进程？）';
    }
  }

  if (listening && serviceOk) {
    return {
      level: 'ok', title: `端口 ${port}`, key: 'port',
      detail: `服务已就绪${owner ? `（PID ${owner.pid} ${owner.name}）` : ''}`,
      fix: { label: '', kind: 'none' },
    };
  }
  if (listening) {
    return {
      level: 'bad', title: `端口 ${port}`, key: 'port',
      detail: `${owner ? `被 ${owner.name}（PID ${owner.pid}）占用` : '被占用'}，且${serviceVerdict}`,
      fix: {
        label: '结束占用并启动', kind: 'killPort',
        payload: { port, pid: owner ? owner.pid : 0, process: owner ? owner.name : '' },
      },
    };
  }
  const bind = await P.isBindable(port);
  if (bind.ok) {
    return {
      level: 'ok', title: `端口 ${port}`, key: 'port',
      detail: '空闲可用',
      fix: { label: '', kind: 'none' },
    };
  }
  // ★ Hyper-V / WSL 保留端口：netstat 查不到、但 bind 不行
  const isReserved = (bind.code === 'EACCES');
  return {
    level: 'bad', title: `端口 ${port}`, key: 'port',
    detail: isReserved
      ? '被 Windows 保留端口段占用（Hyper-V / WSL / 容器），看不见占用者'
      : '无法绑定（' + bind.code + '）',
    fix: isReserved
      ? {
        label: '换个端口', kind: 'switchPort',
        payload: {
          from: port,
          note: 'netsh interface ipv4 set excludedportrange protocol=tcp startport=' + port + ' numberofports=1 store=persistent',
        },
      }
      : { label: '换个端口', kind: 'switchPort', payload: { from: port } },
  };
}

/**
 * round74b 修复：之前 PATH 兜底分支**无条件返回 warn**（连 ffplay 能不能跑都不测），
 * 导致「感叹号永远在」。现在真的跑一次 ffplay -version 验证。
 * 注意播放器用的是 ffplay（不是 ffmpeg），ffmpeg.exe 播不了音频。
 */
async function checkFfmpeg(cfg) {
  const bin = player.ffmpegBin(cfg);          // 用户配置优先，ffmpeg.exe 自动找同目录 ffplay.exe
  const ok = await player.hasFfmpeg(cfg);     // 真跑一次 -version
  if (ok) {
    return {
      level: 'ok', title: 'ffplay（播放用）', key: 'ffmpeg',
      detail: bin === 'ffplay' ? '系统 PATH 中的 ffplay 可用' : bin,
      fix: { label: '', kind: 'none' },
    };
  }
  return {
    level: 'warn', title: 'ffplay（播放用）', key: 'ffmpeg',
    detail: '未找到可用的 ffplay：合成不受影响，但服务端试听会无声。填 ffmpeg.exe 也可以，会自动用同目录的 ffplay.exe',
    fix: { label: '指定路径', kind: 'setPath', payload: { field: 'ffmpegPath' } },
  };
}

function checkCache(cacheDir) {
  if (!cacheDir || !fs.existsSync(cacheDir)) {
    return { level: 'ok', title: '音频缓存', key: 'cache', detail: '尚未创建', fix: { label: '', kind: 'none' } };
  }
  const bytes = dirSize(cacheDir);
  let files = 0, old = 0;
  const now = Date.now() - 30 * 86400000;
  try {
    for (const f of fs.readdirSync(cacheDir)) {
      const p = path.join(cacheDir, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) { files++; if (st.mtimeMs < now) old++; }
      } catch (e) { }
    }
  } catch (e) { }
  if (old === 0) {
    return { level: 'ok', title: '音频缓存', key: 'cache', detail: `${files} 个文件 / ${P.human(bytes)}`, fix: { label: '', kind: 'none' } };
  }
  return {
    level: 'warn', title: '音频缓存', key: 'cache',
    detail: `${files} 个文件 / ${P.human(bytes)}，其中 ${old} 个超过 30 天`,
    fix: { label: '清理旧缓存', kind: 'cleanCache', payload: { dir: cacheDir, olderThanDays: 30 } },
  };
}

/* ---------------- 汇总体检 ---------------- */

/**
 * @param {object} cfg TTS 配置
 * @returns {Promise<{summary:object, items:Array, engineStatus:object}>}
 */
async function diagnose(cfg) {
  const c = cfg || {};
  const items = [];

  const py = await checkPython();
  items.push(py);
  const pythonOk = (py.level === 'ok' && py.python) ? py.python : null;

  if (c.engine === 'vits' || c.engine === 'all' || !c.engine) {
    items.push(await checkVitsDeps(pythonOk));
    items.push(await checkGpu(pythonOk));
    items.push(checkVitsModel(c.vitsDir));
  }
  if (c.engine === 'gptsovits' || c.engine === 'all' || !c.engine) {
    items.push(checkGptSovitsDir(c.gptSovitsDir));
    items.push(await checkPort(Number(c.port) || 9880));
  }
  items.push(await checkFfmpeg(c));
  items.push(checkCache(c.cacheDir));

  const bad = items.filter(i => i.level === 'bad').length;
  const warn = items.filter(i => i.level === 'warn').length;
  return {
    summary: {
      total: items.length, ok: items.length - bad - warn, warn, bad,
      verdict: bad ? `${bad} 项异常，需处理` : (warn ? `${warn} 项提醒` : '一切正常，可以直接用'),
    },
    items,
    engine: c.engine || 'gptsovits',
  };
}

/** 自动扫描候选安装目录（供「重新指定」按钮用） */
function scanCandidates(searchRoots) {
  const roots = searchRoots && searchRoots.length
    ? searchRoots
    : ['D:\\ai program', '%USERPROFILE%'];
  const vits = P.findDirs(roots, d => {
    try { return fs.existsSync(path.join(d, 'speakers_list.txt')) && fs.existsSync(path.join(d, 'models.py')); } catch (e) { return false; }
  });
  const gpt = P.findDirs(roots, d => {
    try { return fs.existsSync(path.join(d, 'api_v2.py')); } catch (e) { return false; }
  });
  return { vits, gptsovits: gpt };
}

module.exports = { diagnose, scanCandidates, candidatePythons, runPy, VITS_REQUIRED };
