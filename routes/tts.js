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
const { BreezeEngine } = require('../utils/tts/breeze-engine');
const { IndexTtsEngine } = require('../utils/tts/indextts-engine');
const { FishAudioEngine } = require('../utils/tts/fishaudio-engine');
const player = require('../utils/tts/player');
const vitsModel = require('../utils/tts/vits-model');

/* ---------- 引擎单例（vits / gptsovits / breeze / indextts / fishaudio） ---------- */
const engines = { vits: null, gptsovits: null, breeze: null, indextts: null, fishaudio: null };
const ENGINE_KEYS = ['vits', 'breeze', 'indextts', 'fishaudio'];
function engineOf(name) {
  const cfg = cfgStore.read();
  const key = ENGINE_KEYS.includes(name) ? name : 'gptsovits';
  if (!engines[key]) {
    if (key === 'breeze') {
      engines[key] = new BreezeEngine(cfg);
    } else if (key === 'indextts') {
      engines[key] = new IndexTtsEngine(cfg);
    } else if (key === 'fishaudio') {
      /* round141 云端引擎：不占 GPU、无进程可启动。
         代理优先级：tts-config 里 fishAudio.proxyUrl > 全局 config.network.proxyServer。
         （api.fish.audio 国内直连实测 ETIMEDOUT，没代理基本必失败） */
      const networkProxy = (() => { try { return (require('../utils/config').network || {}).proxyServer || ''; } catch (e) { return ''; } })();
      engines[key] = new FishAudioEngine(Object.assign({}, cfg, {
        proxyServer: (cfg.fishAudio && cfg.fishAudio.proxyUrl) || networkProxy
      }));
    } else if (key === 'vits') {
      engines[key] = new VitsEngine({ pythonPath: cfg.pythonPath, vitsDir: cfg.vitsDir, cacheDir: cfg.cacheDir });
    } else {
      engines[key] = new GptSovitsEngine(cfg);
    }
  } else {
    // 每次读配置后把最新值铺进去：换音色/改 key/换代理都要即时生效，不用重启
    if (key === 'fishaudio') {
      const networkProxy = (() => { try { return (require('../utils/config').network || {}).proxyServer || ''; } catch (e) { return ''; } })();
      engines[key].cfg = Object.assign({}, cfg, {
        fishAudio: cfg.fishAudio,
        proxyServer: (cfg.fishAudio && cfg.fishAudio.proxyUrl) || networkProxy
      });
    } else if (engines[key].cfg) {
      Object.assign(engines[key].cfg, cfg);
    }
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
    /* round141 安全修复：原来这里多回了一个 `cfg: cfgStore.write(patch)`，
       那是**整份原始配置**（含 fishAudio.apiKey / gptSovits 等明文密钥），
       等于把密钥原样回吐给前端。现在只回脱敏后的 publicView + 本次保存的字段名。 */
    cfgStore.write(patch);
    /* round145：切引擎时把 AI 伴侣声线一起带过去，避免「面板切了、伴侣还是老声音」 */
    const companion = patch.engine ? syncCompanionVoice(patch.engine) : null;
    res.json({ code: 0, data: cfgStore.publicView(), saved: Object.keys(patch), companion });
  } catch (e) { fail(res, e); }
});

/* round141：Fish Audio 连通性/鉴权自检 —— 设置页「测试」按钮走这里。
 * 为什么单独一个端点：合成一次要花钱，用户只想确认 key 和代理通不通时，
 * 用极短文本试一句最划算；同时把失败原因说成人话（代理没开 / key 过期 / 额度不足）。 */
/* round145：把「语音朗读引擎」同步成 AI 伴侣声线（ai.tts）。
   用户心里的模型只有一个：「我选了 fishaudio / 换了音色，就该用这个声音」。
   旧版两套配置互不相干 —— 面板切了 fishaudio，伴侣还读着 ai.tts.engine=breeze，
   表现就是「选的是 fishaudio，出来的还是本地那个声音」。 */
