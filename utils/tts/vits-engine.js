/**
 * round74 · VITS 引擎（常驻进程 + 管道）
 *
 * 对应需求书「一键式 + 自愈」的能力：
 *   probe()   一键体检（委托 diagnostics）
 *   start()   一键唤起：spawn 常驻 worker + 加载模型
 *   stop()    自动关闭：只杀自己拉起的进程
 *   health()  健康检查：管道 ping + 模型是否就绪
 *   voices()  一键切音色：804 音色来自 speakers_list.txt
 *   synthesize() 合成（含缓存，避免同一句反复合成）
 *
 * 相比 GPT-SoVITS 的最大优势：**没有端口**，所以用户最担心的
 * 「端口占用 / Hyper-V 保留端口 / 僵尸进程」在这条路径上根本不存在。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./proc');

const WORKER = path.join(__dirname, 'vits_worker.py');

class VitsEngine {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.managed = null;      // P.spawnManaged 的返回
    this.pending = new Map();// id -> resolve
    this.seq = 0;
    this.bootedAt = 0;
    this.state = 'stopped';   // stopped | starting | ready | error
    this.lastError = '';
    this.stdoutBuf = '';
    this.speaking = null;    // 当前合成中的 promise 链（串行）
  }

  get name() { return 'VITS'; }
  get usesPort() { return false; }

  /* ---------- 生命周期 ---------- */

  isRunning() {
    return !!(this.managed && this.managed.proc && this.managed.proc.exitCode === null);
  }

  /** 一键唤起：拉起 worker 并加载模型 */
  async start() {
    if (this.isRunning() && this.state === 'ready') return { ok: true, already: true };

    const python = this.cfg.pythonPath;
    const dir = require('./vits-model').resolveDir(this.cfg.vitsDir);
    if (!python || !fs.existsSync(python)) throw new Error('未配置 Python 解释器路径');
    if (!dir || !fs.existsSync(dir)) throw new Error('VITS 目录不存在：' + dir);

    this.state = 'starting';
    this.lastError = '';
    this.stdoutBuf = '';
    this.pending.clear();

    // ★ 环境必须净化 + 三个 PYTHON* 变量，否则中文/日文音色名会乱码、输出会缓冲
    const env = P.buildChildEnv(python, [dir], { ...process.env, PYTHONPATH: dir });

    this.managed = P.spawnManaged(python, [WORKER, dir], {
      cwd: dir, env, name: 'vits-worker',
    });

    this.managed.proc.stdout.setEncoding('utf8');
    this.managed.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.managed.proc.stderr.on('data', (d) => { this.lastError = (this.lastError + d).slice(-2000); });
    this.managed.proc.on('exit', (code) => {
      this.state = code === 0 ? 'stopped' : 'error';
      // 让所有等待中的请求失败，别让调用方永久挂着
      for (const [, r] of this.pending) r.reject(new Error('VITS 进程已退出 (code=' + code + ')'));
      this.pending.clear();
    });

    // 等 worker 握手
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (this.stdoutBuf.includes('"booted"')) break;
      if (this.managed.proc.exitCode !== null) throw new Error('VITS 进程启动即退出：' + (this.lastError.slice(-300) || '（无输出）'));
      await new Promise(r => setTimeout(r, 120));
    }
    this.stdoutBuf = '';

    // 加载模型（实测 1.3s，但给足 180s 余量，冷启动可能更久）
    const r = await this._req({ op: 'load' }, 180000);
    this.state = 'ready';
    this.bootedAt = Date.now();
    return { ok: true, speakers: r.speakers, sr: r.sr, bootMs: Date.now() - t0 };
  }

  /** 自动关闭：只杀自己拉起的进程（VITS 本来就是我们 spawn 的） */
  async stop() {
    if (!this.isRunning()) { this.state = 'stopped'; return { ok: true, already: true }; }
    try { await this._req({ op: 'bye' }, 1500); } catch (e) { /* 正常，进程可能已走 */ }
    this.managed.kill();
    this.state = 'stopped';
    this.bootedAt = 0;
    return { ok: true };
  }

  /** 健康检查 */
  async health() {
    if (!this.isRunning()) return { ok: false, state: this.state, detail: '未运行' };
    try {
      const r = await this._req({ op: 'ping' }, 5000);
      return { ok: true, state: this.state, detail: r.ready ? '模型已就绪' : '进程活着但模型未加载', ready: r.ready };
    } catch (e) {
      return { ok: false, state: 'error', detail: String(e.message).slice(0, 120) };
    }
  }

  /** 空闲自动退出（省显存）—— 有新请求时自动复活 */
  enableIdleExit(ms = 10 * 60 * 1000) {
    this._idleMs = ms;
    this._resetIdle();
  }
  _resetIdle() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (!this._idleMs || !this.isRunning()) return;
    this._idleTimer = setTimeout(async () => {
      // 只在没有合成任务时退出
      if (!this.speaking) { try { await this.stop(); } catch (e) { } }
      else this._resetIdle();
    }, this._idleMs);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  /* ---------- 能力 ---------- */

  /** 一键切音色：返回全部音色（804） */
  /**
   * 音色列表。
   * ★ 音色名只存在 speakers_list.txt 里，**根本不需要加载模型**。
   *   之前这里写的是「没 ready 就先 start()」，为了列个音色要等 18 秒拉起 450MB 权重；
   *   后来又改成 peek 模式直接返回空 —— 结果用户在设置里一个音色都看不到（实测被用户投诉）。
   *   现在：引擎在跑就问它要，不在跑就直接读文件，永远秒回。
   */
  async voices() {
    if (this.state === 'ready') {
      try {
        const r = await this._req({ op: 'voices' }, 8000);
        if (r && r.speakers && r.speakers.length) return r.speakers;
      } catch (e) { /* 落到读文件 */ }
    }
    return this._readSpeakersFromDisk();
  }

  /** 直接读 speakers_list.txt（不碰模型） */
  _readSpeakersFromDisk() {
    try {
      const dir = require('./vits-model').resolveDir(this.cfg.vitsDir);
      if (!dir) return [];
      const sp = path.join(dir, 'speakers_list.txt');
      if (!fs.existsSync(sp)) return [];
      const lines = fs.readFileSync(sp, 'utf8').split(/\r?\n/);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        let s = (lines[i] || '').trim();
        if (!s) continue;
        // 文件里是 '0: 特别周' 这种格式，序号已在 id 里，名字里不要重复
        s = s.replace(/^\d+\s*[:：]\s*/, '');
        if (s) out.push({ id: i, name: s });
      }
      return out;
    } catch (e) { return []; }
  }

  /**
   * 合成。
   * @param {{text:string, speakerId?:number, speed?:number, noise?:number,
   *          lang?:string, cacheDir?:string, noCache?:boolean}} opt
   */
  async synthesize(opt) {
    const o = opt || {};
    const text = String(o.text || '').trim();
    if (!text) throw new Error('文本为空');
    if (this.state !== 'ready') await this.start();

    const cacheDir = o.cacheDir || this.cfg.cacheDir
      || path.join(process.env.APPDATA || '.', 'CinemaVault', 'tts-cache');
    try { if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { }

    // 同一句 + 同参数 → 命中缓存，不重复合成
    const key = crypto.createHash('md5').update(
      ['vits1', text, o.speakerId || 0, o.speed || 1, o.lang || 'zh'].join('|')).digest('hex');
    const out = path.join(cacheDir, key + '.wav');
    if (!o.noCache) { try { if (fs.existsSync(out) && fs.statSync(out).size > 1000) return { path: out, cached: true }; } catch (e) { } }

    // 串行化：避免多段同时进同一个模型导致显存爆
    const task = (this.speaking || Promise.resolve()).catch(() => { })
      .then(() => this._req({
        op: 'synth', text,
        speaker: o.speakerId || 0,
        noise: o.noise != null ? o.noise : 0.6,
        noise_w: 0.668,
        length: (o.speed && o.speed > 0) ? (1 / o.speed) : 1.2,
        lang: o.lang || 'zh',
        out,
      }, 300000));
    this.speaking = task;
    this._resetIdle();

    const r = await task;
    this.speaking = null;
    return { path: r.path, seconds: r.seconds, elapsed: r.elapsed, cached: false, sr: r.sr };
  }

  /* ---------- 内部 ---------- */

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.id == null) continue;                 // 握手广播
      const r = this.pending.get(msg.id);
      if (!r) continue;
      this.pending.delete(msg.id);
      if (msg.ok) r.resolve(msg.result || {});
      else r.reject(new Error(msg.error || 'VITS 调用失败'));
    }
  }

  _req(payload, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.isRunning()) return reject(new Error('VITS 未运行'));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('VITS 调用超时（' + Math.round(timeout / 1000) + 's）'));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.managed.proc.stdin.write(JSON.stringify(Object.assign({ id }, payload)) + '\n', 'utf8');
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id);
        reject(new Error('写管道失败：' + e.message));
      }
    });
  }
}

module.exports = { VitsEngine, WORKER };
