/**
 * round74 · 小说阅读器朗读（按段高亮 + 断点续播）
 * round74c · 语速/音色调节 + 自动下一章 + 配置实时同步
 * round76 · 听书核心重构：
 *   · 修复「掐段」：playUrl 改 ended 事件驱动。旧实现 play() 开始即 resolve，
 *     for 循环立刻合成下一块，完成后直接覆盖 media.src —— 正在播的块被硬切，
 *     每块只播了「下一块的合成耗时」（听感严重漏段、缓存命中时只蹦几个字）。
 *   · 预取流水线：播放第 n 块时后台合成第 n+1 块（含跨段预取），段间无缝。
 *   · 首块切短（~90 字）：点朗读后先出声再续，感知首字大幅提前。
 *   · GPT 引擎语速走前端 playbackRate（无损），VITS 保持引擎侧变速。
 *   · 分页模式禁用 scrollIntoView（overflow:hidden 的固定页上滚动外层 → 视觉乱跳）。
 *   · 页驱动连播（对齐微信读书/番茄）：页读完自动翻下一页、空页自动跳过、
 *     章末自动切下一章、全书末页停止并标记已读完；滚动模式保持章驱动。
 *   · 依赖 novel-reader.html 暴露的 window.NovelNav —— currentChapter 等是 let
 *     顶层变量不挂 window，旧代码读 window.currentChapter 永远 undefined，
 *     「自动下一章」实际固定 loadChapter(1)（跳第 2 章）的根因。
 */
