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
    const r = await fetch(API + path, Object.assign({ signal: AbortSignal.timeout(180000) }, opt));
    const j = await r.json().catch(() => ({ code: -1, msg: 'HTTP ' + r.status }));
    if (j.code !== 0) throw new Error(j.msg || '失败');
    return j.data;
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
    $('nvTtsTip').textContent = !cfg ? '读取配置失败'
      : (!on ? '未启用（设置 → 语音朗读）'
        : (cfg.engine === 'vits' ? 'VITS' : 'GPT-SoVITS'));
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
      if (cfg.engine === 'vits') {
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
      if (cfg.engine === 'vits') {
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
      // GPT 引擎：合成固定 1.0（speed_factor 变速有损），语速走播放端无损变速
      media.playbackRate = (cfg && cfg.engine === 'gptsovits') ? speedVal() : 1;
      const onEnded = () => { if (my === playToken) resolve(); };
      const onError = () => { if (my === playToken) reject(new Error('音频加载失败')); };
      media.addEventListener('ended', onEnded, { once: true });
      media.addEventListener('error', onError, { once: true });
      media.src = API + '/audio/' + name;
      media.play().catch((e) => { if (my === playToken) reject(e); });
    });
  }

  /** 合成一块文本（GPT 语速固定 1.0，变速交给播放端；VITS 引擎侧变速） */
  function synthChunk(text, tk) {
    return api('/synthesize', {
      text, play: false,
      speakerId: cfg.engine === 'vits' ? (Number(cfg.vitsSpeakerId) || 0) : undefined,
      voice: cfg.engine === 'gptsovits' ? (cfg.gptVoice || '') : undefined,
      speed: cfg.engine === 'gptsovits' ? undefined : speedVal(),
    });
  }

  async function speak(i, tk) {
    if (tk !== token || stopped) return;
    const el = paras[i];
    if (!el) return;
    const text = (el.textContent || '').trim();
    if (!text) { next(); return; }
    const maxLen = (i === firstIdx) ? 50 : 220;   // 首块切短（1~2 句）：api_v2 整段返回，块越小首字越快
    const chunks = splitText(text, maxLen);
    for (let c = 0; c < chunks.length; c++) {
      if (tk !== token || stopped) return;
      highlight(i);
      // —— 预取：本块开播前，把下一块（本段末块则预取下一段首块）挂到后台合成 ——
      let nextKey = null;
      if (c + 1 < chunks.length) {
        nextKey = chunks[c + 1];
      } else {
        const nEl = paras[i + 1];
        const nt = nEl ? (nEl.textContent || '').trim() : '';
        if (nt) nextKey = splitText(nt, (i + 1 === firstIdx) ? 90 : 220)[0];
      }
      const nextP = nextKey ? synthChunk(nextKey, tk).catch(e => ({ __err: e })) : null;
      // —— 取当前块：命中预取直接用，否则现合成 ——
      let d;
      if (prefetchLive && prefetchLive.tk === tk && prefetchLive.key === chunks[c]) {
        d = await prefetchLive.p;
        prefetchLive = null;
      } else {
        d = await synthChunk(chunks[c], tk);
      }
      if (d && d.__err) throw d.__err;
      if (tk !== token || stopped) return;
      if (nextP) prefetchLive = { key: nextKey, p: nextP, tk };
      await playUrl(String(d.path).split(/[\\/]/).pop());
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
