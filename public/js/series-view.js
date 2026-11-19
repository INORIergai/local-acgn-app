// ================================================================
// series-view.js —— round173 追番页（阶段1）
//   挂 window.SeriesView，由 app.js 的 switchView('series') 驱动。
//   三栏看板（追番中/计划看/已完成）+ 本周新番一键加追 + 分集展开。
//
//   纪律（照 round168-tags.css）：
//   · 颜色只取语义令牌，纸(classic)/夜(matinee) 自动适配，不写死色值
//   · #seriesView 是独立视图容器，内部自己布局，不碰 movieGrid 的 grid
//   · 事件委托，不用内联 onclick（避免函数名不一致的历史坑）
// ================================================================
(function () {
    'use strict';

    const ROOT_ID = 'seriesView';
    let currentTab = 'watching';
    let boardCache = null;
    let calendarItems = null;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const api = async (url, opts) => {
        const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
        return r.json();
    };

    function root() { return document.getElementById(ROOT_ID); }

    // ---------- 数据加载 ----------
    async function loadBoard() {
        const r = await api('/api/series/follows');
        boardCache = (r && r.code === 0 && Array.isArray(r.data)) ? r.data : [];
        renderBoard();
    }

    async function loadCalendar(force) {
        const r = await api('/api/series/from-calendar' + (force ? '?force=1' : ''));
        calendarItems = (r && r.code === 0 && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
        renderCalendar();
    }

    // ---------- 渲染：本周新番条 ----------
    function renderCalendar() {
        const box = root() && root().querySelector('#svCalendar');
        if (!box) return;
        if (!calendarItems || !calendarItems.length) {
            box.innerHTML = '<div class="sv-empty-line">本周放送表暂无数据（数据源不可达时可稍后刷新）</div>';
            return;
        }
        box.innerHTML = calendarItems.slice(0, 40).map((it) => {
            const following = it.followStatus === 'watching';
            const label = it.episode != null ? '第' + it.episode + '集' : (it.date || '');
            const poster = it.cover
                ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
                : '<div class="sv-poster-ph"></div>';
            return '<div class="sv-cal-card" data-sid="' + it.seriesId + '">'
                + '<div class="sv-cal-poster">' + poster + '</div>'
                + '<div class="sv-cal-title" title="' + esc(it.title) + '">' + esc(it.title) + '</div>'
                + '<div class="sv-cal-meta">' + esc(label) + '</div>'
                + '<button class="sv-follow-btn' + (following ? ' following' : '') + '" data-act="follow" data-sid="' + it.seriesId + '" data-status="watching">'
                + (following ? '✓ 已追' : '+ 追番') + '</button>'
                + '</div>';
        }).join('');
    }

    // ---------- 渲染：追番看板 ----------
    function renderBoard() {
        const box = root() && root().querySelector('#svBoard');
        if (!box) return;
        const list = (boardCache || []).filter(b => !currentTab || b.followStatus === currentTab);
        if (!list.length) {
            const tips = {
                watching: '还没有追番。从上方「本周新番」点「+ 追番」开始吧。',
                planned: '计划看列表是空的。在追番卡片上切到「计划看」。',
                completed: '还没有已完成的番。'
            };
            box.innerHTML = '<div class="sv-empty">' + (tips[currentTab] || '暂无数据') + '</div>';
            return;
        }
        box.innerHTML = list.map((b) => {
            const total = Number(b.episodeTotal || 0);
            const watched = Number(b.watchedCount || 0);
            const pct = total ? Math.round(watched / total * 100) : 0;
            const next = b.nextEpisode;
            const poster = b.posterPath
                ? '<img src="' + esc(b.posterPath) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
                : '<div class="sv-poster-ph"></div>';
            const nextLabel = next != null ? '▶ 继续看第 ' + next + ' 集' : (total ? '✓ 已看完' : '暂无分集');
            return '<div class="sv-card" data-sid="' + b.id + '">'
                + '<div class="sv-poster" data-act="detail" data-sid="' + b.id + '">' + poster
                + '<span class="sv-progress-badge">' + pct + '%</span></div>'
                + '<div class="sv-body">'
                + '<div class="sv-title" title="' + esc(b.title) + '">' + esc(b.title) + '</div>'
                + '<div class="sv-count">已看 ' + watched + ' / ' + total + ' 集</div>'
                + '<div class="sv-bar"><i style="width:' + pct + '%"></i></div>'
                + '<button class="sv-next" data-act="detail" data-sid="' + b.id + '">' + nextLabel + '</button>'
                + '<div class="sv-card-actions">'
                + '<button data-act="status" data-sid="' + b.id + '" data-status="planned">计划看</button>'
                + '<button data-act="status" data-sid="' + b.id + '" data-status="completed">已完成</button>'
                + '<button data-act="unfollow" data-sid="' + b.id + '">移除</button>'
                + '</div></div></div>';
        }).join('');
    }

    // ---------- 分集抽屉 ----------
    async function openDetail(seriesId) {
        const r = await api('/api/series/' + seriesId + '/detail');
        if (!r || r.code !== 0 || !r.data) { if (window.showNotification) showNotification('加载失败', (r && r.msg) || '未知错误'); return; }
        const d = r.data;
        const eps = d.episodes || [];
        const rows = eps.map(e => {
            const watched = e.watched === 1;
            const pos = Number(e.position || 0), dur = Number(e.progressDuration || e.duration || 0);
            const pct = dur ? Math.round(pos / dur * 100) : 0;
            return '<div class="sv-ep" data-eid="' + e.id + '">'
                + '<span class="sv-ep-no">' + esc(e.episodeNo) + '</span>'
                + '<span class="sv-ep-title">' + esc(e.title || ('第' + e.episodeNo + '集')) + '</span>'
                + '<span class="sv-ep-stat">' + (watched ? '✓ 已看' : (pct ? pct + '%' : '未看')) + '</span>'
                + (e.movieId ? '<button class="sv-ep-play" data-act="play" data-movie="' + e.movieId + '" data-ep="' + e.id + '" data-title="' + esc(d.series.title) + '">播放</button>'
                             : (e.sourceUrl ? '<button class="sv-ep-play sv-ep-online" data-act="play-online" data-eid="' + e.id + '" data-src="' + esc(e.sourceId || '') + '" data-url="' + esc(e.sourceUrl) + '" data-epno="' + esc(e.episodeNo) + '" data-pos="' + (watched ? 0 : pos) + '" data-title="' + esc(d.series.title) + '">🌐 在线</button>'
                             : '<button class="sv-ep-nosrc sv-ep-search" data-act="search-bt" data-title="' + esc(d.series.title) + '" data-ep="' + esc(e.episodeNo) + '">🔍 搜BT</button>'))
                + '<button class="sv-ep-link" data-act="link-local" data-eid="' + e.id + '" data-sid="' + d.series.id + '" data-title="' + esc(d.series.title) + '" data-epno="' + esc(e.episodeNo) + '" title="手动挂本地影片">' + (e.movieId ? '换源' : '📎') + '</button>'
                + '</div>';
        }).join('');
        const html = '<div class="sv-modal-mask" data-act="close-detail">'
            + '<div class="sv-modal" role="dialog" aria-modal="true" aria-label="分集列表">'
            + '<div class="sv-modal-head"><h3>' + esc(d.series.title) + '</h3>'
            + '<button class="sv-online-match" data-act="match-online" data-sid="' + d.series.id + '" data-title="' + esc(d.series.title) + '">🌐 搜在线源</button>'
            + '<button class="sv-modal-close" data-act="close-detail" aria-label="关闭">✕</button></div>'
            + '<div class="sv-ep-list">' + (rows || '<div class="sv-empty">还没有分集数据，等待刮削回填。</div>') + '</div>'
            + '</div></div>';
        let host = document.getElementById('svDetailHost');
        if (!host) { host = document.createElement('div'); host.id = 'svDetailHost'; document.body.appendChild(host); }
        host.innerHTML = html;
    }
    function closeDetail() { const h = document.getElementById('svDetailHost'); if (h) h.innerHTML = ''; }

    // ---------- round182 P0-3：订阅新鲜度自动刷新 ----------
    let __sourceRefreshDone = false;
    async function autoRefreshSources() {
        if (__sourceRefreshDone) return;
        __sourceRefreshDone = true;
        try {
            const f = await api('/api/media-source/freshness');
            if (!f || f.code !== 0 || !f.data || !f.data.stale) return;
            // 后台刷新，不阻塞 UI；静默完成（不弹通知打扰）
            const r = await api('/api/media-source/refresh', { method: 'POST', body: '{}' });
            if (r && r.code === 0 && window.showNotification) {
                showNotification('在线源规则已更新', `拉取了 ${r.data.updated} 份最新规则，追番搜源更准`);
            }
        } catch (e) { /* 网络不通就跳过，下次再试 */ }
    }

    // ---------- v6.7.0：全网多源搜索在线源 ----------
    async function openOnlineMatch(seriesId, title) {
        let host = document.getElementById('svOnlineHost');
        if (!host) { host = document.createElement('div'); host.id = 'svOnlineHost'; document.body.appendChild(host); }
        host.innerHTML = '<div class="sv-modal-mask" data-closem="1"><div class="sv-modal sv-online-modal" role="dialog" aria-modal="true">'
            + '<div class="sv-modal-head"><h3>🌐 全网搜在线源 · ' + esc(title) + '</h3>'
            + '<button class="sv-modal-close" data-closem="1">✕</button></div>'
            + '<div class="sv-online-body" id="svOnlineBody"><div class="sv-empty">正在并发搜索所有在线源（约 10~15 秒）…</div></div></div></div>';
        host.querySelectorAll('[data-closem="1"]').forEach(el => el.addEventListener('click', e => {
            if (e.target === el || el.classList.contains('sv-modal-close')) host.innerHTML = '';
        }));
        try {
            const r = await api('/api/series/match-online', { method: 'POST', body: JSON.stringify({ seriesId, keyword: title }) });
            const body = document.getElementById('svOnlineBody');
            if (!body) return;
            if (!r || r.code !== 0) {
                body.innerHTML = '<div class="sv-empty">搜索失败：' + esc((r && r.msg) || '服务无响应') + '。可稍后重试或点「🔍 搜BT」。</div>';
                return;
            }
            const hits = (r.data && r.data.hits) || [];
            if (!hits.length) {
                body.innerHTML = '<div class="sv-empty">没找到匹配的在线源（扫了 ' + (r.data.scanned || 0) + ' 个源）。可试试「🔍 搜BT」下载。</div>';
                return;
            }
            let n = 0;
            body.innerHTML = '<div class="sv-online-tip">找到 ' + hits.length + ' 个源有结果，点「挂载」把剧集接到本番分集：</div>'
                + hits.map(h => h.items.map(it => {
                    const i = n++;
                    return '<div class="sv-online-item"><div class="sv-online-name" title="' + esc(it.name) + '">' + esc(it.name) + '</div>'
                        + '<span class="sv-online-src">' + esc(h.sourceName) + '</span>'
                        + '<button class="sv-online-pick" data-act="apply-online-source" data-sid="' + seriesId + '" data-src="' + esc(h.sourceId) + '" data-url="' + esc(it.url) + '">挂载</button></div>';
                }).join('')).join('');
        } catch (e) {
            const body = document.getElementById('svOnlineBody');
            if (body) body.innerHTML = '<div class="sv-empty">搜索失败：' + esc(e.message) + '</div>';
        }
    }

    // ---------- v6.4.0④ 手动挂本地影片 ----------
    async function openLinkLocal(episodeId, title, epno) {
        let host = document.getElementById('svLinkHost');
        if (!host) { host = document.createElement('div'); host.id = 'svLinkHost'; document.body.appendChild(host); }
        host.innerHTML = '<div class="sv-modal-mask" data-act="close-link"><div class="sv-modal sv-link-modal" role="dialog" aria-modal="true">'
            + '<div class="sv-modal-head"><h3>📎 挂本地影片 · ' + esc(title) + ' 第' + esc(epno) + '集</h3>'
            + '<button class="sv-modal-close" data-act="close-link">✕</button></div>'
            + '<div class="sv-link-body" id="svLinkBody"><div class="sv-empty">搜索影片库中…</div></div></div></div>';
        host.querySelectorAll('[data-act="close-link"]').forEach(el => el.addEventListener('click', (e) => {
            if (e.target === el || el.classList.contains('sv-modal-close')) host.innerHTML = '';
        }));
        // 用番名 + 集号搜影片库
        const kw = [title, '第' + epno + '集'].filter(Boolean).join(' ');
        try {
            const r = await api('/api/movie/search?keyword=' + encodeURIComponent(kw) + '&limit=30');
            const list = (r && (r.data || r)) || [];
            const items = Array.isArray(list) ? list : (list.items || list.list || []);
            const body = document.getElementById('svLinkBody');
            if (!body) return;
            if (!items.length) {
                body.innerHTML = '<div class="sv-empty">没找到匹配影片。可点「🔍 搜BT」找种子，下载后会自动归集到本集。</div>';
                return;
            }
            body.innerHTML = items.slice(0, 30).map(m =>
                '<div class="sv-link-item"><div class="sv-link-title" title="' + esc(m.title || m.fileName || '') + '">' + esc(m.title || m.fileName || ('影片 #' + m.id)) + '</div>'
                + '<button class="sv-link-pick" data-act="do-link" data-eid="' + episodeId + '" data-mid="' + m.id + '">挂到本集</button></div>'
            ).join('');
        } catch (e) {
            const body = document.getElementById('svLinkBody');
            if (body) body.innerHTML = '<div class="sv-empty">搜索失败：' + esc(e.message) + '</div>';
        }
    }

    // ---------- BT 搜索（阶段4） ----------
    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch (e) {
            const ta = document.createElement('textarea'); ta.value = text;
            ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
            ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e2) {}
            document.body.removeChild(ta); return ok;
        }
    }

    async function openBtSearch(title, ep) {
        // ★ BT 种子标题多用原名 + E01/[01]，几乎不用中文「第N话」——
        //   拼中文话数会让 RSS 整串匹配落空（实测"葬送的芙莉莲 第1话"=0 条，纯番名=48 条）。
        //   只用番名搜索，让用户从结果里自己挑集的种子。
        const kw = String(title || '').trim();
        let host = document.getElementById('svBtHost');
        if (!host) { host = document.createElement('div'); host.id = 'svBtHost'; document.body.appendChild(host); }
        host.innerHTML = '<div class="sv-modal-mask" data-act="close-bt"><div class="sv-modal sv-bt-modal" role="dialog" aria-modal="true">'
            + '<div class="sv-modal-head"><h3>🔍 BT 搜索：' + esc(kw) + '</h3>'
            + '<button class="sv-modal-close" data-act="close-bt">✕</button></div>'
            + '<div class="sv-bt-body" id="svBtBody"><div class="sv-empty">搜索中…</div></div>'
            + '<div class="sv-bt-tip">只展示磁力链接，应用不下载任何内容。复制后粘到夸克/下载器离线，完成后自动入库并挂到本集。</div>'
            + '</div></div>';
        // 关闭按钮
        host.querySelectorAll('[data-act="close-bt"]').forEach(el => el.addEventListener('click', (e) => {
            if (e.target === el || el.classList.contains('sv-modal-close')) { host.innerHTML = ''; }
        }));
        try {
            const r = await api('/api/bt/search?kw=' + encodeURIComponent(kw));
            const items = (r && r.code === 0 && Array.isArray(r.data)) ? r.data : [];
            const body = document.getElementById('svBtBody');
            if (!body) return;
            if (!items.length) { body.innerHTML = '<div class="sv-empty">未找到种子（BT 源可能不可达，可稍后重试）</div>'; return; }
            body.innerHTML = items.slice(0, 40).map(it =>
                '<div class="sv-bt-item"><div class="sv-bt-title" title="' + esc(it.title) + '">' + esc(it.title) + '</div>'
                + '<div class="sv-bt-meta">' + esc(it.size || '') + ' · ' + esc(it.date || '').slice(0, 16) + ' · ' + esc(it.sourceName || '') + '</div>'
                + '<button class="sv-bt-copy" data-act="copy-magnet" data-magnet="' + esc(it.magnet) + '">复制磁力</button></div>'
            ).join('');
        } catch (e) {
            const body = document.getElementById('svBtBody');
            if (body) body.innerHTML = '<div class="sv-empty">搜索失败：' + esc(e.message) + '</div>';
        }
    }

    // ---------- 事件委托 ----------
    async function onClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        const sid = Number(btn.dataset.sid);
        if (act === 'close-detail') { if (e.target === btn || btn.classList.contains('sv-modal-close')) closeDetail(); return; }
        if (act === 'check-updates') {
            btn.disabled = true;
            const old = btn.textContent; btn.textContent = '检查中…';
            api('/api/series/check-updates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                .then(r => {
                    if (r && r.code === 0) {
                        const n = r.data && r.data.notified || 0;
                        if (window.showNotification) showNotification('更新检查完成', n ? ('发现 ' + n + ' 部追番有新集，已发通知') : '暂无新集');
                    }
                })
                .finally(() => { btn.disabled = false; btn.textContent = old; });
            return;
        }
        if (act === 'follow' || act === 'status') {
            const status = btn.dataset.status || 'watching';
            btn.disabled = true;
            api('/api/series/follow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesId: sid, status }) })
                .then(r => {
                    if (r && r.code === 0) {
                        loadBoard(); loadCalendar(false);
                        // round173c：首次追番后台回填分集（静默，不阻塞 UI）；完成/失败都刷新看板
                        if (status === 'watching') {
                            api('/api/series/' + sid + '/backfill-episodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                                .then(() => loadBoard()).catch(() => {});
                        }
                    } else if (window.showNotification) showNotification('操作失败', r && r.msg);
                })
                .finally(() => { btn.disabled = false; });
            return;
        }
        if (act === 'unfollow') {
            btn.disabled = true;
            api('/api/series/unfollow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seriesId: sid }) })
                .then(r => { if (r && r.code === 0) { loadBoard(); loadCalendar(false); } })
                .finally(() => { btn.disabled = false; });
            return;
        }
        if (act === 'detail') { openDetail(sid); return; }
        if (act === 'search-bt') { openBtSearch(btn.dataset.title || '', btn.dataset.ep || ''); return; }
        if (act === 'link-local') { openLinkLocal(Number(btn.dataset.eid), btn.dataset.title || '', btn.dataset.epno || ''); return; }
        if (act === 'do-link') {
            const eid = Number(btn.dataset.eid), mid = Number(btn.dataset.mid), seriesId = Number(btn.dataset.sid);
            try {
                const r = await api('/api/series/episode/link', { method: 'POST', body: JSON.stringify({ episodeId: eid, movieId: mid }) });
                if (window.showNotification) showNotification(r && r.code === 0 ? '已挂接' : '挂接失败', r && r.code === 0 ? '现在可以播放这一集了' : (r && r.msg || ''));
                if (r && r.code === 0) {
                    const host = document.getElementById('svLinkHost'); if (host) host.innerHTML = '';
                    if (seriesId) openDetail(seriesId);
                }
            } catch (e) { if (window.showNotification) showNotification('挂接失败', e.message); }
            return;
        }
        if (act === 'match-online') { openOnlineMatch(Number(btn.dataset.sid), btn.dataset.title || ''); return; }
        if (act === 'apply-online-source') {
            const seriesId = Number(btn.dataset.sid);
            try {
                const r = await api('/api/series/apply-online', { method: 'POST', body: JSON.stringify({
                    seriesId, sourceId: btn.dataset.src, detailUrl: btn.dataset.url, seasonNo: 1
                }) });
                if (window.showNotification) showNotification(r && r.code === 0 ? '在线源已挂载' : '挂载失败',
                    r && r.code === 0 ? ('已挂 ' + r.data.updated + ' 集，点分集的「🌐 在线」即可播放') : (r && r.msg || ''));
                if (r && r.code === 0) {
                    const host = document.getElementById('svOnlineHost'); if (host) host.innerHTML = '';
                    openDetail(seriesId);
                }
            } catch (e) { if (window.showNotification) showNotification('挂载失败', e.message); }
            return;
        }
        if (act === 'play-online') {
            const src = btn.dataset.src, url = btn.dataset.url;
            if (!src || !url) { if (window.showNotification) showNotification('无法播放', '该集在线源信息缺失'); return; }
            if (window.showNotification) showNotification('正在解析在线播放地址', '首次解析可能需十几秒（内置浏览器嗅探）');
            try {
                const d = await api('/api/media-source/resolve?source=' + encodeURIComponent(src) + '&url=' + encodeURIComponent(url));
                if (d && d.code === 0 && window.showVideoPlayer) {
                    window.showVideoPlayer(d.data.streamUrl, btn.dataset.title + ' · 第' + (btn.dataset.epno || '') + '集', d.data.kind,
                        Number(btn.dataset.pos) || 0, Number(btn.dataset.eid) || 0);
                } else if (window.showNotification) showNotification('解析失败', d && d.msg || '未知错误');
            } catch (e) { if (window.showNotification) showNotification('解析失败', e.message); }
            return;
        }
        if (act === 'copy-magnet') {
            const mag = btn.dataset.magnet || '';
            copyText(mag).then(ok => { if (window.showNotification) showNotification(ok ? '磁力已复制' : '复制失败', ok ? '粘贴到夸克/下载器离线下载，完成后自动入库挂到本集' : '请手动复制'); });
            return;
        }
        if (act === 'play') {
            const mid = Number(btn.dataset.movie);
            // 第一档②：把当前追番集号传给播放器，跳过区间改为按 episode 存 DB
            window.__svPlayingEpisode = Number(btn.dataset.ep) || 0;
            window.__svPlayingTitle = btn.dataset.title || '';
            closeDetail();
            if (window.playMovieById) window.playMovieById(mid);
            else if (window.showVideoPlayer) window.showVideoPlayer('', '');
            return;
        }
    }

    function onKeydown(e) {
        if (e.key !== 'Escape') return;
        closeDetail();
        const bt = document.getElementById('svBtHost'); if (bt) bt.innerHTML = '';
        const lk = document.getElementById('svLinkHost'); if (lk) lk.innerHTML = '';
        const om = document.getElementById('svOnlineHost'); if (om) om.innerHTML = '';
    }

    // ---------- 对外接口 ----------
    function show() {
        const r = root();
        if (!r) return;
        r.style.display = 'block';
        buildShell(r);
        loadBoard();
        loadCalendar(false);
        // v6.5.0①：注入系列关系图 / Jellyfin 入口（幂等）
        if (window.SeriesGraph && window.SeriesGraph.injectButton) window.SeriesGraph.injectButton();
        if (window.JellyfinPanel && window.JellyfinPanel.injectButton) window.JellyfinPanel.injectButton();
        // round182 P0-3：订阅超过 7 天没刷新则后台自动拉最新源规则（不阻塞 UI）
        autoRefreshSources();
        document.addEventListener('click', onClick);
        document.addEventListener('keydown', onKeydown);
    }
    function hide() {
        const r = root();
        if (r) r.style.display = 'none';
        closeDetail();
        document.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKeydown);
    }
    function buildShell(r) {
        if (r.dataset.built === '1') return;
        r.innerHTML = '<div class="sv-wrap">'
            + '<div class="sv-head"><h2>📺 追番</h2>'
            + '<div class="sv-head-actions">'
            + '<button class="sv-refresh" data-act="check-updates">检查更新</button>'
            + '<button class="sv-refresh" id="svRefresh">刷新放送表</button></div></div>'
            + '<section class="sv-section"><h3>本周新番 <small>点「+ 追番」加入清单</small></h3>'
            + '<div class="sv-calendar" id="svCalendar"><div class="sv-empty-line">加载中…</div></div></section>'
            + '<section class="sv-section"><div class="sv-tabs" id="svTabs">'
            + '<button data-tab="watching" class="active">追番中</button>'
            + '<button data-tab="planned">计划看</button>'
            + '<button data-tab="completed">已完成</button></div>'
            + '<div class="sv-board" id="svBoard"><div class="sv-empty">加载中…</div></div></section>'
            + '</div>';
        r.dataset.built = '1';
        r.querySelector('#svRefresh').addEventListener('click', () => loadCalendar(true));
        r.querySelector('#svTabs').addEventListener('click', (e) => {
            const b = e.target.closest('[data-tab]');
            if (!b) return;
            currentTab = b.dataset.tab;
            r.querySelectorAll('#svTabs button').forEach(x => x.classList.toggle('active', x === b));
            renderBoard();
        });
    }

    window.SeriesView = Object.assign(window.SeriesView || {}, {
        show, hide, openDetail, loadBoard, loadCalendar, refresh: () => { loadBoard(); loadCalendar(false); }
    });
})();
