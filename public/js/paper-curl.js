/* ============================================================
   CinemaVault · paper-curl.js —— 纸张卷曲翻页
   ------------------------------------------------------------
   原生移植 PaperCurlCarousel（Raw WebGL fragment shader 版）。

   ★ 为什么分两条路径（关键设计决策）
     漫画页是 <img>，天然可以 upload 成 WebGL 纹理 → 走**真 shader 卷曲**；
     小说页是**纯文本 DOM**，无法在不引入外部光栅化库（本项目离线、
     无构建步骤、不能引 CDN 的 html2canvas）的前提下送进纹理。
     若强行光栅化：每页几千字要 drawImage 到 canvas 再 getImageData，
     在 Electron 里单帧就要几十到上百 ms，翻页直接卡死。

     所以：
       漫画 → WebGL 片元着色器（圆柱卷轴 unroll + 纸背透印 + 投影）
       小说 → 等效 DOM 卷曲（同一套圆柱几何，用 CSS 3D + clip-path 表达）

     两者对外接口完全一致，阅读器代码不需要区分。

  ★★ 时间曲线（round81 重写：弹簧 → 定时长缓动）
  ------------------------------------------------------------
  旧实现用临界阻尼弹簧 OMEGA_TURN=4.5 逼近 1，round79 验收报告里的实测数字是
  「92 帧稳定收敛到 0.9900」—— 92 帧 @60fps ≈ **1.53 秒**，而且**只到 0.99 不到 1**。
  这一个缺陷同时造成用户报的两个现象：
    ·「翻页速度有点慢了」          ← 1.53s 本身就慢
    ·「最右侧会卷起一个边形的暂留」← e 渐近爬向 1 的末段，卷轴带正停在页右缘磨蹭，
                                    直到旧的 1600ms 硬超时才把它一刀切掉，观感就是「卡一下」

  新实现三条：
    1) **定时长**：在已知时刻 T 精确到达 1，不再有渐近尾巴 ⇒ 时长可控可调
    2) **末端加速**（幂曲线，而非 easeOut）：把卷轴带甩出页外，而不是让它在右缘磨蹭
    3) **末端同步淡出**：卷层 opacity 在同一段降到 0 ⇒ 右缘绝不会留下可见卷边

  三者叠起来的效果（脚本 _r81-curl-timing.js 实测）：
    旧 ≤1600ms（被硬超时砍断，砍断瞬间 e≈0.9999 但看到的是右缘卡一下）
    → 新 560ms 精确收尾，且 e∈[0.93,1) 的「可见留卷」只占 26ms。

  ★ CORS 降级
     WebGL 纹理要求同源或 CORS 允许。本项目海报/漫画页都走本地 API，
     但 PDF 模式是 dataURL、其他场景可能拿到外链 —— 一旦 upload 失败，
     自动降级为纯图片淡入，绝不白屏。

   ★ reduced-motion
     系统开启减弱动画时不做卷曲，直接切页（功能不受影响）。
   ============================================================ */
