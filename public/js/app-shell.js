/* 应用外壳：库务面板、焦点归还、SVG 状态图标；不接管业务路由。 */
(function () {
    'use strict';

    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    ready(function () {
        var panel = document.getElementById('shellWorkspace');
        var scrim = document.getElementById('shellScrim');
        var trigger = document.getElementById('shellLibraryBtn');
        var closeButton = document.getElementById('shellWorkspaceClose');
        if (!panel || !scrim || !trigger || !closeButton) return;
        var lastFocus = null;

        // 视图状态属于导航，不属于动效；reduced-motion 下也必须更新。
        if (typeof window.switchView === 'function' && !window.switchView.__shellStateWrapped) {
            var originalSwitch = window.switchView;
            var shellSwitch = function (view) {
                document.body.dataset.view = view;
                return originalSwitch.apply(this, arguments);
            };
            shellSwitch.__shellStateWrapped = true;
            window.switchView = shellSwitch;
        }

        function selectTab(name) {
            panel.querySelectorAll('[data-shell-tab]').forEach(function (button) {
                var active = button.dataset.shellTab === name;
                button.classList.toggle('active', active);
                button.setAttribute('aria-selected', String(active));
            });
            panel.querySelectorAll('[data-shell-panel]').forEach(function (section) {
                section.hidden = section.dataset.shellPanel !== name;
            });
        }

        function open(tab) {
            if (window.innerWidth <= 860 && document.getElementById('mainSidebar')?.classList.contains('open')) {
                document.getElementById('mNavMask')?.click();
            }
            lastFocus = document.activeElement;
            selectTab(tab || 'library');
            panel.hidden = false;
            scrim.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            document.body.classList.add('shell-workspace-open');
            closeButton.focus();
        }

        function close() {
            panel.hidden = true;
            scrim.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            document.body.classList.remove('shell-workspace-open');
            if (lastFocus && lastFocus.isConnected) lastFocus.focus();
        }

        trigger.addEventListener('click', function () { panel.hidden ? open() : close(); });
        closeButton.addEventListener('click', close);
        scrim.addEventListener('click', close);
        panel.querySelectorAll('[data-shell-tab]').forEach(function (button) {
            button.addEventListener('click', function () { selectTab(button.dataset.shellTab); });
        });
        document.getElementById('shellAllSettings')?.addEventListener('click', function () {
            close();
            if (window.Gate) {
                window.Gate.guard('settings').then(function (allowed) { if (allowed) window.switchView('settings'); });
            } else window.switchView('settings');
        });

        function goView(view) {
            if (window.Gate) {
                window.Gate.guard(view).then(function (allowed) { if (allowed) window.switchView(view); });
            } else window.switchView(view);
        }

        function latestActivity() {
            var hidden = typeof window.isAdultNavHidden === 'function' && window.isAdultNavHidden();
            var movieRequest = window.api?.getMovies('lastplay', 'all', 'all', 1, 1, hidden ? 'exclude' : 'include')
                .catch(function () { return []; });
            var bookRequest = fetch('/api/media/resume?type=all').then(function (r) { return r.json(); })
                .then(function (j) { return j.code === 0 ? j.data : null; }).catch(function () { return null; });
            Promise.all([movieRequest, bookRequest]).then(function (result) {
                var movie = Array.isArray(result[0]) ? result[0][0] : null;
                if (hidden && movie && ['jav', 'anime'].includes(String(movie.type || 'jav'))) movie = null;
                var book = result[1];
                if (book && (!movie || Number(book.updatedAt) > Number(movie.lastPlayTime))) {
                    if (book.type === 'novel' && typeof window.openNovelReader === 'function') window.openNovelReader(book.id);
                    else if (typeof window.openComicReader === 'function') window.openComicReader(book.id);
                    else goView(book.type === 'novel' ? 'novel' : 'comic');
                    return;
                }
                if (movie && Number(movie.lastPlayTime) > 0 && typeof window.showMovieDetail === 'function') {
                    window.showMovieDetail(movie.id);
                    return;
                }
                goView('recent');
            });
        }
        document.getElementById('shellContinueBtn')?.addEventListener('click', latestActivity);
        document.getElementById('searchInput')?.addEventListener('input', function (event) {
            event.target.closest('.search-box')?.classList.toggle('has-query', !!event.target.value.trim());
        });

        var notice = document.getElementById('notificationBtn');
        notice?.setAttribute('aria-haspopup', 'dialog');
        notice?.addEventListener('click', function (event) {
            event.stopImmediatePropagation();
            event.stopPropagation();
            open('alerts');
        }, true);
        document.addEventListener('keydown', function (event) {
            if (panel.hidden) return;
            if (event.key === 'Escape') { event.preventDefault(); close(); return; }
            if (event.key !== 'Tab') return;
            var focusable = [...panel.querySelectorAll('button:not([disabled]), input, select, a[href], [tabindex="0"]')]
                .filter(function (el) { return el.getClientRects().length; });
            if (!focusable.length) return;
            var first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });

        /* 状态由 app.js 写入 label span；按钮原生文本不覆盖 SVG。 */

        document.querySelectorAll('.sidebar-section').forEach(function (section) {
            var title = section.querySelector(':scope > h3');
            if (!title) return;
            if (title.textContent.trim() === '排序方式') section.classList.add('sidebar-sort-section');
            if (title.textContent.trim() === '数据统计') section.classList.add('sidebar-stats-section');
        });
    });
})();