function syncCompanionVoice(appliedEngine) {
  const out = { synced: false, note: '' };
  try {
    const p = path.join(__dirname, '../config.json');
    if (!fs.existsSync(p)) { out.note = 'config.json 不存在'; return out; }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || !raw.ai || !raw.ai.tts) { out.note = '未启用 AI 伴侣语音'; return out; }
    const c = cfgStore.read();
    const pick = {
      fishaudio: () => (c.fishAudio && c.fishAudio.referenceId) || '',
      breeze: () => c.breezeVoice || '爱弥斯',
      gptsovits: () => c.gptVoice || '',
      vits: () => (c.vitsSpeakerId == null ? '' : String(c.vitsSpeakerId))
    }[appliedEngine];
    if (!pick) { out.note = '该引擎不参与伴侣同步'; return out; }
    raw.ai.tts.engine = appliedEngine;
    const v = pick();
    if (v) raw.ai.tts.voice = v;      // fishaudio 下 voice 语义 = reference_id
    fs.writeFileSync(p, JSON.stringify(raw, null, 4), 'utf8');
    out.synced = true;
  } catch (e) { out.note = String(e.message || e).slice(0, 120); }
  return out;
}

router.post('/fishaudio/test', async (req, res) => {
  try {
    const e = engineOf('fishaudio');
    const b = req.body || {};
    const text = String(b.text || '你好呀，测试一下语音。').slice(0, 60);
    const t0 = Date.now();
    const r = await e.synthesize({
      text,
      voice: b.referenceId || undefined,
      noCache: true
    });
    res.json({
      code: 0,
      msg: '连接正常，已合成一段试听音频',
      data: {
        ok: true,
        engine: 'fishaudio',
        costMs: Date.now() - t0,
        bytes: r.bytes,
        path: r.path,
        text
      }
    });
  } catch (e) {
    // 失败也要 200：前端拿 msg 直接展示，不用区分 HTTP 层错误
    res.json({ code: -1, msg: String(e && e.message || e).slice(0, 300) });
  }
});

/* ------------------------------------------------------------------ round145
 * Fish Audio 在线音色：搜索 + 选中即热重载。
 * 对齐 Alife 插件（Plugins/Azuma.FishAudioTTS/FishAudioModelUI.SearchVoicesAsync）的能力：
 *   输入关键词 → 搜全站公开音色（带试听样本）→ 点一下就换，且立刻生效。
 * 旧版 `fetchMyVoices()` 是空的（注释写着「保守起见只返回空」），
 * 所以 CinemaVault 里只有 1 个写死的预设 + 手填 ID，等于没有音色库。
 */
router.get('/fishaudio/search', async (req, res) => {
  try {
    const e = engineOf('fishaudio');
    const r = await e.searchVoices({
      q: req.query.q,
      page: req.query.page,
      pageSize: req.query.pageSize,
      sortBy: req.query.sortBy
    });
    res.json({ code: 0, data: r });
  } catch (err) {
    // 搜索失败不该是红色报错弹窗，前端只展示一行提示
    res.json({ code: -1, msg: String((err && err.message) || err).slice(0, 300) });
  }
});

/** 选中音色 = 立刻写配置。引擎每次合成都会重读 cfg，所以「热重载」天然成立，
 *  连重启都不需要；顺带把 AI 伴侣的声线也指过来，避免「语音面板换了、伴侣还是老声音」。 */
router.post('/fishaudio/voice', (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.referenceId || b.id || '').trim();
    const name = String(b.voiceName || b.name || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      return res.json({ code: -1, msg: 'reference_id 格式不对（应为 32 位十六进制，例如 da6a6205c31d451fabb28c3d139adfa8）' });
    }
    const cfg = cfgStore.write({ fishAudio: { referenceId: id, voiceName: name || '' } });

    /* 同步 AI 伴侣声线（config.json 里没有 ai.tts 就跳过，绝不凭空造一段配置） */
    const cs = syncCompanionVoice('fishaudio');
    const companionSynced = cs.synced, companionNote = cs.note;

    res.json({
      code: 0,
      data: {
        referenceId: (cfg.fishAudio && cfg.fishAudio.referenceId) || id,
        voiceName: (cfg.fishAudio && cfg.fishAudio.voiceName) || name,
        companionSynced, companionNote
      }
    });
  } catch (e) { fail(res, e); }
});

