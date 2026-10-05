/**
 * round74 · TTS 配置
 *
 * 存哪：`<userData>/tts-config.json`（Electron 下就是 %APPDATA%\CinemaVault\tts-config.json）
 * 为什么不用项目里的 config.json：那个是「改扫描目录/开关必须重启」的重量级配置，
 * 而 TTS 路径、音色、语速这些是要在 UI 里频繁微调的，轻量独立文件更合适，
 * 也避免用户改个音色路径就要重启整个应用。
 *
 * 设计原则：**字段有默认值且能自愈** —— 首次运行时自动扫描本机已知的
 * VITS / GPT-SoVITS 安装位置，用户开箱即用，不用先配置路径。
 */

const fs = require('fs');
const path = require('path');
const { scanCandidates, candidatePythons } = require('./diagnostics');

const DEFAULT_PORTS = { gptsovits: 9880 };

function runtimeDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'CinemaVault');
  return path.join(__dirname, '..', '..', '..');
}
const CONFIG_FILE = path.join(runtimeDir(), 'tts-config.json');

/**
 * 缓存目录默认放哪。
 * ★ round72 用户反馈「为什么缓存放在 C 盘」。原来默认落在 %APPDATA%（C 盘），
 *   而这个库和媒体都在 D 盘；语音缓存是高频读写的大头（每段语音一个 wav），不该占 C 盘。
 *   探测顺序：① 环境变量显式指定 ② exe 同级的「本地数据-敏感」可写区（D/G 盘都试）
 *            ③ 退回 %APPDATA%。用户在设置里可随时改。
 * ⚠️ 探测不能用 __dirname 往上推算 —— runtime 本身就在 C 盘（%APPDATA% 下），
 *   往上三级是 AppData\Roaming，不是项目目录。必须按盘符去找。
 */
function defaultCacheDir() {
  if (process.env.CINEMAVAULT_TTS_CACHE) return process.env.CINEMAVAULT_TTS_CACHE;
  // 常见项目位置（打包后 exe 旁边的可写数据区）
  const roots = [
    '%INSTALLDIR%\\exe\\本地数据-敏感',
    'G:\\ai program\\local-movie-library\\exe\\本地数据-敏感',
  ];
  for (const r of roots) {
    try { if (fs.existsSync(r)) return path.join(r, 'tts-cache'); } catch (e) { }
  }
  // 兜底：看看有没有别的盘装了本项目
  return path.join(runtimeDir(), 'tts-cache');
}

const DEFAULTS = {
  // 引擎：'gptsovits'（音质好，参考音频已备）| 'vits'（零配置、804 音色）| 'off'
  engine: 'gptsovits',
  autoStartEngine: true,       // 勾上后，打开阅读器自动唤起引擎（round76 默认开：避免每次朗读都等模型冷加载）
  autoStopOnExit: true,        // 退出应用时自动关闭本应用启动的引擎
  idleExitMinutes: 30,         // 空闲多久自动释放（round76：10 → 30，听书歇几分钟就睡、回来等 180s 太伤）

  // 公共
  pythonPath: '',              // 留空则自动探测
  cacheDir: defaultCacheDir(),
  ffmpegPath: '',              // 留空则用系统 PATH
  lang: 'zh',
  speed: 1.0,

  // VITS
  vitsDir: '',
  vitsSpeakerId: 0,

  // GPT-SoVITS
  gptSovitsDir: '',
  gptPythonPath: '',
  port: DEFAULT_PORTS.gptsovits,
  refAudio: '',
  auxRefAudios: [],
  emotion: '',                 // ref/ 下的情绪目录名，留空用中性 ref
  textSplitMethod: 'cut5',
  // 可选调参：留空 = 用服务端 yaml 的默认值（传错反而更差）
  fragmentInterval: null,
  batchSize: null,
  topK: null, topP: null, temperature: null, repetitionPenalty: null,
  presetKey: '',              // GPT_weights_v4 之类的权重目录
  presetFile: '',             // 该目录下的具体 .ckpt
  gptVoice: '',               // round75c：当前音色（logs/ 训练目录名，如「爱弥斯」），空 = 不切权重、用情绪参考音
  gptVoiceRefs: {},           // round76：每音色自定义参考音覆盖 { 音色名: wav 路径 }；空则用训练切片自动挑选
};

let _cache = null;

