/* ============================================================
   移动端导航 · mobile-nav.js
   ------------------------------------------------------------
   职责（只在 ≤860px 生效，桌面端完全不介入）：
   1. 汉堡按钮 / 遮罩 / Esc / 右滑 控制侧边抽屉
   2. 从导航栏把「风格切换 + 开始扫描」搬进抽屉（离开移动端时原样搬回）
   3. 底部标签栏：点击切视图 + 当前视图高亮同步
   4. 抽屉打开时锁定背景滚动
   ============================================================ */
(function () {
    'use strict';

    var MQ = window.matchMedia('(max-width: 860px)');

    var drawerBtn = document.getElementById('mDrawerBtn');
    var sidebar = document.getElementById('mainSidebar');
    var mask = document.getElementById('mNavMask');
    var tabbar = document.getElementById('mTabbar');
    var moreBtn = document.getElementById('mTabMore');
    var actionsHost = document.getElementById('mSidebarActions');
    var searchInput = document.getElementById('searchInput');

    if (!sidebar || !mask || !tabbar) return;   // 页面结构变了就安静退出

    /* ---------- 1. 抽屉开关 ---------- */
    var scrollLocked = false;
    var savedScrollY = 0;

    function lockScroll() {
        if (scrollLocked) return;
        savedScrollY = window.scrollY || 0;
        document.body.style.overflow = 'hidden';
        scrollLocked = true;
    }
    function unlockScroll() {
        if (!scrollLocked) return;
        document.body.style.overflow = '';
        scrollLocked = false;
    }

    function openDrawer() {
        sidebar.classList.add('open');
        mask.classList.add('open');
        if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'true');
        lockScroll();
    }
    function closeDrawer() {
        sidebar.classList.remove('open');
        mask.classList.remove('open');
        if (drawerBtn) drawerBtn.setAttribute('aria-expanded', 'false');
        unlockScroll();
    }
    function isOpen() { return sidebar.classList.contains('open'); }

    if (drawerBtn) drawerBtn.addEventListener('click', function () {
        isOpen() ? closeDrawer() : openDrawer();
    });
    mask.addEventListener('click', closeDrawer);
    if (moreBtn) moreBtn.addEventListener('click', openDrawer);

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOpen()) { closeDrawer(); e.stopPropagation(); }
    }, true);

    /* 抽屉里点了导航项就自动收起 */
    sidebar.addEventListener('click', function (e) {
        if (e.target.closest('.nav-item[data-view]')) {
            setTimeout(closeDrawer, 60);   // 等 switchView 先跑
        }
    });

    /* 手机上的右滑手势：从屏幕左缘往右拖打开抽屉 */
    var touchX0 = 0, touchY0 = 0, tracking = false;
    document.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { tracking = false; return; }
        touchX0 = e.touches[0].clientX;
        touchY0 = e.touches[0].clientY;
        tracking = (touchX0 <= 24) || isOpen();
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
        if (!tracking) return;
        tracking = false;
        var t = e.changedTouches[0];
        var dx = t.clientX - touchX0;
        var dy = Math.abs(t.clientY - touchY0);
        if (dy > Math.abs(dx)) return;              // 竖向滚动，忽略
        if (!isOpen() && dx > 60) openDrawer();
        else if (isOpen() && dx < -50) closeDrawer();
    }, { passive: true });

    /* ---------- 2. 把导航栏的控件搬进抽屉（可逆） ---------- */
    var placeholders = [];

    function moveIntoDrawer() {
        if (placeholders.length || !actionsHost) return;
        var title = document.createElement('h3');
        title.textContent = '快捷操作';
        actionsHost.appendChild(title);

        ['.v4-skin-switch', '#scanBtn', '#scanStatus'].forEach(function (sel) {
            var el = document.querySelector('.nav-right ' + sel);
            if (!el) return;
            var ph = document.createComment('m-moved:' + sel);
            el.parentNode.insertBefore(ph, el);
            actionsHost.appendChild(el);
            placeholders.push({ el: el, ph: ph });
        });
    }

    function restoreFromNav() {
        placeholders.forEach(function (p) {
            if (p.ph.parentNode) p.ph.parentNode.replaceChild(p.el, p.ph);
        });
        placeholders.length = 0;
        if (actionsHost) actionsHost.innerHTML = '';
    }

    /* ---------- 3. 底部标签栏 ---------- */
    var TAB_VIEWS = ['movies', 'guess', 'new-releases', 'favorites'];

    function syncTabs(view) {
        var v = (view === 'guess-grid' || view === 'guess-magic') ? 'guess' : view;
        tabbar.querySelectorAll('.m-tab[data-view]').forEach(function (b) {
            var on = b.dataset.view === v;
            b.classList.toggle('active', on);
            if (on) b.setAttribute('aria-current', 'page');
            else b.removeAttribute('aria-current');
        });
    }

    tabbar.addEventListener('click', function (e) {
        var tab = e.target.closest('.m-tab');
        if (!tab) return;
        var view = tab.dataset.view;
        if (!view) return;
        if (typeof window.switchView === 'function') window.switchView(view);
        // 切视图后回到顶部，否则会停在上一页的滚动位置
        window.scrollTo({ top: 0, behavior: 'auto' });
    });

    /* 包装 switchView 以同步高亮（只包一次，避免重复包装） */
    if (typeof window.switchView === 'function' && !window.switchView.__mWrapped) {
        var orig = window.switchView;
        var wrapped = function (view) {
            var r = orig.apply(this, arguments);
            syncTabs(view);
            markView(view);
            return r;
        };
        wrapped.__mWrapped = true;
        window.switchView = wrapped;
        // 首帧同步一次
        var active = document.querySelector('.nav-item.active');
        syncTabs(active ? active.dataset.view : 'movies');
        markView(active ? active.dataset.view : 'movies');
    }

    /* ---------- 5. 移动端专属清理 ---------- */

    /* 把当前视图写到 body 上，供 CSS 做「这个视图自带标题，就别再显示工具栏标题」判断。
       只在移动端写 —— 桌面端不留下任何移动端痕迹 */
    function markView(view) {
        if (!MQ.matches) {
            delete document.body.dataset.mview;
            return;
        }
        if (!view) return;
        var v = (view === 'guess-grid' || view === 'guess-magic') ? 'guess' : view;
        document.body.dataset.mview = v;
    }

    /* 搜索框 placeholder 里的「Ctrl+K 全局搜索」在手机上既没意义又会被截断 */
    var ORIG_PLACEHOLDER = searchInput ? searchInput.getAttribute('placeholder') : '';
    function setSearchPlaceholder() {
        if (!searchInput) return;
        if (MQ.matches) searchInput.setAttribute('placeholder', '搜索番号、片名、演员…');
        else searchInput.setAttribute('placeholder', ORIG_PLACEHOLDER);
    }

    /* logo 全称有 198px 宽，手机上会把右侧图标挤到第三行（整个导航栏 159px 高）。
       移动端收短品牌名，导航栏压回两行 */
    var logoEl = document.querySelector('.logo');
    var ORIG_LOGO = logoEl ? logoEl.textContent : '';
    var SHORT_LOGO = '午夜场';
    function setLogo() {
        if (!logoEl) return;
        logoEl.textContent = MQ.matches ? SHORT_LOGO : ORIG_LOGO;
    }

    /* ---------- 4. 断点切换时的进出场 ---------- */
    function applyMode() {
        setSearchPlaceholder();
        setLogo();
        if (MQ.matches) {
            moveIntoDrawer();
            var active2 = document.querySelector('.nav-item.active');
            syncTabs(active2 ? active2.dataset.view : 'movies');
            markView(active2 ? active2.dataset.view : 'movies');
        } else {
            closeDrawer();
            restoreFromNav();
            // 回到桌面端时清掉视图标记，避免移动端专属规则外溢
            delete document.body.dataset.mview;
        }
    }
    applyMode();

    if (MQ.addEventListener) MQ.addEventListener('change', applyMode);
    else if (MQ.addListener) MQ.addListener(applyMode);

    /* 暴露给验证脚本用 */
    window.__mNav = {
        open: openDrawer, close: closeDrawer, isOpen: isOpen,
        syncTabs: syncTabs, mode: function () { return MQ.matches; },
        mview: function () { return document.body.dataset.mview; }
    };
})();
