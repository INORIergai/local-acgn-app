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
        // round42：不写内联 display（内联会盖掉 CSS 的两栏 grid），交给 .active 规则
        v.style.display = '';

        // 若有未加载的问候，这里补一次（页面首次进入时调用）
        renderRankPreview();
        loadCalendar(false);
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

    /* r75：轻量 Markdown 渲染 —— AI 常回 **粗体** 和 | 表格 |，
       原样 innerHTML 会满屏星号竖线。必须在 esc() 之后跑，无 XSS 面。 */
    function mdLite(s) {
        return String(s || '')
            .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
            .replace(/^\s*\|(.+)\|\s*$/gm, (m, row) => {
                const cells = row.split('|').map(c => c.trim()).filter(c => c);
                if (!cells.length || cells.every(c => /^[-: ]*$/.test(c))) return '';
                return cells.join(' · ');
            });
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

    /* r61：agent 任务分解步骤条 —— 后端循环里每执行一个工具就记一步，
       回复到达后先铺步骤再出最终报告，让「AI 干活」看得见。 */
    function addStepsBlock(steps) {
        if (!Array.isArray(steps) || !steps.length) return;
        const box = document.getElementById('homeChatMessages');
        if (!box) return;
        const empty = box.querySelector('.home-chat-empty');
        if (empty) empty.remove();
        const wrap = document.createElement('div');
        wrap.className = 'home-msg ai';
        const el = document.createElement('div');
        el.className = 'ai-agent-steps';
        el.innerHTML =
            '<div class="ai-steps-title">🗂 任务分解 · ' + steps.length + ' 步</div>' +
            steps.map(s =>
                '<div class="ai-step ' + (s.ok !== false ? 'ok' : 'fail') + '">' +
                '<span class="ai-step-ic">' + (s.ok !== false ? '✅' : '❌') + '</span>' +
                '<span class="ai-step-label">' + esc(s.label || s.tool || '执行操作') + '</span>' +
                (s.summary ? '<span class="ai-step-sum">' + esc(s.summary) + '</span>' : '') +
                '</div>').join('');
        wrap.appendChild(el);
        box.appendChild(wrap);
        box.scrollTop = box.scrollHeight;
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
        // v4.0：Live2D 伴侣进入思考态
        if (window.CVCompanion) window.CVCompanion.aiEvent('thinking');

        try {
            const res = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg, sessionId: 'main' }),
            });
            const data = await res.json();
            if (typing) typing.remove();

            if (data.code !== 0) {
                if (window.CVCompanion) window.CVCompanion.aiEvent('error');
                addMsg('ai', esc(shortErr(data.msg || 'AI 暂时没有回应，请检查 AI 配置')));
                return;
            }

            let reply = data.data.reply || '（无内容）';
            // r61：先铺任务分解步骤，再出最终报告
            addStepsBlock(data.data.steps);
            // r61 修复「回复被吞」：先整体转义再替换 [[ID|标题]] 标记。
            // 旧代码把原文直接 innerHTML，模型回 <xxx> 或 <think> 块时会被浏览器当成标签吞掉。
            reply = mdLite(esc(reply)).replace(/\[\[(\d+)\|([^\]]+)\]\]/g, (m, id, title) =>
                `<span class="ai-movie-ref" data-movie-id="${id}" onclick="window.jumpToMovieFromAI && window.jumpToMovieFromAI(${id})">📎 ${title}</span>`);
            addMsg('ai', reply);
            // v4.0：伴侣朗读回复（气泡 + TALKING 动作）
            if (window.CVCompanion) window.CVCompanion.aiEvent('reply', data.data.reply || '');
        } catch (e) {
            if (typing) typing.remove();
            if (window.CVCompanion) window.CVCompanion.aiEvent('error');
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

    // 榜单条目：不再 <a target=_blank> 跳浏览器 —— 全部走应用内详情弹窗。
    // round52：右侧再给一个「▶」直达聚合页（不必先开详情）。
    function rankItemHtml(it) {
        const heat = it.heat ? `<span class="rank-heat">🔥 ${fmtHeat(it.heat)}</span>` : '';
        const score = (it.score != null) ? `<span class="rank-score">${it.score.toFixed(1)}</span>` : '';
        const tags = (it.tags && it.tags.length)
            ? `<span class="rank-tags">${it.tags.slice(0, 3).map(t => `<span class="rank-tag">${esc(t)}</span>`).join('')}</span>`
            : '';
        const meta = (it.source === 'fankuhub' && it.voteCount)
            ? `<span>${fmtHeat(it.voteCount)} 人评</span>` : '';
        const payload = esc(JSON.stringify({ s: it.source, id: it.id || '', scope: it.scope || 'anime' }));
        // 与详情弹窗同一套口径（watchLabelFor），gal 走外链、不给直达按钮
        const w = watchLabelFor(it.scope || 'anime');
        const go = w.view === '_external' ? '' :
            `<button class="rank-go" data-goview="${esc(w.view)}" data-gotitle="${esc(it.title || '')}" title="${esc(w.label)}：直接进聚合页搜遍所有在线源" aria-label="${esc(w.label)}">▶</button>`;
        return `
        <div class="rank-item ${it.rank <= 3 ? 'top' + it.rank : ''}" onclick="window.Home.openAcgDetail('${payload}')" title="在应用内查看详情">
            <span class="rank-num">${it.rank}</span>
            ${it.cover ? `<img class="rank-cover" src="${coverProxy(it.cover)}" loading="lazy" alt="">` : ''}
            <span class="rank-body">
                <span class="rank-title">${esc(it.title)}</span>
                <span class="rank-meta">${tags}${meta}${heat}</span>
            </span>
            ${score}
            ${go}
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
        bindCardGo(box);   // round52：榜单条目右侧「▶」直达聚合页
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
        const cacheKey = p.s + ':' + (p.id || '') + ':' + (p.b || '');
        const render = (d) => {
            if (seq !== acgDetailSeq) return;   // 连续点开时只渲染最后一次
            acgDetailCache[cacheKey] = d;
            renderAcgDetail(d);
        };

        if (acgDetailCache[cacheKey]) { render(acgDetailCache[cacheKey]); return; }

        // round46：条目带 bgmId（Bangumi 命中）时传给后端 → 详情优先走中文源
        fetch(`/api/acg/detail?source=${encodeURIComponent(p.s)}&id=${encodeURIComponent(p.id)}&scope=${encodeURIComponent(p.scope || '')}${p.b ? '&bgmId=' + encodeURIComponent(p.b) : ''}`)
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
        if (scope === 'gal') return { label: '🌐 VNDB 页面', view: '_external' };
        if (scope === 'comic' || scope === 'manga') return { label: '📖 去阅读', view: 'watch-comic' };
        if (scope === 'novel' || scope === 'light-novel') return { label: '📖 去阅读', view: 'watch-novel' };   // round53：小说独立板块
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
        // round46：中文源优先展示；gal 外链按钮按实际详情来源标注
        const srcName = d.source === 'fankuhub' ? '番库'
            : d.source === 'vndb' ? 'VNDB'
            : d.source === 'bgm' ? 'Bangumi'
            : d.source === 'cngal' ? 'CnGal'
            : d.source === 'anilist' ? 'AniList' : 'ACGHub';
        if (d.scope === 'gal') {
            w.label = d.source === 'cngal' ? '🌐 CnGal 页面'
                : d.source === 'bgm' ? '🌐 Bangumi 页面' : '🌐 VNDB 页面';
        }
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
                        <button class="btn acg-d-watch" id="acgDWatchBtn" data-view="${w.view}" data-title="${esc(d.title)}" data-url="${esc(d.detailUrl || '')}">${w.label}</button>
                        <button class="btn btn-secondary" id="acgDFavBtn" title="存进收藏夹，想看的动漫/漫画/小说/游戏分板块存放">⭐ 收藏</button>
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
            if (wb.dataset.view === '_external') {
                if (wb.dataset.url) window.open(wb.dataset.url, '_blank');
                closeAcgDetail();
                return;
            }
            if (typeof window.openWatchWithSearch === 'function') {
                window.openWatchWithSearch(wb.dataset.view, wb.dataset.title);
                closeAcgDetail();
            }
        });
        // round53：⭐ 收藏 —— 榜单条目进收藏夹（图文卡），点击时回跳聚合页按标题搜。
        // scope → 板块：动画→想看的动漫；manga/comic→漫画；novel→小说；gal→想玩的游戏。
        const fb = body.querySelector('#acgDFavBtn');
        if (fb) fb.addEventListener('click', () => {
            const scope = d.scope || (d.source === 'acghub' ? '' : 'anime');
            const board = scope === 'gal' ? 'game'
                : (scope === 'comic' || scope === 'manga') ? 'comic'
                : (scope === 'novel' || scope === 'light-novel') ? 'novel' : 'anime';
            if (typeof window.saveToFav !== 'function') { showNotification('收藏夹还没就绪'); return; }
            window.saveToFav({
                board,
                title: d.title || '',
                url: d.detailUrl || '',
                coverUrl: d.cover || '',
                source: srcName
            });
        });
    }

    function closeAcgDetail() {
        const dm = document.getElementById('acgDetailModal');
        if (dm) dm.classList.remove('show');
    }

    // ---------- ACG 榜单独立视图 ----------
    // round42：日/周/月/年切换（周=双源聚合；日/月/年=AniList 高清源）
    // v1.3 四类榜：cat=anime|manga|novel|gal；gal 用专属 tab（daily|rating|votes）
    let acgBoardPeriod = 'week';
    let acgBoardCat = 'anime';
    // round46：非动画类别的子口径（JS 动态渲染进 #acgSubGrid）
    const ACG_SUBTABS = {
        manga: [['heat', '人气榜'], ['score', '高分榜']],
        novel: [['heat', '人气榜'], ['score', '高分榜']],
        gal: [['daily', '每日推荐'], ['rating', '高分榜'], ['votes', '人气榜'], ['cngal', 'CnGal 精选']],
    };
    let acgSubTab = 'heat';

    function renderSubTabs() {
        const box = document.getElementById('acgSubGrid');
        if (!box) return;
        const tabs = ACG_SUBTABS[acgBoardCat] || [];
        box.innerHTML = tabs.map(([v, label]) =>
            `<button class="acg-period-tab${v === acgSubTab ? ' active' : ''}" data-sub="${v}">${label}</button>`).join('');
        box.querySelectorAll('.acg-period-tab[data-sub]').forEach(b =>
            b.addEventListener('click', () => window.Home.switchSubTab(b.dataset.sub)));
    }

    function syncBoardTabs() {
        document.querySelectorAll('.acg-cat-tab').forEach(t =>
            t.classList.toggle('active', t.dataset.cat === acgBoardCat));
        document.querySelectorAll('.acg-period-tab[data-period]').forEach(t =>
            t.classList.toggle('active', acgBoardCat === 'anime' && t.dataset.period === acgBoardPeriod));
        // round46：动画用周期格；漫画/小说/gal 用动态子口径格
        const isAnime = acgBoardCat === 'anime';
        const pg = document.getElementById('acgPeriodGrid');
        const sg = document.getElementById('acgSubGrid');
        if (pg) pg.style.display = isAnime ? '' : 'none';
        if (sg) {
            sg.style.display = isAnime ? 'none' : '';
            if (!isAnime) renderSubTabs();
        }
    }

    function showAcgBoard() {
        const v = document.getElementById('acgView');
        if (!v) return;
        v.classList.add('active');
        v.style.display = 'block';
        syncBoardTabs();
        loadAcgBoard();
    }

    function hideAcgBoard() {
        const v = document.getElementById('acgView');
        if (!v) return;
        v.classList.remove('active');
        v.style.display = 'none';
    }

    function switchAcgPeriod(period) {
        if (acgBoardCat === 'anime' && acgBoardPeriod === period) return;
        acgBoardPeriod = period;
        syncBoardTabs();
        loadAcgBoard();
    }

    function switchAcgCat(cat) {
        if (acgBoardCat === cat) return;
        acgBoardCat = cat;
        // 切口径时给每个类别一个合理的默认子口径
        if (cat === 'anime') acgBoardPeriod = acgBoardPeriod || 'week';
        else acgSubTab = cat === 'gal' ? 'daily' : 'heat';
        syncBoardTabs();
        loadAcgBoard();
    }

    function switchSubTab(tab) {
        if (acgSubTab === tab) return;
        acgSubTab = tab;
        syncBoardTabs();
        loadAcgBoard();
    }

    function acgCardHtml(it, srcLabel) {
        const payload = esc(JSON.stringify({ s: it.source, id: it.id || '', scope: it.scope || 'anime', b: it.bgmId || '' }));
        // round52：卡片上直接给「去观看 / 去阅读」，不必先开详情弹窗。
        // 口径与详情弹窗完全一致（同一个 watchLabelFor），gal 是外链不适用，不显示。
        const w = watchLabelFor(it.scope || 'anime');
        const goBtn = w.view === '_external' ? '' :
            `<button class="acg-card-go" data-goview="${esc(w.view)}" data-gotitle="${esc(it.title || '')}" title="直接进聚合页，一次搜遍所有在线源">${esc(w.label)}</button>`;
        return `
        <div class="acg-card" onclick="window.Home.openAcgDetail('${payload}')" title="在应用内查看详情">
            ${it.cover ? `<img class="acg-card-cover" src="${coverProxy(it.cover)}" loading="lazy" alt="">` : ''}
            <div class="acg-card-body">
                <div class="acg-card-title">${esc(it.title)}</div>
                <div class="acg-card-meta">
                    <span>${esc(srcLabel)} · ${it.rank}</span>
                    ${it.score != null ? `<span class="acg-card-score">${it.score.toFixed(1)}</span>` : ''}
                </div>
                ${goBtn}
            </div>
        </div>`;
    }

    /* 榜单直达：点卡片上的「去观看/去阅读」——
       ★必须用捕获阶段监听：卡片自己是行内 onclick（冒泡阶段才执行），
       若在冒泡阶段 stopPropagation，详情弹窗已经先打开了。
       用事件委托一次绑定，后面几处 innerHTML 重绘都自动生效。 */
    function bindCardGo(root) {
        if (!root || root.__cardGoBound) return;
        root.__cardGoBound = 1;
        root.addEventListener('click', (e) => {
            const b = e.target.closest('[data-gotitle]');
            if (!b) return;
            e.stopPropagation();
            e.preventDefault();
            const t = b.dataset.gotitle || '';
            if (!t) return;
            if (typeof window.openWatchWithSearch === 'function') {
                window.openWatchWithSearch(b.dataset.goview || 'watch-anime', t);
            }
        }, true);
    }

    async function loadAcgBoard() {
        const grid = document.getElementById('acgGrid');
        if (!grid) return;
        bindCardGo(grid);   // round52：卡片「去观看」直达（委托，重绘后仍生效）
        grid.innerHTML = '<div class="acg-empty">正在加载榜单…</div>';
        try {
            /* v1.3 四类榜：
             *   动画周榜 = fankuhub + acghub 双源合并（round33 原样）；
             *   动画日/月/年 = AniList；漫画/小说全部周期 = AniList（无双源周榜，周 tab 已隐藏）；
             *   galgame = VNDB 高分/人气榜 + 每日推荐（高分池按日期轮换） */
            if (acgBoardCat === 'gal' || acgBoardCat === 'manga' || acgBoardCat === 'novel') {
                if (acgBoardCat === 'gal') {
                    const isDaily = acgSubTab === 'daily';
                    const isCngal = acgSubTab === 'cngal';
                    const res = await fetch(isDaily ? '/api/acg/daily' : '/api/acg/rank?cat=gal&sort=' + (isCngal ? 'cngal' : acgSubTab));
                    const data = await res.json();
                    if (data.code !== 0) { grid.innerHTML = '<div class="acg-empty">' + esc(data.msg || '加载失败') + '</div>'; return; }
                    const items = (data.data && data.data.items) || [];
                    if (!items.length) { grid.innerHTML = '<div class="acg-empty">暂无榜单数据</div>'; return; }
                    /* 池子有 200 条（供每日推荐轮换），榜面与其他口径一致只展示 30 */
                    const shown = isDaily ? items : items.slice(0, 30);
                    const label = isDaily ? '每日推荐' : (isCngal ? 'CnGal 精选' : (acgSubTab === 'votes' ? '人气榜' : '高分榜'));
                    grid.innerHTML = shown.map(it => acgCardHtml(it, label)).join('');
                    return;
                }
                // 漫画/小说：人气/高分双口径（AniList POPULARITY 池 + Bangumi 中文名）
                const res = await fetch('/api/acg/rank?cat=' + acgBoardCat + '&sort=' + (acgSubTab === 'score' ? 'score' : 'heat'));
                const data = await res.json();
                if (data.code !== 0) { grid.innerHTML = '<div class="acg-empty">' + esc(data.msg || '加载失败') + '</div>'; return; }
                const items = (data.data && data.data.items) || [];
                if (!items.length) { grid.innerHTML = '<div class="acg-empty">暂无榜单数据</div>'; return; }
                grid.innerHTML = items.map(it => acgCardHtml(it, acgSubTab === 'score' ? '高分榜' : '人气榜')).join('');
                return;
            }
            if (acgBoardCat !== 'anime' || acgBoardPeriod !== 'week') {
                const catQ = acgBoardCat !== 'anime' ? '&cat=' + acgBoardCat : '';
                const res = await fetch('/api/acg/rank?source=anilist&period=' + acgBoardPeriod + catQ);
                const data = await res.json();
                if (data.code !== 0) { grid.innerHTML = '<div class="acg-empty">' + esc(data.msg || '加载失败') + '</div>'; return; }
                const items = (data.data && data.data.items) || [];
                if (!items.length) { grid.innerHTML = '<div class="acg-empty">暂无榜单数据</div>'; return; }
                grid.innerHTML = items.map(it => acgCardHtml(it, 'AniList')).join('');
                return;
            }
            const res = await fetch('/api/acg/rank?source=all');
            const data = await res.json();
            if (data.code !== 0) { grid.innerHTML = '<div class="acg-empty">加载失败</div>'; return; }
            const merged = [];
            if (data.data.fankuhub && data.data.fankuhub.items) merged.push(...data.data.fankuhub.items);
            if (data.data.acghub && data.data.acghub.items) merged.push(...data.data.acghub.items);
            if (!merged.length) { grid.innerHTML = '<div class="acg-empty">暂无榜单数据</div>'; return; }
            grid.innerHTML = merged.map(it =>
                acgCardHtml(it, it.source === 'fankuhub' ? '番库' : 'ACGHub')).join('');
        } catch (e) {
            grid.innerHTML = '<div class="acg-empty">网络错误</div>';
        }
    }

    // ---------- 本周放送（round36 P0-2） ----------
    const calState = { data: null, day: 0 };

    function calItemHtml(it) {
        const time = it.airingAt ? new Date(it.airingAt) : null;
        const timeStr = time ? `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}` : '';
        return `
        <div class="cal-item" data-title="${esc(it.title)}" title="在应用内搜索并观看">
            ${it.cover ? `<img class="cal-cover" src="${coverProxy(it.cover)}" loading="lazy" alt="">` : '<div class="cal-cover cal-cover-empty">📺</div>'}
            <div class="cal-item-body">
                <div class="cal-item-title">${esc(it.title)}</div>
                <div class="cal-item-meta">
                    ${it.episode ? `<span class="cal-chip">第 ${it.episode} 集</span>` : ''}
                    ${it.totalEps ? `<span class="cal-chip">共 ${it.totalEps} 集</span>` : ''}
                    ${it.score ? `<span class="cal-chip cal-chip-time">★ ${it.score}</span>` : ''}
                    ${timeStr ? `<span class="cal-chip cal-chip-time">${timeStr}</span>` : ''}
                </div>
            </div>
        </div>`;
    }

    function renderCalTabs() {
        const tabs = document.getElementById('homeCalTabs');
        if (!tabs || !calState.data) return;
        tabs.innerHTML = calState.data.days.map((d, i) => `
            <button class="cal-tab ${i === calState.day ? 'active' : ''}" data-i="${i}">
                ${esc(d.label)}<span class="cal-tab-n">${d.items.length}</span>
            </button>`).join('');
        tabs.querySelectorAll('.cal-tab').forEach(b =>
            b.addEventListener('click', () => { calState.day = +b.dataset.i; renderCalTabs(); renderCalList(); }));
    }

    function renderCalList() {
        const box = document.getElementById('homeCalList');
        if (!box || !calState.data) return;
        const items = (calState.data.days[calState.day] || {}).items || [];
        if (!items.length) {
            box.innerHTML = '<div class="rank-error">这一天没有排播</div>';
            return;
        }
        box.innerHTML = items.map(calItemHtml).join('');
        box.querySelectorAll('.cal-item').forEach(el =>
            el.addEventListener('click', () => {
                if (typeof window.openWatchWithSearch === 'function') {
                    window.openWatchWithSearch('watch-anime', el.dataset.title);
                }
            }));
    }

    async function loadCalendar(force) {
        const box = document.getElementById('homeCalList');
        if (!box || (calState.data && !force)) return;
        try {
            const res = await fetch(`/api/acg/calendar${force ? '?force=1' : ''}`);
            const data = await res.json();
            if (data.code !== 0) {
                box.innerHTML = '<div class="rank-error">放送时间表加载失败：' + esc(data.msg || '') + '</div>';
                return;
            }
            calState.data = data.data;
            calState.day = 0;
            const srcEl = document.getElementById('homeCalSource');
            if (srcEl) srcEl.textContent = data.data.source === 'cycanime' ? '· 次元城动画'
                : data.data.source === 'anilist'
                ? ('· AniList' + (data.data.zh ? ' + Bangumi中文名' : ''))
                : '· Bangumi';
            renderCalTabs();
            renderCalList();
        } catch (e) {
            box.innerHTML = '<div class="rank-error">网络错误</div>';
        }
    }

    // 绑定输入框事件（在 DOMContentLoaded 后由 app.js 调用 bindHome）
    /* v3.0-c：首页聊天框与 AI 抽屉共用同一永久会话 —— 进入首页时恢复最近几条，
       与 AI 抽屉里看到的上下文一致。只补空状态，不打断已在进行的对话。 */
    let homeChatRestored = false;
    async function restoreHomeChat() {
        if (homeChatRestored) return;
        homeChatRestored = true;
        try {
            const r = await (await fetch('/api/ai/history?sessionId=main&limit=6')).json();
            if (r.code !== 0) return;
            const msgs = r.data.messages || [];
            if (!msgs.length) return;
            const box = document.getElementById('homeChatMessages');
            if (!box || box.querySelector('.home-msg')) return;   // 已经聊上了就不动
            for (const m of msgs) {
                const text = esc(m.content || '').replace(/\[\[(\d+)\|([^\]]+)\]\]/g, (mm, id, title) =>
                    `<span class="ai-movie-ref" data-movie-id="${id}" onclick="window.jumpToMovieFromAI && window.jumpToMovieFromAI(${id})">📎 ${esc(title)}</span>`);
                addMsg(m.role === 'assistant' ? 'ai' : 'user', text);
            }
        } catch (e) { /* 记忆引擎未就绪时保持空态 */ }
    }

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
        restoreHomeChat();
        document.querySelectorAll('.home-rank-tab[data-src]').forEach(t =>
            t.addEventListener('click', () => switchRankSource(t.dataset.src)));
        document.querySelectorAll('.home-rank-tab[data-lib]').forEach(t =>
            t.addEventListener('click', () => switchLibRank(t.dataset.lib)));
        const rf = document.getElementById('homeRankRefresh');
        if (rf) rf.addEventListener('click', refreshRank);
        // round36：本周放送刷新
        const crf = document.getElementById('homeCalRefresh');
        if (crf) crf.addEventListener('click', () => loadCalendar(true));
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

    window.Home = { showHome, hideHome, showAcgBoard, hideAcgBoard, bindHome, openAcgDetail, closeAcgDetail, switchAcgPeriod, switchAcgCat, switchSubTab };
})();
