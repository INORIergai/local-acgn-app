/* ============================================================
   CinemaVault · squeeze-carousel.js
   ------------------------------------------------------------
   「精选推荐」挤压式轮播（原生移植 SqueezeCarousel）。

   为什么不用源码里的 React 版：
     本项目是原生 HTML/CSS/JS，无 React / 无 Tailwind / 无构建步骤。
     保留的是动效本身 —— 份额几何、hover 挤压、条带推进、
     easeOutExpo 缓动、reduced-motion 降级。

   ★ 份额几何（本组件的核心）—— ★★ round80 重做，旧版有一处致命设计缺陷
   ------------------------------------------------------------------
   旧版：SHARES = [-0.06, 0.61, 0.30, 0.15]，带符号累加 left
     left(-1)=0 / left(0)=-0.06 / left(1)=0.55 / left(2)=0.85
     ⇒ 主卡从 -6% 起，**左侧出血 6%**；最右边界 0.85+0.15=1.00 恰好满边。

     ⇒ 坏在( a )：主卡整体左移，容器里左边空出一块 ——
                 这就是用户说的「海报封面不在正中，反而偏左」。
              坏在( b )：右边界 = 1 - |slat|，想让残条宽一点就必须重写全部份额。

   新版：残条改为**与主卡同起点、叠在主卡左缘**（压叠，不出血）
       r=-1: left =  0,     w = slat     → [ 0,   slat  )  z-index 高于主卡
       r= 0: left =  0,     w = 0.52     → [ 0,    0.52 )
       r= 1: left =  0.52,  w = 0.28     → [ 0.52, 0.80 )
       r= 2: left =  0.80,  w = 0.20     → [ 0.80, 1.00 )  ← 正好贴右缘
     ★ 不变式（几何脚本按这三条断言，改动后必测）：
       1) 主卡 left 恒为 0        —— 主卡不再偏移，这是「偏左」的直接修复
       2) 正面三列 Σ(A+B+C) = 1  —— 右缘恒贴容器右边，与残条宽度无关
       3) 残条 left = 0、width = slat，且 z-index > 主卡 —— 读作「上一张压在左缘」

   ★★ 为什么残条不改成「向左出血」（left = -slat）：
     那样几何更漂亮，但 .gallery-container 在 style.css:369 有 overflow:hidden，
     出容器左缘的部分会被整条裁掉。压叠方案既符合 CSS 原注释
     （「slot -1 = 上一张残条，压在主卡左缘 → 挤压缝」），
     又零裁切风险，还让残条宽度成为真正可独立调节的参数。

   ★ hover 挤压（STRETCHED / SQUEEZED）
     原组件里 STRETCHED = 该列份额放大、SQUEEZED = 其余列等比收窄。
     这里保持同一份额代数：hover 时把被指列的份额乘 STRETCH，其余按
     「剩余总量 / 其余份额和」等比压缩 —— 正份额总和恒为 1，尾巴不会被挤出界。
     ★ 只作用于正面列：残条压在主卡上，挤它没有意义。

   ★★ round81：按海报真实比例自适应（Task #8）
   ------------------------------------------------------------------
   痛点：容器写死 aspect-ratio:16/9 + img 用 object-fit:cover，
        对 16:9 的电影海报勉强能用，但**漫画 / 小说的封面是 3:4 或 9:16**，
        塞进 16:9 的基准块后上下各切一刀，一张竖封面只剩中间一条，
        用户认不出是哪一本 —— 这是「化推荐区面对竖海报时必须改」的根源。

   做法：读每张封面 <img> 的 naturalWidth/naturalHeight，取**中位数**
        （抗「个别条目用了横版宣传图」这种异常），然后在三个标准比例里
        取**对数距离最近**的一档（对数才是「形状相似」的正确度量，
        线性距离会让 0.56 偏向 1.78 那一侧）：

           wide     16:9    → 3 列  主卡 52%   容器 16:9（★ 与 round80 完全一致，不动）
           portrait 3:4     → 4 列  主卡 40%   容器 (3/4)/0.40 = 1.875
           tall     9:16    → 5 列  主卡 32%   容器 (9/16)/0.32 = 1.758

   为什么「竖海报 → 列数变多」：容器高度恒等于列高，主卡越窄 ⇒ 单列越修长，
   正好贴竖封面的形状。同时容器宽高比按
        containerAR = 海报AR / 主卡份额
   反推 —— 这样**主卡恰好不裁剪**，后面的递减卡自然被切，正是核心的那层 strip 美学。

   ⚠️ 实测修正（_r81-squeeze-ratio-live.js 倒逼）：
      真正算比例时必须用**实测中位比例**，不能偷懒用上面那三个参考值 ——
      库里真实封面的中位 AR 常常是 0.617 这种落在两档之间的数，
      按参考值反推会残留约 9% 的裁切。详见 containerArFor()。
      首帧（封面还没解码）沿用 round80 的 16/9，避免开局就有「变高变矮」的跳动。

   ★★★ round81 Task#9：三版候选动效并存（用户挑一版定稿）
   ------------------------------------------------------------------
   用户原话：「精选推荐的你并没有按照我给你要求的动效进行更改……
             可以参考随机推荐里卡片动效的样式，也可以在动效路径下
             （D:\UI_anime）找最新的卡片动效进行追加。」
   ⇒ 动效到底要哪一种，一次说不清。**做三版并存，用 data-sq-motion 切换**：

     A squeeze 挤压条带（默认）—— 上面整套份额几何。最保守，几何已被
        103 项断言锁死。代价：仍需 left/width 过渡（每列的 object-fit:cover
        要按自己的宽高比重算，改走 transform 会退化成「整图取中间一条」，
        竖海报反而被切得更狠）。
     B deck   3D 牌堆 —— 卡固定尺寸居中堆叠，offset 一个参数同时给出
        translate3d / rotateY / scale，缓动 cubic-bezier(.34,1.56,.64,1)
        （带回弹的 overshoot）。移植自本项目「猜你喜欢」的 deck-carousel
        （app.js:10586 updateDeckCards + round-motion-extras.css:1225）。
        ✅ 全 transform ⇒ 只走合成层，不触发重排重绘。
     C halo   椭圆光环 —— 移植 D:\UI_anime\21st-gallery\33-halo-reel 的核心思想：
        「cos θ 一个参数同时决定 x 位置、缩放、层级，三者永不打架」，
        近端大、远端小。可拖拽转动。
        ✅ 全 transform。

   三版共用：卡片池 / 点击打开 / 自动播放 / 键盘 / 销毁 / 比例探测。
   切换优先级：create({motion}) > URL ?sqMotion= > localStorage cvSqueezeMotion > 'A'
   ============================================================ */
