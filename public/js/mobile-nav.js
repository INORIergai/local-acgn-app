/* ============================================================
   移动端全功能原生交互层 · mobile-nav.js
   ------------------------------------------------------------
   设计铁律（2026-11 规范）：
   · 移动端具备桌面端几乎所有功能，绝不一刀切阉割；
   · 彻底摒弃电脑端操作逻辑（Ctrl+点击多选、悬停才现形、密集顶栏按钮），
     转译为手机端原生直觉交互：
     1. 底部 5 格黄金拇指导航（首页 / 影剧 / 书架 / AI助手 / 全库·我的）
     2. 抽屉顶部「手机控制中心」（四皮肤切换 / 隐私锁显隐开关 / 全局快搜面板 / 扫描与监控 / 客户端更新）
     3. 视图内「移动端上下文操作栏」（自适应排序选择器 + 批量多选模式开关 + 书架目录树展开开关）
     4. 卡片长按（420ms + 震动反馈）直接进入「整卡点选批量模式」，点卡任意位置即勾选/取消
   ============================================================ */
(function () {
    'use strict';

    var MQ = window.matchMedia('(max-width: 860px)');

    var drawerBtn = document.getElementById('mDrawerBtn');
    var sidebar = document.getElementById('mainSidebar');
    var mask = document.getElementById('mNavMask');
    var tabbar = document.getElementById('mTabbar');
    var aiTabBtn = document.getElementById('mTabAi');
    var moreBtn = document.getElementById('mTabMore');
    var actionsHost = document.getElementById('mSidebarActions');
    var searchInput = document.getElementById('searchInput');
    var movieGrid = document.getElementById('movieGrid');

    if (!sidebar || !mask || !tabbar) return;

    /* ---------- 1. 抽屉开关与边缘手势 ---------- */
    var scrollLocked = false;

    function lockScroll() {
        if (scrollLocked) return;
        document.body.style.overflow = 'hidden';
        scrollLocked = true;
    }
    function unlockScroll() {
        if (!scrollLocked) return;
        document.body.style.overflow = '';
        scrollLocked = false;
    }

    function openDrawer() {
        syncAdultControlUI();
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
    if (moreBtn) moreBtn.addEventListener('click', function () {
        isOpen() ? closeDrawer() : openDrawer();
    });
    if (aiTabBtn) aiTabBtn.addEventListener('click', function () {
        if (isOpen()) closeDrawer();
        if (typeof window.showAIAssistant === 'function') {
            window.showAIAssistant();
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOpen()) { closeDrawer(); e.stopPropagation(); }
    }, true);

    /* 抽屉里点了导航项就自动收起 */
    sidebar.addEventListener('click', function (e) {
        if (e.target.closest('.nav-item[data-view]')) {
            setTimeout(closeDrawer, 60);
        }
    });

    /* 手机上的左缘右滑打开抽屉 / 左滑收起抽屉 */
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
        if (dy > Math.abs(dx)) return;
        if (!isOpen() && dx > 60) openDrawer();
        else if (isOpen() && dx < -50) closeDrawer();
    }, { passive: true });

    /* ---------- 2. 抽屉顶部「手机端控制中心」（可逆搬移 + 补齐桌面隐藏功能） ---------- */
    var placeholders = [];
    var mAdultBtn = null;

    function isAdultHiddenNow() {
        if (typeof window.isAdultNavHidden === 'function') return window.isAdultNavHidden();
        return document.body.classList.contains('adult-hidden');
    }

    function syncAdultControlUI() {
        if (!mAdultBtn) return;
        var hidden = isAdultHiddenNow();
        var arm = document.getElementById('adultToggle');
        var isArmed = arm && arm.classList.contains('adult-arm');
        mAdultBtn.classList.toggle('is-unlocked', !hidden);
        mAdultBtn.classList.toggle('is-armed', !!isArmed);
        if (isArmed) {
            mAdultBtn.innerHTML = '<span class="m-cc-ic">🔓</span><span class="m-cc-txt"><b>再点一次确认解锁</b><em>显示 AV库 / 里番 / 隐私内容</em></span>';
        } else if (hidden) {
            mAdultBtn.innerHTML = '<span class="m-cc-ic">🔒</span><span class="m-cc-txt"><b>隐私入口：已隐藏</b><em>点击解锁成人与隐私库</em></span>';
        } else {
            mAdultBtn.innerHTML = '<span class="m-cc-ic">🔓</span><span class="m-cc-txt"><b>隐私入口：已显示</b><em>点击一键隐藏全部成人入口</em></span>';
        }
    }
    window.__syncMobileAdultUI = syncAdultControlUI;

    function moveIntoDrawer() {
        if (placeholders.length || !actionsHost) return;
        actionsHost.innerHTML = '';

        var head = document.createElement('div');
        head.className = 'm-cc-head';
        head.innerHTML = '<span class="m-cc-title">控制中心</span><span class="m-cc-sub">全功能触控台</span>';
        actionsHost.appendChild(head);

        /* 2.1 皮肤与主题行 */
        var skinRow = document.createElement('div');
        skinRow.className = 'm-cc-skin-row';
        var skinLabel = document.createElement('span');
        skinLabel.className = 'm-cc-row-label';
        skinLabel.textContent = '界面风格';
        skinRow.appendChild(skinLabel);

        ['.v4-skin-switch', '#themeToggle'].forEach(function (sel) {
            var el = document.querySelector(sel);
            if (!el) return;
            var ph = document.createComment('m-moved:' + sel);
            el.parentNode.insertBefore(ph, el);
            skinRow.appendChild(el);
            placeholders.push({ el: el, ph: ph });
        });
        actionsHost.appendChild(skinRow);

        /* 2.2 隐私开关 + 全局快搜双卡片 */
        var quickGrid = document.createElement('div');
        quickGrid.className = 'm-cc-grid';

        mAdultBtn = document.createElement('button');
        mAdultBtn.type = 'button';
        mAdultBtn.className = 'm-cc-card';
        mAdultBtn.addEventListener('click', function () {
            if (typeof window.toggleAdultNav === 'function') {
                window.toggleAdultNav();
                setTimeout(syncAdultControlUI, 30);
            }
        });
        syncAdultControlUI();
        quickGrid.appendChild(mAdultBtn);

        var cmdBtn = document.createElement('button');
        cmdBtn.type = 'button';
        cmdBtn.className = 'm-cc-card';
        cmdBtn.innerHTML = '<span class="m-cc-ic">⌘</span><span class="m-cc-txt"><b>快速跳转 / 命令</b><em>搜影片 · 切视图 · 抽盲盒</em></span>';
        cmdBtn.addEventListener('click', function () {
            closeDrawer();
            var cp = document.getElementById('cpOverlay');
            var cpInp = document.getElementById('cpInput');
            if (cp) {
                cp.classList.add('show', 'open', 'active');
                cp.style.display = 'flex';
                if (cpInp) setTimeout(function () { cpInp.focus(); }, 60);
            } else {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
            }
        });
        quickGrid.appendChild(cmdBtn);
        actionsHost.appendChild(quickGrid);

        /* 2.3 扫描与监控操作栏 */
        var scanGroup = document.createElement('div');
        scanGroup.className = 'm-cc-scan-group';
        ['#scanBtn', '#watchNowBtn', '#watchToggleBtn', '#scanStatusWrap'].forEach(function (sel) {
            var el = document.querySelector(sel);
            if (!el) return;
            var ph = document.createComment('m-moved:' + sel);
            el.parentNode.insertBefore(ph, el);
            scanGroup.appendChild(el);
            placeholders.push({ el: el, ph: ph });
        });
        actionsHost.appendChild(scanGroup);

        /* 2.4 客户端更新检查 */
        var updateBtn = document.createElement('button');
        var libraryBtn = document.createElement('button');
        libraryBtn.type = 'button';
        libraryBtn.className = 'btn btn-sm btn-secondary m-cc-update-btn';
        libraryBtn.textContent = '库务与个性化';
        libraryBtn.addEventListener('click', function () {
            closeDrawer();
            document.getElementById('shellLibraryBtn')?.click();
        });
        actionsHost.appendChild(libraryBtn);

        updateBtn.type = 'button';
        updateBtn.className = 'btn btn-sm btn-secondary m-cc-update-btn';
        updateBtn.innerHTML = '🔄 检查客户端更新';
        updateBtn.onclick = function () {
            if (typeof window.checkAndroidUpdate === 'function') {
                window.checkAndroidUpdate();
            } else if (typeof window.showNotification === 'function') {
                window.showNotification('版本检查', '当前已是最新客户端版本');
            }
        };
        actionsHost.appendChild(updateBtn);
    }

    function restoreFromNav() {
        placeholders.forEach(function (p) {
            if (p.ph.parentNode) p.ph.parentNode.replaceChild(p.el, p.ph);
        });
        placeholders.length = 0;
        mAdultBtn = null;
        if (actionsHost) actionsHost.innerHTML = '';
    }

    /* ---------- 3. 视图内「移动端上下文操作栏」（排序 + 批量选择 + 书架目录树开关） ---------- */
    var ctxBar = null;
    var mSortSelect = null;
    var mBatchBtn = null;
    var mTreeBtn = null;

    var BATCH_CAPABLE_VIEWS = {
        'movies': 1, 'jav': 1, 'anime': 1, 'film': 1, 'cartoon': 1,
        'favorites': 1, 'recent': 1, 'unwatched': 1, 'hot': 1,
        'movies-adult': 1, 'recent-adult': 1, 'hot-adult': 1, 'unwatched-adult': 1
    };
    var TREE_VIEWS = { 'comic': 1, 'novel': 1 };
    var SORT_HIDDEN_VIEWS = {
        'home': 1, 'settings': 1, 'annual': 1, 'scrape-failures': 1, 'poster-health': 1,
        'actresses': 1, 'tags': 1, 'favhub': 1, 'watch': 1, 'watch-hub': 1,
        'watch-anime': 1, 'watch-comic': 1, 'watch-novel': 1, 'watch-hanime': 1,
        'acg-rank': 1, 'ms': 1, 'new-releases': 1
    };

    function ensureContextBar() {
        if (ctxBar) return ctxBar;
        var toolbar = document.querySelector('.content > .toolbar');
        if (!toolbar) return null;

        ctxBar = document.createElement('div');
        ctxBar.className = 'm-context-bar';
        ctxBar.id = 'mContextBar';

        /* A. 书架目录树展开按钮（仅 comic/novel 显示） */
        mTreeBtn = document.createElement('button');
        mTreeBtn.type = 'button';
        mTreeBtn.className = 'm-ctx-pill m-ctx-tree-btn';
        mTreeBtn.innerHTML = '<svg class="ic" width="15" height="15"><use href="#ic-folder"/></svg><span>目录树</span>';
        mTreeBtn.addEventListener('click', function () {
            var tree = document.querySelector('.av-view.av-workspace .av-tree');
            if (!tree) return;
            var open = tree.classList.toggle('m-tree-open');
            mTreeBtn.classList.toggle('active', open);
        });
        ctxBar.appendChild(mTreeBtn);

        /* B. 移动端自适应排序选择器（打通 #sortSelect 与 #searchSortSelect） */
        var sortWrap = document.createElement('label');
        sortWrap.className = 'm-ctx-pill m-ctx-sort-wrap';
        sortWrap.innerHTML = '<svg class="ic" width="14" height="14"><use href="#ic-sort"/></svg>';
        mSortSelect = document.createElement('select');
        mSortSelect.className = 'm-ctx-sort-select';
        mSortSelect.id = 'mQuickSortSelect';
        mSortSelect.setAttribute('aria-label', '排序方式');
        mSortSelect.addEventListener('change', function () {
            var val = mSortSelect.value;
            var isSearching = searchInput && searchInput.value.trim().length > 0;
            var targetSel = document.getElementById(isSearching ? 'searchSortSelect' : 'sortSelect');
            if (targetSel) {
                targetSel.value = val;
                targetSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        sortWrap.appendChild(mSortSelect);
        ctxBar.appendChild(sortWrap);

        /* C. 批量多选模式切换按钮（替代电脑端 Ctrl+Click） */
        mBatchBtn = document.createElement('button');
        mBatchBtn.type = 'button';
        mBatchBtn.className = 'm-ctx-pill m-ctx-batch-btn';
        mBatchBtn.id = 'mBatchModeBtn';
        mBatchBtn.addEventListener('click', function () {
            toggleMobileSelectMode();
        });
        ctxBar.appendChild(mBatchBtn);

        toolbar.appendChild(ctxBar);
        syncContextBar();
        return ctxBar;
    }

    function syncSortOptions() {
        if (!mSortSelect) return;
        var isSearching = searchInput && searchInput.value.trim().length > 0;
        var srcSel = document.getElementById(isSearching ? 'searchSortSelect' : 'sortSelect');
        if (!srcSel) return;

        mSortSelect.innerHTML = '';
        Array.from(srcSel.options).forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.textContent.replace(/^[^\w\u4e00-\u9fa5]+/, '').trim() || opt.textContent;
            mSortSelect.appendChild(o);
        });
        mSortSelect.value = srcSel.value;
    }

    function syncBatchUI() {
        if (!mBatchBtn) return;
        var count = (window.selectedMovies && window.selectedMovies.size) ? window.selectedMovies.size : 0;
        var active = !!window._mobileSelectMode || count > 0;
        document.body.classList.toggle('m-select-mode', active);
        mBatchBtn.classList.toggle('active', active);
        if (active) {
            mBatchBtn.innerHTML = '<svg class="ic" width="14" height="14"><use href="#ic-check"/></svg><span>退出批量' + (count ? ' (' + count + ')' : '') + '</span>';
        } else {
            mBatchBtn.innerHTML = '<svg class="ic" width="14" height="14"><use href="#ic-check"/></svg><span>批量管理</span>';
        }
    }
    window.__syncMobileBatchUI = syncBatchUI;

    function toggleMobileSelectMode(force) {
        var next = (typeof force === 'boolean') ? force : !window._mobileSelectMode;
        window._mobileSelectMode = next;
        document.body.classList.toggle('m-select-mode', next);
        if (!next && typeof window.clearSelection === 'function') {
            window.clearSelection();
            return;
        }
        if (typeof window.updateBatchToolbar === 'function') {
            window.updateBatchToolbar();
        }
        syncBatchUI();
    }

    function syncContextBar(view) {
        if (!MQ.matches) return;
        ensureContextBar();
        if (!ctxBar) return;
        var activeEl = document.querySelector('.nav-item.active');
        var v = view || document.body.dataset.mview || (activeEl ? activeEl.dataset.view : 'movies');
        var isSearching = searchInput && searchInput.value.trim().length > 0;

        if (SORT_HIDDEN_VIEWS[v] && !isSearching) {
            ctxBar.style.display = 'none';
            return;
        }
        ctxBar.style.display = 'flex';

        if (mTreeBtn) {
            mTreeBtn.style.display = TREE_VIEWS[v] ? 'inline-flex' : 'none';
            if (!TREE_VIEWS[v]) mTreeBtn.classList.remove('active');
        }
        if (mBatchBtn) {
            mBatchBtn.style.display = (BATCH_CAPABLE_VIEWS[v] || isSearching) ? 'inline-flex' : 'none';
        }
        syncSortOptions();
        syncBatchUI();
    }

    if (searchInput) {
        searchInput.addEventListener('input', function () {
            if (MQ.matches) syncContextBar();
        });
    }

    /* ---------- 3b. AI 工作台：手机端会话侧栏改抽屉 ----------
       桌面端 #aiModal 是「左会话栏 + 右消息区」双栏；390px 下并排会把消息区
       挤成 100px，且会话的重命名/归档/删除按钮原本只在 hover 时出现（触屏
       等于不存在）。这里补一个「会话」抽屉按钮 + 遮罩，并把操作改为常驻
       （CSS 侧 round173-mobile-v6.css 已处理）。 */
    function initAiWorkbenchMobile() {
        var aiModal = document.getElementById('aiModal');
        if (!aiModal || aiModal.__mAiInit) return;
        var content = aiModal.querySelector('.modal-content');
        var sidebar = aiModal.querySelector('.dsn-sidebar');
        var topbar = aiModal.querySelector('.dsn-topbar');
        if (!content || !sidebar || !topbar) return;
        aiModal.__mAiInit = true;

        var scrim = document.createElement('div');
        scrim.className = 'm-ai-scrim';
        content.appendChild(scrim);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'm-ai-sb-btn';
        btn.id = 'mAiSessionsBtn';
        btn.setAttribute('aria-label', '打开会话列表');
        btn.innerHTML = '<svg class="ic" width="13" height="13" aria-hidden="true"><use href="#ic-list"/></svg>会话';
        topbar.insertBefore(btn, topbar.firstChild);

        function open() {
            sidebar.classList.add('m-open');
            scrim.classList.add('on');
            btn.setAttribute('aria-expanded', 'true');
        }
        function close() {
            sidebar.classList.remove('m-open');
            scrim.classList.remove('on');
            btn.setAttribute('aria-expanded', 'false');
        }
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', function () {
            sidebar.classList.contains('m-open') ? close() : open();
        });
        scrim.addEventListener('click', close);
        /* 点了会话 / 新建 / 归档箱后自动收起 */
        sidebar.addEventListener('click', function (e) {
            if (e.target.closest('.dsn-session-item, #dsnNewChatBtn, #dsnArchiveToggleBtn')) {
                setTimeout(close, 90);
            }
        });
        /* Esc：先收抽屉，不直接关整个工作台 */
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && sidebar.classList.contains('m-open')) {
                close();
                e.stopPropagation();
            }
        }, true);
        /* 关闭整个 AI 工作台时复位，避免下次打开仍是抽屉展开态 */
        if (typeof window.closeAIModal === 'function' && !window.closeAIModal.__mWrapped) {
            var origClose = window.closeAIModal;
            var wrappedClose = function () {
                close();
                return origClose.apply(this, arguments);
            };
            wrappedClose.__mWrapped = true;
            window.closeAIModal = wrappedClose;
        }
        window.__mAiSidebar = { open: open, close: close };
    }

    /* ---------- 4. 移动端卡片「长按进入多选 + 整卡点击勾选」 ---------- */
    if (movieGrid) {
        /* 4.1 捕获阶段拦截点击：处于批量模式时，点整张卡片任意处即切换选中，不弹详情 */
        movieGrid.addEventListener('click', function (e) {
            var count = (window.selectedMovies && window.selectedMovies.size) ? window.selectedMovies.size : 0;
            if (!window._mobileSelectMode && count === 0) return;
            var card = e.target.closest('.movie-card[data-id], [data-mid]');
            if (!card) return;
            var id = parseInt(card.dataset.id || card.dataset.mid, 10);
            if (!id) return;
            e.preventDefault();
            e.stopPropagation();
            if (typeof window.toggleSelect === 'function') {
                window.toggleSelect(id);
            }
        }, true);

        /* 4.2 长按卡片（420ms）直接开启批量多选并选中当前卡 */
        var holdTimer = 0;
        var holdStartX = 0, holdStartY = 0;
        var suppressNextClick = false;

        movieGrid.addEventListener('touchstart', function (e) {
            if (!MQ.matches || e.touches.length !== 1) return;
            var card = e.target.closest('.movie-card[data-id], [data-mid]');
            if (!card) return;
            var id = parseInt(card.dataset.id || card.dataset.mid, 10);
            if (!id) return;

            holdStartX = e.touches[0].clientX;
            holdStartY = e.touches[0].clientY;
            clearTimeout(holdTimer);
            holdTimer = setTimeout(function () {
                holdTimer = 0;
                suppressNextClick = true;
                try { if (navigator.vibrate) navigator.vibrate(18); } catch (err) { /* ignore */ }
                window._mobileSelectMode = true;
                document.body.classList.add('m-select-mode');
                if (typeof window.toggleSelect === 'function') {
                    window.toggleSelect(id);
                }
            }, 420);
        }, { passive: true });

        movieGrid.addEventListener('touchmove', function (e) {
            if (!holdTimer || !e.touches.length) return;
            var dx = Math.abs(e.touches[0].clientX - holdStartX);
            var dy = Math.abs(e.touches[0].clientY - holdStartY);
            if (dx > 10 || dy > 10) {
                clearTimeout(holdTimer);
                holdTimer = 0;
            }
        }, { passive: true });

        movieGrid.addEventListener('touchend', function () {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
        }, { passive: true });

        movieGrid.addEventListener('touchcancel', function () {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
        }, { passive: true });

        movieGrid.addEventListener('click', function (e) {
            if (suppressNextClick) {
                suppressNextClick = false;
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
    }

    /* ---------- 5. 底部标签栏与视图同步 ---------- */
    function syncTabs(view) {
        var v = view;
        if (view === 'novel') v = 'comic';
        if (view === 'film' || view === 'cartoon' || view === 'jav' || view === 'anime' ||
            view === 'hot' || view === 'random' || view === 'unwatched' || view === 'recent') {
            v = 'movies';
        }
        if (view === 'guess' || view === 'guess-grid' || view === 'guess-magic') v = 'home';
        tabbar.querySelectorAll('.m-tab[data-view]').forEach(function (b) {
            var on = b.dataset.view === v;
            b.classList.toggle('active', on);
            if (on) b.setAttribute('aria-current', 'page');
            else b.removeAttribute('aria-current');
        });
        if (moreBtn) {
            moreBtn.classList.toggle('active', view === 'settings' || view === 'favorites' || view === 'new-releases' || view === 'annual');
        }
    }

    tabbar.addEventListener('click', function (e) {
        var tab = e.target.closest('.m-tab[data-view]');
        if (!tab) return;
        var view = tab.dataset.view;
        if (!view) return;
        if (isOpen()) closeDrawer();
        if (typeof window.switchView === 'function') window.switchView(view);
        window.scrollTo({ top: 0, behavior: 'auto' });
    });

    if (typeof window.switchView === 'function' && !window.switchView.__mWrapped) {
        var orig = window.switchView;
        var wrapped = function (view) {
            var r = orig.apply(this, arguments);
            syncTabs(view);
            markView(view);
            setTimeout(function () { syncContextBar(view); }, 30);
            return r;
        };
        wrapped.__mWrapped = true;
        window.switchView = wrapped;
        var active = document.querySelector('.nav-item.active');
        var initView = active ? active.dataset.view : 'home';
        syncTabs(initView);
        markView(initView);
    }

    function markView(view) {
        if (!MQ.matches) {
            delete document.body.dataset.mview;
            return;
        }
        if (!view) return;
        var v = (view === 'guess-grid' || view === 'guess-magic') ? 'guess' : view;
        document.body.dataset.mview = v;
    }

    var ORIG_PLACEHOLDER = searchInput ? searchInput.getAttribute('placeholder') : '';
    function setSearchPlaceholder() {
        if (!searchInput) return;
        if (MQ.matches) searchInput.setAttribute('placeholder', '搜索番号、片名、演员、标签…');
        else searchInput.setAttribute('placeholder', ORIG_PLACEHOLDER);
    }

    var logoEl = document.querySelector('.logo');
    var ORIG_LOGO = logoEl ? logoEl.textContent : '';
    var SHORT_LOGO = '午夜场';
    function setLogo() {
        if (!logoEl) return;
        logoEl.textContent = MQ.matches ? SHORT_LOGO : ORIG_LOGO;
    }

    function applyMode() {
        setSearchPlaceholder();
        setLogo();
        if (MQ.matches) {
            moveIntoDrawer();
            initAiWorkbenchMobile();
            var active2 = document.querySelector('.nav-item.active');
            var v = active2 ? active2.dataset.view : 'home';
            syncTabs(v);
            markView(v);
            syncContextBar(v);
        } else {
            closeDrawer();
            restoreFromNav();
            delete document.body.dataset.mview;
            if (ctxBar) ctxBar.style.display = 'none';
        }
    }
    applyMode();

    if (MQ.addEventListener) MQ.addEventListener('change', applyMode);
    else if (MQ.addListener) MQ.addListener(applyMode);

    window.__mNav = {
        open: openDrawer, close: closeDrawer, isOpen: isOpen,
        syncTabs: syncTabs, syncContextBar: syncContextBar,
        toggleBatchMode: toggleMobileSelectMode,
        mode: function () { return MQ.matches; },
        mview: function () { return document.body.dataset.mview; }
    };
})();

/* ------------------------------------------------------------------ *
 * v4.7.0 · 统一返回栈（仅当原生提供 CVNative 能力契约时启用）
 *
 * 目标：把"返回关闭哪个弹窗"的决定权从原生层（硬编码 DOM id 注入 JS）
 * 收归前端统一栈。新增弹窗（series 分集/搜源、AI 工作台）只要在这里
 * 注册一条关闭规则即可，不必改 APK —— 这是渐进式全原生的关键接缝。
 *
 * 未启用时（桌面浏览器 / 老 APK）原生旧逻辑照常工作，零回归。
 * ------------------------------------------------------------------ */
(function () {
  'use strict';
  if (!window.CVNative || typeof window.CVNative.isAvailable !== 'function') return;
  if (!window.CVNative.isAvailable()) return;

  // 关闭规则：按优先级从高到低，命中并执行关闭则返回 true。
  var rules = [
    // 追番：分集抽屉 / 搜源弹窗（本周新增，原生旧逻辑不认识它们）
    function () {
      var dlg = document.querySelector('.series-episode-sheet.show, .series-source-sheet.show, [data-series-sheet].show');
      if (dlg) { dlg.classList.remove('show'); return true; }
      return false;
    },
    // AI 工作台会话抽屉
    function () {
      var aiDrawer = document.querySelector('#aiSessionDrawer.open, .ai-workbench .drawer.open');
      if (aiDrawer) { aiDrawer.classList.remove('open'); return true; }
      return false;
    },
    // 手机导航抽屉
    function () {
      if (window.__mNav && window.__mNav.isOpen && window.__mNav.isOpen()) {
        window.__mNav.close(); return true;
      }
      return false;
    },
    // 通用弹窗：详情 / 播放器 / 阅读器 / 任意 .modal.show
    function () {
      var modal = document.querySelector('.modal.show, #playerModal.show, #readerView.show');
      if (!modal) return false;
      var closeBtn = modal.querySelector('.modal-close, .close-btn, [data-close]');
      if (closeBtn) { closeBtn.click(); return true; }
      if (typeof window.closeModal === 'function') { window.closeModal(); return true; }
      modal.classList.remove('show');
      return true;
    }
  ];

  window.CVNative.setBackHandler(function () {
    for (var i = 0; i < rules.length; i++) {
      try {
        if (rules[i]()) return true;  // 已消费，原生不再处理
      } catch (e) { /* 单条规则异常跳过 */ }
    }
    return false;  // 交回原生默认返回栈
  });
})();
