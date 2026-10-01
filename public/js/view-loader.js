/* ============================================================
   午夜场 · view-loader.js —— 换页加载动画「开演 Open Reel」
   ------------------------------------------------------------
   零改动挂载：包装 window.switchView（不改 app.js 一行）。
   时序（v2，按实机 mutation 取证重设计）：
     t0        V3 极光线立即起（transform 合成器动画，
               主线程冻结的重同步渲染期间也能转）；布观察者
     变更流    每次子树变更刷新「静默计时」，静默 180ms = 就位 → 收
     ≥250ms    若仍零变更（真异步等待）→ V1 中央盘动 + 旧内容压暗
     ≥800ms    仍零变更 → 追加 V2 走带
     3s        安全阀强收
   兜底：视频失败 → 静帧 PNG（复用 nav-icons/reel.png）；
   reduced-motion 整层不启用；瞬时切换只闪 ~250ms 细线，永不白屏。
   ============================================================ */
(function () {
  'use strict';
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var DIR = 'img/view-loader/';
  var FALLBACK = 'img/nav-icons/reel.png';
  var SETTLE = 180;              /* 变更静默多久算就位 */
  var root = null, video = null, img = null, main = null;
  var state = 'idle';            /* idle | armed | shown */
  var timers = [];
  var activeMo = null;
  var lastView = null, lastT = 0;

  function ensureDom() {
    if (root) return;
    main = document.querySelector('main.content') || document.querySelector('.content');
    if (!main) return;
    root = document.createElement('div');
    root.className = 'nvl-root';
    root.hidden = true;
    root.innerHTML =
      '<div class="nvl-line"></div>' +
      '<div class="nvl-center"><span class="nvl-reel">' +
      '<video muted loop playsinline disablepictureinpicture preload="auto"></video>' +
      '<img alt="" draggable="false"></span><b>正在换盘 …</b></div>' +
      '<div class="nvl-strip"></div>';
    video = root.querySelector('video');
    img = root.querySelector('img');
    video.addEventListener('error', function () { video.hidden = true; });
    video.addEventListener('play', function () { img.hidden = true; });
    img.src = FALLBACK;
    video.src = DIR + 'reel-spin.webm';
    document.body.appendChild(root);
  }

  function place() {
    var r = main.getBoundingClientRect();
    root.style.left = r.left + 'px';
    root.style.top = r.top + 'px';
    root.style.width = r.width + 'px';
    root.style.height = r.height + 'px';
  }

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  /* round45 反馈：快切零动效（像素揭示整层撤下）；
     只有真等待（250ms 零变更）才出 dim + 中央盘 */
  function finish() {
    clearTimers();
    if (activeMo) {
      try { activeMo.disconnect(); } catch (e) /* noop */ {}
      activeMo = null;
    }
    if (root) {
      root.hidden = true;
      root.className = 'nvl-root';
      try { video.pause(); } catch (e) /* noop */ {}
    }
    if (main) main.classList.remove('nvl-dim');
    state = 'idle';
  }

  function begin() {
    ensureDom();
    if (!root || !main) return;
    place();
    state = 'armed';
    root.hidden = true;              /* round45：快切零动效，250ms 零变更才显形 */

    var mutCount = 0;
    var settleT = null;
    activeMo = new MutationObserver(function () {
      mutCount++;
      if (settleT) clearTimeout(settleT);
      settleT = setTimeout(function () {   /* 变更静默 SETTLE ms = 就位 */
        if (state !== 'idle') finish();
      }, SETTLE);
    });
    activeMo.observe(main, { childList: true, subtree: true });

    timers.push(setTimeout(function () {   /* 250ms 仍零变更：V1 + 压暗 */
      if (state === 'armed' && mutCount === 0) {
        state = 'shown';
        place();                           /* 窗口尺寸可能已变 */
        root.hidden = false;
        root.className = 'nvl-root nvl-v1';
        try {
          video.currentTime = 0;
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) { /* noop */ }
        main.classList.add('nvl-dim');
      }
    }, 250));
    timers.push(setTimeout(function () {   /* 800ms 仍零变更：追加走带 */
      if (state === 'shown' && mutCount === 0) root.classList.add('nvl-v2');
    }, 800));
    timers.push(setTimeout(function () {   /* 安全阀 */
      finish();
    }, 3000));
  }

  function wrap() {
    if (typeof window.switchView !== 'function') {
      setTimeout(wrap, 200);
      return;
    }
    var orig = window.switchView;
    window.switchView = function (view) {
      var now = Date.now();
      var reclick = view === lastView && now - lastT < 600;
      lastView = view;
      lastT = now;
      document.body.dataset.view = view;      /* 供各页辨识色/标题字使用 */
      finish();
      if (reclick) return orig.apply(this, arguments);
      ensureDom();
      if (!root || !main) return orig.apply(this, arguments);
      if (window.NVX_LOADER_OFF !== true) begin();   /* 动效库可整体关闭换页层（round49） */
      return orig.apply(this, arguments);
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wrap);
  } else {
    wrap();
  }
})();
