/* ==========================================================================
   mobile-gestures.js —— 手机端手势层（第 21 轮）
   --------------------------------------------------------------------------
   只做一件事：**详情弹窗下滑关闭**（用户要的「可选增强 B」）。
   桌面端（>860px）完全不参与 —— 鼠标怎么拖都不会触发这里任何逻辑。

   为什么单开一个文件而不是写进 app.js：
     app.js 已 ~8k 行，本功能与业务逻辑无关，独立文件好回滚
     （删掉 library.html 里的一行 <script> 即可，其它文件一个字没动）。

   项目铁律遵守情况：
     · 不用 pointerdown + setPointerCapture（实测会吞掉静止点击），
       改用原生 touch 事件；只有「纵向位移 > 8px 且内容已滚到顶」才进入拖拽态，
       纯点击 / 横向滑动一律不拦截，原生滚动照常。
     · 关闭复用 app.js 已有的 window.closeModal()，不另起一套关闭逻辑。
     · 只在手机断点生效，桌面端零改动。

   手感参数（实测调过）：
     位移 > 96px 松手即关；快速甩动（>0.65px/ms 且位移 >28px）也算关。
     位移不够就弹回原位。遮罩随拖拽距离变淡，给出「正在关闭」的连续反馈。

   ⚠️ 踩过的坑（别再犯）：第一版为了「重开弹窗时清掉残留内联样式」上了
   MutationObserver 监听 #detailModal 的 class，回调里又去改它的 class，
   构成正反馈死循环 —— 一旦打开详情，渲染主线程就被吃满，
   连 page.evaluate(() => 1+1) 都超时。详见下方 onStart 前的注释。
   ========================================================================== */
