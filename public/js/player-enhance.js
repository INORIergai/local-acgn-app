// ================================================================
// player-enhance.js —— round173g 播放器增强
//   ①外挂字幕  ②跳过片头/片尾  ③缓冲进度条  ④画中画
//   挂 window.PlayerEnhance，由 showVideoPlayer() 调 onPlay(url,title)。
//   ★ 语义令牌双皮肤；按钮事件在模块内绑定，不内联 onclick。
// ================================================================
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (u) => { const r = await fetch(u); return r.json().catch(() => ({})); };
  const SKIP_KEY = (title) => 'cv:skip:' + String(title || '').trim().slice(0, 120);

  let bound = false;
  let currentTitle = '';
  let currentMatchTitle = '';
  let skipCfg = null;         // {opEnd, edStart}
  let skipFired = { op: false, ed: false };
  let subtitleTracks = [];

  function bindOnce() {
    if (bound) return;
    bound = true;
    const subBtn = $('playerSubtitleBtn');
    const skipBtn = $('playerSkipBtn');
    const pipBtn = $('playerPipBtn');
    if (subBtn) subBtn.addEventListener('click', toggleSubtitleMenu);
    if (skipBtn) skipBtn.addEventListener('click', doSkip);
    if (pipBtn) pipBtn.addEventListener('click', togglePip);
    // 点菜单外关闭
    document.addEventListener('click', (e) => {
      const menu = $('playerSubtitleMenu');
      if (menu && menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== subBtn) menu.style.display = 'none';
    });
  }

  /** 由 showVideoPlayer 调用：新片开始，重置状态并探测字幕 */
  function onPlay(videoUrl, title, matchTitle) {
    bindOnce();
    currentTitle = String(title || '');
    // round185 A4：本地字幕库是按文件名搜的，展示标题里的「· 第N集」要洗掉
    currentMatchTitle = String(matchTitle || title || '');
    skipFired = { op: false, ed: false };
    clearTracks();
    clearAssLayer();
    readSkipCfg();
    updateSkipBtn();
    updatePipBtn();
    // 第一档②：追番集从 DB 异步加载跳过区间（按 episode），覆盖 localStorage 值
    const epId = window.__svPlayingEpisode || 0;
    if (epId) {
      fetch('/api/series/episode/skip?episodeId=' + epId).then(r => r.json()).then(j => {
        if (j && j.code === 0 && j.data && (j.data.skipOp || j.data.skipEd)) {
          skipCfg = { opEnd: j.data.skipOp || 0, edStart: j.data.skipEd || 0 };
          updateSkipBtn();
        }
      }).catch(() => {});
    }
    // 本地媒体路径（/api/movie/stream?path=...）才可扫同名字幕；在线流传 videoUrl 让后端过滤
    let mediaPath = '';
    try {
      const u = new URL(videoUrl, location.href);
      if (u.pathname.indexOf('/api/movie/stream') >= 0) mediaPath = decodeURIComponent(u.searchParams.get('path') || '');
      /* round185 A4：只有「本地可访问的路径」才谈得上扫同目录字幕。
       * 在线流是 http(s) 直链/代理地址，拿它去 /api/player/subtitles 只会白等一次请求，
       * 直接跳过、走下面的字幕库按标题搜。 */
      else if (!/^https?:\/\//i.test(videoUrl) && /\.(mp4|mkv|avi|mov|m4v|ts|flv|webm)(\?|$)/i.test(videoUrl)) mediaPath = videoUrl;
    } catch (e) { /* 非标准 URL */ }
    scanSubtitles(mediaPath);
  }

  // ---------- 字幕 ----------
  async function scanSubtitles(mediaPath) {
    const menu = $('playerSubtitleMenu');
    if (!menu) return;
    try {
      if (mediaPath) {
        const r = await api('/api/player/subtitles?path=' + encodeURIComponent(mediaPath));
        subtitleTracks = (r && r.code === 0 && Array.isArray(r.data)) ? r.data : [];
      } else subtitleTracks = [];
      // v6.4.0②：在线流/无同名字幕 → 在媒体目录按标题搜本地字幕库
      if (!subtitleTracks.length && currentMatchTitle) {
        const r2 = await api('/api/player/subtitle-library?title=' + encodeURIComponent(currentMatchTitle));
        subtitleTracks = (r2 && r2.code === 0 && Array.isArray(r2.data)) ? r2.data : [];
        if (subtitleTracks.length) subtitleTracks.forEach(x => { x.lang = x.lang || '本地库'; });
      }
    } catch (e) { subtitleTracks = []; }
    renderSubtitleMenu();
  }

  function renderSubtitleMenu() {
    const menu = $('playerSubtitleMenu');
    if (!menu) return;
    const opts = subtitleTracks.map((t, i) =>
      '<button type="button" class="psm-item" data-idx="' + i + '">' + esc(t.lang) + ' · ' + esc(t.name) + '</button>'
    ).join('');
    // ★ 两栏布局：左=跳过区间设置，右=字幕列表。压缩高度，避免超出播放器被裁。
    menu.innerHTML = '<div class="psm-col">'
      + '<div class="psm-title">跳过片头片尾（秒）</div>'
      + '<div class="psm-skip-row"><label>片头结束</label><input type="number" min="0" id="psmOpEnd" value="' + (skipCfg.opEnd || 0) + '"></div>'
      + '<div class="psm-skip-row"><label>片尾开始</label><input type="number" min="0" id="psmEdStart" value="' + (skipCfg.edStart || 0) + '"></div>'
      + '<button type="button" class="psm-save" id="psmSaveSkip">保存区间</button>'
      + '</div><div class="psm-col">'
      + '<div class="psm-title">外挂字幕</div>'
      + '<button type="button" class="psm-item" data-idx="-1">关闭字幕</button>'
      + (opts || '<div class="psm-empty">同目录无 srt/ass/vtt</div>')
      + '</div>';
    menu.querySelectorAll('[data-idx]').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.idx);
      selectSubtitle(i);
      menu.style.display = 'none';
    }));
    const save = menu.querySelector('#psmSaveSkip');
    if (save) save.addEventListener('click', () => {
      window.PlayerEnhance.setSkipCfg({
        opEnd: Number((menu.querySelector('#psmOpEnd') || {}).value || 0),
        edStart: Number((menu.querySelector('#psmEdStart') || {}).value || 0)
      });
      menu.style.display = 'none';
    });
  }

  function clearTracks() {
    const video = $('videoPlayer');
    if (!video) return;
    video.querySelectorAll('track[data-enhance="1"]').forEach(t => t.remove());
    if (video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        try { video.textTracks[i].mode = 'disabled'; } catch (e) {}
      }
    }
    subtitleTracks = [];
  }

  // ---------- v6.4.0① ASS 特效字幕层 ----------
  let assCues = [];
  let assActive = false;
  let assRaf = 0;

  function clearAssLayer() {
    assCues = []; assActive = false;
    if (assRaf) { cancelAnimationFrame(assRaf); assRaf = 0; }
    const layer = $('assSubLayer');
    if (layer) layer.innerHTML = '';
  }

  async function loadAssStyles(t) {
    try {
      const r = await api('/api/player/subtitle-styled?path=' + encodeURIComponent(t.path));
      const data = r && r.code === 0 && r.data;
      if (!data || !data.cues || !data.cues.length) return false;
      assCues = data.cues; assActive = true;
      startAssLoop();
      return true;
    } catch (e) { return false; }
  }

  function startAssLoop() {
    if (assRaf) return;
    const tick = () => {
      if (!assActive) { assRaf = 0; return; }
      const video = $('videoPlayer'), layer = $('assSubLayer');
      if (video && layer) {
        const t = video.currentTime;
        // 二分找当前 cue（cues 已按 start 排序）
        let active = null;
        for (const c of assCues) {
          if (c.start <= t && t <= c.end) active = c;
          else if (c.start > t) break;
        }
        if (active) {
          const st = active.style || {};
          const pos = st.pos || st.move;
          let css = 'color:' + (st.color || '#fff') + ';font-size:' + (st.fontSize || 20) + 'px;'
            + 'font-weight:' + (st.bold ? 700 : 400) + ';font-style:' + (st.italic ? 'italic' : 'normal') + ';';
          if (st.borderColor) css += '-webkit-text-stroke:1px ' + st.borderColor + ';';
          else if (st.border) css += 'text-shadow:0 1px 2px #000,0 0 1px #000;';
          if (pos) css += 'left:' + (pos[0] / 3840 * 100).toFixed(2) + '%;top:' + (pos[1] / 2160 * 100).toFixed(2) + '%;transform:translate(-50%,-50%);position:absolute;';
          else css += 'left:50%;bottom:12%;transform:translateX(-50%);position:absolute;';
          const html = active.text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
          if (layer.dataset.sig !== active.start + '|' + html) {
            layer.innerHTML = '<div class="ass-cue" style="' + css + '">' + html + '</div>';
            layer.dataset.sig = active.start + '|' + html;
          }
          layer.style.display = 'block';
        } else if (layer.innerHTML) {
          layer.innerHTML = ''; layer.dataset.sig = ''; layer.style.display = 'none';
        }
      }
      assRaf = requestAnimationFrame(tick);
    };
    assRaf = requestAnimationFrame(tick);
  }

  function selectSubtitle(idx) {
    const video = $('videoPlayer');
    if (!video) return;
    clearTracks();
    clearAssLayer();
    if (idx < 0 || !subtitleTracks[idx]) return;
    const t = subtitleTracks[idx];
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = t.name;
    track.srclang = 'zh';
    track.src = '/api/player/subtitle-file?path=' + encodeURIComponent(t.path);
    track.setAttribute('data-enhance', '1');
    track.default = true;
    video.appendChild(track);
    // 追加后手动置 showing（default 在动态追加时部分内核不自动启用）
    setTimeout(() => {
      try {
        for (let i = 0; i < video.textTracks.length; i++) {
          if (video.textTracks[i].label === t.name) video.textTracks[i].mode = 'showing';
        }
      } catch (e) {}
      // v6.4.0①：ASS 轨额外加载特效层（隐藏原生 track 避免双重字幕）
      if (/\.(ass|ssa)$/i.test(t.path || t.name)) {
        loadAssStyles(t).then(ok => {
          if (ok) {
            for (let i = 0; i < video.textTracks.length; i++) {
              try { video.textTracks[i].mode = 'disabled'; } catch (e) {}
            }
          }
        });
      }
    }, 120);
  }

  function toggleSubtitleMenu(e) {
    e.stopPropagation();
    const menu = $('playerSubtitleMenu');
    if (!menu) return;
    if (menu.style.display === 'none') { renderSubtitleMenu(); menu.style.display = 'grid'; }
    else menu.style.display = 'none';
  }

  // ---------- 跳过片头/片尾 ----------
  function readSkipCfg() {
    // 先读 localStorage（普通影片仍按片名存）；追番集随后由 onPlay 异步从 DB 覆盖
    try { skipCfg = JSON.parse(localStorage.getItem(SKIP_KEY(currentTitle)) || 'null'); }
    catch (e) { skipCfg = null; }
    if (!skipCfg || typeof skipCfg !== 'object') skipCfg = { opEnd: 0, edStart: 0 };
  }
  function saveSkipCfg() {
    const epId = window.__svPlayingEpisode || 0;
    if (epId) {
      // 异步写 DB，失败静默
      fetch('/api/series/episode/skip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId: epId, skipOp: skipCfg.opEnd || 0, skipEd: skipCfg.edStart || 0 })
      }).catch(() => {});
    }
    try { localStorage.setItem(SKIP_KEY(currentTitle), JSON.stringify(skipCfg)); } catch (e) {}
  }
  function updateSkipBtn() {
    const btn = $('playerSkipBtn');
    if (!btn) return;
    // 有至少一个区间才显示
    btn.style.display = (skipCfg.opEnd > 0 || skipCfg.edStart > 0) ? '' : 'none';
  }
  function doSkip() {
    const video = $('videoPlayer');
    if (!video) return;
    const t = video.currentTime;
    if (skipCfg.opEnd > 0 && t < skipCfg.opEnd) video.currentTime = skipCfg.opEnd + 0.1;
    else if (skipCfg.edStart > 0 && t >= skipCfg.edStart - 30) video.currentTime = video.duration - 0.2;
  }
  function onTimeUpdate() {
    const video = $('videoPlayer');
    const btn = $('playerSkipBtn');
    if (!video || !btn || btn.style.display === 'none') return;
    const t = video.currentTime;
    if (skipCfg.opEnd > 0 && t >= 0 && t < skipCfg.opEnd && !skipFired.op) {
      btn.textContent = '⏭ 跳过片头'; btn.style.display = '';
    } else if (skipCfg.edStart > 0 && t >= skipCfg.edStart && !skipFired.ed) {
      btn.textContent = '⏭ 跳过片尾'; btn.style.display = '';
    }
  }

  // ---------- 画中画 ----------
  function updatePipBtn() {
    const btn = $('playerPipBtn');
    if (!btn) return;
    btn.style.display = (document.pictureInPictureEnabled && $('videoPlayer')) ? '' : 'none';
  }
  async function togglePip() {
    const video = $('videoPlayer');
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (e) { /* 浏览器不支持/用户拒绝，静默 */ }
  }

  // ---------- 缓冲进度条 ----------
  function updateBuffered() {
    const video = $('videoPlayer');
    const fill = $('playerProgressFill');
    const bar = $('playerProgress');
    if (!video || !fill || !bar) return;
    let buf = $('playerBufferedFill');
    if (!buf) {
      buf = document.createElement('div');
      buf.id = 'playerBufferedFill';
      buf.className = 'player-buffered-fill';
      bar.insertBefore(buf, fill);
    }
    if (!video.buffered || !video.buffered.length || !video.duration) { buf.style.width = '0%'; return; }
    // 取包含当前时间的 range 末端
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) >= video.currentTime) {
        end = video.buffered.end(i); break;
      }
      end = Math.max(end, video.buffered.end(i));
    }
    buf.style.width = Math.min(100, end / video.duration * 100) + '%';
  }

  // 周期更新（缓冲 + 跳过按钮）——低频 500ms，避免贴 timeupdate 高频重排
  setInterval(() => {
    const modal = $('playerModal');
    if (!modal || !modal.classList.contains('show')) return;
    updateBuffered();
    onTimeUpdate();
  }, 500);

  window.PlayerEnhance = { onPlay, clearTracks, saveSkipCfg, getSkipCfg: () => skipCfg, setSkipCfg: (c) => { skipCfg = Object.assign({}, skipCfg, c); saveSkipCfg(); updateSkipBtn(); } };
})();
