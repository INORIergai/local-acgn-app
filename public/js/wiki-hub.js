// ================================================================
// wiki-hub.js —— 次元资料：萌娘百科 + GameKee
//
//   两个页面都是「原生 UI + 后端清洗后的内容」，不套 webview：
//   · WikiView   搜索 → 条目正文（章节锚点/内链站内跳转/原站外链）
//   · GameKeeView 游戏库 → 游戏主页 → 攻略文章（目录树懒加载）
//
//   后端已经把远程 HTML 清洗/转义过（utils/wiki.js、utils/gamekee.js），
//   前端只负责排版；所有远程链接一律 target=_blank rel=noopener。
// ================================================================
(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const api = async (url, opts) => {
        const o = Object.assign({ credentials: 'same-origin' }, opts || {});
        if (o.body && typeof o.body === 'string') {
            o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
        }
        const ms = Number(o.timeout) || 30000;
        delete o.timeout;
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        if (ac) { o.signal = ac.signal; timer = setTimeout(() => ac.abort(), ms); }
        try {
            const r = await fetch(url, o);
            return r.json();
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round(ms / 1000) + 's）');
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    const notify = (title, body) => {
        if (typeof window.showNotification === 'function') window.showNotification(title, body || '');
    };

    const RECENT_KEY = 'cv.wikiRecent';
    function loadRecent() {
        try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 8); } catch (e) { return []; }
    }
    function pushRecent(title) {
        const list = loadRecent().filter((t) => t !== title);
        list.unshift(title);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) { /* 忽略 */ }
    }

    // ================================================================
    // 萌娘百科
    // ================================================================
    const W = { built: false, seq: 0, query: '', items: [], title: '', inited: false };

    function wroot() { return document.getElementById('wikiView'); }

    function wBuild() {
        const r = wroot();
        if (!r || W.built) return;
        r.innerHTML = '<div class="wk-page">'
            + '<header class="wk-head">'
            + '<div class="wk-head-copy"><h2>萌娘百科</h2><p>动画 / 游戏 / 角色资料 · 站内阅读，图片走 storage CDN</p></div>'
            + '<form class="wk-search" id="wkForm">'
            + '<input id="wkInput" type="search" placeholder="搜索条目，例如：葬送的芙莉莲、命运石之门" autocomplete="off">'
            + '<button type="submit">搜索</button>'
            + '</form></header>'
            + '<div class="wk-body">'
            + '<aside class="wk-side"><div class="wk-recent" id="wkRecent"></div><div class="wk-results" id="wkResults">'
            + '<div class="wk-placeholder">输入关键词开始搜索。<br>支持中文条目名、日文名与常见简称。</div></div></aside>'
            + '<article class="wk-article" id="wkArticle"><div class="wk-welcome">'
            + '<div class="wk-welcome-icon">📖</div>'
            + '<h3>萌娘百科 · 站内阅读</h3>'
            + '<p>搜索条目查看完整资料；正文里的内链会在本页继续打开，原站链接会新窗口打开。<br>'
            + '从追番详情页点「📖 资料」可以直接跳到对应番剧条目。</p>'
            + '</div></article>'
            + '</div></div>';
        W.built = true;
        const form = r.querySelector('#wkForm');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            wSearch(r.querySelector('#wkInput').value.trim());
        });
        r.querySelector('#wkResults').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-wk-title]');
            if (btn) wOpen(btn.getAttribute('data-wk-title'));
        });
        r.querySelector('#wkRecent').addEventListener('click', (e) => {
            const b = e.target.closest('[data-wk-title]');
            if (b) wOpen(b.getAttribute('data-wk-title'));
        });
        r.querySelector('#wkArticle').addEventListener('click', (e) => {
            const link = e.target.closest('a.wiki-link');
            if (link) {
                e.preventDefault();
                const t = link.getAttribute('data-wiki-title');
                if (t) wOpen(t);
                return;
            }
            const toc = e.target.closest('[data-wk-anchor]');
            if (toc) {
                const line = toc.getAttribute('data-wk-anchor');
                const node = [...document.querySelectorAll('#wkArticle .wk-content h2, #wkArticle .wk-content h3')]
                    .find((h) => h.textContent.trim() === line);
                if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
            }
            const act = e.target.closest('[data-act]');
            if (!act) return;
            const a = act.getAttribute('data-act');
            if (a === 'wk-refresh') wOpen(W.title, { refresh: true });
            if (a === 'wk-series') wFindSeries();
        });
        wRenderRecent();
    }

    function wRenderRecent() {
        const box = wroot() && wroot().querySelector('#wkRecent');
        if (!box) return;
        const list = loadRecent();
        box.innerHTML = list.length
            ? '<div class="wk-side-label">最近查看</div>' + list.map((t) =>
                '<button class="wk-recent-chip" data-wk-title="' + esc(t) + '">' + esc(t) + '</button>').join('')
            : '';
    }

    async function wSearch(q, opts = {}) {
        const kw = String(q || '').trim();
        if (!kw) return;
        W.query = kw;
        const input = wroot().querySelector('#wkInput');
        if (input && input.value !== kw) input.value = kw;
        const box = wroot().querySelector('#wkResults');
        if (box) box.innerHTML = '<div class="wk-loading"><span class="wk-spin"></span>正在搜索…</div>';
        try {
            const r = await api('/api/wiki/search?q=' + encodeURIComponent(kw), { timeout: 35000 });
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '搜索失败');
            W.items = (r.data && r.data.items) || [];
            wRenderResults();
            if (W.items.length && opts.autoOpen !== false) {
                // 标题与关键词高度一致时直接打开，省一次点击
                const norm = (s) => String(s || '').replace(/[\s\-_·・]/g, '').toLowerCase();
                const exact = W.items.find((it) => norm(it.title) === norm(kw));
                if (exact) wOpen(exact.title);
            }
        } catch (e) {
            if (box) box.innerHTML = '<div class="wk-error">' + esc(e.message) + '</div>';
        }
    }

    function wRenderResults() {
        const box = wroot() && wroot().querySelector('#wkResults');
        if (!box) return;
        if (!W.items.length) {
            box.innerHTML = '<div class="wk-placeholder">没有找到条目。<br>试试更短的名称，或只保留作品名（去掉「第二季」）。</div>';
            return;
        }
        box.innerHTML = '<div class="wk-side-label">搜索结果 · ' + W.items.length + '</div>'
            + W.items.map((it) => '<button class="wk-result' + (it.title === W.title ? ' active' : '')
                + '" data-wk-title="' + esc(it.title) + '">'
                + '<b>' + esc(it.title) + '</b>'
                + (it.snippet ? '<small>' + esc(it.snippet) + '</small>' : '')
                + '</button>').join('');
    }

    async function wOpen(title, opts = {}) {
        const t = String(title || '').trim();
        if (!t) return;
        W.title = t;
        const input = wroot() && wroot().querySelector('#wkInput');
        if (input) input.value = t;
        pushRecent(t);
        wRenderRecent();
        wRenderResults();
        const box = wroot().querySelector('#wkArticle');
        if (box) box.innerHTML = '<div class="wk-loading"><span class="wk-spin"></span>正在打开《' + esc(t) + '》…</div>';
        const seq = ++W.seq;
        try {
            const r = await api('/api/wiki/page?title=' + encodeURIComponent(t) + (opts.refresh ? '&force=1' : ''), { timeout: 45000 });
            if (seq !== W.seq) return;
            if (!r || r.code !== 0 || !r.data) throw new Error((r && r.msg) || '打开失败');
            wRenderArticle(r.data, r.msg || '');
        } catch (e) {
            if (seq !== W.seq) return;
            /* 条目名可能不是萌娘百科的正式标题（番剧长名、带副标题）：
             * 失败时自动改成「搜索相关条目」，把候选列出来，而不是只留一个红字。 */
            if (box) {
                box.innerHTML = '<div class="wk-error">没有直接打开《' + esc(t) + '》：' + esc(e.message)
                    + '<br>已为你搜索相关条目，点左侧结果继续。</div>';
            }
            wSearch(t, { autoOpen: false });
        }
    }

    function wRenderArticle(d, note) {
        const box = wroot() && wroot().querySelector('#wkArticle');
        if (!box) return;
        const toc = (d.sections || []).map((s) => '<button class="wk-toc-chip l' + (s.level || 2)
            + '" data-wk-anchor="' + esc(s.line) + '">' + esc(s.line) + '</button>').join('');
        box.innerHTML = '<div class="wk-art">'
            + (note ? '<div class="wk-note">' + esc(note) + '</div>' : '')
            + '<header class="wk-art-head">'
            + (d.cover ? '<div class="wk-cover"><img src="' + esc(d.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.style.display=\'none\'"></div>' : '')
            + '<div class="wk-art-copy"><div class="wk-art-kicker">萌娘百科' + (d.cached ? ' · 缓存' : '') + '</div>'
            + '<h1>' + esc(d.title || W.title) + '</h1>'
            + '<div class="wk-art-meta">' + (d.sections || []).length + ' 个章节'
            + (d.fallback ? ' · 镜像不可达，仅导语' : '') + '</div>'
            + '<div class="wk-art-actions">'
            + '<button data-act="wk-refresh">↻ 刷新</button>'
            + '<button data-act="wk-series">📺 在追番中查看</button>'
            + (d.sourceUrl ? '<a href="' + esc(d.sourceUrl) + '" target="_blank" rel="noopener noreferrer">原站 ↗</a>' : '')
            + '</div></div></header>'
            + (toc ? '<nav class="wk-toc">' + toc + '</nav>' : '')
            + '<div class="wk-content">' + (d.html || '<div class="wk-placeholder">这个条目没有可显示的正文。</div>') + '</div>'
            + '</div>';
        box.scrollTop = 0;
    }

    async function wFindSeries() {
        const title = W.title;
        if (!title) return;
        try {
            const r = await api('/api/series/search?kw=' + encodeURIComponent(title) + '&limit=5');
            const list = (r && r.data) || [];
            if (!list.length) { notify('追番里没有找到', '可以先在「追番」里搜索或从放送表添加'); return; }
            const hit = list[0];
            if (typeof window.switchView === 'function') window.switchView('series');
            if (window.SeriesView && window.SeriesView.openDetail) {
                setTimeout(() => window.SeriesView.openDetail(hit.id), 260);
            }
        } catch (e) {
            notify('查询失败', e.message);
        }
    }

    function wShow() {
        const r = wroot();
        if (!r) return;
        r.style.display = 'block';
        document.body.classList.add('wk-mode');
        wBuild();
        wRenderRecent();
        if (!W.inited) {
            W.inited = true;
            const input = r.querySelector('#wkInput');
            if (input) input.focus();
        }
    }
    function wHide() {
        const r = wroot();
        if (r) r.style.display = 'none';
        document.body.classList.remove('wk-mode');
    }

    window.WikiView = {
        show: wShow,
        hide: wHide,
        open: (title) => { wShow(); wOpen(title); },
        search: (q) => { wShow(); wSearch(q); },
    };

    // ================================================================
    // GameKee
    // ================================================================
    const G = { built: false, games: [], gameId: 0, seq: 0, tab: 'articles' };

    function groot() { return document.getElementById('gamekeeView'); }

    function gBuild() {
        const r = groot();
        if (!r || G.built) return;
        r.innerHTML = '<div class="gk-page">'
            + '<header class="wk-head">'
            + '<div class="wk-head-copy"><h2>GameKee 攻略库</h2><p>崩坏：星穹铁道 / 鸣潮 / 绝区零 等社区 wiki · 原生阅读</p></div>'
            + '<form class="wk-search" id="gkForm">'
            + '<input id="gkInput" type="search" placeholder="搜索游戏，例如：星穹铁道、鸣潮" autocomplete="off">'
            + '<button type="submit">搜索</button>'
            + '</form></header>'
            + '<div class="gk-body">'
            + '<aside class="gk-games" id="gkGames"><div class="wk-loading"><span class="wk-spin"></span>加载游戏库…</div></aside>'
            + '<section class="gk-panel">'
            + '<div class="gk-game-head" id="gkGameHead"><div class="wk-placeholder">左边选一个游戏</div></div>'
            + '<div class="gk-tabs" id="gkTabs" style="display:none">'
            + '<button data-gk-tab="articles" class="active">攻略文章</button>'
            + '<button data-gk-tab="tree">目录</button>'
            + '</div>'
            + '<div class="gk-list" id="gkList"></div>'
            + '</section>'
            + '<article class="gk-article" id="gkArticle"><div class="wk-welcome">'
            + '<div class="wk-welcome-icon">🎮</div><h3>GameKee 攻略库</h3>'
            + '<p>选择左侧游戏，查看版本公告、角色攻略与图鉴目录；文章正文在应用内排版，不套网页。</p>'
            + '</div></article>'
            + '</div></div>';
        G.built = true;
        r.querySelector('#gkForm').addEventListener('submit', (e) => {
            e.preventDefault();
            gLoadGames(r.querySelector('#gkInput').value.trim());
        });
        r.querySelector('#gkGames').addEventListener('click', (e) => {
            const b = e.target.closest('[data-gk-game]');
            if (b) gOpenGame(Number(b.getAttribute('data-gk-game')));
        });
        r.querySelector('#gkTabs').addEventListener('click', (e) => {
            const b = e.target.closest('[data-gk-tab]');
            if (!b) return;
            G.tab = b.getAttribute('data-gk-tab');
            r.querySelectorAll('#gkTabs button').forEach((x) => x.classList.toggle('active', x === b));
            gRenderList();
        });
        r.querySelector('#gkList').addEventListener('click', (e) => {
            const a = e.target.closest('[data-gk-article]');
            if (a) { gOpenArticle(Number(a.getAttribute('data-gk-article'))); return; }
            const node = e.target.closest('[data-gk-node]');
            if (node) gOpenNode(Number(node.getAttribute('data-gk-node')));
        });
    }

    async function gLoadGames(q) {
        const box = groot() && groot().querySelector('#gkGames');
        if (box) box.innerHTML = '<div class="wk-loading"><span class="wk-spin"></span>搜索游戏…</div>';
        try {
            const r = await api('/api/gamekee/games?q=' + encodeURIComponent(q || ''), { timeout: 30000 });
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '加载失败');
            G.games = (r.data && r.data.items) || [];
            gRenderGames();
        } catch (e) {
            if (box) box.innerHTML = '<div class="wk-error">' + esc(e.message) + '</div>';
        }
    }

    function gRenderGames() {
        const box = groot() && groot().querySelector('#gkGames');
        if (!box) return;
        if (!G.games.length) {
            box.innerHTML = '<div class="wk-placeholder">没有匹配的游戏。<br>GameKee 只收录自建 wiki 的游戏（约 466 款），没有原神/FGO。</div>';
            return;
        }
        box.innerHTML = '<div class="wk-side-label">游戏 · ' + G.games.length + '</div>'
            + G.games.map((g) => '<button class="gk-game' + (g.id === G.gameId ? ' active' : '')
                + '" data-gk-game="' + g.id + '">'
                + (g.icon ? '<img src="' + esc(g.icon) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<i class="gk-game-ph"></i>')
                + '<span><b>' + esc(g.name) + '</b><small>' + esc(g.alias) + '</small></span>'
                + '</button>').join('');
    }

    async function gOpenGame(id) {
        if (!id) return;
        G.gameId = id;
        gRenderGames();
        const head = groot().querySelector('#gkGameHead');
        const list = groot().querySelector('#gkList');
        const art = groot().querySelector('#gkArticle');
        const tabs = groot().querySelector('#gkTabs');
        if (tabs) tabs.style.display = 'none';
        if (head) head.innerHTML = '<div class="wk-loading"><span class="wk-spin"></span>打开游戏…</div>';
        if (list) list.innerHTML = '';
        if (art) art.innerHTML = '<div class="wk-placeholder">左边选文章，或切到「目录」。</div>';
        G.tree = [];
        G.articles = [];
        try {
            const [g, a] = await Promise.all([
                api('/api/gamekee/game?id=' + id, { timeout: 30000 }),
                api('/api/gamekee/articles?gameId=' + id + '&page=1&limit=20', { timeout: 30000 }),
            ]);
            if (g && g.code === 0 && g.data) {
                const d = g.data;
                const ginfo = d.game || {};
                if (head) {
                    head.innerHTML = '<div class="gk-game-title">'
                        + (ginfo.icon ? '<img src="' + esc(ginfo.icon) + '" alt="">' : '')
                        + '<div><h3>' + esc(ginfo.name) + '</h3>'
                        + '<div class="gk-game-meta">' + esc((d.ext && d.ext.developer) || '') 
                        + ((d.ext && d.ext.pubArea) ? ' · ' + esc(d.ext.pubArea) : '') + '</div></div></div>'
                        + ((d.ext && d.ext.desc) ? '<p class="gk-game-desc">' + esc(d.ext.desc) + '</p>' : '');
                }
            }
            if (a && a.code === 0 && a.data) {
                G.articles = a.data.items || [];
                gRenderList();
                if (tabs) tabs.style.display = '';
            } else {
                if (list) list.innerHTML = '<div class="wk-error">' + esc((a && a.msg) || '文章列表加载失败') + '</div>';
            }
            gLoadTree(id, 0);
        } catch (e) {
            if (head) head.innerHTML = '<div class="wk-error">' + esc(e.message) + '</div>';
        }
    }

    async function gLoadTree(gameId, pid) {
        try {
            const r = await api('/api/gamekee/tree?gameId=' + gameId + '&pid=' + (pid || 0), { timeout: 30000 });
            const nodes = (r && r.code === 0 && r.data && r.data.nodes) || [];
            if (!pid) G.tree = nodes;
            if (G.tab === 'tree') gRenderList();
        } catch (e) { /* 目录失败不影响文章 */ }
    }

    function gRenderList() {
        const box = groot() && groot().querySelector('#gkList');
        if (!box) return;
        if (G.tab === 'articles') {
            if (!G.articles.length) { box.innerHTML = '<div class="wk-placeholder">这个游戏还没有文章。</div>'; return; }
            box.innerHTML = G.articles.map((a) => '<button class="gk-art-row" data-gk-article="' + a.id + '">'
                + (a.thumb ? '<img src="' + esc(a.thumb) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '')
                + '<span><b>' + esc(a.title) + '</b><small>' + esc((a.summary || '').slice(0, 70)) + '</small></span>'
                + '</button>').join('');
            return;
        }
        const nodes = G.tree || [];
        if (!nodes.length) { box.innerHTML = '<div class="wk-placeholder">目录为空。</div>'; return; }
        box.innerHTML = nodes.map((n) => '<button class="gk-node' + (n.contentId ? ' is-art' : '')
            + '" data-gk-node="' + n.id + '"' + (n.contentId ? ' data-gk-content="' + n.contentId + '"' : '') + '>'
            + '<span class="gk-node-name">' + esc(n.name) + '</span>'
            + '<span class="gk-node-tag">' + (n.contentId ? '文章' : '目录') + '</span>'
            + '</button>').join('');
    }

    async function gOpenNode(nodeId) {
        const nodes = G.tree || [];
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) return;
        if (node.contentId) { gOpenArticle(node.contentId); return; }
        try {
            const r = await api('/api/gamekee/tree?gameId=' + G.gameId + '&pid=' + node.id, { timeout: 30000 });
            const kids = (r && r.code === 0 && r.data && r.data.nodes) || [];
            const box = groot().querySelector('#gkList');
            if (!box) return;
            // 展开：把子节点插到当前节点之后
            const btn = box.querySelector('[data-gk-node="' + node.id + '"]');
            if (btn) {
                const html = kids.map((n) => '<button class="gk-node child' + (n.contentId ? ' is-art' : '')
                    + '" data-gk-node="' + n.id + '"><span class="gk-node-name">' + esc(n.name) + '</span>'
                    + '<span class="gk-node-tag">' + (n.contentId ? '文章' : '目录') + '</span></button>').join('');
                btn.insertAdjacentHTML('afterend', html);
                btn.disabled = true;
                btn.classList.add('expanded');
                kids.forEach((k) => nodes.push(k));
            }
        } catch (e) { notify('目录展开失败', e.message); }
    }

    async function gOpenArticle(id) {
        const art = groot() && groot().querySelector('#gkArticle');
        if (art) art.innerHTML = '<div class="wk-loading"><span class="wk-spin"></span>加载文章…</div>';
        const seq = ++G.seq;
        try {
            const r = await api('/api/gamekee/article?id=' + id, { timeout: 35000 });
            if (seq !== G.seq) return;
            if (!r || r.code !== 0 || !r.data) throw new Error((r && r.msg) || '加载失败');
            const d = r.data;
            if (art) {
                art.innerHTML = '<div class="wk-art gk-art">'
                    + '<header class="gk-art-head"><div class="wk-art-kicker">GameKee 攻略</div>'
                    + '<h1>' + esc(d.title || '未命名') + '</h1>'
                    + '<div class="wk-art-meta">' + (d.wordCount ? d.wordCount + ' 字 · ' : '')
                    + (d.updatedAt ? new Date(d.updatedAt * 1000).toLocaleDateString('zh-CN') : '') + '</div></header>'
                    + '<div class="wk-content">' + (d.html || '<div class="wk-placeholder">这篇内容没有正文。</div>') + '</div>'
                    + '</div>';
                art.scrollTop = 0;
            }
        } catch (e) {
            if (seq !== G.seq) return;
            if (art) art.innerHTML = '<div class="wk-error">加载失败：' + esc(e.message) + '</div>';
        }
    }

    function gShow() {
        const r = groot();
        if (!r) return;
        r.style.display = 'block';
        document.body.classList.add('gk-mode');
        gBuild();
        if (!G.games.length) gLoadGames('');
    }
    function gHide() {
        const r = groot();
        if (r) r.style.display = 'none';
        document.body.classList.remove('gk-mode');
    }

    window.GameKeeView = { show: gShow, hide: gHide };
})();
