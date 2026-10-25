/* ============================================================
   CinemaVault · round113-flip.js —— 共享元素转场（P4）
   ------------------------------------------------------------
   背景：motion-flip.js 早就写好了 FLIP 引擎，且在 showMovieDetail /
   closeModal 里都有 enter()/exit() 调用，但**从来没调用过 record()**，
   于是 state.firstRect 恒为 null，每次都在函数开头就 early-return，
   只做了一次 .25s 淡入 —— 这就是「共享元素转场」一直没出现的原因。

   本文件在 motion-flip.js 之后加载，整体接管 window.MotionFLIP。
   不修改原文件 ⇒ 回滚只需从 library.html 删掉一行 <script>。

   设计要点
   · 源几何在 **window 捕获阶段** 的 click 里记录。捕获先于卡片上的
     内联 onclick / 冒泡监听，所以记录时卡片还没被弹窗顶掉。
     20+ 个 showMovieDetail 调用点一个都不用改。
   · 时长 / 曲线从 --mv2-d3 / --mv2-settle / --mv2-d2 读取，和
     round113 令牌层保持同一套语言；?motion=off 时整体不飞（回滚旧行为）。
   · 飞行代理是 body 直属的 position:fixed <img>，脱离抽屉的
     translateX 上下文，免受父级滑入位移叠加。
   · 抽屉是在飞的（translateX 40px / 260ms），所以 getBoundingClientRect()
     量到的是「动画进行中的视觉框」，与终态必然有差。
     round127 修复：以前拿这个中间态当终点，再在落地前 100ms 量一次真实 rect
     做「吸附校正」——那段二次过渡正是用户看到的「飞到了又挪一下」。
     现在改成：measure() 走 layoutRect()，用 offsetLeft/offsetTop/offsetWidth/
     offsetHeight 这些**布局值**（完全不受 CSS transform 影响）直接得到稳态框，
     主飞行一次到位，吸附代码整段删除。
   ============================================================ */
