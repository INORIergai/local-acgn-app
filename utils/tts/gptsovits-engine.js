/**
 * round74 · GPT-SoVITS 引擎（本地 HTTP 服务 + 全套自愈）
 *
 * 与 VITS 引擎实现同一套生命周期契约（probe/start/stop/health/voices/synthesize/repair），
 * 前端与用户操作完全无差别。差别在于它要起一个 **HTTP 服务**，
 * 于是多出一整类坑（端口占用 / Hyper-V 保留端口 / 僵尸进程 / 配置漂移 / PATH 污染…），
 * 这些正是本文件的主要工作量。
 *
 * 启动命令（实测与 Alife 一致）：
 *   runtime\python.exe api_v2.py -p {port} -c "GPT_SoVITS/configs/tts_infer.yaml"
 *   cwd = 整合包根目录
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./proc');

/** api_v2 只认这 5 个语种，发别的直接 400（Alife 4.1.0 才补上这个归一） */
const LANGS = ['zh', 'ja', 'en', 'ko', 'yue'];
function normalizeLang(v, fallback = 'zh') {
  const s = String(v || '').toLowerCase();
  if (LANGS.includes(s)) return s;
  if (/^(zh|cmn)/.test(s) || /hans|hant|tw|hk|sg|mo/.test(s)) return 'zh';
  if (/^ja/.test(s)) return 'ja';
  if (/^en/.test(s)) return 'en';
  if (/^ko/.test(s)) return 'ko';
  if (/^yue|canton/.test(s)) return 'yue';
  return fallback;
}

