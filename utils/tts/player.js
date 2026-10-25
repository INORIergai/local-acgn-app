/**
 * round74 · TTS 音频播放
 *
 * 方案选择：**ffplay 子进程**。
 * Alife 用的是 .NET 的 NAudio，Electron 没有等价物。两个候选：
 *   ① Web Audio API：零新依赖，但必须等 wav 落盘才能播（首音慢 1~2 秒），且做不了流式
 *   ② ffplay：能吃管道流（首音低）、不受 Electron 音频策略和页面切换影响、稳定
 * 用户的取向是「哪个最稳定用哪个」⇒ 选 ffplay。
 *
 * ⚠️ 必须加 -nodisp：ffplay 默认会弹一个视频窗口出来。
 * ⚠️ 全局单播放互斥（对应 Alife 的 PlaybackGate SemaphoreSlim(1,1)）：
 *    同一时刻只允许一段音频在放，新的会打断旧的。
 */

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

let current = null;   // { proc, file, startedAt }

/**
 * 解析可用的 ffplay 路径。
 * 用户在设置里填的可能是：
 *   - ffplay.exe 全路径 → 直接用
 *   - ffmpeg.exe 全路径  → 自动找同目录的 ffplay.exe（ffmpeg.exe 播不了音频）
 *   - 目录              → 目录下的 ffplay.exe
 *   - 留空              → 系统 PATH 里的 ffplay
 */
function ffmpegBin(cfg) {
  const c = (cfg && cfg.ffmpegPath) || '';
  if (c) {
    try {
      const st = fs.statSync(c);
      if (st.isDirectory()) {
        const f = path.join(c, 'ffplay.exe');
        if (fs.existsSync(f)) return f;
      } else if (/ffplay(\.exe)?$/i.test(c)) {
        return c;
      } else if (/ffmpeg(\.exe)?$/i.test(c)) {
        // 用户填了 ffmpeg.exe：播放要的是同目录的 ffplay.exe
        const sib = path.join(path.dirname(c), 'ffplay.exe');
        if (fs.existsSync(sib)) return sib;
      }
    } catch (e) { /* 路径不存在 → 落回 PATH */ }
  }
  return 'ffplay';
}

/** 试着用 PATH 里的 ffplay；找不到就返回 false（调用方决定是否降级） */
function hasFfmpeg(cfg) {
  return new Promise((resolve) => {
    const bin = ffmpegBin(cfg);
    execFile(bin, ['-version'], { timeout: 5000, windowsHide: true },
      (err) => resolve(!err));
  });
}

function stopAll() {
  if (current && current.proc) {
    try { current.proc.kill(); } catch (e) { }
  }
  current = null;
  return { ok: true };
}

/**
 * 播放一个 wav。
 * @param {string} file
 * @param {{ffmpegPath?:string, onEnd?:Function}} opt
 */
function playFile(file, opt) {
  const o = opt || {};
  return new Promise((resolve, reject) => {
    if (!file || !fs.existsSync(file)) return reject(new Error('音频文件不存在'));
    // 单播放互斥：新的打断旧的
    stopAll();

    const bin = ffmpegBin(o);
    const args = [
      '-nodisp',              // ★ 绝不能弹视频窗口
      '-autoexit',
      '-loglevel', 'quiet',
      // ★ 不能加 -playmode：ffplay 没有这个选项，加了会立刻退出（退出码 1），
      //   之前把退出码 1 当成功 → 「播放成功」却一点声音都没有（round74b 事故）
      file,
    ];
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      return reject(new Error('无法启动 ' + bin + '：' + e.message));
    }
    current = { proc, file, startedAt: Date.now() };

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      const ms = Date.now() - (current ? current.startedAt : Date.now());
      if (current && current.proc === proc) current = null;
      if (o.onEnd) { try { o.onEnd(err); } catch (e) { } }
      err ? reject(err) : resolve({ ok: true, file, ms });
    };
    proc.on('error', (e) => done(new Error('播放失败：' + e.message + '（找不到 ' + bin + '？请在体检里指定 ffplay 路径）')));
    proc.on('exit', (code) => {
      // 0 = 正常播完（-autoexit）；null = 被信号杀；255 = ffplay 被打断的传统退出码
      if (code === 0 || code === null || code === 255) done(null);
      else done(new Error('播放进程退出码 ' + code + '（ffplay 参数或音频文件有问题）'));
    });
  });
}

/** 估算时长（秒），用于前端显示进度 */
function durationOf(file) {
  return new Promise((resolve) => {
    try {
      const stat = fs.statSync(file);
      // 22050Hz 单声道 16bit = 44100 B/s；读 wav 头拿真实值
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64);
      fs.readSync(fd, buf, 0, 64, 0);
      fs.closeSync(fd);
      if (buf.slice(0, 4).toString('ascii') === 'RIFF') {
        // 找 fmt 与 data chunk
        let off = 12, byteRate = 44100, dataSize = 0;
        while (off < 56) {
          const id = buf.slice(off, off + 4).toString('ascii');
          const sz = buf.readUInt32LE(off + 4);
          if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
          if (id === 'data') { dataSize = sz; break; }
          off += 8 + sz + (sz % 2);
        }
        if (byteRate > 0 && dataSize > 0) return resolve(Math.round(dataSize / byteRate * 10) / 10);
      }
      void stat;
    } catch (e) { }
    resolve(0);
  });
}

function status() {
  return {
    playing: !!(current && current.proc && current.proc.exitCode === null),
    file: current ? current.file : '',
  };
}

module.exports = { playFile, stopAll, status, hasFfmpeg, durationOf, ffmpegBin };
