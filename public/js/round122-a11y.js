/* ============================================================
   round122 · 卡片键盘可达性
   ------------------------------------------------------------
   问题：`.movie-card`（影片库 / 首页 / 本周放送都用它）是 div，
   既没有 tabindex 也没有 role，**Tab 永远到不了**；而 av-board 渲染的
   小说/漫画卡有 tabindex="0" —— 同一个东西两套待遇。

   做法：用一个注入器补齐，不改 app.js 里那段巨大的模板字符串。
     · 补 tabindex="0" / role="button" / aria-label
     · Enter / Space 触发 click（复用现有点击逻辑，不自己实现打开）
     · 详情关闭后把焦点**还给来源卡片**（键盘用户关掉详情后不会掉到 body）
   ============================================================ */
(function () {
    'use strict';

    var lastCard = null;

    function labelOf(card) {
        var t = card.getAttribute('title') || '';
        if (!t) {
            var img = card.querySelector('img[alt]');
            t = img ? img.getAttribute('alt') : '';
        }
        if (!t) {
            var h = card.querySelector('.movie-hover-title, .movie-title-below, .av-title');
            t = h ? (h.textContent || '').trim() : '';
        }
        return (t || '影片').slice(0, 80);
    }

    function enhance(card) {
        if (card.getAttribute('data-kbd') === '1') return;
        card.setAttribute('data-kbd', '1');
        if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '0');
        if (!card.hasAttribute('role')) card.setAttribute('role', 'button');
        if (!card.hasAttribute('aria-label')) card.setAttribute('aria-label', labelOf(card));
        card.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                /* ★ 空格默认会滚动页面；卡片自己处理掉 */
                e.preventDefault();
                e.stopPropagation();
                card.click();
            }
        });
        /* 记住最近一次被聚焦/点击的卡，用于关闭详情后归还焦点 */
        card.addEventListener('focus', function () { lastCard = card; }, true);
        card.addEventListener('pointerdown', function () { lastCard = card; }, true);
    }

    function scan() {
        document.querySelectorAll('.movie-card:not([data-kbd])').forEach(enhance);
    }

    /* 详情关闭 → 焦点回到来源卡 */
    function watchDetail() {
        var modal = document.getElementById('detailModal');
        if (!modal || modal.getAttribute('data-kbd-observed') === '1') return;
        modal.setAttribute('data-kbd-observed', '1');
        var wasOpen = modal.classList.contains('show');
        new MutationObserver(function () {
            var open = modal.classList.contains('show');
            if (wasOpen && !open) {
                /* 关掉了：把焦点还给刚才那张卡（它可能已被重渲染，所以按 data-id 找回来） */
                var id = lastCard && lastCard.getAttribute('data-id');
                var target = id ? document.querySelector('.movie-card[data-id="' + id + '"]') : null;
                target = target || lastCard;
                if (target && document.body.contains(target)) {
                    setTimeout(function () { try { target.focus({ preventScroll: true }); } catch (e) { } }, 60);
                }
            }
            wasOpen = open;
        }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    }

    function boot() {
        scan();
        watchDetail();
        var grid = document.getElementById('movieGrid');
        if (grid) {
            var t = null;
            new MutationObserver(function () {
                if (t) clearTimeout(t);
                t = setTimeout(scan, 50);
            }).observe(grid, { childList: true, subtree: true });
        }
        /* 视图切换后卡片是新一批，也补一遍 */
        document.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('.nav-item, [data-view]')) {
                setTimeout(scan, 500);
            }
        }, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
