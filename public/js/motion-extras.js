/* ============================================================
   午夜场 · motion-extras.js —— 交互瞬间素材包接线
   ------------------------------------------------------------
   ① 猜你喜欢抽牌光扫：观察 #magicDeck，中央卡换位时盖上
      card-sweep.webm（零改动 magic-likes.js）
   ② 空态家族：观察主区，.empty-state/.magic-empty 的 emoji
      按 语境 → 变体（box/spark/check/eye）替换为循环动画；
      视频失败自动还原 emoji（永不白块）
   ③ 待机银幕：闲置 180s 且无影片播放/无换页加载 → 全屏
      「午夜场」氛围循环，任意输入即退（window.MidnightIdle 可手动触发）
   ④ 年度档案：年度报告视图注入「▶ 放映年度档案」按钮，
      全屏播放 img/extras/annual-<年>.webm
   全部遵守：只追加、零改动既有逻辑、reduced-motion 全面禁用。
   ============================================================ */
(function () {
  'use strict';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var DIR = 'img/extras/';
  var FALLBACK_REEL = 'img/nav-icons/reel.png';

  /* ============ ① 抽牌光扫 ============ */
  var deckMo = null, lastCenter = null, sweepBusy = false;
  function sweepRect(rect) {
    if (sweepBusy || !rect || REDUCED) return;
    sweepBusy = true;
    var v = document.createElement('video');
    v.muted = true;
    v.setAttribute('playsinline', '');
    v.className = 'nv-sweep';
    v.style.left = rect.left + 'px';
    v.style.top = rect.top + 'px';
    v.style.width = rect.width + 'px';
    v.style.height = rect.height + 'px';
    var done = function () { if (v.parentNode) v.parentNode.removeChild(v); sweepBusy = false; };
    v.addEventListener('ended', done);
    v.addEventListener('error', done);
    v.src = DIR + 'card-sweep.webm';
    document.body.appendChild(v);
    var p = v.play();
    if (p && p.catch) p.catch(done);
  }
  function playSweep(center) {
    sweepRect(center.getBoundingClientRect());
  }
  /* Aardvark 散落展台（默认猜你喜欢）：包装 openGuess，新牌阵落定时全场扫光 */
  function hookAvBoard() {
    if (!window.AvBoard || window.AvBoard.__nvx) return !!window.AvBoard;
    window.AvBoard.__nvx = true;
    var orig = window.AvBoard.openGuess;
    window.AvBoard.openGuess = function () {
      var out = orig.apply(this, arguments);
      try {
        var grid = document.getElementById('movieGrid');
        if (!grid) return out;
        var mo = new MutationObserver(function () {
          if (grid.querySelector('.av-card')) {
            mo.disconnect();
            sweepRect(grid.getBoundingClientRect());
          }
        });
        mo.observe(grid, { childList: true, subtree: true });
        setTimeout(function () { mo.disconnect(); }, 4000);
      } catch (e) { /* noop */ }
      return out;
    };
    return true;
  }
  function hookDeck() {
    var deck = document.getElementById('magicDeck');
    if (!deck) return false;
    if (deckMo) return true;
    deckMo = new MutationObserver(function () {
      if (REDUCED) return;
      var center = deck.querySelector('.magic-card.is-center');
      if (!center || center === lastCenter) return;
      lastCenter = center;
      playSweep(center);
    });
    deckMo.observe(deck, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return true;
  }

  /* ============ ② 空态家族 ============ */
  function variantFor(el) {
    var txt = el.textContent || '';
    if (/✅/.test(txt)) return 'check';
    if (/没有找到|无结果|未找到/.test(txt)) return 'eye';
    if (/📭|暂无/.test(txt)) return 'box';
    return 'spark';
  }
  function decorateEmpty(el) {
    if (el.dataset.nvx) return;
    var variant = variantFor(el);
    var holder = el.querySelector('.icon');
    if (!holder) {
      var divs = el.querySelectorAll('div');
      for (var i = 0; i < divs.length; i++) {
        var t = (divs[i].textContent || '').trim();
        if (t && t.length <= 4 && /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}]/u.test(t)) {
          holder = divs[i];
          break;
        }
      }
    }
    if (!holder) { el.dataset.nvx = 'keep'; return; }
    var emoji = (holder.textContent || '').trim();
    el.dataset.nvx = variant;
    holder.textContent = '';
    var wrapEl = document.createElement('span');
    wrapEl.className = 'nv-empty';
    var v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.addEventListener('error', function () {
      wrapEl.remove();
      holder.textContent = emoji;      /* 还原 emoji */
    });
    v.src = DIR + 'empty-' + variant + '.webm';
    var p = v.play();
    if (p && p.catch) p.catch(function () {});
    wrapEl.appendChild(v);
    holder.appendChild(wrapEl);
  }

  /* ============ ③ 待机银幕（并入 round38 动画自定义体系） ============ */
  var idleSecs = 180, idleT = null, idleShown = false, idleEl = null, idleVideo = null;
  var idleCfg = { url: DIR + 'idle-screen.webm', off: false, fetched: false };
  function refreshIdleCfg(cb) {
    fetch('/api/customization/animation').then(function (r) { return r.json(); }).then(function (j) {
      var d = (j && j.data) || {};
      idleCfg.off = !!d.idleScreenOff;
      if (d.idleScreen && d.idleScreen.custom && d.idleScreen.url) idleCfg.url = d.idleScreen.url;
      else idleCfg.url = DIR + 'idle-screen.webm';
      if (cb) cb();
    }).catch(function () { if (cb) cb(); });
  }
  function busyNow() {
    var vids = document.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      if (!v.paused && !v.ended && v.duration > 60) return true;   /* 正在看片 */
    }
    var nvl = document.querySelector('.nvl-root');
    if (nvl && !nvl.hidden) return true;                            /* 换页加载中 */
    return document.hidden;
  }
  function armIdle() {
    if (idleT) clearTimeout(idleT);
    idleT = setTimeout(function () {
      if (busyNow()) { armIdle(); return; }
      showIdle();
    }, idleSecs * 1000);
  }
  function ensureIdle() {
    if (idleEl) return;
    idleEl = document.createElement('div');
    idleEl.className = 'nv-idle';
    idleEl.innerHTML = '<video muted loop playsinline disablepictureinpicture preload="auto"></video>' +
      '<div class="nv-idle-hint">动一动鼠标，回到片库</div>';
    idleVideo = idleEl.querySelector('video');
    idleVideo.src = DIR + 'idle-screen.webm';
    document.body.appendChild(idleEl);
  }
  function showIdle() {
    if (idleShown || REDUCED) return;
    ensureIdle();
    /* 每次触发前拉取最新配置：开关 / 自定义素材（round38 体系） */
    refreshIdleCfg(function () {
      if (idleCfg.off || busyNow()) { armIdle(); return; }
      idleShown = true;
      idleEl.hidden = false;
      if (idleVideo.src.indexOf(encodeURI(idleCfg.url)) === -1) idleVideo.src = idleCfg.url;
      requestAnimationFrame(function () { idleEl.classList.add('on'); });
      try { idleVideo.currentTime = 0; idleVideo.play(); } catch (e) { /* noop */ }
    });
  }
  function hideIdle() {
    if (!idleShown) return;
    idleShown = false;
    idleEl.classList.remove('on');
    setTimeout(function () {
      if (!idleShown) { idleEl.hidden = true; try { idleVideo.pause(); } catch (e) {} }
    }, 650);
    armIdle();
  }
  window.MidnightIdle = { show: showIdle, hide: hideIdle };   /* 可手动触发/测试 */

  /* ============ ⑤ 年度页面增强：数字滚动 / 排名赛跑 / 图表延伸 ============ */
  /* 锚点 = .annual-hero（年报页独有），避免误锚顶栏标题 */
  function enhanceAnnual(main) {
    var hero = main.querySelector('.annual-hero');
    if (!hero) return;
    var view = hero.closest('.panel-section') || hero.parentElement;
    view.classList.add('nvx-annual');

    /* 数字滚动（复合后缀如 1h5m 不参与，直接跳过） */
    Array.prototype.forEach.call(view.querySelectorAll('.annual-card .num'), function (numEl, i) {
      if (numEl.dataset.nvxC) return;
      var txt = numEl.textContent.trim();
      var mNum = txt.match(/^([\d,]+(?:\.\d+)?)(.*)$/);
      if (!mNum || /[^hm%]/.test(mNum[2] || '')) { numEl.dataset.nvxC = 'keep'; return; }
      numEl.dataset.nvxC = '1';
      var target = parseFloat(mNum[1].replace(/,/g, '')) || 0;
      var suffix = mNum[2] || '';
      var dec = (mNum[1].indexOf('.') >= 0) ? 1 : 0;
      var t0 = null, dur = 950 + i * 90;
      function step(ts) {
        if (t0 === null) t0 = ts;
        var p = Math.min(1, (ts - t0) / dur);
        var e = 1 - Math.pow(1 - p, 3);
        var val = target * e;
        numEl.textContent = (dec ? (Math.round(val * 10) / 10) : Math.round(val).toLocaleString()) + suffix;
        if (p < 1) requestAnimationFrame(step);
        else numEl.textContent = txt;
      }
      requestAnimationFrame(step);
    });

    /* 排名赛跑：按各自容器分组 —— 第 1 名从最底下冲顶（延迟最晚、行程最长、弹簧过冲+落位爆闪） */
    var byParent = new Map();
    Array.prototype.forEach.call(view.querySelectorAll('.annual-rank, .an-rank'), function (row) {
      if (row.dataset.nvxR) return;
      row.dataset.nvxR = '1';
      var p = row.parentElement;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(row);
    });
    byParent.forEach(function (rows2) {
      var N = rows2.length;
      rows2.forEach(function (row, i) {
        row.style.setProperty('--tyf', ((N - i) * 58) + 'px');
        if (i === 0) {
          row.classList.add('nvx-r1');
          row.style.setProperty('--nvd', (250 + (N - 1) * 95) + 'ms');
        } else {
          row.style.setProperty('--nvd', ((N - 1 - i) * 85) + 'ms');
        }
        row.classList.add('nvx-ri');
      });
    });

    /* 面积图：从一点延伸 + 伪 3D 深度投影 + 渐变描边色相流动 */
    var svg = view.querySelector('.an-area');
    if (svg && !svg.dataset.nvxC) {
      svg.dataset.nvxC = '1';
      svg.classList.add('nvx-chart');
      var line = svg.querySelector('.an-area-line');
      if (line) {
        var depth = line.cloneNode();          /* 伪 3D 厚度：暗色投影线垫底 */
        depth.classList.add('an-depth');
        line.parentNode.insertBefore(depth, line);
      }
      var defs = svg.querySelector('defs');
      if (defs && line && !svg.querySelector('#nvxLineGrad')) {
        var g = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        g.setAttribute('id', 'nvxLineGrad');
        g.setAttribute('x1', '0'); g.setAttribute('y1', '0'); g.setAttribute('x2', '1'); g.setAttribute('y2', '0');
        g.innerHTML =
          '<stop offset="0" stop-color="#22D3EE"><animate attributeName="stop-color" values="#22D3EE;#818CF8;#C084FC;#22D3EE" dur="6s" repeatCount="indefinite"/></stop>' +
          '<stop offset="1" stop-color="#C084FC"><animate attributeName="stop-color" values="#C084FC;#22D3EE;#818CF8;#C084FC" dur="6s" repeatCount="indefinite"/></stop>';
        defs.appendChild(g);
        line.setAttribute('stroke', 'url(#nvxLineGrad)');
        line.style.filter = 'drop-shadow(0 0 6px rgba(129,140,248,0.55))';
      }
      Array.prototype.forEach.call(svg.querySelectorAll('.an-dot'), function (d, i) {
        d.style.setProperty('--i', i);
      });
      Array.prototype.forEach.call(svg.querySelectorAll('.an-m'), function (t, i) {
        t.style.setProperty('--i', i);
      });
    }
  }

  /* ============ ⑥ 海报标题字：功能页大标题 + 艺术字风格轮换 ============ */
  var PG_STYLE = {
    movies: 'gold', jav: 'gold', home: 'gold', hot: 'gold', book: 'gold',
    bell: 'gold', annual: 'gold', novel: 'gold',
    'hot-adult': 'gold', 'random-adult': 'neon',
    guess: 'neon', anime: 'neon', random: 'neon', watch: 'neon',
    'watch-anime': 'neon', 'watch-hub': 'neon', 'watch-novel': 'neon',
    film: 'duo', clock: 'duo', settings: 'duo', ms: 'duo',
    favorites: 'stamp', favhub: 'stamp', tags: 'stamp', 'new-releases': 'stamp',
    'scrape-failures': 'duo', 'poster-health': 'stamp',
    'acg-rank': 'duo', actresses: 'stamp', cartoon: 'neon', comic: 'stamp',
  };
  var PG_ACCENT = {
    movies: '#FCD34D', jav: '#F9A8D4', home: '#22D3EE', hot: '#FB923C',
    book: '#C08552', bell: '#FFE08A', annual: '#FBBF24', novel: '#C08552',
    'hot-adult': '#F9A8D4', 'random-adult': '#F9A8D4',
    guess: '#67E8F9', anime: '#7DD3FC', random: '#818CF8', watch: '#67E8F8',
    'watch-anime': '#7DD3FC', 'watch-hub': '#67E8F8', 'watch-novel': '#C08552',
    film: '#C9C9D6', clock: '#C7D2FE', settings: '#D7DEE9', ms: '#D7DEE9',
    favorites: '#F87171', favhub: '#F87171', tags: '#DDBB8A',
    'new-releases': '#FFE08A', 'scrape-failures': '#F87171',
    'poster-health': '#4ADE80', 'acg-rank': '#4ADE80', actresses: '#A78BFA',
    cartoon: '#5EEAD4', comic: '#FACC15',
  };
  var PG_ICON = {
    movies: 'reel', jav: 'frame', home: 'home', hot: 'flame', book: 'book',
    bell: 'bell', annual: 'chart', novel: 'book', guess: 'spark',
    anime: 'anime', random: 'shuffle', watch: 'watch', 'watch-anime': 'anime',
    'watch-hub': 'watch', 'watch-novel': 'book', film: 'film', clock: 'clock',
    settings: 'settings', ms: 'settings', favorites: 'bookmark',
    favhub: 'bookmark', tags: 'tag', 'new-releases': 'bell',
    'acg-rank': 'chart', actresses: 'actress', cartoon: 'cartoon', comic: 'comic',
    'hot-adult': 'flame', 'random-adult': 'shuffle',
    'scrape-failures': 'alert', 'poster-health': 'image',
  };
  function heroText() {
    var tb = document.getElementById('toolbarTitle');
    if (!tb) return '';
    var t = tb.textContent.trim().replace(/共[\d,，\s]*部.*$/, '').trim();
    return t.replace(/^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s*/u, '');
  }
  var FLAGS = window.NVX_FLAGS || {};   /* 测试开关：NVX_FLAGS={hero:false,titlefx:false} 可单独禁用 */
  function renderHero() {
    /* round47 用户裁决：海报大标题（渐变大字/图标/下划线）整体下架——「难看设计全部去掉」。
       默认不渲染；除非 NVX_FLAGS.hero===true 才复活。进页顺带清残留。 */
    if (FLAGS.hero !== true) {
      var stale = document.querySelector('main.content .pg-hero');
      if (stale) stale.remove();
      return;
    }
    var main = document.querySelector('main.content');
    if (!main) return;
    var view = document.body.dataset.view || '';
    var text = heroText();
    if (!text) return;
    var sig = view + '|' + text;
    var hero = main.querySelector('.pg-hero');
    if (hero && hero.dataset.sig === sig) return;
    if (!hero) {
      hero = document.createElement('div');
      hero.className = 'pg-hero';
      main.insertBefore(hero, main.firstChild);
    }
    hero.dataset.sig = sig;
    var style = PG_STYLE[view] || 'gold';
    var accent = PG_ACCENT[view] || '#818CF8';
    var icon = PG_ICON[view];
    hero.className = 'pg-hero pg-style-' + style;
    hero.style.setProperty('--pgc', accent);
    hero.style.setProperty('--pgc-g', accent + '88');
    var chars = Array.from(text).map(function (ch, i) {
      var rot = (i % 2 ? 1 : -1) * (5 + (i % 3) * 2);
      return '<span class="pg-ch" style="--i:' + i + ';--rot:' + rot + 'deg">' +
        (ch === ' ' ? '&nbsp;' : ch) + '</span>';
    }).join('');
    hero.innerHTML =
      (icon ? '<img class="pg-motif" src="img/nav-icons/' + icon + '.png" alt="">' : '') +
      '<span class="pg-title"><span class="pg-stamp"></span>' + chars + '</span>' +
      '<span class="pg-underline"></span>';
  }

  /* ============ ⑥b 工具栏小标题级联 ============
     ⚠️ 铁律（本轮踩坑）：只字符化「第一个文本节点」，count span 等
     其它子节点原地不动 —— 重写后整段 textContent 必须严格不变，
     否则 sig 守卫永不收敛 → 「共 N 部」指数自我复制 → 渲染进程崩溃
     （motion.js 里同款正反馈事故的变体，代价：headless 实测崩三次）。 */
  function titleFx() {
    if (FLAGS.titlefx === false) return;
    var tb = document.getElementById('toolbarTitle');
    if (!tb) return;
    var sig = tb.textContent;
    if (tb.dataset.nvxT === sig) return;
    tb.dataset.nvxT = sig;
    var firstText = null;
    for (var n = tb.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.textContent.trim()) { firstText = n; break; }
    }
    if (!firstText) return;
    var full = firstText.textContent.trim();
    var m = full.match(/^([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?)\s*(.*)$/u);
    var emoji = m ? m[1] : '';
    var rest = m ? m[2] : full;
    var frag = document.createDocumentFragment();
    if (emoji) {
      var eSpan = document.createElement('span');
      eSpan.className = 'tb-emoji';
      eSpan.textContent = emoji;
      frag.appendChild(eSpan);
    }
    Array.from(rest).forEach(function (ch, i) {
      var s = document.createElement('i');
      s.style.setProperty('--i', i);
      s.textContent = ch === ' ' ? '\u00A0' : ch;
      frag.appendChild(s);
    });
    tb.replaceChild(frag, firstText);   /* 只换文本节点；count span 原地保留 */
  }

  /* ============ ④ 年度档案 ============ */
  function openAnnual() {
    fetch('/api/stats/annual').then(function (r) { return r.json(); }).then(function (j) {
      var year = (j.data && j.data.year) || new Date().getFullYear();
      var ov = document.createElement('div');
      ov.className = 'nv-annual-player';
      ov.innerHTML = '<video src="' + DIR + 'annual-' + year + '.webm" controls autoplay></video>' +
        '<button class="nv-annual-close">✕ 关闭 (Esc)</button>';
      var close = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      ov.querySelector('.nv-annual-close').addEventListener('click', close);
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });
      ov.querySelector('video').addEventListener('error', function () {
        close();
        if (typeof window.showNotification === 'function') {
          window.showNotification('尚未生成', year + ' 年度档案影片还未渲染，等下一轮再来看看');
        }
      });
      document.body.appendChild(ov);
    }).catch(function () {});
  }
  function hookAnnual(main) {
    var hero = main.querySelector('.annual-hero');
    if (!hero) return;
    var panel = hero.closest('.panel-section');
    if (!panel || panel.querySelector('.nv-annual-btn')) return;
    var head = panel.querySelector('.panel-head');
    if (!head) return;
    var btn = document.createElement('button');
    btn.className = 'nv-annual-btn';
    btn.type = 'button';
    btn.textContent = '▶ 放映年度档案';
    btn.addEventListener('click', openAnnual);
    head.appendChild(btn);
  }

  /* ============ 总观察器 ============ */
  function init() {
    if (REDUCED) return;
    var mainEl = document.querySelector('main.content') || document.querySelector('.content');
    if (!mainEl) { setTimeout(init, 300); return; }
    var mainMo = new MutationObserver(function () {
      hookDeck();
      hookAvBoard();
      Array.prototype.forEach.call(mainEl.querySelectorAll('.empty-state, .magic-empty, .av-empty'), decorateEmpty);
      hookAnnual(mainEl);
      enhanceAnnual(mainEl);
    });
    mainMo.observe(mainEl, { childList: true, subtree: true });
    hookDeck();
    hookAvBoard();
    Array.prototype.forEach.call(mainEl.querySelectorAll('.empty-state, .magic-empty, .av-empty'), decorateEmpty);
    enhanceAnnual(mainEl);

    /* 艺术标题字：工具栏级联 + 功能页海报大标题 */
    var tb = document.getElementById('toolbarTitle');
    if (tb) {
      titleFx();
      renderHero();
      new MutationObserver(function () { titleFx(); renderHero(); })
        .observe(tb, { childList: true, subtree: true, characterData: true });
    }

    armIdle();
    armSkiperFx();
    armLongTasks();
    armP1Fx();
    ['mousemove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        if (idleShown) hideIdle();
        else armIdle();
      }, { passive: true });
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) armIdle();
    });
  }

  /* ============ Skiper UI 特效 v1（用户指定批次：37/43/4/3/29 等） ============
     数字滚动=.count 变化双层滑入；海报视差=skiper29 Siena 倾斜；
     主题球=skiper4 点击 spin。全部事件委托/观察器，自标注防回环。 */
  function armSkiperFx() {
    if (armSkiperFx.done) return;
    armSkiperFx.done = true;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    /* skiper37 Number flow：侧栏分类计数徽章变化 → 旧值上滑出 / 新值下滑入
       注意（r62 排坑）：.stat-card .num 数据统计卡片专属于 motion.js countUp 缓动计数，
       绝不可在此处接入 rollCount，否则 560ms 定时器回填中间过渡值会导致数字不断变小死循环。 */
    var sidebar = document.querySelector('.sidebar');
    if (sidebar && window.MutationObserver) {
      new MutationObserver(function (muts) {
        if (document.body.classList.contains('fx-countroll-off')) return;
        muts.forEach(function (mu) {
          var node = mu.type === 'characterData' ? mu.target.parentElement : mu.target;
          var el = node && node.closest ? node.closest('.count') : null;
          if (!el || el.dataset.nvxRolling) return;
          rollCount(el);
        });
      }).observe(sidebar, { childList: true, subtree: true, characterData: true });
    }
    Array.prototype.forEach.call(document.querySelectorAll('.sidebar .count'), function (el) {
      el.dataset.nvxPrev = el.textContent.trim();
    });

    function rollCount(el) {
      var to = el.textContent.trim();
      var from = el.dataset.nvxPrev != null ? el.dataset.nvxPrev : to;
      el.dataset.nvxPrev = to;
      if (!to || from === to) return;
      el.dataset.nvxRolling = '1';
      var w = document.createElement('span');
      w.className = 'nvx-roll';
      var o = document.createElement('span'); o.className = 'nvx-o'; o.textContent = from;
      var n = document.createElement('span'); n.className = 'nvx-n'; n.textContent = to;
      w.appendChild(o); w.appendChild(n);
      el.textContent = '';
      el.appendChild(w);
      setTimeout(function () {
        el.textContent = to;
        delete el.dataset.nvxRolling;
      }, 560);
    }

    /* skiper29 Siena 视差：详情海报跟随鼠标 3D 倾斜（动效库可关：fx-parallax-off） */
    var tilted = null;
    document.addEventListener('mousemove', function (e) {
      if (document.body.classList.contains('fx-parallax-off')) return;
      var wrap = e.target && e.target.closest ? e.target.closest('.detail-poster-wrap') : null;
      var poster = wrap ? wrap.querySelector('.detail-poster') : null;
      if (tilted && tilted !== poster) {
        tilted.style.transform = '';
        tilted = null;
      }
      if (!poster || !wrap) return;
      var r = wrap.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      tilted = poster;
      poster.style.transition = 'transform 0.12s ease-out';
      poster.style.transform =
        'perspective(900px) rotateY(' + (px * 10).toFixed(2) + 'deg) rotateX(' +
        (-py * 8).toFixed(2) + 'deg) scale(1.02)';
    }, { passive: true });
    document.addEventListener('mouseout', function (e) {
      var wrap = e.target && e.target.closest ? e.target.closest('.detail-poster-wrap') : null;
      if (!wrap) return;
      var poster = wrap.querySelector('.detail-poster');
      if (poster) { poster.style.transform = ''; }
    }, { passive: true });

    /* skiper4 Theme toggle：点击弹性翻转（animationend 自摘帽，可重复触发） */
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.theme-toggle') : null;
      if (!btn || btn.classList.contains('nvx-tspin')) return;
      btn.classList.add('nvx-tspin');
      btn.addEventListener('animationend', function h() {
        btn.classList.remove('nvx-tspin');
        btn.removeEventListener('animationend', h);
      });
    });
  }

  /* ============ round45/round61 长任务加载动效 ============
     fetch 模式包装，零侵入 app.js。>400ms 才显形，快接口零闪烁。
     并发计数，全部落定后收层。
     修复项：
     1. 剔除 /api/webview/(stream|site|frameable) 等长连接与普通探测，避免卡死不消失
     2. 增加 7.5s 强制看门狗，任何网络挂起自动安全熔断消退
     3. 暴露 nvxLongReset()，切换页面时立即彻底销毁 */
  var LONG_TASKS = [
    { re: /\/api\/movie\/rescrape|\/api\/movie\/scrape-preview|\/api\/scanner\/rescrape-failed/, label: '正在刮削元数据' },
    { re: /\/api\/scanner\/watch-now/, label: '正在跳转播放' },
    { re: /\/api\/novel\/(scan|convert)|\/api\/comic\/scan/, label: '正在扫描媒体库' }
  ];
  var nvxLong = { n: 0, el: null, t: null, watchdog: null };

  function nvxLongReset() {
    nvxLong.n = 0;
    if (nvxLong.t) { clearTimeout(nvxLong.t); nvxLong.t = null; }
    if (nvxLong.watchdog) { clearTimeout(nvxLong.watchdog); nvxLong.watchdog = null; }
    var el = document.getElementById('nvxLong');
    var veil = document.getElementById('nvxLongVeil');
    if (el) {
      el.classList.add('bye');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }
    if (veil) {
      veil.classList.add('bye');
      setTimeout(function () { if (veil.parentNode) veil.parentNode.removeChild(veil); }, 200);
    }
    nvxLong.el = null;
  }

  function nvxLongShow(label) {
    nvxLong.n++;
    if (nvxLong.watchdog) clearTimeout(nvxLong.watchdog);
    nvxLong.watchdog = setTimeout(nvxLongReset, 7500); // 7.5s 安全看门狗

    if (nvxLong.el) { nvxLongSetLabel(label); return; }
    if (nvxLong.t) clearTimeout(nvxLong.t);
    nvxLong.t = setTimeout(function () {
      if (nvxLong.n <= 0) return;
      if (!document.getElementById('nvxLongVeil')) {
        var veil = document.createElement('div');
        veil.id = 'nvxLongVeil';
        document.body.appendChild(veil);
      }
      var el = document.createElement('div');
      el.id = 'nvxLong';

      var loaderSrc = (window.animState && window.animState.urls && window.animState.urls.loader)
          ? window.animState.urls.loader
          : 'img/extras/walk-character.webp';
      var isVid = /\.(mp4|webm|mov)$/i.test(loaderSrc);
      var mediaHtml = isVid
          ? '<video class="nvxl-walk" muted loop autoplay playsinline disablepictureinpicture preload="auto" src="' + loaderSrc + '"></video>'
          : '<img class="nvxl-walk" src="' + loaderSrc + '" alt="">';
      el.innerHTML = mediaHtml + '<b class="nvxl-label"></b>';
      document.body.appendChild(el);
      nvxLong.el = el;
      nvxLongSetLabel(label);
    }, 380);
  }

  function nvxLongSetLabel(label) {
    var el = nvxLong.el;
    if (!el) return;
    var rawText = String(label || '正在加载').replace(/[…\. ]+$/, '');
    var letters = Array.from(rawText).map(function (ch, i) {
      return '<i style="--wd:' + (i * 35) + 'ms">' + (ch === ' ' ? '&nbsp;' : ch) + '</i>';
    }).join('');
    var dots = '<span class="nvx-bouncing-dots"><i></i><i></i><i></i></span>';
    el.querySelector('b').innerHTML = letters + dots;
  }

  function nvxLongHide() {
    nvxLong.n = Math.max(0, nvxLong.n - 1);
    if (nvxLong.n > 0) return;
    if (nvxLong.watchdog) { clearTimeout(nvxLong.watchdog); nvxLong.watchdog = null; }
    if (!nvxLong.el) { clearTimeout(nvxLong.t); nvxLong.t = null; return; }
    var el = nvxLong.el;
    var veil = document.getElementById('nvxLongVeil');
    nvxLong.el = null;
    clearTimeout(nvxLong.t);
    nvxLong.t = null;
    el.classList.add('bye');
    if (veil) veil.classList.add('bye');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (veil && veil.parentNode) veil.parentNode.removeChild(veil);
    }, 300);
  }

  function armLongTasks() {
    if (armLongTasks.done || typeof window.fetch !== 'function') return;
    armLongTasks.done = true;
    window.NVX_LONG = { show: nvxLongShow, hide: nvxLongHide, reset: nvxLongReset };   /* 测试与复位句柄 */
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) /* noop */ {}
      var hit = null;
      for (var i = 0; i < LONG_TASKS.length; i++) {
        if (LONG_TASKS[i].re.test(url)) { hit = LONG_TASKS[i]; break; }
      }
      if (!hit) return origFetch(input, init);
      nvxLongShow(hit.label);
      return origFetch(input, init).then(function (res) {
        nvxLongHide();
        return res;
      }, function (err) {
        nvxLongHide();
        throw err;
      });
    };
  }

  /* ============ round52 动效广泛适配 P1（方案已批，EXE 验收制） ============
     A 树折叠=纯 CSS 级联（round-motion-extras）；B 板块滑动指示条=skiper96；
     C 海报揭示级联=skiper71/104，会话内每张只演一次。均可从动效库开关。 */
  function armP1Fx() {
    if (armP1Fx.done) return;
    armP1Fx.done = true;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    /* B skiper96：滑动指示条。容器里第一个按钮后插入胶囊底座，
       点击任意按钮 → 底座滑过去（方向感知，过冲弹簧）。容器重渲染后自动重建。 */
    var TAB_BTN = '[data-favboard]';
    function ensureSlider(bar) {
      var s = bar.querySelector('.nvx-tab-slider');
      if (!s) {
        s = document.createElement('span');
        s.className = 'nvx-tab-slider';
        bar.insertBefore(s, bar.firstChild);
      }
      return s;
    }
    function moveSlider(bar, btn, instant) {
      if (document.body.classList.contains('fx-favtab-off')) return;
      var s = ensureSlider(bar);
      s.style.opacity = '1';
      if (instant) s.style.transition = 'none';
      s.style.width = btn.offsetWidth + 'px';
      s.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
      if (instant) {
        void s.offsetWidth;   /* flush 后恢复过渡，下次点击才有滑动 */
        s.style.transition = '';
      }
    }
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(TAB_BTN) : null;
      if (!btn) return;
      var bar = btn.parentElement;
      if (!bar) return;
      moveSlider(bar, btn, false);
    }, true);
    /* 初挂与重渲染：委托 MutationObserver 兜底找含 TAB_BTN 的条 */
    new MutationObserver(function () {
      if (document.body.classList.contains('fx-favtab-off')) {
        Array.prototype.forEach.call(document.querySelectorAll('.nvx-tab-slider'), function (s) { s.remove(); });
        return;
      }
      Array.prototype.forEach.call(document.querySelectorAll(TAB_BTN), function (b) {
        var bar = b.parentElement;
        if (!bar || bar.querySelector('.nvx-tab-slider')) return;
        var active = b.classList.contains('btn-secondary') ? null :
          (bar.querySelector(TAB_BTN + ':not(.btn-secondary)') || b);
        moveSlider(bar, active || b, true);
      });
    }).observe(document.body, { childList: true, subtree: true });

    /* C skiper71/104：海报揭示级联。IO 首次进入视口 → blur+沉浮揭示；
       按批内序号 35ms 级联；src 去重 = 会话内每张只演一次（翻回来不重播）。 */
    var revealed = new Set();
    var io = new IntersectionObserver(function (entries) {
      var batch = 0;
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var img = en.target;
        io.unobserve(img);
        var src = img.currentSrc || img.src || '';
        if (!src || revealed.has(src)) return;
        revealed.add(src);
        img.style.setProperty('--rd', (batch++ * 35) + 'ms');
        img.classList.add('nvx-reveal-in');
      });
    }, { rootMargin: '60px 0px' });
    function watchGrid() {
      if (document.body.classList.contains('fx-reveal-off')) return;
      Array.prototype.forEach.call(document.querySelectorAll('#movieGrid img.movie-poster'), function (img) {
        if (img.dataset.nvxRv) return;
        img.dataset.nvxRv = '1';
        io.observe(img);
      });
    }
    new MutationObserver(watchGrid).observe(document.body, { childList: true, subtree: true });
    watchGrid();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
