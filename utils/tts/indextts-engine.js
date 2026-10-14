/**
 * utils/tts/indextts-engine.js —— IndexTTS-2 本地语音引擎
 * ============================================================================
 * round85 重构：旧版 synthesize 是**空壳**（直接返回一个从不落盘的 wav 路径，
 * 前端拿 code:0 但音频 404 → 选了 IndexTTS 就永远没声音）。
 * 现在与 breeze-engine.js 共用同一套「常驻 worker + stdin/stdout 逐行 JSON」
 * 模式：模型冷启动加载一次（约 1~3 分钟）后常驻显存，进度实时上报。
 * 音色 = 零样本克隆：直接复用 voices_catalog.json 的 30 款角色参考音频。
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnManaged, buildChildEnv } = require('./proc');

const INDEXTTS_ROOT = 'D:\\TTS model\\index-tts';
const INDEXTTS_PYTHON = 'D:\\TTS model\\index-tts\\.venv311\\Scripts\\python.exe';
const INDEXTTS_MODEL = 'D:\\TTS model\\index-tts\\checkpoints\\IndexTTS-2';
const INDEXTTS_CODE = 'D:\\TTS model\\index-tts\\code\\index-tts-main';
const VOICES_CATALOG_FILE = 'D:\\TTS model\\voices\\voices_catalog.json';
const WORKER_SCRIPT = path.join(__dirname, 'index_worker.py');

class IndexTtsEngine {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.name = 'indextts';
    this.state = 'cold';
    this.progressMsg = '';
    this.port = 0;
    this.lastError = '';
    this.cacheDir = cfg.cacheDir || path.resolve(__dirname, '../../cache/tts-cache');
    try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch (e) {}
    this._worker = null;
    this._buf = '';
    this._pending = null;
    this._seq = 0;
    this._chain = Promise.resolve();
  }

  isInstalled() {
    return fs.existsSync(INDEXTTS_PYTHON) && fs.existsSync(INDEXTTS_MODEL) && fs.existsSync(INDEXTTS_CODE);
  }

  isRunning() {
    return !!(this._worker && this._worker.proc && this._worker.proc.exitCode === null);
  }

  _setStatus(state, msg) {
    this.state = state;
    if (msg != null) this.progressMsg = msg;
  }

  async start() {
    if (!this.isInstalled()) {
      throw new Error(`IndexTTS-2 环境不存在，请检查 ${INDEXTTS_ROOT}`);
    }
    if (this.isRunning()) return { ok: true, state: this.state, engine: 'indextts' };

    this._setStatus('starting', '启动推理进程…');
    this.lastError = '';

    const logFile = path.join(this.cacheDir, 'indextts-worker.log');
    const env = buildChildEnv(INDEXTTS_PYTHON, [INDEXTTS_CODE]);
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.PYTHONUNBUFFERED = '1';

    const args = [WORKER_SCRIPT, '--code', INDEXTTS_CODE, '--model', INDEXTTS_MODEL, '--log', logFile];
    const m = spawnManaged(INDEXTTS_PYTHON, args, {
      cwd: INDEXTTS_CODE, env, name: 'indextts-worker',
      idleExitMs: (Number(this.cfg.idleExitMinutes) || 30) * 60000,
    });
    this._worker = m;

    m.proc.stdout.on('data', (d) => this._onStdout(d));
    m.proc.on('exit', (code) => {
      this._worker = null;
      this._setStatus('cold', null);
      if (this._pending) {
        clearTimeout(this._pending.timer);
        const p = this._pending; this._pending = null;
        p.reject(new Error('IndexTTS 推理进程退出（code ' + code + '）' + (this.lastError ? '：' + this.lastError.slice(-200) : '')));
      }
    });

    await this._waitReady(420000);
    return { ok: true, state: this.state, engine: 'indextts' };
  }

  _waitReady(timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.state === 'ready') return resolve();
        if (this.state === 'error') return reject(new Error(this.progressMsg || 'IndexTTS 模型加载失败'));
        if (!this.isRunning()) return reject(new Error(this.lastError || 'IndexTTS 推理进程未存活'));
        if (Date.now() - t0 > timeoutMs) return reject(new Error('IndexTTS 模型加载超时'));
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
    if (o.id != null && this._pending && this._pending.id === o.id && o.type !== 'progress') {
      clearTimeout(this._pending.timer);
      const p = this._pending; this._pending = null;
      if (o.ok) p.resolve(o);
      else p.reject(new Error(String(o.error || '合成失败').slice(-400)));
    }
  }

  async stop() {
    if (this._worker) {
      try { this._worker.kill(); } catch (e) {}
      this._worker = null;
    }
    if (this._pending) {
      clearTimeout(this._pending.timer);
      const p = this._pending; this._pending = null;
      p.reject(new Error('IndexTTS 推理进程已停止'));
    }
    this._setStatus('cold', null);
    return { ok: true, state: 'stopped' };
  }

  /**
   * 健康检查（/status 轮询用，毫秒级；真实进度看 state/progressMsg）。
   * ★ 缺这个方法时 /status 会抛 TypeError: e.health is not a function。
   */
  async health(quick) {
    if (!this.isInstalled()) {
      const miss = [];
      if (!fs.existsSync(INDEXTTS_PYTHON)) miss.push('Python 环境 ' + INDEXTTS_PYTHON);
      if (!fs.existsSync(INDEXTTS_MODEL)) miss.push('模型 ' + INDEXTTS_MODEL);
      return { ok: false, state: 'error', detail: '环境未就绪：缺少 ' + (miss.join('；') || '未知项'), quick: !!quick };
    }
    if (this.state === 'ready' && !this.isRunning()) this._setStatus('cold', null);
    return {
      ok: this.isRunning() || this.state === 'cold',
      state: this.state,
      detail: this.state === 'ready' ? 'IndexTTS-2 模型已常驻显存'
        : this.state === 'cold' ? 'IndexTTS-2 环境就绪（未启动，首次合成时自动加载约 1~3 分钟）'
        : (this.progressMsg || '正在启动'),
      quick: !!quick,
    };
  }

  /** 音色 = 零样本克隆参考音频：复用 voices_catalog.json（30 款角色） */
  async voices() {
    const list = [];
    if (fs.existsSync(VOICES_CATALOG_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(VOICES_CATALOG_FILE, 'utf8'));
        raw.forEach((item) => {
          if (!item.character || !item.audio_path) return;
          if (list.some(v => v.name === item.character)) return;
          list.push({ id: item.character, name: item.character, refAudio: item.audio_path, lang: 'zh' });
        });
      } catch (e) { /* 走默认音色 */ }
    }
    if (!list.length) {
      list.push({ id: 'index_default', name: 'IndexTTS 默认声线', lang: 'zh', refAudio: '' });
    }
    return list;
  }

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
    if (!this.isInstalled()) throw new Error('IndexTTS 环境未就绪');

    const cleanText = text.trim();

    // 参考音频：显式 ref 优先，其次按音色名查 catalog，兜底第一个角色
    let refAudio = opts.ref || '';
    if (!refAudio) {
      try {
        const vs = await this.voices();
        const want = opts.voice || this.cfg.indexVoice || '';
        const hit = vs.find(v => v.name === want) || vs[0];
        refAudio = hit ? hit.refAudio : '';
      } catch (e) { /* 保持空 → worker 报错提示 */ }
    }

    const hash = crypto.createHash('sha256')
      .update(`indextts:${path.basename(String(refAudio || ''))}:${cleanText}`).digest('hex').slice(0, 32);
    const outWav = path.join(this.cacheDir, `index_${hash}.wav`);

    if (fs.existsSync(outWav) && fs.statSync(outWav).size > 1024) {
      return { path: outWav, wavPath: outWav, durationSec: 0, cached: true };
    }

    const run = () => this._dispatch({ text: cleanText, refAudio, output: outWav });
    const result = await (this._chain = this._chain.then(run, run));
    return {
      path: result.path || outWav,
      wavPath: result.path || outWav,
      durationSec: result.durationSec || 0,
      genSec: result.genSec || 0,
      cached: false
    };
  }

  _dispatch({ text, refAudio, output }) {
    const id = 'r' + (++this._seq);
    return new Promise((resolve, reject) => {
      if (!this.isRunning()) this.start().catch(e => reject(e));
      const waitStart = () => {
        if (!this.isRunning()) { setTimeout(waitStart, 300); return; }
        const timer = setTimeout(() => {
          if (this._pending && this._pending.id === id) {
            this._pending = null;
            reject(new Error('IndexTTS 合成超时（10 分钟）'));
          }
        }, 600000);
        this._pending = { id, resolve, reject, timer };
        try {
          this._worker.proc.stdin.write(JSON.stringify({
            id, cmd: 'synth', text, refAudio, output,
          }) + '\n');
        } catch (e) {
          clearTimeout(timer); this._pending = null;
          reject(new Error('IndexTTS worker 通信失败：' + e.message));
        }
      };
      if (this.state !== 'ready') {
        const t0 = Date.now();
        const tick = () => {
          if (this.state === 'ready') return waitStart();
          if (this.state === 'error') return reject(new Error(this.progressMsg || 'IndexTTS 模型加载失败'));
          if (!this.isRunning()) return reject(new Error('IndexTTS 推理进程未存活'));
          if (Date.now() - t0 > 420000) return reject(new Error('等待 IndexTTS 模型就绪超时'));
          setTimeout(tick, 500);
        };
        tick();
      } else {
        waitStart();
      }
    });
  }
}

module.exports = {
  IndexTtsEngine,
  INDEXTTS_ROOT,
  INDEXTTS_PYTHON
};
