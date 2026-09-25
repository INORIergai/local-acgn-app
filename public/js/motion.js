/* ==========================================================================
   全站动效引擎 v1 —— 滚动入场 / 视图过渡 / 数字滚动
   --------------------------------------------------------------------------
   不引入任何库：IntersectionObserver + MutationObserver + rAF，
   这三个就是"已有优秀案例"（Stripe / Linear / vineyard 同款）的底层原语。
   工作方式：
     1) 监听内容容器（#movieGrid #actressGrid #tagList .av-board .av-slider）
        的子节点变化 → 新节点加 .mv-reveal 并进 IO 观察
     2) IO 命中 → 加 .mv-visible（CSS 接管 0.8s 慢入场），随后 unobserve
     3) 视图切换 → 给主容器打一拍 .view-in
     4) 侧栏统计数字 → 文本变化时做一次 0.6s count-up
   回滚：删除本文件 + library.html 的 <script> 一行。
   ========================================================================== */
(function () {
    'use strict';

    var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------- 滚动入场 ---------- */

    var io = null;
    if (!REDUCED && 'IntersectionObserver' in window) {
        io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (!en.isIntersecting) return;
                en.target.classList.add('mv-visible');
                io.unobserve(en.target);
            });
        }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    }

    // 新节点注册：加 reveal 类 + 错峰 delay + 观察
    // ⚠️ 一次最多注册 40 个：整页几百张卡同时进观察队列+挂 transition，
    // 会让首次渲染卡住好几秒。剩下的交给 MutationObserver 的后续批次。
    var REGISTER_CAP = 40;
    function register(nodes) {
        if (!io) return;
        var i = 0;
        nodes.forEach(function (el) {
            if (!el || el.nodeType !== 1) return;
            if (el.dataset.mvDone) return;
            el.dataset.mvDone = '1';
            // 错峰：同一批最多 4 级，每级 45ms（长列表不会拖到 1 秒开外）
            el.style.setProperty('--mv-delay', Math.min(i, 4) * 45 + 'ms');
            el.classList.add('mv-reveal');
            io.observe(el);
            i++;
        });
    }

    // 分片注册：每帧最多 40 个，避免长列表一次性挂载 transition
    var pendingNodes = [];
    var drainScheduled = false;
    function drainQueue() {
        drainScheduled = false;
        var batch = pendingNodes.splice(0, REGISTER_CAP);
        if (batch.length) register(batch);
        if (pendingNodes.length) scheduleDrain();
    }
    function scheduleDrain() {
        if (drainScheduled) return;
        drainScheduled = true;
        if (window.requestIdleCallback) {
            requestIdleCallback(drainQueue, { timeout: 200 });
        } else {
            requestAnimationFrame(drainQueue);
        }
    }

    // .av-card/.av-folder 自带 avPop 入场动画，不重复挂 reveal
    var WATCH_SEL = '.movie-card, .actress-card, .tag-item, .folder-card, .stat-card';

    var gridObserver = new MutationObserver(function (muts) {
        var fresh = [];
        muts.forEach(function (m) {
            m.addedNodes.forEach(function (n) {
                if (n.nodeType !== 1) return;
                if (n.matches && n.matches(WATCH_SEL)) fresh.push(n);
                else if (n.querySelectorAll) {
                    var inner = n.querySelectorAll(WATCH_SEL);
                    inner.forEach(function (x) { fresh.push(x); });
                }
            });
        });
        if (fresh.length) {
            pendingNodes = pendingNodes.concat(fresh);
            scheduleDrain();
        }
    });

    function watchContent() {
        var root = document.querySelector('.content');
        if (!root) return;
        // 首屏已有内容也要入场（同样分片，只取前 40）
        pendingNodes = pendingNodes.concat(
            Array.prototype.slice.call(root.querySelectorAll(WATCH_SEL)).slice(0, 40)
        );
        scheduleDrain();
        gridObserver.observe(root, { childList: true, subtree: true });
    }

    /* ---------- 视图切换过渡：toolbar 标题变化时给内容区一拍上浮 ---------- */

    var lastTitle = '';
    var titleObserver = new MutationObserver(function () {
        var t = document.getElementById('toolbarTitle');
        var grid = document.getElementById('movieGrid');
        if (!t || !grid) return;
        var text = t.textContent || '';
        if (text === lastTitle) return;
        lastTitle = text;
        if (REDUCED) return;
        t.classList.remove('title-swap');
        grid.classList.remove('view-in');
        void grid.offsetWidth;
        t.classList.add('title-swap');
        grid.classList.add('view-in');
    });

    /* ---------- 数字滚动：侧栏统计 ----------
       ⚠️ 踩坑记录（2026-09-22，代价：整站点击后鼠标卡死）
       countUp 每帧写 el.textContent，而 statObserver 正在观察这个节点的 childList，
       于是「观察者 → countUp 改文本 → 触发观察者 → 又起一个 countUp」形成正反馈：
       实测 5 秒内 requestAnimationFrame 被调用 130 万次，主线程被 rAF 回调淹死，
       表现就是"鼠标基本不能动、点什么都没反应"。两处修复：
         1) 滚动的每一帧都加 busy 标记，观察者看到 busy 直接 return；
         2) 收尾时把最终值定格并延迟一拍才清 busy，避免自己最后一帧又触发自己。 */
    var busy = {};

    function countUp(el) {
        if (REDUCED || !el) return;
        var key = el.id || 'anon';
        if (busy[key]) return;                       // 同一个元素同时只允许一个滚动
        var raw = (el.textContent || '').trim();
        var m = raw.match(/^([\d,]+(?:\.\d+)?)(.*)$/);
        if (!m) return;
        var target = parseFloat(m[1].replace(/,/g, ''));
        if (!isFinite(target) || target < 2) return; // 小数字没必要滚
        var suffix = m[2] || '';

        // 目标值没变（比如只是重新渲染）就不重播动画
        if (el.dataset.mvCounted === m[1] + suffix) return;
        el.dataset.mvCounted = m[1] + suffix;

        busy[key] = true;
        var t0 = null;
        var DUR = 650;
        function step(ts) {
            if (!t0) t0 = ts;
            var p = Math.min(1, (ts - t0) / DUR);
            var eased = 1 - Math.pow(1 - p, 3);      // ease-out cubic
            var val = target * eased;
            el.textContent = (target % 1 ? val.toFixed(1) : Math.round(val)) + suffix;
            if (p < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = m[1] + suffix;       // 定格到目标值（保留原千分位写法）
                setTimeout(function () { busy[key] = false; }, 0);
            }
        }
        requestAnimationFrame(step);
    }

    var statObserver = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
            if (m.type === 'characterData' || m.type === 'childList') {
                var el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
                if (!el || !el.classList || !el.classList.contains('num')) return;
                if (busy[el.id || 'anon']) return;    // 自己写的字，不要再触发自己
                countUp(el);
            }
        });
    });

    function watchStats() {
        ['statTotal', 'statSize', 'statWatched', 'statPlays'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) statObserver.observe(el, { characterData: true, childList: true, subtree: true });
        });
    }

    /* ---------- 启动 ---------- */

    function init() {
        watchContent();
        var toolbar = document.getElementById('toolbarTitle');
        if (toolbar) titleObserver.observe(toolbar, { characterData: true, childList: true, subtree: true });
        watchStats();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
