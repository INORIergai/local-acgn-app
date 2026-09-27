/* ==========================================================================
   猜你喜欢 · 魔术卡片（Magic Deck）v2
   --------------------------------------------------------------------------
   交互：卡片从卡堆展开成一条 3D 牌列（中心最大，两侧依次后退、压暗）
        拖动 / 横向滚轮 / ← → / 两侧按钮切换中心卡片
        「换一批」把牌收回卡堆，再抽一批（后端带 exclude，保证真的不重复）
        点击卡片 = 直接播放（复用 app.js 的 playMovieInline）
   依赖：app.js 提供的 getPosterUrl / playMovieInline（都挂在 window 上）
   ========================================================================== */
(function () {
    'use strict';

    // 一次抽几张（实际可见的层数由容器宽度决定，见 layout）
    // 2026-09-21：按用户要求由 7 张提到 10 张 —— 牌堆更厚，一路翻下去能翻十张
    var BATCH = 10;

    // 占位图：跟首页卡片一样是 16:9 宽幅
    var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">' +
        '<rect width="640" height="360" fill="#1C1915"/>' +
        '<text x="320" y="182" text-anchor="middle" font-size="64">🎬</text>' +
        '<text x="320" y="232" text-anchor="middle" fill="#9C9282" font-size="20">未找到封面</text>' +
        '</svg>'
    );

    /**
     * 每一层相对中心的空间位置。
     *   k = 层号（层间距的倍数，实际位移 = k * step，step 由卡片宽推出）
     *   z / ry / s = 纵深、绕 Y 轴侧转、缩放
     *   b = 亮度（不是 opacity！低 opacity 会让后卡透出来，像叠了几片玻璃）
     *
     * 【间距原则】step = 卡片宽 * 1.15，保证相邻两张之间始终有明确空隙；
     * 卡片宽变了 step 跟着变，所以放大缩小都不会挤在一起。
     */
    var LAYERS = [
        { k: 0, y: 0,  z: 170,  ry: 0,  s: 1,    b: 1 },
        { k: 1, y: 16, z: -40,  ry: 24, s: 0.88, b: 0.72 },
        { k: 2, y: 36, z: -210, ry: 32, s: 0.74, b: 0.50 },
        { k: 3, y: 58, z: -380, ry: 38, s: 0.60, b: 0.34 }
    ];

    // 卡片在「卡堆里」的起始姿态（展开动画的起点 / 换一批的收拢终点）
    var DECK_POSE = 'translate3d(0px, 0px, -340px) scale(0.5)';

    var state = {
        movies: [],
        center: 0,
        exclude: [],
        excludeSet: {},
        loading: false,
        failed: false
    };

    var view = null, stage = null, deck = null;
    var btnPrev = null, btnNext = null, btnMore = null, btnList = null;
    var bound = false, drag = null, suppressClick = false, wheelLock = 0;
    var lastPlayAt = 0;
    var resizeTimer = null;

    // ---------- 小工具 ----------

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function twoFrames() {
        return new Promise(function (r) {
            requestAnimationFrame(function () { requestAnimationFrame(r); });
        });
    }

    function cards() {
        return deck ? Array.prototype.slice.call(deck.querySelectorAll('.magic-card')) : [];
    }

    function centerCard() {
        return deck ? deck.querySelector('.magic-card.is-center') : null;
    }

    function posterOf(m) {
        try {
            if (typeof getPosterUrl === 'function') {
                var u = getPosterUrl(m);
                if (u) return u;
            }
        } catch (e) { /* 忽略 */ }
        return PLACEHOLDER;
    }

    // ---------- 尺寸 ----------

    /**
     * 量出舞台当前的可用宽度，推出卡片宽与层间距。
     * 【为什么卡片宽度要算出来而不是写死】16:9 的卡片很宽，
     * 写死尺寸在窄容器里两侧会被裁，在宽容器里又显得小气。
     * 按容器宽的 34% 取（上限 480px），保证「中心一张 + 左右各一张」
     * 刚好把内容区铺满，同时相邻两张之间留出空隙。
     */
    function metrics() {
        var W = (stage && stage.clientWidth) || 0;
        if (W < 60) W = 1200;          // 视图还没显示时的兜底

        var cardW;
        if (W < 620) {
            cardW = Math.max(180, W * 0.62);   // 窄屏：只保证中心卡清晰，两侧露边
        } else {
            /*
             * 30% 是这个布局的甜点：16:9 的卡片很宽，再大一点两侧那张就会被
             * 容器裁掉。实测 1344px 内容区里 445px 的中心卡刚好让
             * 「中心 + 左右各一张」完整可见，并且相邻之间还留出 60px 空隙。
             */
            cardW = Math.max(230, Math.min(430, W * 0.30));
        }
        return { W: W, cardW: cardW, step: cardW * 1.14 };
    }

    function applyMetrics() {
        var m = metrics();
        if (view) view.style.setProperty('--mcw', Math.round(m.cardW) + 'px');
        return m;
    }

    // ---------- 骨架 ----------

    function ensureSkeleton() {
        if (!view || view.querySelector('.magic-stage')) return;
        view.innerHTML = [
            '<div class="magic-head">',
            '  <div class="magic-title">拖动或滚轮翻牌 · 点中间那张直接播放</div>',
            '</div>',
            '<div class="magic-stage" id="magicStage">',
            '  <div class="magic-deck" id="magicDeck"></div>',
            '</div>',
            '<div class="magic-foot">',
            '  <button class="magic-btn ghost" id="magicPrev" type="button" title="上一张">‹</button>',
            '  <button class="magic-btn primary" id="magicMore" type="button">换一批</button>',
            '  <button class="magic-btn ghost" id="magicNext" type="button" title="下一张">›</button>',
            '  <button class="magic-btn ghost" id="magicList" type="button" title="切换成列表模式">☰</button>',
            '</div>'
        ].join('');

        stage = view.querySelector('#magicStage');
        deck = view.querySelector('#magicDeck');
        btnPrev = view.querySelector('#magicPrev');
        btnNext = view.querySelector('#magicNext');
        btnMore = view.querySelector('#magicMore');
        btnList = view.querySelector('#magicList');
    }

    // ---------- 数据 ----------

    function fetchBatch(n) {
        var excl = state.exclude.slice(-150).join(',');
        var url = '/api/recommend/guess?limit=' + n + '&exclude=' + encodeURIComponent(excl);
        return fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var list = (d && d.data) || [];
                list = list.filter(function (m) { return m && !state.excludeSet[m.id]; });
                list.forEach(function (m) {
                    state.excludeSet[m.id] = 1;
                    state.exclude.push(m.id);
                });
                return list;
            })
            .catch(function (e) {
                console.error('[魔术卡片] 取数据失败:', e);
                return [];
            });
    }

    // ---------- 渲染 ----------

    function renderCards() {
        if (!deck) return;

        var html = state.movies.map(function (m, i) {
            var poster = posterOf(m);
            var title = esc(m.title || m.fileName || '未知影片');
            var avid = esc(m.avid || '');
            var plays = Number(m.playCount || m.plays || 0);
            var meta = [
                avid ? '<span class="mc-avid">' + avid + '</span>' : '',
                plays > 0 ? '<span>▶ ' + plays + '</span>' : ''
            ].join('');
            return [
                '<article class="magic-card" data-idx="' + i + '" data-id="' + esc(m.id) + '">',
                '<img class="mc-poster" src="' + esc(poster) + '" alt="' + title + '" draggable="false"',
                ' onerror="this.onerror=null;this.src=\'' + PLACEHOLDER + '\'">',
                '<div class="mc-info">',
                '<div class="mc-title">' + title + '</div>',
                meta ? '<div class="mc-meta">' + meta + '</div>' : '',
                '</div>',
                '<div class="mc-play">▶</div>',
                '</article>'
            ].join('');
        }).join('');

        deck.innerHTML = html;

        // 起始态：全部叠在卡堆位置（缩在远处、透明），随后由 layout 展开
        cards().forEach(function (el) {
            el.style.transition = 'none';
            el.style.transitionDelay = '0ms';
            el.style.opacity = '0';
            el.style.filter = 'brightness(0.5)';
            el.style.transform = DECK_POSE;
        });
        void deck.offsetHeight;   // 强制样式落定，否则起始态会被跳过
        cards().forEach(function (el) { el.style.transition = ''; });
    }

    function layout(dealing) {
        if (!stage) return;
        var m = applyMetrics();
        var half = m.W / 2;

        cards().forEach(function (el, i) {
            var d = i - state.center;
            var ad = Math.abs(d);
            var L = LAYERS[Math.min(ad, LAYERS.length - 1)];
            var sign = d === 0 ? 0 : (d > 0 ? 1 : -1);

            var x = sign * L.k * m.step;

            // 整张卡都在舞台外 -> 直接收起。避免边缘出现互相压叠的一堆卡。
            var halfW = (m.cardW * L.s) / 2;
            var outOfView = Math.abs(x) - halfW > half + 8;

            el.style.transitionDelay = (dealing ? ad * 60 : 0) + 'ms';
            el.style.transform = 'translate3d(' + x.toFixed(1) + 'px, ' + L.y + 'px, ' + L.z + 'px)' +
                ' rotateY(' + (-sign * L.ry) + 'deg) scale(' + L.s + ')';
            el.style.opacity = outOfView ? '0' : '1';
            el.style.filter = 'brightness(' + L.b + ')';
            el.style.zIndex = String(90 - ad);
            el.style.pointerEvents = outOfView ? 'none' : 'auto';
            el.classList.toggle('is-center', d === 0);
        });

        updateArrows();
    }

    function updateArrows() {
        if (btnPrev) btnPrev.disabled = state.center <= 0;
        if (btnNext) btnNext.disabled = state.center >= state.movies.length - 1;
    }

    // 中心卡的一次琥珀色呼吸（替代原来「帽子喷金粉」的仪式感）
    function pulse() {
        var el = centerCard();
        if (!el) return;
        el.classList.remove('pulse');
        void el.offsetWidth;
        el.classList.add('pulse');
        setTimeout(function () { el.classList.remove('pulse'); }, 760);
    }

    // ---------- 抽牌 ----------

    function deal(isInitial) {
        if (!deck || state.loading) return Promise.resolve();
        state.loading = true;
        if (btnMore) btnMore.classList.add('busy');
        state.failed = false;

        // 首次抽取可能要走 AI 推荐（后端最多等 9 秒），先给个交代
        if (isInitial && !cards().length) {
            deck.innerHTML = '<div class="magic-empty"><div class="ico">✨</div>' +
                '<div>正在挑片…</div></div>';
        }

        var pre = Promise.resolve();

        if (!isInitial && state.movies.length) {
            // 把现有卡片收回卡堆
            cards().forEach(function (el) {
                el.style.transition = 'transform .4s cubic-bezier(.55,0,.85,.3), opacity .3s ease';
                el.style.transitionDelay = '0ms';
                el.style.transform = DECK_POSE;
                el.style.opacity = '0';
                el.classList.remove('is-center');
            });
            pre = wait(400);
        }

        return pre
            .then(function () { return fetchBatch(BATCH); })
            .then(function (movies) {
                if (!movies.length) {
                    // 全库都被排除过了 -> 清空重来，避免一直空着
                    state.exclude = [];
                    state.excludeSet = {};
                    return fetchBatch(BATCH);
                }
                return movies;
            })
            .then(function (movies) {
                if (!movies || !movies.length) {
                    state.failed = true;
                    if (deck) {
                        deck.innerHTML = '<div class="magic-empty"><div class="ico">🎬</div>' +
                            '<div>还没有可以推荐的影片</div>' +
                            '<div style="font-size:12px;">先扫描一些影片进来吧</div></div>';
                    }
                    return;
                }

                state.movies = movies;
                state.center = Math.floor(movies.length / 2);
                renderCards();

                return twoFrames().then(function () {
                    layout(true);
                    if (!isInitial) pulse();
                    // 展开动画结束后清掉延迟，否则后续切换会拖泥带水
                    setTimeout(function () {
                        cards().forEach(function (el) { el.style.transitionDelay = '0ms'; });
                    }, 1100);
                });
            })
            .then(function () {
                state.loading = false;
                if (btnMore) btnMore.classList.remove('busy');
            });
    }

    function go(delta) {
        var n = state.movies.length;
        if (!n) return;
        var next = Math.max(0, Math.min(n - 1, state.center + delta));
        if (next === state.center) return;
        state.center = next;
        cards().forEach(function (el) { el.style.transitionDelay = '0ms'; });
        layout();
    }

    // ---------- 播放 ----------

    function play(movie) {
        if (!movie) return;
        // 防抖：松手时的 tap 判定与 deck 的 click 兜底可能同时触发同一次点击
        var now = Date.now();
        if (now - lastPlayAt < 400) return;
        lastPlayAt = now;
        if (typeof playMovieInline === 'function') {
            playMovieInline(movie.id);
        } else if (typeof showMovieDetail === 'function') {
            showMovieDetail(movie.id);
        } else if (typeof showNotification === 'function') {
            showNotification('无法播放', '播放器还没准备好');
        }
    }

    // ---------- 事件 ----------

    function bindOnce() {
        if (bound || !stage) return;
        bound = true;

        // 指针拖动（鼠标 + 触摸统一走 pointer 事件）
        stage.addEventListener('pointerdown', function (e) {
            if (e.target.closest && e.target.closest('.magic-btn')) return;
            if (e.button && e.button !== 0) return;
            drag = { x0: e.clientX, moved: 0, active: true, t0: Date.now() };
            stage.classList.add('dragging');
            try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        });

        stage.addEventListener('pointermove', function (e) {
            if (!drag || !drag.active) return;
            drag.moved = e.clientX - drag.x0;
            if (deck) deck.style.transform = 'translate3d(' + (drag.moved * 0.28).toFixed(1) + 'px, 0, 0)';
        });

        /**
         * 松手结算。
         * 【为什么要在这里判定「点击」】setPointerCapture 之后浏览器会把后续
         * 鼠标事件的 target 重定向到 stage，于是 click 的 e.target 是 stage
         * 而不是卡片，closest('.magic-card') 永远拿不到 -> 点卡片没反应。
         * 所以用 elementFromPoint 按坐标自己找卡片。
         */
        function endDrag(e) {
            if (!drag || !drag.active) return;
            var d = drag;
            d.active = false;
            drag = null;

            stage.classList.remove('dragging');
            if (deck) deck.style.transform = '';

            var dx = d.moved;
            var isTap = Math.abs(dx) <= 8 && (Date.now() - d.t0) < 700;

            if (Math.abs(dx) > 10) {
                suppressClick = true;
                setTimeout(function () { suppressClick = false; }, 90);
            }

            if (Math.abs(dx) > 52) {
                var step = Math.max(1, Math.round(Math.abs(dx) / 120));
                go(dx > 0 ? -step : step);
                return;
            }

            if (isTap && e && typeof e.clientX === 'number') {
                var hit = document.elementFromPoint(e.clientX, e.clientY);
                var card = hit && hit.closest && hit.closest('.magic-card');
                if (card) {
                    var idx = parseInt(card.dataset.idx, 10);
                    if (Number.isFinite(idx)) play(state.movies[idx]);
                }
            }
        }

        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);
        stage.addEventListener('pointerleave', function () { if (drag && drag.active) endDrag(); });

        // 滚轮：横向或纵向都切卡（纵向占多数，做成「往下刷」的手感）
        stage.addEventListener('wheel', function (e) {
            var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (Math.abs(d) < 4) return;
            e.preventDefault();
            var now = Date.now();
            if (now - wheelLock < 280) return;
            wheelLock = now;
            go(d > 0 ? 1 : -1);
        }, { passive: false });

        // 点击卡片 = 直接播放
        deck.addEventListener('click', function (e) {
            if (suppressClick) return;
            var card = e.target.closest && e.target.closest('.magic-card');
            if (!card) return;
            var idx = parseInt(card.dataset.idx, 10);
            if (!Number.isFinite(idx)) return;
            play(state.movies[idx]);
        });

        if (btnMore) btnMore.addEventListener('click', function () { deal(false); });
        if (btnPrev) btnPrev.addEventListener('click', function () { go(-1); });
        if (btnNext) btnNext.addEventListener('click', function () { go(1); });
        if (btnList) btnList.addEventListener('click', function () {
            if (typeof switchView === 'function') switchView('guess-grid');
        });

        // 键盘（仅本视图可见时接管，输入框内不抢键）
        window.addEventListener('keydown', function (e) {
            if (!view || !view.classList.contains('show')) return;
            var tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        });

        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                if (view && view.classList.contains('show')) layout();
            }, 160);
        });
    }

    // ---------- 对外 ----------

    function open() {
        view = document.getElementById('magicView');
        if (!view) return;
        ensureSkeleton();
        // 清掉 switchView 留下的内联 display:none，否则会盖住 .show 的 flex 布局
        view.style.display = '';
        requestAnimationFrame(function () { view.classList.add('show'); });
        bindOnce();

        if (!state.movies.length) {
            deal(true);
        } else {
            // 再次进入时重演一次展开
            renderCards();
            twoFrames().then(function () {
                layout(true);
                setTimeout(function () {
                    cards().forEach(function (el) { el.style.transitionDelay = '0ms'; });
                }, 1100);
            });
        }
    }

    function close() {
        if (!view) return;
        view.classList.remove('show');
        view.style.display = 'none';
    }

    function refresh() { return deal(false); }

    window.MagicLikes = {
        open: open,
        close: close,
        refresh: refresh,
        deal: deal,
        go: go,
        state: state
    };
})();
