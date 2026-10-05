/**
 * round74 · TTS HTTP 接口
 *
 * 设计意图：把「一键体检 / 一键修复 / 一键唤起 / 一键切音色」这套能力完整暴露出去，
 * 前端只做渲染。所有跨进程操作（spawn Python、占端口、杀进程）都留在主进程里做。
 *
 * 挂载点：/api/tts
 *   GET  /api/tts/config              读配置
 *   POST /api/tts/config              写配置
 *   POST /api/tts/autodiscover         自动扫描本机已装位置（开箱即用）
 *   POST /api/tts/diagnose            一键体检（不启动任何东西，纯只读探测）
 *   POST /api/tts/repair              一键修复（port / zombie / restart）
 *   GET  /api/tts/status              当前引擎状态（是否在跑、端口、健康）
 *   POST /api/tts/start               一键唤起
 *   POST /api/tts/stop                自动关闭（只关本应用启动的）
 *   GET  /api/tts/voices              音色列表（VITS 804 / GPT 权重+情绪）
 *   POST /api/tts/synthesize          合成一段（试听 / 朗读用）
 *   GET  /api/tts/scan                扫描候选安装目录
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const cfgStore = require('../utils/tts/config');
const diagnostics = require('../utils/tts/diagnostics');
const { VitsEngine } = require('../utils/tts/vits-engine');
const { GptSovitsEngine } = require('../utils/tts/gptsovits-engine');
const player = require('../utils/tts/player');
const vitsModel = require('../utils/tts/vits-model');

/* ---------- 引擎单例（两个引擎各一个，跑起来后常驻） ---------- */
const engines = { vits: null, gptsovits: null };
function engineOf(name) {
  const key = (name === 'vits') ? 'vits' : 'gptsovits';
  if (!engines[key]) {
    const cfg = cfgStore.read();
    engines[key] = key === 'vits'
      ? new VitsEngine({ pythonPath: cfg.pythonPath, vitsDir: cfg.vitsDir, cacheDir: cfg.cacheDir })
      : new GptSovitsEngine(cfg);
  } else {
    // 配置可能刚改过，刷新路径类字段
    const cfg = cfgStore.read();
    if (key === 'vits') { engines[key].cfg.pythonPath = cfg.pythonPath; engines[key].cfg.vitsDir = cfg.vitsDir; }
    else { Object.assign(engines[key].cfg, cfg); }
  }
  return engines[key];
}

function fail(res, e) {
  console.log('[TTS] 接口异常', e && e.message);
  return res.json({ code: -1, msg: String((e && e.message) || e).slice(0, 300) });
}

/* ---------------- 配置 ---------------- */

router.get('/config', (req, res) => {
  try { res.json({ code: 0, data: cfgStore.publicView() }); } catch (e) { fail(res, e); }
});

router.post('/config', (req, res) => {
  try {
    const patch = {};
    const b = req.body || {};
    // 只接受已知字段，避免前端传脏东西进来
    for (const k of Object.keys(cfgStore.DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(b, k)) patch[k] = b[k];
    }
    res.json({ code: 0, data: cfgStore.publicView(), saved: Object.keys(patch), cfg: cfgStore.write(patch) });
  } catch (e) { fail(res, e); }
});

router.post('/autodiscover', (req, res) => {
  try {
    const r = cfgStore.autodiscover();
    res.json({ code: 0, data: { cfg: cfgStore.publicView(), changed: r.changed } });
  } catch (e) { fail(res, e); }
});

router.get('/scan', (req, res) => {
  try { res.json({ code: 0, data: diagnostics.scanCandidates(req.body && req.body.roots) }); }
  catch (e) { fail(res, e); }
});

/* ---------------- 一键体检 / 修复 ---------------- */

router.post('/diagnose', async (req, res) => {
  try {
    const cfg = cfgStore.read();
    const engine = (req.body && req.body.engine) || cfg.engine;
    const r = await diagnostics.diagnose(Object.assign({}, cfg, { engine }));
    res.json({ code: 0, data: r });
  } catch (e) { fail(res, e); }
});

router.post('/repair', async (req, res) => {
  try {
    const b = req.body || {};
    const kind = b.kind || 'restart';
    const name = b.engine || cfgStore.read().engine;
    if (name === 'vits') {
      // VITS 没有端口，修复项只有「重启进程」和「清缓存」
      const e = engineOf('vits');
      const acts = [];
      if (kind === 'cleanCache') {
        const dir = cfgStore.read().cacheDir;
        let n = 0;
        try {
          const old = Date.now() - 30 * 86400000;
          for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            try { if (fs.statSync(p).mtimeMs < old) { fs.unlinkSync(p); n++; } } catch (e) { }
          }
        } catch (e) { }
        acts.push({ step: '清理 30 天前缓存', result: `删除 ${n} 个` });
      } else {
        acts.push({ step: '重启 VITS 进程', result: '完成' });
        await e.stop();
      }
      return res.json({ code: 0, data: { ok: true, acts } });
    }
    const e = engineOf('gptsovits');
    res.json({ code: 0, data: await e.repair(kind) });
  } catch (err) { fail(res, err); }
});

