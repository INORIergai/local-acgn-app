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
    const LS_DISABLED = 'cv:msDisabled';
    const LS_HISTORY = 'cv:msHistory';

    let curTab = 'discover';
    let mounted = false;
    let query = '';
    let statusCache = {};   // 源 id -> 探测结果
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
        try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); }
        catch (e) { return []; }
    }
    function pushHistory(rec) {
        const list = history().filter((x) => !(x.url === rec.url && x.sourceId === rec.sourceId));
        list.unshift(rec);
        localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, 60)));
    }

    async function api(path) {
        const r = await fetch(path);
        const j = await r.json();
        if (j.code !== 0 && j.code != null) throw new Error(j.msg || '接口返回错误');
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
                        ${TABS.map((t) => `<button class="ms-tab" data-ms-tab="${t.key}">${t.name}</button>`).join('')}
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
    const LS_READ_LAST = 'cv:rdrLast';
    const LS_READ_SCROLL = 'cv:rdrScroll';
    const READ_SCROLL_MAX = 80;
    // 同一章来回翻时别再走一遍源站（ESJ 单章最慢 30s），最多留 24 章
    const readChapterCache = new Map();
    const readChapterPending = new Map();
    const READ_CACHE_MAX = 24;

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
    function restoreReadScroll(body, ratio) {
        if (!(ratio > 0)) return;
        const imgs = Array.from(body.querySelectorAll('img'));
        const start = Date.now();
        let canceled = false;
        const pump = () => {
            if (canceled) return;
            if (!body.isConnected) { clearInterval(timer); return; }
            const max = body.scrollHeight - body.clientHeight;
            if (max > 4) body.scrollTop = ratio * max;
            if (!imgs.some((i) => !i.complete) || Date.now() - start > 4000) clearInterval(timer);
        };
        const timer = setInterval(pump, 150);
        pump();
        const cancel = () => { canceled = true; clearInterval(timer); };
        body.addEventListener('wheel', cancel, { once: true, passive: true });
        body.addEventListener('touchstart', cancel, { once: true, passive: true });
        body.addEventListener('keydown', cancel, { once: true });
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
                    </div>
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

    async function loadReadCatalog(id, force) {
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
        // 从「继续上次」条进入时直接落位到上次章节
        if (opts && Number.isInteger(opts.resume) && opts.resume >= 0) openReader(opts.resume);
        else detail.scrollIntoView({ block: 'start' });
    }

    async function openReader(index) {
        const ch = readChapters[index];
        const box = document.getElementById('rdrReader');
        if (!ch || !box) return;
        const seq = ++readOpenSeq;
        if (box.classList.contains('on')) saveReadLast(readIndex);
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
        const onScroll = () => {
            const max = body.scrollHeight - body.clientHeight;
            if (bar) bar.style.width = (max > 2 ? Math.min(100, body.scrollTop / max * 100) : 0) + '%';
        };
        body.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        restoreReadScroll(body, readScrollFor(index));

        const next = readChapters[index + 1];
        if (next) {
            getReadChapter(readAdapter, next.url).then((n) => {
                (n.pages || []).slice(0, 3).forEach((p) => { const im = new Image(); im.src = p; });
            }).catch(() => { /* 预取失败无所谓 */ });
        }
    }

    function closeReader() {
        readOpenSeq++;
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
    async function doSearch(q) {
        q = String(q || '').trim();
        if (!q) return;
        query = q;
        const my = ++searchToken;
        const box = document.getElementById('msResults');
        const eps = document.getElementById('msEps');
        if (eps) eps.innerHTML = '';
        box.innerHTML = '<div class="ms-loading">正在并发搜索全部启用源…</div>';

        const dis = disabledSet();
        // 只把「禁用的」排除掉：不传 sources 参数即表示全部
        const srcs = Array.from(dis);
        let data;
        try {
            data = await api('/api/media-source/search?q=' + encodeURIComponent(q));
        } catch (e) {
            box.innerHTML = `<div class="ms-empty">搜索失败：${esc(e.message)}</div>`;
            return;
        }
        if (my !== searchToken) return;

        const groups = data.filter((g) => !dis.has(g.sourceId));
        const skipped = data.length - groups.length;
        const okCount = groups.filter((g) => g.ok && g.items.length).length;
        box.innerHTML = `
            <div class="ms-summary">共 ${groups.length} 个源参与（${okCount} 个有结果${skipped ? ` · ${skipped} 个已禁用` : ''}）</div>
            ${groups.map((g) => `
                <div class="ms-group ${g.ok ? '' : 'is-bad'}">
                    <div class="ms-group-head">
                        <span class="ms-tier t${g.tier}">T${g.tier}</span>
                        <b>${esc(g.sourceName)}</b>
                        <span class="ms-host">${esc(g.host)}</span>
                        <span class="ms-group-st">${g.ok ? (g.items.length ? g.items.length + ' 条' : '无结果') : esc(g.error || '失败')}</span>
                    </div>
                    <div class="ms-items">
                        ${(g.items || []).map((it, i) => `
                            <div class="ms-item" data-src="${esc(g.sourceId)}" data-url="${esc(it.url)}" data-name="${esc(it.name)}">
                                <span class="ms-item-n">${esc(it.name)}</span>
                                <span class="ms-item-go">选集 ▸</span>
                            </div>`).join('')}
                    </div>
                </div>`).join('')}`;

        box.querySelectorAll('.ms-item').forEach((el) => el.addEventListener('click', () => {
            loadEpisodes(el.dataset.src, el.dataset.url, el.dataset.name);
        }));
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
        eps.querySelector('#msAltBtn').addEventListener('click', () => loadAltSources(name));
        eps.querySelectorAll('.ms-ep').forEach((b) => b.addEventListener('click', () => {
            playEpisode(b.dataset.src, b.dataset.url, b.dataset.title, b.dataset.ep);
        }));
        eps.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    /* r153 · D：同一部作品的多源线路。换源时把当前播放时间带过去。 */
    async function loadAltSources(title) {
        const eps = document.getElementById('msEps');
        if (!eps) return;
        const old = eps.querySelector('.ms-alt');
        if (old) { old.remove(); return; }
        const box = document.createElement('div');
        box.className = 'ms-alt';
        box.innerHTML = '<div class="ms-loading">正在找同一部作品的其他源…</div>';
        eps.appendChild(box);
        let data;
        try { data = await api('/api/media-source/search?q=' + encodeURIComponent(title)); }
        catch (e) { box.innerHTML = `<div class="ms-empty">换源搜索失败：${esc(e.message)}</div>`; return; }
        const key = String(title || '').toLowerCase().replace(/[\s　·:：\-—_\[\]()（）]/g, '');
        const alts = [];
        (data || []).forEach((g) => {
            (g.items || []).forEach((it) => {
                const k = String(it.name || '').toLowerCase().replace(/[\s　·:：\-—_\[\]()（）]/g, '');
                if (!k) return;
                if (k.includes(key) || key.includes(k)) {
                    alts.push({ sourceId: g.sourceId, sourceName: g.sourceName, name: it.name, url: it.url });
                }
            });
        });
        if (!alts.length) { box.innerHTML = '<div class="ms-empty">其他源没找到同名作品。</div>'; return; }
        box.innerHTML = `
            <div class="ms-alt-head">🔁 其他源（切换后从当前播放位置继续）</div>
            <div class="ms-alt-list">${alts.map((a) => `
                <button class="ms-ep ms-alt-item" data-alt-src="${esc(a.sourceId)}" data-alt-url="${esc(a.url)}" data-alt-name="${esc(a.name)}">
                    <span class="ms-ep-n">${esc(a.sourceName)}</span>
                    <span class="ms-ep-ch">${esc(a.name)}</span>
                </button>`).join('')}</div>`;
        box.querySelectorAll('.ms-alt-item').forEach((b) => b.addEventListener('click', () => {
            const v = document.getElementById('videoPlayer');
            const at = v && v.currentTime > 2 ? v.currentTime : 0;
            loadEpisodes(b.dataset.altSrc, b.dataset.altUrl, b.dataset.altName);
            if (at) notify('已换源', `播放位置将从 ${Math.floor(at)} 秒继续（选一集后生效）`);
            window.__msResumeAt = at;
        }));
    }

    async function playEpisode(sourceId, url, title, epName) {
        // 提示要如实：多数站点的真地址藏在混淆过的播放器 JS 里，静态抓不到，
        // 引擎会开内置浏览器把页面跑起来再抓（十几秒量级）。不说清楚会被当成卡死。
        notify('正在解析播放地址', `${title} · ${epName}（必要时启用内置浏览器，约需十几秒）`);
        let d;
        try {
            d = await api(`/api/media-source/resolve?source=${encodeURIComponent(sourceId)}&url=${encodeURIComponent(url)}`);
        } catch (e) {
            notify('解析失败', e.message, 'error');
            return;
        }
        const full = `${title} · ${epName}`;
        if (typeof window.showVideoPlayer === 'function') {
            window.showVideoPlayer(d.streamUrl, full, d.kind, window.__msResumeAt || 0);
            window.__msResumeAt = 0;
        } else {
            window.open(d.streamUrl, '_blank');
        }
        pushHistory({ title, episode: epName, sourceId, sourceName: d.sourceName || '', url, kind: d.kind, at: Date.now() });
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
            cb.closest('.ms-src').classList.toggle('is-off', !cb.checked);
        }));
    }

    // ==========================================================
    // 二级 tab 4：观看历史
    // ==========================================================
    function renderHistory(body) {
        const list = history();
        if (!list.length) {
            body.innerHTML = `<div class="ms-results"><div class="ms-empty">还没有在线解析播放记录</div></div>`;
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
            <span class="ms-hint">只记「解析播放」，本地影片的进度在播放器里单独记</span></div>
            <div class="ms-results">
                ${list.map((it, i) => `
                    <div class="ms-hist" data-i="${i}">
                        <div class="ms-hist-main">
                            <b>${esc(it.title)}</b>
                            <span class="ms-ep-n">${esc(it.episode || '')}</span>
                        </div>
                        <div class="ms-hist-m">${esc(it.sourceName || it.sourceId)} · ${ago(it.at)}</div>
                        <div class="ms-bt-acts">
                            <button class="btn btn-sm btn-primary" data-play="${i}">▶ 继续播放</button>
                        </div>
                    </div>`).join('')}
            </div>`;
        body.querySelector('#msHistClear').addEventListener('click', () => {
            localStorage.removeItem(LS_HISTORY);
            renderHistory(body);
        });
        body.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => {
            const it = list[Number(b.dataset.play)];
            if (it) playEpisode(it.sourceId, it.url, it.title, it.episode);
        }));
    }

    return { show, openWithQuery, switchTab, tabs: TABS.map((t) => t.key) };
})();