(function () {
  'use strict';

  const API = '/api/tts';
  let media = null;          // HTMLAudioElement
  let playToken = 0;         // 播放代：pause/stop 时 ++，作废挂起的播放回调
  let paras = [];            // 当前页/章的段落 DOM
  let idx = -1;              // 当前段索引
  let playing = false;
  let stopped = true;
  let token = 0;             // 会话令牌，切章/停止时作废旧的异步回调
  let cfg = null;
  let bar = null;
  let userStop = false;      // 用户主动停止/暂停 → 自动连播链条中断
  let autoContinue = false;  // 正在自动切章途中，章节变化监听不要打断
  let chaining = false;      // 自动连播推进途中（start 遇空页时据此继续跳）
  let firstIdx = -1;         // 起播段索引（首块切短用）
  let prefetchLive = null;   // { key, p, tk } 后台预取中的合成
  let voiceCache = null;     // { vits:[{id,name}] | gpt:{voiceList,emotions} }

  // 语速/自动连播：本地记忆优先，没有就跟随全局配置
  const LS_SPEED = 'nvTtsSpeed', LS_AUTO = 'nvTtsAutoNext';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function novelId() {
    const m = location.search.match(/[?&]id=(\d+)/) || location.search.match(/[?&]novel=(\d+)/);
    return m ? Number(m[1]) : (window.currentReaderBookId || 0);
  }

  async function api(path, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    // round85：180s → 300s。breeze/indextts 首次合成要现场加载 7GB 模型（约 2 分钟），
    // 180s 会把「模型加载 + 合成」的整体耗时掐断，表现为朗读直接报错
    const r = await fetch(API + path, Object.assign({ signal: AbortSignal.timeout(300000) }, opt));
    const j = await r.json().catch(() => ({ code: -1, msg: 'HTTP ' + r.status }));
    if (j.code !== 0) throw new Error(j.msg || '失败');
    return j.data;
  }

  /**
   * round85：等语音引擎真正可用（含现场加载模型的进度展示）。
   * 旧流程点「开始朗读」后前端完全不感知引擎状态 —— 模型加载两分钟，用户看到的是
   * 两分钟静默。现在：未就绪 → 自动 POST /start 并轮询 /status，实时刷新进度文案。
   */
  async function ensureEngineReady(tk, onMsg) {
    const say = (m) => { try { (onMsg || (() => {}))(m); } catch (e) {} };
    const st = await api('/status?engine=' + cfg.engine).catch(() => null);
    if (st && (st.state === 'ready' || st.state === 'running')) return;
    if (st && st.state === 'error') throw new Error(st.msg || '语音引擎异常');
    // 未启动 → 后台拉起（服务端 15s 后也会自动预热，这里兜底手动触发）
    say('语音引擎启动中…');
    await fetch(API + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: cfg.engine }) });
    const t0 = Date.now();
    while (Date.now() - t0 < 420000) {   // 最长等 7 分钟（首次冷加载 ~2 分钟 + 余量）
      if (tk !== token || stopped) throw new Error('已停止');
      const s = await api('/status?engine=' + cfg.engine).catch(() => null);
      if (s) {
        if (s.state === 'ready') { say('语音引擎就绪'); return; }
        if (s.state === 'error') throw new Error(s.msg || '语音引擎异常');
        say((s.msg || '模型加载中…') + '（首次约 1~2 分钟）');
      }
      await new Promise(r2 => setTimeout(r2, 2000));
    }
    throw new Error('语音引擎启动超时');
  }

  function textRoot() {
    // 滚动模式 #chapterText 优先，其次分页模式 #pagedText
    const a = $('chapterText'), b = $('pagedText');
    if (a && a.offsetParent !== null) return a;
    if (b && b.offsetParent !== null) return b;
    return a || b;
  }

  function collectParas() {
    const root = textRoot();
    if (!root) return [];
    let list = [...root.querySelectorAll('p')];
    if (list.length < 2) {
      // round76：只有 fallback 结果更丰富才替换 —— 旧逻辑 `< 2` 就整体换掉，
      // 单 <p> 的短页（尾页/插图页）会被误判成「无可朗读」
      const alt = [...root.querySelectorAll('div,li,blockquote')];
      if (alt.length > list.length) list = alt;
    }
    return list.filter(el => (el.textContent || '').trim().length > 1);
  }

  function markDone() {
    const id = novelId();
    if (!id) return;
    fetch('/api/media/novel/' + id + '/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }).catch(() => { });
  }

  /* ---------------- 控制条 ---------------- */

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'nvTtsBar';
    bar.className = 'nv-tts-bar';
    bar.innerHTML =
      '<span class="nv-tts-dot" id="nvTtsDot"></span>' +
      '<span class="nv-tts-idx" id="nvTtsIdx">—</span>' +
      '<button class="nv-tts-btn" id="nvTtsToggle">▶ 朗读本章</button>' +
      '<button class="nv-tts-btn" id="nvTtsStop" disabled>■ 停止</button>' +
      '<select id="nvTtsVoice" title="音色（与设置里同步）" style="max-width:130px;height:26px;font-size:12px;border-radius:6px;border:1px solid var(--border,#888780);background:var(--bg-card,#fff);color:inherit;padding:0 4px;">' +
      '<option value="">音色…</option></select>' +
      '<label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;" title="语速（GPT 引擎走播放端无损变速）">速' +
      '<input id="nvTtsSpeed" type="range" min="0.5" max="2" step="0.1" value="1" style="width:76px;vertical-align:middle;accent-color:var(--primary,#6366f1);">' +
      '<b id="nvTtsSpeedVal" style="font-weight:500;min-width:26px;text-align:right;">1.0</b></label>' +
      '<label style="display:flex;align-items:center;gap:3px;font-size:12px;white-space:nowrap;cursor:pointer;" title="读完自动翻页 / 下一章继续朗读（对齐微信读书、番茄）">' +
      '<input id="nvTtsAuto" type="checkbox" style="vertical-align:middle;accent-color:var(--primary,#6366f1);"> 自动连播</label>' +
      '<span class="nv-tts-tip" id="nvTtsTip">未启用</span>';
    document.body.appendChild(bar);
    $('nvTtsToggle').addEventListener('click', () => (playing ? pause() : start()));
    $('nvTtsStop').addEventListener('click', () => { userStop = true; stop(); });
    $('nvTtsVoice').addEventListener('change', onVoiceChange);
    $('nvTtsSpeed').addEventListener('input', onSpeedInput);
    $('nvTtsAuto').addEventListener('change', () => {
      localStorage.setItem(LS_AUTO, $('nvTtsAuto').checked ? '1' : '0');
    });
    return bar;
  }

  async function refreshBar() {
    ensureBar();
    try { cfg = await api('/config'); } catch (e) { cfg = null; }
    const on = cfg && cfg.engine && cfg.engine !== 'off';
    // round86：朗读进行中别用引擎名盖掉进度 tip（refreshBar 会在切章等时机被调）
    if (!playing) {
      $('nvTtsTip').textContent = !cfg ? '读取配置失败'
        : (!on ? '未启用（设置 → 语音朗读）'
          : (cfg.engine === 'breeze' ? 'Breeze-TTS-2' : (cfg.engine === 'vits' ? 'VITS' : 'GPT-SoVITS')));
    }
    $('nvTtsToggle').disabled = !on;
    $('nvTtsDot').className = 'nv-tts-dot' + (playing ? ' on' : (on ? ' ok' : ''));
    // 语速：本地记忆优先，其次全局配置
    const sp = Number(localStorage.getItem(LS_SPEED)) || Number(cfg && cfg.speed) || 1;
    $('nvTtsSpeed').value = sp;
    $('nvTtsSpeedVal').textContent = sp.toFixed(1);
    $('nvTtsAuto').checked = localStorage.getItem(LS_AUTO) !== '0';   // 默认开
    if (on) populateVoiceSelect();
  }

  /** 音色下拉：VITS=804 音色，GPT=音色库（logs/ 训练音色，round75c）；选中值与全局配置对齐 */
  async function populateVoiceSelect() {
    const sel = $('nvTtsVoice');
    if (!sel || !cfg) return;
    try {
      if (!voiceCache) voiceCache = await api('/voices?engine=' + cfg.engine);
      if (cfg.engine === 'breeze') {
        const cur = cfg.breezeVoice || '爱弥斯';
        const list = voiceCache.voices || [];
        const frag = document.createDocumentFragment();
        list.forEach(v => {
          const o = document.createElement('option');
          o.value = v.name;
          o.textContent = v.name;
          if (cur === v.name) o.selected = true;
          frag.appendChild(o);
        });
        sel.innerHTML = '';
        sel.appendChild(frag);
      } else if (cfg.engine === 'vits') {
        const cur = Number(cfg.vitsSpeakerId) || 0;
        const list = voiceCache.voices || [];
        const frag = document.createDocumentFragment();
        list.forEach(v => {
          const o = document.createElement('option');
          o.value = String(v.id);
          o.textContent = v.name;
          if (v.id === cur) o.selected = true;
          frag.appendChild(o);
        });
        sel.innerHTML = '';
        sel.appendChild(frag);
      } else {
        /* round75c：GPT 用音色库（爱弥斯/达妮娅…），不再是情绪列表 */
        const list = voiceCache.voiceList || [];
        const cur = cfg.gptVoice || '';
        const frag = document.createDocumentFragment();
        const o0 = document.createElement('option');
        o0.value = ''; o0.textContent = '默认参考音';
        frag.appendChild(o0);
        list.forEach(v => {
          const o = document.createElement('option');
          o.value = v.name;
          o.textContent = v.name + (v.gptWeights && v.sovitsWeights ? '' : '（缺权重）');
          if (cur === v.name) o.selected = true;
          frag.appendChild(o);
        });
        sel.innerHTML = '';
        sel.appendChild(frag);
      }
    } catch (e) { sel.innerHTML = '<option value="">音色读取失败</option>'; }
  }

  async function onVoiceChange() {
    const sel = $('nvTtsVoice');
    if (!sel || !cfg) return;
    try {
      if (cfg.engine === 'breeze') {
        await api('/config', { breezeVoice: sel.value });
        cfg.breezeVoice = sel.value;
      } else if (cfg.engine === 'vits') {
        await api('/config', { vitsSpeakerId: Number(sel.value) || 0 });
        cfg.vitsSpeakerId = Number(sel.value) || 0;
      } else {
        /* round75c：切音色 = 记 gptVoice（+refAudio 供探测/兜底），合成时服务端热切权重 */
        if (sel.value) {
          const hit = ((voiceCache && voiceCache.voiceList) || []).find(v => v.name === sel.value);
          if (hit && hit.ref) await api('/config', { gptVoice: sel.value, refAudio: hit.ref });
          else { $('nvTtsTip').textContent = '该音色缺权重/参考音'; return; }
        } else {
          await api('/config', { gptVoice: '' });
        }
        cfg.gptVoice = sel.value;
      }
      $('nvTtsTip').textContent = '音色已切换 ✓';
    } catch (e) { $('nvTtsTip').textContent = '切换失败：' + e.message.slice(0, 30); }
  }

  function speedVal() {
    return Number($('nvTtsSpeed') && $('nvTtsSpeed').value) || 1;
  }

  function onSpeedInput() {
    const v = speedVal();
    $('nvTtsSpeedVal').textContent = v.toFixed(1);
    localStorage.setItem(LS_SPEED, String(v));
    // round86：正在播的块立即变速（vits 走合成侧变速，其余引擎走播放端 playbackRate；
    // defaultPlaybackRate 一起写，防下一次 src 赋值把速率重置回 1）
    if (media && cfg && cfg.engine !== 'vits') {
      try { media.playbackRate = v; media.defaultPlaybackRate = v; media.preservesPitch = true; } catch (e) { }
    }
    // 防抖写回全局配置，设置面板与试听保持一致
    clearTimeout(onSpeedInput._t);
    onSpeedInput._t = setTimeout(() => { api('/config', { speed: v }).catch(() => { }); }, 400);
  }

  function setIdx(i) {
    idx = i;
    const n = paras.length;
    $('nvTtsIdx').textContent = n ? (Math.max(0, Math.min(i, n - 1)) + 1) + ' / ' + n : '—';
  }

  function highlight(i) {
    paras.forEach((el, k) => el.classList.toggle('nv-tts-cur', k === i));
    const el = paras[i];
    // round76：分页模式是 overflow:hidden 的固定页，scrollIntoView 会去滚外层容器
    // 造成视觉乱跳/「跳回前页」——页内段落本来就全部可见，只做高亮即可。
    const paged = window.NovelNav && window.NovelNav.mode() === 'page';
    if (el && !paged && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { }
    }
  }

  /* ---------------- 播放（round76 重构） ---------------- */

  /**
   * 播放一个 wav，ended 事件驱动 resolve —— 播完整块才算完。
   * 旧实现 media.play().then(resolve) 播放开始即返回，调用方随即覆盖 media.src，
   * 把正在播的块硬切（掐段根因）。
   */
  function playUrl(name) {
    return new Promise((resolve, reject) => {
      if (!media) media = new Audio();
      playToken++;
      const my = playToken;
      // round86：vits 走合成侧变速（引擎原生 speed 参数）；breeze/gptsovits 引擎
      // 不支持合成侧变速 → 统一走播放端 playbackRate（preservesPitch 默认true，音调不变）
      // ★注意：下面 media.src 赋值会触发 load 算法、把 playbackRate 重置回
      //   defaultPlaybackRate —— 所以必须同时写 defaultPlaybackRate（探针实测踩坑）
      const rate = (cfg && cfg.engine === 'vits') ? 1 : speedVal();
      media.defaultPlaybackRate = rate;
      const onEnded = () => { if (my === playToken) resolve(); };
      const onError = () => { if (my === playToken) reject(new Error('音频加载失败')); };
      media.addEventListener('ended', onEnded, { once: true });
      media.addEventListener('error', onError, { once: true });
      media.src = API + '/audio/' + name;
      media.playbackRate = rate;
      media.play().catch((e) => { if (my === playToken) reject(e); });
    });
  }

  /* ---------------- round87 真流式（WebAudio 边收边播） ----------------
   * 协议见 routes/tts.js /synthesize-stream：首行 JSON 头（header/cached/error），
   * 之后到流结束全是二进制 PCM16LE。PCM 攒成 ~1 秒一粒的 AudioBuffer，
   * 产出即排进 AudioContext 时间线 —— 点朗读后 ~1 秒出声（bench TTFA 仅 0.25s）。
   * 前提：breeze 引擎 + 语速≈1（WebAudio 变速会变调，语速≠1 走旧的文件路径）。 */

  let actx = null;         // AudioContext 懒建
  let liveSources = [];    // 已排队的 source，stop 时统一停
  let streamAbort = null;  // 当前流式合成的 AbortController

  function ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!actx) { try { actx = new AC(); } catch (e) { return null; } }
    if (actx.state === 'suspended') { try { actx.resume(); } catch (e) { } }
    return actx;
  }

  function stopStreamAudio() {
    for (const s of liveSources) { try { s.stop(); } catch (e) { } }
    liveSources = [];
    if (streamAbort) { try { streamAbort.abort(); } catch (e) { } streamAbort = null; }
  }

  function pcmGranule(ctx, i16, sr) {
    const buf = ctx.createBuffer(1, i16.length, sr);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    return buf;
  }

  function concatU8(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  /**
   * 流式合成并播放一块文本。
   * resolve { streamed:true } = 已边到边播完；{ cached:true, path } = 服务端缓存命中（调方走 playUrl）。
   * reject = 出错（调方提示并停）。
   * round88 卡顿修复：Breeze RTF>1（合成比实时慢），旧版「来一粒播一粒」必然
   * 每粒 underrun 一次 = 用户听的「两三个字卡一次」。改为：
   *   · 首播前预缓冲 PREBUF_SEC 秒再开播；
   *   · 中途 underrun 进入重缓冲，攒够 RESUME_SEC 再续播（把高频小卡顿变成长段连续播放+低频停顿）；
   *   · 每粒首尾 7ms 淡入淡出，消除拼接爆音。
   */
  function synthPlayStreamed(text, tk) {
    const PREBUF_SEC = 4.0;
    const RESUME_SEC = 1.6;
    const GRAN_FRAMES = 1.25;   // 粒长（秒）
    return new Promise((resolve, reject) => {
      const ctx = ensureCtx();
      if (!ctx || !ctx.createBufferSource) return reject(new Error('浏览器不支持 WebAudio'));
      const granules = [];   // { i16, sr } 已就绪的播放粒
      let sr = 24000;
      let sawHeader = false;
      let streamDone = false;
      let failure = null;
      let gIdx = 0;          // 已排进时间线的粒数
      let nextTime = 0;
      let settled = false;
      let started = false;   // round88：预缓冲/重缓冲门
      const ctl = new AbortController();
      streamAbort = ctl;
      let acc = [], accFrames = 0;

      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
      const finish = () => { streamDone = true; pump(); checkEnd(); };

      function bufferedSec() {
        let s = 0;
        for (let i = gIdx; i < granules.length; i++) s += granules[i].i16.length / granules[i].sr;
        return s;
      }

      function emitGranule() {
        if (!accFrames) return;
        const i16 = new Int16Array(accFrames);
        let off = 0;
        for (const u8 of acc) {
          const n = Math.floor(u8.byteLength / 2);
          i16.set(new Int16Array(u8.buffer, u8.byteOffset, n), off);
          off += n;
        }
        acc = []; accFrames = 0;
        // round88：粒首尾 7ms 淡入淡出，消除粒间拼接的咔哒声
        const fadeN = Math.min(Math.floor(sr * 0.007), i16.length >> 1);
        for (let k = 0; k < fadeN; k++) {
          const g = k / fadeN;
          i16[k] = Math.round(i16[k] * g);
          i16[i16.length - 1 - k] = Math.round(i16[i16.length - 1 - k] * g);
        }
        granules.push({ i16, sr });
        pump();
      }

      function pump() {
        if (tk !== token || stopped) return;
        if (!started) {
          const need = (gIdx === 0 ? PREBUF_SEC : RESUME_SEC);
          if (!streamDone && bufferedSec() < need) {
            const t = $('nvTtsTip');
            if (t && tk === token && !stopped) t.textContent = '正在缓冲语音…';
            return;
          }
          started = true;
          nextTime = Math.max(nextTime, ctx.currentTime + 0.08);
        }
        while (gIdx < granules.length) {
          const g = granules[gIdx++];
          const buf = pcmGranule(ctx, g.i16, g.sr);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          nextTime = Math.max(nextTime, ctx.currentTime + 0.06);
          src.start(nextTime);
          nextTime += buf.duration;
          liveSources.push(src);
          if (tk === token && !stopped) { const t = $('nvTtsTip'); if (t) t.textContent = '朗读中'; }
        }
      }

      function checkEnd() {
        if (settled) return;
        if (tk !== token || stopped) return settle(resolve, { streamed: true, aborted: true });
        if (failure) return settle(reject, new Error(failure));
        if (!streamDone) {
          // round88：时间线已耗尽而流还没完 ⇒ underrun，回退到重缓冲门
          if (started && gIdx >= granules.length && ctx.currentTime >= nextTime - 0.03) started = false;
          setTimeout(checkEnd, 150);
          return;
        }
        // 流结束且最后一粒已排完并播到时间线末端 → 本块完成
        if (gIdx >= granules.length && ctx.currentTime >= nextTime - 0.05) {
          return settle(resolve, { streamed: true });
        }
        setTimeout(checkEnd, 120);
      }

      (async () => {
        try {
          const resp = await fetch(API + '/synthesize-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: 'breeze', voice: cfg.breezeVoice || undefined, text }),
            signal: ctl.signal,
          });
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          let buf = new Uint8Array(0);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!sawHeader) {
              buf = concatU8(buf, value);
              const nl = buf.indexOf(10);
              if (nl < 0) continue;
              let head;
              try { head = JSON.parse(dec.decode(buf.slice(0, nl))); }
              catch (e) { throw new Error('流式响应头解析失败'); }
              buf = buf.slice(nl + 1);
              if (head.t === 'cached') return settle(resolve, { cached: true, path: head.path });
              if (head.t === 'error') throw new Error(head.msg || '流式合成失败');
              sr = Number(head.sr) || 24000;
              sawHeader = true;
              if (buf.length) {   // 头和 PCM 可能同包到达
                acc.push(buf); accFrames += Math.floor(buf.length / 2);
                buf = new Uint8Array(0); emitGranule();
              }
              continue;
            }
            acc.push(value);
            accFrames += Math.floor(value.byteLength / 2);
            if (accFrames >= sr * 1.25) emitGranule();   // round88：粒长 1.25s
          }
          emitGranule();
          finish();
        } catch (e) {
          if (ctl.signal.aborted) return settle(resolve, { streamed: true, aborted: true });
          failure = String((e && e.message) || e).slice(0, 80);
          finish();
        }
      })();
    });
  }

  /** 合成一块文本（breeze/gptsovits 语速固定 1.0，变速交给播放端；VITS 引擎侧变速） */
  function synthChunk(text, tk) {
    return api('/synthesize', {
      text, play: false,
      speakerId: cfg.engine === 'vits' ? (Number(cfg.vitsSpeakerId) || 0) : undefined,
      voice: cfg.engine === 'breeze' ? (cfg.breezeVoice || '爱弥斯') : (cfg.engine === 'gptsovits' ? (cfg.gptVoice || '') : undefined),
      speed: (cfg.engine === 'gptsovits' || cfg.engine === 'breeze') ? undefined : speedVal(),
    });
  }

  async function speak(i, tk) {
    if (tk !== token || stopped) return;
    const el = paras[i];
    if (!el) return;
    const text = (el.textContent || '').trim();
    if (!text) { next(); return; }
    // round86：块长按引擎区分。Breeze RTF≈2.2，220 字块要合成近 2 分钟才出声
    // （用户报的「超长段很久没声」就是它）→ breeze 用 80 字小块 + 30 字首块；
    // 其余引擎维持原 220/50。
    const breezeSmall = cfg.engine === 'breeze';
    const maxLen = (i === firstIdx)
      ? (breezeSmall ? 30 : 50)
      : (breezeSmall ? 80 : 220);   // 首块切短：块越小首字越快
    const chunks = splitText(text, maxLen);
    // round87：breeze + 语速≈1 → 走真流式（边合成边播，~1s 出声）。
    // 语速≠1 时 WebAudio 变速会变调，退回文件路径（<audio>.playbackRate 保音高）。
    const useStream = cfg.engine === 'breeze' && Math.abs(speedVal() - 1) < 0.02;
    for (let c = 0; c < chunks.length; c++) {
      if (tk !== token || stopped) return;
      highlight(i);
      // —— 预取：本块开播前，把下一块（本段末块则预取下一段首块）挂到后台合成 ——
      // ★流式模式下不预发射：预取 /synthesize 会先于当前块的流式请求进 worker 串行队列，
      //   把当前块挤到整块预取合成完之后（次序颠倒 = 首声反而更慢）。
      let nextKey = null;
      if (!useStream) {
        if (c + 1 < chunks.length) {
          nextKey = chunks[c + 1];
        } else {
          const nEl = paras[i + 1];
          const nt = nEl ? (nEl.textContent || '').trim() : '';
          if (nt) nextKey = splitText(nt, (i + 1 === firstIdx) ? (breezeSmall ? 45 : 90) : (breezeSmall ? 80 : 220))[0];
        }
      }
      const nextP = nextKey ? synthChunk(nextKey, tk).catch(e => ({ __err: e })) : null;
      // —— 取当前块：命中预取直接用；流式模式边合成边播；否则现合成后整块播 ——
      let d = null;
      let streamed = false;
      if (prefetchLive && prefetchLive.tk === tk && prefetchLive.key === chunks[c]) {
        d = await prefetchLive.p;
        prefetchLive = null;
      } else if (useStream) {
        if (tk === token && !stopped) $('nvTtsTip').textContent = '正在合成语音…';
        const r = await synthPlayStreamed(chunks[c], tk);
        if (r && r.cached) d = r;          // 服务端缓存命中 → 文件路径播放
        else streamed = true;              // 已边到边播完（或被停止中止）
      } else {
        if (tk === token && !stopped) $('nvTtsTip').textContent = '正在合成语音…';
        d = await synthChunk(chunks[c], tk);
      }
      if (d && d.__err) throw d.__err;
      if (tk !== token || stopped) return;
      if (nextP) prefetchLive = { key: nextKey, p: nextP, tk };
      if (tk === token && !stopped) $('nvTtsTip').textContent = '朗读中';
      if (!streamed) await playUrl(String(d.path).split(/[\\/]/).pop());
    }
    // 本段所有块播完（playUrl 由 ended 驱动），推进下一段
    if (tk !== token || stopped) return;
    next();
  }

  /** 长段按句切；中英日都照顾到（。！？；… 与 .!?;\n） */
  function splitText(s, max) {
    const out = [];
    let buf = '';
    const parts = s.split(/(?<=[。！？；…\n])|(?<=[.!?;])\s+/);
    for (const p of parts) {
      if ((buf + p).length > max && buf) { out.push(buf); buf = p; }
      else buf += p;
      while (buf.length > max) { out.push(buf.slice(0, max)); buf = buf.slice(max); }
    }
    if (buf.trim()) out.push(buf);
    return out.length ? out : [s];
  }

  function next() {
    if (stopped) return;
    if (idx + 1 >= paras.length) { advance(); return; }
    const tk = token;
    setIdx(idx + 1);
    highlight(idx);
    speak(idx, tk).catch((e) => { $('nvTtsTip').textContent = '出错：' + e.message.slice(0, 40); stop(); });
  }

  /* ---------------- 自动连播推进（round76：页驱动） ---------------- */

  /**
   * 当前页/章播完后的推进：
   *   分页模式：翻下一页（pageTurn 自带章末切章），空页由 start→advance 循环跳过
   *   滚动模式：切下一章（用 NovelNav 拿真实章号，不再读挂不上 window 的 let 变量）
   *   全书末尾：停止并标记已读完
   */
  async function advance() {
    const tk = token;
    const auto = localStorage.getItem(LS_AUTO) !== '0';   // 默认开
    const nav = window.NovelNav;
    const paged = nav && nav.mode() === 'page';
    if (!auto) {
      stop();
      $('nvTtsTip').textContent = paged ? '本页已读完 ✓' : '本章已读完 ✓';
      return;
    }
    if (!nav) { stop(); $('nvTtsTip').textContent = '本页已读完 ✓'; return; }
    chaining = true;
    autoContinue = true;   // 推进途中防 watchChapterChange 误停（start 成功后会复位）
    const info = nav.info();
    if (info.mode === 'page') {
      if (info.page < info.pages - 1) {
        nav.turn(1, false);                 // 下一页
      } else if (info.chapter < info.total - 1) {
        nav.turn(1, true);                  // 末页 → pageTurn 自带切下一章第 1 页
      } else {
        chaining = false;
        stop();
        $('nvTtsTip').textContent = '全书读完 ✓';
        markDone();
        return;
      }
      const ok = await waitPageChanged(info, tk);
      chaining = false;
      if (userStop || tk !== token) { if (userStop) $('nvTtsTip').textContent = '已停止'; return; }
      if (!ok) { stop(); $('nvTtsTip').textContent = '翻页超时，已停止'; return; }
      await start();
      return;
    }
    // —— 滚动模式：章驱动 ——
    if (info.chapter < info.total - 1) {
      autoContinue = true;
      const prevTitle = $('chapterTitle') ? $('chapterTitle').textContent : '';
      const prevFirst = paras.length ? (paras[0].textContent || '').trim().slice(0, 40) : '';
      try { nav.go(info.chapter + 1); } catch (e) { autoContinue = false; chaining = false; return; }
      const ok = await waitNewChapter(prevTitle, prevFirst, tk);
      autoContinue = false; chaining = false;
      if (userStop || tk !== token) { if (userStop) $('nvTtsTip').textContent = '已停止'; return; }
      if (!ok) { stop(); $('nvTtsTip').textContent = '切章超时，已停止'; return; }
      await start();
      return;
    }
    chaining = false;
    stop();
    $('nvTtsTip').textContent = '已是最后一章 ✓';
    markDone();
  }

  /** 等分页内容真正变过来（翻页同步、切章异步，统一轮询 NovelNav 快照） */
  function waitPageChanged(prev, tk) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (userStop || tk !== token) { clearInterval(timer); return resolve(false); }
        const info = window.NovelNav ? window.NovelNav.info() : null;
        if (info && (info.page !== prev.page || info.chapter !== prev.chapter)) {
          clearInterval(timer);
          setTimeout(() => resolve(true), 500);   // 等渲染稳定
        } else if (Date.now() - t0 > 8000) {
          clearInterval(timer);
          resolve(false);
        }
      }, 300);
    });
  }

  /** 滚动模式：等新章内容渲染出来（标题变了或首段文本变了，最多等 15 秒） */
  function waitNewChapter(prevTitle, prevFirst, tk) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (userStop || tk !== token) { clearInterval(timer); return resolve(false); }
        const t = $('chapterTitle') ? $('chapterTitle').textContent : '';
        const ps = collectParas();
        const first = ps.length ? (ps[0].textContent || '').trim().slice(0, 40) : '';
        if ((t && t !== prevTitle) || (first && first !== prevFirst)) {
          clearInterval(timer);
          setTimeout(() => resolve(true), 600);   // 等渲染稳定
        } else if (Date.now() - t0 > 15000) {
          clearInterval(timer);
          resolve(false);
        }
      }, 400);
    });
  }

  async function start() {
    ensureBar();
    // round74c：每次开始都拉最新配置 —— 设置里换了音色/语速，这里立刻生效
    try { cfg = await api('/config'); } catch (e) { /* 用旧 cfg 兜底 */ }
    if (!cfg || cfg.engine === 'off') { $('nvTtsTip').textContent = '请先在设置里启用'; chaining = false; return; }
    paras = collectParas();
    if (!paras.length) {
      // round76：自动连播途中遇空页/空章 → 自动跳过继续翻；手动点朗读才提示
      if (chaining) { $('nvTtsTip').textContent = '本页无文字，自动跳过…'; return advance(); }
      $('nvTtsTip').textContent = '本页没有可朗读的内容';
      return;
    }
    chaining = false;
    userStop = false; autoContinue = false;
    stopped = false; playing = true; token++;
    const tk = token;
    $('nvTtsToggle').textContent = '⏸ 暂停';
    $('nvTtsStop').disabled = false;
    $('nvTtsTip').textContent = '准备中…';
    // round85：引擎没就绪（模型加载中）先等就绪，进度实时显示在提示条上，
    // 用户不再面对「点了朗读两分钟没任何反应」的黑箱
    try {
      await ensureEngineReady(tk, (m) => { if (tk === token && !stopped) $('nvTtsTip').textContent = m; });
    } catch (e) {
      stop();
      $('nvTtsTip').textContent = e.message === '已停止' ? '已停止' : '语音引擎未就绪：' + e.message.slice(0, 40);
      return;
    }
    if (tk !== token || stopped) return;
    // 断点续播：滚动模式从当前视口第一段起；分页模式整页可见，从页首起
    let from = 0;
    const paged = window.NovelNav && window.NovelNav.mode() === 'page';
    if (!paged) {
      try {
        const vis = paras.findIndex(p => { const r = p.getBoundingClientRect(); return r.top > window.innerHeight * 0.35 && r.bottom > 0; });
        if (vis >= 0) from = vis;
      } catch (e) { }
    }
    firstIdx = from;
    setIdx(from); highlight(from);
    speak(from, tk).catch((e) => { $('nvTtsTip').textContent = '出错：' + e.message.slice(0, 40); stop(); });
    refreshBar();
  }

  function pause() {
    userStop = true;
    playing = false; stopped = true; token++; playToken++;
    prefetchLive = null;
    if (media) { try { media.pause(); } catch (e) { } }
    $('nvTtsToggle').textContent = '▶ 继续';
    $('nvTtsTip').textContent = '已暂停';
    refreshBar();
  }

  function stop() {
    stopped = true; playing = false; token++; playToken++;
    prefetchLive = null;
    stopStreamAudio();   // round87：停掉 WebAudio 流式队列与在途流式请求
    if (media) { try { media.pause(); media.currentTime = 0; } catch (e) { } }
    paras.forEach(p => p.classList.remove('nv-tts-cur'));
    if ($('nvTtsToggle')) $('nvTtsToggle').textContent = '▶ 朗读本章';
    if ($('nvTtsStop')) $('nvTtsStop').disabled = true;
    if (!autoContinue) refreshBar();
  }

  /* ---------------- 切章时自动停（自动连播途中除外） ---------------- */

  function watchChapterChange() {
    let last = $('chapterTitle') ? $('chapterTitle').textContent : '';
    setInterval(() => {
      const t = $('chapterTitle') ? $('chapterTitle').textContent : '';
      if (t !== last) {
        last = t;
        if (autoContinue) return;   // 是我们自己切的章，别打断
        if (playing || !stopped) stop();
      }
    }, 1200);
  }

  window.NvTts = { start, pause, stop, refreshBar };

  document.addEventListener('DOMContentLoaded', () => {
    ensureBar();
    refreshBar();
    watchChapterChange();
  });
})();
