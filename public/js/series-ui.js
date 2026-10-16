/**
 * round75 · 系列归类前端共享模块
 *
 * 与后端 utils/series-group.js 同一套算法的浏览器版：
 *   · 归一化提取系列基名（去扩展名/括号段/卷话标记，括号内标题回退）
 *   · 精确键分组 + Levenshtein ≥0.8 模糊合并 + 前缀包含
 *   · groupItems(list, titleFn) → Map(系列名 → 成员数组)，只含 ≥2 成员的系列
 *
 * UI 三件套（样式由本模块自注入，无需改 CSS 文件）：
 *   · SeriesUI.capsuleRow(seriesMap, active, onClick)  系列胶囊行（横向滚动）
 *   · SeriesUI.stackWrap(name, count, innerHtml)       摞卡外壳（内层放原卡片）
 *   · SeriesUI.slide*                                  round78 Page side-by-side 转场
 *
 * round78：摞卡 ⇄ 展开页的切换改用 Page side-by-side 转场（Transitions.dev 方案）。
 * 容器 .t-page-slide 叠两页 .t-page，用 data-page 在 1/2 间切；
 * page1 向左退出、page2 向右退出，位移+模糊+淡出三通道并行。
 * 样式在 public/css/round78-page-slide.css；这里只管状态与时序。
 */