(function (global) {
  'use strict';

  var REDUCED = global.matchMedia
    && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ★ round81：卷曲时长（ms），可被阅读器的「翻页速度」设置实时改写 */
  var DUR_MIN = 160;
  var DUR_MAX = 1600;
  var duration = 560;

  /* 三档预设 —— 旧实现实际耗时约 1530ms，所以即便「慢」档也比原来快得多 */
  var SPEEDS = { slow: 900, normal: 560, fast: 320 };

  var RADIUS = 0.13;             // 卷轴半径（相对页宽）
  var SHADE = 0.42;              // 卷曲处压暗强度

  /* ★★ 为什么结局 tense 不用 easeOut（本轮最容易踩的直觉陷阱）
     直觉上「丝滑」= easeOut（起手快、落幅柔）。但它恰恰是本次缺陷的来源：
       easeOut 在 u→1 时导数趋于 0 ⇒ 进度要花掉大把时间才爬完最后几个百分点，
       而这几个百分点正是「卷轴带停在页右缘」的可见时刻。
     （旧实现更糟：在弹簧之上又乘了一层 smoothstep，收尾导数同样是 0。）

     所以改用**幂加速** e = u^POW：
       · u=0 处导数为 0 —— 纸从静止被拈起，天然贴合手感
       · 全程单调加速 —— 像真实的纸被重力带过去
       · u=1 处导数 = POW ≠ 0 —— 卷轴带是**被甩出页外**的，不会停在右缘磨蹭
     POW=1.5 时 e∈[0.93,1) 只占全程 4.6% 时长（560ms 档 ≈ 26ms）。 */
  var POW = 1.5;
  /* 卷层从这一时刻起淡出：与「被甩出」配合，右缘绝不会留下可见的卷边 */
  var FADE_U = 0.88;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /** 卷曲进度 e = f(归一化时间 u)，u ∈ [0,1]。u≥1 时精确返回 1。 */
  function easeAt(u) {
    if (u >= 1) return 1;
    if (u <= 0) return 0;
    return Math.pow(u, POW);
  }

  /** 卷层不透明度：末端同一段降到 0，彻底消掉右缘残留的卷边 */
  function fadeAt(u) {
    if (u <= FADE_U) return 1;
    return Math.max(0, 1 - (u - FADE_U) / (1 - FADE_U));
  }

  function clampDur(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return DUR_MIN;   // 非法/非正数 → 下限，不静默沿用当前值
    return Math.max(DUR_MIN, Math.min(DUR_MAX, n));
  }

  // ==========================================================
  //  WebGL 卷曲引擎（漫画图片页）
  // ==========================================================
  /** 最近一次 WebGLRenderer 失败的原因（null = 上次成功）。
   *  暴露出去是为了让「着色器编译失败」不再静默 —— 见 WebGLRenderer 里的说明。 */
  var lastError = null;

  var VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = aPos * 0.5 + 0.5;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* 片元着色器（覆盖层模型：透明处露出下层的新页）
       uProgress  0=摊平 1=完全卷走
       uDir       +1 旧页往右卷 / -1 旧页往左卷
       uRadius    卷轴的**最大**屏幕投影宽度（相对页宽），实际宽度非线性饱和
       uShade     投影强度
     ⚠ 这一段的 GLSL 注释只能写成立块注释形式，不能用双斜杠：
       双斜杠会把外层 JS 的单引号字符串提前闭合，node --check 直接 SyntaxError
       （第一版就踩了；这里外层注释里也不能出现块注释的结束符，否则本段自己先炸）。

     ★★ 卷曲几何（改过两版才對，务必先读这段再动）
       s = 到「正在被掀起那条边」的距离：被掀起的一边 s=0，整页远端 s=1。
         uDir > 0（旧页往右卷，被掀起的边在右侧）：s = 1 - vUv.x
         uDir < 0（旧页往左卷，被掀起的边在左侧）：s = vUv.x
       p = uProgress = 已卷走的比例；卷起的纸是 s ∈ [0, p] 这段，折痕停在 s = p。

       圆柱卷轴的物理（这是关键）：
         纸绕半径 R 的圆柱自底部切点缠起，转过圆心角 θ：
           屏幕投影宽度 ds = R · (1 - cos θ)      ← 非线性，饱和于 2R
         所以 ds 关于 θ 单调饱和：θ→π 时 ds = 2R 封顶，不再增长。

       纸弧长怎么算：整段卷起的纸是 s ∈ [0, p]（共 p 页宽），它们**全部**缠在
       卷轴上 ⇒ arc(θ) = p · θ/θ_max（θ_max 为卷轴最外缘对应的圆心角）。
       折痕侧 ds ≈ Rθ²/2 ⇒ dθ/dds → ∞ ⇒ 折痕处纸被急剧压缩，
       这正是「纸被吞进卷轴」的观感。

       ⚠️ 踩过的两个坑（都是截图目检才发现，断言全绿）：
         (1) 把「0..p 整段」都当卷轴带 ⇒ 带宽 = p，线性膨胀。
             p=0.5 时白柱占半页宽，像根柱子推而不像纸卷。
             投影宽度必须走 R(1-cos θ) 并在 2R 处封顶。
         (2) 弧长写成 arc = R·θ（只按圆柱周长）⇒ 上限 R·π ≈ 0.20 页宽，
             挤进 13% 宽的带里仅 1.6 倍压缩，看起来完全没卷。
             必须让弧长覆盖整段卷起的纸（压缩比 = p/B）。          */
  var FRAG = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uFront;',
    'uniform sampler2D uBack;',
    'uniform float uProgress;',
    'uniform float uDir;',
    'uniform float uRadius;',   // 卷轴最大屏幕投影宽（= 2R）
    'uniform float uShade;',    // 投影强度
    'uniform vec3  uPaperBack;',

    'void main() {',
    '  float p = clamp(uProgress, 0.0, 1.0);',
    '  float s = (uDir > 0.0) ? (1.0 - vUv.x) : vUv.x;',
    '  float R = uRadius * 0.5;',
    /* 卷轴带的屏幕宽度：非线性饱和，θ_max = min(π, p/R) */
    '  float thMax = min(p / max(R, 1e-4), 3.14159265);',
    '  float B = R * (1.0 - cos(thMax));',
    /* 卷轴带**折痕内侧**留一道窄投影（纸离开平面时落在下面的阴影），其余交给圆柱代码
       ⚠️⚠️ 本轮踩了三个连续的坑，全都是「分支区间写错」这一个根因：
       ① 原条件 `s < p`：覆盖**整条卷轴带** s ∈ [p-B, p]，
          把下面圆柱反解 / 弧长压缩 / 圆柱受光 / 纸背**全变成死代码**，一次没跑过。
       ② 改成外缘窄条 `s < (p-B) + sw`：区间没错，但与 paperBack 生效段
          （s ∈ [p-B, p-0.0725]，宽 5.47%）几乎完全重叠 ⇒ uPaperBack 永远采不到，
          实测两种纸背读数一字不差（36 / 36）。
       ③ 改成 `s > p - sw`（想表达「离折痕 sw 以内」）：**方向写反了**，
          覆盖的是 (p-sw, 1.0] —— 整个平摊段全被它吃掉并 return。
          而式子里 (p - s) 在 s > p 时为负，除以正数 sw 后 >1，pow 直接溢出 ⇒ 纯黑。
          症状：p=0.05（几乎没有卷轴带）时整页全黑；p=0.70 时 x>p 区域全黑。
          这也是为什么「常量 UV」「highp」两个变体都救不了 —— 问题不在采样，在区间。

       正确判据：折痕在 s = p，纸往 s 减小方向卷走 ⇒ 折痕内侧就是 s < p 的那一小段。
       用 `s < p - (B - sw)` 精确取「卷轴带最靠近折痕的 sw 宽度」，
       此时 0 ≤ (p-s) ≤ sw，pow 的底数恰为 1→0，既不溢出也与圆柱段无缝衔接。 */
    '  if (s < p - B) { discard; }',
    '  float sw = max(B * 0.28, 1e-4);',
    /* ⚠️ 两个条件缺一不可：
          下界 s < p      —— 排除平摊段（s ≥ p 属于「还没卷走」，不能上阴影）
          上界 s > p - sw —— 只取折痕内侧 sw 宽度
       少写下界 ⇒ 平摊段整片被吃掉，且 (p-s) 为负 ⇒ pow 溢出 ⇒ 纯黑。
       少写上界 ⇒ 整条卷轴带被吃掉（就是 ① 那个 bug）。 */
    '  if (s < p && s > p - sw) {',
    '    gl_FragColor = vec4(0.0, 0.0, 0.0, pow(1.0 - (p - s) / sw, 1.8) * uShade);',
    '    return;',
    '  }',
    /* ★ 平摊段必须**独立成一支**（源就是它自己：src = s）。
         ⚠️ 踩过的坑：漏了这个分支，让 s > p 继续往下走卷轴反解 ——
            此时 ds = p - s 为负 ⇒ th = acos(1) = 0 ⇒ src 恒等于 p，
            整块平摊区被采样成**同一列**的颜色 ⇒ 表现为「单列拉伸的色块 /
            水平拖影」，横向密线与竖条色卡全部消失。
            实机截图（漫画页上是一道道水平条、lab 里是一整块纯色）才看出来。 */
    '  if (s >= p) {',
    '    gl_FragColor = texture2D(uFront, vec2((uDir > 0.0) ? (1.0 - s) : s, vUv.y));',
    '    return;',
    '  }',
    /* 卷轴带：反解圆柱 —— 屏幕偏移 ds ⇒ 圆心角 θ ⇒ 纸弧长 ⇒ 旧页源 s */
    '  float ds = p - s;',                            // 0 = 折痕
    /* ⚠️ thMax 已在外层算过（决定带宽 B）；这里要的是「卷轴最外缘对应的圆心角」，
        两者在 p 较小时并不相等 —— 同名会触发 GLSL redefinition 编译失败，
        而 WebGLRenderer 把它吞成 return null，只表现为「WebGL 不可用」。 */
    '  float thEdge = max(acos(clamp(1.0 - B / max(R, 1e-4), -1.0, 1.0)), 1e-4);',
    '  float th = acos(clamp(1.0 - ds / max(R, 1e-4), -1.0, 1.0));',
    /* ★ 弧长必须覆盖**整段卷起的纸**（s ∈ [0,p]，共 p 页宽）：
         折痕处 src=p（纸还平着的那头），卷轴最外缘 src=0（纸的自由边）。
         这才是纸张卷曲的拓扑 —— 整段卷起的纸全缠在卷轴上。
       ⚠️ 踩过的坑：写成 arc = R * th（纯粹按圆柱周长算），
          上限只有 R·π ≈ 0.20 页宽，挤进 13% 宽的带里仅 1.6 倍压缩 ——
          看起来跟没卷一样，色卡疏密几乎不变。
          改成 arc = p · (th/thEdge) 后压缩比 = p/B（p=0.5 时约 3.8 倍），
          且折痕处 dθ/dds → ∞，自然呈现「纸被吞进卷轴」的密集化。 */
    '  float arc = p * (th / thEdge);',
    '  float src = clamp(p - arc, 0.0, 1.0);',        // 旧页上的源 s（恒 ≤ p）
    '  float t = th / thEdge;',                       // 0=折痕 1=卷轴最外缘
    '  vec2 fuv = vec2((uDir > 0.0) ? (1.0 - src) : src, vUv.y);',
    '  vec4 col = texture2D(uFront, clamp(fuv, 0.0, 1.0));',
    /* 圆柱受光（横向）：折痕侧最暗 → 过顶点最亮 → 卷轴外缘转暗。
       ⚠️ 立体感的关键是**折痕侧要真的压下去**：之前用 mix(1.0, lit, uShade)
          且 lit 下限 0.58，几何台目检下来卷轴带跟旁边平摊段亮度几乎一样，
          「圆柱」完全看不出来（几何是对的但视觉不成立）。
          现在 lit 直接乘、并把下限压到 0.34，折痕侧明确出现暗带。 */
    '  float y = abs(vUv.y - 0.5) * 2.0;',
    '  float body = 1.0 - 0.26 * y * y;',
    '  float lit = 0.34 + 0.66 * sin(th);',
    '  col.rgb *= body * lit;',
    /* 纸背：转过顶点后纸翻了面，透出纸背 + 反向透印 */
    '  vec2 buv = vec2((uDir > 0.0) ? (1.0 - src) : src, 1.0 - vUv.y);',
    '  vec3 back = texture2D(uBack, clamp(buv, 0.0, 1.0)).rgb;',
    '  col.rgb = mix(col.rgb, mix(back, uPaperBack, 0.5), smoothstep(0.55, 0.98, t));',
    '  gl_FragColor = vec4(col.rgb, 1.0);',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('shader: ' + log);
    }
    return s;
  }

  function makeShader(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function makeTexture(gl, img) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    return t;
  }

  /**
   * WebGL 卷曲渲染器：在 canvas 上播放卷曲。
   * ⚠️ 必须开 alpha: true —— 卷走的那部分是 discard，要让**下层的新页**露出来。
   *    开 alpha:false 会把透明区填成不透明黑，整页糊死。
   */
  function WebGLRenderer(canvas) {
    var gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: false })
        || canvas.getContext('experimental-webgl', { alpha: true });
    } catch (e) { gl = null; }
    if (!gl) { lastError = 'no-webgl-context'; return null; }

    var prog;
    try { prog = makeShader(gl, VERT, FRAG); }
    // ⚠️ 编译/链接失败必须留下痕迹。原来直接 return null，
    //    而 attachImage 拿不到就静默降级 —— 结果是「GLSL 写错 ⇒ 卷曲整段失效、
    //    页面只表现为『没有动效』」，排查时完全看不出是着色器挂了。
    //    实测踩过：thMax 重定义导致整章白改。
    catch (e) { lastError = String(e && e.message || e); return null; }
    lastError = null;

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    var uFront = gl.getUniformLocation(prog, 'uFront');
    var uBack = gl.getUniformLocation(prog, 'uBack');
    var uProgress = gl.getUniformLocation(prog, 'uProgress');
    var uDir = gl.getUniformLocation(prog, 'uDir');
    var uRadius = gl.getUniformLocation(prog, 'uRadius');
    var uShade = gl.getUniformLocation(prog, 'uShade');
    var uPaperBack = gl.getUniformLocation(prog, 'uPaperBack');

    gl.useProgram(prog);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var texFront = null, texBack = null;

    return {
      ok: true,
      /** 上传正/背两张图；任一失败返回 false（调用方降级） */
      setImages: function (frontImg, backImg) {
        try {
          if (texFront) gl.deleteTexture(texFront);
          if (texBack) gl.deleteTexture(texBack);
          texFront = makeTexture(gl, frontImg);
          texBack = backImg ? makeTexture(gl, backImg) : texFront;
          return true;
        } catch (e) {
          // CORS / 解码失败 —— 交由调用方降级
          return false;
        }
      },
      resize: function (w, h) {
        canvas.width = Math.max(1, Math.round(w));
        canvas.height = Math.max(1, Math.round(h));
        gl.viewport(0, 0, canvas.width, canvas.height);
      },
      draw: function (progress, dir, paperBack) {
        // ⚠️ 必须清成**全透明**：discard 之外的区域要靠清屏色保持透明，
        //    才能透出下层的新页。填不透明色 = 新页永远看不见。
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFront);
        gl.uniform1i(uFront, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texBack);
        gl.uniform1i(uBack, 1);
        gl.uniform1f(uProgress, clamp01(progress));
        gl.uniform1f(uDir, dir);
        gl.uniform1f(uRadius, RADIUS);
        gl.uniform1f(uShade, SHADE);
        gl.uniform3f(uPaperBack, paperBack[0], paperBack[1], paperBack[2]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      /** 读回中心像素（测试用：确认真的画出了东西而不是全透明） */
      sampleCenter: function () {
        var px = new Uint8Array(4);
        try {
          gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1,
            gl.RGBA, gl.UNSIGNED_BYTE, px);
        } catch (e) { return null; }
        return [px[0], px[1], px[2], px[3]];
      },
      hasImage: function () { return !!texFront; },
      destroy: function () {
        try {
          if (texFront) gl.deleteTexture(texFront);
          if (texBack) gl.deleteTexture(texBack);
          gl.deleteBuffer(buf);
          gl.deleteProgram(prog);
        } catch (e) { /* 忽略 */ }
      }
    };
  }

  // ==========================================================
  //  对外：图片页（WebGL）卷曲
  // ==========================================================
  /** 纹理源是否就绪。
   *  ⚠️ 必须同时接受 <img> 与 <canvas>（离屏合成图）：
   *     canvas 没有 complete / naturalWidth，只看 img 的属性会把
   *     「双页合成快照」这条路径误判成不可用，静默退化成硬切。 */
  function isTextureReady(src) {
    if (!src) return false;
    if (src.tagName === 'CANVAS') return src.width > 0 && src.height > 0;
    return src.complete === true && src.naturalWidth > 0;
  }

  /**
   * 把「旧页」用真 WebGL 卷走，露出下层的新页。
   *
   * @param {Object} o
   *   canvas    覆盖层 canvas（绝对定位铺在旧页之上，与旧页同尺寸）
   *   oldImg    旧页纹理源（HTMLImageElement 或已绘制的离屏 canvas）
   *   dir       +1 往右卷 / -1 往左卷
   *   applySwap 卷曲过半时调用 —— 调用方在此把新页换上旧页那个 <img>
   *   done      收尾（复位 canvas）
   * @returns {Object|null} null = 不可用（无 WebGL / 纹理未就绪 / 上传失败）
   */
  function attachImage(o) {
    if (REDUCED || !o || !o.canvas || !isTextureReady(o.oldImg)) return null;

    var r = WebGLRenderer(o.canvas);
    if (!r || !r.ok) return null;
    // 纹理上传失败（CORS / 尺寸超限 / 未解码）→ 降级，绝不白屏
    if (!r.setImages(o.oldImg, o.oldImg)) { r.destroy(); return null; }

    // 画布位图尺寸 = CSS 尺寸 × DPR，否则高分屏下卷曲出来是糊的。
    // ⚠️ 必须在调用方把 canvas 摆到正确位置、样式生效之后再调（靠 getBoundingClientRect 逼回流）。
    var cr = o.canvas.getBoundingClientRect();
    var dpr = o.dpr || (global.devicePixelRatio || 1);
    if (cr.width > 0 && cr.height > 0) r.resize(cr.width * dpr, cr.height * dpr);

    var raf = 0;
    var finished = false;

    function cleanup() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (finished) return;
      finished = true;
      o.canvas.style.display = 'none';
      r.destroy();
      // ⚠️ 也要走 done —— 用户在卷曲途中又点了一页时，
      //    loadPage() 正 await 这个 promise；不调用它就会永远挂起，
      //    后续所有翻页全部失灵。
      if (typeof o.done === 'function') o.done();
    }

    function play() {
      var dir = (o.dir || 1) >= 0 ? 1 : -1;
      // 纸背色：夜间模式给深色，其余给浅米色（避免卷起处出现死白）
      var back = o.paperBack || [0.94, 0.91, 0.85];
      /* ★ round81：不再用 performance.now() 做增量积分。
         起始时刻写死一次，之后每帧只看「已过时长 / 总时长」 ⇒
         掉帧 / 切标签页回来都不会让进度爆炸或倒退，最坏情况是立即收尾。 */
      var t0 = performance.now();
      var T = clampDur((o && o.duration) || duration);
      var swapped = false;

      /* 卷轴带 progress →  canvas 也要跟着淡出，否则最后几帧
         「已经卷完但还没 hide」的那一点点残留就停在右缘（用户所见的现象） */
      o.canvas.style.opacity = '1';

      function frame(now) {
        var u = (now - t0) / T;
        var e = easeAt(u);

        r.draw(e, dir, back);
        o.canvas.style.opacity = String(fadeAt(u));

        // 过半换页：此时旧页已被卷走大半，切换不可见
        if (!swapped && e > 0.5) {
          swapped = true;
          if (typeof o.applySwap === 'function') o.applySwap();
        }

        if (u >= 1) {
          // u≥1 时 easeAt 精确返回 1 ⇒ 最后一帧就是「完全卷走」，不再有爬行段
          if (!swapped && typeof o.applySwap === 'function') o.applySwap();
          cleanup();      // done 由 cleanup 统一触发（保证 cancel 路径也会调）
          return;
        }
        raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
    }

    return {
      play: play,
      cancel: cleanup,
      renderer: r
    };
  }

  // ==========================================================
  //  对外：文本页（DOM）卷曲
  // ==========================================================
  //  圆柱卷曲的 DOM 表达：
  //    stage 内叠两层 —— 底层 = 下一页（静止，作为被揭开的纸），
  //    上层 = 当前页（被卷走）。上层卷起后自然露出底层，
  //    观感就是「一张纸卷起来、露出下一张」。
  //  用 transform 而非切竖带：切带会破坏文本排版与行内图片。
  function DomCurl(stage) {
    var raf = 0;
    var upper = null, lower = null;

    function ensureLayers() {
      if (stage.__curlUpper && stage.__curlLower && stage.__curlUpper.parentNode === stage) {
        // ⚠️ 必须把闭包变量同步过来 —— 下面用的是同名局部变量声明，
        //    若不同步，play() 里的 upper/lower 会一直是 null。
        upper = stage.__curlUpper;
        lower = stage.__curlLower;
        return true;
      }
      // ⚠️ 懒建的前提是有子节点可搬。.paged-inner 里是 <h1> + #pagedText，
      //    若此刻 DOM 还没填内容就会建出空层 —— 那比不建更糟（翻页看到空白）。
      if (!stage.firstElementChild) return false;

      // 把原有内容整体挪进 lower
      var lo = document.createElement('div');
      lo.className = 'curl-layer curl-lower';
      while (stage.firstChild) lo.appendChild(stage.firstChild);

      // upper 是当前页的克隆：只取视觉，不参与交互
      var up = document.createElement('div');
      up.className = 'curl-layer curl-upper';
      up.setAttribute('aria-hidden', 'true');

      stage.appendChild(up);
      stage.appendChild(lo);
      stage.__curlUpper = up;
      stage.__curlLower = lo;
      stage.style.position = stage.style.position || 'relative';
      // 打开 3D 上下文（透视 + preserve-3d），否则 rotateY 只是平面旋转
      stage.classList.add('curl-armed');
      upper = up;
      lower = lo;
      return true;
    }

    /** 同步 upper 为当前页的视觉快照
     *  ⚠️ 必须剥掉 id —— 原节点是 #pagedTitle / #pagedText，
     *    innerHTML 复制会造出**同名 id 的副本**，而快照层是 display:none 的。
     *    之后 document.getElementById('pagedText') 就会命中副本（高度恒为 0），
     *    pageHeight() 读到 0 → 分页全错（实测：正文溢出到按钮下方被遮）。
     *    这个坑隐蔽且致命，改这段前务必先读 round79 验收报告。 */
    function syncUpper() {
      if (!ensureLayers()) return false;
      upper.innerHTML = lower.innerHTML;
      // 剥掉 id 与表单/事件属性，避免副本污染全局选择器
      upper.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
      upper.querySelectorAll('img').forEach(function (im) { im.removeAttribute('loading'); });
      // 上层只是视觉快照，屏蔽一切交互与朗读（否则 TTS 会把两页都念出来）
      upper.setAttribute('aria-hidden', 'true');
      upper.style.pointerEvents = 'none';
      return true;
    }

    /**
     * 播放卷曲
     * @param {number} d 方向 +1 / -1
     * @param {Function} applyNext 在动画进行到「卷走一半」时调用，替换底层内容
     * @param {Function} done 结束回调
     */
    function play(d, applyNext, done) {
      if (REDUCED || !ensureLayers()) {
        if (typeof applyNext === 'function') applyNext();
        if (typeof done === 'function') done();
        return;
      }
      upper = stage.__curlUpper;
      lower = stage.__curlLower;
      syncUpper();

      // lower 保持自己的内容不动（它的 id 是「真」节点：#pagedTitle / #pagedText）。
      // ⚠️ 绝不能写 lower.innerHTML = upper.innerHTML —— upper 的副本已被剥掉 id，
      //    倒灌回去会让真节点失去 id，pageHeight()/fillPage() 全线崩。
      upper.classList.add('is-curling');

      var dir = d >= 0 ? 1 : -1;
      /* ★ round81：与 WebGL 路径同一套定时长曲线（见文件头注释） */
      var t0 = performance.now();
      var T = clampDur(duration);
      var swapped = false;

      function frame(now) {
        var u = (now - t0) / T;
        var e = easeAt(u);
        var fade = fadeAt(u);

        // 卷起页：位移 + Y 轴旋转 + 横向压扁（圆柱投影）+ 压暗
        var shift = e * 72 * dir;
        var rot = -dir * e * 58;
        var squeeze = Math.max(0.04, 1 - e * 0.94);
        upper.style.transform =
          'translate3d(' + shift.toFixed(2) + '%, 0, 0) ' +
          'rotateY(' + rot.toFixed(2) + 'deg) ' +
          'scaleX(' + squeeze.toFixed(3) + ')';
        upper.style.filter = 'brightness(' + (1 - e * 0.55).toFixed(3) + ')';
        /* ★ 末端同步淡出：上层这时只剩页右缘一条卷边，
             不如让它退干净，而不是留在那儿等清理 */
        upper.style.opacity = String((1 - e * 0.5) * fade);

        // 卷过一半时换底层内容（此时上层已卷走大半，切换不可见）
        if (!swapped && e > 0.5) {
          swapped = true;
          if (typeof applyNext === 'function') applyNext();
        }

        if (u >= 1) {
          upper.classList.remove('is-curling');
          upper.style.transform = '';
          upper.style.filter = '';
          upper.style.opacity = '';
          if (!swapped && typeof applyNext === 'function') applyNext();
          if (typeof done === 'function') done();
          return;
        }
        raf = requestAnimationFrame(frame);
      }
      raf = requestAnimationFrame(frame);
    }

    function cancel() { if (raf) cancelAnimationFrame(raf); raf = 0; }

    return { play: play, cancel: cancel, syncUpper: syncUpper };
  }

  // ==========================================================
  //  统一入口（给小说等纯文本阅读器用）
  // ==========================================================
  /**
   * @param {Object} o
   *   stage   容器（其内容会被搬进 curl-lower）
   *   applyNext 换页逻辑（由调用方实现；卷曲过半时触发）
   *   isActive 当前是否处于翻页模式（滚动模式不介入）
   */
  function attachText(o) {
    var curl = DomCurl(o.stage);
    // 构造即建层（而不是等第一次翻页）：让 3D 上下文与层级在进翻页模式时就位，
    // 也让「建层失败」（DOM 还没内容）能被立刻发现，而不是静默退化成硬切。
    curl.syncUpper();
    return {
      reduced: REDUCED,
      turn: function (dir) {
        if (typeof o.isActive === 'function' && !o.isActive()) {
          return o.applyNext(dir);          // 非翻页模式 → 原样换页
        }
        return new Promise(function (resolve) {
          curl.play(dir, function () { o.applyNext(dir); }, resolve);
        });
      },
      destroy: function () { curl.cancel(); }
    };
  }

  global.PaperCurl = {
    DomCurl: DomCurl,
    WebGLRenderer: WebGLRenderer,
    attachText: attachText,
    attachImage: attachImage,
    isTextureReady: isTextureReady,
    REDUCED: REDUCED,

    /* ---- round81：翻页速度（阅读器设置面板直接调这两个） ---- */
    SPEEDS: SPEEDS,
    /** 设置卷曲时长（ms）。返回实际生效值（会被夹到 160~1600） */
    setDuration: function (ms) { duration = clampDur(ms); return duration; },
    /** 设置速度档位名（'slow'|'normal'|'fast'）或裸毫秒数 */
    setSpeed: function (name) {
      if (typeof name === 'number') { duration = clampDur(name); return duration; }
      var ms = SPEEDS[String(name)] ;
      if (!ms) { duration = SPEEDS.normal; return duration; }
      duration = clampDur(ms);
      return duration;
    },
    getDuration: function () { return duration; },

    /* 曲线导出：给验证脚本做断言用（例如「u=1 时必须精确返回 1」） */
    easeAt: easeAt,
    fadeAt: fadeAt,
    clampDur: clampDur,

    /** 最近一次 WebGL 初始化失败原因（排查用；null = 正常） */
    lastError: function () { return lastError; }
  };
})(window);