class GptSovitsEngine {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.managed = null;        // P.spawnManaged
    this.ownProcess = false;    // ★ 只有自己拉起的才允许 stop 杀它
    this.state = 'stopped';     // stopped | starting | ready | external | error
    this.port = Number(this.cfg.port) || 9880;
    this.bootMs = 0;
    this.lastError = '';
    this._probeCache = 0;
  }

  get name() { return 'GPT-SoVITS'; }
  get usesPort() { return true; }
  get base() { return 'http://127.0.0.1:' + this.port; }

  /* ============ 路径解析 ============ */

  _root() { return this.cfg.gptSovitsDir || ''; }
  _python() {
    const c = this.cfg.gptPythonPath;
    if (c && fs.existsSync(c)) return c;
    const r = this._root();
    if (!r) return null;
    for (const rel of ['runtime\\python.exe', 'python.exe', '..\\runtime\\python.exe']) {
      const p = path.join(r, rel);
      try { if (fs.existsSync(p)) return p; } catch (e) { }
    }
    return null;
  }
  _apiPy() {
    const p = path.join(this._root(), 'api_v2.py');
    try { return fs.existsSync(p) ? p : null; } catch (e) { return null; }
  }
  _yaml() {
    const p = path.join(this._root(), 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
    try { return fs.existsSync(p) ? p : null; } catch (e) { return null; }
  }

  /* ============ 端口决策（自愈的核心） ============ */

  /**
   * 决定这次要用哪个端口。
   * 1) 配置端口上已有**健康的** GPT-SoVITS → 直接采用（用户自己启的服务，不该抢）
   * 2) 配置端口空闲 → 用它
   * 3) 配置端口被占/被保留 → 顺延到下一个可 bind 的端口
   * 4) 记录原因，供 UI 提示
   */
  async _resolvePort() {
    const want = Number(this.cfg.port) || 9880;

    // ① 先看是不是已经有健康服务
    const existing = await this._probeOpenApi(want, 2000);
    if (existing.ok) {
      this.port = want;
      return { port: want, adopted: true, reason: '检测到端口 ' + want + ' 上已有可用的 GPT-SoVITS，直接采用' };
    }

    // ② 配置端口能不能用
    const listening = await P.isPortListening(want);
    const bind = listening ? { ok: false, code: 'EADDRINUSE' } : await P.isBindable(want);
    if (bind.ok) {
      this.port = want;
      return { port: want, adopted: false, reason: '' };
    }

    // ③ 顺延
    const free = await P.findFreePort(want + 1, want + 30);
    if (!free.port) {
      this.lastError = free.reason;
      throw new Error('端口 ' + want + ' 被占用，且 ' + (want + 1) + '~' + (want + 30) + ' 都不可用');
    }
    this.port = free.port;
    const isReserved = bind.code === 'EACCES' || bind.code === 'EADDRINUSE';
    return {
      port: free.port, adopted: false,
      reason: `端口 ${want} ${isReserved ? '不可绑定（被占用或被 Windows 保留端口段占用）' : '异常'}，已自动改用 ${free.port}`,
      reserved: bind.code === 'EACCES',
    };
  }

  async _probeOpenApi(port, timeout = 3000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/openapi.json`, { signal: AbortSignal.timeout(timeout) });
      if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
      const txt = await r.text();
      return /\/tts/.test(txt) ? { ok: true } : { ok: false, reason: '端口上有服务但不是 GPT-SoVITS（无 /tts）' };
    } catch (e) {
      return { ok: false, reason: '无响应' };
    }
  }

  /* ============ 生命周期 ============ */

  isRunning() { return !!(this.managed && this.managed.proc && this.managed.proc.exitCode === null); }

  /**
   * 一键唤起。
   * 流程：解析端口 → spawn → 轮询就绪（最多 180s，模型加载慢）→ **合成能力探测**。
   * 合成能力探测是必须的：Alife 实测存在「openapi 正常但 /tts 全 Errno 22」的坏服务，
   * 只看 openapi 会误判为健康。
   */
  async start() {
    if (this.state === 'ready') return { ok: true, already: true };

    const root = this._root();
    if (!root || !fs.existsSync(root)) throw new Error('未配置 GPT-SoVITS 目录');
    const py = this._python();
    if (!py) throw new Error('整合包里找不到 python（runtime\\python.exe）');
    const api = this._apiPy();
    const yaml = this._yaml();
    if (!api || !yaml) throw new Error('整合包不完整：缺 api_v2.py 或 tts_infer.yaml');

    const t0 = Date.now();
    const pick = await this._resolvePort();
    this.state = 'starting';
    this.lastError = '';

    // ★ PATH 净化：把整合包自己的 runtime 放在最前，剔除宿主的其它 Python
    const extra = [path.join(root, 'runtime'), path.join(root, 'runtime', 'Scripts')];
    const env = P.buildChildEnv(py, extra, process.env);

    this.managed = P.spawnManaged(py, [api, '-p', String(this.port), '-c', yaml], {
      cwd: root, env, name: 'gptsovits',
    });
    this.managed.proc.stderr.on('data', d => { this.lastError = (this.lastError + d).slice(-2000); });
    this.managed.proc.on('exit', (code) => {
      if (this.ownProcess) this.state = code === 0 ? 'stopped' : 'error';
    });
    this.ownProcess = true;

    // 等就绪
    const deadline = t0 + 180000;
    let last = '';
    while (Date.now() < deadline) {
      if (this.managed.proc.exitCode !== null) {
        this.ownProcess = false;
        throw new Error('GPT-SoVITS 进程退出 (code=' + this.managed.proc.exitCode + ')：' + this.lastError.slice(-300));
      }
      const p = await this._probeOpenApi(this.port, 2000);
      if (p.ok) break;
      last = p.reason;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (Date.now() >= deadline) {
      await this.stop();
      throw new Error('GPT-SoVITS 启动超时（180s），最后状态：' + last);
    }

    // 合成能力探测（真发一次合成）
    const ok = await this._probeSynth();
    if (!ok.ok) {
      await this.stop();
      throw new Error('服务起来了但合成不可用：' + ok.reason);
    }

    this.state = 'ready';
    this.bootMs = Date.now() - t0;
    // ★ 服务（重新）启动后加载的是默认权重，运行时跟踪清零 —— 首次切音色必然重切
    this._curGpt = null;
    this._curSovits = null;
    return { ok: true, port: this.port, bootMs: this.bootMs, portReason: pick.reason, adopted: pick.adopted };
  }

  async stop() {
    if (!this.isRunning()) { this.state = 'stopped'; this.ownProcess = false; return { ok: true, already: true }; }
    // ★ 只杀自己拉起的：用户手动启的服务我们无权关闭
    if (!this.ownProcess) {
      this.state = 'external';
      return { ok: true, skipped: true, msg: '该服务不是本应用启动的，已保留（如需停止请自行处理）' };
    }
    this.managed.kill();
    this.state = 'stopped';
    this.ownProcess = false;
    return { ok: true };
  }

  /**
   * 健康检查。
   * @param {boolean} quick  true = 只探端口+接口（毫秒级，适合前端轮询）；
   *                      false/undefined = 额外发一次真实合成验证能力（重，仅在 start 后用一次）
   * ★ 这个区分是必要的：合成探测要真 POST 一次 /tts（会吃 GPU、耗时数秒到数十秒），
   *   而前端每几秒轮询一次状态，用重探测会把界面卡住、也会把显卡打满。
   */
  async health(quick) {
    const oa = await this._probeOpenApi(this.port, 2500);
    if (!oa.ok) return { ok: false, state: this.state, detail: '服务未响应（' + oa.reason + '）' };
    if (quick) {
      return { ok: true, state: this.state, detail: '服务在线', quick: true };
    }
    const s = await this._probeSynth();
    return s.ok
      ? { ok: true, state: this.state, detail: '服务健康，合成可用' }
      : { ok: false, state: 'error', detail: '服务在但合成失败：' + s.reason };
  }

  /** 真发一次最小合成做能力探测 */
  async _probeSynth() {
    const ref = this.cfg.refAudio;
    if (!ref || !fs.existsSync(ref)) {
      // 没有参考音频就没法探测，如实说清楚而不是假装健康
      return { ok: false, reason: '未配置参考音频，无法验证合成能力' };
    }
    const t0 = Date.now();
    try {
      const buf = await this._postTts({ text: '测试。', lang: 'zh', ref, out: null });
      if (!buf || !buf.length) return { ok: false, reason: '返回空音频' };
      return { ok: true, bytes: buf.length, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, reason: String(e.message).slice(0, 120) };
    }
  }

  /* ============ 能力 ============ */

  /**
   * 一键切音色：权重预设 + ref 情绪库 + 音色库（round75c）
   * 音色 = logs/<音色名>/ 训练目录（有 5-wav32k 音频）+ GPT/SoVITS 权重配对。
   * 「情绪」只决定语气（ref wav 的情感），「音色」决定谁在说话（权重 + 该音色自己的 ref）。
   */
  async voices() {
    const root = this._root();
    const out = { presets: [], emotions: [], voiceList: [] };
    if (!root) return out;
    // 权重预设：GPT_weights* 下的 .ckpt
    try {
      for (const d of fs.readdirSync(root)) {
        if (!/^GPT_weights/.test(d)) continue;
        const wd = path.join(root, d);
        let st; try { st = fs.statSync(wd); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        let files = [];
        try { files = fs.readdirSync(wd).filter(f => /\.(ckpt|pth)$/i.test(f)); } catch (e) { }
        out.presets.push({ key: d, name: d, count: files.length, files });
      }
    } catch (e) { }
    // 情绪参考库：ref/{情感}/*.wav
    try {
      for (const d of fs.readdirSync(path.join(root, 'ref'))) {
        const p = path.join(root, 'ref', d);
        let st; try { st = fs.statSync(p); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        const wavs = fs.readdirSync(p).filter(f => /\.(wav|mp3|flac)$/i.test(f));
        if (wavs.length) out.emotions.push({ name: d, file: path.join(p, wavs[0]), count: wavs.length });
      }
    } catch (e) { }
    // 音色库（round75c）：logs/<音色>/5-wav32k 有训练音频的目录
    out.voiceList = this._scanVoices(root);
    return out;
  }

  /** 扫描音色：logs/<名>/5-wav32k/ 有音频 → 找配对的 GPT + SoVITS 权重 */
  _scanVoices(root) {
    const logsDir = path.join(root, 'logs');
    const voices = [];
    try {
      for (const d of fs.readdirSync(logsDir)) {
        const p = path.join(logsDir, d);
        let st; try { st = fs.statSync(p); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        const wavDir = path.join(p, '5-wav32k');
        if (!fs.existsSync(wavDir)) continue;      // xxx / asr_opt 等非音色目录
        let wavs = [];
        try { wavs = fs.readdirSync(wavDir).filter(f => /\.(wav|mp3|flac)$/i.test(f)).sort(); } catch (e) { }
        if (!wavs.length) continue;
        // ★ GPT-SoVITS 要求参考音频 3~10 秒：5-wav32k 是 32kHz/16bit 单声道 wav（64000 字节/秒），
        //   按大小挑一个落在范围内的，挑不到再退回第一个（让上游报真实错误）
        let refWav = wavs[0];
        for (const w of wavs) {
          let sz = 0;
          try { sz = fs.statSync(path.join(wavDir, w)).size; } catch (e) { continue; }
          if (sz >= 3 * 64000 && sz <= 10 * 64000) { refWav = w; break; }
        }
        voices.push({
          name: d,
          ref: path.join(wavDir, refWav),
          refCount: wavs.length,
          gptWeights: this._pickWeight(root, 'GPT_weights', d, /\.(ckpt|pth)$/i),
          sovitsWeights: this._pickWeight(root, 'SoVITS_weights', d, /\.pth$/i),
        });
      }
    } catch (e) { }
    // 无任何权重配对的目录（杂项/半成品）不进音色列表
    return voices.filter(v => v.gptWeights || v.sovitsWeights);
  }

  /** 在 <prefix>* 各目录里找以音色名开头的权重文件，取 epoch 最高的一个 */
  _pickWeight(root, prefix, voiceName, extRe) {
    let best = null;
    try {
      for (const d of fs.readdirSync(root)) {
        if (!d.startsWith(prefix)) continue;
        const wd = path.join(root, d);
        let st; try { st = fs.statSync(wd); } catch (e) { continue; }
        if (!st.isDirectory()) continue;
        for (const f of fs.readdirSync(wd)) {
          if (!extRe.test(f)) continue;
          // 音色名必须后跟 - 或 _（防「安」误匹配「安娜」）
          if (!(f === voiceName || f.startsWith(voiceName + '-') || f.startsWith(voiceName + '_'))) continue;
          const ep = Number((f.match(/e(\d+)/) || [0, 0])[1]) || 0;
          if (!best || ep > best.ep) best = { file: path.join(wd, f), ep };
        }
      }
    } catch (e) { }
    return best ? best.file : '';
  }

  /**
   * 合成。
   * @param {{text, ref?, auxRefs?, lang?, speed?, noCache?, cacheDir?, voice?}} opt
   *   voice（round75c）：音色名（logs/ 训练目录名）。传入后：
   *     · ref 换成该音色自己的训练音频（ref 不传 voice 的 ref 优先）
   *     · GPT/SoVITS 权重与当前加载的不同时，先调 /set_*_weights 热切换
   */
  async synthesize(opt) {
    const o = opt || {};
    const text = String(o.text || '').trim();
    if (!text) throw new Error('文本为空');
    if (this.state !== 'ready' && this.state !== 'external') await this.start();

    let ref = o.ref || this.cfg.refAudio;
    if (o.voice) {
      const v = await this._voiceByName(o.voice);
      if (!v) throw new Error('音色「' + o.voice + '」不存在（未在 logs/ 下找到训练目录）');
      // round76：用户自定义参考音优先（设置页「换参考音」写入 gptVoiceRefs）
      const custom = (this.cfg.gptVoiceRefs || {})[o.voice];
      if (custom && fs.existsSync(custom)) ref = custom;
      else if (v.ref && fs.existsSync(v.ref)) ref = v.ref;    // 音色自己的 ref 优先
      await this._switchWeights(v);
    }
    if (!ref || !fs.existsSync(ref)) throw new Error('未配置参考音频（refAudio）');
    const lang = normalizeLang(o.lang || this.cfg.lang);

    const cacheDir = o.cacheDir || this.cfg.cacheDir
      || path.join(process.env.APPDATA || '.', 'CinemaVault', 'tts-cache');
    try { if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { }

    const speed = Number(o.speed) > 0 ? Number(o.speed) : (Number(this.cfg.speed) || 1.0);
    const key = crypto.createHash('md5').update(['gpt1', text, ref, lang, speed, o.voice || ''].join('|')).digest('hex');
    const out = path.join(cacheDir, key + '.wav');
    if (!o.noCache) { try { if (fs.existsSync(out) && fs.statSync(out).size > 1000) return { path: out, cached: true }; } catch (e) { } }

    const buf = await this._postTts({
      text, lang, ref, out, speed,
      aux: (o.auxRefs && o.auxRefs.length) ? o.auxRefs : (this.cfg.auxRefAudios || null),
      split: this.cfg.textSplitMethod || 'cut5',
    });
    return { path: out, bytes: buf.length, cached: false, voice: o.voice || '' };
  }

  /** 按名字找音色（_scanVoices 结果内存缓存 60s，避免每次合成扫盘） */
  async _voiceByName(name) {
    if (!this._voiceCache || Date.now() - this._voiceCache.t > 60000) {
      this._voiceCache = { t: Date.now(), list: this._scanVoices(this._root()) };
    }
    return (this._voiceCache.list || []).find(v => v.name === name) || null;
  }

  /** 热切换 GPT/SoVITS 权重（api_v2 的 /set_gpt_weights、/set_sovits_weights） */
  async _switchWeights(v) {
    const jobs = [];
    if (v.gptWeights && v.gptWeights !== this._curGpt) {
      jobs.push(['set_gpt_weights', 'weights_path', v.gptWeights]);
    }
    if (v.sovitsWeights && v.sovitsWeights !== this._curSovits) {
      jobs.push(['set_sovits_weights', 'weights_path', v.sovitsWeights]);
    }
    for (const [ep, param, val] of jobs) {
      const url = this.base + '/' + ep + '?' + param + '=' + encodeURIComponent(val);
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('切换权重失败：/' + ep + ' HTTP ' + r.status);
      if (ep === 'set_gpt_weights') this._curGpt = v.gptWeights;
      else this._curSovits = v.sovitsWeights;
      console.log('[GPT-SoVITS] 已切换权重：/' + ep + ' → ' + val);
    }
    if (jobs.length) await new Promise(r2 => setTimeout(r2, 400));   // 模型装载缓冲
  }

  /** 调 api_v2 的 /tts。out 非空时落盘 */
  async _postTts(o) {
    const body = {
      text: o.text,
      text_lang: o.lang || 'zh',
      // ★ 反斜杠必须转正斜杠：FastAPI 收到 "D:\xxx\a.wav" 会挂
      ref_audio_path: String(o.ref).replace(/\\/g, '/'),
      prompt_text: o.promptText || '',
      prompt_lang: o.promptLang || o.lang || 'zh',
      text_split_method: o.split || 'cut5',
      media_type: 'wav',
      streaming_mode: false,
    };
    if (o.aux && o.aux.length) {
      body.aux_ref_audio_paths = o.aux.map(x => String(x).replace(/\\/g, '/'));
    }
    // 可选调参（不传就用服务端默认，避免传错反而变差）
    if (this.cfg.fragmentInterval != null) body.fragment_interval = Number(this.cfg.fragmentInterval);
    if (this.cfg.batchSize != null) body.batch_size = Number(this.cfg.batchSize);
    if (this.cfg.topK != null) body.top_k = Number(this.cfg.topK);
    if (this.cfg.topP != null) body.top_p = Number(this.cfg.topP);
    if (this.cfg.temperature != null) body.temperature = Number(this.cfg.temperature);
    if (this.cfg.repetitionPenalty != null) body.repetition_penalty = Number(this.cfg.repetitionPenalty);
    if (o.speed != null) body.speed_factor = Number(o.speed);

    const r = await fetch(this.base + '/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('HTTP ' + r.status + ' ' + String(t).slice(0, 160));
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('返回空音频');
    if (o.out) fs.writeFileSync(o.out, buf);
    return buf;
  }

  /* ============ 一键修复 ============ */

  /**
   * @param {'port'|'zombie'|'restart'|'none'} kind
   */
  async repair(kind) {
    const acts = [];
    // ① 清僵尸：端口在监听但服务不健康 → 查占用者是不是 python
    if (kind === 'port' || kind === 'zombie' || kind === 'restart') {
      const want = Number(this.cfg.port) || 9880;
      const listening = await P.isPortListening(want);
      const oa = listening ? await this._probeOpenApi(want, 2000) : { ok: false };
      if (listening && !oa.ok) {
        const owner = await P.getPortOwner(want);
        acts.push({ step: '检查端口 ' + want, result: owner ? `被 ${owner.name}(PID ${owner.pid}) 占用` : '被未知进程占用' });
        if (owner && /python/i.test(owner.name)) {
          const k = await P.killProcess(owner.pid);
          acts.push({ step: '结束占用进程 ' + owner.pid, result: k.ok ? '已结束' : '失败' });
        } else if (owner) {
          acts.push({ step: '跳过', result: `${owner.name} 不是 Python 服务，不擅自结束；可选择换端口` });
        }
      } else if (listening && oa.ok) {
        acts.push({ step: '检查端口 ' + want, result: '已有健康服务，无需处理' });
      } else {
        acts.push({ step: '检查端口 ' + want, result: '空闲' });
      }
    }
    if (kind === 'restart') {
      await this.stop();
      acts.push({ step: '停止本应用启动的服务', result: '完成' });
    }
    return { ok: true, acts };
  }
}

module.exports = { GptSovitsEngine, normalizeLang, LANGS };