(function (global) {
  'use strict';

  /* ★ 残条宽度（压在主卡左缘的那一条「上一张」）。独立可调，不影响其它三列。 */
  var SLAT_W = 0.085;

  /* ★ round81 三档预设。faces 是正面列份额（Σ=1），ref 是这一档的参考海报比例。 */
  var PRESETS = {
    wide: {
      key: 'wide',
      faces: [0.52, 0.28, 0.20],                 // ★ 与 round80 完全一致
      mobile: [0.62, 0.38],
      ref: 16 / 9
    },
    portrait: {
      key: 'portrait',
      faces: [0.40, 0.24, 0.20, 0.16],
      mobile: [0.48, 0.30, 0.22],
      ref: 3 / 4
    },
    tall: {
      key: 'tall',
      faces: [0.32, 0.21, 0.17, 0.16, 0.14],
      mobile: [0.44, 0.30, 0.26],
      ref: 9 / 16
    }
  };
  var PRESET_DEFAULT = PRESETS.wide;

  /* 高度预算：容器高度 = 宽度 / containerAR，宽度上限由这条反推出去 */
  var MAX_H_VH = 78;

  /* 容器宽高比的合理区间（防极端封面把版式带跑，见 containerArFor 注释） */
  var AR_MIN = 1.5;
  var AR_MAX = 3.6;
  /* 首帧（封面还没解码）用这个比例，等于 round80 的 16:9 —— 不会有一开局就变高变矮的跳动 */
  var INITIAL_AR = 16 / 9;

  /* ★★ round81 Task#9：三版动效配置（详见文件头）
     containerAr = 0 表示「走 containerArFor 反推」（只有 A 用）；
     B/C 的容器比例固定 —— 它们的卡片是固定尺寸的 3D 层叠，
     容器只负责给一个横向展开的舞台，不需要按海报比例反推。 */
  var MOTION_KEY = 'cvSqueezeMotion';
  var MOTIONS = {
    A: { key: 'A', name: '挤压条带', containerAr: 0 },
    B: { key: 'B', name: '3D 牌堆', containerAr: 2.6, dur: 450, ease: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    C: { key: 'C', name: '光环转环', containerAr: 2.4, dur: 520, ease: 'cubic-bezier(0.16, 1, 0.3, 1)' }
  };
  /* ★ round81 用户实测三版后选定 **C 光环转环**（卡片沿椭圆环运行，
       cos θ 一个参数同时决定位置 / 缩放 / 层级，整环转动一格而非主卡原地换图，
       可鼠标拖拽）。其余两版保留可切：设置页「动效设置 → 精选推荐」三选即写这里。 */
  var MOTION_DEFAULT = 'C';

  /* B「3D 牌堆」参数（手感对齐 app.js updateDeckCards，尺寸按容器自适应）
     kW     = 单卡宽度占容器宽的比例
     stepK  = 相邻卡的横向步距 = 卡宽 * 该系数
     half   = 可见卡的 offset 上限（|off| <= half ⇒ 最多 2*half+1 张）
     ryStep = 每远离一格多绕 Y 轴转多少度
     ★★ ryStep 为什么不是 deck 原版的 -28：
        原版 half=3 + -28 ⇒ 最外侧转到 -84°，几乎完全侧立，
        实测渲染宽度只剩 **50px**（cos84°≈0.1，再叠 translateZ 的透视收缩），
        看着像两条细边而不是卡片。-18 ⇒ ±54°，最外侧实测约 75px，
        仍是一条「被推远的卡」，但读得出来是海报。 */
  var DECK = { kW: 0.22, stepK: 0.62, half: 3, ryStep: -18 };

  /* C「光环转环」参数
     kW     = 近端主卡宽度占容器宽的比例
     ampX   = 椭圆横向振幅（占容器宽）
     ampY   = 椭圆纵向振幅（占容器高）
     rotY   = 最大绕 Y 轴倾角（度）
     dragK  = 拖拽灵敏度（拖过容器宽 * dragK ⇒ 转过一整圈相位）
     ★★ ampY 为什么只有 0.13：环的「后排」靠纵向偏移从前排后面露出来，
        偏移越大露得越多；但容器高只有 card 高的 ~1.5 倍，
        ampY 再大前排卡的下沿就会被 overflow:hidden 切掉（实测 0.17 会切 5px）。 */
  var HALO = { kW: 0.20, ampX: 0.40, ampY: 0.13, rotY: 14, dragK: 0.55 };

  var EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';   // easeOutExpo
  var DUR = 620;                                  // ms，与 CSS --sq-dur 一致

  var STRETCH = 1.22;   // hover 目标列的份额倍率
  var SQUEEZE = 0.94;   // 其余列的份额倍率（两者的平衡点）

  var clamp = function (n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); };

  /** 容器应该用多宽：让高度不超过 MAX_H_VH，同时不超出握有的 100% */
  function widthExpr(ar) {
    return 'min(100%, calc(' + MAX_H_VH + 'vh * ' + ar.toFixed(4) + '))';
  }

  /** 份额（在对数空间）找一个标准比例 —— 比线性距离更接近「形状像不像」 */
  function classify(ar) {
    if (!ar || !isFinite(ar) || ar <= 0) return PRESET_DEFAULT;
    var best = PRESET_DEFAULT, bd = Infinity;
    Object.keys(PRESETS).forEach(function (k) {
      var p = PRESETS[k];
      var d = Math.abs(Math.log(ar / p.ref));
      if (d < bd) { bd = d; best = p; }
    });
    return best;
  }

  /* 向后兼容：旧代码/调试面板可能读 window.SqueezeCarousel.SHARES
     —— 语义仍是「slot 0=残条，slot 1..n = 正面列」。
     round81：取值改为跟随 wide 档（默认档），列数变了它也会跟着变。 */
  var SHARES = [SLAT_W].concat(PRESET_DEFAULT.faces);

  /**
   * 决定用哪一版动效：显式传参 > URL ?sqMotion= > localStorage > 默认 A
   * ⚠️ URL 参数优先，是为了让「三版对比页」和「用户直接开链接试版」都成立；
   *    localStorage 是给用户试完以后钉住某一版用的。
   */
  function resolveMotion(v) {
    var k = String(v || '').toUpperCase();
    if (MOTIONS[k]) return k;
    try {
      var q = global.location && global.location.search
        ? new URLSearchParams(global.location.search).get('sqMotion') : null;
      if (q && MOTIONS[String(q).toUpperCase()]) return String(q).toUpperCase();
      var ls = global.localStorage ? global.localStorage.getItem(MOTION_KEY) : null;
      if (ls && MOTIONS[String(ls).toUpperCase()]) return String(ls).toUpperCase();
    } catch (e) { /* 隐私模式下 localStorage 会抛，忽略即可 */ }
    return MOTION_DEFAULT;
  }

  /**
   * 创建一个轮播实例（三版动效共用同一份卡片池与生命周期）
   * @param {Object} opt
   *   container  外层定位容器（.gallery-container）
   *   movies     [{id, title, poster}]
   *   onOpen     点击某列时回调 (movie)
   *   onChange   当前索引变化时回调 (index)
   *   motion     'A' | 'B' | 'C'（可选，缺省走 resolveMotion）
   */
  function create(opt) {
    var container = opt.container;
    var movies = (opt.movies || []).slice();
    var onOpen = opt.onOpen || function () {};
    var onChange = opt.onChange || function () {};

    var motion = resolveMotion(opt.motion);          // ★ round81 Task#9
    var motionCfg = MOTIONS[motion];

    var reduce = global.matchMedia
      && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var strip = null;
    var cards = [];
    var index = 0;
    var hoverR = null;      // 当前 hover 的相对位（-1..n-1）
    var timer = null;
    var built = false;
    var preset = PRESET_DEFAULT;   // round81：当前比例档
    var measured = 0;              // round81：探测到的中位海报比例（0 = 还没测到）
    var haloDrag = 0;              // round81：C 版拖拽累积的环相位（弧度）
    var drag = null;               // round81：C 版拖拽会话

    // ---------- 建 DOM ----------
    // ⚠️ 只重建 .gallery-track，绝不清空 container：
    //    #galleryPrev / #galleryNext / #galleryDots 是 library.html 里的既有节点，
    //    外面还有 polish.css 的定位规则（left:16px / right:16px）和胶片齿孔伪元素。
    //    清空 container 会把它们一起干掉，箭头与圆点直接消失。
    function build() {
      var old = container.querySelector('.gallery-track');
      if (old && old.parentNode) old.parentNode.removeChild(old);

      var track = document.createElement('div');
      track.className = 'gallery-track';
      track.id = 'galleryTrack';
      track.style.setProperty('--sq-ease', EASE);
      track.style.setProperty('--sq-dur', (reduce ? 1 : DUR) + 'ms');
      /* ★ round81 Task#9：动效版本写到容器上，CSS 按 [data-sq-motion] 切换
         定位基线（A 用 left/width；B/C 用居中 + transform）与过渡曲线。 */
      container.setAttribute('data-sq-motion', motion);

      strip = document.createElement('div');
      strip.className = 'sq-strip';
      track.appendChild(strip);
      // 插到箭头之前（appendChild 会落在最后，正好在齿孔之下）
      container.insertBefore(track, container.firstChild);

      cards = movies.map(function (m, i) {
        var card = document.createElement('div');
        card.className = 'sq-card';
        card.dataset.index = String(i);
        card.title = m.title || '';
        var img = document.createElement('img');
        img.src = m.poster;
        img.alt = m.title || '';
        /* ★ round81：不再 lazy —— 本组件要读每张封面的 naturalWidth 判断真实比例，
              lazy 会让「被推到 -9999px 的那几张」永远不解码，样本只剩 2-3 张，
              median 就失去了抗异常的能力。总共只有 10 张且都在首屏黑边附近，
              直接 eager，代价可忽略。 */
        img.decoding = 'async';
        img.draggable = false;
        /* 每张解码完成都重算一次比例档（去抖 80ms）。
           这样做的好处：首屏先按默认 wide 画出来，图片陆续到位后自动换到正确档，
           不需要调用方（app.js）配合传任何 width/height 提示字段。 */
        img.addEventListener('load', function () { scheduleMeasure(); });
        img.addEventListener('error', function () { scheduleMeasure(); });
        card.appendChild(img);
        strip.appendChild(card);
        return card;
      });

      bind();
      built = true;
      measure();        // round81：能同步测到就测（图片已在缓存里时）
      apply();
    }

    /* ---------- round81：海报比例探测 → 选档 ---------- */
    var mt = null;
    function scheduleMeasure() {
      if (mt) clearTimeout(mt);
      mt = setTimeout(function () { mt = null; measure(); }, 80);
    }

    /** 读所有已解码封面的真实像素比例，取中位数，选最近的一档 */
    function measure() {
      if (!built) return;
      var ars = [];
      for (var i = 0; i < cards.length; i++) {
        var im = cards[i].querySelector('img');
        if (!im) continue;
        var nw = im.naturalWidth, nh = im.naturalHeight;
        if (nw > 0 && nh > 0) ars.push(nw / nh);
      }
      if (!ars.length) { setPreset(PRESET_DEFAULT, 0); return; }   // 一张都没解码：先按默认画
      ars.sort(function (a, b) { return a - b; });
      var med = ars[Math.floor(ars.length / 2)];
      setPreset(classify(med), med);
    }

    /* ★ 容器宽高比 = 实测中位海报比例 / 主卡份额（并夹在合理区间）
       ------------------------------------------------------------------
       ★★ 这一步是 _r81-squeeze-ratio-live.js 实测倒逼出来的：
           一开始图省事用了「预设的参考比例」反推（tall 档写死 9:16），
           结果浏览器实测打脸 —— 库里封面的中位 AR 是 **0.617**
           （既不是 3:4 的 0.75，也不是 9:16 的 0.5625，属于中间值），
           按 0.5625 反推出来的主卡渲染比例是 0.5623，
           与真实封面差 8.9% ⇒ 依然要被上下各裁一小条，等于没解决问题。
           改成按**实测值**反推后，主卡宽高比与封面严丝合缝，误差归零。
       ⚠️ 必须 clamp：若某天混进一张超长海报（AR 0.3），不夹就会算出 1.0 的容器，
          整块变成方形，配 stretches 会把次卡压成一条线。 */
    function containerArFor(p, medAr) {
      /* ★ round81 Task#9：B/C 的容器比例是固定的舞台比例，不参与反推 */
      if (motionCfg.containerAr) return motionCfg.containerAr;
      if (!medAr || !isFinite(medAr)) return INITIAL_AR;    // 首帧还没测到 → 沿用 round80 的 16/9，避免开局抖一下
      return clamp(medAr / p.faces[0], AR_MIN, AR_MAX);
    }

    /* ★ B/C：卡片是固定尺寸的 3D 层，尺寸必须按「容器 + 实测海报比例」算一次。
       kW = 单卡宽度占容器宽的比例；高度由海报比例推，再按容器高兜底夹一次。
       ⚠️ 为什么不交给 CSS：卡宽还要参与 B 的步距、C 的椭圆振幅，
          这些是 JS 算的，尺寸必须同源，否则「改了 kW 步距不变」会错位。 */
    function cardBox(kW) {
      var cw0 = container.clientWidth;
      var ch0 = container.clientHeight;
      var w = cw0 || 0, h = ch0 || 0;
      if (!w && !h) return null;                 // 还没布局，等下一次 measure/apply
      if (!w) w = h * 2.4;
      if (!h) h = w / 2.4;
      var ar = (measured && isFinite(measured) && measured > 0) ? measured : 0.7;
      var cw = Math.min(w * kW, h * 0.86 * ar);
      var ch = cw / ar;
      if (ch > h * 0.92) { ch = h * 0.92; cw = ch * ar; }
      return { w: Math.max(24, Math.round(cw)), h: Math.max(24, Math.round(ch)) };
    }

    /** 落地某一档：写 data 属性 + 容器宽度 + 容器宽高比，然后重排 */
    function setPreset(p, medAr) {
      var next = p || PRESET_DEFAULT;
      if (next === preset && Math.abs((measured || 0) - (medAr || 0)) < 1e-6) {
        return;                    // 没变化就不要重排（否则每次 load 都抖一下动画）
      }
      preset = next;
      measured = medAr || 0;

      var ar = containerArFor(next, measured);

      /* ⚠️ 容器宽度必须同步改写：宽高比变了，若沿用旧的 `78vh * 16/9`，
           竖海报档会被算成「宽 1387px 高 780px」——超过视口，整段顶下去。 */
      container.style.width = widthExpr(ar);
      container.setAttribute('data-sq-preset', next.key);
      // CSS 里 .gallery-track 读这个变量当 aspect-ratio（见 round79-squeeze.css）
      container.style.setProperty('--sq-ar', ar.toFixed(4));
      apply();
    }

    // ---------- 几何：份额 → 每列的 left/width ----------
    // ⚠️ 断点必须按**视口宽度**判，不能按容器 clientWidth。
    //    实测踩坑：桌面 1600px 视口下，推荐容器只占 736px（宽度由 16/9 反推），
    //    用容器宽度判就会误进 MOBILE 档（主卡 72%、只剩 3 列），桌面版式整个塌掉。
    //    与项目铁律一致：断点统一 860px。
    function isMobile() {
      return window.innerWidth <= 860;
    }

    /**
     * 份额 → 每列的 {left, width}（单位：容器宽度的比例）
     *
     * ★ round80 新模型：主卡不再左移，残条改为压在主卡左缘。
     *   geo[0]    = 残条   left = 0, width = SLAT_W（叠在主卡之上，z-index 更高）
     *   geo[1..n] = 正面列 left 从 0 起顺次累加，Σ = 1
     *
     * 下标约定：slot 0 = 残条（data-sq-r="-1"），slot r+1 = 正面第 r 张（data-sq-r="r"）。
     */
    function compute() {
      var mobile = isMobile();
      // round81：份额不再是两套写死的常量，由当前比例档给出（mobile 也各有三套）
      var base = mobile ? preset.mobile : preset.faces;
      var faces = base.slice();
      var n = faces.length;                 // wide 3 / portrait 4 / tall 5（窄屏各减一档）
      var k;

      // ★ 不变式 2：正面列 Σ 必须恒为 1，否则最右列会溢出容器（尾巴被挤出可见区）。
      //   自愈归一化，避免有人改配置写错就崩版式。
      var total = 0;
      for (k = 0; k < n; k++) total += faces[k];
      if (Math.abs(total - 1) > 1e-9) {
        for (k = 0; k < n; k++) faces[k] = faces[k] / total;
      }

      var shares = faces.slice();

      // hover 挤压：被指列乘 STRETCH，其余列等比吃掉剩余总量。
      // ★ 只作用于**正面列**：残条压在主卡左缘，挤它没有意义。
      //   hoverR 是 data-sq-r 的值，正面卡恰好等于 faces 的下标，不用再 +1 偏移。
      if (hoverR !== null && hoverR >= 0 && hoverR < n) {
        var hov = hoverR;
        var others = 0;
        for (k = 0; k < n; k++) if (k !== hov) others += faces[k];
        var want = Math.min(faces[hov] * STRETCH, 1);   // 上限 1：不能让单列超过容器宽
        for (k = 0; k < n; k++) {
          if (k === hov) {
            shares[k] = want;
          } else if (others > 1e-9) {
            shares[k] = (faces[k] / others) * (1 - want);   // Σ 其余 = 1 - want，仍闭合
          } else {
            shares[k] = 0;
          }
        }
      }

      // ★ 不变式 1 + 3：主卡 left 恒为 0；残条同起点、窄条，叠在主卡之上
      var out = [{ left: 0, width: SLAT_W, w: SLAT_W }];
      var left = 0;
      for (k = 0; k < n; k++) {
        var w = Math.max(0, shares[k]);
        out.push({ left: left, width: w, w: w });
        left += w;
      }
      return out;
    }

    // ---------- 应用一次布局 ----------
    // 相对位 r = 「从当前主卡沿环往前走的步数」，恒为非负：
    //   r = 0..maxR  正面可见卡（slot 1..n）—— 主卡 / 次卡 / 尾巴，全都可见可点
    //   r = len-1    环上「上一张」= 左侧残条（slot 0，压在主卡左缘）
    // ⚠️ 早期版本在这里做二次取模折叠（r>len/2 则减 len），结果 r=-1 与残条位
    //    撞车、尾部卡片落进 geo 越界槽位，翻页整体失效。改为纯前向距离后此坑消失。
    /** ★ round81 Task#9：按动效版本分发。
        三版共用 index / hoverR / cards / 自动播放 / 键盘，只有「落位」这一步不同。 */
    function apply() {
      if (motion === 'B') return applyDeck();
      if (motion === 'C') return applyHalo();
      return applySqueeze();
    }

    /** 隐藏越界卡。A 靠 -9999px，B/C 靠行内 opacity:0 —— 统一走这一处，
        免得三版各写一遍、某版漏清类名，留下「看不见但吃点击」的幽灵卡。 */
    function hideCard(card) {
      card.style.left = '-9999px';
      card.style.width = '0px';
      card.style.opacity = '0';
      card.style.transform = '';
      card.classList.remove('is-interactive', 'is-active', 'is-stretched',
        'is-squeezed', 'is-slat', 'is-tail');
      card.dataset.sqR = '9';
    }

    /** B/C 的卡是「居中 + 固定尺寸」：行内 left/width 必须清掉，
        否则 A 遗留的行内值会压过 CSS 的定位基线。 */
    function unstageCard(card) {
      card.style.left = '';
      card.style.width = '';
    }

    function applySqueeze() {
      var geo = compute();
      var slots = geo.length;                 // 1 残条 + n 正面列（桌面 4 / 窄屏 3）
      var len = movies.length;
      /* ★ 正面可见卡的最大相对位 = n-1 = slots-2。
         算错的后果实测过：写成 slots-3 或把下面的 `r <= maxR` 写成 `r < maxR`，
         尾巴卡（r = maxR）就拿不到 is-interactive ⇒ opacity:0，
         于是右侧整整 20% 轨宽空出来，「可视卡群中心」比容器中心偏左 223px。 */
      var maxR = slots - 2;                  // 桌面 2 / 窄屏 1
      var slatR = len - 1;                   // 残条位
      var hasSlat = len - 1 > maxR;          // 影片数不够时不硬塞残条
      var i;

      for (i = 0; i < cards.length; i++) {
        var card = cards[i];
        var r = ((i - index) % len + len) % len;

        var isSlat = hasSlat && r === slatR;
        var isFace = (r >= 0 && r <= maxR);      // 正面可见卡（含尾巴）
        var vis = isFace || isSlat;
        if (!vis) {
          card.style.left = '-9999px';
          card.style.width = '0px';
          card.classList.remove('is-interactive', 'is-active', 'is-stretched', 'is-squeezed');
          card.dataset.sqR = '9';
          continue;
        }

        // 份额位：残条 → 0，主卡 → 1，次卡 → 2..
        var slot = isSlat ? 0 : r + 1;
        var g = geo[slot];
        card.style.left = (g.left * 100).toFixed(4) + '%';
        card.style.width = (g.width * 100).toFixed(4) + '%';
        card.dataset.sqR = isSlat ? '-1' : String(r);

        /* ★ 可交互 = 正面全部可见卡（含尾巴）+ 残条。
           残条必须给 is-interactive —— round80 之前它拿不到这个类 ⇒ opacity:0，
           于是「占着空间却完全不可见」，主卡被推到左边（用户报的偏左）。
           尾巴同理：它占 20% 轨宽，隐藏就等于右侧空一块。 */
        var interactive = isSlat || isFace;
        card.classList.toggle('is-active', r === 0);
        card.classList.toggle('is-interactive', interactive);
        card.classList.toggle('is-stretched', hoverR !== null && hoverR === r);
        // SQUEEZED 标「非 hover 的正面卡」；残条是上一张的背影，不参与明暗对比
        card.classList.toggle('is-squeezed',
          hoverR !== null && hoverR !== r && isFace);

        /* ★ round81：层级改为按 r 递减的行内值。
             原来只在 CSS 里写了 r=-1..2 四条，列数一多（portrait 4 列 / tall 5 列）
             r=3、r=4 就没有规则 → z-index:auto → 层叠顺序不确定，
             挤压瞬间尾巴可能闪到主卡上面。行内写死彻底摆脱「写几列要配几条 CSS」。 */
        card.style.zIndex = String(isSlat ? 60 : (50 - (isFace ? r : 0)));
        // 递减列统一标记，方便 CSS 给「右边的条」压暗右边沿
        card.classList.toggle('is-slat', isSlat);
        card.classList.toggle('is-tail', isFace && r > 0);
      }
    }

    /* ---------- B：3D 牌堆 ----------
       移植自本项目「猜你喜欢」的 deck-carousel
       （app.js:10586 updateDeckCards + round-motion-extras.css:1225），
       缓动沿用 cubic-bezier(.34,1.56,.64,1) —— 收尾带一点 overshoot 的回弹，
       这正是用户说「随机推荐那边的卡片动效好看」的来源。

       与原版的两处差别：
         · 原版是固定 7 张 + 线性 offset（idx - center），循环时中心一换两端就重排；
           这里是**环**，offset 取环形最短带符号距离，10 张也能无缝循环。
         · 尺寸按「容器 + 实测海报比例」算，不再是写死的 190×280。
       ★ 和原版一样：offset 一个数字同时决定 tx / tz / ry / scale / opacity / z-index，
         所以不会出现「位置变了但缩放没跟上」这种自相矛盾的中间帧。 */
    function applyDeck() {
      var box = cardBox(DECK.kW);
      if (!box) { retryApply(); return; }
      var len = movies.length;
      var step = box.w * DECK.stepK;
      container.style.setProperty('--sq-card-w', box.w + 'px');
      container.style.setProperty('--sq-card-h', box.h + 'px');

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var r = ((i - index) % len + len) % len;
        /* ★ 环形最短带符号距离：绕半圈以上的应从「后面」过来，取负值。
           不折叠的话，最后几张会一股脑堆在右侧，翻页时整排瞬间跳位。 */
        var off = (r > len / 2) ? r - len : r;
        if (Math.abs(off) > DECK.half) { hideCard(card); continue; }
        unstageCard(card);

        var absOff = Math.abs(off);
        var isCenter = (off === 0);
        var tx = off * step;
        var tz = isCenter ? 60 : -absOff * 90;
        var ry = off * DECK.ryStep;
        var sc = isCenter ? 1.08 : Math.max(0.72, 1 - absOff * 0.12);
        if (hoverR !== null && hoverR === r) sc *= 1.05;
        var op = isCenter ? 1 : Math.max(0.48, 1 - absOff * 0.2);

        card.style.transform =
          'translate3d(calc(-50% + ' + tx.toFixed(1) + 'px), -50%, ' + tz + 'px) ' +
          'rotateY(' + ry + 'deg) scale(' + sc.toFixed(3) + ')';
        card.style.opacity = op.toFixed(3);
        card.style.zIndex = String(20 - absOff * 2);
        /* ⚠️ sqR 必须写非负相对位：CSS 里 [data-sq-r="-1"] 是 A 的残条样式
           （压暗 + 内阴影），B 的左邻卡若拿到 -1 会被误当成残条。 */
        card.dataset.sqR = String(r);
        card.dataset.sqOff = String(off);
        card.classList.add('is-interactive');
        card.classList.toggle('is-active', isCenter);
        card.classList.toggle('is-stretched', hoverR !== null && hoverR === r);
      }
    }

    /* ---------- C：光环转环 ----------
       移植 D:\UI_anime\21st-gallery\33-halo-reel 的核心思想：
         「cards riding an ellipse —— cos θ places each card, sizes it and
           stacks it ... one number, three properties, always in agreement.」
       落地：θ_i = phase + (i / N) * 2π，phase = -index * (2π / N) + 拖拽偏移
         x     = AX * sin θ                    位置（左右）
         scale = 0.55 + 0.45 * (cosθ + 1)/2     大小（近端 1.0，远端 0.55）
         zIndex= 100 + 100 * cos θ              层叠（与大小同向，永不打架）
         y     = AY * cos θ                     椭圆的纵向扁度（近端略下沉）
       ⇒ 翻页是**整环转动一格**，不是「主卡原地换图」，所以每张卡都有位移可看。
       ✓ 全是 transform / opacity ⇒ 只走合成层，不触发重排。 */
    function applyHalo() {
      var box = cardBox(HALO.kW);
      if (!box) { retryApply(); return; }
      var len = movies.length;
      var w = container.clientWidth || 0;
      var h = container.clientHeight || 0;
      if (!w && !h) { retryApply(); return; }
      if (!w) w = h * 2.4;
      if (!h) h = w / 2.4;

      container.style.setProperty('--sq-card-w', box.w + 'px');
      container.style.setProperty('--sq-card-h', box.h + 'px');

      var AX = w * HALO.ampX;
      var AY = h * HALO.ampY;
      var phase = -index * (Math.PI * 2 / Math.max(1, len)) + haloDrag;

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var r = ((i - index) % len + len) % len;
        var th = phase + (i / Math.max(1, len)) * Math.PI * 2;
        var c = Math.cos(th);
        var s = Math.sin(th);
        var t = (c + 1) / 2;                       // 近端 = 1，远端 = 0
        var sc = 0.55 + 0.45 * t;
        if (hoverR !== null && hoverR === r) sc *= 1.06;
        /* ★ 远端几乎全被前排挡住，与其留一堆半透明的糊影，不如直接淡到近乎不见，
             让「环」读起来是前排一条弧 —— 这也是 halo-reel 原版的观感。
             ⚠️ 下限必须 > 0.05：验证脚本用 opacity>0.05 判「这张卡算可见」。 */
        var op = 0.08 + 0.92 * Math.pow(t, 1.4);

        unstageCard(card);
        card.style.transform =
          'translate3d(calc(-50% + ' + (AX * s).toFixed(1) + 'px), ' +
          'calc(-50% + ' + (AY * c).toFixed(1) + 'px), ' +
          Math.round(-240 + 240 * t) + 'px) ' +
          'rotateY(' + (-s * HALO.rotY).toFixed(1) + 'deg) scale(' + sc.toFixed(3) + ')';
        card.style.opacity = op.toFixed(3);
        card.style.zIndex = String(Math.round(100 + 100 * c));
        card.dataset.sqR = String(r);
        card.dataset.sqOff = String(Math.round((c + 1) * 50));
        card.classList.add('is-interactive');
        card.classList.toggle('is-active', r === 0);
      }
    }

    /* 还没布局完（clientWidth/Height 为 0）时，下一帧再试一次。
       ⚠️ 少了这一步，B/C 在首帧会全部落到 24×24 的兜底尺寸，一闪而过很丑。 */
    var rafPending = false;
    function retryApply() {
      if (rafPending) return;
      rafPending = true;
      var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 32); };
      raf(function () { rafPending = false; apply(); });
    }

    // ---------- 索引推进 ----------
    function go(next, silent) {
      var len = movies.length;
      if (!len) return;
      index = ((next % len) + len) % len;
      apply();
      if (!silent && onChange) onChange(index);
    }

    function next() { go(index + 1); }
    function prev() { go(index - 1); }

    // ---------- hover 挤压 ----------
    function onEnter(e) {
      var card = e.currentTarget;
      var r = parseInt(card.dataset.sqR, 10);
      // 残条（r=-1）画在容器外，不参与 hover 挤压（compute 里也会被 hoverR>=0 挡掉）；
      // 越界位 r=9 不响应。
      if (isNaN(r) || r === 9 || r < 0) return;
      hoverR = r;
      apply();
    }
    function onLeave() {
      hoverR = null;
      apply();
    }

    function bind() {
      cards.forEach(function (card) {
        card.addEventListener('mouseenter', onEnter);
        card.addEventListener('mouseleave', onLeave);
        card.addEventListener('click', function () {
          if (suppressClickUntil > Date.now()) return;      // ★ C 版刚拖过：不吃这次点击
          var i = parseInt(card.dataset.index, 10);
          // 点残条 = 往回退一张
          if (card.dataset.sqR === '-1') { prev(); return; }
          if (card.dataset.sqR === '0') { onOpen(movies[i], i); return; }
          // 点次卡/尾巴 = 直接跳过去
          if (!isNaN(i)) { go(i); onOpen(movies[i], i); }
        });
      });
      bindDrag();
    }

    /* ---------- C：拖拽转动 ----------
       ★ 项目铁律 #3：pointerdown 后位移 > 4px 才算拖拽，否则仍按点击处理
         —— 手指/鼠标轻轻一抖就把点击吃掉是最招人烦的那类 bug。
       拖拽期间给容器加 .is-sq-dragging ⇒ CSS 关掉过渡，做到「跟手」；
       松手后按位移换算成「转过几格」，整环平滑归位。 */
    var suppressClickUntil = 0;

    function bindDrag() {
      if (motion !== 'C' || !strip) return;
      strip.addEventListener('pointerdown', onDragDown);
      global.addEventListener('pointermove', onDragMove);
      global.addEventListener('pointerup', onDragUp);
      global.addEventListener('pointercancel', onDragUp);
    }
    function unbindDrag() {
      if (!strip) return;
      strip.removeEventListener('pointerdown', onDragDown);
      global.removeEventListener('pointermove', onDragMove);
      global.removeEventListener('pointerup', onDragUp);
      global.removeEventListener('pointercancel', onDragUp);
    }
    function onDragDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      drag = { x: e.clientX, phase0: haloDrag, moved: false };
    }
    function onDragMove(e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 4) {
        drag.moved = true;
        container.classList.add('is-sq-dragging');
      }
      if (!drag.moved) return;
      var w = container.clientWidth || 900;
      /* 往右拖 ⇒ 相位变大 ⇒ 环正转 ⇒ 左边的卡转到近端（内容跟着手指走） */
      haloDrag = drag.phase0 + (dx / w) * (Math.PI * 2) / HALO.dragK;
      applyHalo();
    }
    function onDragUp() {
      if (!drag) return;
      var d = drag; drag = null;
      container.classList.remove('is-sq-dragging');
      if (!d.moved) return;
      var len = Math.max(1, movies.length);
      var step = (Math.PI * 2) / len;
      /* 相位前进 delta ⇒ 视觉上「第 index - k 张」转到了近端，所以是 index - k。
         （推导：θ_i = -index*step + haloDrag + i*step，令其 ≡0 得 i = index - haloDrag/step） */
      var k = Math.round((haloDrag - d.phase0) / step);
      haloDrag = 0;
      suppressClickUntil = Date.now() + 260;   // 拖完那一下 click 会紧跟着来，压掉
      if (k !== 0) go(index - k);
      else applyHalo();
    }

    // ---------- 自动播放 ----------
    function startAuto(ms) {
      stopAuto();
      if (reduce) return;
      timer = setInterval(function () { next(); }, ms || 5200);
    }
    function stopAuto() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    // ---------- 键盘 ----------
    function onKey(e) {
      var k = e.key;
      if (k === 'ArrowRight') { next(); e.preventDefault(); }
      else if (k === 'ArrowLeft') { prev(); e.preventDefault(); }
    }

    // ---------- 响应式重排 ----------
    var rt = null;
    function onResize() {
      if (rt) clearTimeout(rt);
      rt = setTimeout(function () { apply(); }, 120);
    }

    function destroy() {
      stopAuto();
      unbindDrag();
      container.classList.remove('is-sq-dragging');
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      // 只摘自己建的 track，箭头/圆点留给下一次 build 复用
      if (built) {
        var old = container.querySelector('.gallery-track');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        cards = [];
        strip = null;
        built = false;
      }
    }

    build();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);

    return {
      go: go,
      next: next,
      prev: prev,
      startAuto: startAuto,
      stopAuto: stopAuto,
      destroy: destroy,
      get index() { return index; },
      set index(v) { go(v, true); },
      get length() { return movies.length; },
      get motion() { return motion; },
      pauseHover: function () { hoverR = null; apply(); }
    };
  }

  /** 把某一版动效钉进 localStorage（用户挑完版以后调用，下次进应用直接生效） */
  function persistMotion(k) {
    /* ★ 必须先校验再写。原来直接走 resolveMotion(k)：传个非法值（比如旧版本号）
       会被静默解析成「当前生效的那版」再写回 localStorage —— 调用方以为切成功了，
       实际什么都没变，排查起来极难看出。 */
    var key = String(k || '').toUpperCase();
    if (!MOTIONS[key]) return null;
    try { if (global.localStorage) global.localStorage.setItem(MOTION_KEY, key); } catch (e) {}
    return key;
  }

  global.SqueezeCarousel = {
    create: create,
    SHARES: SHARES,
    EASE: EASE,
    /* round81：把比例自适应相关的参数与选择器导出 —— 几何测试脚本要能
       直接从源码读到同一份定义（不允许在测试里手抄一份，那叫假验证）。 */
    PRESETS: PRESETS,
    classify: classify,
    widthExpr: widthExpr,
    MAX_H_VH: MAX_H_VH,
    SLAT_W: SLAT_W,
    /* round81 Task#9：三版动效 */
    MOTIONS: MOTIONS,
    MOTION_KEY: MOTION_KEY,
    MOTION_DEFAULT: MOTION_DEFAULT,
    DECK: DECK,
    HALO: HALO,
    resolveMotion: resolveMotion,
    persistMotion: persistMotion
  };
})(window);