(function (global) {
  'use strict';

  /* 只认这些卡片宿主：点卡片任意位置（含标题）都算点封面 */
  var CARD_SEL = [
    '.movie-card', '.av-card', '.similar-card', '.nr-card',
    '.magic-card', '.deck-card', '.tl-card', '.hc-card'
  ].join(',');

  /* 卡片内部的按钮不该触发飞行（收藏/删除/选择…） */
  var SKIP_SEL = 'button, a, input, select, .card-act, .av-act, .card-actions, .fav-btn, .sel-box';

  var state = {
    host: null, img: null, src: '', first: null, radius: '12px',
    proxy: null, busy: false, timer: 0, at: 0
  };

  function motionOff() {
    var l = document.getElementById('mv2-motion-css');
    return !!(l && l.disabled);
  }
  function reduced() {
    try { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }
  /* 从令牌层读时长（ms）/ 曲线，读不到就用与令牌同值的兜底 */
  function tokTime(name, fb) {
    var v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) {}
    if (!v) return fb;
    return /ms$/.test(v) ? parseFloat(v) : parseFloat(v) * 1000;
  }
  function tokEase(name, fb) {
    var v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) {}
    return v && /cubic-bezier|linear|ease/.test(v) ? v : fb;
  }
  var DUR_IN = function () { return tokTime('--mv2-d3', 460); };
  var DUR_OUT = function () { return tokTime('--mv2-d2', 260); };
  /* 进场：长距离落位用 spring（有过冲 1.4%，像物件真的放下去了）。
     settle 曲线前段太陡（实测 12% 时间走完 55% 距离），460ms 里后 300ms 几乎不动，
     共享元素这种大跨度位移用它反而看不出「飞」的过程。 */
  var EASE_IN = function () { return tokEase('--mv2-spring', 'cubic-bezier(.32,.72,0,1)'); };
  /* 退场：要快走，用 snap，别拖尾巴 */
  var EASE_OUT = function () { return tokEase('--mv2-snap', 'cubic-bezier(.2,.8,.2,1)'); };

  function killProxy() {
    if (state.proxy && state.proxy.parentNode) state.proxy.parentNode.removeChild(state.proxy);
    state.proxy = null;
  }

  /* 「作废」而不是「清空」：只把时效打掉，让下一次 enter 视为过期走淡入。
     几何和 img 必须留着 —— 点关闭按钮/遮罩/Esc 都会经过捕获监听，
     若在这里清空 img，exit() 会因为没有源而直接收摊，弹窗变成瞬间消失。 */
  function clearSource() {
    state.at = 0;
  }

  /* ── 1. 记录源几何（捕获阶段 click） ───────────────────── */
  function record(node) {
    if (!node || !node.closest) return false;
    if (node.closest(SKIP_SEL)) return false;
    var host = node.closest(CARD_SEL);
    if (!host) return false;
    if (host.closest('.modal, #detailModal, #playerModal, #posterLightbox')) return false;

    var img = host.querySelector('img');
    if (!img) return false;
    var r = img.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;

    var src = img.currentSrc || img.src || '';
    if (!src) return false;

    state.host = host;
    state.img = img;
    state.src = src;
    state.first = { left: r.left, top: r.top, width: r.width, height: r.height };
    state.at = (global.performance || Date).now();
    try { state.radius = global.getComputedStyle(img).borderRadius || '12px'; } catch (e) { state.radius = '12px'; }
    return true;
  }

  /* ── 1.5 布局框（完全不含 CSS transform 的「稳态」几何） ──────────
     bug5 的真正根因就在这里。
     详情抽屉打开时 .modal-content 正在 translateX(40px)→0（drawer 模式），
     或 translateY(18px) scale(.985)→0（modal 模式）。
     getBoundingClientRect() 量到的是「动画进行中的视觉框」，而代理海报的终点
     必须是「动画结束后的视觉框」—— 两者差着那 40px / 18px / 1.5%。
     以前只靠一段 45ms 的二次吸附去补这个差，于是用户看到
     「已经飞到位了，最后又挪一小段」。

     offsetLeft/offsetTop/offsetWidth/offsetHeight 是**布局值**，
     不受任何 CSS transform 影响，正好等于动画结束后的稳态几何。
     顺带也解决了 motion-extras.js 给 .detail-poster 挂的
     `perspective(900px) rotateY(..) scale(1.02)` 鼠标视差 ——
     那个 scale(1.02) 会让 rect 虚胖 2%，以前也被当成终点。 */
  function layoutRect(el) {
    if (!el) return null;
    var w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return null;

    var x = 0, y = 0, node = el, hitFixed = false;
    while (node) {
      x += node.offsetLeft - (node.scrollLeft || 0);
      y += node.offsetTop - (node.scrollTop || 0);
      /* 元素自身是 position:fixed ⇒ 它的 offsetLeft/Top 已经相对视口，
         且 offsetParent 为 null；必须在这里就判定，否则后面会误减页面滚动 */
      var selfPos = '';
      try { selfPos = global.getComputedStyle(node).position; } catch (e) { selfPos = ''; }
      if (selfPos === 'fixed') { hitFixed = true; break; }
      var op = node.offsetParent;
      if (!op) break;
      var pos = '';
      try { pos = global.getComputedStyle(op).position; } catch (e) { pos = ''; }
      if (pos === 'fixed') hitFixed = true;
      node = op;
    }
    /* 走到 position:fixed 的祖先 ⇒ 已经是视口坐标，别再减页面滚动 */
    if (!hitFixed) {
      x -= global.scrollX || global.pageXOffset || 0;
      y -= global.scrollY || global.pageYOffset || 0;
    }
    return { left: x, top: y, width: w, height: h };
  }

  /* ── 2. 量目标框（布局稳态，与抽屉/视差动效完全解耦） ──────
     natFallback：详情海报此刻可能还没 decode 完（naturalWidth=0，offsetWidth=0），
     这时拿不到真实比例，只能用卡片图（同源，比例必然一致）的 natural 尺寸预测。
     预测值只在图片尚未完成布局时使用；一旦浏览器排好版，就以布局值为准。 */
  function measure(tp, natFallback) {
    if (!tp) return null;
    var cs;
    try { cs = global.getComputedStyle(tp); } catch (e) { return null; }

    var radius = cs.borderTopLeftRadius || '12px';

    /* ① 图片已完成布局：布局框就是终态，一次到位，无需任何预测/吸附 */
    var lay = layoutRect(tp);
    if (lay && lay.width > 8 && lay.height > 8) {
      return { left: lay.left, top: lay.top, width: lay.width, height: lay.height, radius: radius };
    }

    /* ② 图片还没就位：用 natural 比例 + CSS 约束预测 */
    var wrap = tp.closest('.detail-poster-wrap') || tp.parentElement;
    var natW = tp.naturalWidth || 0, natH = tp.naturalHeight || 0;
    if ((natW <= 0 || natH <= 0) && natFallback && natFallback[0] > 0 && natFallback[1] > 0) {
      natW = natFallback[0];
      natH = natFallback[1];
    }
    if (natW <= 0 || natH <= 0) return null;

    /* 基准位置取 wrap 的布局框，再按 text-align:center 水平居中 */
    var wrapLay = layoutRect(wrap);
    var availW = wrapLay ? wrapLay.width : 0;
    if (!wrapLay) return null;

    var bx = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
    var by = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    var maxH = parseFloat(cs.maxHeight) || 0;
    var maxW = parseFloat(cs.maxWidth) || 0;

    var cw = natW, ch = natH;
    /* 与 CSS `max-height` + `max-width` + `width:auto` 同序求解 */
    if (maxH > 0 && ch + by > maxH) { ch = maxH - by; cw = ch * natW / natH; }
    var capW = availW;
    if (maxW > 0 && (capW <= 0 || maxW < capW)) capW = maxW;
    if (capW > 0 && cw + bx > capW) { cw = capW - bx; ch = cw * natH / natW; }

    var w = cw + bx, h = ch + by;
    return {
      left: wrapLay.left + Math.max(0, (availW - w) / 2),
      top: wrapLay.top,
      width: w,
      height: h,
      radius: radius
    };
  }

  function makeProxy(from, radius, src) {
    var el = document.createElement('img');
    el.className = 'flip-flight-proxy';
    el.src = src;
    el.alt = '';
    el.draggable = false;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = [
      'position:fixed',
      'left:' + from.left.toFixed(2) + 'px',
      'top:' + from.top.toFixed(2) + 'px',
      'width:' + from.width.toFixed(2) + 'px',
      'height:' + from.height.toFixed(2) + 'px',
      'object-fit:cover',
      'object-position:center',
      'border-radius:' + radius,
      'background:transparent',
      'box-shadow:0 10px 28px -10px rgba(0,0,0,.45)',
      'z-index:99999',
      'pointer-events:none',
      'margin:0',
      'max-width:none',
      'max-height:none',
      'transform:none',
      'will-change:left,top,width,height,border-radius,box-shadow',
      'transition:none'
    ].join(';') + ';';
    return el;
  }

  /* ── 3. 进场：卡片海报 → 详情海报 ───────────────────── */
  function enter(target) {
    if (!target) return;
    /* 源有时效：只有「刚点完卡片就打开详情」才飞。程序化调用（播放器切下一集、
       上/下一部按钮、URL 直达）不产生 click 或产生的是弹窗内点击，源会是陈旧的，
       拿着旧几何飞比不飞更糟。 */
    var stale = !state.at || ((global.performance || Date).now() - state.at) > 1500;
    if (!state.first || !state.src || stale || motionOff() || reduced()) {
      /* 这次打开不是来自卡片点击（程序化/上下一部/源已过期）⇒ 清掉源，
         关闭时也别飞回那张旧卡片 */
      state.img = null;
      state.host = null;
      target.style.opacity = '';
      target.style.transition = '';
      return;
    }

    /* 卡片图已经加载完（用户能点到它），它的 natural 尺寸就是海报的真实比例，
       拿来给 measure() 兜底，避免详情图未 decode 时量到错误尺寸。 */
    var natFallback = null;
    try {
      if (state.img && state.img.naturalWidth > 0 && state.img.naturalHeight > 0) {
        natFallback = [state.img.naturalWidth, state.img.naturalHeight];
      }
    } catch (e) { natFallback = null; }

    var dest = measure(target, natFallback);
    if (!dest) { state.first = null; return; }

    /* 源卡片完全在视口外（用户点不到，只可能是程序化/键盘触发）⇒ 别从屏幕外飞进来，直接显形 */
    var f0 = state.first;
    if (f0.left + f0.width < 0 || f0.top + f0.height < 0 ||
        f0.left > global.innerWidth || f0.top > global.innerHeight) {
      state.first = null;
      target.style.transition = '';
      target.style.opacity = '';
      return;
    }

    killProxy();
    if (state.timer) { clearTimeout(state.timer); state.timer = 0; }

    /* 真海报隐身，避免和代理重影 */
    target.style.transition = 'none';
    target.style.opacity = '0';

    var proxy = makeProxy(state.first, state.radius, state.src);
    document.body.appendChild(proxy);
    state.proxy = proxy;
    state.busy = true;

    var dur = Math.round(DUR_IN());
    var ease = EASE_IN();

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!state.proxy) return;
        proxy.style.transition = [
          'left ' + dur + 'ms ' + ease,
          'top ' + dur + 'ms ' + ease,
          'width ' + dur + 'ms ' + ease,
          'height ' + dur + 'ms ' + ease,
          'border-radius ' + dur + 'ms ' + ease,
          'box-shadow ' + dur + 'ms ' + ease
        ].join(', ');
        proxy.style.left = dest.left.toFixed(2) + 'px';
        proxy.style.top = dest.top.toFixed(2) + 'px';
        proxy.style.width = dest.width.toFixed(2) + 'px';
        proxy.style.height = dest.height.toFixed(2) + 'px';
        proxy.style.borderRadius = dest.radius;
        proxy.style.boxShadow = '0 16px 36px -16px rgba(0,0,0,.5)';

        /* ★round127 · bug5 修复：这里原本有一段「落地前 45ms 再量一次真实 rect，
           偏差 >0.6px 就补一段 45ms 过渡」的吸附校正。它正是用户看到的
           「已经飞到位了，最后又位移一小段」的直接来源：
           ① 量到的 rect 受 .modal-content 进场位移/scale 与 .detail-poster 视差
              transform 影响，与 dest 必然有差，于是吸附几乎每次都会触发；
           ② 主飞行（460ms）尚未结束就再起一段过渡，两段缓动在末尾叠加成一次
              「抖动式二次位移」。
           现在 measure() 改用 offsetLeft/offsetTop/offsetWidth/offsetHeight 的
           布局稳态几何（完全不受 transform 影响），dest 从第一帧起就是终态，
           所以这段吸附彻底删掉，让主飞行一次到位。 */
      });
    });

    state.timer = setTimeout(function () {
      /* 交接：代理撤掉，真海报无缝显形 */
      killProxy();
      state.busy = false;
      state.first = null;
      /* 飞行期间详情已被换掉（连点/上下一部）⇒ 目标已脱离 DOM，别去碰它 */
      if (!target.isConnected) return;
      target.style.transition = 'opacity 120ms linear';
      target.style.opacity = '1';
      setTimeout(function () { target.style.transition = 'none'; }, 140);
    }, dur + 10);
  }

  /* ── 4. 退场：详情海报 → 卡片原位 ───────────────────── */
  function exit(target, done) {
    var called = false;
    var dm = document.getElementById('detailModal');
    function finish() {
      if (called) return;
      called = true;
      killProxy();
      if (dm) dm.classList.remove('flip-leaving');
      state.busy = false;
      state.first = null;
      state.host = null;
      state.img = null;
      if (typeof done === 'function') done();
    }

    if (!target || !state.img || !state.img.isConnected || motionOff() || reduced()) {
      finish();
      return;
    }

    var back = state.img.getBoundingClientRect();
    var from = target.getBoundingClientRect();
    if (back.width < 8 || back.height < 8 || from.width <= 2 || from.height <= 2) {
      finish();
      return;
    }
    /* 卡片已滚出视口：别飞，直接收 */
    if (back.bottom < -40 || back.top > global.innerHeight + 40 ||
        back.right < -40 || back.left > global.innerWidth + 40) {
      finish();
      return;
    }

    var dur = Math.round(DUR_OUT());
    var ease = EASE_OUT();

    killProxy();
    target.style.transition = 'none';
    target.style.opacity = '0';
    /* 抽屉同时淡出（detail-mode.css 里 .modal-content 已有 opacity 过渡），
       否则会是「封面飞走了、抽屉还开着一条」的割裂感 */
    if (dm) dm.classList.add('flip-leaving');

    var proxy = makeProxy(from, global.getComputedStyle(target).borderTopLeftRadius || '12px', state.src || target.src);
    document.body.appendChild(proxy);
    state.proxy = proxy;
    state.busy = true;

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (!state.proxy) return;
        proxy.style.transition = [
          'left ' + dur + 'ms ' + ease, 'top ' + dur + 'ms ' + ease,
          'width ' + dur + 'ms ' + ease, 'height ' + dur + 'ms ' + ease,
          'border-radius ' + dur + 'ms ' + ease,
          'box-shadow ' + dur + 'ms ease',
          'opacity ' + dur + 'ms linear'
        ].join(', ');
        proxy.style.left = back.left.toFixed(2) + 'px';
        proxy.style.top = back.top.toFixed(2) + 'px';
        proxy.style.width = back.width.toFixed(2) + 'px';
        proxy.style.height = back.height.toFixed(2) + 'px';
        proxy.style.borderRadius = state.radius;
        proxy.style.boxShadow = '0 10px 28px -10px rgba(0,0,0,.45)';
        proxy.style.opacity = '1';
      });
    });

    state.timer = setTimeout(finish, dur + 30);
    /* 硬超时：绝不让代理卡住弹窗关闭 */
    setTimeout(finish, dur + 260);
  }

  /* ── 5. 捕获阶段记录源（先于卡片上的 onclick / 冒泡监听） ── */
  global.addEventListener('click', function (e) {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey) return;   /* 多选不该触发转场 */
    /* ★记录失败必须清空源。否则「详情里点上/下一部」这类程序化调用会拿
       上一次的卡片几何去飞，封面从上一部的位置窜过来 —— 比不飞更糟。 */
    if (!record(e.target)) clearSource();
  }, true);

  global.MotionFLIP = {
    record: record,
    enter: enter,
    exit: exit,
    /* round127 · bug3：换完海报要把详情弹窗「重开」一次，但那是同一个作品的续场，
       不该再从原卡片飞一遍（用户会看到封面又飞一次）。把源判成过期即可 ——
       只打掉时效，保留 img/first，退出转场仍然正常。 */
    invalidate: function () { clearSource(); },
    isAnimating: function () { return state.busy; }
  };
})(window);
