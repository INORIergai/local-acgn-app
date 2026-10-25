/* ============================================================
   round123 · 网格方向键 + 详情 focus trap
   ------------------------------------------------------------
   round122 让卡片能 Tab 到了，但留下两件事：
     1. 走一遍 45 张卡要按 45 次 Tab —— 网格该用方向键；
     2. 详情打开时 Tab 仍能跑到背后页面的控件上（视觉被遮罩挡住，
        焦点却跑出去了，键盘用户会"看不见自己在哪"）。

   方向键怎么找邻居：**按几何找，不按 DOM 顺序猜**。
     · DOM 顺序在"摞卡/夹层"等结构下与视觉顺序不一致；
     · 几何法直接看卡片中心的相对位置，列数变了也不用改代码。
     具体：往右 = 中心 x 更大、且竖直方向有重叠 → 取 x 最小的那个。

   回滚 = 删 library.html 里本文件那一行 script。
   ============================================================ */
(function () {
    'use strict';

    var CARD = '.movie-card, .av-card';
    var KEYS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
    var EDGE = { Home: 1, End: 1 };

    function visibleCards() {
        var out = [];
        document.querySelectorAll(CARD).forEach(function (el) {
            var r = el.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) out.push({ el: el, r: r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
        });
        return out;
    }

    /* 找方向上最近的邻居。overlap 用"卡片尺寸的一半"作容差 ——
       比固定像素稳：卡片尺寸随断点变，写死 20px 在大屏上就选不中同排。 */
    function neighbor(list, cur, dir) {
        var best = null, bestScore = Infinity;
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            if (c.el === cur.el) continue;
            var d1 = c.cx - cur.cx, d2 = c.cy - cur.cy;
            var tolX = cur.r.width * 0.5, tolY = cur.r.height * 0.5;
            var ok = false, primary = 0, secondary = 0;
            if (dir === 'right' && d1 > 1 && Math.abs(d2) < tolY) { ok = true; primary = d1; secondary = Math.abs(d2); }
            if (dir === 'left' && d1 < -1 && Math.abs(d2) < tolY) { ok = true; primary = -d1; secondary = Math.abs(d2); }
            if (dir === 'down' && d2 > 1 && Math.abs(d1) < tolX) { ok = true; primary = d2; secondary = Math.abs(d1); }
            if (dir === 'up' && d2 < -1 && Math.abs(d1) < tolX) { ok = true; primary = -d2; secondary = Math.abs(d1); }
            if (!ok) continue;
            /* 先比主轴距离，再比偏移 —— 保证"同排最近的"胜出 */
            var score = primary * 1000 + secondary;
            if (score < bestScore) { bestScore = score; best = c; }
        }
        return best && best.el;
    }

    /* ---------- 1. 方向键在网格里移动焦点 ---------- */
    document.addEventListener('keydown', function (e) {
        if (!KEYS[e.key]) return;
        var cur = document.activeElement;
        if (!cur || !cur.matches || !cur.matches(CARD)) return;
        /* 在输入框/下拉里按方向键不该被拦（有些卡内可能嵌了 input） */
        if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
        var list = visibleCards();
        if (list.length < 2) return;
        var me = list.filter(function (x) { return x.el === cur; })[0];
        if (!me) return;

        var dir = e.key.toLowerCase().replace('arrow', '');
        var next = neighbor(list, me, dir);
        if (!next) return;                 // 到边了：不拦，让既有快捷键（翻页）接手

        /* ★★ 这里必须 stopPropagation，否则焦点会被"弹掉"：
           app.js 在 **window** 上有一个全局方向键翻页（ArrowLeft/Right → goToPage），
           它不检查 defaultPrevented。我 focus 到邻居卡之后，它紧接着翻页、整页重渲染，
           卡片 DOM 被换掉 ⇒ 焦点落到 body。表现为"按 → 焦点消失"。
           document 的监听先于 window，所以在这一层掐断就够了。 */
        e.preventDefault();
        e.stopPropagation();
        next.focus();
        try { next.scrollIntoView({ block: 'nearest' }); } catch (err) { }
    });

    /* ---------- 1b. Home / End 跳到第一张 / 最后一张 ---------- */
    document.addEventListener('keydown', function (e) {
        if (!EDGE[e.key]) return;
        var cur = document.activeElement;
        if (!cur || !cur.matches || !cur.matches(CARD)) return;
        if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
        var list = visibleCards();
        if (!list.length) return;
        var target = e.key === 'Home' ? list[0] : list[list.length - 1];
        e.preventDefault();
        e.stopPropagation();
        target.el.focus();
        try { target.el.scrollIntoView({ block: 'nearest' }); } catch (err) { }
    });

    /* ---------- 2. 详情打开时把 Tab 圈在面板里 ----------
       注意两个边界：
         · 焦点跑到面板外（比如刚打开时停在 body）→ 第一次 Tab 要送回面板内；
         · 面板里有些按钮是 display:none（.dbtn.is-extra）→ 用 offsetParent 过滤掉。 */
    function focusables(root) {
        return [].filter.call(
            root.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
            function (el) {
                if (el.disabled) return false;
                if (el.hasAttribute('hidden')) return false;
                if (el.getAttribute('aria-hidden') === 'true') return false;
                return el.offsetParent !== null || el === document.activeElement;
            }
        );
    }

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') return;
        var modal = document.getElementById('detailModal');
        if (!modal || !modal.classList.contains('show')) return;
        var f = focusables(modal);
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        var active = document.activeElement;
        var inside = modal.contains(active);

        if (!inside) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
            return;
        }
        if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }, true);
})();