function read() {
  if (_cache) return _cache;
  let user = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { user = {}; }
  _cache = Object.assign({}, DEFAULTS, user);
  // 迁移：旧默认把缓存放在 C 盘的 %APPDATA% 下，round72 起改到 exe 同级可写数据区。
  // 只在「还是旧默认值」或「没配」时改，用户手动指定过的不动。
  const oldDefault = path.join(runtimeDir(), 'tts-cache');
  if (!_cache.cacheDir || _cache.cacheDir === oldDefault) _cache.cacheDir = defaultCacheDir();
  return _cache;
}

function write(patch) {
  const cur = read();
  _cache = Object.assign({}, cur, patch || {});
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_cache, null, 2), 'utf8');
  } catch (e) {
    console.error('[TTS] 配置写入失败：', e.message);
  }
  return _cache;
}

/**
 * 首次运行时自动填路径 —— 扫描本机已知的安装位置。
 * 这是「开箱即用」的关键：用户装过 Alife 就不用再配一遍。
 */
function autodiscover() {
  const cfg = read();
  const changed = [];

  if (!cfg.pythonPath) {
    const pys = candidatePythons();
    // 优先选 3.12（numba 不支持 3.13，实测 3.12 环境最稳）
    const p312 = pys.find(p => /Python312/.test(p));
    if (p312) { cfg.pythonPath = p312; changed.push('pythonPath'); }
    else if (pys[0]) { cfg.pythonPath = pys[0]; changed.push('pythonPath'); }
  }

  if (!cfg.vitsDir || !fs.existsSync(cfg.vitsDir)) {
    const hit = scanCandidates().vits.find(d => {
      try { return fs.existsSync(path.join(d, 'model', 'G_953000.pth')); } catch (e) { return false; }
    });
    if (hit) { cfg.vitsDir = hit; changed.push('vitsDir'); }
  }

  if (!cfg.gptSovitsDir || !fs.existsSync(cfg.gptSovitsDir)) {
    const hit = scanCandidates().gptsovits.find(d => {
      try { return fs.existsSync(path.join(d, 'api_v2.py')) && fs.existsSync(path.join(d, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')); } catch (e) { return false; }
    });
    if (hit) {
      cfg.gptSovitsDir = hit; changed.push('gptSovitsDir');
      const rt = path.join(hit, 'runtime', 'python.exe');
      try { if (fs.existsSync(rt)) { cfg.gptPythonPath = rt; changed.push('gptPythonPath'); } } catch (e) { }
    }
  }

  // 情绪参考音频：自动挑 ref/ 下的第一个情绪
  if (!cfg.refAudio && cfg.gptSovitsDir) {
    try {
      const refDir = path.join(cfg.gptSovitsDir, 'ref');
      for (const d of fs.readdirSync(refDir)) {
        const sub = path.join(refDir, d);
        // ★ ref/ 下混着普通文件（实测有个 _picked.json），对文件 readdirSync 会抛 ENOTDIR，
        //   而整个循环被这层 try 包着，一抛就整个中断 ⇒ 永远选不到参考音频。
        let st; try { st = fs.statSync(sub); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        let wavs = [];
        try { wavs = fs.readdirSync(sub).filter(f => /\.(wav|mp3|flac)$/i.test(f)); } catch (e) { continue; }
        if (wavs.length) {
          cfg.refAudio = path.join(sub, wavs[0]);
          cfg.emotion = d;
          changed.push('refAudio');
          break;
        }
      }
    } catch (e) { }
  }

  if (changed.length) write(cfg);
  return { cfg, changed };
}

/** 对外暴露时把绝对路径转成可读形式，别把整个 userData 路径糊在 UI 上 */
function publicView() {
  const c = read();
  return {
    engine: c.engine, autoStartEngine: c.autoStartEngine, autoStopOnExit: c.autoStopOnExit,
    idleExitMinutes: c.idleExitMinutes, lang: c.lang, speed: c.speed,
    vitsDir: c.vitsDir, vitsSpeakerId: c.vitsSpeakerId,
    gptSovitsDir: c.gptSovitsDir, port: c.port, refAudio: c.refAudio,
    emotion: c.emotion, presetKey: c.presetKey, presetFile: c.presetFile,
    gptVoice: c.gptVoice, gptVoiceRefs: c.gptVoiceRefs || {},
    pythonPath: c.pythonPath, ffmpegPath: c.ffmpegPath, cacheDir: c.cacheDir,
    configFile: CONFIG_FILE,
  };
}

module.exports = { DEFAULTS, CONFIG_FILE, read, write, autodiscover, publicView };
