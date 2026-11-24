/* ============================================================
   round113-P5 · 页头收放开关
   ------------------------------------------------------------
   唯一职责：滚动时给 <html> 挂/摘 .hdr-compact，样式在 round113-p5.css。

   ★为什么不按 scrollY 判断：
     .toolbar 是 position:sticky（top:var(--nav-h)），它**吸住以后 rect.top 恒等于 --nav-h**，
     再往下滚也不会变小。所以不能用「top < 阈值」当滚动深度，只能直接判「是否已吸住」：
       rect.top <= navH + 0.5  ⇒ 已经贴在 navbar 下面 ⇒ 收起
     这也正好是 iOS 大标题的语义（吸住那一刻才收），比自定义阈值更准。

   ★为什么用捕获阶段接 scroll 而不是 scrollY：
     本项目的主滚动面是 document，但内层也有滚动容器（.modal-content / 阅读器 / 侧栏）。
     滚动事件不冒泡，却会经过捕获阶段；挂 document 的捕获监听能一次覆盖所有容器，
     以后换滚动容器也不用改这里。

   ★滞回：贴住是硬夹紧，边界上会因亚像素在 navH±0.4 之间跳，所以进入用 +0.5、
     退出用 +3，避免临界点反复触发 class 抖动（一抖就是一次重排）。

   ★★round143 防振荡熔断（用户 m01872：「拉到最下面，左上角设置一直闪、变大变小」）：
     仅靠 3px 滞回挡不住「收缩本身改变页面高度」这一类自反馈：
       页面滚到底 → 收起让工具条矮 40px → scrollHeight 变短 → 浏览器把 scrollY 向上 clamp
       → 工具条 rect.top 瞬间增大 40px（远超滞回）→ 判定离开吸顶 → 展开 → 又够长 → 再收起 …
     实测会以每帧一次的频率无限翻转（Layout Thrashing）。
     设置页已在 round113-p5.css 里改成恒定高度（根本解法）；这里再补一层通用熔断：
     若 800ms 内翻转达到 6 次，判定进入振荡，锁死当前状态并暂停判定，
     直到用户真正滚动（scrollY 变化 > 24px）或触发 resize 才解锁重新测量。
     这样即使未来某个新视图再犯同样的错，也只是「停在某个高度」，不会闪。
   ============================================================ */
(function () {
    'use strict';

    var MIN_W = 861;      // 与 round113-p5.css 的断点一致
    var HOLD_ON = 0.5;
    var HOLD_OFF = 3;
    /* 振荡检测窗口与阈值：窗口内翻转次数超限即熔断 */
    var FLIP_WINDOW = 800;
    var FLIP_LIMIT = 6;
    var UNLOCK_SCROLL = 24;

    var root = document.documentElement;
    var compact = false;
    var ticking = false;

    var flips = [];        // 最近翻转时间戳
    var frozen = false;    // 熔断中
    var frozenY = 0;       // 熔断时的 scrollY，用于判断「用户真的滚了」

    function navH() {
        var n = parseFloat(getComputedStyle(root).getPropertyValue('--nav-h'));
        return isNaN(n) ? 60 : n;
    }

    function bar() {
        return document.querySelector('.content > .toolbar');
    }

    function set(next) {
        if (next === compact) return;
        compact = next;
        root.classList.toggle('hdr-compact', compact);

        /* 记录翻转并做振荡检测 */
        var now = Date.now();
        flips.push(now);
        while (flips.length && now - flips[0] > FLIP_WINDOW) flips.shift();
        if (!frozen && flips.length >= FLIP_LIMIT) {
            frozen = true;
            frozenY = window.scrollY || window.pageYOffset || 0;
        }
    }

    /* 熔断解锁条件：用户真的滚动了（不是被 clamp 弹回来的那种微小变化） */
    function maybeUnfreeze() {
        if (!frozen) return;
        var y = window.scrollY || window.pageYOffset || 0;
        if (Math.abs(y - frozenY) > UNLOCK_SCROLL) {
            frozen = false;
            flips.length = 0;
        }
    }

    function measure() {
        ticking = false;
        maybeUnfreeze();
        if (frozen) return;          // 熔断中：不再判定，保持当前高度不动
        var tb = bar();
        if (!tb) { set(false); return; }
        if (window.innerWidth < MIN_W) { set(false); return; }
        var r = tb.getBoundingClientRect();
        if (r.height < 4) { set(false); return; }   // 视图隐藏（首页/ACG）时 rect 全 0，别误判成「已吸住」
        set(r.top <= navH() + (compact ? HOLD_OFF : HOLD_ON));
    }

    function kick() {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(measure);
    }

    document.addEventListener('scroll', kick, true);
    window.addEventListener('scroll', kick, { passive: true });
    /* resize 是用户主动改变布局，熔断状态一并复位（窗口尺寸变了，旧的振荡前提不再成立） */
    window.addEventListener('resize', function () {
        frozen = false;
        flips.length = 0;
        kick();
    }, { passive: true });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kick);
    else kick();

    /* round143：把内部状态暴露出来，便于自动化验证「拉到最底部时标题不再抖动」 */
    window.CVHeader = {
        refresh: kick,
        isCompact: function () { return compact; },
        isFrozen: function () { return frozen; },
        flipCount: function () { return flips.length; },
        reset: function () { frozen = false; flips.length = 0; kick(); }
    };
})();