/* ---------------- 状态 / 启停 ---------------- */

router.get('/status', async (req, res) => {
  try {
    const name = (req.query.engine) || cfgStore.read().engine;
    if (name === 'off') return res.json({ code: 0, data: { engine: 'off', state: 'stopped' } });
    const e = engineOf(name);
    const h = await e.health(true);   // 前端轮询走轻量探活，别每次都发真合成
    res.json({ code: 0, data: { engine: name, state: e.state, running: e.isRunning(), port: e.port || 0, health: h } });
  } catch (e) { fail(res, e); }
});

router.post('/start', async (req, res) => {
  try {
    const name = (req.body && req.body.engine) || cfgStore.read().engine;
    if (name === 'off') return res.json({ code: -1, msg: 'TTS 已在设置里关闭' });
    /* round77：VITS 权重未就位 → 后台自动下载（进度走 /model/status 轮询），
       先回 downloading，前端显示进度条，下载完再点「一键唤起」即可。 */
    const cfgDir = cfgStore.read().vitsDir;
    if (name === 'vits' && !vitsModel.status(cfgDir).installed) {
      const st = vitsModel.status(cfgDir);
      if (st.state !== 'downloading') vitsModel.download(cfgDir).catch(() => { });
      return res.json({ code: 0, engine: name, needModel: true, data: vitsModel.status(cfgDir) });
    }
    const e = engineOf(name);
    const r = await e.start();
    res.json({ code: 0, data: r, engine: name });
  } catch (e) { fail(res, e); }
});

/* ---------------------------------------------------------------- 模型（round77）
 * VITS 权重 479MB 不进安装包，改为 Release 资产按需下载，支持续传/进度/取消。 */
router.get('/model/status', (req, res) => {
  try { res.json({ code: 0, data: vitsModel.status(cfgStore.read().vitsDir) }); } catch (e) { fail(res, e); }
});

router.post('/model/download', async (req, res) => {
  try { res.json({ code: 0, data: await vitsModel.download(cfgStore.read().vitsDir) }); } catch (e) { fail(res, e); }
});

router.post('/model/cancel', (req, res) => {
  try { res.json({ code: 0, data: vitsModel.cancel() }); } catch (e) { fail(res, e); }
});

router.post('/stop', async (req, res) => {
  try {
    const name = (req.body && req.body.engine) || cfgStore.read().engine;
    const e = engineOf(name);
    res.json({ code: 0, data: await e.stop(), engine: name });
  } catch (e) { fail(res, e); }
});

/** 应用退出时调用：只关自己拉起的引擎，绝不动用户手动启的 */
router.post('/shutdown', async (req, res) => {
  try {
    const out = {};
    for (const k of ['vits', 'gptsovits']) {
      if (engines[k] && engines[k].isRunning()) {
        out[k] = await engines[k].stop();
      }
    }
    player.stopAll();
    res.json({ code: 0, data: out });
  } catch (e) { fail(res, e); }
});

/* ---------------- 音色 ---------------- */

router.get('/voices', async (req, res) => {
  try {
    const name = (req.query.engine) || cfgStore.read().engine;
    if (name === 'vits') {
      // ★ 引擎侧已改成「没启动就直接读 speakers_list.txt」，所以这里不用再管 peek，
      //   点开设置就能秒列 804 个音色，不必等 18 秒拉起 450MB 模型。
      const vs = await engineOf('vits').voices();
      const q = String(req.query.q || '').trim();
      return res.json({ code: 0, data: { engine: 'vits', total: vs.length, voices: q ? vs.filter(v => v.name.includes(q)) : vs } });
    }
    const v = await engineOf('gptsovits').voices();
    res.json({ code: 0, data: Object.assign({ engine: 'gptsovits' }, v) });
  } catch (e) { fail(res, e); }
});

/* ---------------- 合成 / 播放 ---------------- */

