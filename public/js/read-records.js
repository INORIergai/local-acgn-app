/* ============================================================================
   read-records.js —— 小说 / 漫画「阅读记录中心」
   ----------------------------------------------------------------------------
   侧栏「档案与清单 → 小说阅读记录 / 漫画阅读记录」的渲染器。
   数据来源（全部只读组合，不改后端形状）：
     /api/media/digest?type=&days=14      今日/连续/近 14 天曲线/目标
     /api/{type}/stats/overview?days=30   累计时长/次数/榜单
     /api/{type}/tree + /api/media/progress-map?type=   最近阅读（按 updatedAt）
     /api/media/notes?kind=&limit=8       书摘回顾
     /api/media/notes/stats?kind=         书摘总数/涉及书目
     POST /api/media/reading-report        AI 阅读简报
   ========================================================================== */
(function () {
    'use strict';
    if (window.ReadRecords && window.ReadRecords.__v1) return;

    var RR = {};
    RR.__v1 = true;
    window.ReadRecords = RR;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function getJSON(url) {
        return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    }
    function fmtMin(sec) {
        var m = Math.round((Number(sec) || 0) / 60);
        if (m < 60) return m + '<i>分钟</i>';
        var h = Math.floor(m / 60), mm = m % 60;
        return h + '<i>小时</i>' + (mm ? ' ' + mm + '<i>分</i>' : '');
    }
    function fmtDate(ms) {
        var t = Number(ms) || 0;
        if (!t) return '';
        var d = new Date(t);
        return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }
    function relTime(ms) {
        var t = Number(ms) || 0;
        if (!t) return '';
        var d = Date.now() - t;
        if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + ' 分钟前';
        if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前';
        if (d < 30 * 86400e3) return Math.round(d / 86400e3) + ' 天前';
        return fmtDate(t);
    }
    function posterOf(it) {
        if (typeof window.getPosterUrl === 'function') {
            try { return window.getPosterUrl(it) || ''; } catch (e) { /* ignore */ }
        }
        var p = it && (it.posterPath || '');
        if (/^https?:\/\//i.test(p)) return '/api/movie/poster/proxy?url=' + encodeURIComponent(p);
        return p ? '/api/movie/poster/' + encodeURIComponent(p) : '';
    }

    var QUOTES = {
        novel: [
            ['读书不是为了雄辩和驳斥，也不是为了轻信和盲从，而是为了思考和权衡。', '弗朗西斯·培根'],
            ['我们读书，因为我们孤单；我们读书，然后就不孤单。', '《岛上书店》'],
            ['一本书就是一个世界。在阅读时，每个人都能轻而易举地接纳多重世界。', '《阅读是一座随身携带的避难所》'],
            ['阅读不是为了让我们变得博学，而是为了让我们变得更好。', '《如何阅读一本书》']
        ],
        comic: [
            ['分镜之间留出的那一格空白，才是读者呼吸的地方。', '漫画分镜笔记'],
            ['一格画面能说清的事，就不要用两格。', '手冢治虫'],
            ['故事结束的地方，读者的想象才刚刚开始。', '《理解漫画》'],
            ['线条是情绪的延长线。', '漫画速写笔记']
        ]
    };

    var S = { type: null, seq: 0, loading: false, d: null };

    function root() { return document.getElementById('recordsView'); }

    /* ---- 数据整理 ---- */
    function flatten(node, out) {
        out = out || [];
        (node.items || []).forEach(function (it) { out.push(it); });
        (node.children || []).forEach(function (c) { flatten(c, out); });
        return out;
    }
    function buildRecent(tree, pmap) {
        var list = flatten(tree || { items: [], children: [] });
        var rows = [];
        list.forEach(function (it) {
            var p = pmap && pmap[it.id];
            if (!p || !p.u) return;
            rows.push({
                id: it.id,
                title: it.title || it.displayTitle || it.fileName || '未命名',
                cover: posterOf(it),
                percent: Math.max(0, Math.min(100, Number(p.p) || 0)),
                state: p.s || 'reading',
                cursor: Number(p.c) || 0,
                total: Number(p.t) || 0,
                updatedAt: Number(p.u) || 0
            });
        });
        rows.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        return rows;
    }

    /* ---- 渲染 ---- */
    function pageHtml() {
        var d = S.d || {};
        var type = S.type;
        var label = type === 'comic' ? '漫画' : '小说';
        var today = d.digest && d.digest.today || { seconds: 0, books: 0 };
        var goal = (d.digest && d.digest.goal) || { minutes: 10, books: 5, minutesPct: 0, booksPct: 0 };
        var streak = (d.digest && d.digest.streakDays) || 0;
        var total = (d.digest && d.digest.total) || { seconds: 0, books: 0 };
        var overview = d.overview || {};
        var recent = d.recent || [];
        var notes = d.notes || [];
        var noteStats = d.noteStats || { total: 0, books: 0, recent: 0 };
        var inReading = recent.filter(function (r) { return r.state === 'reading'; }).length;
        var quote = (QUOTES[type] || QUOTES.novel)[Math.floor(Math.random() * 4)];

        var pct = Math.max(0, Math.min(100, Number(goal.minutesPct) || 0));
        var minsToday = Math.round((Number(today.seconds) || 0) / 60);

        var bars = (d.digest && d.digest.days) || [];
        var maxSec = 1;
        bars.forEach(function (b) { if ((b.seconds || 0) > maxSec) maxSec = b.seconds; });

        return '<div class="rr-page" data-rr-type="' + esc(type) + '">'
            + '<header class="rr-head">'
            + '<p class="rr-kicker">READING LOG · ' + (type === 'comic' ? 'MANGA' : 'NOVEL') + '</p>'
            + '<h1 class="rr-title">' + label + '阅读记录</h1>'
            + '<p class="rr-sub">读过的每一分钟、写下的每一句，都留在这里。</p>'
            + '</header>'

            + '<section class="rr-hero">'
            + '<div class="rr-today">'
            + '<div class="rr-ring" style="--p:' + pct + '">'
            + '<div class="rr-ring-in"><b data-count="' + minsToday + '">0</b><span>分钟</span></div>'
            + '</div>'
            + '<div class="rr-today-body">'
            + '<p class="rr-today-k">TODAY · 今日阅读</p>'
            + '<h2>今天已读 <b data-count="' + minsToday + '">0</b> 分钟</h2>'
            + '<p class="rr-today-p">目标 ' + (goal.minutes || 10) + ' 分钟 · 已完成 ' + pct + '%'
            + (today.books ? ' · 读完 ' + today.books + ' 本' : '') + '</p>'
            + '<div class="rr-today-bar"><i style="width:' + pct + '%"></i></div>'
            + '<div class="rr-streak">🔥 连续阅读 <b>' + streak + '</b> 天</div>'
            + '</div></div>'

            + '<div class="rr-ai">'
            + '<p class="rr-ai-k">AI · 阅读简报</p>'
            + '<div class="rr-ai-text" id="rrAiText">近 ' + Math.round((Number(total.seconds) || 0) / 60) + ' 分钟、'
            + (total.books || 0) + ' 本读完' + (streak ? '、连续 ' + streak + ' 天' : '') + '。让 AI 帮你写一段这段时间的阅读小结。</p>'
            + '<button class="rr-ai-btn" id="rrAiBtn">✨ 生成阅读简报</button>'
            + '</div>'
            + '</section>'

            + '<section class="rr-cards">'
            + cardHtml('累计阅读', fmtMin(overview.totalSeconds || total.seconds), (overview.sessionCount || 0) + ' 次阅读')
            + cardHtml('最近阅读', recent[0] ? esc(recent[0].title) : '还没有记录', recent[0] ? relTime(recent[0].updatedAt) : '从一本开始')
            + cardHtml('在读', String(inReading), '本' + label)
            + cardHtml('书摘', String(noteStats.total || 0), '涉及 ' + (noteStats.books || 0) + ' 本')
            + '</section>'

            + '<section class="rr-section">'
            + '<div class="rr-sec-head"><h2>最近阅读</h2><span>' + recent.length + ' 本</span></div>'
            + (recent.length ? '<div class="rr-recent">' + recent.slice(0, 6).map(recentRowHtml).join('') + '</div>'
                : '<div class="rr-empty">还没有阅读记录，去' + label + '库挑一本开始。</div>')
            + '</section>'

            + '<section class="rr-section">'
            + '<div class="rr-sec-head"><h2>近 14 天</h2><span>每天读多久</span></div>'
            + '<div class="rr-chart">' + bars.map(function (b) {
                var h = Math.round(((b.seconds || 0) / maxSec) * 100);
                return '<div class="rr-bar" title="' + esc(b.date) + ' · ' + Math.round((b.seconds || 0) / 60) + ' 分钟">'
                    + '<i style="height:' + Math.max(3, h) + '%"></i><span>' + esc(String(b.date || '').slice(-2)) + '</span></div>';
            }).join('') + '</div>'
            + '</section>'

            + '<section class="rr-section">'
            + '<div class="rr-sec-head"><h2>书摘回顾</h2><span>' + (noteStats.total || 0) + ' 条 · 近 7 天新增 ' + (noteStats.recent || 0) + ' 条</span></div>'
            + (notes.length ? '<div class="rr-quotes">' + notes.map(noteCardHtml).join('') + '</div>'
                : '<div class="rr-empty">阅读时选中文字 → 点「摘抄」，句子会出现在这里。</div>')
            + '</section>'

            + '<section class="rr-section rr-quote-day">'
            + '<p class="rr-qd-k">今日一句</p>'
            + '<blockquote>' + esc(quote[0]) + '</blockquote>'
            + '<cite>— ' + esc(quote[1]) + '</cite>'
            + '</section>'
            + '</div>';
    }

    function cardHtml(k, v, sub) {
        var isText = /[^\d\s.]/.test(String(v).replace(/<[^>]+>/g, ''));
        var inner = isText
            ? '<b class="rr-card-t">' + v + '</b>'
            : '<b data-count="' + (parseInt(String(v).replace(/[^\d]/g, ''), 10) || 0) + '">0</b>';
        return '<div class="rr-card"><p class="rr-card-k">' + esc(k) + '</p>' + inner
            + '<p class="rr-card-s">' + sub + '</p></div>';
    }

    function recentRowHtml(r) {
        var label = S.type === 'comic'
            ? '第 ' + (r.cursor + 1) + (r.total ? ' / ' + r.total + ' 页' : ' 页')
            : '第 ' + (r.cursor + 1) + (r.total ? ' / ' + r.total + ' 章' : ' 章');
        return '<article class="rr-row" data-rr-id="' + r.id + '" tabindex="0" role="button">'
            + '<div class="rr-row-cover">' + (r.cover ? '<img loading="lazy" src="' + esc(r.cover) + '" alt="">' : '<span>' + (S.type === 'comic' ? '漫' : '书') + '</span>') + '</div>'
            + '<div class="rr-row-body"><h3>' + esc(r.title) + '</h3>'
            + '<p>' + esc(label) + ' · ' + esc(relTime(r.updatedAt)) + '</p>'
            + '<div class="rr-row-bar"><i style="width:' + r.percent + '%"></i></div></div>'
            + '<button class="rr-row-go" data-rr-open="' + r.id + '">继续 ›</button>'
            + '</article>';
    }

    function noteCardHtml(n) {
        return '<article class="rr-quote" data-note-id="' + esc(n.id) + '">'
            + '<p class="rr-q-text">「' + esc(String(n.quote || '').slice(0, 180)) + '」</p>'
            + (n.note ? '<p class="rr-q-note">' + esc(String(n.note).slice(0, 120)) + '</p>' : '')
            + '<footer><span>' + esc(n.bookTitle || '') + (n.chapterTitle ? ' · ' + esc(n.chapterTitle) : '') + '</span>'
            + '<button class="rr-q-del" data-note-del="' + esc(n.id) + '" title="删除这条书摘">✕</button></footer>'
            + '</article>';
    }

    /* ---- 动效：数字 count-up ---- */
    function countUp(el) {
        var target = Number(el.getAttribute('data-count')) || 0;
        var start = performance.now();
        var dur = 700;
        function tick(now) {
            var t = Math.min(1, (now - start) / dur);
            var eased = 1 - Math.pow(1 - t, 3);
            el.textContent = String(Math.round(target * eased));
            if (t < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    }

    function bind() {
        var r = root();
        if (!r) return;
        r.querySelectorAll('[data-count]').forEach(function (el) { if (!el.__counted) { el.__counted = 1; countUp(el); } });

        r.querySelectorAll('.rr-row').forEach(function (row) {
            row.addEventListener('click', function () { open(Number(row.getAttribute('data-rr-id'))); });
            row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(Number(row.getAttribute('data-rr-id'))); } });
        });
        r.querySelectorAll('[data-note-del]').forEach(function (b) {
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = b.getAttribute('data-note-del');
                fetch('/api/media/notes/' + id, { method: 'DELETE' }).then(function (x) { return x.json(); }).then(function (j) {
                    if (j && j.code === 0) {
                        var card = b.closest('.rr-quote');
                        if (card) { card.classList.add('rr-quote-out'); setTimeout(function () { card.remove(); }, 220); }
                    }
                }).catch(function () { });
            });
        });
        var aiBtn = r.querySelector('#rrAiBtn');
        if (aiBtn) aiBtn.addEventListener('click', genReport);
    }

    function open(id) {
        if (!id) return;
        if (S.type === 'comic' && typeof window.openComicReader === 'function') window.openComicReader(id);
        else if (typeof window.openNovelReader === 'function') window.openNovelReader(id);
    }

    function genReport() {
        var btn = root() && root().querySelector('#rrAiBtn');
        var out = root() && root().querySelector('#rrAiText');
        if (btn) { btn.disabled = true; btn.textContent = '正在生成…'; }
        fetch('/api/media/reading-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: S.type, days: 14 })
        }).then(function (r) { return r.json(); }).then(function (j) {
            if (out) out.textContent = (j && j.code === 0 && j.data && j.data.text) || '暂时生成不出来，稍后再试。';
            if (j && j.code === 0 && typeof showNotification === 'function') showNotification('阅读简报已生成', '');
        }).catch(function () {
            if (out) out.textContent = '生成失败，请检查 AI 配置或网络。';
        }).then(function () {
            if (btn) { btn.disabled = false; btn.textContent = '✨ 再生成一次'; }
        });
    }

    RR.mount = async function (type) {
        if (type !== 'comic' && type !== 'novel') return false;
        S.type = type;
        var my = ++S.seq;
        var r = root();
        if (r) r.innerHTML = '<div class="rr-page"><div class="rr-loading">正在整理阅读记录…</div></div>';
        try {
            var res = await Promise.all([
                getJSON('/api/media/digest?type=' + type + '&days=14').catch(function () { return null; }),
                getJSON('/api/media/notes?kind=' + type + '&limit=8').catch(function () { return null; }),
                getJSON('/api/media/notes/stats?kind=' + type).catch(function () { return null; }),
                getJSON('/api/' + type + '/tree').catch(function () { return null; }),
                getJSON('/api/media/progress-map?type=' + type).catch(function () { return null; }),
                getJSON('/api/' + type + '/stats/overview?days=30').catch(function () { return null; })
            ]);
            if (my !== S.seq) return false;
            var tree = res[3] && res[3].code === 0 && res[3].data ? res[3].data.tree : null;
            var pmap = res[4] && res[4].code === 0 ? res[4].data : null;
            S.d = {
                digest: res[0] && res[0].code === 0 ? res[0].data : null,
                notes: res[1] && res[1].code === 0 ? res[1].data : [],
                noteStats: res[2] && res[2].code === 0 ? res[2].data : { total: 0, books: 0, recent: 0 },
                tree: tree,
                overview: res[5] && res[5].code === 0 ? res[5].data : null,
                recent: buildRecent(tree, pmap)
            };
            if (r) { r.innerHTML = pageHtml(); bind(); }
            return true;
        } catch (e) {
            if (r) r.innerHTML = '<div class="rr-page"><div class="rr-empty">阅读记录加载失败：' + esc(e.message) + '</div></div>';
            return false;
        }
    };

    RR.refresh = function () { return RR.mount(S.type || 'novel'); };
})();