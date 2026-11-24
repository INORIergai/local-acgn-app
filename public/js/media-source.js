/**
 * 番剧解析（站点解析器前端）—— round36 批次B
 * ============================================================
 * 与「在线观看（内嵌网页）」是两条互补的路子：
 *   在线观看 = 把别人的网页塞进 iframe，能不能用取决于对方让不让嵌；
 *   番剧解析 = 服务端按声明式源定义把网页**读成数据**（剧集 → 真流地址），
 *              再用应用自带播放器（hls.js）+ 弹幕播出来，不再受 iframe 限制。
 *
 * 导航分级（回应用户「左侧+次级+三级」的诉求）：
 *   一级 = 左栏「在线 → 🔎 番剧解析」
 *   二级 = 主体顶部 tab：聚合搜索 / BT资源 / 源管理 / 观看历史
 *   三级 = 页内分组：搜索结果里点一部 → 就地展开剧集区（不跳页、不弹窗）
 */
window.MediaSource = (function () {
    const TABS = [
        { key: 'discover', name: '🧭 发现' },
        { key: 'stream', name: '🎬 私密流' },
        { key: 'read', name: '📖 在线阅读' },
        { key: 'search', name: '🔍 聚合搜索' },
        { key: 'bt', name: '🧲 BT资源' },
        { key: 'sources', name: '🧩 源管理' },
        { key: 'history', name: '🕘 观看历史' }
    ];
    /* 2026-11：成人入口隐藏时，「私密流」tab 不出现（AV / 里番字样也不展示） */
    function adultHidden() {
        return (typeof window.isAdultNavHidden === 'function') && window.isAdultNavHidden();
    }
    function visibleTabs() {
        return adultHidden() ? TABS.filter(function (t) { return t.key !== 'stream'; }) : TABS;
    }
    const LS_DISABLED = 'cv:msDisabled';
    const LS_HISTORY = 'cv:msHistory';
    const LS_HISTORY_PENDING = 'cv:msHistoryPending';
    const LS_HISTORY_READY = 'cv:msHistoryServer';
    const LS_HISTORY_CLEAR = 'cv:msHistoryClearPending';

    let curTab = 'discover';
    let mounted = false;
    let query = '';
    let statusCache = {};   // 源 id -> 探测结果
    let currentSession = null;
    let playToken = 0;
    let searchCache = null;
    const failedLines = new Set(); // 本次运行内解析/播放失败的线路，自动换源会跳过
    let failoverDepth = 0;
    let historySyncState = '';   // server / offline
    let historyPulling = null;
    let historyRenderSeq = 0;
    let streamBoard = 'av';       // av | hanime
    let streamSiteKey = '';
    let streamSiteList = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function notify(t, m, lv) {
        if (typeof window.showNotification === 'function') window.showNotification(t, m, 3200, lv || 'info');
    }
    function disabledSet() {
        try { return new Set(JSON.parse(localStorage.getItem(LS_DISABLED) || '[]')); }
        catch (e) { return new Set(); }
    }
    function saveDisabled(set) {
        localStorage.setItem(LS_DISABLED, JSON.stringify(Array.from(set)));
    }
    function history() {
        try {
            const list = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }
    function writeHistory(list) {
        try { localStorage.setItem(LS_HISTORY, JSON.stringify((list || []).slice(0, 60))); }
        catch (e) { /* 本地镜像写失败不阻塞播放 */ }
    }
    function pendingHistory() {
        try {
            const list = JSON.parse(localStorage.getItem(LS_HISTORY_PENDING) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }
    function savePendingHistory(list) {
        try { localStorage.setItem(LS_HISTORY_PENDING, JSON.stringify((list || []).slice(0, 100))); }
        catch (e) { /* 队列入库失败时仍保留 localStorage 主记录 */ }
    }
    function historyKey(rec) {
        return String(rec && rec.sourceId || '') + '|' + String(rec && rec.url || '');
    }
    function historyFingerprint(list) {
        return JSON.stringify((list || []).map((x) => [
            x.sourceId, x.url, x.title, x.episode,
            Number(x.position) || 0, Number(x.duration) || 0,
            x.completed ? 1 : 0, Number(x.at) || 0
        ]));
    }
    function normalizeHistoryRecord(rec) {
        const out = Object.assign({}, rec);
        out.at = Number(out.at) || Number(out.updatedAt) || 0;
        out.updatedAt = Number(out.updatedAt) || out.at;
        out.index = Number.isInteger(out.index) ? out.index : 0;
        out.episodes = Array.isArray(out.episodes) ? out.episodes : [];
        out.position = Math.max(0, Number(out.position) || 0);
        out.duration = Math.max(0, Number(out.duration) || 0);
        out.completed = !!out.completed;
        return out;
    }
    function mergeHistoryLists() {
        const map = new Map();
        for (let i = 0; i < arguments.length; i++) {
            for (const raw of arguments[i] || []) {
                const rec = normalizeHistoryRecord(raw);
                const key = historyKey(rec);
                if (!rec.sourceId || !rec.url) continue;
                const old = map.get(key);
                if (!old || (rec.updatedAt || rec.at) >= (old.updatedAt || old.at)) map.set(key, rec);
            }
        }
        return Array.from(map.values())
            .sort((a, b) => (b.updatedAt || b.at) - (a.updatedAt || a.at))
            .slice(0, 60);
    }
    function queueHistoryPending(rec) {
        const list = pendingHistory().filter((x) => historyKey(x) !== historyKey(rec));
        list.unshift(rec);
        savePendingHistory(list);
    }
    function unqueueHistoryPending(rec) {
        const at = Number(rec && (rec.updatedAt || rec.at)) || 0;
        savePendingHistory(pendingHistory().filter((x) => {
            if (historyKey(x) !== historyKey(rec)) return true;
            // 同一条记录在请求途中又被更新时，保留更新的待同步副本。
            return (Number(x.updatedAt || x.at) || 0) > at;
        }));
    }
    async function syncHistoryRecord(rec) {
        try {
            const r = await fetch('/api/media-source/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rec)
            });
            const j = await r.json();
            if (j.code !== 0) throw new Error(j.msg || '同步失败');
            unqueueHistoryPending(rec);
            historySyncState = 'server';
        } catch (e) {
            // 离线时保留本地记录与待同步队列，下次打开历史页再补传。
            historySyncState = 'offline';
        }
    }
    function pushHistory(rec) {
        const now = Date.now();
        const item = normalizeHistoryRecord(Object.assign({}, rec, {
            at: Number(rec && rec.at) || now,
            updatedAt: now
        }));
        const list = history().filter((x) => historyKey(x) !== historyKey(item));
        list.unshift(item);
        writeHistory(list);
        queueHistoryPending(item);
        void syncHistoryRecord(item);
    }
    async function pullHistory() {
        if (historyPulling) return historyPulling;
        historyPulling = (async () => {
            const before = historyFingerprint(history());
            let local = history();
            if (localStorage.getItem(LS_HISTORY_CLEAR) === '1') {
                try {
                    const r = await fetch('/api/media-source/history', { method: 'DELETE' });
                    const j = await r.json();
                    if (j.code !== 0) throw new Error(j.msg || '清空失败');
                    localStorage.removeItem(LS_HISTORY_CLEAR);
                    savePendingHistory([]);
                    writeHistory([]);
                    local = [];
                    historySyncState = 'server';
                } catch (e) {
                    historySyncState = 'offline';
                    return false;
                }
            }
            const first = localStorage.getItem(LS_HISTORY_READY) !== '1';
            const pending = pendingHistory();
            const seed = first ? mergeHistoryLists(pending, local) : pending;
            if (seed.length) {
                try {
                    const r = await fetch('/api/media-source/history/merge', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ items: seed })
                    });
                    const j = await r.json();
                    if (j.code !== 0) throw new Error(j.msg || '历史同步失败');
                    if (first) localStorage.setItem(LS_HISTORY_READY, '1');
                    const seeded = new Set(seed.map(historyKey));
                    savePendingHistory(pendingHistory().filter((x) => !seeded.has(historyKey(x))));
                } catch (e) {
                    historySyncState = 'offline';
                    return false;
                }
            } else if (first) {
                localStorage.setItem(LS_HISTORY_READY, '1');
            }
            try {
                const r = await fetch('/api/media-source/history?limit=60');
                const j = await r.json();
                if (j.code !== 0 || !Array.isArray(j.data)) throw new Error(j.msg || '历史读取失败');
                // 服务器是已同步记录的事实来源；只保留尚未上传成功的本地记录。
                const merged = mergeHistoryLists(j.data, pendingHistory());
                writeHistory(merged);
                historySyncState = 'server';
                return historyFingerprint(merged) !== before;
            } catch (e) {
                historySyncState = 'offline';
                return false;
            }
        })().finally(() => { historyPulling = null; });
        return historyPulling;
    }
    function savePlaybackProgress(position, duration, ended) {
        const s = currentSession;
        if (!s) return;
        const pos = Math.max(0, Math.floor(Number(position) || 0));
        const dur = Math.max(0, Math.floor(Number(duration) || 0));
        const done = ended === true;
        if (done && dur > 0 && pos < dur * 0.9) return;
        const list = history();
        const old = list.find((x) => x.url === s.url && x.sourceId === s.sourceId);
        pushHistory({
            ...old,
            title: s.title,
            episode: s.episode,
            sourceId: s.sourceId,
            sourceName: s.sourceName,
            url: s.url,
            workUrl: s.workUrl || (old && old.workUrl) || '',
            episodes: s.episodes || (old && old.episodes) || [],
            index: s.index,
            kind: s.kind || (old && old.kind) || '',
            position: done ? 0 : pos,
            duration: dur,
            completed: done,
            at: Date.now()
        });
    }
    function clearPlayback() {
        playToken++;
        currentSession = null;
        window.currentOnlinePlayback = null;
        if (window.currentPlaylist) {
            window.currentPlaylist = null;
            window.currentPlaylistIndex = null;
        }
    }
    function searchPath(q) {
        const enabled = Array.from(disabledSet());
        return '/api/media-source/search?q=' + encodeURIComponent(q)
            + (enabled.length ? '&exclude=' + encodeURIComponent(enabled.join(',')) : '');
    }
    async function searchEnabled(q, force = false) {
        const dis = disabledSet();
        if (!force && searchCache && searchCache.q === q && searchCache.disabled === Array.from(dis).sort().join(',')) {
            return searchCache.data;
        }
        const data = await api(searchPath(q));
        searchCache = { q, disabled: Array.from(dis).sort().join(','), data };
        return data;
    }
    function lineKeyOf(sourceId, url) {
        const tm = window.TitleMatch;
        return tm ? tm.lineKey(sourceId, url) : String(sourceId || '') + '|' + String(url || '');
    }
    function flattenSearch(data) {
        const out = [];
        (Array.isArray(data) ? data : []).forEach((g) => {
            (g.items || []).forEach((it) => out.push({
                sourceId: g.sourceId,
                sourceName: g.sourceName,
                tier: g.tier,
                name: it.name,
                url: it.url
            }));
        });
        return out;
    }
    function matchBadge(m) {
        if (!m) return '';
        const cls = m.level === 'exact' ? 'is-exact'
            : m.level === 'same' ? 'is-same'
                : m.level === 'season' ? 'is-season'
                    : m.level === 'special' ? 'is-special' : 'is-low';
        const text = m.level === 'exact' ? '精确'
            : m.level === 'same' ? '接近'
                : m.level === 'season' ? '季度'
                    : m.level === 'special' ? '特别篇' : '低相关';
        if (m.level === 'other' && m.score < 50) return '';
        return `<span class="ms-item-badge ${cls}" title="${esc(m.reason)} · ${m.score}%">${text}<i>${m.score}</i></span>`;
    }

    async function api(path) {
        const r = await fetch(path);
        const j = await r.json();
        if (j.code !== 0 && j.code != null) throw new Error(j.msg || '接口返回错误');
        if (!j.data || typeof j.data !== 'object') throw new Error('接口返回内容不完整');
        return j.data;
    }

    // ==========================================================
    // 外壳 + 次级 tab
    // ==========================================================
    function shell() {
        const view = document.getElementById('featureView');
        if (!view) return null;
        if (!mounted || !document.getElementById('msRoot')) {
            view.innerHTML = `
                <div class="panel-section ms-full" id="msRoot">
                    <div class="ms-subtabs" id="msTabs">
                        ${visibleTabs().map((t) => `<button class="ms-tab" data-ms-tab="${t.key}">${t.name}</button>`).join('')}
                    </div>
                    <div class="ms-body" id="msBody"></div>
                </div>`;
            view.querySelectorAll('[data-ms-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.msTab)));
            mounted = true;
        }
        return view;
    }

    function switchTab(key) {
        curTab = key;
        shell();
        document.querySelectorAll('[data-ms-tab]').forEach((b) => b.classList.toggle('on', b.dataset.msTab === key));
        const body = document.getElementById('msBody');
        if (!body) return;
        if (key === 'discover') renderDiscover(body);
        else if (key === 'stream') renderStream(body);
        else if (key === 'read') renderRead(body);
        else if (key === 'search') renderSearch(body);
        else if (key === 'bt') renderBt(body);
        else if (key === 'sources') renderSources(body);
        else renderHistory(body);
    }

    /** 一级入口：由 switchView('ms') 调起 */
    function show(tab, opts) {
        if (adultHidden() && ((opts && opts.board) || (tab || curTab) === 'stream')) {
            tab = 'discover';
            if (opts) { opts = Object.assign({}, opts); delete opts.board; }
        }
        if (opts && opts.board) streamBoard = opts.board;
        if (opts && opts.board) curTab = 'stream';
        if (opts && opts.kind) readKind = opts.kind;
        if (opts && opts.adapter) readAdapter = opts.adapter;
        else if (opts && opts.kind) readAdapter = opts.kind === 'novel' ? 'esjzone' : 'dm5';
        if (opts && opts.adapter) curTab = 'read';
        if (opts && opts.kind) curTab = 'read';
        const view = shell();
        if (!view) return;
        view.style.display = 'block';
        switchTab(tab || curTab);
    }

    /** 带词从别处跳进来（榜单 / 时间表 / 聚合页联动） */
    function openWithQuery(q, tab) {
        curTab = tab || 'search';
        show(curTab);
        const inp = document.getElementById('msQ');
        if (inp) { inp.value = q; setTimeout(() => doSearch(q), 30); }
    }

    // ==========================================================
    // 二级 tab 0：发现（r153 · D：原生浏览墙，不跳 iframe）
    // ==========================================================
    async function renderDiscover(body) {
        body.innerHTML = `
            <div class="ms-searchbar">
                <input id="msDiscQ" type="text" placeholder="直接搜片名，或点下面的源站逛目录" autocomplete="off">
                <button class="btn btn-primary" id="msDiscGo">🔍 搜索</button>
                <span class="ms-hint">全程在应用内播放 · 解析不到才退回原站排障</span>
            </div>
            <div class="ms-results" id="msResults"><div class="ms-empty">正在读取源站清单…</div></div>
            <div class="ms-eps" id="msEps"></div>
            <div class="ms-discover" id="msSourceGrid"></div>`;
        const q = body.querySelector('#msDiscQ');
        body.querySelector('#msDiscGo').addEventListener('click', () => {
            if (q.value.trim()) { switchTab('search'); const inp = document.getElementById('msQ'); if (inp) { inp.value = q.value.trim(); doSearch(inp.value); } }
        });
        q.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !q.value.trim()) return;
            switchTab('search');
            const inp = document.getElementById('msQ');
            if (inp) { inp.value = q.value.trim(); doSearch(inp.value); }
        });
        const grid = body.querySelector('#msSourceGrid');
        let list = [];
        try { list = await api('/api/media-source/sources'); } catch (e) { list = []; }
        const usable = list.filter((s) => s.kind === 'web');
        document.getElementById('msResults').innerHTML = usable.length
            ? `<div class="ms-summary">${usable.length} 个可用解析源 · 点源站直接逛目录，或先搜索</div>`
            : '<div class="ms-empty">没有可用源。去「源管理」刷新订阅。</div>';
        grid.innerHTML = usable.map((s) => `
            <button class="ms-source-card" data-disc-src="${esc(s.id)}" data-disc-name="${esc(s.name)}">
                ${s.iconUrl ? `<img src="${esc(s.iconUrl)}" alt="" onerror="this.style.display='none'">` : '<span>🎞️</span>'}
                <span><b>${esc(s.name)}</b><span>T${s.tier} · ${esc(s.host || '')}</span></span>
            </button>`).join('');
        grid.querySelectorAll('[data-disc-src]').forEach((el) => {
            el.addEventListener('click', () => loadCatalog(el.dataset.discSrc, el.dataset.discName));
        });
    }

    async function loadCatalog(sourceId, sourceName) {
        const box = document.getElementById('msResults');
        if (!box) return;
        box.innerHTML = `<div class="ms-loading">正在读取「${esc(sourceName)}」目录…（部分站点必须带关键词，取不到就会提示）</div>`;
        let d;
        try {
            d = await api('/api/media-source/catalog?source=' + encodeURIComponent(sourceId) + '&limit=36');
        } catch (e) {
            box.innerHTML = `<div class="ms-empty">读取目录失败：${esc(e.message)}</div>`;
            return;
        }
        d = d || {};
        if (!d.items || !d.items.length) {
            box.innerHTML = `<div class="ms-empty">「${esc(sourceName)}」目录没取到：${esc(d.error || '未知原因')}。<br>回「聚合搜索」直接输片名更稳。</div>`;
            return;
        }
        box.innerHTML = `
            <div class="ms-summary">「${esc(sourceName)}」当前目录 · ${d.items.length} 条（点一部直接进选集）</div>
            ${d.items.map((it) => `
                <div class="ms-item" data-src="${esc(sourceId)}" data-url="${esc(it.url)}" data-name="${esc(it.name)}">
                    <span class="ms-item-n">${esc(it.name)}</span>
                    <span class="ms-item-go">选集 ▸</span>
                </div>`).join('')}`;
        box.querySelectorAll('.ms-item').forEach((el) => el.addEventListener('click', () => {
            loadEpisodes(el.dataset.src, el.dataset.url, el.dataset.name);
        }));
    }

    // ==========================================================
    // 二级 tab：私密流（阶段2 · AV / 里番去 iframe）
    // 只取源站列表与作品页里的真实流地址，界面与播放全在应用内；
    // 原站整站窗口只作为「过 CF / 解析失败」的排障兜底。
    // ==========================================================
    async function loadStreamSites(force) {
        if (streamSiteList && !force) return streamSiteList;
        const r = await (await fetch('/api/webview/sites')).json();
        streamSiteList = (r.data || []).filter((s) => s.board === 'av' || s.board === 'hanime');
        return streamSiteList;
    }

    async function renderStream(body) {
        body.innerHTML = `
            <div class="ms-searchbar msv-head">
                <div class="msv-boards">
                    <button class="msv-board${streamBoard === 'av' ? ' on' : ''}" data-msv-board="av">🔞 私密影片</button>
                    <button class="msv-board${streamBoard === 'hanime' ? ' on' : ''}" data-msv-board="hanime">🎴 里番</button>
                </div>
                <button class="btn btn-sm btn-secondary" id="msvOrigin">🛠 原站排障</button>
                <span class="ms-hint">只抽源站数据 → 应用内原生播放，不渲染对方网页</span>
            </div>
            <div class="ms-discover" id="msvSources"><div class="ms-empty">正在读取源站清单…</div></div>
            <div class="ms-results">
                <div class="msv-chips" id="msvChips"></div>
                <div class="msv-grid" id="msvGrid"><div class="ms-empty">选一个源站开始浏览</div></div>
            </div>
            <div class="msv-sheet" id="msvSheet"></div>`;
        body.querySelectorAll('[data-msv-board]').forEach((b) => b.addEventListener('click', () => {
            streamBoard = b.dataset.msvBoard;
            streamSiteKey = '';
            renderStream(document.getElementById('msBody'));
        }));
        body.querySelector('#msvOrigin').addEventListener('click', () => {
            window.switchView(streamBoard === 'hanime' ? 'watch-origin-hanime' : 'watch-origin');
        });

        let list = [];
        try { list = await loadStreamSites(); } catch (e) {
            body.querySelector('#msvSources').innerHTML = `<div class="ms-empty">源站清单读取失败：${esc(e.message)}</div>`;
            return;
        }
        const mine = list.filter((s) => s.board === streamBoard);
        const srcBox = body.querySelector('#msvSources');
        srcBox.innerHTML = mine.map((s) => `
            <button class="ms-source-card${s.canList ? '' : ' is-off'}" data-msv-src="${esc(s.key)}">
                <span>${s.board === 'hanime' ? '🎴' : '🎬'}</span>
                <span><b>${esc(s.name)}</b><span>${s.canList
                    ? ((s.categories && s.categories.length) ? s.categories.length + ' 个分类' : '目录可抓')
                    : '需人机验证 · 仅原站'}</span></span>
            </button>`).join('') || '<div class="ms-empty">这个板块还没有可抓目录的源</div>';
        srcBox.querySelectorAll('[data-msv-src]').forEach((el) => el.addEventListener('click', () => {
            srcBox.querySelectorAll('[data-msv-src]').forEach((x) => x.classList.remove('on'));
            el.classList.add('on');
            loadStreamCatalog(el.dataset.msvSrc, '');
        }));
        if (streamSiteKey) {
            const cur = srcBox.querySelector(`[data-msv-src="${streamSiteKey}"]`);
            if (cur) { cur.classList.add('on'); loadStreamCatalog(streamSiteKey, ''); }
        }
    }

    async function loadStreamCatalog(key, path) {
        const site = (streamSiteList || []).find((s) => s.key === key);
        const grid = document.getElementById('msvGrid');
        const chips = document.getElementById('msvChips');
        if (!grid || !site) return;
        streamSiteKey = key;
        if (chips) chips.innerHTML = '';
        grid.innerHTML = `<div class="ms-loading">正在抓「${esc(site.name)}」目录…（无头浏览器首次启动约 10~15 秒）</div>`;
        let d;
        try {
            const url = `/api/webview/list?site=${encodeURIComponent(key)}&limit=48${path ? '&path=' + encodeURIComponent(path) : ''}`;
            d = await (await fetch(url)).json();
        } catch (e) {
            grid.innerHTML = `<div class="ms-empty">目录读取失败：${esc(e.message)}</div>`;
            return;
        }
        if (d.code !== 0) { grid.innerHTML = `<div class="ms-empty">${esc(d.msg || '读取失败')}</div>`; return; }
        const items = (d.data && d.data.items) || [];
        if (!items.length) { grid.innerHTML = `<div class="ms-empty">没有抓到条目，换一个源或稍后重试</div>`; return; }
        const cats = [{ name: '全部', path: '' }].concat(site.categories || []);
        if (chips && cats.length > 1) {
            chips.innerHTML = cats.map((c) => `<button class="msv-chip${(c.path || '') === (path || '') ? ' on' : ''}" data-path="${esc(c.path || '')}">${esc(c.name)}</button>`).join('');
            chips.querySelectorAll('[data-path]').forEach((b) => b.addEventListener('click', () => loadStreamCatalog(key, b.dataset.path)));
        }
        grid.innerHTML = items.map((it) => `
            <button class="msv-card" data-url="${esc(it.href)}" data-title="${esc(it.title)}" data-cover="${esc(it.cover)}">
                <img src="${esc(it.cover)}" loading="lazy" alt="" onerror="this.style.visibility='hidden'">
                <b>${esc(it.title)}</b>
                <span>${esc(it.duration || '')}</span>
            </button>`).join('');
        grid.querySelectorAll('.msv-card').forEach((el) => el.addEventListener('click', () => {
            openStreamSheet(site, { href: el.dataset.url, title: el.dataset.title, cover: el.dataset.cover });
        }));
    }

    function openStreamSheet(site, item) {
        const sheet = document.getElementById('msvSheet');
        if (!sheet) return;
        sheet.classList.add('on');
        sheet.innerHTML = `
            <div class="msv-card-lg">
                <div class="msv-lg-top">
                    <img src="${esc(item.cover)}" alt="">
                    <div>
                        <div class="msv-kicker">${esc(site.name)} · 原生播放</div>
                        <h3>${esc(item.title)}</h3>
                        <p>只读作品页数据，视频交给应用自带播放器；解析不到再退回原站。</p>
                    </div>
                </div>
                <div class="msv-acts">
                    <button class="btn btn-primary" id="msvPlay">▶ 原生播放</button>
                    <button class="btn btn-secondary" id="msvOrigin2">🌐 原站排障</button>
                    <button class="btn btn-secondary" id="msvClose">关闭</button>
                </div>
                <div class="msv-status" id="msvStatus"></div>
            </div>`;
        const close = () => { sheet.classList.remove('on'); sheet.innerHTML = ''; };
        const goOrigin = () => {
            close();
            window.switchView(streamBoard === 'hanime' ? 'watch-origin-hanime' : 'watch-origin');
        };
        sheet.querySelector('#msvClose').addEventListener('click', close);
        sheet.querySelector('#msvOrigin2').addEventListener('click', goOrigin);
        sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); }, { once: true });

        const status = sheet.querySelector('#msvStatus');
        sheet.querySelector('#msvPlay').addEventListener('click', async () => {
            status.textContent = '正在嗅探真实视频流…（首次打开该站要过 CF，约 10~30 秒）';
            try {
                const r = await (await fetch('/api/webview/resolve?url=' + encodeURIComponent(item.href))).json();
                if (r.code !== 0 || !r.data || !r.data.url) throw new Error(r.msg || '没嗅到视频流');
                pushHistory({ url: item.href, sourceId: site.key, sourceName: site.name, title: item.title, episode: '', at: Date.now() });
                close();
                if (typeof window.showVideoPlayer === 'function') {
                    window.showVideoPlayer(r.data.url, item.title, r.data.kind);
                    // 自动播放策略可能拦下有声起播：被拦时提示手动点一下，别让用户对着黑屏猜
                    setTimeout(() => {
                        const v = document.getElementById('videoPlayer');
                        if (v && v.paused) {
                            v.play().catch(() => notify('已就绪', '点一下播放器 ▶ 即可开始，浏览器拦下了自动播放', 'info'));
                        }
                    }, 2500);
                }
                else window.open(r.data.url, '_blank');
            } catch (e) {
                status.innerHTML = `解析失败：${esc(e.message)} <button class="btn btn-sm btn-secondary" id="msvOrigin3">去原站看</button>`;
                const o = sheet.querySelector('#msvOrigin3');
                if (o) o.addEventListener('click', goOrigin);
            }
        });
    }

    // ==========================================================
    // 二级 tab：在线阅读（阶段3 · 漫画 / 小说直投原生阅读层）
    // 源站只提供目录与章节内容；阅读界面、翻章、图片墙都在应用内。
    // ==========================================================
    let readKind = 'manga';
    let readAdapter = 'dm5';
    let readChapters = [];
    let readIndex = 0;
    let readOpenSeq = 0;
    let readAdapterName = '';
    let readItem = null;
    let stopReadRestore = null;
    const LS_READ_LAST = 'cv:rdrLast';
    const LS_READ_SCROLL = 'cv:rdrScroll';
    const READ_SCROLL_MAX = 80;
    // 同一章来回翻时别再走一遍源站（ESJ 单章最慢 30s），最多留 24 章
    const readChapterCache = new Map();
    const readChapterPending = new Map();
    const READ_CACHE_MAX = 24;
    // 第四批：跨源搜索 + 换源续读
    let readWallAdapter = '';      // 书墙当前加载的源，换源后据此重载目录
    let readCrossGroups = [];      // 最近一次跨源结果
    let readCrossSeq = 0;          // 防串号
    let readSwitchMode = false;    // true = 换源续读，false = 普通跨源搜索

    function readLast() {
        try { return JSON.parse(localStorage.getItem(LS_READ_LAST) || 'null'); }
        catch (e) { return null; }
    }
    function readScrollMap() {
        try { return JSON.parse(localStorage.getItem(LS_READ_SCROLL) || '{}') || {}; }
        catch (e) { return {}; }
    }
    function readScrollKey(index) {
        return readAdapter + '|' + (readItem && readItem.url) + '|' + index;
    }
    function readScrollFor(index) {
        const map = readScrollMap();
        const hit = map[readScrollKey(index)];
        if (hit && typeof hit.r === 'number') return hit.r;
        const last = readLast();
        return last && last.adapter === readAdapter && last.url === readItem.url && last.index === index
            ? Number(last.scroll) || 0 : 0;
    }
    function saveReadLast(index = readIndex) {
        if (!readItem) return;
        try {
            const b = document.getElementById('rdrBody');
            const scroll = b && b.scrollHeight > b.clientHeight
                ? b.scrollTop / (b.scrollHeight - b.clientHeight) : 0;
            const ratio = Number(scroll.toFixed(3));
            localStorage.setItem(LS_READ_LAST, JSON.stringify({
                adapter: readAdapter, url: readItem.url, name: readItem.name,
                index, scroll: ratio, at: Date.now()
            }));
            // 翻回上一章、关掉重开都靠这张按章比例表（单槽 last 只保最后读的一章）
            const map = readScrollMap();
            map[readScrollKey(index)] = { r: ratio, at: Date.now() };
            const keys = Object.keys(map);
            if (keys.length > READ_SCROLL_MAX) {
                keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
                    .slice(0, keys.length - READ_SCROLL_MAX)
                    .forEach((k) => delete map[k]);
            }
            localStorage.setItem(LS_READ_SCROLL, JSON.stringify(map));
        } catch (e) { /* 隐私模式写不进就算了 */ }
    }

    function getReadChapter(adapter, url) {
        const key = adapter + '|' + url;
        if (readChapterCache.has(key)) {
            const hit = readChapterCache.get(key);
            readChapterCache.delete(key);
            readChapterCache.set(key, hit);
            return Promise.resolve(hit);
        }
        if (readChapterPending.has(key)) return readChapterPending.get(key);
        const pending = api('/api/media-source/reading/chapter?adapter=' + encodeURIComponent(adapter)
            + '&url=' + encodeURIComponent(url)).then((d) => {
            if (d) {
                readChapterCache.set(key, d);
                while (readChapterCache.size > READ_CACHE_MAX) {
                    readChapterCache.delete(readChapterCache.keys().next().value);
                }
            }
            return d;
        }).finally(() => readChapterPending.delete(key));
        readChapterPending.set(key, pending);
        return pending;
    }

    // 慢源（ESJ 目录首抓约 20 秒）至少让用户看到秒数在走
    function loadingWithTimer(el, text) {
        const start = Date.now();
        el.innerHTML = `<div class="ms-loading">${esc(text)}<span class="rdr-elapsed">0s</span></div>`;
        const timer = setInterval(() => {
            const label = el.querySelector('.rdr-elapsed');
            if (label) label.textContent = Math.round((Date.now() - start) / 1000) + 's';
        }, 800);
        return () => clearInterval(timer);
    }

    // 漫画图没有预设高度，必须等图撑开再按比例落位，否则恢复的是「空页面」的 0
    function restoreReadScroll(body, ratio, onRestore, onDone) {
        if (!(ratio > 0)) return () => {};
        const imgs = Array.from(body.querySelectorAll('img'));
        const start = Date.now();
        let canceled = false;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearInterval(timer);
            body.removeEventListener('wheel', cancel);
            body.removeEventListener('touchstart', cancel);
            body.removeEventListener('keydown', cancel);
            if (stopReadRestore === cancel) stopReadRestore = null;
            if (onDone) onDone();
        };
        const pump = () => {
            if (canceled || !body.isConnected) { finish(); return; }
            const max = body.scrollHeight - body.clientHeight;
            if (max > 4) {
                if (onRestore) onRestore();
                body.scrollTop = ratio * max;
            }
            if (!imgs.some((i) => !i.complete) || Date.now() - start > 4000) finish();
        };
        const timer = setInterval(pump, 150);
        pump();
        const cancel = () => { canceled = true; finish(); };
        body.addEventListener('wheel', cancel, { once: true, passive: true });
        body.addEventListener('touchstart', cancel, { once: true, passive: true });
        body.addEventListener('keydown', cancel, { once: true });
        return cancel;
    }

    let readItems = [];
    let readQuery = '';
    let readSortMode = 'default';

    const readKindLabel = () => readKind === 'novel' ? '小说' : '漫画';

    async function renderRead(body) {
        const novel = readKind === 'novel';
        body.innerHTML = `
            <div class="rh-shell">
                <header class="rh-head">
                    <div class="rh-intro">
                        <p class="rh-kicker">LIBRARY READER · 源站目录直连</p>
                        <h2 class="rh-title">${novel ? '小说书墙' : '漫画书墙'}</h2>
                        <p class="rh-sub">${novel ? '封面、目录、正文一次到位。翻章和进度都在应用内，不打开展示不全的网页。' : '封面、章节、整章图片一次到位。点封面进详情，再点章节直接进入图片墙。'}</p>
                    </div>
                    <div class="rh-kinds" role="tablist" aria-label="阅读类型">
                        <button role="tab" class="${novel ? '' : 'on'}" data-rh-kind="manga">漫画</button>
                        <button role="tab" class="${novel ? 'on' : ''}" data-rh-kind="novel">小说</button>
                    </div>
                </header>
                <div class="rh-toolbar">
                    <div class="rh-sources" id="rdrAdapters"><span class="rh-src-loading">正在读取阅读源…</span></div>
                    <div class="rh-tools">
                        <label class="rh-search">
                            <span aria-hidden="true">⌕</span>
                            <input id="rhFilter" type="search" placeholder="搜索书名、作者或最新章节" autocomplete="off">
                        </label>
                        <select id="rhSort" aria-label="排序">
                            <option value="default">推荐顺序</option>
                            <option value="name">书名 A→Z</option>
                            <option value="latest">按最新章节</option>
                        </select>
                        <button class="rh-cross-toggle" id="rhCrossToggle" title="跨源搜索">🌐 跨源</button>
                    </div>
                </div>
                <div class="rh-cross" id="rhCross" hidden>
                    <div class="rh-cross-bar">
                        <input id="rhCrossQ" type="search" placeholder="跨源搜索漫画名，如：海贼王" autocomplete="off">
                        <button class="rh-primary" id="rhCrossGo">搜索</button>
                        <button class="rh-secondary" id="rhCrossClose">收起</button>
                    </div>
                    <div class="rh-cross-groups" id="rhCrossGroups"></div>
                </div>
                <div class="rh-continue" id="rhContinue" hidden></div>
                <div class="rh-wall-wrap" id="rhWallWrap">
                    <div class="rh-wall-head"><span id="rhSummary">正在读取目录…</span><button class="rh-refresh" id="rhRefresh" title="重新读取目录">↻ 刷新</button></div>
                    <div class="rh-wall" id="rhGrid"></div>
                </div>
                <div class="rh-detail" id="rhDetail" hidden></div>
            </div>
            <div class="rdr-reader" id="rdrReader" aria-hidden="true"></div>`;
        const kinds = body.querySelectorAll('[data-rh-kind]');
        kinds.forEach((b) => b.addEventListener('click', () => {
            if (readKind === b.dataset.rhKind) return;
            readKind = b.dataset.rhKind;
            readAdapter = readKind === 'novel' ? 'esjzone' : 'dm5';
            readItem = null;
            renderRead(body);
        }));
        body.querySelector('#rhRefresh').addEventListener('click', () => loadReadCatalog(readAdapter, true));
        const crossToggle = body.querySelector('#rhCrossToggle');
        if (crossToggle) crossToggle.addEventListener('click', () => openCrossPanel('', false));
        const crossClose = body.querySelector('#rhCrossClose');
        if (crossClose) crossClose.addEventListener('click', () => { body.querySelector('#rhCross').hidden = true; });
        const crossGo = body.querySelector('#rhCrossGo');
        if (crossGo) crossGo.addEventListener('click', () => crossSearch(body.querySelector('#rhCrossQ').value));
        const crossQ = body.querySelector('#rhCrossQ');
        if (crossQ) crossQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') crossSearch(crossQ.value); });
        let list = [];
        try { list = await api('/api/media-source/reading/adapters'); } catch (e) {
            body.querySelector('#rdrAdapters').innerHTML = `<span class="rh-src-error">阅读源读取失败：${esc(e.message)}</span>`;
            return;
        }
        list = list.filter((a) => a.kind === readKind);
        if (!list.length) {
            body.querySelector('#rdrAdapters').innerHTML = `<span class="rh-src-error">没有可用的${readKindLabel()}源</span>`;
            body.querySelector('#rhGrid').innerHTML = '';
            return;
        }
        if (!list.some((a) => a.id === readAdapter)) readAdapter = list[0].id;
        const box = body.querySelector('#rdrAdapters');
        box.innerHTML = list.map((a) => `
            <button class="rh-src${a.id === readAdapter ? ' on' : ''}" data-rdr-src="${esc(a.id)}" role="tab">
                <b>${esc(a.name)}</b><i>${a.kind === 'manga' ? '漫画 · 章节图' : '小说 · 正文'}</i>
            </button>`).join('');
        box.querySelectorAll('[data-rdr-src]').forEach((el) => el.addEventListener('click', () => {
            box.querySelectorAll('[data-rdr-src]').forEach((x) => x.classList.remove('on'));
            el.classList.add('on');
            readAdapter = el.dataset.rdrSrc;
            readItem = null;
            loadReadCatalog(readAdapter);
        }));
        const filter = body.querySelector('#rhFilter');
        filter.value = readQuery;
        filter.addEventListener('input', () => { readQuery = filter.value.trim(); paintReadGrid(); });
        const sort = body.querySelector('#rhSort');
        sort.value = readSortMode;
        sort.addEventListener('change', () => { readSortMode = sort.value; paintReadGrid(); });
        loadReadCatalog(readAdapter);
    }

    // 第四批：跨源搜索面板。switchMode=true 时选候选走「换源续读」，否则普通进详情。
    function openCrossPanel(q, switchMode) {
        const panel = document.getElementById('rhCross');
        if (!panel) return;
        readSwitchMode = !!switchMode;
        panel.hidden = false;
        const input = panel.querySelector('#rhCrossQ');
        if (input) { input.value = q || ''; input.focus(); }
        const groups = panel.querySelector('#rhCrossGroups');
        if (groups) groups.innerHTML = '<div class="rh-cross-hint">' + (readSwitchMode ? '搜索其它源里的同一部作品，选后接着读' : '输入书名，跨多个漫画源搜索') + '</div>';
        if (q) crossSearch(q);
    }

    async function crossSearch(q) {
        const query = String(q || '').trim();
        if (!query) return;
        const seq = ++readCrossSeq;
        const groupsBox = document.getElementById('rhCrossGroups');
        if (!groupsBox) return;
        groupsBox.innerHTML = '<div class="rh-cross-hint">正在跨源搜索…</div>';
        let d;
        try {
            d = await api('/api/media-source/reading/search?q=' + encodeURIComponent(query) + '&kind=' + readKind);
        } catch (e) {
            groupsBox.innerHTML = '<div class="rh-empty">跨源搜索失败：' + esc(e.message) + '</div>';
            return;
        }
        if (seq !== readCrossSeq) return; // 序列号不匹配：已有更新的搜索，丢弃本次结果
        const groups = (d.groups || []).map((g) => {
            const items = (g.items || []).map((it) => {
                const m = (window.TitleMatch && window.TitleMatch.score) ? window.TitleMatch.score(query, it.name) : null;
                return { ...it, _score: m ? m.score : 0, _reason: m ? m.reason : '' };
            }).sort((a, b) => b._score - a._score);
            const best = items.length ? items[0]._score : 0;
            return { ...g, items, _best: best };
        }).sort((a, b) => b._best - a._best);
        readCrossGroups = groups;
        const TM = window.TitleMatch || {};
        groupsBox.innerHTML = groups.length ? groups.map((g, gi) => {
            const head = '<div class="rh-cross-group-head"><b>' + esc(g.name) + '</b>'
                + (g.ok ? '<span>' + g.items.length + ' 条</span>' : '<span class="rh-cross-fail">搜索失败：' + esc(g.error || '') + '</span>') + '</div>';
            if (!g.ok || !g.items.length) return '<div class="rh-cross-group">' + head + '</div>';
            return '<div class="rh-cross-group">' + head + '<div class="rh-cross-cards">' + g.items.map((it, ii) => {
                const badge = it._score >= 80 ? '精确' : it._score >= 55 ? '相近' : '';
                return '<button class="rh-cross-card" data-g="' + gi + '" data-i="' + ii + '" title="' + esc(it._reason || '') + '">'
                    + '<span class="rh-cross-cover">' + (it.cover ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy">' : '') + '</span>'
                    + '<span class="rh-cross-name">' + esc(it.name) + '</span>'
                    + (badge ? '<i class="ms-item-badge">' + badge + ' ' + it._score + '%</i>' : '')
                    + (it.latest ? '<small>' + esc(it.latest) + '</small>' : '') + '</button>';
            }).join('') + '</div></div>';
        }).join('') : '<div class="rh-empty">没有可用的漫画搜索源</div>';
        groupsBox.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
            const g = readCrossGroups[Number(b.dataset.g)];
            const it = g && g.items[Number(b.dataset.i)];
            if (g && it) switchReadSource(g, it);
        }));
    }

    function switchReadSource(group, item, opts) {
        readAdapter = group.adapter;
        readAdapterName = group.name || readAdapter;
        readItem = item;
        // 同步源选择器的高亮
        document.querySelectorAll('[data-rdr-src]').forEach((el) => {
            el.classList.toggle('on', el.dataset.rdrSrc === readAdapter);
        });
        const panel = document.getElementById('rhCross');
        if (panel) panel.hidden = true;
        // 换源续读模式：带上原章节名与滚动比例，落到同章同比例
        let finalOpts = opts;
        if (readSwitchMode && window.__readResume) {
            finalOpts = Object.assign({}, opts || {}, {
                resumeName: window.__readResume.name,
                seedScroll: window.__readResume.ratio,
                autoOpen: true
            });
        }
        readSwitchMode = false;
        openReadChapters(item, finalOpts);
    }

    async function loadReadCatalog(id, force) {
        readWallAdapter = id;
        const grid = document.getElementById('rhGrid');
        if (!grid) return;
        const summary = document.getElementById('rhSummary');
        const detail = document.getElementById('rhDetail');
        if (detail) { detail.hidden = true; detail.innerHTML = ''; }
        const cont = document.getElementById('rhContinue');
        if (cont) { cont.hidden = true; cont.innerHTML = ''; }
        readItems = [];
        if (summary) summary.textContent = '正在读取目录…';
        grid.innerHTML = Array.from({ length: 12 }, () => '<div class="rh-skel"><span></span><b></b><i></i></div>').join('');
        const slow = id === 'esjzone' ? '读取目录中 · ESJ 首次约 20 秒，之后走缓存' : '读取目录中…';
        const stopTimer = loadingWithTimer(grid, slow);
        let d;
        try {
            d = await api('/api/media-source/reading/catalog?adapter=' + encodeURIComponent(id) + (force ? '&force=1' : ''));
        } catch (e) {
            stopTimer();
            grid.innerHTML = `<div class="rh-empty">目录读取失败：${esc(e.message)}<button class="rh-retry" data-retry="1">重试</button></div>`;
            const retry = grid.querySelector('[data-retry]');
            if (retry) retry.addEventListener('click', () => loadReadCatalog(id));
            if (summary) summary.textContent = '';
            return;
        }
        stopTimer();
        readAdapterName = (d && d.name) || id;
        readItems = (d && d.items) || [];
        if (!readItems.length) {
            grid.innerHTML = '<div class="rh-empty">这个源暂时没取到目录<button class="rh-retry" data-retry="1">重新读取</button></div>';
            const retry = grid.querySelector('[data-retry]');
            if (retry) retry.addEventListener('click', () => loadReadCatalog(id));
            if (summary) summary.textContent = '';
            return;
        }
        paintReadGrid();
        renderReadContinue();
    }

    function paintReadGrid() {
        const grid = document.getElementById('rhGrid');
        const summary = document.getElementById('rhSummary');
        if (!grid) return;
        const q = readQuery.toLowerCase();
        const rows = readItems.map((it, i) => ({ it, i })).filter(({ it }) => {
            if (!q) return true;
            return (it.name || '').toLowerCase().includes(q)
                || (it.latest || '').toLowerCase().includes(q)
                || (it.author || '').toLowerCase().includes(q);
        });
        if (readSortMode === 'name') rows.sort((a, b) => String(a.it.name).localeCompare(String(b.it.name), 'zh-Hans-CN'));
        else if (readSortMode === 'latest') rows.sort((a, b) => String(b.it.latest || '').localeCompare(String(a.it.latest || ''), 'zh-Hans-CN'));
        if (summary) {
            summary.textContent = q
                ? `${readAdapterName} · 命中 ${rows.length} / ${readItems.length} 部`
                : `${readAdapterName} · ${readItems.length} 部 · 点封面进入详情`;
        }
        if (!rows.length) {
            grid.innerHTML = `<div class="rh-empty">没有匹配「${esc(readQuery)}」的作品</div>`;
            return;
        }
        grid.innerHTML = rows.map(({ it, i }, n) => {
            const latest = (it.latest || it.author || readKindLabel()).toString();
            return `
            <button class="rh-card" data-i="${i}" aria-label="${esc(it.name)}，查看章节">
                <span class="rh-poster">
                    <span class="rh-ph">
                        <em>${esc(readAdapterName)}</em>
                        <b>${esc(it.name)}</b>
                        <i>${readKindLabel()} · 原站目录</i>
                    </span>
                    ${it.cover ? `<img src="${esc(it.cover)}" loading="${n < 10 ? 'eager' : 'lazy'}" decoding="async" alt="" onload="this.parentNode.classList.add('ok')" onerror="this.parentNode.classList.add('bad')">` : ''}
                    <span class="rh-open">进入目录</span>
                </span>
                <span class="rh-card-title">${esc(it.name)}</span>
                <span class="rh-card-meta">${esc(latest)}</span>
            </button>`;
        }).join('');
        grid.querySelectorAll('.rh-card').forEach((el) => el.addEventListener('click', () => {
            openReadChapters(readItems[Number(el.dataset.i)]);
        }));
    }

    function renderReadContinue() {
        const box = document.getElementById('rhContinue');
        if (!box) return;
        const last = readLast();
        if (!last || last.adapter !== readAdapter) { box.hidden = true; return; }
        const item = readItems.find((it) => it.url === last.url);
        if (!item) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = `
            <button class="rh-cont-card" data-cont-url="${esc(item.url)}">
                <span class="rh-cont-cover">
                    <span class="rh-ph"><b>${esc(item.name)}</b></span>
                    ${item.cover ? `<img src="${esc(item.cover)}" alt="" onload="this.parentNode.classList.add('ok')" onerror="this.parentNode.classList.add('bad')">` : ''}
                </span>
                <span class="rh-cont-body">
                    <em>继续上次阅读 · ${esc(readAdapterName)}</em>
                    <b>${esc(last.name || item.name)}</b>
                    <i>第 ${Number(last.index || 0) + 1} 章 · 回到上次停下的位置</i>
                </span>
                <span class="rh-cont-go">继续阅读 ›</span>
            </button>`;
        box.querySelector('[data-cont-url]').addEventListener('click', () => {
            openReadChapters(item, { resume: last.index });
        });
    }

    function closeReadDetail() {
        const detail = document.getElementById('rhDetail');
        const wrap = document.getElementById('rhWallWrap');
        if (detail) { detail.hidden = true; detail.innerHTML = ''; }
        if (wrap) wrap.hidden = false;
        readItem = null;
        renderReadContinue();
        // 换源后书墙还停在旧源目录，回到书墙时用当前源重载（坑位 9：不要在详情里调 loadReadCatalog）
        if (readWallAdapter && readWallAdapter !== readAdapter) loadReadCatalog(readAdapter);
    }

    async function openReadChapters(item, opts) {
        const detail = document.getElementById('rhDetail');
        const wrap = document.getElementById('rhWallWrap');
        if (!detail || !wrap) return;
        readItem = item;
        wrap.hidden = true;
        detail.hidden = false;
        detail.innerHTML = '<div class="rh-detail-loading"><div class="ms-loading">正在读取章节…</div></div>';
        const stopTimer = loadingWithTimer(detail.querySelector('.rh-detail-loading'), '正在读取章节…');
        let d;
        try {
            d = await api('/api/media-source/reading/chapters?adapter=' + encodeURIComponent(readAdapter)
                + '&url=' + encodeURIComponent(item.url));
        } catch (e) {
            stopTimer();
            detail.innerHTML = `<div class="rh-empty">章节读取失败：${esc(e.message)}<button class="rh-retry" data-back="1">返回书墙</button></div>`;
            detail.querySelector('[data-back]').addEventListener('click', closeReadDetail);
            return;
        }
        stopTimer();
        const chs = d.chapters || [];
        readChapters = chs;
        const last = readLast();
        let resumeIdx = last && last.adapter === readAdapter && last.url === item.url && last.index < chs.length
            ? last.index : -1;
        if (opts && Number.isInteger(opts.resume) && opts.resume >= 0 && opts.resume < chs.length) resumeIdx = opts.resume;
        // 第四批：换源续读——按章节名在新源里找同一章
        if (opts && opts.resumeName) {
            const TM = window.TitleMatch || {};
            const picked = TM.pickChapter ? TM.pickChapter(chs, opts.resumeName) : -1;
            if (picked >= 0) resumeIdx = picked;
        }
        // seedScroll：把续读比例写进新源新章的滚动 key，readScrollFor 才能命中
        if (opts && typeof opts.seedScroll === 'number' && resumeIdx >= 0) {
            try {
                const map = readScrollMap();
                const key = readAdapter + '|' + item.url + '|' + resumeIdx;
                map[key] = { r: Math.max(0, Math.min(1, opts.seedScroll)), at: Date.now() };
                localStorage.setItem(LS_READ_SCROLL, JSON.stringify(map));
            } catch (e) { /* 存不进去不影响阅读 */ }
        }
        const cover = d.cover || item.cover || '';
        const title = d.title || item.name;
        detail.innerHTML = `
            <div class="rh-detail-bar">
                <button class="rh-back" data-back="1">‹ 返回书墙</button>
                <span>${esc(readAdapterName)} · ${readKindLabel()}</span>
                <a class="rh-origin" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">原站打开 ↗</a>
            </div>
            <section class="rh-detail-hero">
                <span class="rh-detail-cover">
                    <span class="rh-ph"><em>${esc(readAdapterName)}</em><b>${esc(title)}</b><i>${readKindLabel()}</i></span>
                    ${cover ? `<img src="${esc(cover)}" alt="" onload="this.parentNode.classList.add('ok')" onerror="this.parentNode.classList.add('bad')">` : ''}
                </span>
                <div class="rh-detail-meta">
                    <p class="rh-kicker">${esc(readAdapterName)} · 源站目录</p>
                    <h2>${esc(title)}</h2>
                    <p class="rh-detail-sub">共 ${chs.length} 章 · ${readKind === 'novel' ? '正文在应用内阅读' : '整章图片在应用内阅读'}</p>
                    <div class="rh-detail-acts">
                        ${chs.length ? `<button class="rh-primary" data-start="1">▶ 从第一章开始</button>` : ''}
                        ${resumeIdx >= 0 ? `<button class="rh-secondary" data-resume="${resumeIdx}">继续第 ${resumeIdx + 1} 章</button>` : ''}
                        <button class="rh-secondary" data-switch-src="1">换源续读</button>
                    </div>
                    ${resumeIdx >= 0 ? `<p class="rh-resume-hint">上次读到：${esc(chs[resumeIdx].name)}</p>` : ''}
                </div>
            </section>
            <section class="rh-chapter-panel">
                <div class="rh-chapter-head">
                    <b>目录</b>
                    <input id="rdrFilter" type="search" placeholder="输入章节号或关键词筛选" autocomplete="off">
                    <span id="rhChapterCount"></span>
                </div>
                <div class="rh-chapters" id="rdrChapters"></div>
            </section>`;
        detail.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', closeReadDetail));
        const listBox = detail.querySelector('#rdrChapters');
        const count = detail.querySelector('#rhChapterCount');
        const CHUNK = 160;
        const paint = (q, limit) => {
            const matched = [];
            chs.forEach((c, i) => { if (!q || c.name.toLowerCase().includes(q)) matched.push(i); });
            const shown = matched.slice(0, limit);
            if (count) count.textContent = `${matched.length} 章`;
            listBox.innerHTML = shown.length
                ? shown.map((i) => {
                    const on = i === resumeIdx ? ' on' : '';
                    return `<button class="rh-ch${on}" data-ch="${i}"><span>${esc(chs[i].name)}</span>${i === resumeIdx ? '<i>上次</i>' : ''}</button>`;
                }).join('')
                  + (matched.length > limit ? `<button class="rh-ch rh-more" data-more="1">显示更多（还有 ${matched.length - limit} 章）</button>` : '')
                : '<div class="rh-empty">没有匹配的章节</div>';
            listBox.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => {
                openReader(Number(b.dataset.ch));
            }));
            const more = listBox.querySelector('[data-more]');
            if (more) more.addEventListener('click', () => paint(q, limit + CHUNK));
        };
        paint('', CHUNK);
        const resume = detail.querySelector('[data-resume]');
        if (resume) resume.addEventListener('click', () => openReader(Number(resume.dataset.resume)));
        const start = detail.querySelector('[data-start]');
        if (start) start.addEventListener('click', () => openReader(0));
        const filter = detail.querySelector('#rdrFilter');
        filter.addEventListener('input', () => paint(filter.value.trim().toLowerCase(), CHUNK));
        // 第四批：换源续读——用作品名跨源搜索，选源后带 resumeName/seedScroll/autoOpen
        const switchBtn = detail.querySelector('[data-switch-src]');
        if (switchBtn) switchBtn.addEventListener('click', () => {
            const workName = (d.title || item.name || '').trim();
            let name = '', ratio = 0;
            const readerBox = document.getElementById('rdrReader');
            if (readerBox && readerBox.classList.contains('on') && readChapters[readIndex]) {
                name = readChapters[readIndex].name;
                const b = readerBox.querySelector('#rdrBody');
                ratio = b && b.scrollHeight > b.clientHeight ? b.scrollTop / (b.scrollHeight - b.clientHeight) : 0;
            } else if (resumeIdx >= 0 && readChapters[resumeIdx]) {
                name = readChapters[resumeIdx].name;
                ratio = readScrollFor(resumeIdx);
            }
            window.__readResume = { name, ratio };
            openCrossPanel(workName, true);
        });
        // 从「继续上次」条进入时直接落位到上次章节
        if (opts && Number.isInteger(opts.resume) && opts.resume >= 0) openReader(opts.resume);
        else if (opts && opts.autoOpen && resumeIdx >= 0) openReader(resumeIdx);
        else detail.scrollIntoView({ block: 'start' });
    }

    async function openReader(index) {
        const ch = readChapters[index];
        const box = document.getElementById('rdrReader');
        if (!ch || !box) return;
        const seq = ++readOpenSeq;
        if (stopReadRestore) stopReadRestore();
        if (box.classList.contains('on')) {
            if (stopReadRestore) stopReadRestore();
            saveReadLast(readIndex);
        }
        readIndex = index;
        box.classList.add('on');
        box.setAttribute('aria-hidden', 'false');
        box.innerHTML = `
            <div class="rh-reader-bar">
                <div class="rh-reader-left">
                    <button class="rh-rbtn" id="rdrToc" title="返回目录">目录</button>
                    <span class="rh-reader-title">${esc(ch.name)}</span>
                </div>
                <span class="rh-reader-count">${index + 1} / ${readChapters.length}</span>
                <div class="rh-reader-right">
                    <button class="rh-rbtn" id="rdrSwitchSrc" title="换源续读">🌐 换源</button>
                    <button class="rh-rbtn" id="rdrPrev" ${index === 0 ? 'disabled' : ''}>‹ 上一章</button>
                    <button class="rh-rbtn" id="rdrNext" ${index === readChapters.length - 1 ? 'disabled' : ''}>下一章 ›</button>
                    <button class="rh-rbtn rh-rclose" id="rdrClose" title="关闭阅读器">关闭</button>
                </div>
            </div>
            <div class="rh-reader-progress"><i id="rdrProgress"></i></div>
            <div class="rdr-body" id="rdrBody"><div class="ms-loading">正在读取章节…</div></div>`;
        const stopTimer = loadingWithTimer(box.querySelector('#rdrBody'), '正在读取章节…');
        box.querySelector('#rdrClose').addEventListener('click', closeReader);
        box.querySelector('#rdrToc').addEventListener('click', () => { closeReader(); });
        const rdrSwitch = box.querySelector('#rdrSwitchSrc');
        if (rdrSwitch) rdrSwitch.addEventListener('click', () => {
            // 阅读器里换源：记住当前章名和比例，Esc 退出阅读器后打开跨源面板
            const b = box.querySelector('#rdrBody');
            const ratio = b && b.scrollHeight > b.clientHeight ? b.scrollTop / (b.scrollHeight - b.clientHeight) : 0;
            window.__readResume = { name: ch.name, ratio };
            const workName = (readItem && readItem.name) || '';
            closeReader();
            openCrossPanel(workName, true);
        });
        box.querySelector('#rdrPrev').addEventListener('click', () => { if (readIndex > 0) openReader(readIndex - 1); });
        box.querySelector('#rdrNext').addEventListener('click', () => { if (readIndex < readChapters.length - 1) openReader(readIndex + 1); });
        document.addEventListener('keydown', readerKeys);

        let d;
        try {
            d = await getReadChapter(readAdapter, ch.url);
        } catch (e) {
            stopTimer();
            if (seq !== readOpenSeq) return;
            box.querySelector('#rdrBody').innerHTML = `<div class="rh-empty">章节读取失败：${esc(e.message)}<button class="rh-retry" id="rdrRetry">重试</button></div>`;
            const retry = box.querySelector('#rdrRetry');
            if (retry) retry.addEventListener('click', () => openReader(index));
            return;
        }
        stopTimer();
        if (seq !== readOpenSeq || !box.classList.contains('on')) return;
        const body = box.querySelector('#rdrBody');
        if (d.kind === 'manga') {
            const pages = d.pages || [];
            body.innerHTML = pages.length
                ? `<div class="rdr-pages">${pages.map((p, i) => `<figure class="rdr-page"><img src="${esc(p)}" loading="${i < 3 ? 'eager' : 'lazy'}" decoding="async" alt="第 ${i + 1} 页"><figcaption>${i + 1} / ${pages.length}</figcaption></figure>`).join('')}</div>`
                : '<div class="rh-empty">这一章没取到图片</div>';
        } else {
            body.innerHTML = `<article class="rdr-text">${d.content || '<div class="rh-empty">这一章没有正文</div>'}</article>`;
        }
        const bar = box.querySelector('#rdrProgress');
        let lastScrollSave = 0;
        let restoringScroll = false;
        const onScroll = () => {
            if (restoringScroll) return;
            const max = body.scrollHeight - body.clientHeight;
            if (bar) bar.style.width = (max > 2 ? Math.min(100, body.scrollTop / max * 100) : 0) + '%';
            // 退出应用不会可靠触发 closeReader：每秒落一次，避免丢最后一段阅读位置。
            const now = Date.now();
            if (now - lastScrollSave >= 1000) {
                lastScrollSave = now;
                saveReadLast(index);
            }
        };
        body.addEventListener('scroll', onScroll, { passive: true });
        const stopRestore = restoreReadScroll(body, readScrollFor(index), () => {
            restoringScroll = true;
        }, () => {
            restoringScroll = false;
            onScroll();
        });
        stopReadRestore = stopRestore;
        onScroll();
        if (d.kind === 'manga') {
            body.querySelectorAll('.rdr-page img').forEach((img) => {
                img.addEventListener('error', () => {
                    const figure = img.closest('.rdr-page');
                    if (!figure || figure.querySelector('.rdr-image-error')) return;
                    img.style.display = 'none';
                    const error = document.createElement('div');
                    error.className = 'rdr-image-error';
                    error.innerHTML = `<span>第 ${Array.from(body.querySelectorAll('.rdr-page')).indexOf(figure) + 1} 页加载失败</span><button type="button" class="rh-retry">重试本页</button>`;
                    error.querySelector('button').addEventListener('click', () => {
                        const button = error.querySelector('button');
                        button.disabled = true;
                        button.textContent = '重试中…';
                        const retry = new Image();
                        retry.onload = () => {
                            img.src = retry.src;
                            img.style.display = '';
                            error.remove();
                        };
                        retry.onerror = () => {
                            button.disabled = false;
                            button.textContent = '仍失败，点击重试';
                        };
                        const original = img.getAttribute('src') || '';
                        const join = original.includes('?') ? '&' : '?';
                        retry.src = original + join + '__rdrRetry=' + Date.now();
                    });
                    figure.insertBefore(error, figure.querySelector('figcaption'));
                });
            });
        }
        const next = readChapters[index + 1];
        if (next) {
            getReadChapter(readAdapter, next.url).then((n) => {
                (n.pages || []).slice(0, 3).forEach((p) => { const im = new Image(); im.src = p; });
            }).catch(() => { /* 预取失败无所谓 */ });
        }
    }

    function closeReader() {
        readOpenSeq++;
        if (stopReadRestore) stopReadRestore();
        saveReadLast();
        const box = document.getElementById('rdrReader');
        if (box) { box.classList.remove('on'); box.setAttribute('aria-hidden', 'true'); box.innerHTML = ''; }
        document.removeEventListener('keydown', readerKeys);
    }

    function readerKeys(e) {
        if (!document.querySelector('.rdr-reader.on')) return;
        if (e.key === 'Escape') { closeReader(); return; }
        if (e.key === 'ArrowRight' && readIndex < readChapters.length - 1) openReader(readIndex + 1);
        if (e.key === 'ArrowLeft' && readIndex > 0) openReader(readIndex - 1);
    }

    // ==========================================================
    // 二级 tab 1：聚合搜索
    // ==========================================================
    function renderSearch(body) {
        body.innerHTML = `
            <div class="ms-searchbar">
                <input id="msQ" type="text" placeholder="输入番剧名，如：葬送的芙莉莲" autocomplete="off" value="${esc(query)}">
                <button class="btn btn-primary" id="msGo">🔍 搜索</button>
                <span class="ms-hint">多源并发 · 单源失效不阻塞</span>
            </div>
            <div class="ms-results" id="msResults"><div class="ms-empty">输入番剧名开始搜索（默认只用启用的源）</div></div>
            <div class="ms-eps" id="msEps"></div>`;
        const inp = body.querySelector('#msQ');
        body.querySelector('#msGo').addEventListener('click', () => doSearch(inp.value));
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(inp.value); });
        if (query) doSearch(query);
    }

    let searchToken = 0;
    async function doSearch(q, force = false) {
        q = String(q || '').trim();
        if (!q) return;
        const dis = disabledSet();
        const box = document.getElementById('msResults');
        if (!force && query === q && searchCache && searchCache.disabled === Array.from(dis).sort().join(',')) {
            renderSearchResults(searchCache.data, dis, box);
            return;
        }
        query = q;
        const my = ++searchToken;
        const eps = document.getElementById('msEps');
        if (eps) eps.innerHTML = '';
        box.innerHTML = '<div class="ms-loading">正在并发搜索全部启用源…</div>';

        // 禁用源直接不发给后端；换源复用同一次作品搜索的候选。
        let data;
        try {
            data = await searchEnabled(q);
        } catch (e) {
            box.innerHTML = `<div class="ms-empty">搜索失败：${esc(e.message)}</div>`;
            return;
        }
        if (my !== searchToken) return;
        renderSearchResults(data, dis, box);
    }

    function renderSearchResults(data, dis, box) {
        if (!box) return;
        const tm = window.TitleMatch;
        const groups = (Array.isArray(data) ? data : []).map((g) => {
            const items = (g.items || []).map((it) => Object.assign({}, it, {
                match: tm ? tm.score(query, it.name) : null
            }));
            if (tm) {
                items.sort((a, b) => (b.match.score - a.match.score)
                    || String(a.name).localeCompare(String(b.name), 'zh'));
            }
            return Object.assign({}, g, {
                items,
                bestScore: items.length && items[0].match ? items[0].match.score : 0
            });
        });
        groups.sort((a, b) => {
            if (!!a.ok !== !!b.ok) return a.ok ? -1 : 1;
            return (b.bestScore || 0) - (a.bestScore || 0)
                || ((a.tier == null ? 9 : a.tier) - (b.tier == null ? 9 : b.tier))
                || String(a.sourceName || '').localeCompare(String(b.sourceName || ''), 'zh');
        });
        const skipped = dis.size;
        const okCount = groups.filter((g) => g.ok && g.items.length).length;
        const all = flattenSearch(groups);
        const pk = tm && all.length ? tm.pick(query, all, { minScore: 70, strict: true }) : null;
        const best = pk && pk.best ? pk.best : null;
        const bestBar = best ? `
            <div class="ms-best">
                <span class="ms-best-tag">推荐</span>
                <span class="ms-best-src">${esc(best.sourceName)}</span>
                <span class="ms-best-name">${esc(best.name)}</span>
                <span class="ms-best-score">${best.match.score}% · ${esc(best.match.reason)}</span>
                ${pk.ambiguous ? '<span class="ms-best-warn">有多条同分线路</span>' : ''}
                <button class="btn btn-sm btn-primary" id="msBestBtn">选集</button>
            </div>` : '';
        box.innerHTML = `
            <div class="ms-summary">共 ${groups.length} 个源参与（${okCount} 个有结果${skipped ? ` · ${skipped} 个已禁用` : ''}）${tm ? '<span class="ms-sort-note">按标题匹配度排序</span>' : ''}</div>
            ${bestBar}
            ${groups.map((g) => `
                <div class="ms-group ${g.ok ? '' : 'is-bad'}">
                    <div class="ms-group-head">
                        <span class="ms-tier t${g.tier}">T${g.tier}</span>
                        <b>${esc(g.sourceName)}</b>
                        <span class="ms-host">${esc(g.host)}</span>
                        <span class="ms-group-st">${g.ok ? (g.items.length ? g.items.length + ' 条' : '无结果') : esc(g.error || '失败')}</span>
                    </div>
                    <div class="ms-items">
                        ${(g.items || []).map((it) => `
                            <div class="ms-item" data-src="${esc(g.sourceId)}" data-url="${esc(it.url)}" data-name="${esc(it.name)}">
                                <span class="ms-item-n">${esc(it.name)}</span>
                                ${matchBadge(it.match)}
                                <span class="ms-item-go">选集 ▸</span>
                            </div>`).join('')}
                    </div>
                </div>`).join('')}`;

        box.querySelectorAll('.ms-item').forEach((el) => el.addEventListener('click', () => {
            loadEpisodes(el.dataset.src, el.dataset.url, el.dataset.name);
        }));
        const bestBtn = box.querySelector('#msBestBtn');
        if (bestBtn && best) bestBtn.addEventListener('click', () => {
            loadEpisodes(best.sourceId, best.url, best.name);
        });
    }

    async function loadEpisodes(sourceId, url, name) {
        const eps = document.getElementById('msEps');
        if (!eps) return;
        eps.innerHTML = `<div class="ms-eps-head"><b>${esc(name)}</b><span class="ms-loading">正在读取剧集…</span></div>`;
        let d;
        try {
            d = await api(`/api/media-source/episodes?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(url)}`);
        } catch (e) {
            eps.innerHTML = `<div class="ms-empty">读取剧集失败：${esc(e.message)}</div>`;
            return;
        }
        if (!d.episodes || !d.episodes.length) {
            eps.innerHTML = `<div class="ms-eps-head"><b>${esc(name)}</b></div>
                <div class="ms-empty">没解析到剧集：${esc(d.error || '未知原因')}。<br>可以回「在线观看」用网页模式试这个站，或换一个源。</div>`;
            return;
        }
        eps.innerHTML = `
            <div class="ms-eps-head">
                <b>${esc(name)}</b>
                <span class="ms-host">${esc(d.sourceName)} · ${d.episodes.length} 集</span>
                <button class="btn btn-sm btn-secondary" id="msAltBtn" title="同一部作品换一条源线路，保留播放进度">🔁 换源</button>
                <button class="btn btn-sm btn-secondary" id="msEpClose">收起 ✕</button>
            </div>
            <div class="ms-ep-list">
                ${d.episodes.map((e, i) => `
                    <button class="ms-ep" data-url="${esc(e.url)}" data-src="${esc(sourceId)}"
                            data-ep="${esc(e.name)}" data-title="${esc(name)}">
                        <span class="ms-ep-n">${esc(e.name)}</span>
                        ${e.channel ? `<span class="ms-ep-ch">${esc(e.channel)}</span>` : ''}
                    </button>`).join('')}
            </div>`;
        eps.querySelector('#msEpClose').addEventListener('click', () => { eps.innerHTML = ''; });
        eps.querySelector('#msAltBtn').addEventListener('click', () => loadAltSources(name, url, sourceId));
        eps.querySelectorAll('.ms-ep').forEach((b, index) => b.addEventListener('click', () => {
            playEpisode(b.dataset.src, b.dataset.url, b.dataset.title, b.dataset.ep, {
                index,
                workUrl: url,
                sourceName: d.sourceName,
                episodes: d.episodes.map((e) => ({ name: e.name, url: e.url }))
            });
        }));
        eps.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    /* 同一部作品的多源线路。换源时保留当前集与播放位置，直接续接。 */
    async function loadAltSources(title, currentUrl, currentSourceId) {
        const eps = document.getElementById('msEps');
        if (!eps) return;
        const old = eps.querySelector('.ms-alt');
        if (old) { old.remove(); return; }
        const box = document.createElement('div');
        box.className = 'ms-alt';
        box.innerHTML = '<div class="ms-loading">正在按标题、季度与特别篇匹配其他线路…</div>';
        eps.appendChild(box);
        let data;
        try { data = await searchEnabled(title); }
        catch (e) { box.innerHTML = `<div class="ms-empty">换源搜索失败：${esc(e.message)}</div>`; return; }
        const tm = window.TitleMatch;
        let alts = [];
        let excluded = [];
        const currentKey = currentUrl ? lineKeyOf(currentSourceId, currentUrl) : '';
        if (tm) {
            const all = flattenSearch(data).filter((c) => !currentKey || lineKeyOf(c.sourceId, c.url) !== currentKey);
            const exclude = new Set(currentKey ? [currentKey] : []);
            alts = tm.rank(title, all, { minScore: 55, excludeKeys: exclude });
            excluded = all.map((c) => Object.assign({}, c, { match: tm.score(title, c.name) }))
                .filter((c) => c.match.level === 'season' || c.match.level === 'special' || c.match.score < 55)
                .sort((a, b) => b.match.score - a.match.score);
        } else {
            /* 老版本兼容：没有 TitleMatch 时退回标题包含，并排除当前线路。 */
            const key = String(title || '').toLowerCase().replace(/[\s　·:：\-—_\[\]()（）]/g, '');
            (data || []).forEach((g) => {
                (g.items || []).forEach((it) => {
                    if (currentKey && lineKeyOf(g.sourceId, it.url) === currentKey) return;
                    const k = String(it.name || '').toLowerCase().replace(/[\s　·:：\-—_\[\]()（）]/g, '');
                    if (k && (k.includes(key) || key.includes(k))) {
                        alts.push({ sourceId: g.sourceId, sourceName: g.sourceName, name: it.name, url: it.url, tier: g.tier });
                    }
                });
            });
        }
        const exNote = excluded.length
            ? `<div class="ms-alt-note" title="${esc(excluded.slice(0, 8).map((x) => `${x.name} · ${x.match.reason}`).join('\n'))}">已排除 ${excluded.length} 条其他季度、特别篇或低匹配候选</div>`
            : '';
        if (!alts.length) {
            box.innerHTML = `<div class="ms-empty">其他源没有足够接近的线路。${excluded.length ? '另有 ' + excluded.length + ' 条因季度/特别篇不匹配被排除。' : '可回到搜索结果换一个源。'}</div>${exNote}`;
            return;
        }
        box.innerHTML = `
            <div class="ms-alt-head">🔁 其他源（按匹配度排序，自动接回当前集与播放位置）</div>
            ${exNote}
            <div class="ms-alt-list">${alts.slice(0, 16).map((a, index) => {
                const m = a.match || null;
                const failed = failedLines.has(lineKeyOf(a.sourceId, a.url));
                const lv = m ? (m.level === 'exact' ? 'is-exact'
                    : m.level === 'same' ? 'is-same'
                        : m.level === 'season' ? 'is-season'
                            : m.level === 'special' ? 'is-special' : 'is-low') : '';
                return `
                <button class="ms-ep ms-alt-item ${failed ? 'is-failed' : ''}" data-alt-src="${esc(a.sourceId)}" data-alt-url="${esc(a.url)}" data-alt-name="${esc(a.name)}">
                    <span class="ms-alt-main">
                        <span class="ms-ep-n">${esc(a.sourceName)}</span>
                        <span class="ms-alt-title">${esc(a.name)}</span>
                    </span>
                    <span class="ms-alt-score ${lv}">
                        ${m ? `${m.score}% · ${esc(m.reason)}` : (index === 0 ? '最接近' : '同名')}
                        ${failed ? ' · 上次失败' : ''}
                    </span>
                </button>`;
            }).join('')}</div>`;
        box.querySelectorAll('.ms-alt-item').forEach((b) => b.addEventListener('click', () => {
            const v = document.getElementById('videoPlayer');
            const at = currentSession && v && v.currentTime > 2 ? v.currentTime : 0;
            // 用户手动重试曾经失败的线路时，解除本次运行的自动换源黑名单。
            failedLines.delete(lineKeyOf(b.dataset.altSrc, b.dataset.altUrl));
            switchSource(b.dataset.altSrc, b.dataset.altUrl, b.dataset.altName, at, { manual: true });
        }));
    }

    async function switchSource(sourceId, workUrl, title, resumeAt, opts = {}) {
        const token = ++playToken;
        const previous = currentSession;
        const previousEpisode = opts.episode || (previous && previous.episode);
        if (previous) savePlaybackProgress(resumeAt, document.getElementById('videoPlayer')?.duration || 0);
        try {
            const d = await api(`/api/media-source/episodes?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(workUrl)}`);
            if (token !== playToken) return;
            const episodes = (d.episodes || []).map((e) => ({ name: e.name, url: e.url }));
            if (!episodes.length) throw new Error('这个源没有解析到剧集');
            let index = previousEpisode
                ? episodes.findIndex((e) => e.name === previousEpisode) : -1;
            if (index < 0 && previousEpisode) {
                // 只按完整集号匹配；不能用 includes('1')，否则会把第 1 集接成第 11 集。
                const n = episodeNumber(previousEpisode);
                if (n != null) index = episodes.findIndex((e) => episodeNumber(e.name) === n);
            }
            if (index < 0) index = previous && Number.isInteger(previous.index) && previous.index < episodes.length ? previous.index : 0;
            notify('正在换源', `${title} · ${episodes[index].name}${resumeAt ? ' · 从 ' + Math.floor(resumeAt) + ' 秒继续' : ''}`);
            const played = await playEpisode(sourceId, episodes[index].url, title, episodes[index].name, {
                index, workUrl, sourceName: d.sourceName, episodes, startAt: resumeAt, autoFailover: false
            });
            if (!played && token === playToken) notify('换源失败', '新线路未能解析，请尝试其他源', 'error');
        } catch (e) {
            if (token === playToken) {
                failedLines.add(lineKeyOf(sourceId, workUrl));
                notify('换源失败', e.message + '，请尝试其他源', 'error');
            }
        }
    }
    function episodeNumber(name) {
        const m = String(name || '').match(/(?:第\s*)?(\d+(?:\.\d+)?)\s*(?:[集话話回期]|(?=[^\d.]|$))/);
        return m ? Number(m[1]) : null;
    }

    async function playEpisode(sourceId, url, title, epName, opts = {}) {
        const token = ++playToken;
        const old = history().find((x) => x.url === url && x.sourceId === sourceId);
        const episodes = Array.isArray(opts.episodes) ? opts.episodes : (old && old.episodes) || [];
        const index = Number.isInteger(opts.index) ? opts.index : Math.max(0, episodes.findIndex((e) => e.url === url));
        const workUrl = opts.workUrl || (currentSession && currentSession.workUrl) || (old && old.workUrl) || '';
        const startAt = Number.isFinite(opts.startAt) ? opts.startAt
            : old && !old.completed && Number(old.position) > 1 ? Number(old.position) : 0;
        notify('正在解析播放地址', `${title} · ${epName}${startAt ? ' · 将从 ' + formatPlaybackTime(startAt) + ' 继续' : ''}`);
        let d;
        try {
            d = await api(`/api/media-source/resolve?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(url)}`);
        } catch (e) {
            if (token === playToken) {
                if (workUrl) failedLines.add(lineKeyOf(sourceId, workUrl));
                notify('解析失败', e.message + '。可点「换源」保留当前集重试', 'error');
                if (opts.autoFailover !== false) void autoFailover(title, sourceId, workUrl, epName, startAt);
            }
            return false;
        }
        if (token !== playToken) return false;
        const full = `${title} · ${epName}`;
        const cleanTitle = typeof window.cleanMediaTitle === 'function' ? window.cleanMediaTitle(full) : full;
        currentSession = {
            title, episode: epName, sourceId, sourceName: d.sourceName || opts.sourceName || '',
            url, workUrl: opts.workUrl || (old && old.workUrl) || '', episodes, index, kind: d.kind
        };
        window.currentOnlinePlayback = currentSession;
        window.currentPlayerEpisode = 0;
        if (window.PlayerEnhance) window.PlayerEnhance.onPlay(d.streamUrl, full, cleanTitle);
        if (window.Danmaku) window.Danmaku.start(cleanTitle || full, document.getElementById('videoPlayer'));
        window.currentPlaylist = episodes.map((e) => ({ id: e.url, title: e.name }));
        window.currentPlaylistIndex = index;
        if (typeof window.updatePlayerQueueUI === 'function') window.updatePlayerQueueUI();
        if (typeof window.showVideoPlayer === 'function') {
            window.showVideoPlayer(d.streamUrl, full, d.kind, startAt);
            if (startAt) notify('继续播放', `已恢复到 ${formatPlaybackTime(startAt)}`, 'success');
        } else {
            window.open(d.streamUrl, '_blank');
        }
        savePlaybackProgress(startAt, old && old.duration || 0);
        return true;
    }

    /* 解析失败后的分阶段自动换源：标题结构化评分 → 排除失败线路 → 唯一高分才切换。 */
    async function autoFailover(title, sourceId, workUrl, epName, resumeAt) {
        const tm = window.TitleMatch;
        if (!tm || !title || failoverDepth >= 1) return;
        failoverDepth++;
        try {
            let data;
            try { data = await searchEnabled(title); }
            catch (e) { return; }
            const candidates = flattenSearch(data).filter((c) => c.sourceId !== sourceId);
            const exclude = new Set(workUrl ? [lineKeyOf(sourceId, workUrl)] : []);
            const pk = tm.pick(title, candidates, {
                strict: true, minScore: 74, excludeKeys: exclude, failedKeys: failedLines
            });
            if (!pk.best) {
                notify('自动换源', '其他源没有匹配到同一作品，请手动选择线路', 'error');
                return;
            }
            if (pk.ambiguous) {
                notify('自动换源', '有多条同分线路，已停止自动切换，请点「换源」选择', 'info');
                return;
            }
            notify('自动换源', `${pk.best.sourceName} · ${pk.best.name}（${pk.best.match.reason}）`);
            await switchSource(pk.best.sourceId, pk.best.url, title, resumeAt, {
                episode: epName, auto: true
            });
        } finally {
            failoverDepth--;
        }
    }

    function formatPlaybackTime(seconds) {
        const n = Math.max(0, Math.floor(Number(seconds) || 0));
        return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
    }

    async function playQueue(index) {
        const s = currentSession;
        if (!s || !s.episodes[index]) return false;
        return playEpisode(s.sourceId, s.episodes[index].url, s.title, s.episodes[index].name, {
            index, workUrl: s.workUrl, sourceName: s.sourceName, episodes: s.episodes
        });
    }

    function next(opts = {}) {
        const s = currentSession;
        if (!s || !s.episodes.length) { notify('播放提示', '当前没有在线分集队列'); return Promise.resolve(false); }
        const mode = opts.loopMode || 'sequence';
        if (mode === 'single') {
            const v = document.getElementById('videoPlayer');
            if (v) { v.currentTime = 0; v.play().catch(() => {}); }
            return Promise.resolve(true);
        }
        let index = s.index + 1;
        if (mode === 'random' && s.episodes.length > 1) index = Math.floor(Math.random() * s.episodes.length);
        else if (mode === 'loop') index %= s.episodes.length;
        if (index >= s.episodes.length || index < 0 || index === s.index) {
            notify('播放完成', '这部作品的在线分集已播放完毕');
            return Promise.resolve(false);
        }
        return playQueue(index);
    }

    function prev() {
        const s = currentSession;
        if (!s || s.index <= 0) { notify('播放提示', '已经是第一集'); return Promise.resolve(false); }
        return playQueue(s.index - 1);
    }

    // ==========================================================
    // 二级 tab 2：BT 资源
    // ==========================================================
    function renderBt(body) {
        body.innerHTML = `
            <div class="ms-searchbar">
                <input id="msBtQ" type="text" placeholder="搜 BT 资源，如：葬送的芙莉莲 1080" autocomplete="off">
                <button class="btn btn-primary" id="msBtGo">🧲 搜索</button>
                <span class="ms-hint">只出磁力，不内置 BT 下载引擎</span>
            </div>
            <div class="ms-results" id="msBtResults"><div class="ms-empty">BT 源：AnimeGarden / nyaa.land</div></div>`;
        const inp = body.querySelector('#msBtQ');
        const go = body.querySelector('#msBtGo');
        const run = () => doBtSearch(inp.value);
        go.addEventListener('click', run);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    }

    async function doBtSearch(q) {
        q = String(q || '').trim();
        if (!q) return;
        const box = document.getElementById('msBtResults');
        box.innerHTML = '<div class="ms-loading">搜索中…</div>';
        let data;
        try {
            data = await api('/api/media-source/bt?q=' + encodeURIComponent(q));
        } catch (e) {
            box.innerHTML = `<div class="ms-empty">搜索失败：${esc(e.message)}</div>`;
            return;
        }
        const all = [];
        data.forEach((g) => (g.items || []).forEach((it) => all.push({ ...it, src: g.sourceName, err: g.error })));
        if (!all.length) {
            box.innerHTML = `<div class="ms-empty">没有结果${data.some((g) => g.error) ? '（部分源不可用：' + esc(data.find((g) => g.error).error) + '）' : ''}</div>`;
            return;
        }
        box.innerHTML = `<div class="ms-summary">${all.length} 条</div>` + all.map((it) => `
            <div class="ms-bt">
                <div class="ms-bt-t">${esc(it.name)}</div>
                <div class="ms-bt-m">${esc(it.src)}${it.size ? ' · ' + esc(it.size) : ''}${it.date ? ' · ' + esc(it.date) : ''}</div>
                <div class="ms-bt-acts">
                    ${it.magnet ? `<a class="btn btn-sm btn-primary" href="${esc(it.magnet)}">🧲 用本机BT客户端打开</a>
                    <button class="btn btn-sm btn-secondary" data-mag="${esc(it.magnet)}">📋 复制磁力</button>` : ''}
                </div>
            </div>`).join('');
        box.querySelectorAll('[data-mag]').forEach((b) => b.addEventListener('click', async () => {
            const m = b.dataset.mag;
            try {
                await navigator.clipboard.writeText(m);
                notify('已复制磁力', '粘贴到迅雷 / qBittorrent / 夸克离线下载即可', 'success');
            } catch (e) {
                // 剪贴板 API 在非 HTTPS 下常被拒 → 兜底选中提示
                const ta = document.createElement('textarea');
                ta.value = m; document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); notify('已复制磁力', '粘贴到下载器即可', 'success'); }
                catch (e2) { notify('复制失败', '请手动选中链接复制', 'error'); }
                ta.remove();
            }
        }));
    }

    // ==========================================================
    // 二级 tab 3：源管理
    // ==========================================================
    async function renderSources(body) {
        body.innerHTML = `
            <div class="ms-srcbar">
                <button class="btn btn-sm btn-primary" id="msRefresh">🔄 刷新订阅</button>
                <button class="btn btn-sm btn-secondary" id="msProbe">📡 重新探测</button>
                <span class="ms-hint">站点改版后先刷新订阅：拉的是 animeko 官方源定义仓库，不用等应用发版</span>
            </div>
            <div class="ms-results" id="msSrcList"><div class="ms-loading">加载中…</div></div>`;
        body.querySelector('#msRefresh').addEventListener('click', async (e) => {
            e.target.disabled = true; e.target.textContent = '刷新中…';
            try {
                const r = await fetch('/api/media-source/refresh', { method: 'POST' });
                const j = await r.json();
                notify(j.code === 0 ? '订阅已刷新' : '刷新失败', j.msg || '', j.code === 0 ? 'success' : 'error');
            } catch (err) { notify('刷新失败', err.message, 'error'); }
            e.target.disabled = false; e.target.textContent = '🔄 刷新订阅';
            renderSources(body);
        });
        body.querySelector('#msProbe').addEventListener('click', () => { statusCache = {}; renderSources(body, true); });
        await renderSourcesList(body, false);
    }

    async function renderSourcesList(body, force) {
        const box = document.getElementById('msSrcList');
        if (!box) return;
        box.innerHTML = '<div class="ms-loading">加载中…</div>';
        let list;
        try {
            list = await api('/api/media-source/sources?status=1' + (force ? '&force=1' : ''));
        } catch (e) {
            box.innerHTML = `<div class="ms-empty">加载失败：${esc(e.message)}</div>`;
            return;
        }
        list.forEach((s) => { if (s.status) statusCache[s.id] = s.status; });
        const dis = disabledSet();
        const web = list.filter((s) => s.kind === 'web');
        const bt = list.filter((s) => s.kind === 'bt');

        const rowHtml = (s) => {
            const st = statusCache[s.id];
            const dot = !st ? '<span class="ms-dot grey" title="未探测"></span>'
                : st.ok ? `<span class="ms-dot green" title="可达 ${st.ms}ms"></span>`
                    : `<span class="ms-dot red" title="${esc(st.error || '不可达')}"></span>`;
            const stTxt = !st ? '未探测' : st.ok ? `可达 ${st.ms}ms` : '不可达';
            return `
            <div class="ms-src ${dis.has(s.id) ? 'is-off' : ''}">
                <label class="ms-src-on"><input type="checkbox" data-id="${esc(s.id)}" ${dis.has(s.id) ? '' : 'checked'}></label>
                <span class="ms-tier t${s.tier}">${s.kind === 'bt' ? 'BT' : 'T' + s.tier}</span>
                <b>${esc(s.name)}</b>
                <span class="ms-host">${esc(s.host)}</span>
                ${dot}<span class="ms-src-st">${esc(stTxt)}</span>
                ${s.origin === 'override' ? '<span class="ms-badge">订阅</span>' : ''}
            </div>`;
        };

        box.innerHTML = `
            <div class="ms-summary">网页解析源 ${web.length} 个 · BT 源 ${bt.length} 个 · 取消勾选即在搜索中跳过</div>
            <div class="ms-h3">🌐 网页解析源（T0 质量最高）</div>
            ${web.map(rowHtml).join('')}
            <div class="ms-h3">🧲 BT 源</div>
            ${bt.map(rowHtml).join('')}`;

        box.querySelectorAll('input[data-id]').forEach((cb) => cb.addEventListener('change', () => {
            const set = disabledSet();
            if (cb.checked) set.delete(cb.dataset.id); else set.add(cb.dataset.id);
            saveDisabled(set);
            searchCache = null;
            cb.closest('.ms-src').classList.toggle('is-off', !cb.checked);
        }));
    }

    // ==========================================================
    // 二级 tab 4：观看历史
    // ==========================================================
    function historySyncLabel() {
        return historySyncState === 'offline' ? '服务器不可用，显示本地记录'
            : historySyncState === 'server' ? '已与服务器同步' : '正在同步…';
    }
    function updateHistorySyncHint() {
        const nodes = document.querySelectorAll ? document.querySelectorAll('.ms-hist-sync') : [];
        for (const node of nodes) node.textContent = historySyncLabel();
    }
    function renderHistory(body, pulled = false) {
        const seq = ++historyRenderSeq;
        const list = history();
        const syncText = historySyncLabel();
        if (!list.length) {
            body.innerHTML = `<div class="ms-results"><div class="ms-empty">还没有在线解析播放记录<br><span class="ms-hist-sync">${esc(syncText)}</span></div></div>`;
            if (!pulled) {
                void pullHistory().then((changed) => {
                    if (changed && seq === historyRenderSeq && curTab === 'history') renderHistory(body, true);
                    else updateHistorySyncHint();
                });
            }
            return;
        }
        const ago = (t) => {
            const d = Date.now() - t;
            if (d < 60000) return '刚刚';
            if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
            if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
            return Math.floor(d / 86400000) + ' 天前';
        };
        body.innerHTML = `
            <div class="ms-srcbar"><button class="btn btn-sm btn-secondary" id="msHistClear">🗑 清空记录</button>
            <span class="ms-hint">只记「解析播放」，本地影片的进度在播放器里单独记</span>
            <span class="ms-hint ms-hist-sync">${esc(syncText)}</span></div>
            <div class="ms-results">
                ${list.map((it, i) => `
                    <div class="ms-hist" data-i="${i}">
                        <div class="ms-hist-main">
                            <b>${esc(it.title)}</b>
                            <span class="ms-ep-n">${esc(it.episode || '')}</span>
                        </div>
                        <div class="ms-hist-m">${esc(it.sourceName || it.sourceId)} · ${ago(it.at)}${it.position ? ' · 看到 ' + formatPlaybackTime(it.position) : it.completed ? ' · 已看完' : ''}</div>
                        <div class="ms-bt-acts">
                            <button class="btn btn-sm btn-primary" data-play="${i}">${it.position ? '▶ 从 ' + formatPlaybackTime(it.position) + ' 继续' : '▶ 播放'}</button>
                        </div>
                    </div>`).join('')}
            </div>`;
        body.querySelector('#msHistClear').addEventListener('click', async () => {
            writeHistory([]);
            savePendingHistory([]);
            localStorage.setItem(LS_HISTORY_READY, '1');
            try {
                const r = await fetch('/api/media-source/history', { method: 'DELETE' });
                const j = await r.json();
                if (j.code !== 0) throw new Error(j.msg || '清空失败');
                localStorage.removeItem(LS_HISTORY_CLEAR);
                historySyncState = 'server';
                notify('已清空历史', '本机与服务器记录已清空', 'success');
            } catch (e) {
                // 服务器暂时不可用时先清本机；下次进入历史页会自动补一次 DELETE。
                localStorage.setItem(LS_HISTORY_CLEAR, '1');
                historySyncState = 'offline';
                notify('已清空本机历史', '服务器同步失败，联网后会自动重试', 'error');
            }
            renderHistory(body, true);
        });
        body.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => {
            const it = list[Number(b.dataset.play)];
            if (!it) return false;
            return playEpisode(it.sourceId, it.url, it.title, it.episode, {
                index: Number.isInteger(it.index) ? it.index : 0,
                workUrl: it.workUrl,
                sourceName: it.sourceName,
                episodes: it.episodes
            });
        }));
        if (!pulled) {
            void pullHistory().then((changed) => {
                if (changed && seq === historyRenderSeq && curTab === 'history') renderHistory(body, true);
                else updateHistorySyncHint();
            });
        }
    }

    return { show, openWithQuery, switchTab, saveProgress: savePlaybackProgress, clearPlayback, playQueue, next, prev, tabs: TABS.map((t) => t.key) };
})();
