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
        { key: 'search', name: '🔍 聚合搜索' },
        { key: 'bt', name: '🧲 BT资源' },
        { key: 'sources', name: '🧩 源管理' },
        { key: 'history', name: '🕘 观看历史' }
    ];
    const LS_DISABLED = 'cv:msDisabled';
    const LS_HISTORY = 'cv:msHistory';

    let curTab = 'search';
    let mounted = false;
    let query = '';
    let statusCache = {};   // 源 id -> 探测结果

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
        if (key === 'search') renderSearch(body);
        else if (key === 'bt') renderBt(body);
        else if (key === 'sources') renderSources(body);
        else renderHistory(body);
    }

    /** 一级入口：由 switchView('ms') 调起 */
    function show(tab) {
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
        eps.querySelectorAll('.ms-ep').forEach((b) => b.addEventListener('click', () => {
            playEpisode(b.dataset.src, b.dataset.url, b.dataset.title, b.dataset.ep);
        }));
        eps.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
            window.showVideoPlayer(d.streamUrl, full, d.kind);
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