router.post('/synthesize', async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.engine || cfgStore.read().engine;
    if (name === 'off') return res.json({ code: -1, msg: 'TTS 已在设置里关闭' });
    const e = engineOf(name);
    // round74c：调用方没带 speakerId/speed 时用全局配置兜底 ——
    // 之前 VITS 引擎里 o.speakerId || 0，阅读页不传就永远是 0 号音色（特别周），
    // 设置里换的音色对朗读完全无效。
    const c = cfgStore.read();
    const r = await e.synthesize({
      text: b.text,
      speakerId: b.speakerId != null ? Number(b.speakerId)
        : (name === 'vits' ? (Number(c.vitsSpeakerId) || 0) : undefined),
      ref: b.ref, auxRefs: b.auxRefs, lang: b.lang,
      // round75c：GPT 音色 —— 显式传 voice（可空=情绪参考音模式）优先，未传用配置默认
      voice: name === 'gptsovits'
        ? (b.voice !== undefined ? b.voice : (c.gptVoice || ''))
        : undefined,
      // round76：GPT 引擎默认 1.0 —— speed_factor 变速有损（全局 speed 曾是 1.3，
      // 同音色比 Alife 里「听着怪」的主因），语速改由前端 playbackRate 无损变速。
      // VITS 的引擎内变速质量好，维持跟随全局配置。
      speed: b.speed != null ? Number(b.speed) : (name === 'vits' ? (Number(c.speed) || 1) : 1.0),
      noCache: !!b.noCache,
    });
    // 试听：合成完直接播；朗读：由前端控制播放时机
    let played = false;
    if (b.play !== false) {
      played = await player.playFile(r.path).then(() => true).catch((e2) => { console.log('[TTS] 播放失败', e2.message); return false; });
    }
    res.json({ code: 0, data: Object.assign({ played }, r), engine: name });
  } catch (e) { fail(res, e); }
});

/**
 * 把合成好的 wav 交给浏览器播。
 * 为什么要这个接口：TTS 引擎在主进程（有 GPU），而「按段高亮 / 暂停 / 续播」需要在前端
 * 精确控制，用 <audio> 元素最合适（ffplay 只能整段放，播完才知道结束了）。
 * wav 落在 userData/tts-cache，不在 public 下，浏览器访问不到，所以开这个口。
 * 支持 Range —— 否则 <audio> 的拖动进度条不可用。
 */
router.get('/audio/:name', (req, res) => {
  try {
    const cfg = cfgStore.read();
    const dir = cfg.cacheDir || path.join(process.env.APPDATA || '.', 'CinemaVault', 'tts-cache');
    const name = path.basename(String(req.params.name || ''));
    // ★ 只允许 .wav，且必须落在缓存目录内（basename 已挡掉 ../..）
    if (!/^[A-Za-z0-9._-]+\.wav$/i.test(name)) return res.status(400).json({ code: -1, msg: '非法文件名' });
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) return res.status(404).json({ code: -1, msg: '音频不存在' });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.sendFile(full);
  } catch (e) { fail(res, e); }
});

/**
 * 把缓存迁到新目录（round72：默认缓存原本在 C 盘，用户要求挪到 D 盘）
 * body: { to: 'D:\\...\\tts-cache' }
 */
router.post('/migrate-cache', async (req, res) => {
  try {
    const cfg = cfgStore.read();
    const from = cfg.cacheDir;
    const to = String((req.body || {}).to || '').trim();
    if (!to) return res.json({ code: -1, msg: '缺少目标目录' });
    if (path.resolve(to) === path.resolve(from)) return res.json({ code: 0, msg: '目标与当前相同', data: { moved: 0, from, to } });

    fs.mkdirSync(to, { recursive: true });
    let moved = 0, bytes = 0;
    try {
      for (const f of fs.readdirSync(from)) {
        if (!/\.wav$/i.test(f)) continue;
        const s = path.join(from, f), d = path.join(to, f);
        try {
          if (fs.existsSync(d)) { fs.unlinkSync(s); moved++; continue; }
          bytes += fs.statSync(s).size;
          fs.renameSync(s, d);
          moved++;
        } catch (e) { /* 单个失败不中断 */ }
      }
    } catch (e) { /* 源目录不存在 */ }

    cfgStore.write({ cacheDir: to });
    // 引擎单例里也缓存了 cacheDir，刷新一下
    for (const k of Object.keys(engines)) { if (engines[k]) engines[k].cfg.cacheDir = to; }
    res.json({ code: 0, msg: '已迁移 ' + moved + ' 个文件', data: { moved, bytes, from, to } });
  } catch (e) { fail(res, e); }
});

/** 朗读会话控制：开始 / 停止（播放器侧） */
router.post('/play', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.action === 'stop') { player.stopAll(); return res.json({ code: 0, msg: '已停止' }); }
    if (!b.path) return res.json({ code: -1, msg: '缺少 path' });
    await player.playFile(b.path);
    res.json({ code: 0, msg: '播放中' });
  } catch (e) { fail(res, e); }
});

module.exports = router;
module.exports.engines = engines;
module.exports.engineOf = engineOf;

/* round77：开机自检 —— 引擎是 VITS 但权重没下过 → 后台静默下载（不阻塞启动、可取消）。
   延迟 25s 起步，避开启动扫描与首屏渲染的带宽/CPU 竞争。 */
setTimeout(() => {
  try {
    const c = cfgStore.read();
    if (c.engine === 'vits' && !vitsModel.status(c.vitsDir).installed) {
      vitsModel.download(c.vitsDir).then(
        (s) => console.log('[TTS] VITS 权重后台下载完成：' + (s && s.file)),
        (e) => console.log('[TTS] VITS 权重后台下载失败：' + (e && e.message))
      );
    }
  } catch (e) { /* 静默：下载失败不影响应用其它功能 */ }
}, 25000);