router.post('/autodiscover', (req, res) => {
  try {
    const r = cfgStore.autodiscover();
    res.json({ code: 0, data: { cfg: cfgStore.publicView(), changed: r.changed } });  } catch (e) { fail(res, e); }
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
    /* round88：all=1 → 四引擎状态总览。启动加载门（bootGate）用它跟随「真正在预热」
       的引擎：POST /config 只写盘不热更，写盘 engine 与运行引擎可能短暂不一致，
       只盯写盘值会把加载门卡到 300s 兜底。 */
    if (req.query.all === '1') {
      const out = {};
      for (const k of ['breeze', 'indextts', 'vits', 'gptsovits']) {
        try {
          const e2 = engineOf(k);
          out[k] = { state: e2.state, msg: e2.progressMsg || '', running: e2.isRunning() };
        } catch (e3) { out[k] = { state: 'stopped', msg: '', running: false }; }
      }
      return res.json({ code: 0, data: { engines: out } });
    }
    const name = (req.query.engine) || cfgStore.read().engine;
    if (name === 'off') return res.json({ code: 0, data: { engine: 'off', state: 'stopped' } });
    const e = engineOf(name);
    const h = await e.health(true);   // 前端轮询走轻量探活，别每次都发真合成
    // round85：msg = 引擎实时进度文案（breeze/indextts 常驻 worker 加载模型时
    // 会上报「加载模型权重…/预热 CUDA 内核…」），前端直接显示，用户不再干等两分钟没反馈
    res.json({ code: 0, data: { engine: name, state: e.state, msg: e.progressMsg || '', running: e.isRunning(), port: e.port || 0, health: h } });
  } catch (e) { fail(res, e); }
});

