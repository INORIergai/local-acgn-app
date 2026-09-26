// ================================================================
// home.js —— 首页（round33）
//   职责：按时间问候语、AI 对话框（接 /api/ai/chat）、ACG 热度榜渲染
//   挂到 window.Home，由 app.js 的 switchView('home') / switchView('acg-rank') 驱动。
// ================================================================

(function () {
    'use strict';

    const rankState = { source: 'acghub', cache: { acghub: null, fankuhub: null } };

    // ---------- 按时间问候 ----------
    function greeting() {
        const h = new Date().getHours();
        if (h < 6) return '夜深了';
        if (h < 9) return '早上好';
        if (h < 12) return '上午好';
        if (h < 14) return '中午好';
        if (h < 18) return '下午好';
        if (h < 23) return '晚上好';
        return '夜深了';
    }

    // ---------- 首页入口 ----------
    function showHome() {
        const v = document.getElementById('homeView');
        if (!v) return;
        v.classList.add('active');
        v.style.display = 'block';

        const g = document.getElementById('homeGreeting');
        if (g) g.textContent = greeting();

        // 若有未加载的问候，这里补一次（页面首次进入时调用）
        renderRankPreview();
        loadLibRank(rankState.lib || 'all', false);
    }

    function hideHome() {
        const v = document.getElementById('homeView');
        if (!v) return;
        v.classList.remove('active');
        v.style.display = 'none';
    }

    // ---------- AI 对话 ----------
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function addMsg(role, text, opts) {
        const box = document.getElementById('homeChatMessages');
        if (!box) return;
        const empty = box.querySelector('.home-chat-empty');
        if (empty) empty.remove();

        const wrap = document.createElement('div');
        wrap.className = 'home-msg ' + role;
        const b = document.createElement('div');
        b.className = 'bubble' + (opts && opts.typing ? ' typing' : '');
        b.innerHTML = text;
        wrap.appendChild(b);
        box.appendChild(wrap);
        box.scrollTop = box.scrollHeight;
        return b;
    }

    async function sendHomeMessage() {
        const ta = document.getElementById('homeChatInput');
        const btn = document.getElementById('homeChatSend');
        const status = document.getElementById('homeChatStatus');
        const msg = (ta && ta.value.trim()) || '';
        if (!msg) return;

        addMsg('user', esc(msg));
        ta.value = '';
        ta.style.height = 'auto';
        btn.disabled = true;
        if (status) status.textContent = '';

        const typing = addMsg('ai', '正在思考…', { typing: true });

        try {
            const res = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg }),
            });
            const data = await res.json();
            if (typing) typing.remove();

            if (data.code !== 0) {
                addMsg('ai', esc(shortErr(data.msg || 'AI 暂时没有回应，请检查 AI 配置')));
                return;
            }

            let reply = data.data.reply || '（无内容）';
            // [[ID|标题]] → 可点击
            reply = reply.replace(/\[\[(\d+)\|([^\]]+)\]\]/g, (m, id, title) =>
                `<span class="ai-movie-ref" data-movie-id="${id}" onclick="window.jumpToMovieFromAI && window.jumpToMovieFromAI(${id})">📎 ${esc(title)}</span>`);
            addMsg('ai', reply);
        } catch (e) {
            if (typing) typing.remove();
            addMsg('ai', esc(shortErr('请求失败：' + (e && e.message || e))));
        } finally {
            btn.disabled = false;
            if (ta) ta.focus();
        }
    }

    /* 把又长又带 JSON 的报错压成一句话：截取 HTTP 状态后的人话，
       去掉转义残留，气泡里一两行能读完。 */
    function shortErr(s) {
        let t = String(s || '');
        t = t.replace(/&quot;/g, '"').replace(/\\n/g, ' ');
        const m = t.match(/HTTP \d+[:：]\s*([\s\S]+)/);
        if (m) {
            try {
                const j = JSON.parse(m[1]);
                t = (j.error && j.error.message) ? j.error.message : m[1];
            } catch (e2) { t = m[1]; }
        }
        t = t.split('\\n')[0].trim();
        return t.length > 120 ? t.slice(0, 120) + '…' : t;
    }

    // ---------- ACG 热度榜（round34 批次B：两排 + 应用内详情） ----------
    function fmtHeat(n) {
        if (n == null) return '';
        if (n >= 10000) return (n / 10000).toFixed(1) + '万';
        return String(n);
    }

    function coverProxy(u) {
        if (!u) return '';
        return '/api/acg/cover?u=' + encodeURIComponent(u);
    }

    // 榜单条目：不再 <a target=_blank> 跳浏览器 —— 全部走应用内详情弹窗
    function rankItemHtml(it) {
        const heat = it.heat ? `<span class="rank-heat">🔥 ${fmtHeat(it.heat)}</span>` : '';
        const score = (it.score != null) ? `<span class="rank-score">${it.score.toFixed(1)}</span>` : '';
        const tags = (it.tags && it.tags.length)
            ? `<span class="rank-tags">${it.tags.slice(0, 3).map(t => `<span class="rank-tag">${esc(t)}</span>`).join('')}</span>`
            : '';
        const meta = (it.source === 'fankuhub' && it.voteCount)
            ? `<span>${fmtHeat(it.voteCount)} 人评</span>` : '';
        const payload = esc(JSON.stringify({ s: it.source, id: it.id || '', scope: it.scope || 'anime' }));
        return `
        <div class="rank-item ${it.rank <= 3 ? 'top' + it.rank : ''}" onclick="window.Home.openAcgDetail('${payload}')" title="在应用内查看详情">
            <span class="rank-num">${it.rank}</span>
            ${it.cover ? `<img class="rank-cover" src="${coverProxy(it.cover)}" loading="lazy" alt="">` : ''}
            <span class="rank-body">
                <span class="rank-title">${esc(it.title)}</span>
                <span class="rank-meta">${tags}${meta}${heat}</span>
            </span>
            ${score}
        </div>`;
    }

    function renderRankList(items) {
        const box = document.getElementById('homeRankList');
        if (!box) return;
        if (!items || !items.length) {
            box.innerHTML = '<div class="rank-error">榜单数据加载失败</div>';
            return;
        }
        box.innerHTML = items.map(rankItemHtml).join('');
    }

    async function loadRank(source, force) {
        const box = document.getElementById('homeRankList');
        if (box) box.innerHTML = '<div class="rank-loading">正在加载热度榜…</div>';
        try {
            const res = await fetch('/api/acg/rank?source=' + source + (force ? '&force=1' : ''));
            const data = await res.json();
            if (data.code !== 0) {
                if (box) box.innerHTML = '<div class="rank-error">' + esc(data.msg || '加载失败') + '</div>';
                return;
            }
            const items = data.data.items || [];
            rankState.cache[source] = items;
            renderRankList(items);
        } catch (e) {
            if (box) box.innerHTML = '<div class="rank-error">网络错误</div>';
        }
    }

    function renderRankPreview() {
        const box = document.getElementById('homeRankList');
        if (!box) return;
        const items = rankState.cache[rankState.source];
        if (items) { renderRankList(items); return; }
        loadRank(rankState.source, false);
    }

    function switchRankSource(source) {
        rankState.source = source;
        document.querySelectorAll('.home-rank-tab[data-src]').forEach(t =>
            t.classList.toggle('active', t.dataset.src === source));
        renderRankPreview();
    }

    function refreshRank() {
        const btn = document.getElementById('homeRankRefresh');
        if (btn) btn.classList.add('spinning');
        const jobs = [loadRank(rankState.source, true)];
        if (rankState.lib !== undefined) jobs.push(loadLibRank(rankState.lib, true));
        Promise.all(jobs).finally(() => {
            if (btn) btn.classList.remove('spinning');
        });
    }

    // ---------- 第二排：本地片库热度（漫画/小说/AV/里番/影视/动漫 都有） ----------
    const LIB_LABEL = { all: '全部', jav: 'AV', anime: '里番', film: '影视', cartoon: '动漫', comic: '漫画', novel: '小说' };
    let libRankCache = {};

    async function loadLibRank(lib, force) {
        rankState.lib = lib;
        const box = document.getElementById('homeLibList');
        if (!box) return;
        // 只缓存「成功取到的数据」；未解锁 401 / 网络失败不缓存，解锁回首页时重拉
        if (!force && Array.isArray(libRankCache[lib]) && libRankCache[lib].length) {
            renderLibRank(libRankCache[lib]);
            return;
        }
        box.innerHTML = '<div class="rank-loading">正在加载片库热度…</div>';
        try {
            const t = lib === 'all' ? 'all' : lib;
            const res = await fetch(`/api/movie?sort=hot&filter=all&type=${t}&page=1&pageSize=10`);
            const data = await res.json();
            if (data.code !== 0) {
                box.innerHTML = '<div class="rank-error">' + esc(data.msg || '加载失败') + '</div>';
                return;                      // 不缓存失败结果
            }
            const items = (data.data || []).map((m, i) => ({
                id: m.id,
                rank: i + 1,
                title: m.title || m.fileName || ('#' + m.id),
                cover: m.posterFile ? '/api/movie/poster/' + m.posterFile : '',
                score: m.rating != null ? Number(m.rating) : null,
                heat: m.playCount || 0,
                type: m.type || lib,
            }));
            libRankCache[lib] = items;
            renderLibRank(items);
        } catch (e) {
            box.innerHTML = '<div class="rank-error">网络错误</div>';
        }
    }

    function renderLibRank(items) {
        const box = document.getElementById('homeLibList');
        if (!box) return;
        if (!items || !items.length) {
            box.innerHTML = '<div class="rank-error">这个库还没有内容</div>';
            return;
        }
        box.innerHTML = items.map(it => `
            <div class="rank-item ${it.rank <= 3 ? 'top' + it.rank : ''}" onclick="showMovieDetail(${it.id})" title="查看详情">
                <span class="rank-num">${it.rank}</span>
                ${it.cover ? `<img class="rank-cover" src="${esc(it.cover)}" loading="lazy" alt="" onerror="this.style.visibility='hidden'">` : ''}
                <span class="rank-body">
                    <span class="rank-title">${esc(it.title)}</span>
                    <span class="rank-meta"><span class="rank-tag">${LIB_LABEL[it.type] || ''}</span>${it.heat ? `<span>▶ ${fmtHeat(it.heat)} 次播放</span>` : ''}</span>
                </span>
                ${it.score ? `<span class="rank-score">${it.score.toFixed(1)}</span>` : ''}
            </div>`).join('');
    }

    function switchLibRank(lib) {
        rankState.lib = lib;
        document.querySelectorAll('.home-rank-tab[data-lib]').forEach(t =>
            t.classList.toggle('active', t.dataset.lib === lib));
        loadLibRank(lib, false);
    }

    // ---------- 榜单详情弹窗（应用内，绝不跳浏览器） ----------
    let acgDetailCache = {};
    let acgDetailSeq = 0;

    function openAcgDetail(payloadJson) {
        let p;
        try { p = JSON.parse(payloadJson); } catch (e) { return; }
        const dm = document.getElementById('acgDetailModal');
        const body = document.getElementById('acgDetailBody');
        if (!dm || !body) return;
        dm.classList.add('show');
        body.innerHTML = '<div class="rank-loading">正在加载详情…</div>';

        const seq = ++acgDetailSeq;
        const cacheKey = p.s + ':' + (p.id || '');
        const render = (d) => {
            if (seq !== acgDetailSeq) return;   // 连续点开时只渲染最后一次
            acgDetailCache[cacheKey] = d;
            renderAcgDetail(d);
        };

        if (acgDetailCache[cacheKey]) { render(acgDetailCache[cacheKey]); return; }

        fetch(`/api/acg/detail?source=${encodeURIComponent(p.s)}&id=${encodeURIComponent(p.id)}&scope=${encodeURIComponent(p.scope || '')}`)
            .then(r => r.json())
            .then(data => {
                if (data.code !== 0) {
                    body.innerHTML = '<div class="rank-error">' + esc(data.msg || '详情加载失败') + '</div>';
                    return;
                }
                render(data.data);
            })
            .catch(() => { body.innerHTML = '<div class="rank-error">网络错误</div>'; });
    }

    function watchLabelFor(scope) {
        if (scope === 'comic' || scope === 'manga') return { label: '📖 去阅读', view: 'watch-comic' };
        if (scope === 'novel' || scope === 'light-novel') return { label: '📖 去阅读', view: 'watch-comic' };
        return { label: '▶️ 去观看', view: 'watch-anime' };
    }

    function renderAcgDetail(d) {
        const body = document.getElementById('acgDetailBody');
        if (!body) return;
        const alt = (d.titleAlt || []).map(t => `<div class="acg-d-alt">${esc(t)}</div>`).join('');
        const genres = (d.genres || []).map(g => `<span class="rank-tag">${esc(g)}</span>`).join('');
        const staff = (d.staff || []).length
            ? `<div class="acg-d-row"><span class="acg-d-k">制作人员</span><span>${esc(d.staff.join(' / '))}</span></div>` : '';
        const studios = (d.studios || []).length
            ? `<div class="acg-d-row"><span class="acg-d-k">制作公司</span><span>${esc(d.studios.join(' / '))}</span></div>` : '';
        const w = watchLabelFor(d.scope || (d.source === 'acghub' ? '' : 'anime'));
        const srcName = d.source === 'fankuhub' ? '番库' : 'ACGHub';
        body.innerHTML = `
            <div class="acg-d-head">
                ${d.cover ? `<img class="acg-d-cover" src="${coverProxy(d.cover)}" alt="">` : ''}
                <div class="acg-d-info">
                    <div class="acg-d-src">${esc(srcName)}${d.source === 'acghub' && d.detailUrl ? ' · 榜单情报' : ''}</div>
                    <h3 class="acg-d-title">${esc(d.title)}</h3>
                    ${alt}
                    <div class="acg-d-badges">
                        ${d.score != null ? `<span class="acg-d-score">${d.score.toFixed(1)} 分</span>` : ''}
                        ${d.heat ? `<span class="acg-d-chip">🔥 ${fmtHeat(d.heat)}</span>` : ''}
                        ${d.voteCount ? `<span class="acg-d-chip">${fmtHeat(d.voteCount)} 人评</span>` : ''}
                        ${d.airDate ? `<span class="acg-d-chip">📅 ${esc(String(d.airDate).slice(0, 10))}</span>` : ''}
                        ${d.status ? `<span class="acg-d-chip">${esc(d.status)}</span>` : ''}
                    </div>
                    ${genres ? `<div class="acg-d-genres">${genres}</div>` : ''}
                    <div class="acg-d-actions">
                        <button class="btn acg-d-watch" id="acgDWatchBtn" data-view="${w.view}" data-title="${esc(d.title)}">${w.label}</button>
                        <button class="btn btn-secondary" onclick="window.Home.closeAcgDetail()">关闭</button>
                    </div>
                </div>
            </div>
            ${d.synopsis ? `<div class="acg-d-synopsis">${esc(d.synopsis)}</div>` : '<div class="acg-d-synopsis acg-d-empty">暂无简介</div>'}
            ${studios}
            ${staff}
        `;
        const wb = body.querySelector('#acgDWatchBtn');
        if (wb) wb.addEventListener('click', () => {
            if (typeof window.openWatchWithSearch === 'function') {
                window.openWatchWithSearch(wb.dataset.view, wb.dataset.title);
                closeAcgDetail();
            }
        });
    }

    function closeAcgDetail() {
        const dm = document.getElementById('acgDetailModal');
        if (dm) dm.classList.remove('show');
    }

    // ---------- ACG 榜单独立视图 ----------
    function showAcgBoard() {
        const v = document.getElementById('acgView');
        if (!v) return;
        v.classList.add('active');
        v.style.display = 'block';
        loadAcgBoard();
    }

    function hideAcgBoard() {
        const v = document.getElementById('acgView');
        if (!v) return;
        v.classList.remove('active');
        v.style.display = 'none';
    }

    async function loadAcgBoard() {
        const grid = document.getElementById('acgGrid');
        if (!grid) return;
        grid.innerHTML = '<div class="acg-empty">正在加载榜单…</div>';
        try {
            const res = await fetch('/api/acg/rank?source=all');
            const data = await res.json();
            if (data.code !== 0) { grid.innerHTML = '<div class="acg-empty">加载失败</div>'; return; }
            const merged = [];
            if (data.data.fankuhub && data.data.fankuhub.items) merged.push(...data.data.fankuhub.items);
            if (data.data.acghub && data.data.acghub.items) merged.push(...data.data.acghub.items);
            if (!merged.length) { grid.innerHTML = '<div class="acg-empty">暂无榜单数据</div>'; return; }
            grid.innerHTML = merged.map(it => {
                const payload = esc(JSON.stringify({ s: it.source, id: it.id || '', scope: it.scope || 'anime' }));
                return `
                <div class="acg-card" onclick="window.Home.openAcgDetail('${payload}')" title="在应用内查看详情">
                    ${it.cover ? `<img class="acg-card-cover" src="${coverProxy(it.cover)}" loading="lazy" alt="">` : ''}
                    <div class="acg-card-body">
                        <div class="acg-card-title">${esc(it.title)}</div>
                        <div class="acg-card-meta">
                            <span>${it.source === 'fankuhub' ? '番库' : 'ACGHub'} · ${it.rank}</span>
                            ${it.score != null ? `<span class="acg-card-score">${it.score.toFixed(1)}</span>` : ''}
                        </div>
                    </div>
                </div>`;
            }).join('');
        } catch (e) {
            grid.innerHTML = '<div class="acg-empty">网络错误</div>';
        }
    }

    // 绑定输入框事件（在 DOMContentLoaded 后由 app.js 调用 bindHome）
    function bindHome() {
        const ta = document.getElementById('homeChatInput');
        const btn = document.getElementById('homeChatSend');
        if (ta) {
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHomeMessage(); }
            });
            ta.addEventListener('input', () => {
                ta.style.height = 'auto';
                ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
            });
        }
        if (btn) btn.addEventListener('click', sendHomeMessage);
        document.querySelectorAll('.home-rank-tab[data-src]').forEach(t =>
            t.addEventListener('click', () => switchRankSource(t.dataset.src)));
        document.querySelectorAll('.home-rank-tab[data-lib]').forEach(t =>
            t.addEventListener('click', () => switchLibRank(t.dataset.lib)));
        const rf = document.getElementById('homeRankRefresh');
        if (rf) rf.addEventListener('click', refreshRank);
        // 详情弹窗：点遮罩关闭
        const dm = document.getElementById('acgDetailModal');
        if (dm) dm.addEventListener('click', (e) => { if (e.target.id === 'acgDetailModal') closeAcgDetail(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && dm && dm.classList.contains('show')) closeAcgDetail();
        });
        // 窄屏用短提示，避免 placeholder 溢出截断
        const applyPh = () => {
            if (ta && ta.dataset.phWide) {
                ta.placeholder = window.innerWidth <= 860 ? ta.dataset.phNarrow : ta.dataset.phWide;
            }
        };
        applyPh();
        window.addEventListener('resize', applyPh);
    }

    window.Home = { showHome, hideHome, showAcgBoard, hideAcgBoard, bindHome, openAcgDetail, closeAcgDetail };
})();