(function () {
    'use strict';

    var MOBILE = '(max-width: 860px)';
    var THRESHOLD = 96;   // 松手时位移超过它 → 关闭
    var FLING = 0.65;     // px/ms，甩一下的判定速度
    var FLING_MIN = 28;   // 甩动至少要拖出这么远，避免误触
    var LOCK = 8;         // 方向锁：位移超过它才判定横 / 竖

    function isMobile() {
        return !!(window.matchMedia && window.matchMedia(MOBILE).matches);
    }

    function init() {
        var modal = document.getElementById('detailModal');
        if (!modal || modal.getAttribute('data-swipe') === '1') return;
        var panel = modal.querySelector('.modal-content.detail-modal') ||
                    modal.querySelector('.modal-content');
        var scroller = document.getElementById('detailBody');
        if (!panel) return;
        modal.setAttribute('data-swipe', '1');

        var phase = 'idle';       // idle | pending | drag
        var sx = 0, sy = 0, dy = 0, lastY = 0, lastT = 0, vy = 0, raf = 0;

        /* ---------- 绘制 ---------- */
        function paint() {
            raf = 0;
            panel.style.transform = 'translateY(' + dy.toFixed(1) + 'px)';
            // 拖得越远遮罩越淡：给「松手就关」的连续反馈
            var p = Math.min(1, dy / (THRESHOLD * 1.6));
            modal.style.background = 'rgba(8,6,4,' + (0.7 * (1 - p * 0.75)).toFixed(3) + ')';
        }
        function schedule() { if (!raf) raf = requestAnimationFrame(paint); }

        /* 清掉所有内联样式，回到 CSS 类控制的正常状态 */
        function clearInline() {
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            panel.style.transition = '';
            panel.style.transform = '';
            panel.style.opacity = '';
            modal.style.background = '';
            modal.classList.remove('swipe-dragging');
        }

        function atTop() { return !scroller || scroller.scrollTop <= 0; }

        /* ---------- touchstart ---------- */
        function onStart(e) {
            if (!isMobile() || e.touches.length !== 1) { phase = 'idle'; return; }
            // 详情之上还压着别的弹窗（更换海报 / 播放列表 / 播放器…）→ 不做手势
            var shown = document.querySelectorAll('.modal.show');
            for (var i = 0; i < shown.length; i++) {
                if (shown[i] !== modal) { phase = 'idle'; return; }
            }
            // 兜底：上一次手势可能留下内联样式（正常路径已在 dismiss 里清干净），
            // 趁还没开始拖，先复位，免得把残留位移带进这次手势。
            if (phase === 'idle' && panel.style.transform) clearInline();
            var t = e.touches[0];
            sx = t.clientX; sy = t.clientY;
            lastY = t.clientY; lastT = Date.now();
            vy = 0; dy = 0;
            phase = 'pending';
        }

        /* ---------- touchmove ---------- */
        function onMove(e) {
            if (phase === 'idle' || !isMobile()) return;
            var t = e.touches[0];
            if (!t) return;
            var dx = t.clientX - sx;
            var dyy = t.clientY - sy;

            if (phase === 'pending') {
                // 先横后竖：横向为主 → 让给站点的横滑组件，本手势退出
                if (Math.abs(dx) >= LOCK && Math.abs(dx) > Math.abs(dyy)) { phase = 'idle'; return; }
                if (Math.abs(dyy) < LOCK) return;                 // 位移太小，还没定向
                if (dyy <= 0 || !atTop()) { phase = 'idle'; return; } // 上滑 / 内容没滚到顶 → 交给原生滚动
                phase = 'drag';
                modal.classList.add('swipe-dragging');
                panel.style.transition = 'none';
            }

            // 进入拖拽态后才拦截，保证正常滚动不被影响
            if (e.cancelable) e.preventDefault();

            var now = Date.now();
            var dt = now - lastT;
            if (dt > 0) vy = (t.clientY - lastY) / dt;
            lastY = t.clientY; lastT = now;
            dy = Math.max(0, dyy);
            schedule();
        }

        /* ---------- touchend ---------- */
        function onEnd() {
            if (phase !== 'drag') { phase = 'idle'; return; }
            phase = 'idle';
            if (dy > THRESHOLD || (vy > FLING && dy > FLING_MIN)) dismiss();
            else springBack();
        }

        function dismiss() {
            panel.style.transition = 'transform .19s ease-in, opacity .19s ease-in';
            panel.style.transform = 'translateY(100%)';
            panel.style.opacity = '0';
            modal.style.background = 'rgba(8,6,4,0)';
            modal.classList.remove('swipe-dragging');
            setTimeout(function () {
                if (typeof window.closeModal === 'function') window.closeModal();
                // 面板已经滑出屏幕了，这里立刻把 .show 摘掉（display:none），
                // 然后才清内联样式 —— 顺序反了的话会闪回原位一帧。
                modal.classList.remove('show');
                clearInline();
            }, 190);
        }

        function springBack() {
            panel.style.transition = 'transform .26s cubic-bezier(.22,.61,.36,1)';
            panel.style.transform = 'translateY(0px)';
            modal.style.background = '';
            var settled = false;
            var done = function () {
                if (settled) return;
                settled = true;
                panel.removeEventListener('transitionend', done);
                clearInline();
            };
            panel.addEventListener('transitionend', done);
            setTimeout(done, 420);   // 兜底：transitionend 偶尔不触发
        }

        panel.addEventListener('touchstart', onStart, { passive: true });
        panel.addEventListener('touchmove', onMove, { passive: false });
        panel.addEventListener('touchend', onEnd, { passive: true });
        panel.addEventListener('touchcancel', onEnd, { passive: true });

        /* ★ 这里刻意「不」用 MutationObserver 监听 #detailModal 的 class。
         *
         * 第一版就是那么写的（想在弹窗重新打开时清掉上一次手势的内联样式），
         * 结果：observer 回调 → clearInline() → modal.classList.remove(...)
         * → 又触发 class 变更 → 回调……构成正反馈，渲染主线程被一个死循环吃掉。
         * 实测连 `page.evaluate(() => 1+1)` 都超时 6 秒、整页卡死；
         * 把本文件请求 aborted 掉就一切正常，才定位到是它。
         *
         * 现在改成确定性清理：dismiss() / springBack() 两条出口都自己收尾，
         * 不依赖任何「打开时再擦屁股」的机制。
         */

        // 视口从窄变宽（旋转屏 / 桌面调试）时兜底复位
        if (window.matchMedia) {
            try {
                window.matchMedia(MOBILE).addEventListener('change', function (ev) {
                    if (!ev.matches && phase === 'idle') clearInline();
                });
            } catch (err) { /* 老内核没有 addEventListener，忽略 */ }
        }

        initPlayerGestures();
    }

    /* ---------- 播放器移动端手势（双击左右快进/退 + 顶部下滑关闭） ---------- */
    function initPlayerGestures() {
        var playerModal = document.getElementById('playerModal');
        var video = document.getElementById('videoPlayer');
        if (!playerModal || !video) return;

        var lastTapTime = 0;
        var touchStartX = 0;
        var touchStartY = 0;

        // 创建反馈 HUD 提示框
        var hud = document.getElementById('playerGestureHud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'playerGestureHud';
            hud.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(0.9);' +
                'background:rgba(0,0,0,0.78);color:#fff;padding:12px 22px;border-radius:24px;font-size:15px;' +
                'font-weight:bold;pointer-events:none;opacity:0;transition:opacity var(--mv2-d1, .18s) var(--mv2-snap, ease),transform var(--mv2-d1, .18s) var(--mv2-snap, ease);z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);';
            (playerModal.querySelector('.modal-content') || playerModal).appendChild(hud);
        }

        var hudTimer = null;
        function showHud(text) {
            hud.textContent = text;
            hud.style.opacity = '1';
            hud.style.transform = 'translate(-50%,-50%) scale(1)';
            clearTimeout(hudTimer);
            hudTimer = setTimeout(function () {
                hud.style.opacity = '0';
                hud.style.transform = 'translate(-50%,-50%) scale(0.9)';
            }, 600);
        }

        video.addEventListener('touchstart', function (e) {
            if (!isMobile() || e.touches.length !== 1) return;
            var t = e.touches[0];
            touchStartX = t.clientX;
            touchStartY = t.clientY;
        }, { passive: true });

        video.addEventListener('touchend', function (e) {
            if (!isMobile() || e.changedTouches.length !== 1) return;
            var t = e.changedTouches[0];
            var dx = Math.abs(t.clientX - touchStartX);
            var dy = Math.abs(t.clientY - touchStartY);
            if (dx > 16 || dy > 16) return;

            var now = Date.now();
            if (now - lastTapTime < 320) {
                var rect = video.getBoundingClientRect();
                var p = (t.clientX - rect.left) / rect.width;
                if (p < 0.38) {
                    video.currentTime = Math.max(0, video.currentTime - 10);
                    showHud('⏪ 快退 10 秒');
                } else if (p > 0.62) {
                    video.currentTime = Math.min((video.duration || 999999), video.currentTime + 10);
                    showHud('⏩ 快进 10 秒');
                } else {
                    if (video.paused) {
                        video.play();
                        showHud('▶ 继续播放');
                    } else {
                        video.pause();
                        showHud('⏸ 已暂停');
                    }
                }
                lastTapTime = 0;
            } else {
                lastTapTime = now;
            }
        }, { passive: true });

        // 播放器顶部向下滑动退出
        var playerHeader = playerModal.querySelector('.player-top') || playerModal.querySelector('.modal-header');
        if (playerHeader) {
            var pStartY = 0;
            playerHeader.addEventListener('touchstart', function (e) {
                if (e.touches.length === 1) pStartY = e.touches[0].clientY;
            }, { passive: true });
            playerHeader.addEventListener('touchend', function (e) {
                if (e.changedTouches.length === 1) {
                    var pDy = e.changedTouches[0].clientY - pStartY;
                    if (pDy > 70) {
                        var closeBtn = document.getElementById('closePlayer');
                        if (closeBtn) closeBtn.click();
                    }
                }
            }, { passive: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
