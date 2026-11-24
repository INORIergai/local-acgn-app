/* ============================================================
   round115 · 精选推荐折叠条（P11）
   ------------------------------------------------------------
   在 comic / novel / movies 三个视图把 #gallerySection 折成 56px 一条。
   round118 起把「影片库」也纳入：它是同一个组件、同一种占位问题
   （实测 638px 轮播把卡片网格推到折线下面）。
   不删 DOM、不删功能 —— 点「展开 ›」就还原成原来的轮播。

   为什么用 MutationObserver 而不是给 switchView 打补丁：
   视图标记是由 view-loader.js 异步写进 body[data-view] 的，
   包 switchView 会漏掉 hash 恢复、返回上级等路径。
   ============================================================ */
(function () {
    'use strict';

    var FOLD_VIEWS = { comic: 1, novel: 1, movies: 1 };
    var sec = null;
    var btn = null;

    function ensureBtn() {
        if (btn && document.body.contains(btn)) return btn;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gv-fold-btn';
        btn.setAttribute('data-gv-fold', '');
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            e.preventDefault();
            if (!sec) return;
            var open = sec.classList.toggle('is-open');
            syncBtn();
            try {
                if (open) {
                    if (typeof window.startGalleryAutoPlay === 'function') window.startGalleryAutoPlay();
                } else {
                    if (typeof window.stopGalleryAutoPlay === 'function') window.stopGalleryAutoPlay();
                }
            } catch (err) { /* 轮播模块不在也不影响折叠 */ }
        });
        return btn;
    }

    function syncBtn() {
        if (!btn || !sec) return;
        var open = sec.classList.contains('is-open');
        btn.textContent = open ? '收起' : '展开 ›';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.setAttribute('title', open ? '收起精选推荐' : '展开精选推荐');
    }

    function apply() {
        sec = document.getElementById('gallerySection');
        if (!sec) return;
        var view = (document.body && document.body.dataset && document.body.dataset.view) || '';

        if (!FOLD_VIEWS[view]) {
            sec.classList.remove('is-folded');
            if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
            return;
        }

        sec.classList.add('is-folded');
        var b = ensureBtn();
        var title = sec.querySelector('.gallery-title');
        if (title && b.parentNode !== title) title.appendChild(b);
        syncBtn();

        /* 折起来时停表，别让看不见的轮播继续烧 CPU（30+ 处 hideGallery 也是这个道理） */
        if (!sec.classList.contains('is-open') && typeof window.stopGalleryAutoPlay === 'function') {
            try { window.stopGalleryAutoPlay(); } catch (e) { }
        }
    }

    function boot() {
        apply();
        try {
            new MutationObserver(apply).observe(document.body, {
                attributes: true,
                attributeFilter: ['data-view']
            });
        } catch (e) { }
        /* 画廊内容是异步灌进来的，兜底补几拍 */
        [200, 600, 1200, 2500, 4000].forEach(function (ms) { setTimeout(apply, ms); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    window.GVFold = { apply: apply };
})();
