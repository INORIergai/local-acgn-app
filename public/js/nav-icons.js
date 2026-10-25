/* ============================================================
   午夜场 · nav-icons.js —— 导航图标接线层（Remotion 实心光体）
   ------------------------------------------------------------
   职责：
   1) 把侧栏 .nav-item 的 emoji 替换为 Remotion 渲染的动效图标
      （透明 webm 承担登场/悬停演出，png 静帧为默认态）
   2) 载入时编队依次播放登场（45ms 错峰）
   3) 悬停重播该图标的演出；选中态呼吸由 CSS 承担
   4) 兜底链：webm 失败 → png；png 也失败 → 还原 emoji（永不白块）
   铁律：不改 .nav-item 布局与交互逻辑，只插入 .nv-ic 容器；
        MutationObserver 只装饰「他人新增」的 nav-item（自身改动带
        data-nvic 标记，不会自触发）。
   ============================================================ */
(function () {
  'use strict';

  var MAP = {
    'home': 'home',
    'guess': 'spark', 'guess-adult': 'spark',
    'hot': 'flame',
    'random': 'shuffle',
    'unwatched': 'eye', 'unwatched-adult': 'eye',
    'movies': 'reel', 'movies-adult': 'reel',
    'jav': 'frame', 'watch-hanime': 'frame',
    'anime': 'anime', 'watch-anime': 'anime',
    'film': 'film',
    'cartoon': 'cartoon',
    'comic': 'comic', 'watch-comic': 'comic',
    'novel': 'book', 'watch-novel': 'book',
    'favorites': 'bookmark', 'favhub': 'bookmark',
    'recent': 'clock', 'recent-adult': 'clock',
    'actresses': 'actress',
    'tags': 'tag',
    'new-releases': 'bell',
    'annual': 'chart', 'acg-rank': 'chart',
    'settings': 'settings', 'ms': 'settings',
    'watch': 'watch', 'watch-hub': 'watch',
    'hot-adult': 'flame', 'random-adult': 'shuffle',      /* 隐私口径：同图标 */
    'scrape-failures': 'alert', 'poster-health': 'image'  /* round48 补齐 */
  };
  /* 无 data-view 的导航项按文本匹配（AI助手 = 弹窗触发器，不能加 data-view） */
  var TEXT_MAP = [{ re: /AI助手/, id: 'spark' }];
  var DIR = window.NAV_ICONS_DIR || 'img/nav-icons/';
  /* 行首 emoji（含 ZWJ / 变体选择符）+ 其后空白 */
  var EMOJI_RE = /^(?:[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{2BFF}]|[\u{1F1E6}-\u{1F1FF}]|[\u{FE0F}\u{200D}\u{20E3}])+(?:\s+)/u;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var queue = [];

  function decorate(item, playNow) {
    if (item.dataset.nvic) return;
    var view = item.getAttribute('data-view');
    var id = view && MAP[view];
    if (!id) {
      var itemText = (item.textContent || '').trim();
      for (var k = 0; k < TEXT_MAP.length; k++) {
        if (TEXT_MAP[k].re.test(itemText)) { id = TEXT_MAP[k].id; break; }
      }
    }
    if (!id) { item.dataset.nvic = 'keep-emoji'; return; }
    var label = item.querySelector('span');
    if (!label) { item.dataset.nvic = 'keep-emoji'; return; }
    var m = label.textContent.match(EMOJI_RE);
    if (!m) { item.dataset.nvic = 'keep-emoji'; return; }

    item.dataset.nvic = id;
    item.dataset.emoji = m[0].trim();
    label.textContent = label.textContent.replace(EMOJI_RE, '');

    var wrap = document.createElement('span');
    wrap.className = 'nv-ic';
    var img = document.createElement('img');
    img.src = DIR + id + '.png';
    img.alt = '';
    img.draggable = false;
    var v = document.createElement('video');
    v.muted = true;
    v.loop = false;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.setAttribute('disablepictureinpicture', '');

    v.addEventListener('play', function () { img.hidden = true; });
    v.addEventListener('ended', function () { img.hidden = true; });
    v.addEventListener('error', function () {
      v.hidden = true;
      img.hidden = false;
      if (!img.complete || !img.naturalWidth) failToEmoji(item, wrap);
    });
    img.addEventListener('error', function () { failToEmoji(item, wrap); });

    v.src = DIR + id + '.webm';
    wrap.appendChild(v);
    wrap.appendChild(img);
    /* 注入点：label span 内部 —— label 保持 :first-child/flex:1，
       计数徽标右对齐等既有布局零变动（round42 rail 折叠模式同样兼容） */
    label.insertBefore(wrap, label.firstChild);

    /* skiper43 Vercel Tooltip：rail 折叠态的悬浮提示（全宽态不显示，防重复噪音） */
    var tip = document.createElement('span');
    tip.className = 'nvx-tip';
    tip.textContent = label.textContent.replace(/\d+[\d,]*\s*$/, '').trim() || view || '';
    item.appendChild(tip);

    if (!reduced) queue.push(v);
    if (playNow && !reduced) {
      var p0 = v.play();
      if (p0 && p0.catch) p0.catch(function () {});
    }
  }

  function failToEmoji(item, wrap) {
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    if (item.dataset.emoji) {
      var label = item.querySelector('span');
      if (label && !label.textContent.match(EMOJI_RE)) {
        label.textContent = item.dataset.emoji + ' ' + label.textContent;
      }
    }
    item.dataset.nvic = 'keep-emoji';
  }

  /* 载入编队：等首启导览层（#tourOverlay）退场后再演（最多等 6s），
     行级「图标+字」整体浮起 与 图标登场 同拍播放 */
  var queueDone = false;
  function entranceQueue() {
    if (reduced || queueDone) return;
    queueDone = true;
    var overlay = document.getElementById('tourOverlay');
    var fire = function () {
      queue.forEach(function (v, i) {
        setTimeout(function () {
          try {
            v.currentTime = 0;
            var p = v.play();
            if (p && p.catch) p.catch(function () {});
          } catch (e) { /* noop */ }
        }, 150 + i * 60);
      });
      var rows = document.querySelectorAll('.nav-item[data-nvic]');
      Array.prototype.forEach.call(rows, function (item, i) {
        if (item.dataset.nvic === 'keep-emoji') return;
        item.style.setProperty('--nvd', (i * 60) + 'ms');
        item.classList.add('nv-in');
      });
    };
    var check = function () {
      var up = overlay && overlay.isConnected &&
               overlay.style.display !== 'none' && overlay.offsetParent !== null;
      if (!up) { fire(); return; }
      var fired = false;
      var mo = new MutationObserver(function () {
        if (!overlay.isConnected || overlay.style.display === 'none') {
          mo.disconnect();
          if (!fired) { fired = true; fire(); }
        }
      });
      mo.observe(overlay, { attributes: true, attributeFilter: ['style'] });
      setTimeout(function () {
        if (!fired) { fired = true; mo.disconnect(); fire(); }
      }, 6000);
    };
    setTimeout(check, 1000); /* 导览层在载入 900ms 后才出现，1s 时点检查 */
  }

  function init() {
    var items = document.querySelectorAll('.nav-item');
    Array.prototype.forEach.call(items, decorate);
    /* 侧栏被动态重建时装饰新增项（自身改动带 data-nvic，不会自触发） */
    var sidebar = document.querySelector('.sidebar') || document.body;
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        muts.forEach(function (mu) {
          Array.prototype.forEach.call(mu.addedNodes, function (n) {
            if (!(n instanceof HTMLElement)) return;
            if (n.matches && n.matches('.nav-item')) decorate(n, true);
            if (n.querySelectorAll) {
              Array.prototype.forEach.call(n.querySelectorAll('.nav-item'), function (x) { decorate(x, true); });
            }
          });
        });
      }).observe(sidebar, { childList: true, subtree: true });
    }
    entranceQueue();
    /* 悬停重播演出（事件委托，含动态新增项） */
    document.addEventListener('mouseover', function (e) {
      var item = e.target && e.target.closest ? e.target.closest('.nav-item[data-nvic]') : null;
      if (!item || item.dataset.nvic === 'keep-emoji' || reduced) return;
      var v = item.querySelector('.nv-ic video');
      if (!v || v.hidden) return;
      try {
        v.currentTime = 0;
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } catch (err) { /* noop */ }
    });
    /* 点击（换页）重播：切换视图的那一刻也有演出，动感与操作绑定 */
    document.addEventListener('click', function (e) {
      var item = e.target && e.target.closest ? e.target.closest('.nav-item[data-nvic]') : null;
      if (!item || item.dataset.nvic === 'keep-emoji' || reduced) return;
      var v = item.querySelector('.nv-ic video');
      if (!v || v.hidden) return;
      try {
        v.currentTime = 0;
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } catch (err) { /* noop */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
