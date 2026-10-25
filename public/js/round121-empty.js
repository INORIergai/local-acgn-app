/* ============================================================
   round121 · 空状态注入器
   ------------------------------------------------------------
   谁需要它：搜索 / 筛选没有结果时，`#movieGrid` 会被清空，但什么提示都没有。

   它怎么判断「空了」：
     · 只看**结果类**元素（.movie-card / .av-card / .av-folder / .av-stack-top /
       .av-view / .gallery-section）——精选推荐、工具栏这些不算结果；
     · 一个都没有 ⇒ 空。
   为什么不用 `:empty`：渲染函数常留下空壳 div，`:empty` 判不出来，
   而且 CSS 放不下「清除搜索」这个按钮。

   触发：MutationObserver 盯 #movieGrid（孩子变了就重判）+ 搜索框 input 兜底。
   ============================================================ */
(function () {
    'use strict';

    var RESULT_SEL = '.movie-card, .av-card, .av-folder, .av-stack-top, .av-stack, .av-view, .gallery-section';
    var grid = null;
    var box = null;
    var lastKey = '';

    var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="10.5" cy="10.5" r="6.5"></circle>' +
        '<path d="M15.4 15.4 21 21"></path>' +
        '<path d="M8 10.5h5"></path>' +
        '</svg>';

    function query() {
        var el = document.getElementById('searchInput');
        return el ? String(el.value || '').trim() : '';
    }

    function build(q) {
        var d = document.createElement('div');
        d.className = 'cv-empty';
        d.setAttribute('data-cv-empty', '');
        d.innerHTML =
            '<div class="cv-empty-icon">' + ICON + '</div>' +
            '<div class="cv-empty-title">没有找到' +
                (q ? '「<b>' + esc(q.slice(0, 24)) + '</b>」' : '匹配的内容') + '</div>' +
            '<div class="cv-empty-sub">' +
                (q
                    ? '关键词可能太长或写错了。试试更短的一段、换个说法，或清空搜索看全部。'
                    : '当前的筛选条件把结果都排除了。放宽一个条件试试。') +
            '</div>' +
            '<div class="cv-empty-actions">' +
                (q ? '<button type="button" class="cv-empty-btn is-primary" data-cv-clear>清除搜索</button>' : '') +
                '<button type="button" class="cv-empty-btn" data-cv-reset>重置筛选</button>' +
            '</div>';
        return d;
    }

    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
        });
    }

    function clearSearch() {
        var el = document.getElementById('searchInput');
        if (!el) return;
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
    }

    function resetFilters() {
        var all = document.querySelector('[data-av-filter="all"]');
        if (all) { all.click(); return; }
        clearSearch();
    }

    /* 是否有生效中的筛选芯片（"全部"不算） */
    function hasFilter() {
        var on = document.querySelectorAll('[data-av-filter].on, [data-av-filter].active');
        for (var i = 0; i < on.length; i++) {
            var v = on[i].getAttribute('data-av-filter');
            if (v && v !== 'all') return true;
        }
        return false;
    }

    /* 应用自带的全局空提示（#emptyTip「暂无影片，点击右上角开始扫描」）。
       ★ 它说的是"库是空的"，而搜不到东西时说这句是**错的建议** ——
         两条同时出现等于自相矛盾，所以这里有我没它。 */
    function legacyTip() { return document.getElementById('emptyTip'); }

    /* 分页条：搜索到 0 条时它仍然显示"共 6446 部 / 129 页"（上一轮全量列表的残留），
       和标题的"共 0 部"直接打架。空状态在的时候一起收起来。 */
    function pager() { return document.getElementById('pagination'); }

    /* ★ 只还原"我自己隐藏过"的元素。
       第一版是「有结果就把 display 设回 ''」——这等于**覆盖应用自己的 display:none**：
       #emptyTip 在小说库本该隐藏，被我强行显示出来，它那枚 46px 的 🎬 就成了
       字号统计里凭空多出的一档（r120 立刻报红）。别人的状态不要碰。 */
    var iHidLegacy = false, iHidPager = false;

    function hideLegacy() {
        var lt = legacyTip();
        if (lt && lt.style.display !== 'none') { lt.style.display = 'none'; iHidLegacy = true; }
        var pg = pager();
        if (pg && pg.style.display !== 'none') { pg.style.display = 'none'; iHidPager = true; }
    }
    function restoreLegacy() {
        if (iHidLegacy) { var lt = legacyTip(); if (lt) lt.style.display = ''; iHidLegacy = false; }
        if (iHidPager) { var pg = pager(); if (pg) pg.style.display = ''; iHidPager = false; }
    }

    function evaluate() {
        if (!grid || !document.body.contains(grid)) {
            grid = document.getElementById('movieGrid');
            if (!grid) return;
        }
        var hasResult = !!grid.querySelector(RESULT_SEL);
        var q = query();
        var filtering = !!q || hasFilter();

        /* 有结果；或者根本没有搜索/筛选行为（库真的空 ⇒ 交给 #emptyTip）⇒ 不显示 */
        if (hasResult || !filtering) {
            if (box && box.parentNode) box.parentNode.removeChild(box);
            box = null; lastKey = '';
            restoreLegacy();
            return;
        }

        var key = q + '|' + location.hash;
        if (box && box.parentNode && key === lastKey) return;   // 已经是对的，别重建（会打断动画）

        if (box && box.parentNode) box.parentNode.removeChild(box);
        box = build(q);
        lastKey = key;
        grid.appendChild(box);
        hideLegacy();

        box.querySelector('[data-cv-clear]') && box.querySelector('[data-cv-clear]')
            .addEventListener('click', clearSearch);
        box.querySelector('[data-cv-reset]') && box.querySelector('[data-cv-reset]')
            .addEventListener('click', resetFilters);
    }

    function boot() {
        grid = document.getElementById('movieGrid');
        if (!grid) return;

        var t = null;
        new MutationObserver(function () {
            if (t) clearTimeout(t);
            t = setTimeout(evaluate, 60);
        }).observe(grid, { childList: true, subtree: false });

        var input = document.getElementById('searchInput');
        if (input) {
            input.addEventListener('input', function () {
                if (t) clearTimeout(t);
                t = setTimeout(evaluate, 260);
            });
        }
        /* 视图切换后 #movieGrid 会被整体重写，观察器盯的是同一个节点，
           但结果类型变了 ⇒ 也重判一次 */
        document.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('.nav-item, [data-view]')) {
                if (t) clearTimeout(t);
                t = setTimeout(evaluate, 400);
            }
        }, true);

        evaluate();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