(function () {
  'use strict';

  /* ---------------- 归一化（与 utils/series-group.js 保持一致） ---------------- */

  var EXT_RE = /\.(kepub|epub|pdf|zip|cbz|cbr|rar|7z|mobi|azw3?|txt|mp4|mkv|avi|mov|wmv|ts|webm|flv|m2ts)$/i;

  function widthFold(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
      else if (c === 0x3000) out += ' ';
      else out += s[i];
    }
    return out.toLowerCase();
  }

  function splitBrackets(s) {
    var pairs = { ']': '[', ')': '(', '】': '【', '）': '（', '〕': '〔', '}': '{', '」': '「' };
    var opens = Object.keys(pairs).length ? pairs : {};
    var openSet = {}; for (var k in pairs) openSet[pairs[k]] = 1;
    var segs = [], cur = '', buf = '', depth = 0, openCh = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (depth === 0 && openSet[ch]) { depth = 1; openCh = ch; if (buf.trim()) cur += buf; buf = ''; continue; }
      if (depth > 0) {
        if (ch === openCh) depth++;
        else if (ch === pairs[openCh]) { depth--; if (depth === 0) { segs.push(buf); buf = ''; continue; } }
        buf += ch;
      } else cur += ch;
    }
    if (buf) cur += buf;
    return { outside: cur, brackets: segs };
  }

  function stripVolumeTokens(s) {
    var out = s;
    var res = [
      /第\s*[0-9一二三四五六七八九十百千两]+\s*[卷话話集章季部册]/g,
      /(^|\s)[卷话話集]\s*[0-9]{1,3}$/g,
      /\b(vol|v|ch|c|volume|chapter|ep|episode)[.\s]*\d+\b/g,
      /#\d+/g,
      /[（(]\s*[0-9]{1,4}\s*[）)]$/g,
      /(^|\s)(番外|外传|外傳|特别篇|特別篇|sp|extra)(\s*[0-9]{1,4})?(\s|$)/g,
      /(?<=[\u4e00-\u9fff])[0-9]{1,4}([-–—][0-9.]{1,5})?$/g,   // ★ CJK 直连数字（本子6 / 本子1-2）
      /\s[0-9]{1,4}$/g,
      /\s[0-9]{1,4}\s*(完|end|终)$/g,
      /(全一卷|全1卷|完結|完结|\bend\b)$/g,
      /\s(上|中|下)(册|卷)?$/g,
      /\s(i{1,3}|iv|v|vi{1,3}|ix|x)\s*$/g
    ];
    for (var i = 0; i < res.length; i++) out = out.replace(res[i], ' ');
    // ★ 尾部括号组逐层剥（与 utils/series-group.js 保持一致）
    for (var j = 0; j < 3; j++) out = out.replace(/[（(][^（)）]*[）)]\s*$/, ' ');
    // ★ 尾部未闭合的开括号也剥（残缺标题）
    out = out.replace(/[（(][^（()）]*$/, ' ');
    return out.replace(/[\s~～·・—_\-:：,，.。]+/g, ' ').trim();
  }

  var CLOSE_CH = { ']': 1, ')': 1, '】': 1, '）': 1, '〕': 1, '}': 1, '」': 1 };

  /** 闭括号不平衡时递归拆（库内 title 常残缺成 "kmoe][系列名]卷01"） */
  function extractMain(s, depth) {
    if (depth > 3) return '';
    var parts = splitBrackets(s);
    var main = stripVolumeTokens(parts.outside);
    if (main.length >= 2 && !/[)\]」〕}]/.test(main)) return main;
    if (/[)\]」〕}]/.test(parts.outside)) {
      var m = -1, i;
      for (i = parts.outside.length - 1; i >= 0; i--) {
        if (CLOSE_CH[parts.outside[i]]) { m = i; break; }
      }
      if (m >= 0) {
        var suffix = stripVolumeTokens(parts.outside.slice(m + 1));
        if (suffix.length >= 2 && !/[)\]」〕}]/.test(suffix)) return suffix;
        var r = extractMain(parts.outside.slice(0, m), depth + 1);
        if (r) return r;
      }
    }
    for (i = parts.brackets.length - 1; i >= 0; i--) {
      var b = stripVolumeTokens(widthFold(parts.brackets[i]));
      if (b.length >= 2) return b;
    }
    return main;
  }

  function extractSeriesKey(raw) {
    var s = String(raw || '').trim().replace(EXT_RE, '');
    if (!s) return '';
    s = widthFold(s);
    var k = extractMain(s, 0);
    // ★ 纯卷号/通用序号不算系列名（防「卷01/卷02」跨作品互聚成假系列）
    if (!k || /^[卷话話集章回]\s*[0-9]{0,4}$/.test(k) || /^(vol|ch|c|v)[.\s]*\d+$/i.test(k)) return '';
    return k;
  }

  function lev(a, b) {
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (!la || !lb) return Math.max(la, lb);
    if (Math.abs(la - lb) > Math.max(la, lb) * 0.45) return Math.max(la, lb) + 1;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[lb];
  }

  function similarity(a, b) {
    if (a === b) return 1;
    var m = Math.max(a.length, b.length);
    if (!m) return 0;
    if (a.length >= 5 && b.length >= 5 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)) return 1;
    return 1 - lev(a, b) / m;
  }

  /* ---------------- 分组 ---------------- */

  /**
   * @param {Array} items 条目数组
   * @param {Function} titleFn 条目 → 标题
   * @returns {Map<string, Array>} 系列名 → 成员（按 items 原顺序），只含 ≥2 成员
   */
  function groupItems(items, titleFn) {
    var keyed = [];
    for (var i = 0; i < items.length; i++) {
      var k = extractSeriesKey(titleFn(items[i]));
      if (k) keyed.push({ k: k, it: items[i] });
    }
    var byKey = new Map();
    keyed.forEach(function (e) {
      if (!byKey.has(e.k)) byKey.set(e.k, []);
      byKey.get(e.k).push(e.it);
    });
    var clusters = [];
    byKey.forEach(function (list, key) { clusters.push({ key: key, list: list }); });
    clusters.sort(function (a, b) { return b.list.length - a.list.length; });
    var merged = [];
    clusters.forEach(function (c) {
      for (var i = 0; i < merged.length; i++) {
        if (similarity(c.key, merged[i].key) >= 0.8) { merged[i].list = merged[i].list.concat(c.list); return; }
      }
      merged.push(c);
    });
    var out = new Map();
    merged.forEach(function (c) { if (c.list.length >= 2) out.set(c.key, c.list); });
    return out;
  }

  /* ---------------- 样式（自注入一次） ---------------- */

  var CSS = [
    '.av-series-row{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:6px 2px 2px;scrollbar-width:thin;}',
    '.av-series-row .av-scap{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;',
    'border:1px solid var(--border,#888780);background:var(--bg-card,transparent);color:var(--text,#ddd);font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s;}',
    '.av-series-row .av-scap:hover{border-color:var(--primary,#f0a43c);color:var(--primary,#f0a43c);}',
    '.av-series-row .av-scap.active{background:var(--primary,#f0a43c);border-color:var(--primary,#f0a43c);color:#1c1917;font-weight:500;}',
    '.av-series-row .av-scap .n{opacity:.65;font-size:11.5px;}',
    '.av-series-label{flex:0 0 auto;font-size:11.5px;opacity:.55;letter-spacing:1px;}',
    '.av-stack{position:relative;cursor:pointer;}',
    '.av-stack .av-stack-under{position:absolute;left:0;right:0;top:0;height:calc(100% - 26px);border-radius:12px;',
    'background:var(--bg-card,#26221c);border:1px solid var(--border,#888780);}',
    '.av-stack .av-stack-under.u1{transform:rotate(1.6deg) translate(4px,7px);opacity:.75;}',
    '.av-stack .av-stack-under.u2{transform:rotate(-2deg) translate(-4px,9px);opacity:.55;}',
    '.av-stack .av-stack-top{position:relative;z-index:2;transition:transform .18s ease;}',
    '.av-stack:hover .av-stack-top{transform:translateY(-4px);}',
    '.av-stack .av-stack-hit{position:absolute;inset:0 0 26px 0;z-index:3;}',
    '.av-stack .av-stack-badge{position:absolute;z-index:4;top:-7px;right:-5px;padding:2px 8px;border-radius:999px;',
    'background:var(--primary,#f0a43c);color:#1c1917;font-size:11px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.35);}',
    '.av-stack .av-stack-name{position:relative;z-index:2;margin-top:5px;font-size:12px;color:var(--text,#ddd);',
    'text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.movie-grid .av-stack .movie-card{height:100%;}',
    '#seriesGridBar{grid-column:1/-1;}',
    /* round78：转场后胶囊行有两份（page1/page2 各一），id 不能重复 → 用 class 也给通栏 */
    '.seriesGridBar{grid-column:1/-1;}'
  ].join('');
  var styleTag = null;
  function injectCss() {
    if (styleTag) return;
    styleTag = document.createElement('style');
    styleTag.id = 'seriesUiCss';
    styleTag.textContent = CSS;
    document.head.appendChild(styleTag);
  }

  /* ---------------- UI 件 ---------------- */

  /**
   * 系列胶囊行 HTML。
   * @param {Map<string,Array>} seriesMap
   * @param {string} active 当前激活系列名（'' = 无）
   * @param {string} idPrefix 胶囊 data-series 直接存系列名
   */
  function capsuleRow(seriesMap, active) {
    if (!seriesMap || !seriesMap.size) return '';
    var html = '<div class="av-series-row"><span class="av-series-label">系列</span>';
    var names = [...seriesMap.keys()];
    names.sort(function (a, b) { return seriesMap.get(b).length - seriesMap.get(a).length; });
    names.forEach(function (name) {
      var n = seriesMap.get(name).length;
      html += '<button type="button" class="av-scap' + (name === active ? ' active' : '') + '" data-series="' +
        escAttr(name) + '">' + escHtml(name) + '<span class="n">' + n + '</span></button>';
    });
    html += '</div>';
    return html;
  }

  /** round75b：服务端聚合数据直接渲染胶囊（list = [{serial, count}]，服务端已按 count 降序）
   *  根级跨文件夹的系列本地聚不出来，只能用 /api/movie/series 的结果。 */
  function capsuleRowCounts(list, active) {
    if (!list || !list.length) return '';
    var html = '<div class="av-series-row"><span class="av-series-label">系列</span>';
    list.forEach(function (s) {
      html += '<button type="button" class="av-scap' + (s.serial === active ? ' active' : '') + '" data-series="' +
        escAttr(s.serial) + '">' + escHtml(s.serial) + '<span class="n">' + s.count + '</span></button>';
    });
    html += '</div>';
    return html;
  }

  /** 摞卡外壳：innerHtml 放原卡片（textCard / renderMovieCard 的输出） */
  function stackWrap(name, count, innerHtml) {
    return '<div class="av-stack" data-series="' + escAttr(name) + '">' +
      '<div class="av-stack-under u2"></div>' +
      '<div class="av-stack-under u1"></div>' +
      '<div class="av-stack-top">' + innerHtml + '</div>' +
      '<div class="av-stack-hit" title="展开系列「' + escAttr(name) + '"></div>' +
      '<div class="av-stack-badge">' + count + ' 本</div>' +
      '<div class="av-stack-name">' + escHtml(name) + '</div>' +
      '</div>';
  }

  /** 给容器里所有 .av-stack-hit 绑展开回调 */
  function bindStacks(container, onExpand) {
    if (!container) return;
    container.querySelectorAll('.av-stack-hit').forEach(function (hit) {
      var stack = hit.closest('.av-stack');
      if (!stack || stack.__seriesBound) return;
      stack.__seriesBound = true;
      hit.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        onExpand(stack.dataset.series);
      }, true);
    });
  }

  /* ---------------- round78 · Page side-by-side 转场 ---------------- */

  /**
   * 两页并排容器的外壳。
   *
   * @param {string} layout 'grid'（影片网格语境）| 'board'（av-board 书架语境）
   * @param {string} page1Html 首页 HTML（摞卡网格）
   * @param {string} page2Html 次页 HTML（系列展开态）
   * @param {string} active '1' | '2'，初始停在第几页
   */
  function slideWrap(layout, page1Html, page2Html, active) {
    var cur = String(active) === '2' ? '2' : '1';
    return '<div class="t-page-slide" data-layout="' + escAttr(layout || 'grid') + '" data-page="' + cur + '">' +
      '<div class="t-page" data-page="1">' + page1Html + '</div>' +
      '<div class="t-page" data-page="2"' + (cur === '2' ? '' : ' hidden') + '>' + page2Html + '</div>' +
      '</div>';
  }

  /** 取当前页码 */
  function slidePage(container) {
    return String(container && container.getAttribute('data-page')) === '2' ? '2' : '1';
  }

  /** 读出实际过渡时长（ms），供 JS 决定何时收起离场页 */
  function slideDuration(container) {
    if (!container || !window.getComputedStyle) return 520;
    var v = getComputedStyle(container).getPropertyValue('--page-duration');
    var n = parseFloat(v);
    if (!isFinite(n)) return 520;
    return v.indexOf('ms') >= 0 ? n : n * 1000;   // 0.52s → 520
  }

  /**
   * 切页。转场结束后把离场页 hidden —— 两页在 grid 里同格，
   * 不收起的话容器高度会被较高的一页撑住。
   */
  function slideTo(container, page) {
    if (!container) return;
    var next = String(page) === '2' ? '2' : '1';
    if (slidePage(container) === next) return;

    var pages = container.querySelectorAll(':scope > .t-page');
    var incoming = container.querySelector(':scope > .t-page[data-page="' + next + '"]');
    if (!incoming) return;

    // 先解除 hidden 并复位到离场态，再切属性 —— 否则浏览器看不到起始帧，不会有过渡
    pages.forEach(function (p) { p.hidden = false; });
    void container.offsetWidth;                 // 强制回流，锁定起始帧

    container.classList.add('is-moving');
    container.setAttribute('data-page', next);

    if (container.__slideTimer) clearTimeout(container.__slideTimer);
    var dur = slideDuration(container);
    container.__slideTimer = setTimeout(function () {
      container.classList.remove('is-moving');
      container.querySelectorAll(':scope > .t-page').forEach(function (p) {
        if (p.getAttribute('data-page') !== next) p.hidden = true;
      });
      container.__slideTimer = null;
    }, dur + 40);                                // +40ms 兜底，别让最后一帧被砍
  }

  /** 只给容器标注「第几页是语义上的当前态」，不触发转场（首次渲染用） */
  function slideMark(container, page) {
    if (!container) return;
    container.setAttribute('data-page', String(page) === '2' ? '2' : '1');
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(s) { return escHtml(s); }

  injectCss();

  window.SeriesUI = { groupItems: groupItems, capsuleRow: capsuleRow, capsuleRowCounts: capsuleRowCounts, stackWrap: stackWrap, bindStacks: bindStacks, extractSeriesKey: extractSeriesKey, slideWrap: slideWrap, slideTo: slideTo, slidePage: slidePage, slideMark: slideMark };
})();