router.post('/start', async (req, res) => {
  try {
    const name = (req.body && req.body.engine) || cfgStore.read().engine;
    if (name === 'off') return res.json({ code: -1, msg: 'TTS 已在设置里关闭' });
    /* round141：云端引擎没有「加载」这一步，直接验证配置齐不齐。 */
    if (name === 'fishaudio') {
      const e = engineOf('fishaudio');
      const r = await e.start();
      return res.json({ code: 0, data: r, engine: name });
    }
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
    for (const k of ['vits', 'gptsovits', 'breeze', 'indextts']) {
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
    /* round141：Fish Audio 音色 = reference_id 列表（预设 + 用户手填）。
       与本地引擎不同，这里不需要拉起任何进程，秒回。 */
    if (name === 'fishaudio') {
      const vs = await engineOf('fishaudio').voices();
      const q = String(req.query.q || '').trim();
      const cfg = cfgStore.read();
      return res.json({
        code: 0,
        data: {
          engine: 'fishaudio',
          total: vs.length,
          current: (cfg.fishAudio && cfg.fishAudio.referenceId) || '',
          voices: q ? vs.filter(v => String(v.name).includes(q)) : vs
        }
      });
    }
    if (name === 'breeze') {
      const vs = await engineOf('breeze').voices();
      const q = String(req.query.q || '').trim();
      return res.json({
        code: 0,
        data: {
          engine: 'breeze',
          total: vs.length,
          voices: q ? vs.filter(v => v.name.includes(q)) : vs
        }
      });
    }
    if (name === 'indextts') {
      const vs = await engineOf('indextts').voices();
      return res.json({ code: 0, data: { engine: 'indextts', total: vs.length, voices: vs } });
    }
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
      // round75c / r88：Breeze 音色或 GPT 音色 —— 显式传 voice 优先，未传用配置默认
      // round145：Fish Audio 的 voice 语义是 reference_id。旧版这里对 fishaudio 直接给
      //   undefined ⇒ 面板下拉换了音色、试听仍是配置文件里存的那个，「选了不生效」。
      voice: name === 'breeze'
        ? (b.voice || c.breezeVoice || '爱弥斯')
        : (name === 'gptsovits'
            ? (b.voice !== undefined ? b.voice : (c.gptVoice || ''))
            : (name === 'fishaudio'
                ? (b.voice || b.referenceId || (c.fishAudio && c.fishAudio.referenceId) || undefined)
                : undefined)),
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
 * round87 真流式合成（目前仅 breeze 常驻 worker 支持）。
 * 响应为 octet-stream 自定义协议：
 *   首行 JSON 头 + \n：
 *     {"t":"header","sr":24000,"fmt":"pcm_s16le"}   ← 之后到流结束全是二进制 PCM16LE
 *     {"t":"cached","path":"xxx.wav"}               ← 缓存命中，无二进制（前端走 <audio>）
 *     {"t":"error","msg":"..."}                     ← 失败（前端兜底旧路径）
 *   流正常结束时补一行 {"t":"done",...} 再关闭。
 * 价值：bench 实测 TTFA 仅 215~260ms —— 首个 audio chunk 产出即推给前端，
 * 点朗读后 ~1 秒出声，不再等整块合成完（旧行为 breeze 下要等 RTF≈2 × 音频时长）。
 */
router.post('/synthesize-stream', async (req, res) => {
  try {
    const b = req.body || {};
    const name = b.engine || cfgStore.read().engine;
    if (name === 'off') return res.status(400).json({ code: -1, msg: 'TTS 已在设置里关闭' });
    if (name !== 'breeze') return res.status(400).json({ code: -1, msg: '该引擎暂不支持流式，前端会回退普通接口' });
    if (!b.text || !String(b.text).trim()) return res.status(400).json({ code: -1, msg: '合成文本为空' });

    const c = cfgStore.read();
    const e = engineOf('breeze');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    let headerSent = false;
    const sendLine = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (err) { } };

    try {
      const r = await e.synthesize({
        text: b.text,
        voice: b.voice || c.breezeVoice || '爱弥斯',
        play: false,
        onChunk: (pcmBuf, sr) => {
          if (res.writableEnded) return;
          if (!headerSent) { sendLine({ t: 'header', sr: sr || 24000, fmt: 'pcm_s16le' }); headerSent = true; }
          res.write(pcmBuf);
        },
      });
      if (r && r.cached) {
        sendLine({ t: 'cached', path: path.basename(r.path) });
      } else {
        if (!headerSent) sendLine({ t: 'header', sr: r.sampleRate || 24000, fmt: 'pcm_s16le' });
        sendLine({ t: 'done', path: path.basename(r.path), durationSec: r.durationSec || 0 });
      }
      res.end();
    } catch (err) {
      if (!headerSent) sendLine({ t: 'error', msg: String((err && err.message) || err).slice(0, 200) });
      try { res.end(); } catch (e2) { }
    }
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
    /* ★ 只允许音频扩展名，且必须落在缓存目录内（basename 已挡掉 ../..）。
       round141：原来写死 .wav，云端引擎（Fish Audio）返回的是 mp3 ——
       那些文件会被判「非法文件名」而 400，试听/朗读直接没声音。
       现在按扩展名给出正确的 Content-Type。 */
    const m = name.match(/^([A-Za-z0-9._-]+)\.(wav|mp3|flac)$/i);
    if (!m) return res.status(400).json({ code: -1, msg: '非法文件名' });
    const ext = m[2].toLowerCase();
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) return res.status(404).json({ code: -1, msg: '音频不存在' });
    res.setHeader('Content-Type',
      ext === 'mp3' ? 'audio/mpeg' : (ext === 'flac' ? 'audio/flac' : 'audio/wav'));
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

/* round85：开机后台预热常驻 worker（breeze/indextts）。
   旧流程是「用户点朗读 → 现场加载 7GB 模型 → 干等 1~2 分钟」，现在应用一启动
   就在后台把模型灌进显存，等用户真点朗读时模型已就绪，几秒出声。
   autoStartEngine=false 或引擎关闭时不预热。失败静默（下次合成时自动重试）。 */
setTimeout(() => {
  try {
    const c = cfgStore.read();
    /* round138：两道闸都写明。autoStartEngine 现在是默认关（用户要求「启动应用不要自动跑语音合成」），
       engine==='off' 再单独拦一道 —— 免得有人只切引擎没动开关，模型又在后台灌进显存。 */
    if (c.autoStartEngine === false || c.engine === 'off') return;
    if (c.engine !== 'breeze' && c.engine !== 'indextts') return;
    if (!fs.existsSync(c.breezeModelDir || 'D:\\TTS model\\Breeze-TTS-2') && c.engine === 'breeze') return;
    console.log('[TTS] 后台预热 ' + c.engine + ' 模型…');
    engineOf(c.engine).start().then(
      () => console.log('[TTS] ' + c.engine + ' 预热完成'),
      (e) => console.log('[TTS] ' + c.engine + ' 预热失败（合成时会自动重试）：' + (e && e.message))
    );
  } catch (e) { /* 静默 */ }
}, 15000);
