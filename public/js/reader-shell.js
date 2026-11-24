/* ============================================================================
   reader-shell.js —— 阅读器交互外壳（漫画 / 小说共用）
   ----------------------------------------------------------------------------
   对标 Mihon / Yomikiru 的桌面阅读手势：
     · 三段点击区：左 25% 上一页 / 中间 50% 显隐工具栏 / 右 25% 下一页
       （RT L 模式下左右自动互换）
     · 滚轮：普通滚动 = 翻页（280ms 节流）；Ctrl/⌘ + 滚轮交给页面自己的缩放
     · 键盘补充：PageUp/PageDown/Home/End（←→/空格/Esc 仍由各页面原有逻辑处理）
     · 沉浸：工具栏/底栏可整体隐藏；鼠标移到顶/底边缘或点中间重新唤出
     · 首次进入显示 1.8s 的分区提示（每个阅读器只提示一次）
   不做双击翻页：双击与单击翻页会互相误触，宁可少一个手势也不破坏手感。
   ========================================================================== */
(function () {
    'use strict';

    var S = {
        attached: false,
        opts: null,
        wheelAt: 0,
        wheelAcc: 0,
        hideTimer: null,
        hintShown: false,
        moveAt: 0
    };

    function $(sel) {
        return typeof sel === 'string' ? document.querySelector(sel) : sel;
    }

    function isTyping(e) {
        var t = e.target;
        if (!t) return false;
        var tag = (t.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
    }

    function ignored(el, opts) {
        if (!el || !el.closest) return false;
        if (opts.ignore && el.closest(opts.ignore)) return true;
        // 所有按钮/链接/抽屉/面板一律不参与翻页
        return !!el.closest('button, a, input, select, textarea, [role="dialog"], .rs-drawer, .settings-panel, .thumbnail-sidebar, .catalog-sidebar, .toolbar, .progress-bar');
    }

    function chromeHidden() {
        return document.body.classList.contains('chrome-hidden');
    }

    function setChrome(hidden) {
        document.body.classList.toggle('chrome-hidden', !!hidden);
        if (S.hideTimer) { clearTimeout(S.hideTimer); S.hideTimer = null; }
        if (!hidden && S.opts && S.opts.autoHide !== false) {
            S.hideTimer = setTimeout(function () { setChrome(true); }, S.opts.autoHideMs || 4200);
        }
    }

    function toggleChrome() {
        setChrome(!chromeHidden());
    }

    function rtl() {
        return !!(S.opts && typeof S.opts.isRtl === 'function' && S.opts.isRtl());
    }

    function goPrev() {
        if (S.opts && typeof S.opts.onPrev === 'function') S.opts.onPrev();
        if (S.opts && S.opts.onTurn) S.opts.onTurn(-1);
    }
    function goNext() {
        if (S.opts && typeof S.opts.onNext === 'function') S.opts.onNext();
        if (S.opts && S.opts.onTurn) S.opts.onTurn(1);
    }

    function tapZone(x, w) {
        var r = x / Math.max(1, w);
        var zones = (S.opts && S.opts.tapZones) || 'thirds';
        if (zones === 'off') return 'none';
        if (zones === 'sides') return r < 0.5 ? 'left' : 'right';
        if (r < 0.25) return 'left';
        if (r > 0.75) return 'right';
        return 'center';
    }

    function onClick(e) {
        if (!S.attached) return;
        var opts = S.opts || {};
        if (ignored(e.target, opts)) return;
        var area = $(opts.area || '#readerArea');
        if (!area) return;
        if (document.body.classList.contains('pan-active')) return;
        if (opts.suppressClick && opts.suppressClick()) return;

        var rect = area.getBoundingClientRect();
        var zone = tapZone(e.clientX - rect.left, rect.width);
        if (zone === 'none') return;   // 设置里关掉了点击翻页：交给页面/滚动容器自己处理

        if (zone === 'center') {
            /* 页面提供 onCenter 时由页面全权控制（它自己会同步 body.chrome-hidden），
               这里绝不能再切一次 —— 两个状态源互相抵消会表现为“点中间没反应”。 */
            if (typeof opts.onCenter === 'function') opts.onCenter();
            else toggleChrome();
            return;
        }
        // RTL：左区 = 下一页
        var leftIsPrev = !rtl();
        if (zone === 'left') {
            if (leftIsPrev) goPrev(); else goNext();
        } else {
            if (leftIsPrev) goNext(); else goPrev();
        }
    }

    function onWheel(e) {
        if (!S.attached) return;
        var opts = S.opts || {};
        if (opts.enableWheel === false) return;
        if (opts.scrollMode && opts.scrollMode()) return;      // 长条/滚动模式交还浏览器
        if (e.ctrlKey || e.metaKey) return;                     // 缩放交给页面原 handler
        if (ignored(e.target, opts)) return;

        var now = Date.now();
        S.wheelAcc += (e.deltaY || 0);
        if (Math.abs(S.wheelAcc) < 24) return;                  // 触控板轻扫不误翻
        if (now - S.wheelAt < (opts.wheelThrottle || 280)) { S.wheelAcc = 0; return; }
        S.wheelAt = now;
        var down = S.wheelAcc > 0;
        if (opts.wheelInvert) down = !down;
        S.wheelAcc = 0;
        if (e.cancelable) e.preventDefault();
        if (down) goNext(); else goPrev();
    }

    function onKey(e) {
        if (!S.attached || isTyping(e)) return;
        var opts = S.opts || {};
        switch (e.key) {
            case 'PageDown':
                e.preventDefault(); goNext(); break;
            case 'PageUp':
                e.preventDefault(); goPrev(); break;
            case 'Home':
                if (typeof opts.onFirst === 'function') { e.preventDefault(); opts.onFirst(); }
                break;
            case 'End':
                if (typeof opts.onLast === 'function') { e.preventDefault(); opts.onLast(); }
                break;
            case 'F11':
                if (typeof opts.onFullscreen === 'function') { e.preventDefault(); opts.onFullscreen(); }
                break;
            default: break;
        }
    }

    function onMove(e) {
        if (!S.attached) return;
        var now = Date.now();
        if (now - S.moveAt < 120) return;
        S.moveAt = now;
        // 鼠标移到顶部/底部 80px 内自动唤出工具栏（桌面阅读器惯例）
        if (e.clientY < 80 || e.clientY > window.innerHeight - 80) {
            if (chromeHidden()) setChrome(false);
        }
    }

    function showHint() {
        var key = S.opts && S.opts.hintKey;
        try { if (key && localStorage.getItem(key) === '1') return; } catch (e) { /* ignore */ }
        if (document.getElementById('rsTapHint')) return;
        var d = document.createElement('div');
        d.id = 'rsTapHint';
        d.className = 'rs-tap-hint';
        d.innerHTML = '<span>上一页</span><span>工具栏</span><span>下一页</span>';
        document.body.appendChild(d);
        requestAnimationFrame(function () { d.classList.add('show'); });
        setTimeout(function () {
            d.classList.remove('show');
            setTimeout(function () { try { d.remove(); } catch (e) { } }, 400);
        }, 1800);
        try { if (key) localStorage.setItem(key, '1'); } catch (e) { /* ignore */ }
    }

    var RS = {
        attach: function (opts) {
            if (S.attached) RS.detach();
            S.opts = opts || {};
            S.attached = true;
            var area = $(S.opts.area || '#readerArea');
            (area || document).addEventListener('click', onClick);
            (area || document).addEventListener('wheel', onWheel, { passive: false });
            document.addEventListener('keydown', onKey);
            document.addEventListener('mousemove', onMove, { passive: true });
            // 默认 4.2s 后自动收起 chrome（可用 autoHide:false 关掉）
            setChrome(false);
            if (S.opts.showHint !== false) setTimeout(showHint, 500);
            return RS;
        },
        detach: function () {
            S.attached = false;
            if (S.hideTimer) { clearTimeout(S.hideTimer); S.hideTimer = null; }
        },
        /** 设置面板改点击区/滚轮方向时热更新，不重绑事件 */
        updateOptions: function (patch) {
            if (!S.opts) return RS;
            if (patch && typeof patch === 'object') {
                Object.keys(patch).forEach(function (k) { S.opts[k] = patch[k]; });
            }
            return RS;
        },
        showChrome: function () { setChrome(false); },
        hideChrome: function () { setChrome(true); },
        toggleChrome: toggleChrome,
        isChromeHidden: chromeHidden,
        showHint: showHint
    };

    window.ReaderShell = RS;
})();