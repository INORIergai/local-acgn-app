/* ============================================================================
   round153-folia.js —— 「随机推荐 · 海报磁贴无限画布流」
   ----------------------------------------------------------------------------
   参考：docs/reports/round113-folia-design-teardown.md（Folia 逆向）
   做法：48 个常驻槽位的环形虚拟网格 + translate3d 平移 + 惯性 + 光标锚点缩放。
   全程零重排、DOM 恒定 48 个；滑出视野的槽位环绕补位并换绑新作品。
   ============================================================================ */
(function () {
    'use strict';

    /* r153b：海报直接吸在一起的「无缝拼贴」布局。
       每一行用 20 个半列单位（1 单位 = 118px）恰好铺满 2360px，行高不等；
       每块磁贴都完整落在 [0,TOTAL_W]×[0,TOTAL_H) 内，因此按 TOTAL 周期环绕时
       不会出现接缝或空洞 —— 海报与海报边缘直接相接，没有 margin/gap。 */
    var UNIT_W = 118;
    var ROW_SPEC = [
        { h: 300, u: [4, 4, 4, 4, 4] },
        { h: 220, u: [3, 3, 4, 4, 3, 3] },
        { h: 360, u: [3, 4, 3, 4, 3, 3] },
        { h: 260, u: [5, 5, 5, 5] },
        { h: 440, u: [3, 3, 3, 3, 4, 4] },
        { h: 240, u: [2, 3, 3, 4, 2, 2, 4] },
        { h: 320, u: [4, 3, 3, 3, 3, 4] },
        { h: 200, u: [4, 4, 4, 4, 4] },
        { h: 380, u: [3, 4, 3, 4, 3, 3] },
        { h: 260, u: [5, 3, 4, 4, 4] }
    ];
    var LAYOUT = (function () {
        var out = [], y = 0;
        for (var r = 0; r < ROW_SPEC.length; r++) {
            var row = ROW_SPEC[r], x = 0;
            for (var c = 0; c < row.u.length; c++) {
                var w = row.u[c] * UNIT_W;
                out.push({ x: x, y: y, w: w, h: row.h });
                x += w;
            }
            y += row.h;
        }
        return out;
    })();
    var TOTAL_W = 20 * UNIT_W;
    var TOTAL_H = ROW_SPEC.reduce(function (n, r) { return n + r.h; }, 0);
    var MIN_SCALE = 0.65;
    var MAX_SCALE = 1.45;
    var MOMENTUM = 0.93;

    var inst = null;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function reduced() {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }

    function inkFor(seed) {
        var s = String(seed || ''), h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return 'hsl(' + (h % 360) + ' 62% 62%)';
    }

    function isWide(m) {
        var t = (m && m.type) || 'jav';
        return t !== 'novel' && t !== 'comic';
    }

    function labelOf(m) {
        var t = (m && m.type) || 'jav';
        return ({ novel: '小说', comic: '漫画', anime: '动漫', jav: '影片', film: '影视' })[t] || t;
    }

    function buildTile(i) {
        var el = document.createElement('article');
        el.className = 'r153-tile';
        el.tabIndex = 0;
        el.innerHTML =
            '<div class="r153-tile-img"><img alt="" loading="lazy" decoding="async"></div>' +
            '<div class="r153-tile-meta"><b></b><span></span></div>';
        el.dataset.slot = i;
        return el;
    }

    function fillTile(el, m) {
        var img = el.querySelector('img');
        var b = el.querySelector('b');
        var sp = el.querySelector('span');
        var poster = '';
        try { poster = (typeof getPosterUrl === 'function' && getPosterUrl(m)) || m.posterPath || ''; } catch (e) { poster = ''; }
        if (img.getAttribute('src') !== poster) img.src = poster || '';
        el.style.setProperty('--cover', poster ? 'url("' + poster.replace(/"/g, '%22') + '")' : 'none');
        img.alt = m.title || '';
        b.textContent = m.title || m.fileName || m.avid || '未命名';
        sp.textContent = labelOf(m) + (m.releaseDate ? ' · ' + String(m.releaseDate).slice(0, 4) : '');
        el.classList.toggle('is-wide', isWide(m));
        el.classList.toggle('is-tall', !isWide(m));
        el.classList.toggle('is-book', !isWide(m));
        el.classList.toggle('is-focus', (el.dataset.slot | 0) % 13 === 4);
        el.style.setProperty('--ink', inkFor(m.title || m.id));
        el.dataset.id = m.id;
    }

    function openItem(m) {
        if (!m) return;
        if (typeof window.showMovieDetail === 'function') window.showMovieDetail(m.id);
    }

    function playItem(m) {
        if (!m) return;
        var t = m.type || 'jav';
        if (t === 'comic' && typeof window.openComicReader === 'function') return window.openComicReader(m.id);
        if (t === 'novel' && typeof window.openNovelReader === 'function') return window.openNovelReader(m.id);
        if (typeof window.playMovieInline === 'function') return window.playMovieInline(m.id);
        openItem(m);
    }

    function mount(host, movies, opts) {
        destroy();
        host.innerHTML = '';
        host.classList.add('r153-folia');
        host.tabIndex = 0;
        host.setAttribute('role', 'application');
        host.setAttribute('aria-label', '随机推荐无限画布：拖拽平移，滚轮缩放，方向键移动，回车打开');

        var stage = document.createElement('div');
        stage.className = 'r153-folia-stage';
        host.appendChild(stage);

        var hud = document.createElement('div');
        hud.className = 'r153-folia-hud';
        hud.innerHTML = '<span>🧱 拖拽漫游 · 滚轮缩放 · 双击起播</span><span class="r153-zoom">100%</span>';
        host.appendChild(hud);

        var api = opts && opts.api ? opts.api : null;
        var pool = (movies || []).slice();
        var st = {
            host: host, stage: stage, pool: pool, api: api,
            camX: 0, camY: 0, scale: 1,
            vx: 0, vy: 0, dragging: false, moved: 0,
            last: null, lastAt: 0, raf: 0, abort: null, cursor: 0,
            tiles: [], endCursor: 0
        };
        inst = st;

        for (var i = 0; i < LAYOUT.length; i++) {
            var el = buildTile(i);
            el.style.width = LAYOUT[i].w + 'px';
            el.style.height = LAYOUT[i].h + 'px';
            st.tiles.push({ el: el, epoch: 0, idx: -1 });
            stage.appendChild(el);
        }
        /* 手机上先缩小一点，保证一屏能看见 2~3 张，而不是一张半。 */
        st.scale = Math.max(0.55, Math.min(1, (host.clientWidth || 1200) / 1250));
        bind(st, hud);
        assign(st, true);
        layout(st);
        st.raf = requestAnimationFrame(function () { loop(st, hud); });
        return st;
    }

    function assign(st, force) {
        var n = st.pool.length;
        if (!n) return;
        for (var i = 0; i < st.tiles.length; i++) {
            var t = st.tiles[i];
            if (force || t.idx < 0) {
                t.idx = st.cursor++ % n;
                fillTile(t.el, st.pool[t.idx]);
            }
        }
    }

    function refresh(st) {
        st.pool = (st.api ? st.api() : st.pool) || st.pool || [];
        for (var i = 0; i < st.tiles.length; i++) {
            var t = st.tiles[i];
            if (!st.pool.length) { t.el.style.display = 'none'; continue; }
            t.el.style.display = '';
            t.idx = st.cursor++ % st.pool.length;
            fillTile(t.el, st.pool[t.idx]);
        }
    }

    function wrapNear(v, total) {
        // 映射到 [-total/2, total/2)
        return ((v + total / 2) % total + total) % total - total / 2;
    }

    function layout(st) {
        var vw = st.host.clientWidth || 1200;
        var vh = st.host.clientHeight || 620;
        var s = st.scale;
        for (var i = 0; i < st.tiles.length; i++) {
            var L = LAYOUT[i];
            var x0 = L.x;
            var y0 = L.y;
            var wx = wrapNear(x0 - st.camX, TOTAL_W);
            var wy = wrapNear(y0 - st.camY, TOTAL_H);
            var t = st.tiles[i];
            var el = t.el;
            var x = wx * s + vw / 2;
            var y = wy * s + vh / 2;
            el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + s + ')';
            var epoch = Math.floor((st.camX - x0) / TOTAL_W) + Math.floor((st.camY - y0) / TOTAL_H) * 3;
            if (epoch !== t.epoch && st.pool.length) {
                t.epoch = epoch;
                t.idx = st.cursor++ % st.pool.length;
                fillTile(el, st.pool[t.idx]);
            }
        }
        var z = st.host.querySelector('.r153-zoom');
        if (z) z.textContent = Math.round(s * 100) + '%';
    }

    function bind(st, hud) {
        var ac = new AbortController();
        st.abort = ac;
        var sig = { signal: ac.signal };
        var host = st.host;

        host.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            if (e.target.closest && e.target.closest('img')) { /* 仍允许拖拽 */ }
            st.dragging = true;
            st.moved = 0;
            st.vx = st.vy = 0;
            st.last = { x: e.clientX, y: e.clientY, t: performance.now() };
            st.lastAt = st.last.t;
            host.setPointerCapture && host.setPointerCapture(e.pointerId);
            host.classList.add('is-dragging');
        }, sig);

        host.addEventListener('pointermove', function (e) {
            if (!st.dragging) return;
            var now = performance.now();
            var dx = e.clientX - st.last.x;
            var dy = e.clientY - st.last.y;
            var dt = Math.max(8, now - st.last.t);
            st.moved += Math.abs(dx) + Math.abs(dy);
            st.camX -= dx / st.scale;
            st.camY -= dy / st.scale;
            st.vx = -dx / st.scale / dt * 16;
            st.vy = -dy / st.scale / dt * 16;
            st.last = { x: e.clientX, y: e.clientY, t: now };
            layout(st);
        }, sig);

        function endDrag(e) {
            if (!st.dragging) return;
            st.dragging = false;
            host.classList.remove('is-dragging');
            if (st.moved < 8) { st.vx = st.vy = 0; return; }
            if (reduced()) { st.vx = st.vy = 0; }
            if (e && e.pointerId != null && host.releasePointerCapture) {
                try { host.releasePointerCapture(e.pointerId); } catch (err) { }
            }
        }
        host.addEventListener('pointerup', endDrag, sig);
        host.addEventListener('pointercancel', endDrag, sig);

        host.addEventListener('wheel', function (e) {
            e.preventDefault();
            var rect = host.getBoundingClientRect();
            var cx = e.clientX - rect.left - rect.width / 2;
            var cy = e.clientY - rect.top - rect.height / 2;
            var old = st.scale;
            var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, old * (e.deltaY > 0 ? 0.92 : 1.08)));
            if (next === old) return;
            st.camX += cx / old - cx / next;
            st.camY += cy / old - cy / next;
            st.scale = next;
            layout(st);
        }, Object.assign({ passive: false }, sig));

        host.addEventListener('click', function (e) {
            var el = e.target.closest && e.target.closest('.r153-tile');
            if (!el) return;
            if (st.moved >= 8) return;
            var t = st.tiles.find(function (x) { return x.el === el; });
            if (t && st.pool[t.idx]) openItem(st.pool[t.idx]);
        }, sig);

        host.addEventListener('dblclick', function (e) {
            var el = e.target.closest && e.target.closest('.r153-tile');
            if (!el) return;
            var t = st.tiles.find(function (x) { return x.el === el; });
            if (t && st.pool[t.idx]) { e.preventDefault(); playItem(st.pool[t.idx]); }
        }, sig);

        host.addEventListener('keydown', function (e) {
            var pan = 60;
            if (e.key === 'ArrowLeft') { st.camX -= pan; }
            else if (e.key === 'ArrowRight') { st.camX += pan; }
            else if (e.key === 'ArrowUp') { st.camY -= pan; }
            else if (e.key === 'ArrowDown') { st.camY += pan; }
            else if (e.key === 'Enter' && document.activeElement === host) {
                e.preventDefault();
                var first = st.pool[st.tiles[0].idx];
                if (first) openItem(first);
                return;
            } else if (e.key === '+' || e.key === '=') { st.scale = Math.min(MAX_SCALE, st.scale * 1.08); }
            else if (e.key === '-') { st.scale = Math.max(MIN_SCALE, st.scale * 0.92); }
            else return;
            e.preventDefault();
            layout(st);
        }, sig);

        host.addEventListener('focusin', function (e) {
            var el = e.target.closest && e.target.closest('.r153-tile');
            if (!el) return;
            el.classList.add('is-hot');
        }, sig);
        host.addEventListener('focusout', function (e) {
            var el = e.target.closest && e.target.closest('.r153-tile');
            if (el) el.classList.remove('is-hot');
        }, sig);

        host.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var el = e.target.closest && e.target.closest('.r153-tile');
            if (!el) return;
            e.preventDefault();
            var t = st.tiles.find(function (x) { return x.el === el; });
            if (t && st.pool[t.idx]) openItem(st.pool[t.idx]);
        }, sig);
    }

    function loop(st, hud) {
        if (!inst || inst !== st) return;
        if (!st.host.isConnected) { destroy(); return; }
        if (!st.dragging && (Math.abs(st.vx) > 0.05 || Math.abs(st.vy) > 0.05)) {
            st.camX += st.vx / st.scale;
            st.camY += st.vy / st.scale;
            st.vx *= MOMENTUM;
            st.vy *= MOMENTUM;
            layout(st);
        }
        st.raf = requestAnimationFrame(function () { loop(st, hud); });
    }

    function destroy() {
        if (!inst) return;
        cancelAnimationFrame(inst.raf);
        if (inst.abort) inst.abort.abort();
        inst = null;
    }

    window.CVFolia = {
        mount: function (host, movies, opts) { return mount(host, movies, opts); },
        refresh: function (movies) {
            if (!inst) return;
            inst.pool = movies || inst.pool;
            refresh(inst);
        },
        destroy: destroy,
        isMounted: function () { return !!inst; }
    };
})();
