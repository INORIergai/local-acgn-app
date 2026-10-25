/**
 * utils/tts/breeze-engine.js —— Breeze-TTS-2 本地高质量克隆语音引擎
 * ============================================================================
 * round85 重构：**按次 spawn infer.py → 常驻 worker 进程**。
 *   旧方式每次合成都要重新把 7GB 模型灌进显存（约 1~2 分钟），这就是
 *   「首次启动后两分钟没声音」「点开始朗读两分钟无语音」「合成速度与测试
 *   结果完全不符（测试是常驻进程）」三个问题的同一个根因。
 *   现在模型只加载一次（breeze_worker.py，stdin/stdout 逐行 JSON 协议），
 *   加载进度实时上报（/api/tts/status 可轮询），前端可以显示「模型加载中」。
 * 音色来源不变：D:\TTS model\voices\voices_catalog.json 的 30 款角色音色。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnManaged, buildChildEnv } = require('./proc');

const BREEZE_ROOT = 'D:\\TTS model\\breeze-tts';
const BREEZE_MODEL = 'D:\\TTS model\\Breeze-TTS-2';
const BREEZE_PYTHON = 'D:\\TTS model\\breeze-tts\\.venv\\Scripts\\python.exe';
const VOICES_CATALOG_FILE = 'D:\\TTS model\\voices\\voices_catalog.json';
const WORKER_SCRIPT = path.join(__dirname, 'breeze_worker.py');

class BreezeEngine {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.name = 'breeze';
    this.state = 'cold';    // cold → starting → loading → warming → ready | error
    this.progressMsg = '';  // 给前端轮询的人话进度
    this.port = 0;          // 无 HTTP 端口
    this.lastError = '';
    this.cacheDir = cfg.cacheDir || path.resolve(__dirname, '../../cache/tts-cache');
    try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch (e) {}
    this._worker = null;    // spawnManaged 返回值
    this._buf = '';         // stdout 行缓冲
    this._pending = null;   // { id, resolve, reject, timer }
    this._seq = 0;
    this._chain = Promise.resolve();  // 请求串行队列
    this._forceCpu = false;
  }

  isInstalled() {
    return fs.existsSync(BREEZE_PYTHON) && fs.existsSync(BREEZE_MODEL);
  }

  isRunning() {
    return !!(this._worker && this._worker.proc && this._worker.proc.exitCode === null);
  }

  _setStatus(state, msg) {
    this.state = state;
    if (msg != null) this.progressMsg = msg;
  }

  /* ---------------- worker 生命周期 ---------------- */

  async start(forceCpu = false) {
    if (!this.isInstalled()) {
      throw new Error(`Breeze-TTS-2 环境不存在，请检查 ${BREEZE_ROOT} 与 ${BREEZE_MODEL}`);
    }
    if (this.isRunning() && (!forceCpu || this._forceCpu)) {
      return { ok: true, state: this.state, engine: 'breeze' };
    }
    if (this.isRunning()) this.stopWorker();      // GPU → CPU 重启场景

    this._forceCpu = !!forceCpu;
    this._setStatus('starting', '启动推理进程…');
    this.lastError = '';

    const logFile = path.join(this.cacheDir, 'breeze-worker.log');
    const env = buildChildEnv(BREEZE_PYTHON, [BREEZE_ROOT]);
    env.PYTHONPATH = BREEZE_ROOT + (env.PYTHONPATH ? ';' + env.PYTHONPATH : '');
    env.TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER = '0';   // Windows Inductor 溢出规避
    env.PYTORCH_CUDA_ALLOC_CONF = 'expandable_segments:True';
    if (forceCpu) env.CUDA_VISIBLE_DEVICES = '';

    const args = [WORKER_SCRIPT, BREEZE_MODEL, '--repo', BREEZE_ROOT, '--log', logFile];
    const m = spawnManaged(BREEZE_PYTHON, args, {
      cwd: BREEZE_ROOT, env, name: 'breeze-worker',
      idleExitMs: (Number(this.cfg.idleExitMinutes) || 30) * 60000,
    });
    this._worker = m;

    m.proc.stdout.on('data', (d) => this._onStdout(d));
    m.proc.stderr.on('data', (d) => { /* stderr 已被 worker 重定向到日志文件 */ });
    m.proc.on('exit', (code) => {
      this._worker = null;
      this._setStatus('cold', null);
      if (this._pending) {
        clearTimeout(this._pending.timer);
        const p = this._pending; this._pending = null;
        p.reject(new Error('Breeze 推理进程退出（code ' + code + '）' + (this.lastError ? '：' + this.lastError.slice(-200) : '')));
      }
    });

    // 等 worker 报 ready（首次要加载 7GB 权重，给足 6 分钟）
    await this._waitReady(360000);
    return { ok: true, state: this.state, engine: 'breeze' };
  }

  _waitReady(timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.state === 'ready') return resolve();
        if (this.state === 'error') return reject(new Error(this.progressMsg || 'Breeze 模型加载失败'));
        if (!this.isRunning()) return reject(new Error(this.lastError || 'Breeze 推理进程未存活'));
        if (Date.now() - t0 > timeoutMs) return reject(new Error('Breeze 模型加载超时（' + Math.round(timeoutMs / 1000) + 's）'));
        setTimeout(tick, 500);
      };
      tick();
    });
  }

  _onStdout(chunk) {
    this._buf += chunk.toString('utf-8');
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      this._onMessage(o);
    }
  }

  _onMessage(o) {
    if (o.type === 'status') {
      // starting/loading/warming/error 由 worker 主动推
      this._setStatus(o.stage === 'ready' ? 'ready' : (o.stage || 'loading'), o.msg || '');
      if (o.stage === 'error') this.lastError = o.msg || '';
      return;
    }
    if (o.type === 'ready') {
      this._setStatus('ready', o.loadSec != null ? `模型就绪（加载 ${o.loadSec}s）` : '模型就绪');
      return;
    }
    if (o.type === 'load_error') {
      this.lastError = String(o.error || '').slice(-300);
      this._setStatus('error', '模型加载失败');
      return;
    }
    if (o.id != null && this._pending && this._pending.id === o.id) {
      if (o.type === 'progress') {
        if (this._pending.onProgress) {
          try { this._pending.onProgress(o); } catch (e) {}
        }
        return;
      }
      // round87 真流式：worker 逐 chunk 推 base64 PCM16，转发给调用方（边合成边播）
      if (o.type === 'audio') {
        if (this._pending.onChunk) {
          try { this._pending.onChunk(Buffer.from(o.pcm, 'base64'), o.sr || 24000); } catch (e) {}
        }
        return;
      }
      clearTimeout(this._pending.timer);
      const p = this._pending; this._pending = null;
      if (o.ok) p.resolve(o);
      else p.reject(new Error(String(o.error || '合成失败').slice(-400)));
    }
  }

  stopWorker() {
    if (this._worker) {
      try { this._worker.kill(); } catch (e) {}
      this._worker = null;
    }
    if (this._pending) {
      clearTimeout(this._pending.timer);
      const p = this._pending; this._pending = null;
      p.reject(new Error('Breeze 推理进程已停止'));
    }
    this._setStatus('cold', null);
  }

  async stop() {
    this.stopWorker();
    return { ok: true, state: 'stopped' };
  }

  /**
   * 健康检查（/status 轮询用，毫秒级；真实进度看 state/progressMsg）。
   */
  async health(quick) {
    if (!this.isInstalled()) {
      const miss = [];
      if (!fs.existsSync(BREEZE_PYTHON)) miss.push('Python 环境 ' + BREEZE_PYTHON);
      if (!fs.existsSync(BREEZE_MODEL)) miss.push('模型 ' + BREEZE_MODEL);
      return { ok: false, state: 'error', detail: '环境未就绪：缺少 ' + (miss.join('；') || '未知项'), quick: !!quick };
    }
    if (this.state === 'ready' && !this.isRunning()) {
      // worker 挂了但状态没跟上（兜底）
      this._setStatus('cold', null);
    }
    return {
      ok: this.isRunning() || this.state === 'cold',
      state: this.state,
      detail: this.state === 'ready' ? 'Breeze-TTS 模型已常驻显存'
        : this.state === 'cold' ? 'Breeze-TTS 环境就绪（未启动，首次合成时自动加载约 1~2 分钟）'
        : (this.progressMsg || '正在启动'),
      quick: !!quick,
    };
  }

  /**
   * 获取所有可用音色列表（voices_catalog.json + voices 目录扫描）。
   */
  async voices() {
    const list = [];
    const seenNames = new Set();
    const VOICES_ROOT = path.resolve('D:/TTS model/voices');

    // 1. 读取权威 catalog JSON
    if (fs.existsSync(VOICES_CATALOG_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(VOICES_CATALOG_FILE, 'utf8'));
        raw.forEach((item, index) => {
          if (!item.character || seenNames.has(item.character)) return;
          seenNames.add(item.character);
          const isGenshin = item.source === 'genshin_official' || (item.audio_path && item.audio_path.includes('genshin'));
          list.push({
            id: item.character || `voice_${index}`,
            name: item.character,
            refText: item.text || item.character,
            refAudio: item.audio_path,
            source: item.source || 'local',
            group: isGenshin ? '原神角色库' : '本地自备音色',
            duration: item.duration,
            sampleRate: item.sample_rate
          });
        });
      } catch (e) {
        console.warn('[BreezeEngine] 读取 catalog 异常:', e.message);
      }
    }

    // 2. 安全扫描已知的 local 与 genshin 子目录
    for (const sub of ['local', 'genshin']) {
      const subDir = path.resolve(VOICES_ROOT, sub);
      if (!subDir.startsWith(VOICES_ROOT + path.sep)) continue;
      if (!fs.existsSync(subDir)) continue;
      try {
        const files = fs.readdirSync(subDir);
        for (const f of files) {
          const safeName = path.basename(f);
          if (!safeName.toLowerCase().endsWith('.wav')) continue;
          const charName = path.basename(safeName, path.extname(safeName));
          if (seenNames.has(charName)) continue;
          seenNames.add(charName);

          const fullAudio = path.resolve(subDir, safeName);
          if (!fullAudio.startsWith(subDir + path.sep)) continue;

          let text = charName;
          const jsonTarget = path.resolve(subDir, charName + '.json');
          if (jsonTarget.startsWith(subDir + path.sep) && fs.existsSync(jsonTarget)) {
            try { text = JSON.parse(fs.readFileSync(jsonTarget, 'utf8')).text || text; } catch (e) {}
          }

          list.push({
            id: charName,
            name: charName,
            refText: text,
            refAudio: fullAudio,
            source: sub === 'genshin' ? 'genshin_official' : 'local_file',
            group: sub === 'genshin' ? '原神角色库' : '本地自备音色',
            duration: 0,
            sampleRate: 44100
          });
        }
      } catch (e) {}
    }

    return list;
  }

  /**
   * 合成语音（自适应多重签名：支持 synthesize(opt) 和 synthesize(text, opt)）。
   * 模型常驻后这里只做：缓存判定 → 排队 → 发请求 → 等回包。
   */
  async synthesize(textOrOpt, maybeOpts = {}) {
    let text = '', opts = {};
    if (typeof textOrOpt === 'string') {
      text = textOrOpt;
      opts = maybeOpts || {};
    } else if (textOrOpt && typeof textOrOpt === 'object') {
      text = textOrOpt.text || '';
      opts = textOrOpt;
    }

    if (!text || !text.trim()) throw new Error('合成文本为空');
    if (!this.isInstalled()) throw new Error('Breeze-TTS 环境未就绪');

    const cleanText = text.trim();
    const voiceList = await this.voices();
    const targetVoiceName = opts.voice || opts.character || this.cfg.breezeVoice || '爱弥斯';
    const voiceInfo = voiceList.find(v => v.name === targetVoiceName) || voiceList[0];

    if (!voiceInfo) throw new Error('未找到可用参考音色');

    // 缓存哈希判定：相同文本 + 相同角色，命中缓存直接出
    const hash = crypto.createHash('sha256').update(`breeze:${voiceInfo.name}:${cleanText}`).digest('hex').slice(0, 32);
    const outWav = path.join(this.cacheDir, `breeze_${hash}.wav`);

    if (fs.existsSync(outWav) && fs.statSync(outWav).size > 1024) {
      return {
        path: outWav,
        wavPath: outWav,
        durationSec: 0,
        cached: true,
        voice: voiceInfo.name
      };
    }

    // 常驻 worker：串行队列（worker 一次只能合成一条，避免请求互相踩）
    // round87：opts.onChunk 存在时进入流式模式 —— worker 每个 audio chunk 产出即回调
    const run = () => this._dispatch({
      text: cleanText,
      refAudio: voiceInfo.refAudio,
      refText: voiceInfo.refText,
      output: outWav,
      onProgress: opts.onProgress,
      onChunk: typeof opts.onChunk === 'function' ? opts.onChunk : null,
    });
    const result = await (this._chain = this._chain.then(run, run));

    // GPU 推理崩了 → 关键词命中时降级 CPU 重启 worker 重试一次
    if (result && result.__gpuFail) {
      console.warn('[BreezeEngine] GPU 推理失败，降级 CPU 重启重试：', String(result.error).slice(0, 200));
      this.stopWorker();
      await this.start(true);
      const retry = await (this._chain = this._chain.then(run, run));
      if (retry && retry.__gpuFail) throw new Error('Breeze 推理失败（GPU/CPU 均尝试）：' + String(retry.error).slice(-300));
      return this._toResult(retry, outWav, voiceInfo.name);
    }
    return this._toResult(result, outWav, voiceInfo.name);
  }

  _toResult(r, outWav, voiceName) {
    return {
      path: r.path || outWav,
      wavPath: r.path || outWav,
      durationSec: r.durationSec || 0,
      sampleRate: r.sampleRate || 0,
      genSec: r.genSec || 0,
      cached: false,
      voice: voiceName
    };
  }

  /** 发一条合成请求给 worker 并等回包（单飞 + 超时）；onChunk 用于 round87 流式 PCM */
  _dispatch({ text, refAudio, refText, output, onProgress, onChunk }) {
    const id = 'r' + (++this._seq);
    return new Promise((resolve, reject) => {
      if (!this.isRunning()) {
        // worker 意外退出 → 这里拉起来再发
        this.start(this._forceCpu).catch(e => reject(e));
      }
      const waitStart = () => {
        if (!this.isRunning()) { setTimeout(waitStart, 300); return; }
        const timer = setTimeout(() => {
          if (this._pending && this._pending.id === id) {
            this._pending = null;
            reject(new Error('Breeze 合成超时（10 分钟）'));
          }
        }, 600000);
        this._pending = { id, resolve, reject, timer, onProgress, onChunk };
        try {
          this._worker.proc.stdin.write(JSON.stringify({
            id, cmd: 'synth', text, refAudio, refText, output, seed: 42,
          }) + '\n');
        } catch (e) {
          clearTimeout(timer); this._pending = null;
          reject(new Error('Breeze worker 通信失败：' + e.message));
        }
      };
      if (this.state !== 'ready') {
        // 未就绪：先等 ready 再发（start() 已在跑）
        const t0 = Date.now();
        const tick = () => {
          if (this.state === 'ready') return waitStart();
          if (this.state === 'error') return reject(new Error(this.progressMsg || 'Breeze 模型加载失败'));
          if (!this.isRunning()) return reject(new Error('Breeze 推理进程未存活'));
          if (Date.now() - t0 > 360000) return reject(new Error('等待 Breeze 模型就绪超时'));
          setTimeout(tick, 500);
        };
        tick();
      } else {
        waitStart();
      }
    }).then(r => r, (e) => {
      const msg = String(e && e.message || e);
      // GPU 相关失败标记出来给上层降级
      if (!this._forceCpu && /CUDA|out of memory|cuda_launcher|inductor|triton|device-side/i.test(msg)) {
        return { __gpuFail: true, error: msg };
      }
      throw e;
    });
  }
}

module.exports = {
  BreezeEngine,
  BREEZE_ROOT,
  BREEZE_MODEL,
  BREEZE_PYTHON
};
