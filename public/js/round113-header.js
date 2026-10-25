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
   ============================================================ */
(function () {
    'use strict';

    var MIN_W = 861;      // 与 round113-p5.css 的断点一致
    var HOLD_ON = 0.5;
    var HOLD_OFF = 3;

    var root = document.documentElement;
    var compact = false;
    var ticking = false;

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
    }

    function measure() {
        ticking = false;
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
    window.addEventListener('resize', kick, { passive: true });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kick);
    else kick();

    window.CVHeader = { refresh: kick, isCompact: function () { return compact; } };
})();
