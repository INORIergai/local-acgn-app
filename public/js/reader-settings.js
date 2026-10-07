/* ============================================================
   CinemaVault · reader-settings.js —— 阅读器设置面板（小说 / 漫画共用）
   ------------------------------------------------------------
   为什么抽出来：
     漫画与小说是两个各自独立的大 HTML（各自内联 CSS+JS），
     如果设置面板各写一遍，就会出现「小说有三项、漫画有两项、
     名字叫法还不一样」这种必然漂移。这里统一数据定义 + 统一渲染，
     两个阅读器只负责「拿到一整份 settings 后怎么落到自己的 DOM 上」。

   ★ 职责边界（重要）
     本模块**不碰任何阅读器的 DOM 细节**（除了它自己渲染的面板）。
     所有实际生效逻辑都在阅读器传入的 apply(settings) 里。
     这样以后给某个阅读器加一个新选项，改动只落在这一个文件 + 那边的 apply。

   ★ 参考来源
     微信读书 / 起点 / 掌阅 的网页与 App 设置项交集：
       字号 / 行距 / 页边距 / 字体 / 背景(含夜间) / 翻页方式 / 翻页速度 /
       自动翻页 / 排版(单双页) / 阅读方向 / 缩放默认值
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = {
    novel: 'cvReaderSettings:novel',
    comic: 'cvReaderSettings:comic'
  };

  /* ---------- 数据定义 ----------
     每项：id / label / type / options[{v,label,swatch}] / def(默认值)
     改这里就等于改两个阅读器的设置项，无需动 HTML。 */
  var SCHEMA = {
    common: [
      {
        id: 'turnStyle', label: '翻页样式', type: 'choice', def: 'curl',
        hint: '漫画 / 小说页面演出的形式',
        options: [
          { v: 'curl', label: '仿真卷曲' },
          { v: 'slide', label: '平移' },
          { v: 'fade', label: '淡入' },
          { v: 'none', label: '无动画' }
        ]
      },
      {
        id: 'turnSpeed', label: '翻页动画速度', type: 'choice', def: 'normal',
        hint: '卷曲 / 平移 / 淡入的时长',
        options: [
          { v: 'slow', label: '慢' },
          { v: 'normal', label: '标准' },
          { v: 'fast', label: '快' }
        ]
      },
      {
        id: 'autoTurn', label: '自动翻页', type: 'choice', def: 0,
        hint: '到点自动翻到下一页（参考微信读书「自动阅读」）',
        options: [
          { v: 0, label: '关' },
          { v: 5000, label: '5 秒' },
          { v: 8000, label: '8 秒' },
          { v: 12000, label: '12 秒' }
        ]
      }
    ],
    /* 小说专属：排版类 */
    novel: [
      {
        id: 'fontSize', label: '字号', type: 'choice', def: 18,
        options: [
          { v: 14, label: '小' }, { v: 18, label: '中' },
          { v: 22, label: '大' }, { v: 26, label: '特大' }
        ]
      },
      {
        id: 'lineHeight', label: '行距', type: 'choice', def: 1.8,
        options: [
          { v: 1.5, label: '紧凑' }, { v: 1.8, label: '标准' }, { v: 2.2, label: '宽松' }
        ]
      },
      {
        id: 'padding', label: '页边距', type: 'choice', def: 20,
        options: [
          { v: 10, label: '窄' }, { v: 20, label: '标准' }, { v: 30, label: '宽' }
        ]
      },
      {
        id: 'fontFamily', label: '字体', type: 'choice', def: 'serif',
        hint: '微信读书/掌阅都提供多字体切换',
        options: [
          { v: 'serif', label: '宋体' }, { v: 'sans', label: '黑体' },
          { v: 'kai', label: '楷体' }, { v: 'hei-light', label: '细黑' }
        ]
      },
      {
        id: 'bg', label: '背景颜色', type: 'swatch', def: '#f5f0e6',
        options: [
          { v: '#f5f0e6', swatch: '#f5f0e6', label: '纸黄' },
          { v: '#ffffff', swatch: '#ffffff', label: '纯白' },
          { v: '#c7edcc', swatch: '#c7edcc', label: '护眼绿' },
          { v: '#e8e0d0', swatch: '#e8e0d0', label: '米色' },
          { v: '#2a2a2a', swatch: '#2a2a2a', label: '暗色' }
        ]
      },
      {
        id: 'night', label: '夜间模式', type: 'toggle', def: false,
        hint: '与工具栏 🌙 按钮同一个开关'
      }
    ],
    /* 漫画专属：图像与版式 */
    comic: [
      {
        id: 'layout', label: '排版方式', type: 'choice', def: 'single',
        hint: '单页 / 双页跨页拼合',
        options: [
          { v: 'single', label: '单页' }, { v: 'dual', label: '双页' }
        ]
      },
      {
        id: 'rtl', label: '阅读方向', type: 'choice', def: 'ltr',
        hint: '日漫需要从右往左翻',
        options: [
          { v: 'ltr', label: '左翻（常规）' }, { v: 'rtl', label: '右翻（日漫）' }
        ]
      },
      {
        id: 'fit', label: '缩放默认值', type: 'choice', def: 'contain',
        hint: '打开漫画时的适配方式（漫画没有「字号」概念，用这个替代）',
        options: [
          { v: 'contain', label: '适应屏幕' },
          { v: 'width', label: '适应宽度' },
          { v: 'none', label: '原尺寸 100%' }
        ]
      },
      {
        id: 'bg', label: '背景颜色', type: 'swatch', def: '#12100c',
        options: [
          { v: '#ffffff', swatch: '#ffffff', label: '纯白' },
          { v: '#d8d4cc', swatch: '#d8d4cc', label: '浅灰' },
          { v: '#22222a', swatch: '#22222a', label: '深灰' },
          { v: '#12100c', swatch: '#12100c', label: '观赏黑' },
          { v: '#000000', swatch: '#000000', label: '纯黑' }
        ]
      },
      {
        id: 'night', label: '夜间模式', type: 'toggle', def: false,
        hint: '与工具栏 🌙 按钮同一个开关'
      }
    ]
  };

  function groupsFor(kind) {
    var g = [];
    if (kind === 'novel') {
      // 小说：先排版类，再共用的翻页类 —— 与大多数阅读 App 的顺序一致
      g = g.concat(SCHEMA.novel);
    } else {
      g = g.concat(SCHEMA.comic);
    }
    return g.concat(SCHEMA.common);
  }

  function defaults(kind) {
    var out = {};
    groupsFor(kind).forEach(function (it) { out[it.id] = it.def; });
    return out;
  }

  function load(kind) {
    var def = defaults(kind);
    try {
      var raw = localStorage.getItem(KEY[kind]);
      if (!raw) return def;
      var saved = JSON.parse(raw) || {};
      // 只接受 schema 里存在的键，防止旧版本残留把面板搞乱
      Object.keys(def).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(saved, k) && saved[k] !== undefined && saved[k] !== null) {
          def[k] = saved[k];
        }
      });
    } catch (e) { /* localStorage 不可用 / JSON 坏了 → 用默认值 */ }
    return def;
  }

  function save(kind, s) {
    try { localStorage.setItem(KEY[kind], JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 渲染 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * 渲染面板
   * @param el       面板容器（会整体重绘）
   * @param kind     'novel' | 'comic'
   * @param state    当前设置对象
   * @param onPick   (id, value) => void   用户选了某个选项
   * @param title    面板标题
   */
  function render(el, kind, state, onPick, title) {
    if (!el) return;
    var html = '<div class="rs-title">' + esc(title || '⚙️ 阅读设置') + '</div>';

    groupsFor(kind).forEach(function (g) {
      html += '<div class="rs-group">';
      html += '<div class="rs-label">' + esc(g.label) + '</div>';
      if (g.hint) html += '<div class="rs-hint">' + esc(g.hint) + '</div>';

      if (g.type === 'swatch') {
        html += '<div class="rs-swatches">';
        g.options.forEach(function (o) {
          var on = String(o.v) === String(state[g.id]);
          html += '<div class="rs-swatch' + (on ? ' active' : '') + '"' +
            ' title="' + esc(o.label) + '"' +
            ' style="background:' + esc(o.swatch) + ';"' +
            ' data-rs-id="' + esc(g.id) + '" data-rs-v="' + esc(o.v) + '"></div>';
        });
        html += '</div>';
      } else if (g.type === 'toggle') {
        var on = !!state[g.id];
        html += '<div class="rs-options">' +
          '<div class="rs-option' + (on ? ' active' : '') + '" data-rs-id="' + esc(g.id) + '" data-rs-v="1">开</div>' +
          '<div class="rs-option' + (!on ? ' active' : '') + '" data-rs-id="' + esc(g.id) + '" data-rs-v="0">关</div>' +
          '</div>';
      } else {
        html += '<div class="rs-options">';
        g.options.forEach(function (o) {
          var on = String(o.v) === String(state[g.id]);
          html += '<div class="rs-option' + (on ? ' active' : '') + '"' +
            ' data-rs-id="' + esc(g.id) + '" data-rs-v="' + esc(o.v) + '">' +
            esc(o.label) + '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
    });

    el.innerHTML = html;

    el.querySelectorAll('[data-rs-id]').forEach(function (node) {
      node.addEventListener('click', function () {
        var id = node.getAttribute('data-rs-id');
        var raw = node.getAttribute('data-rs-v');
        var item = null;
        groupsFor(kind).forEach(function (g) { if (g.id === id) item = g; });
        if (!item) return;
        var val;
        if (item.type === 'toggle') val = raw === '1';
        else if (typeof item.def === 'number') val = Number(raw);
        else val = raw;
        onPick(id, val);
      });
    });
  }

  /* ---------- 自动翻页 ---------- */
  /** 用法： var at = ReaderSettings.autoTurn(getMs, nextFn);  at.restart(); at.clear(); */
  function autoTurn(getMs, nextFn) {
    var t = null;
    function clear() { if (t) { clearInterval(t); t = null; } }
    function restart() {
      clear();
      var ms = Number(getMs()) || 0;
      if (ms > 0) t = setInterval(function () { nextFn(); }, ms);
    }
    return { restart: restart, clear: clear };
  }

  /* ---------- 速度 → 毫秒 ---------- */
  var SPEED_MS = { slow: 900, normal: 560, fast: 320 };
  function speedMs(name) { return SPEED_MS[String(name)] || SPEED_MS.normal; }

  global.ReaderSettings = {
    KEY: KEY,
    SCHEMA: SCHEMA,
    groupsFor: groupsFor,
    defaults: defaults,
    load: load,
    save: save,
    render: render,
    autoTurn: autoTurn,
    speedMs: speedMs,
    SPEED_MS: SPEED_MS
  };
})(window);
