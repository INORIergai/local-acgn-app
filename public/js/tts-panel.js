/**
 * round72 · 语音朗读（TTS）设置面板
 *
 * 目标：把「体检 → 修复 → 唤起 → 选音色 → 试听」这条链路做成**零配置 + 全程可点**。
 * 用户不应该需要先知道 GPT-SoVITS 装在哪、端口是多少、ffmpeg 在哪 —— 面板负责自动发现与自愈。
 *
 * 独立成文件而不是塞进 app.js：app.js 已 14600 行，且承载大量已验证逻辑，别碰它。
 */
(function () {
  'use strict';

  const API = '/api/tts';
  let cfg = null;          // 当前配置
  let diag = null;         // 最近一次体检结果
  let voices = null;       // 音色列表
  let busy = false;        // 防止重复点击
  let pollTimer = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function call(path, body) {
    const opt = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    const r = await fetch(API + path, Object.assign({ signal: AbortSignal.timeout(240000) }, opt));
    const j = await r.json().catch(() => ({ code: -1, msg: 'HTTP ' + r.status }));
    if (j.code !== 0) throw new Error(j.msg || '操作失败');
    return j.data;
  }

  const busy2 = () => busy;

  function notify(msg, type) {
    // showNotification 签名是 (title, message, duration, level)，之前把 type 当 message 传，
    // 提示弹出来标题是正文、正文是 'info'，等于没有有效状态提示。
    if (typeof showNotification === 'function') showNotification('语音朗读', msg, 3500, type === 'error' ? 'error' : 'info');
    else console.log('[TTS]', msg, type || '');
  }

  /* Electron 渲染进程**不支持 prompt()**：调用即抛异常，而异常发生在 async onclick 里
     只是一个未处理的 Promise rejection —— 界面毫无反应，这就是「指定路径/试听点了没反应」的根因。
     这里做一个页面内小弹窗输入框替代，返回 Promise：
     - 点确定 / 回车 → resolve 输入框原始字符串（可能为 ''，表示「留空跳过」）
     - 点取消 / Esc / 点遮罩 → resolve null（表示放弃） */
  function ttsPrompt(title, def) {
    return new Promise((resolve) => {
      // 固定 id：测试与脚本可直接定位（style.cssText 会被浏览器规范化加空格，
      // 用 [style*=z-index:9000] 这类属性选择器匹配不到，别再走那个坑）
      const prev = document.getElementById('ttsPromptMask');
      if (prev) prev.remove();
      const mask = document.createElement('div');
      mask.id = 'ttsPromptMask';
      mask.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg-card,#1c1917);color:var(--text,#e7e5e4);border-radius:12px;padding:18px 20px;width:min(560px,90vw);box-shadow:0 12px 40px rgba(0,0,0,.5);';
      const label = document.createElement('div');
      label.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;line-height:1.5;';
      label.textContent = title;
      const input = document.createElement('input');
      input.className = 'settings-input';
      input.style.cssText = 'width:100%;box-sizing:border-box;';
      input.value = def == null ? '' : String(def);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';
      const btnC = document.createElement('button');
      btnC.className = 'btn btn-sm'; btnC.textContent = '取消';
      const btnO = document.createElement('button');
      btnO.className = 'btn btn-sm btn-primary'; btnO.textContent = '确定';
      row.appendChild(btnC); row.appendChild(btnO);
      card.appendChild(label); card.appendChild(input); card.appendChild(row);
      mask.appendChild(card);
      document.body.appendChild(mask);
      let done = false;
      const close = (val) => { if (done) return; done = true; mask.remove(); resolve(val); };
      btnO.addEventListener('click', () => close(input.value));
      btnC.addEventListener('click', () => close(null));
      mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
      mask.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
      });
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  }

  /* ---------------- 渲染 ---------------- */

  function engineLabel(e) {
    return e === 'gptsovits' ? 'GPT-SoVITS（音质好·有情绪）'
      : e === 'vits' ? 'VITS（零配置·804 音色）' : '关闭';
  }

  function render() {
    const el = $('ttsPanel');
    if (!el || !cfg) return;
    const st = (window.__ttsStatus && window.__ttsStatus[cfg.engine]) || {};

    el.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.6;">
        漫画/小说阅读器可整章朗读。两个本地引擎任选其一，都支持一键体检与自动修复。
      </div>

      <div class="settings-item">
        <label>朗读引擎</label>
        <div class="tts-engine-row">
          ${['gptsovits', 'vits', 'off'].map(k =>
      `<button class="btn btn-sm ${cfg.engine === k ? '' : 'btn-secondary'} tts-engine"
                 data-engine="${k}">${engineLabel(k)}</button>`).join('')}
        </div>
      </div>

      <div class="tts-status" id="ttsStatusBar">
        <span class="tts-dot ${st.state === 'ready' ? 'ok' : (st.running ? 'wait' : 'idle')}" id="ttsDot"></span>
        <span id="ttsStatusText">${st.state === 'ready' ? '已就绪' + (st.port ? '（端口 ' + st.port + '）' : '') : '未启动'}</span>
      </div>

      <div class="settings-btn-row tts-row">
        <button class="btn-pill btn-pill--info" onclick="ttsAct('diagnose')" ${busy ? 'disabled' : ''}>🩺 一键体检</button>
        <button class="btn-pill btn-pill--warn" onclick="ttsAct('repair')" ${busy ? 'disabled' : ''}>🔧 一键修复</button>
        <button class="btn-pill btn-pill--success" onclick="ttsAct('start')" id="ttsStartBtn" ${busy ? 'disabled' : ''}>▶ 一键唤起</button>
        <button class="btn btn-sm" onclick="ttsAct('stop')" ${busy ? 'disabled' : ''}>⏹ 自动关闭</button>
        <button class="btn-pill btn-pill--neutral" onclick="ttsAct('autodiscover')" ${busy ? 'disabled' : ''}>🔍 重新扫描安装位置</button>
      </div>

      <div id="ttsModelBox"></div>
      <div id="ttsDiagBox"></div>
      <div id="ttsVoiceBox"></div>
      <div id="ttsPathBox" style="margin-top:8px;"></div>
    `;

    el.querySelectorAll('.tts-engine').forEach(b => {
      b.addEventListener('click', async () => {
        try {
          await call('/config', { engine: b.dataset.engine });
          diag = null;                     // 换引擎后旧体检结果已失效，别残留误导
          await loadCfg();
          await loadVoices();              // 音色列表跟着引擎走，立刻刷新
          render();
          notify('已切换到 ' + engineLabel(b.dataset.engine));
        } catch (e) { notify('切换失败：' + e.message, 'error'); }
      });
    });

    renderModelBox();
    renderDiag();
    renderVoices();
    renderPaths();
  }

  /* ============================================================
     round77 · VITS 权重按需下载（479MB 不进安装包）
     ============================================================ */
  let modelTimer = null;

  function human(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(1) : b) + ' ' + u[i];
  }

  async function loadModelStatus() {
    // call() 返回的就是 res.data（body 为空 → GET）
    try { return await call('/model/status', null); }
    catch (e) { return null; }
  }

  async function renderModelBox() {
    const box = $('ttsModelBox');
    if (!box || !cfg) return;
    if (cfg.engine !== 'vits') { box.innerHTML = ''; stopModelPoll(); return; }
    const m = await loadModelStatus();
    if (!m) { box.innerHTML = ''; return; }

    if (m.state === 'downloading') {
      const pct = Math.max(0, Math.min(100, m.percent || 0));
      box.innerHTML = `
        <div class="settings-item" style="margin-top:8px;">
          <label>⬇ VITS 权重下载中 ${pct}%　<span style="opacity:.7">${human(m.received)} / ${human(m.total)}${m.speed ? '（' + human(m.speed) + '/s）' : ''}</span></label>
          <div style="height:8px;border-radius:5px;background:var(--border,#e5e5e5);overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:width .3s;"></div>
          </div>
        </div>
        <div class="settings-btn-row tts-row">
          <button class="btn btn-sm" onclick="ttsModelCancel()">⏹ 取消下载</button>
        </div>`;
      startModelPoll();
      return;
    }
    stopModelPoll();

    if (m.installed) {
      box.innerHTML = `
        <div class="settings-item" style="margin-top:8px;">
          <label>VITS 权重</label>
          <div style="font-size:12px;color:var(--text-muted);line-height:1.6;">
            ✓ ${m.external ? '使用你自己的模型目录' : '已就位（' + human(m.size) + '）'}　<span style="opacity:.7">${esc(m.dir)}</span>
          </div>
        </div>`;
      return;
    }
    box.innerHTML = `
      <div class="settings-item" style="margin-top:8px;">
        <label>VITS 权重（推理代码已内置，权重需下载一次）</label>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.6;margin-bottom:6px;">
          ${m.workspaceReady ? '内置工作区已就绪，' : ''}需下载 ${human(m.total)}（来自本项目 GitHub Release）。
          ${m.size ? '上次已下载 ' + human(m.size) + '，可断点续传。' : ''}
        </div>
      </div>
      <div class="settings-btn-row tts-row">
        <button class="btn-pill btn-pill--primary" onclick="ttsModelDownload()">⬇ 下载权重</button>
      </div>
      ${m.state === 'error' && m.error ? `<div style="font-size:12px;color:var(--danger,#ef4444);margin-top:4px;">${esc(m.error)}</div>` : ''}`;
  }

  function startModelPoll() {
    if (modelTimer) return;
    modelTimer = setInterval(async () => {
      const m = await loadModelStatus();
      if (!m) return;
      if (m.state !== 'downloading') { stopModelPoll(); await renderModelBox(); return; }
      const bar = document.querySelector('#ttsModelBox label');
      if (bar) {
        const pct = Math.max(0, Math.min(100, m.percent || 0));
        bar.innerHTML = `⬇ VITS 权重下载中 ${pct}%　<span style="opacity:.7">${human(m.received)} / ${human(m.total)}${m.speed ? '（' + human(m.speed) + '/s）' : ''}</span>`;
        const fill = document.querySelector('#ttsModelBox div[style*="linear-gradient"]');
        if (fill) fill.style.width = pct + '%';
      }
    }, 1000);
  }

  function stopModelPoll() {
    if (modelTimer) { clearInterval(modelTimer); modelTimer = null; }
  }

  async function ttsModelDownload() {
    try {
      notify('开始下载 VITS 权重（479MB，可后台进行）...');
      await call('/model/download', {});
      await renderModelBox();
    } catch (e) { notify('下载失败：' + e.message, 'error'); }
  }

  async function ttsModelCancel() {
    try { await call('/model/cancel', {}); stopModelPoll(); await renderModelBox(); notify('已取消下载'); }
    catch (e) { notify('取消失败：' + e.message, 'error'); }
  }

  function renderDiag() {
    const box = $('ttsDiagBox');
    if (!box) return;
    if (!diag) { box.innerHTML = ''; return; }
    const s = diag.summary;
    const color = s.bad ? 'var(--danger,#ef4444)' : (s.warn ? '#f59e0b' : '#22c55e');
    box.innerHTML = `
      <div class="tts-diag-sum" style="color:${color}">
        ${s.bad ? '✗' : (s.warn ? '⚠' : '✓')} ${esc(s.verdict)}
      </div>
      <div class="tts-diag-list">
        ${(diag.items || []).map(i => `
          <div class="tts-diag-item">
            <span class="tts-mark ${i.level}">${i.level === 'ok' ? '✓' : (i.level === 'warn' ? '!' : '✗')}</span>
            <span class="tts-diag-title">${esc(i.title)}</span>
            <span class="tts-diag-detail">${esc(i.detail)}</span>
            ${i.fix && i.fix.kind !== 'none' && i.fix.label
        ? `<button class="btn btn-sm btn-secondary tts-fix" data-key="${esc(i.key)}" data-kind="${esc(i.fix.kind)}" data-field="${esc((i.fix.payload && i.fix.payload.field) || '')}">${esc(i.fix.label)}</button>`
        : ''}
          </div>`).join('')}
      </div>`;
    box.querySelectorAll('.tts-fix').forEach(b => {
      b.addEventListener('click', () => doFix(b.dataset.key, b.dataset.kind, b.dataset.field));
    });
  }

  function renderVoices() {
    const box = $('ttsVoiceBox');
    if (!box) return;
    if (!voices) { box.innerHTML = ''; return; }
    if (cfg.engine === 'vits') {
      const list = voices.voices || [];
      const cur = cfg.vitsSpeakerId || 0;
      box.innerHTML = `
        <div class="settings-item" style="margin-top:10px;">
          <label>音色（共 ${voices.total} 个，当前 #${cur} ${esc((voices.voices.find(v => v.id === cur) || {}).name || '')}）</label>
          <input class="settings-input" id="ttsVoiceSearch" placeholder="搜索音色（支持中文/日文）" style="margin-bottom:6px;">
          <select class="settings-input" id="ttsVoiceSel" size="6" style="height:auto;">
            ${list.map(v => `<option value="${v.id}" ${v.id === cur ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-btn-row tts-row">
          <button class="btn-pill btn-pill--primary" onclick="ttsSetSpeaker()">🎧 设为当前音色</button>
          <button class="btn-pill btn-pill--primary" onclick="ttsPreview()">▶ 试听</button>
        </div>`;
      const s = $('ttsVoiceSearch');
      if (s) s.addEventListener('input', () => {
        const q = s.value.trim();
        const sel = $('ttsVoiceSel');
        const all = voices.all || [];
        sel.innerHTML = all.filter(v => !q || v.name.includes(q))
          .slice(0, 300)
          .map(v => `<option value="${v.id}" ${v.id === cur ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
      });
    } else {
      const emos = voices.emotions || [];
      const presets = voices.presets || [];
      const voiceList = voices.voiceList || [];
      const curVoice = cfg.gptVoice || '';
      box.innerHTML = `
        <div class="settings-item" style="margin-top:10px;">
          <label>音色（${voiceList.length} 个，决定「谁在说话」）</label>
          <select class="settings-input" id="ttsVoiceSel2">
            <option value="" ${!curVoice ? 'selected' : ''}>（不切换音色 · 使用下方情绪参考音）</option>
            ${voiceList.map(v => `<option value="${esc(v.name)}" ${curVoice === v.name ? 'selected' : ''}>${esc(v.name)}${v.gptWeights ? '' : '（缺权重）'}</option>`).join('')}
          </select>
          <div style="font-size:11px;opacity:.65;margin-top:4px;">选中音色后合成会自动热切换 GPT/SoVITS 权重，并使用该音色自己的参考音频。</div>
        </div>
        <div class="settings-btn-row tts-row">
          <button class="btn-pill btn-pill--primary" onclick="ttsApplyVoice()">🎧 设为当前音色</button>
          <button class="btn-pill btn-pill--primary" onclick="ttsPreview()">▶ 试听</button>
          <button class="btn-pill btn-pill--ghost" onclick="ttsChangeVoiceRef()">📂 换参考音</button>
        </div>
        <div class="settings-item" style="margin-top:12px;">
          <label>情绪参考音（未选音色时的语气来源）</label>
          <select class="settings-input" id="ttsEmotion">
            <option value="">（使用默认参考音频）</option>
            ${emos.map(e => `<option value="${esc(e.name)}" ${cfg.emotion === e.name ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select>
        </div>
        <div class="settings-item">
          <label>权重预设（手动切音色的旧入口，推荐用上方音色下拉）</label>
          <div class="tts-chip-row">
            ${presets.map(p => `<button class="btn btn-sm btn-secondary tts-preset" data-key="${esc(p.key)}">${esc(p.name)}（${p.count}）</button>`).join('') || '<span style="font-size:12px;opacity:.6;">未扫描到</span>'}
          </div>
        </div>
        <div class="settings-btn-row tts-row">
          <button class="btn-pill btn-pill--primary" onclick="ttsApplyEmotion()">🎧 设为当前参考音</button>
        </div>
        <div style="font-size:11px;opacity:.6;line-height:1.7;margin-top:10px;">
          GPT-SoVITS 整合包体积约 10GB 且需自行训练/准备音色，不随本应用分发：
          请先下载整合包，再在下方「路径」里指定其根目录。<br>
          下载地址：<a href="https://github.com/RVC-Boss/GPT-SoVITS" target="_blank" style="color:var(--primary,#6366f1);">github.com/RVC-Boss/GPT-SoVITS</a>
          （或搜 GPT-SoVITS 一键整合包）
        </div>`;
      box.querySelectorAll('.tts-preset').forEach(b => {
        b.addEventListener('click', () => notify('已选择 ' + b.dataset.key + '（需在启动参数里指定该权重，本版暂不切换）', 'info'));
      });
    }
  }

  /** round75c：应用 GPT 音色（切换 logs/ 训练音色，合成时热切权重 + 换该音色 ref） */
  async function ttsApplyVoice() {
    const sel = $('ttsVoiceSel2');
    if (!sel) return;
    try {
      const name = sel.value;
      if (name) {
        const vs = await call('/voices?engine=gptsovits');
        const hit = (vs.voiceList || []).find(v => v.name === name);
        if (!hit) { notify('未找到该音色', 'error'); return; }
        if (!hit.gptWeights || !hit.sovitsWeights) {
          notify('音色「' + name + '」缺 GPT 或 SoVITS 权重文件，无法切换', 'error');
          return;
        }
        await call('/config', { gptVoice: name, refAudio: hit.ref });
        notify('音色已切到「' + name + '」，试听即可验证');
      } else {
        await call('/config', { gptVoice: '' });
        notify('已取消音色，回到情绪参考音模式');
      }
    } catch (e) { notify('切换音色失败：' + e.message, 'error'); }
    await loadCfg();
    render();
  }

  function renderPaths() {
    const box = $('ttsPathBox');
    if (!box || !cfg) return;
    const rows = [
      ['Python', cfg.pythonPath],
      ['VITS 目录', cfg.vitsDir],
      ['GPT-SoVITS 目录', cfg.gptSovitsDir],
      ['参考音频', cfg.refAudio ? String(cfg.refAudio).split('\\').slice(-3).join('\\') : '（未选）'],
      ['缓存目录', cfg.cacheDir],
    ].filter(r => r[1]);
    box.innerHTML = `<details class="tts-paths"><summary>路径与配置（${esc(cfg.configFile || '')}）</summary>` +
      rows.map(r => `<div class="tts-path-row"><b>${esc(r[0])}</b><span>${esc(r[1])}</span></div>`).join('') +
      `<div class="settings-btn-row" style="margin-top:8px;">
         <button class="btn-pill btn-pill--ghost" onclick="ttsEditPaths()">✏️ 手动指定路径</button>
         <button class="btn-pill btn-pill--warn" onclick="ttsMigrateCache()">📦 迁移缓存到 D 盘</button>
       </div></details>`;
  }

  /* ---------------- 动作 ---------------- */

  async function withBusy(fn, label) {
    if (busy) return;
    busy = true;
    render();
    if (label) notify(label);
    try { await fn(); }
    catch (e) { notify('失败：' + e.message, 'error'); }
    finally { busy = false; await refresh(); render(); }
  }

  const acts = {
    async diagnose() {
      diag = await call('/diagnose', { engine: cfg.engine });
      const s = diag.summary;
      notify(s.verdict, s.bad ? 'error' : 'info');
    },
    async repair() {
      const d = await call('/repair', { engine: cfg.engine, kind: 'restart' });
      notify('修复完成：' + (d.acts || []).map(a => a.step + '→' + a.result).join('；').slice(0, 120));
    },
    async start() {
      // ★ 启动要 18~54 秒（加载模型 + 合成能力探测），期间必须有可见反馈，
      //   否则用户点了没反应，以为按钮坏了。这里每 2 秒刷一次状态灯与秒数。
      const dot = $('ttsDot'), tip = $('ttsStatusText');
      if (dot) dot.className = 'tts-dot wait';
      if (tip) tip.textContent = '正在启动（0s）…';
      let waited = 0;
      const timer = setInterval(() => {
        waited += 2;
        if (tip && !busy2()) tip.textContent = '正在启动（' + waited + 's）…首次需加载模型，请耐心';
        if (waited > 240) { clearInterval(timer); if (tip && !busy2()) tip.textContent = '启动超时，请点「一键修复」'; }
      }, 2000);

      try {
        const d = await call('/start', { engine: cfg.engine });
        clearInterval(timer);
        window.__ttsStatus = window.__ttsStatus || {};
        window.__ttsStatus[cfg.engine] = { state: 'ready', running: true, port: d.port };
        if (dot) dot.className = 'tts-dot ok';
        if (tip) tip.textContent = '已就绪' + (d.port ? '（端口 ' + d.port + '）' : '');
        notify('已唤起' + (d.portReason ? '（' + d.portReason + '）' : '') + '，耗时 ' + Math.round(d.bootMs / 1000) + ' 秒');
      } catch (e) {
        clearInterval(timer);
        if (dot) dot.className = 'tts-dot fail';
        if (tip) tip.textContent = '启动失败：' + e.message.slice(0, 60);
        notify('启动失败：' + e.message, 'error');
        // 失败也跑一次体检，把原因摆出来
        try { diag = await call('/diagnose', { engine: cfg.engine }); } catch (e2) { }
      }
    },
    async stop() {
      const d = await call('/stop', { engine: cfg.engine });
      window.__ttsStatus = window.__ttsStatus || {};
      window.__ttsStatus[cfg.engine] = { state: 'stopped', running: false };
      notify(d.skipped ? (d.msg || '该服务非本应用启动，已保留') : '已关闭');
    },
    async autodiscover() {
      const d = await call('/autodiscover', {});
      notify(d.changed.length ? ('已自动填好：' + d.changed.join('、')) : '未发现新的安装位置');
    },
  };

  async function doFix(key, kind, field) {
    if (kind === 'downloadModel') {          // round77：VITS 权重缺失 → 直接起下载
      await ttsModelDownload();
      return;
    }
    if (kind === 'installPkgs') {
      const ok = confirm('将用 pip 安装缺失的依赖包，可能需要几分钟。要继续吗？');
      if (!ok) return;
      const { execFile } = window.require ? window.require('child_process') : {};
      notify('请在命令行执行：pip install 相关包后重新体检');
      return;
    }
    if (kind === 'cleanCache') {
      const d = await call('/repair', { engine: cfg.engine, kind: 'cleanCache' });
      notify('已清理：' + JSON.stringify(d.acts));
      return;
    }
    if (kind === 'switchPort') {
      const next = (Number(cfg.port) || 9880) + 1;
      await call('/config', { port: next });
      notify('端口已改为 ' + next + '，再次点「一键唤起」生效');
      await loadCfg();
      return;
    }
    if (kind === 'killPort') {
      const d = await call('/repair', { engine: cfg.engine, kind: 'port' });
      notify('已处理端口：' + (d.acts || []).map(a => a.result).join('；').slice(0, 140));
      return;
    }
    if (kind === 'retryStart') { await acts.start(); return; }
    if (kind === 'rescan' || kind === 'setPath') {
      // ★ round74b 修复：字段必须来自体检项的 payload.field（ffmpeg 项是 ffmpegPath），
      //   之前无视 payload 写死 pythonPath —— 用户填的 ffmpeg 路径被存进 pythonPath
      const map = { rescan: 'gptSovitsDir', setPath: 'pythonPath' };
      const key2 = field || map[kind] || 'pythonPath';
      const titleHint = key2 === 'ffmpegPath'
        ? '请输入 ffplay.exe 或 ffmpeg.exe 的完整路径（也可以只填所在目录）：'
        : '请输入 ' + key2 + ' 路径：';
      const val = await ttsPrompt(titleHint, cfg[key2] || '');
      if (val) { await call('/config', { [key2]: val }); notify('已保存 ' + key2); await loadCfg(); }
      return;
    }
    notify('该项需要手动处理：' + key, 'info');
  }

  async function ttsSetSpeaker() {
    const sel = $('ttsVoiceSel');
    if (!sel) return;
    try {
      await call('/config', { vitsSpeakerId: Number(sel.value) || 0 });
      notify('已切换音色 #' + sel.value);
    } catch (e) { notify('切换音色失败：' + e.message, 'error'); }
    await loadCfg();
    render();
  }

  async function ttsApplyEmotion() {
    const sel = $('ttsEmotion');
    if (!sel) return;
    try {
      const emo = sel.value;
      let ref = cfg.refAudio;
      if (emo) {
        const vs = await call('/voices?engine=gptsovits');
        const hit = (vs.emotions || []).find(e => e.name === emo);
        if (!hit) { notify('未找到该情绪的参考音', 'error'); return; }
        ref = hit.file;
      }
      await call('/config', { emotion: emo, refAudio: ref });
      notify(emo ? ('参考音已切到「' + emo + '」') : '已切回默认参考音');
    } catch (e) { notify('设置参考音失败：' + e.message, 'error'); }
    await loadCfg();
    render();
  }

  let previewAudio = null;   // 前端试听的 <audio>，新试听打断旧的

  async function ttsPreview() {
    const text = await ttsPrompt('试听文本（可直接改）：', '你好，这是语音朗读的试听。');
    if (!text) return;
    notify('正在合成…');
    try {
      const speakerId = cfg.engine === 'vits' ? (Number(($('ttsVoiceSel') || {}).value) || cfg.vitsSpeakerId || 0) : undefined;
      // round75c：GPT 试听跟随「音色」下拉当前选择（含未保存的临时选择）
      const vsel = $('ttsVoiceSel2');
      const voice = cfg.engine === 'gptsovits' && vsel ? vsel.value : undefined;
      // play:false —— 服务端只合成不出声，播放交给前端 <audio>：
      // 用户点了「确定」就是用户手势，Electron 自动播放策略放行，且走应用自身音频设备（round74b）。
      const d = await call('/synthesize', { engine: cfg.engine, text, speakerId, voice, play: false });
      const name = String(d.path || '').split(/[\\/]/).pop();
      if (!/^[A-Za-z0-9._-]+\.wav$/.test(name)) throw new Error('合成结果异常：' + String(d.path || '（空）').slice(0, 80));
      if (previewAudio) { try { previewAudio.pause(); } catch (e) { } }
      previewAudio = new Audio('/api/tts/audio/' + name);
      previewAudio.volume = 1.0;
      // round76：GPT 合成固定 1.0（speed_factor 有损），语速走播放端无损变速
      if (cfg.engine === 'gptsovits') previewAudio.playbackRate = Number(cfg.speed) || 1;
      await previewAudio.play();
      notify(d.cached ? '命中缓存，正在播放' : '合成完成，正在播放', 'info');
    } catch (e) {
      notify('试听失败：' + e.message, 'error');
    }
  }

  async function ttsEditPaths() {
    // Electron 不支持 prompt()，改用页面内弹窗；确定返回字符串（可为空=跳过），取消返回 null
    const f = await ttsPrompt('VITS 目录（清空后点确定 = 跳过）：', cfg.vitsDir || '');
    if (f === null) return;
    const g = await ttsPrompt('GPT-SoVITS 目录（清空后点确定 = 跳过）：', cfg.gptSovitsDir || '');
    if (g === null) return;
    const p = await ttsPrompt('Python 解释器路径（清空后点确定 = 跳过）：', cfg.pythonPath || '');
    if (p === null) return;
    const patch = {};
    if (f) patch.vitsDir = f; if (g) patch.gptSovitsDir = g; if (p) patch.pythonPath = p;
    if (!Object.keys(patch).length) { notify('未修改任何路径'); return; }
    await call('/config', patch);
    notify('已保存' + Object.keys(patch).join('、'));
    await loadCfg();
    render();
  }

  /* ---------------- 轮询状态 ---------------- */

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!cfg || cfg.engine === 'off') return;
      try {
        const d = await call('/status?engine=' + cfg.engine);
        window.__ttsStatus = window.__ttsStatus || {};
        const prev = window.__ttsStatus[cfg.engine] || {};
        window.__ttsStatus[cfg.engine] = d;
        if (prev.state !== d.state) render();
      } catch (e) { /* 后端还没起来，忽略 */ }
    }, 4000);
  }

  async function loadCfg() {
    // ★ call() 已经把响应的 {code,data} 解包成 data 了，这里不能再多取一层 .data，
    //   否则 cfg 永远是 undefined → render() 里的 `if (!cfg) return` 会让面板一直停在「正在加载…」。
    const d = await call('/config');
    if (d) cfg = d;
  }
  async function loadVoices() {
    if (!cfg || cfg.engine === 'off') { voices = null; return; }
    try {
      // 引擎侧已保证「没启动也秒回」（直接读 speakers_list.txt），这里不用加参数
      const d = await call('/voices?engine=' + cfg.engine);
      if (cfg.engine === 'vits') d.all = d.voices || [];
      voices = d;
    } catch (e) { voices = null; }
  }
  async function refresh() {
    await loadCfg();
    await Promise.all([loadVoices(), (async () => { try { window.__ttsStatus = window.__ttsStatus || {}; window.__ttsStatus[cfg.engine] = (await call('/status?engine=' + cfg.engine)); } catch (e) { } })()]);
  }

  /* ---------------- 对外 ---------------- */

  async function ttsMigrateCache() {
    const cur = cfg && cfg.cacheDir || '';
    if (/^[a-z]:/i.test(cur) && cur[0].toUpperCase() === 'C:') {
      const okc = confirm('当前缓存在 C 盘（' + cur + '）。建议迁到项目同盘（D 盘）以节省 C 盘空间。要继续吗？');
      if (!okc) return;
    }
    const SEP = String.fromCharCode(92);
    const def = ['D:', 'ai program', 'local-movie-library', 'exe', '本地数据-敏感', 'tts-cache'].join(SEP);
    const to = await ttsPrompt('新的缓存目录：', def);
    if (!to) return;
    try {
      const d = await call('/migrate-cache', { to });
      notify(d.msg + '（' + (d.bytes / 1048576).toFixed(1) + 'MB）');
    } catch (e) { notify('迁移失败：' + e.message, 'error'); }
    await loadCfg();
  }

  /** round76：为当前音色指定自定义参考音频（覆盖训练切片自动挑选；留空路径 = 恢复自动） */
  async function ttsChangeVoiceRef() {
    const sel = $('ttsVoiceSel2');
    if (!sel || !cfg) return;
    const name = sel.value;
    if (!name) { notify('先在上拉选一个音色，再换它的参考音', 'error'); return; }
    const cur = (cfg.gptVoiceRefs || {})[name] || '';
    const p = await ttsPrompt('为「' + name + '」输入参考音频完整路径（3~10 秒 wav/mp3；留空 = 恢复自动挑选）：', cur);
    if (p === null) return;
    try {
      const refs = Object.assign({}, cfg.gptVoiceRefs || {});
      if (p.trim()) refs[name] = p.trim();
      else delete refs[name];
      await call('/config', { gptVoiceRefs: refs });
      notify(p.trim() ? ('「' + name + '」参考音已更新，试听即可对比') : ('「' + name + '」已恢复自动挑选参考音'));
    } catch (e) { notify('保存失败：' + e.message, 'error'); }
    await loadCfg();
    render();
  }

  window.ttsMigrateCache = ttsMigrateCache;
  window.ttsAct = (k) => withBusy(acts[k], k === 'start' ? '正在唤起引擎（首次可能要一分钟左右）' : '');
  window.ttsSetSpeaker = ttsSetSpeaker;
  window.ttsApplyEmotion = ttsApplyEmotion;
  window.ttsApplyVoice = ttsApplyVoice;
  window.ttsChangeVoiceRef = ttsChangeVoiceRef;
  window.ttsPreview = ttsPreview;
  window.ttsEditPaths = ttsEditPaths;
  window.ttsModelDownload = ttsModelDownload;
  window.ttsModelCancel = ttsModelCancel;
  window.TtsPanel = { render, refresh: async () => { await refresh(); render(); } };

  /* ---------------- 挂载 ---------------- */

  /**
   * 设置页是**懒渲染**的：DOMContentLoaded 时 #ttsPanel 还不存在（在设置模板里，
   * 要等用户点开设置才注入）。所以不能只靠 DOMContentLoaded —— 那次会直接 return，
   * 面板永远停在「正在加载…」。这里用 MutationObserver 盯着它出现，露面即渲染。
   */
  let mounted = false;
  function tryMount() {
    const el = $('ttsPanel');
    if (!el || el.dataset.ready) return;
    el.dataset.ready = '1';
    mounted = true;
    refresh().then(render).catch((e) => {
      // round74c：失败时**保留** data-ready，只显示错误 + 手动重试。
      // 之前 delete dataset.ready + 常驻观察者 = 每次页面 DOM 变化都重试 → 请求风暴。
      el.innerHTML = '<div style="font-size:12px;color:#ef4444;">面板加载失败：' + esc(e.message) +
        ' <button class="btn btn-sm" onclick="var p=document.getElementById(\'ttsPanel\');if(p)p.removeAttribute(\'data-ready\');TtsPanel.mount()">重试</button></div>';
    });
    startPoll();
  }

  function boot() {
    if ($('ttsPanel')) { tryMount(); return; }
    // round74c 修复「从小说页回设置一直加载中」：设置视图每次重渲染都会造一个**新的**
    // #ttsPanel（没有 data-ready），而旧代码首次挂载后就 mo.disconnect() 了 →
    // 之后永远没人再挂载。观察者改为**常驻**，看到没挂载的面板就挂（tryMount 幂等）。
    const mo = new MutationObserver(() => {
      const el = $('ttsPanel');
      if (el && !el.dataset.ready) tryMount();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    // 兜底：设置页可能早就开着（刷新场景）
    setTimeout(tryMount, 1500);
    setTimeout(tryMount, 4000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.TtsPanel.mount = tryMount;
})();
