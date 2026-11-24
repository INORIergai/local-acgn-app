/* ============================================================================
   read-workspace.js —— 漫画库 / 小说库「书架工作台」（推倒重做版）
   ----------------------------------------------------------------------------
   替换 av-board 的「左树 + 右主区 + 统计浮层」拼贴结构。保留的能力：
   文件夹 drill-down/面包屑、续读、随机一本、状态筛选、排序、网格/列表、
   批量状态、详情抽屉、阅读器跳转、本地/网盘切换入口（由外层工具栏提供）。
   数据结构见 /api/{comic|novel}/tree 与 /api/media/progress-map|resume|stats。
   ========================================================================== */
(function () {
    'use strict';

    if (window.RW && window.RW.__v2) return;

    var RW = {};
    RW.__v2 = true;
    window.RW = RW;

    /* ---------------- 基础工具 ---------------- */
    var FOLDER_SVG = '<svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.6h5.2l1.5 2.1H16v7.1H2z"/></svg>';
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function fmtSize(n) {
        var b = Number(n) || 0;
        if (b <= 0) return '';
        if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
        if (b >= 1048576) return (b / 1048576).toFixed(0) + ' MB';
        return Math.max(1, Math.round(b / 1024)) + ' KB';
    }
    function relTime(ms) {
        var t = Number(ms) || 0;
        if (!t) return '';
        var d = Date.now() - t;
        if (d < 3600e3) return Math.max(1, Math.round(d / 60e3)) + ' 分钟前';
        if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前';
        if (d < 30 * 86400e3) return Math.round(d / 86400e3) + ' 天前';
        var dt = new Date(t);
        return dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate();
    }
    function pickOne(arr) {
        if (!arr || !arr.length) return null;
        try {
            var a = new Uint32Array(1);
            crypto.getRandomValues(a);
            return arr[a[0] % arr.length];
        } catch (e) {
            return arr[Math.floor(Math.random() * arr.length)];
        }
    }
    function coverPlaceholder(it) {
        var raw = String((it && (it.title || it.displayTitle || it.fileName)) || '');
        var label = raw.replace(/^[\s\d.、:：\-—]+/, '').slice(0, 14) || (S.type === 'comic' ? '漫画' : '小说');
        var h = 0;
        var seed = String((it && it.id) || raw);
        for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
        /* 与深海/夜读皮肤同温的冷色相池，避免随机出土黄/橄榄的“脏”封面 */
        var HUES = [206, 218, 231, 244, 258, 272, 196, 178];
        var hue = HUES[h % HUES.length];
        var c1 = 'hsl(' + hue + ',26%,22%)';
        var c2 = 'hsl(' + ((hue + 14) % 360) + ',22%,12%)';
        return '<div class="rw-cover-ph rw-cover-letter" style="background:linear-gradient(155deg,' + c1 + ',' + c2 + ')"><span>' + esc(label) + '</span></div>';
    }
    function posterOf(it) {
        if (typeof window.getPosterUrl === 'function') {
            try { return window.getPosterUrl(it) || ''; } catch (e) { /* fallthrough */ }
        }
        var p = it && (it.posterPath || '');
        if (/^https?:\/\//i.test(p)) return '/api/movie/poster/proxy?url=' + encodeURIComponent(p);
        return p ? '/api/movie/poster/' + encodeURIComponent(p) : '';
    }
    function getJSON(url) {
        return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    }

    /* ---------------- 状态 ---------------- */
    var LS = {
        get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    };

    var S = {
        type: null,
        tree: null,
        roots: [],
        path: '',
        progress: {},
        resume: null,
        stats: { reading: 0, done: 0, shelved: 0 },
        filter: 'all',
        sort: 'recent',
        view: 'grid',
        q: '',
        visible: 120,
        seq: 0,
        loading: true,
        error: '',
        selected: {},
        lastFetch: 0
    };
    RW.S = S;

    var _treeCache = { comic: { at: 0, data: null }, novel: { at: 0, data: null } };
    var _bound = false;
    var _io = null;

    /* ---------------- 树工具 ---------------- */
    function findNode(root, path) {
        if (!path) return root;
        var parts = String(path).split('/').filter(Boolean);
        var node = root;
        for (var i = 0; i < parts.length; i++) {
            var next = null;
            for (var j = 0; j < node.children.length; j++) {
                if (node.children[j].name === parts[i]) { next = node.children[j]; break; }
            }
            if (!next) return node;
            node = next;
        }
        return node;
    }
    function countNode(node, type) {
        var n = (node.items || []).length;
        var covers = 0;
        var cover = '';
        for (var i = 0; i < node.items.length; i++) {
            if (!cover && (node.items[i].posterPath || node.items[i].localPosterPath)) {
                cover = posterOf(node.items[i]); covers++;
            }
        }
        for (var k = 0; k < node.children.length; k++) {
            var sub = countNode(node.children[k], type);
            n += sub.n;
            if (!cover && sub.cover) { cover = sub.cover; }
        }
        return { n: n, cover: cover };
    }
    function collectAll(node, out) {
        out = out || [];
        (node.items || []).forEach(function (it) { out.push(it); });
        (node.children || []).forEach(function (c) { collectAll(c, out); });
        return out;
    }
    function allItems() {
        return S.tree ? collectAll(S.tree, []) : [];
    }

    /* ---------------- 状态归一 ---------------- */
    function stateOf(it) {
        var p = S.progress[it.id];
        if (p) {
            if (p.s === 'done' || p.s === 'shelved' || p.s === 'reading') return p.s;
        }
        if (Number(it.watched) === 1) return 'done';
        return 'unread';
    }
    function percentOf(it) {
        var p = S.progress[it.id];
        return p ? Math.max(0, Math.min(100, Number(p.p) || 0)) : 0;
    }
    function unitLabel(it, state) {
        var p = S.progress[it.id];
        if (S.type === 'comic') {
            if (p && p.t > 0) return '读到第 ' + (Number(p.c) + 1) + ' / ' + p.t + ' 页';
            return fmtSize(it.fileSize) || '漫画';
        }
        if (p && p.t > 0) return '读到第 ' + (Number(p.c) + 1) + ' / ' + p.t + ' 章';
        return '小说' + (fmtSize(it.fileSize) ? ' · ' + fmtSize(it.fileSize) : '');
    }

    /* ---------------- 排序 / 筛选 ---------------- */
    var collator = (function () {
        try { return new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }); }
        catch (e) { return null; }
    })();
    function cmpName(a, b) {
        var x = a.displayTitle || a.title || a.fileName || '';
        var y = b.displayTitle || b.title || b.fileName || '';
        return collator ? collator.compare(x, y) : String(x).localeCompare(String(y));
    }
    function sortItems(items) {
        var arr = items.slice();
        if (S.sort === 'name') arr.sort(cmpName);
        else if (S.sort === 'size') arr.sort(function (a, b) { return (Number(b.fileSize) || 0) - (Number(a.fileSize) || 0); });
        else if (S.sort === 'progress') arr.sort(function (a, b) { return percentOf(b) - percentOf(a); });
        else arr.sort(function (a, b) { return (Number(b.addedTime) || 0) - (Number(a.addedTime) || 0); }); // recent
        return arr;
    }
    function matchFilter(it) {
        if (S.filter === 'all') return true;
        return stateOf(it) === S.filter;
    }
    function matchQuery(it) {
        if (!S.q) return true;
        var q = S.q.toLowerCase();
        var hay = [it.displayTitle, it.title, it.fileName, it.relPath, it.folderName].join(' ').toLowerCase();
        return hay.indexOf(q) >= 0;
    }
    function visibleItems() {
        return sortItems(allItems().filter(function (it) { return matchFilter(it) && matchQuery(it); }));
    }

    /* ---------------- 渲染 ---------------- */
    function rootEl() { return document.getElementById('movieGrid'); }

    function statusBadge(it) {
        var st = stateOf(it);
        if (st === 'reading') {
            var p = percentOf(it);
            return '<span class="rw-st reading">在读' + (p ? ' ' + p + '%' : '') + '</span>';
        }
        if (st === 'done') return '<span class="rw-st done">已读</span>';
        if (st === 'shelved') return '<span class="rw-st shelved">搁置</span>';
        return '';
    }

    function cardHtml(it, opts) {
        opts = opts || {};
        var cover = posterOf(it);
        var st = stateOf(it);
        var p = percentOf(it);
        var title = it.title || it.displayTitle || it.fileName || '(无标题)';
        var sel = !!S.selected[it.id];
        var openLabel = st === 'reading' ? '继续阅读' : '打开阅读';
        return '<article class="rw-card' + (sel ? ' sel' : '') + '" data-rw-id="' + esc(it.id) + '" tabindex="0" role="button"'
            + ' aria-label="' + esc(title) + '">'
            + '<div class="rw-cover">'
            + (cover ? '<img loading="lazy" src="' + esc(cover) + '" alt="" onerror="this.style.display=\'none\'">'
                : coverPlaceholder(it))
            + statusBadge(it)
            + (p > 0 && st !== 'done' ? '<span class="rw-prog"><i style="width:' + p + '%"></i></span>' : '')
            + '<button class="rw-open" data-rw-act="read">' + openLabel + ' ›</button>'
            + '</div>'
            + '<h3 class="rw-ct" title="' + esc(title) + '">' + esc(title) + '</h3>'
            + '<p class="rw-cs">' + esc(unitLabel(it, st)) + '</p>'
            + '</article>';
    }

    function shelfCardHtml(it) {
        return cardHtml(it, { shelf: true });
    }

    function treeHtml(node, depth) {
        var kids = (node.children || []).slice().sort(function (a, b) {
            return collator ? collator.compare(a.name, b.name) : String(a.name).localeCompare(String(b.name));
        });
        if (!kids.length) return '';
        var html = '<ul>';
        kids.forEach(function (c) {
            var cnt = countNode(c, S.type).n;
            var on = S.path === c.path || (S.path && S.path.indexOf(c.path + '/') === 0);
            html += '<li><button class="rw-tree-node' + (S.path === c.path ? ' on' : '') + '"'
                + ' data-rw-act="folder" data-rw-path="' + esc(c.path) + '" title="' + esc(c.name) + '">'
                + '<span>' + FOLDER_SVG + '</span><em>' + esc(c.name) + '</em><b>' + cnt + '</b></button>'
                + treeHtml(c, depth + 1) + '</li>';
        });
        return html + '</ul>';
    }

    function crumbsHtml(node) {
        if (!S.path) return '';
        var parts = S.path.split('/').filter(Boolean);
        var html = '<div class="rw-crumbs"><button data-rw-act="folder" data-rw-path="">' + (S.type === 'comic' ? '漫画库' : '小说库') + '</button>';
        var acc = '';
        parts.forEach(function (name) {
            acc = acc ? acc + '/' + name : name;
            html += '<span>/</span><button data-rw-act="folder" data-rw-path="' + esc(acc) + '">' + esc(name) + '</button>';
        });
        return html + '</div>';
    }

    function contHtml() {
        var r = S.resume;
        if (!r) {
            return '<div class="rw-continue" data-rw-act="noop">'
                + '<div class="rw-continue-cover"><div class="rw-cover-ph rw-cover-letter" style="position:static;height:100%;background:linear-gradient(155deg,hsl(218,26%,22%),hsl(232,22%,12%))"><span>' + (S.type === 'comic' ? '漫画' : '小说') + '</span></div></div>'
                + '<div class="rw-continue-body">'
                + '<p class="rw-continue-k">CONTINUE · 继续阅读</p>'
                + '<h2 class="rw-continue-t">还没有阅读记录</h2>'
                + '<p class="rw-continue-p">从下面挑一本开始，之后这里会记住你读到哪里。</p>'
                + '<div class="rw-continue-meta"><span>提示：任何一本都可以点开</span></div>'
                + '</div></div>';
        }
        var cov = posterOf(r);
        var progText;
        if (S.type === 'comic') {
            progText = r.total > 0 ? '第 ' + (Number(r.page) + 1) + ' / ' + r.total + ' 页' : (r.percent + '%');
        } else {
            progText = r.total > 0 ? '第 ' + (Number(r.chapter) + 1) + ' / ' + r.total + ' 章' : (r.percent + '%');
        }
        var pct = Math.max(0, Math.min(100, Number(r.percent) || 0));
        return '<div class="rw-continue" data-rw-act="read" data-rw-id="' + esc(r.id) + '" role="button" tabindex="0">'
            + '<div class="rw-continue-cover">' + (cov ? '<img src="' + esc(cov) + '" alt="" onerror="this.style.display=\'none\'">' : '<div class="rw-cover-ph rw-cover-letter" style="position:static;height:100%;background:linear-gradient(155deg,hsl(218,26%,22%),hsl(232,22%,12%))"><span>' + (S.type === 'comic' ? '漫画' : '小说') + '</span></div>') + '</div>'
            + '<div class="rw-continue-body">'
            + '<p class="rw-continue-k">CONTINUE · 继续阅读</p>'
            + '<h2 class="rw-continue-t" title="' + esc(r.title) + '">' + esc(r.title || '未命名') + '</h2>'
            + '<p class="rw-continue-p">' + esc(progText) + ' · 上次读于 ' + esc(relTime(r.updatedAt)) + '</p>'
            + '<div class="rw-continue-bar"><i style="width:' + pct + '%"></i></div>'
            + '<div class="rw-continue-meta"><span>' + pct + '%</span>'
            + '</div>'
            + '<button class="rw-continue-go">继续阅读 ›</button>'
            + '</div></div>';
    }

    function randomHtml() {
        var pool = allItems();
        var pick = pickOne(pool);
        if (!pick) {
            return '<div class="rw-random" data-rw-act="noop"><div class="rw-random-k">RANDOM · 随手一本</div>'
                + '<div class="rw-random-ic">🎲</div><div class="rw-random-t">暂无条目</div>'
                + '<div class="rw-random-p">扫描后这里会随机挑一本给你</div></div>';
        }
        var t = pick.displayTitle || pick.title || pick.fileName || '未命名';
        return '<div class="rw-random" data-rw-act="read" data-rw-id="' + esc(pick.id) + '" role="button" tabindex="0" title="直接打开《' + esc(t) + '》">'
            + '<div class="rw-random-k">RANDOM · 随手一本</div>'
            + '<div class="rw-random-ic">🎲</div>'
            + '<div class="rw-random-t" title="' + esc(t) + '">' + esc(t) + '</div>'
            + '<div class="rw-random-p">点一下直接开读（每次换一本）</div></div>';
    }

    function stripeHtml(it, label) {
        return '<article class="rw-card" data-rw-id="' + esc(it.id) + '" tabindex="0" role="button">'
            + '<div class="rw-cover">' + (posterOf(it) ? '<img loading="lazy" src="' + esc(posterOf(it)) + '" alt="">' : coverPlaceholder(it))
            + statusBadge(it) + '</div>'
            + '<h3 class="rw-ct">' + esc(it.title || it.displayTitle || '') + '</h3>'
            + '<p class="rw-cs">' + esc(label) + '</p></article>';
    }

    function mainHtml(node) {
        var all = visibleItems();
        var curItems = (node.items || []).filter(function (it) { return matchQuery(it); });
        var reading = sortItems(allItems().filter(function (it) { return stateOf(it) === 'reading'; }))
            .filter(matchQuery).slice(0, 10);
        var folders = (node.children || []).slice().sort(function (a, b) {
            return collator ? collator.compare(a.name, b.name) : String(a.name).localeCompare(String(b.name));
        });

        var html = '';
        html += contHtml();
        html += randomHtml();
        // hero row 已用 section 包裹，这里输出成一个 section 容器
        html += '<section class="rw-section" aria-label="继续阅读与随机">';

        if (reading.length) {
            html += '<section class="rw-section" data-rw-sec="reading">'
                + '<div class="rw-sec-head"><h2>在读 · 最近</h2><span class="rw-sec-sub">' + reading.length + ' 本</span>'
                + '<button class="rw-sec-more" data-rw-act="filter" data-rw-filter="reading">查看全部 ›</button></div>'
                + '<div class="rw-shelf">' + reading.map(function (it) {
                    return '<article class="rw-card" data-rw-id="' + esc(it.id) + '" tabindex="0" role="button">'
                        + '<div class="rw-cover">' + (posterOf(it) ? '<img loading="lazy" src="' + esc(posterOf(it)) + '" alt="">' : coverPlaceholder(it))
                        + statusBadge(it) + '<span class="rw-prog"><i style="width:' + percentOf(it) + '%"></i></span>'
                        + '<button class="rw-open" data-rw-act="read">继续阅读 ›</button></div>'
                        + '<h3 class="rw-ct">' + esc(it.title || it.displayTitle || '') + '</h3>'
                        + '<p class="rw-cs">' + esc(unitLabel(it, 'reading')) + '</p></article>';
                }).join('') + '</div></section>';
        }

        if (folders.length) {
            html += '<section class="rw-section" data-rw-sec="collections">'
                + '<div class="rw-sec-head"><h2>合集</h2><span class="rw-sec-sub">' + folders.length + ' 个文件夹</span></div>'
                + '<div class="rw-collections">' + folders.map(function (f) {
                    var c = countNode(f, S.type);
                    var cov = c.cover;
                    return '<button class="rw-folder" data-rw-act="folder" data-rw-path="' + esc(f.path) + '">'
                        + '<span class="rw-folder-art">' + (cov ? '<img loading="lazy" src="' + esc(cov) + '" alt="">' : '') + '<span class="rw-folder-stack">' + FOLDER_SVG + '</span></span>'
                        + '<span class="rw-folder-body"><span class="rw-folder-t">' + esc(f.name) + '</span>'
                        + '<span class="rw-folder-n">' + c.n + ' 本</span></span></button>';
                }).join('') + '</div></section>';
        }

        html += '<section class="rw-section" data-rw-sec="all">'
            + '<div class="rw-sec-head"><h2>' + (S.filter === 'all' ? (S.path ? '本文件夹' : '全部馆藏') : filterName(S.filter)) + '</h2>'
            + '<span class="rw-sec-sub">' + all.length + ' 本</span>'
            + '<div class="rw-chips">' + chipsHtml() + '</div></div>'
            + '<div class="rw-grid' + (S.view === 'list' ? ' rw-list' : '') + '" id="rwGrid">' + gridHtml(all) + '</div>'
            + '<div class="rw-foot" id="rwFoot">' + footHtml(all) + '</div>'
            + '</section>';

        html += '</section>';
        return html;
    }

    function filterName(f) {
        return { reading: '在读', done: '已读', shelved: '搁浅', unread: '未读' }[f] || '全部馆藏';
    }
    function chipsHtml() {
        var counts = { all: allItems().length, reading: 0, unread: 0, done: 0, shelved: 0 };
        allItems().forEach(function (it) { var s = stateOf(it); if (counts[s] != null) counts[s]++; });
        return [['all', '全部'], ['reading', '在读'], ['unread', '未读'], ['done', '已读'], ['shelved', '搁浅']]
            .map(function (p) {
                return '<button class="rw-chip' + (S.filter === p[0] ? ' on' : '') + '" data-rw-act="filter" data-rw-filter="' + p[0] + '">'
                    + p[1] + ' <b style="opacity:.7;font-weight:400">' + (counts[p[0]] || 0) + '</b></button>';
            }).join('');
    }
    function gridHtml(items) {
        var show = items.slice(0, S.visible);
        if (!show.length) {
            return ''; // 空态由 footHtml 统一渲染
        }
        return show.map(function (it) { return cardHtml(it); }).join('');
    }
    function footHtml(items) {
        if (!items.length) {
            return '<div class="rw-empty"><div class="rw-empty-ic">🗂</div>'
                + '<h3>' + (S.q ? '没有匹配「' + esc(S.q) + '」的条目' : (S.filter === 'all' ? '这里还没有内容' : '这个筛选下暂时没有内容')) + '</h3>'
                + '<p>' + (S.q ? '换个关键词，或清空搜索' : '返回全部，或去扫描/网盘里添加') + '</p>'
                + '<button data-rw-act="' + (S.q ? 'clearq' : 'filter') + '" data-rw-filter="all">' + (S.q ? '清空搜索' : '看全部') + '</button></div>';
        }
        if (items.length <= S.visible) {
            return '<span>已显示全部 ' + items.length + ' 本</span>';
        }
        return '<span>已显示 ' + Math.min(S.visible, items.length) + ' / ' + items.length + '</span>'
            + '<button class="rw-more" data-rw-act="more">加载更多</button>';
    }

    function pageHtml(node) {
        var counts = { all: allItems().length, reading: 0, unread: 0, done: 0, shelved: 0 };
        allItems().forEach(function (it) { var s = stateOf(it); if (counts[s] != null) counts[s]++; });
        var main = mainHtml(node);
        // 把 hero 两块包成一行：mainHtml 开头输出的是 cont+random，这里重新组织
        var hero = '<section class="rw-section rw-hero-row" aria-label="继续阅读与随手一本">' + contHtml() + randomHtml() + '</section>';
        // 去掉 mainHtml 里重复的 hero 部分（mainHtml 已含 cont/random 与外壳，改为直接拼装）
        return '<div class="rw-page" data-rw-type="' + esc(S.type) + '">'
            + '<header class="rw-head">'
            + '<div class="rw-head-main">'
            + '<p class="rw-kicker">LIBRARY · ' + (S.type === 'comic' ? 'MANGA' : 'NOVEL') + '</p>'
            + '<h1 class="rw-title">' + (S.type === 'comic' ? '漫画库' : '小说库') + '</h1>'
            + '<p class="rw-sub"><b>' + counts.all + '</b> 本 <i>·</i> 在读 ' + counts.reading
            + ' <i>·</i> 已读 ' + counts.done + (counts.shelved ? ' <i>·</i> 搁浅 ' + counts.shelved : '') + '</p>'
            + '</div>'
            + '<div class="rw-head-tools">'
            + '<input class="rw-search" id="rwSearch" type="search" placeholder="在本库中搜索…" value="' + esc(S.q) + '" autocomplete="off">'
            + '<select class="rw-select" id="rwSort" aria-label="排序">'
            + sortOpts()
            + '</select>'
            + '<div class="rw-viewtoggle" role="group" aria-label="视图">'
            + '<button data-rw-act="view" data-rw-view="grid" class="' + (S.view === 'grid' ? 'on' : '') + '" title="网格">'
            + '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="1.5" width="4.4" height="4.4" rx="1"/><rect x="8.1" y="1.5" width="4.4" height="4.4" rx="1"/><rect x="1.5" y="8.1" width="4.4" height="4.4" rx="1"/><rect x="8.1" y="8.1" width="4.4" height="4.4" rx="1"/></svg></button>'
            + '<button data-rw-act="view" data-rw-view="list" class="' + (S.view === 'list' ? 'on' : '') + '" title="列表">'
            + '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 3h10M2 7h10M2 11h10"/></svg></button>'
            + '</div>'
            + '</div></header>'
            + '<div class="rw-body">'
            + '<nav class="rw-rail" aria-label="分类">'
            + railHtml(node)
            + '</nav>'
            + '<main class="rw-main">'
            + crumbsHtml(node)
            + hero
            + mainSections(node)
            + '</main>'
            + '</div>'
            + '<div class="rw-batchbar" id="rwBatchBar"></div>'
            + '</div>';
    }

    function sortOpts() {
        var opts = [['recent', '最近添加'], ['name', '名称 A→Z'], ['size', '体积'], ['progress', '进度']];
        return opts.map(function (o) {
            return '<option value="' + o[0] + '"' + (S.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('');
    }

    function railHtml(node) {
        var counts = { all: allItems().length, reading: 0, unread: 0, done: 0, shelved: 0 };
        allItems().forEach(function (it) { var s = stateOf(it); if (counts[s] != null) counts[s]++; });
        var items = [
            ['all', '全部馆藏', '▦'],
            ['reading', '在读', '◐'],
            ['unread', '未读', '○'],
            ['done', '已读', '✓'],
            ['shelved', '搁浅', '⏸']
        ];
        var html = '<div class="rw-rail-group"><div class="rw-rail-h">状态</div>';
        html += items.map(function (it) {
            return '<button class="rw-nav' + (S.filter === it[0] ? ' on' : '') + '" data-rw-act="filter" data-rw-filter="' + it[0] + '">'
                + '<span class="rw-nav-ic">' + it[2] + '</span><span>' + it[1] + '</span>'
                + '<span class="rw-nav-n">' + (counts[it[0]] || 0) + '</span></button>';
        }).join('');
        html += '</div>';
        var tree = treeHtml(node, 0);
        if (tree) {
            html += '<div class="rw-rail-group"><div class="rw-rail-h">文件夹</div><div class="rw-tree">' + tree + '</div></div>';
        }
        html += '<div class="rw-rail-group"><div class="rw-rail-h">提示</div>'
            + '<div style="padding:4px 10px;font-size:11px;line-height:1.6;color:var(--text-faint)">'
            + 'Ctrl / ⌘ + 点击卡片可多选<br>双击卡片直接开读</div></div>';
        return html;
    }

    /* mainHtml 里已包含 hero（cont/random）+ 各分区，这里单独抽出来避免重复 */
    function mainSections(node) {
        // 与 mainHtml 相同的后半段，但不含 cont/random
        var all = visibleItems();
        var reading = sortItems(allItems().filter(function (it) { return stateOf(it) === 'reading'; }))
            .filter(matchQuery).slice(0, 10);
        var folders = (node.children || []).slice().sort(function (a, b) {
            return collator ? collator.compare(a.name, b.name) : String(a.name).localeCompare(String(b.name));
        });
        var html = '';
        if (reading.length) {
            html += '<section class="rw-section" data-rw-sec="reading">'
                + '<div class="rw-sec-head"><h2>在读 · 最近</h2><span class="rw-sec-sub">' + reading.length + ' 本</span>'
                + '<button class="rw-sec-more" data-rw-act="filter" data-rw-filter="reading">查看全部 ›</button></div>'
                + '<div class="rw-shelf">' + reading.map(function (it) {
                    return '<article class="rw-card" data-rw-id="' + esc(it.id) + '" tabindex="0" role="button">'
                        + '<div class="rw-cover">' + (posterOf(it) ? '<img loading="lazy" src="' + esc(posterOf(it)) + '" alt="">' : coverPlaceholder(it))
                        + statusBadge(it) + '<span class="rw-prog"><i style="width:' + percentOf(it) + '%"></i></span>'
                        + '<button class="rw-open" data-rw-act="read">继续阅读 ›</button></div>'
                        + '<h3 class="rw-ct">' + esc(it.title || it.displayTitle || '') + '</h3>'
                        + '<p class="rw-cs">' + esc(unitLabel(it, 'reading')) + '</p></article>';
                }).join('') + '</div></section>';
        }
        if (folders.length) {
            html += '<section class="rw-section" data-rw-sec="collections">'
                + '<div class="rw-sec-head"><h2>合集</h2><span class="rw-sec-sub">' + folders.length + ' 个文件夹</span></div>'
                + '<div class="rw-collections">' + folders.map(function (f) {
                    var c = countNode(f, S.type);
                    return '<button class="rw-folder" data-rw-act="folder" data-rw-path="' + esc(f.path) + '">'
                        + '<span class="rw-folder-art">' + (c.cover ? '<img loading="lazy" src="' + esc(c.cover) + '" alt="">' : '') + '<span class="rw-folder-stack">' + FOLDER_SVG + '</span></span>'
                        + '<span class="rw-folder-body"><span class="rw-folder-t">' + esc(f.name) + '</span>'
                        + '<span class="rw-folder-n">' + c.n + ' 本</span></span></button>';
                }).join('') + '</div></section>';
        }
        html += '<section class="rw-section" data-rw-sec="all">'
            + '<div class="rw-sec-head"><h2>' + (S.filter === 'all' ? (S.path ? '本文件夹' : '全部馆藏') : filterName(S.filter)) + '</h2>'
            + '<span class="rw-sec-sub">' + all.length + ' 本</span>'
            + '<div class="rw-chips">' + chipsHtml() + '</div></div>'
            + '<div class="rw-grid' + (S.view === 'list' ? ' rw-list' : '') + '" id="rwGrid">' + gridHtml(all) + '</div>'
            + '<div class="rw-foot" id="rwFoot">' + footHtml(all) + '</div>'
            + '</section>';
        return html;
    }

    /* ---------------- 渲染入口 ---------------- */
    function render() {
        var grid = rootEl();
        if (!grid || !S.type) return;
        if (!S.tree) return; // 骨架由 mount 负责
        var node = findNode(S.tree, S.path);
        grid.innerHTML = pageHtml(node);
        bind(grid);
        if (S.selected && Object.keys(S.selected).length) updateBatchBar();
    }

    function renderSkeleton() {
        var grid = rootEl();
        if (!grid) return;
        var sk = [];
        for (var i = 0; i < 18; i++) sk.push('<div class="rw-skel"></div>');
        grid.innerHTML = '<div class="rw-page" data-rw-type="' + esc(S.type) + '">'
            + '<header class="rw-head"><div class="rw-head-main">'
            + '<p class="rw-kicker">LIBRARY</p><h1 class="rw-title">' + (S.type === 'comic' ? '漫画库' : '小说库') + '</h1>'
            + '<p class="rw-sub">正在整理书架…</p></div></header>'
            + '<div class="rw-body"><div class="rw-main"><section class="rw-section"><div class="rw-grid">' + sk.join('') + '</div></section></div></div></div>';
    }

    function renderError(msg) {
        var grid = rootEl();
        if (!grid) return;
        grid.innerHTML = '<div class="rw-page"><div class="rw-empty" style="margin-top:40px">'
            + '<div class="rw-empty-ic">⚠️</div><h3>书架加载失败</h3>'
            + '<p>' + esc(msg || '网络或接口异常') + '</p>'
            + '<button data-rw-act="retry">重试</button></div></div>';
        bind(grid);
    }

    /* ---------------- 事件 ---------------- */
    function bind(root) {
        if (root.__rwBound) return;
        root.__rwBound = true;
        root.addEventListener('click', onClick);
        root.addEventListener('keydown', onKey);
        root.addEventListener('change', onChange);
        root.addEventListener('input', onInput);
    }

    function onClick(e) {
        var actEl = e.target.closest('[data-rw-act]');
        if (actEl) {
            var act = actEl.getAttribute('data-rw-act');
            if (act === 'folder') { e.preventDefault(); goFolder(actEl.getAttribute('data-rw-path') || ''); return; }
            if (act === 'filter') { e.preventDefault(); setFilter(actEl.getAttribute('data-rw-filter') || 'all'); return; }
            if (act === 'view') { e.preventDefault(); setView(actEl.getAttribute('data-rw-view') || 'grid'); return; }
            if (act === 'more') { e.preventDefault(); S.visible += 120; rerenderGrid(); return; }
            if (act === 'clearq') { e.preventDefault(); S.q = ''; refreshView(); return; }
            if (act === 'retry') { e.preventDefault(); RW.mount(S.type, { force: true }); return; }
            if (act === 'read') {
                e.preventDefault(); e.stopPropagation();
                var id = Number(actEl.getAttribute('data-rw-id') || (actEl.closest('[data-rw-id]') || {}).getAttribute && actEl.closest('[data-rw-id]').getAttribute('data-rw-id'));
                if (!id) { var card0 = actEl.closest('[data-rw-id]'); if (card0) id = Number(card0.getAttribute('data-rw-id')); }
                openReader(id);
                return;
            }
            if (act === 'batch') { e.preventDefault(); doBatch(actEl.getAttribute('data-rw-status')); return; }
            if (act === 'batch-x') { e.preventDefault(); S.selected = {}; refreshSelection(); return; }
            if (act === 'noop') { e.preventDefault(); return; }
        }
        var card = e.target.closest('.rw-card, .rw-continue');
        if (!card) return;
        if (e.target.closest('.rw-open')) return; // 交给 read 分支
        var id = Number(card.getAttribute('data-rw-id'));
        if (!id) return;
        if (e.ctrlKey || e.metaKey) {
            if (S.selected[id]) delete S.selected[id]; else S.selected[id] = true;
            refreshSelection();
            return;
        }
        if (typeof window.showMovieDetail === 'function') window.showMovieDetail(id);
    }

    function onKey(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var card = e.target.closest && e.target.closest('.rw-card, .rw-continue, .rw-folder');
        if (!card) return;
        e.preventDefault();
        card.click();
    }

    function onChange(e) {
        if (e.target && e.target.id === 'rwSort') {
            S.sort = e.target.value;
            LS.set('rw:' + S.type + ':sort', S.sort);
            refreshView();
        }
    }

    var _qTimer = null;
    function onInput(e) {
        if (!e.target || e.target.id !== 'rwSearch') return;
        var v = e.target.value || '';
        clearTimeout(_qTimer);
        _qTimer = setTimeout(function () {
            S.q = v.trim();
            S.visible = 120;
            refreshView(true);
        }, 220);
    }

    /* ---------------- 交互动作 ---------------- */
    function goFolder(path) {
        S.path = path || '';
        S.visible = 120;
        S.filter = 'all';
        render();
        var grid = rootEl();
        if (grid) {
            var page = grid.querySelector('.rw-page');
            if (page) page.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    }

    function setFilter(f) {
        S.filter = f;
        S.visible = 120;
        render();
    }

    function setView(v) {
        S.view = v === 'list' ? 'list' : 'grid';
        LS.set('rw:' + S.type + ':view', S.view);
        render();
    }

    function rerenderGrid() {
        var all = visibleItems();
        var g = document.getElementById('rwGrid');
        if (g) g.innerHTML = gridHtml(all);
        var f = document.getElementById('rwFoot');
        if (f) {
            f.innerHTML = footHtml(all);
            bind(f);
        }
        if (g) bind(g);
    }

    function refreshView(keepFocus) {
        var wasFocused = keepFocus;
        render();
        if (wasFocused) {
            var s = document.getElementById('rwSearch');
            if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
        }
    }

    function openReader(id) {
        if (!id) return;
        if (S.type === 'comic' && typeof window.openComicReader === 'function') window.openComicReader(id);
        else if (S.type === 'novel' && typeof window.openNovelReader === 'function') window.openNovelReader(id);
    }

    function refreshSelection() {
        var grid = rootEl();
        if (!grid) return;
        grid.querySelectorAll('.rw-card[data-rw-id]').forEach(function (c) {
            var on = !!S.selected[Number(c.getAttribute('data-rw-id'))];
            c.classList.toggle('sel', on);
        });
        updateBatchBar();
    }

    function updateBatchBar() {
        var bar = document.getElementById('rwBatchBar');
        if (!bar) return;
        var n = Object.keys(S.selected).length;
        if (!n) { bar.className = 'rw-batchbar'; bar.innerHTML = ''; return; }
        bar.className = 'rw-batchbar show';
        bar.innerHTML = '<span>已选 <b>' + n + '</b> 本</span>'
            + '<button data-rw-act="batch" data-rw-status="done">标为已读</button>'
            + '<button data-rw-act="batch" data-rw-status="reading">标为在读</button>'
            + '<button data-rw-act="batch" data-rw-status="shelved">搁浅</button>'
            + '<button class="rw-batch-x" data-rw-act="batch-x">取消</button>';
        bind(bar);
    }

    function doBatch(status) {
        var ids = Object.keys(S.selected).map(Number).filter(Boolean);
        if (!ids.length) return;
        fetch('/api/media/' + S.type + '/batch/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids, status: status })
        }).then(function (r) { return r.json(); }).then(function (j) {
            if (j && j.code === 0) {
                ids.forEach(function (id) {
                    S.progress[id] = S.progress[id] || { p: 0, s: status, u: Date.now(), c: 0, t: 0 };
                    S.progress[id].s = status;
                    S.progress[id].u = Date.now();
                });
                S.selected = {};
                if (typeof showNotification === 'function') showNotification('状态已更新', '已处理 ' + ids.length + ' 本');
                render();
            } else if (typeof showNotification === 'function') {
                showNotification('批量操作失败', (j && j.msg) || '请稍后重试');
            }
        }).catch(function () {
            if (typeof showNotification === 'function') showNotification('批量操作失败', '网络异常');
        });
    }

    /* ---------------- 数据加载 ---------------- */
    function fetchTree(force) {
        var c = _treeCache[S.type];
        if (!force && c.data && Date.now() - c.at < 60000) {
            return Promise.resolve(c.data);
        }
        return getJSON('/api/' + S.type + '/tree').then(function (j) {
            if (!j || j.code !== 0 || !j.data) throw new Error((j && j.msg) || '目录树加载失败');
            var d = j.data;
            if (!d.tree) throw new Error('目录树为空');
            var root = d.tree;
            if (!Array.isArray(root.children)) root.children = [];
            if (!Array.isArray(root.items)) root.items = [];
            c.data = root; c.at = Date.now();
            return root;
        });
    }

    RW.mount = function (type, opts) {
        opts = opts || {};
        if (type !== 'comic' && type !== 'novel') return Promise.resolve(false);
        var prevType = S.type;
        S.type = type;
        if (prevType !== type) {
            S.path = '';
            S.filter = 'all';
            S.q = '';
            S.selected = {};
            S.visible = 120;
            S.sort = LS.get('rw:' + type + ':sort', 'recent');
            S.view = LS.get('rw:' + type + ':view', 'grid');
            S.resume = null;
            S.progress = {};
        }
        var mySeq = ++S.seq;
        S.loading = true;
        S.error = '';

        // 旧版续读横幅在 #movieGrid 之前，新页自带续读卡，移除避免双份
        var oldBar = document.getElementById('readResumeBar');
        if (oldBar) oldBar.remove();

        renderSkeleton();
        var grid = rootEl();
        if (grid) {
            grid.classList.remove('tree-mode');
            grid.classList.add('rw-mode');
        }

        return Promise.all([
            fetchTree(!!opts.force),
            getJSON('/api/media/progress-map?type=' + type).catch(function () { return null; }),
            getJSON('/api/media/resume?type=' + type).catch(function () { return null; }),
            getJSON('/api/media/stats?type=' + type).catch(function () { return null; })
        ]).then(function (res) {
            if (mySeq !== S.seq) return false; // 已切走
            S.tree = res[0];
            var pm = res[1];
            S.progress = (pm && pm.code === 0 && pm.data) ? pm.data : {};
            var rv = res[2];
            S.resume = (rv && rv.code === 0 && rv.data) ? rv.data : null;
            var st = res[3];
            S.stats = (st && st.code === 0 && st.data) ? st.data : { reading: 0, done: 0, shelved: 0 };
            S.loading = false;
            render();
            return true;
        }).catch(function (e) {
            if (mySeq !== S.seq) return false;
            S.loading = false;
            S.error = e.message || '加载失败';
            renderError(S.error);
            return false;
        });
    };

    RW.refresh = function () {
        if (!S.type) return Promise.resolve(false);
        return RW.mount(S.type, { force: true });
    };

    RW.unmount = function () {
        S.seq++;
        S.selected = {};
        S.loading = false;
        var bar = document.getElementById('rwBatchBar');
        if (bar) bar.remove();
    };

    RW.getState = function () { return S; };

    /* 让旧代码也能拿到当前挂载态 */
    window.addEventListener('message', function (e) {
        if (e && e.data && e.data.type === 'cv:rw-refresh') RW.refresh();
    });
})();