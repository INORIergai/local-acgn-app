/* ============================================================
   features.js — 扩展功能模块
   播放进度（续播/齿孔进度条）· 女优标签档案页眉 ·
   刮削失败面板（一键重刮）· 年度观影报告
   依赖 app.js 的全局：showNotification / formatDuration / getPosterUrl /
   updateToolbarTitle / escapeHtml / showMovieDetail / switchView
   ============================================================ */
(function () {
    'use strict';

    const $ = (sel) => document.querySelector(sel);

    // ================= 播放进度 =================
    // movieId -> 已观看百分比（卡片齿孔进度条数据源）
    window.progressMap = {};

    async function loadProgressMap() {
        try {
            const res = await fetch('/api/movie/progress-map');
            const data = await res.json();
            if (data.code === 0) {
                window.progressMap = data.data || {};
                // 已渲染的列表补画进度条
                document.querySelectorAll('.movie-card[data-id]').forEach(card => {
                    const pct = window.progressMap[card.dataset.id];
                    if (pct > 0 && !card.querySelector('.card-progress')) {
                        const bar = document.createElement('div');
                        bar.className = 'card-progress';
                        bar.style.setProperty('--p', pct + '%');
                        card.appendChild(bar);
                    }
                });
            }
        } catch (e) { /* 静默 */ }
    }

    async function saveProgress(movieId, position, duration) {
        try {
            const res = await fetch(`/api/movie/progress/${movieId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ position, duration })
            });
            const data = await res.json();
            if (data.data && data.data.completed) {
                delete window.progressMap[movieId];
            } else if (duration > 0) {
                window.progressMap[movieId] = Math.min(100, Math.round(position / duration * 100));
            }
        } catch (e) { /* 静默 */ }
    }

    async function resumeProgress(video, movieId) {
        try {
            const res = await fetch(`/api/movie/progress/${movieId}`);
            const data = await res.json();
            if (data.code === 0 && data.data && data.data.position > 30) {
                const apply = () => {
                    if (data.data.duration > 0 && video.duration > 0 &&
                        Math.abs(data.data.duration - video.duration) / video.duration > 0.2) {
                        return; // 影片时长对不上（换源等），不跳
                    }
                    video.currentTime = data.data.position;
                    showNotification('继续播放', `已从 ${formatTime(data.data.position)} 处继续`);
                };
                if (video.readyState >= 1) apply();
                else video.addEventListener('loadedmetadata', apply, { once: true });
            }
        } catch (e) { /* 静默 */ }
    }

    // ================= 女优 / 标签档案页眉 =================
    function renderProfile(kind, name, movies, actressInfo) {
        const strip = $('#profileStrip');
        if (!strip) return;
        const list = movies || [];
        const total = list.length;
        const watched = list.filter(m => m.watched === 1).length;
        const fav = list.filter(m => m.favorite === 1).length;
        const totalMin = Math.round(list.reduce((s, m) => s + (m.duration || 0), 0) / 60);
        const playCount = list.reduce((s, m) => s + (m.playCount || 0), 0);
        const years = list.map(m => (m.releaseDate || '').substring(0, 4)).filter(y => /^\d{4}$/.test(y));
        const yearRange = years.length ? `${Math.min(...years)} – ${Math.max(...years)}` : '—';
        const watchPct = total ? Math.round(watched / total * 100) : 0;

        // 演员档案：头像 + 生日/身高/三围（刮削获得，没刮到就整块不显示）
        const info = actressInfo || {};
        const bioItems = kind === 'actress' ? [
            info.birthday ? { k: '生日', v: info.birthday } : null,
            info.height ? { k: '身高', v: info.height + 'cm' } : null,
            (info.bust || info.waist || info.hip) ? { k: '三围', v: [info.bust, info.waist, info.hip].filter(Boolean).join(' / ') } : null,
            info.cup ? { k: '罩杯', v: info.cup } : null,
            info.hobby ? { k: '爱好', v: info.hobby } : null,
        ].filter(Boolean) : [];

        const avatarHtml = (kind === 'actress' && info.avatar)
            ? `<div class="profile-avatar has-img"><img src="${info.avatar}" alt="${escapeHtml(name)}"
                   onerror="this.remove();this.parentElement.classList.remove('has-img')"></div>`
            : `<div class="profile-avatar">${name ? name.charAt(0) : '?'}</div>`;

        strip.innerHTML = `
            <div class="profile-head">
                ${avatarHtml}
                <div class="profile-meta">
                    <div class="profile-name">${escapeHtml(name)} <span style="font-size:12px;color:var(--text-muted);letter-spacing:.1em;">/ ${kind === 'actress' ? '演员档案' : '标签档案'}</span></div>
                    ${bioItems.length ? `
                    <div class="profile-bio">
                        ${bioItems.map(b => `<span class="profile-bio-item"><i>${b.k}</i>${escapeHtml(String(b.v))}</span>`).join('')}
                    </div>` : ''}
                    <div class="profile-stats">
                        <div class="profile-stat"><div class="n">${total}</div><div class="l">藏品</div></div>
                        <div class="profile-stat"><div class="n">${watchPct}%</div><div class="l">已看 ${watched}</div></div>
                        <div class="profile-stat"><div class="n">${formatDuration(totalMin * 60)}</div><div class="l">总时长</div></div>
                        <div class="profile-stat"><div class="n">${playCount}</div><div class="l">累计播放</div></div>
                        <div class="profile-stat"><div class="n">${fav}</div><div class="l">收藏</div></div>
                        <div class="profile-stat"><div class="n">${yearRange}</div><div class="l">年代跨度</div></div>
                    </div>
                </div>
            </div>
        `;
        strip.style.display = 'block';
    }

    // ================= 刮削失败面板 =================
    async function showFailures() {
        const view = $('#featureView');
        view.style.display = 'block';
        view.innerHTML = `<div class="panel-section"><div class="lan-loading">正在读取失败记录…</div></div>`;

        let failures = [];
        try {
            const res = await fetch('/api/scanner/failures');
            const data = await res.json();
            failures = data.data || [];
        } catch (e) { }

        updateFailureCount(failures.length);

        const rows = failures.map(f => `
            <div class="fail-row">
                ${f.localPosterPath || f.posterPath
                ? `<img class="fail-poster" src="${getPosterUrl(f)}" alt="">`
                : `<div class="fail-glyph">🎞️</div>`}
                <div class="fail-main">
                    <div class="fail-title">${escapeHtml(f.title || f.fileName || f.filePath)}</div>
                    <div class="fail-reason" title="${escapeHtml(f.reason || '')}">${escapeHtml(f.reason || '未知原因')} · 重试 ${f.retryCount || 0} 次</div>
                </div>
                <span class="fail-time">${formatDateLabel(new Date(f.failedAt).toISOString().substring(0, 10))}</span>
            </div>
        `).join('');

        view.innerHTML = `
            <div class="panel-section">
                <div class="panel-head">
                    <div class="toolbar-title" style="border:none;margin:0;padding:0;">⚠️ 刮削失败清单
                        <span class="toolbar-count">共 ${failures.length} 条</span>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-secondary btn-sm" id="failRefreshBtn">刷新</button>
                        <button class="btn btn-sm" id="failRescrapeBtn" ${failures.length === 0 ? 'disabled' : ''}>🔄 一键重刮失败项</button>
                    </div>
                </div>
                ${failures.length === 0
                ? `<div class="empty-state"><div class="icon">✨</div><div>没有刮削失败的影片，一切正常</div></div>`
                : rows}
                <div id="rescrapeStatus" style="margin-top:14px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);"></div>
            </div>
        `;

        $('#failRefreshBtn').addEventListener('click', showFailures);
        $('#failRescrapeBtn').addEventListener('click', startRescrape);
    }

    async function startRescrape() {
        try {
            const res = await fetch('/api/scanner/rescrape-failed', { method: 'POST' });
            const data = await res.json();
            if (data.code !== 0) {
                showNotification('无法开始', data.msg);
                return;
            }
            showNotification('一键重刮', '已开始逐条重试失败的刮削任务');
            pollRescrape();
        } catch (e) {
            showNotification('操作失败', e.message);
        }
    }

    function pollRescrape() {
        const timer = setInterval(async () => {
            try {
                const res = await fetch('/api/scanner/rescrape-failed/status');
                const data = await res.json();
                const st = data.data || {};
                const el = $('#rescrapeStatus');
                if (!el) { clearInterval(timer); return; }
                if (st.running) {
                    el.textContent = `重刮中 ${st.current}/${st.total} · ${st.currentFile || ''} · 成功 ${st.success} · 仍失败 ${st.stillFailed}`;
                } else {
                    clearInterval(timer);
                    el.textContent = `重刮完成：成功 ${st.success}，仍失败 ${st.stillFailed}`;
                    showNotification('重刮完成', `成功 ${st.success} 条，仍失败 ${st.stillFailed} 条`);
                    showFailures();
                }
            } catch (e) {
                clearInterval(timer);
            }
        }, 1500);
    }

    async function loadFailureCount() {
        try {
            const res = await fetch('/api/scanner/failures');
            const data = await res.json();
            updateFailureCount((data.data || []).length);
        } catch (e) { }
    }

    function updateFailureCount(n) {
        const el = $('#countFailures');
        if (el) el.textContent = n > 0 ? String(n) : '0';
    }

    // ================= 年度观影报告 =================
    let annualYear = new Date().getFullYear();

    /* ---------- 2026-09-22 年度报告高级可视化 ----------
       ① 月度分布：平滑面积图（折线入场描一次线，圆点 hover 出 tooltip）
       ② 年度标签：气泡图（圆面积 ∝ 次数，贪心换行排布，纯 SVG 一次性渲染，无循环）
       ③ 年度演员：名次行 + 数值比例条背景 */
    const AN_CANDY = ['#fbb663', '#f49978', '#ffdbfd', '#DDFCFC', '#CAF7C8', '#c2b4eb', '#997ade', '#FAED8F', '#feb6fa', '#00ecef'];

    function annualAreaChart(monthMap) {
        const values = Array.from({ length: 12 }, (_, i) => monthMap[String(i + 1).padStart(2, '0')] || 0);
        const max = Math.max(1, ...values);
        const W = 560, H = 176, pl = 14, pr = 14, pt = 18, pb = 30;
        const iw = W - pl - pr, ih = H - pt - pb;
        const pts = values.map((v, i) => [pl + i * iw / 11, pt + ih - (v / max) * ih]);
        const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
        const area = line + ` L ${(pl + iw).toFixed(1)} ${(pt + ih).toFixed(1)} L ${pl} ${(pt + ih).toFixed(1)} Z`;
        return `<svg class="an-area" viewBox="0 0 ${W} ${H}">
            <defs><linearGradient id="anGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#fbb663" stop-opacity=".5"/>
                <stop offset="1" stop-color="#fbb663" stop-opacity="0"/>
            </linearGradient></defs>
            <path class="an-area-fill" d="${area}" fill="url(#anGrad)"/>
            <path class="an-area-line" d="${line}" pathLength="1"/>
            ${pts.map((p, i) => `<g class="an-dot" transform="translate(${p[0].toFixed(1)},${p[1].toFixed(1)})">
                <circle r="9" fill="transparent"/><circle class="an-dot-c" r="3.5"/>
                <title>${i + 1} 月：${values[i]} 次</title></g>`).join('')}
            ${pts.map((p, i) => `<text class="an-m" x="${p[0].toFixed(1)}" y="${H - 8}">${String(i + 1).padStart(2, '0')}</text>`).join('')}
        </svg>`;
    }

    function annualBubbles(items) {
        const arr = (items || []).slice(0, 12);
        if (!arr.length) return '<div class="cp-empty" style="padding:16px;">暂无记录</div>';
        const max = Math.max(1, ...arr.map(r => r.playCount || 0));
        const nodes = arr.map((r, i) => ({
            name: r.name || '—',
            v: r.playCount || 0,
            r: 17 + Math.sqrt((r.playCount || 0) / max) * 33,
            c: AN_CANDY[i % AN_CANDY.length]
        }));
        const W = 560;
        let x = 8, y = 0, rowH = 0;
        nodes.forEach(n => {
            if (x + n.r * 2 > W) { x = 8; y += rowH + 10; rowH = 0; }
            n.cx = x + n.r; n.cy = y + n.r + 30;
            x += n.r * 2 + 10;
            rowH = Math.max(rowH, n.r * 2);
        });
        const H = y + rowH + 46;
        return `<svg class="an-bubbles" viewBox="0 0 ${W} ${H}">` + nodes.map(n => {
            const short = n.name.length > 6 ? n.name.slice(0, 6) + '…' : n.name;
            return `<g class="an-bub" transform="translate(${n.cx.toFixed(1)},${n.cy.toFixed(1)})">
                <title>${escapeHtml(n.name)}：${n.v} 次</title>
                <circle r="${n.r.toFixed(1)}" fill="${n.c}" opacity=".92"/>
                <text class="an-bub-v" y="-1">${n.v}</text>
                <text class="an-bub-n" y="13">${escapeHtml(short)}</text>
            </g>`;
        }).join('') + '</svg>';
    }

    function annualRankBars(arr) {
        const list = (arr || []).slice(0, 10);
        if (!list.length) return '<div class="cp-empty" style="padding:16px;">暂无记录</div>';
        const max = Math.max(1, ...list.map(r => r.playCount || 0));
        return list.map((r, i) => `
            <div class="an-rank">
                <i class="an-rank-bar" style="width:${Math.max(3, Math.round((r.playCount || 0) / max * 100))}%;--dc:${AN_CANDY[i % AN_CANDY.length]}"></i>
                <span class="idx">${String(i + 1).padStart(2, '0')}</span>
                <span class="name">${escapeHtml(r.name || '—')}</span>
                <span class="val">${r.playCount || 0} 次</span>
            </div>`).join('');
    }

    async function showAnnual(year) {
        if (year) annualYear = year;
        const view = $('#featureView');
        view.style.display = 'block';
        view.innerHTML = `<div class="panel-section"><div class="lan-loading">正在汇总 ${annualYear} 年的观影记录…</div></div>`;

        let d;
        try {
            const res = await fetch(`/api/stats/annual?year=${annualYear}`);
            const json = await res.json();
            d = json.data;
        } catch (e) { }

        if (!d) { view.innerHTML = '<div class="panel-section"><div class="empty-state">数据加载失败</div></div>'; return; }

        const plays = d.watchSummary || {};
        const totalMin = Math.round(plays.totalMinutes || 0);
        const hours = Math.round(totalMin / 60);
        const years = (d.availableYears && d.availableYears.length) ? d.availableYears : [annualYear];

        // 月度播放分布：平滑面积图（SVG，入场描线一次；2026-09-22 换掉裸柱状图）
        const monthMap = {};
        (d.playsByMonth || []).forEach(r => { monthMap[r.month] = r.plays; });
        const chart = annualAreaChart(monthMap);

        // 年度标签：气泡图（圆面积 ∝ 次数）
        const tagBubbles = annualBubbles(d.topTags);

        // 年度演员：名次行 + 背景比例条
        const actressRows = annualRankBars(d.topActresses);

        const topMovies = (d.topMovies || []).map((r, i) => `
            <div class="annual-rank">
                <span class="idx">${String(i + 1).padStart(2, '0')}</span>
                ${getPosterUrl(r) ? `<img class="annual-rank-poster" src="${getPosterUrl(r)}" data-id="${r.id}" alt="">` : ''}
                <span class="name">${escapeHtml(r.title || r.avid || '—')}</span>
                <span class="val">${r.playCount} 次</span>
            </div>`).join('') || '<div class="cp-empty" style="padding:16px;">今年还没有播放记录</div>';

        const reading = (d.readingSummary || []);
        const comicMin = Math.round((reading.find(r => r.type === 'comic') || {}).totalMinutes || 0);
        const novelMin = Math.round((reading.find(r => r.type === 'novel') || {}).totalMinutes || 0);

        const addedByType = {};
        (d.addedByType || []).forEach(r => { addedByType[r.type || 'jav'] = r.count; });

        view.innerHTML = `
            <div class="panel-section">
                <div class="panel-head">
                    <div class="toolbar-title" style="border:none;margin:0;padding:0;">📈 ${annualYear} 年度观影报告</div>
                    <select class="select-input" id="annualYearSelect" style="width:auto;">
                        ${years.map(y => `<option value="${y}" ${y === annualYear ? 'selected' : ''}>${y} 年</option>`).join('')}
                    </select>
                </div>

                <div class="annual-hero">
                    <div class="annual-card"><div class="num">${plays.totalPlays || 0}</div><div class="label">播放次数</div></div>
                    <div class="annual-card"><div class="num">${plays.uniqueMovies || 0}</div><div class="label">看过不同影片</div></div>
                    <div class="annual-card"><div class="num">${hours}h</div><div class="label">观影总时长</div></div>
                    <div class="annual-card"><div class="num">${comicMin >= 60 ? Math.floor(comicMin / 60) + 'h' + (comicMin % 60) : comicMin + 'm'}</div><div class="label">漫画阅读</div></div>
                    <div class="annual-card"><div class="num">${novelMin >= 60 ? Math.floor(novelMin / 60) + 'h' + (novelMin % 60) : novelMin + 'm'}</div><div class="label">小说阅读</div></div>
                    <div class="annual-card"><div class="num">${Object.values(addedByType).reduce((a, b) => a + b, 0)}</div><div class="label">新入库</div></div>
                </div>

                <div class="annual-grid">
                    <div class="annual-block">
                        <h4>每月播放分布</h4>
                        <div class="annual-chart">${chart}</div>
                    </div>
                    <div class="annual-block">
                        <h4>最常重看</h4>
                        ${topMovies}
                    </div>
                    <div class="annual-block">
                        <h4>年度演员</h4>
                        ${actressRows}
                    </div>
                    <div class="annual-block">
                        <h4>年度标签</h4>
                        ${tagBubbles}
                    </div>
                </div>
            </div>
        `;

        $('#annualYearSelect').addEventListener('change', (e) => showAnnual(parseInt(e.target.value)));
        view.querySelectorAll('.annual-rank-poster').forEach(img => {
            img.addEventListener('click', () => showMovieDetail(parseInt(img.dataset.id)));
        });
    }

    // ================= 逐个修正封面（手动选健康海报） =================
    window.posterFixActive = false;
    window.posterFixQueue = [];
    window.posterFixIndex = 0;
    let posterFixTitles = [];

    function startPosterFix(ids, titles) {
        window.posterFixQueue = ids || [];
        posterFixTitles = titles || [];
        window.posterFixIndex = 0;
        window.posterFixActive = window.posterFixQueue.length > 0;
        if (window.posterFixActive) posterFixNext();
    }

    function posterFixNext() {
        if (window.posterFixIndex >= window.posterFixQueue.length) {
            window.posterFixActive = false;
            const bar = $('#posterFixBar');
            if (bar) bar.style.display = 'none';
            showNotification('封面修正完成', `已处理 ${window.posterFixQueue.length} 部影片`);
            showPosterHealth();
            return;
        }
        const id = window.posterFixQueue[window.posterFixIndex];
        updatePosterFixBar();
        if (typeof showChangePosterModal === 'function') {
            showChangePosterModal(id);
        }
    }

    function updatePosterFixBar() {
        const bar = $('#posterFixBar');
        const info = $('#posterFixInfo');
        if (!bar || !info) return;
        bar.style.display = 'block';
        const i = window.posterFixIndex;
        const title = posterFixTitles[i] || '';
        info.textContent = `正在修正 ${i + 1} / ${window.posterFixQueue.length}${title ? '：「' + title + '」' : ''} —— 点下方任意一张健康海报，或「跳过」`;
    }

    // 换成功后由 app.js changePoster 调用（success=true 时进下一部）
    function posterFixAdvance(success) {
        window.posterFixIndex++;
        window.posterFixActive = window.posterFixIndex < window.posterFixQueue.length;
        if (window.posterFixActive) {
            // 先关掉当前弹窗，再开下一部
            if (typeof closePosterModal === 'function') closePosterModal();
            setTimeout(() => posterFixNext(), 150);
        } else {
            if (typeof closePosterModal === 'function') closePosterModal();
            const bar = $('#posterFixBar');
            if (bar) bar.style.display = 'none';
            showNotification('封面修正完成', `已处理 ${window.posterFixQueue.length} 部影片`);
            showPosterHealth();
        }
    }

    function posterFixSkip() {
        posterFixAdvance(false);
    }

    function posterFixDone() {
        window.posterFixActive = false;
        window.posterFixQueue = [];
        if (typeof closePosterModal === 'function') closePosterModal();
        const bar = $('#posterFixBar');
        if (bar) bar.style.display = 'none';
        showNotification('已停止修正');
        showPosterHealth();
    }

    window.posterFixAdvance = posterFixAdvance;
    window.posterFixSkip = posterFixSkip;
    window.posterFixDone = posterFixDone;
    window.startPosterFix = startPosterFix;

    // ================= 海报健康 =================
    async function showPosterHealth() {
        const view = $('#featureView');
        view.style.display = 'block';
        view.innerHTML = `<div class="panel-section"><div class="lan-loading">正在扫描海报…</div></div>`;

        let d;
        try {
            const res = await fetch('/api/movie/poster-health');
            const json = await res.json();
            d = json.data;
        } catch (e) { }

        if (!d) { view.innerHTML = '<div class="panel-section"><div class="empty-state">数据加载失败</div></div>'; return; }

        updatePosterHealthCount(d.missingCount + d.dupGroupsCount);

        // 收集待修正影片（缺封面优先，再到重复分组，去重）
        const fixIds = [];
        const fixTitles = [];
        const seen = new Set();
        const pushFix = (id, title) => {
            if (!id || seen.has(id)) return;
            seen.add(id);
            fixIds.push(id);
            fixTitles.push((title || '').slice(0, 40));
        };
        (d.missing || []).forEach(m => pushFix(m.id, m.title || m.fileName));
        (d.duplicateGroups || []).forEach(g => {
            (g.movies || []).forEach(m => pushFix(m.id, m.title || m.fileName));
        });

        const missingRows = (d.missing || []).map(m => `
            <div class="fail-row">
                <div class="fail-glyph">🖼️</div>
                <div class="fail-main">
                    <div class="fail-title">${escapeHtml(m.title || m.fileName)}</div>
                    <div class="fail-reason">缺少封面 · ${escapeHtml((m.type || '').toUpperCase())}</div>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="showChangePosterModal(${m.id})">🖼️ 选封面</button>
                <button class="btn btn-secondary btn-sm" onclick="rescrapeMovie(${m.id})">🔄 重刮</button>
            </div>`).join('');

        const dupBlocks = (d.duplicateGroups || []).map(g => `
            <div class="annual-block" style="margin-bottom:10px;padding:12px 16px;">
                <h4 style="margin-bottom:8px;">${g.count} 部影片共用同一张封面</h4>
                ${g.movies.map(m => `
                    <div class="annual-rank">
                        <span class="name">${escapeHtml(m.title || m.fileName)}</span>
                        <button class="btn btn-secondary btn-sm" onclick="showChangePosterModal(${m.id})">🖼️ 选封面</button>
                        <button class="btn btn-secondary btn-sm" onclick="rescrapeMovie(${m.id})">🔄 重刮</button>
                    </div>`).join('')}
            </div>`).join('');

        view.innerHTML = `
            <div class="panel-section">
                <div class="panel-head">
                    <div class="toolbar-title" style="border:none;margin:0;padding:0;">🖼️ 海报健康
                        <span class="toolbar-count">缺封面 ${d.missingCount} · 重复分组 ${d.dupGroupsCount}</span>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-sm" id="posterFixStart" ${fixIds.length ? '' : 'disabled'}>🖼️ 逐个修正封面（${fixIds.length}）</button>
                        <button class="btn btn-secondary btn-sm" id="posterHealthRefresh">刷新</button>
                    </div>
                </div>

                ${d.missingCount > 0 ? `
                <div class="annual-block" style="margin-bottom:14px;">
                    <h4>🈳 缺少封面（${d.missingCount} 部）</h4>
                    ${missingRows}
                </div>` : ''}

                ${d.dupGroupsCount > 0 ? `
                <div style="margin-top:6px;">
                    <div class="annual-block" style="margin-bottom:12px;">
                        <h4>🔁 多部共用同一张封面（${d.dupGroupsCount} 组）</h4>
                        <p style="font-size:12px;color:var(--text-muted);margin:4px 0 10px;">同一系列可能共用系列封面；点「选封面」可手动挑健康的海报，或点「逐个修正封面」挨个确认。</p>
                        ${dupBlocks}
                    </div>
                </div>` : ''}

                ${d.missingCount === 0 && d.dupGroupsCount === 0 ? `
                <div class="empty-state"><div class="icon">✅</div><div>所有影片封面正常</div></div>` : ''}
            </div>
        `;

        $('#posterHealthRefresh').addEventListener('click', showPosterHealth);
        $('#posterFixStart')?.addEventListener('click', () => startPosterFix(fixIds, fixTitles));
    }

    async function updatePosterHealthCount(n) {
        const el = $('#countPosterHealth');
        if (el) el.textContent = n > 0 ? String(n) : '0';
    }

    // ================= 在线观看（多标签；切标签不丢网页状态） =================
    // 站点页要铺满内容区；能不能内嵌由服务端探测（浏览器读不到跨域 XFO），三种结果：
    //   true    → 直接 iframe
    //   false   → 站点禁止内嵌（XFO/CSP/CF）→ 有列表抓取能力的站点改用「应用内列表」，否则给解释卡
    //   unknown → 探测自己失败（网络抖动），照样放 iframe，别诬赖站点
    // **核心：每个站点是一个常驻 .watch-pane，切标签只切 display，绝不重建 DOM 或重设 iframe.src**，
    // 否则网页里的搜索结果/滚动位置/播放状态每次都被清空（用户明确要求保留操作记录）。
    // 站点只列 key/name —— 实际用哪个地址（官方还是镜像）由服务端逐级探测决定，见 /api/webview/site
    // caps 是站点能力档案（服务端 /api/webview/sites 下发）：
    //   canProxy  —— 支持整站反代，能真正在应用内完整使用（登录/翻页/播放全在站内）
    //   canSearch —— 支持应用内搜索
    //   categories—— 预设分类快捷入口
    // 开标签前先拉一次，决定进「整站模式」还是「列表模式」，避免先白屏再切换。
    // ★ 四板块（第 16 轮）：board 决定站点归属哪个入口。用户要求「功能和设计都一样」，
    //   所以四个板块共用这一套 macOS 窗口 + 同一份 openWatchTab/loadWatchPane 逻辑，
    //   唯一区别就是站点栏里显示哪几个站点、以及标签栏显示哪个板块的标签。
    //   board 值会和 /api/webview/sites 下发的合并（服务端为准）。
    let WATCH_SITES = [
        { key: 'javbus', name: 'JavBus', board: 'av' },
        { key: 'jable', name: 'Jable', board: 'av' },
        { key: 'javmenu', name: 'JavMenu', board: 'av' },
        { key: 'netflav', name: 'Netflav', board: 'av' },
        { key: 'onejav', name: 'OneJAV', board: 'av' },
        { key: 'porndude', name: 'ThePornDude', board: 'av' },
        { key: 'dongman', name: '91动漫', board: 'hanime' },
        { key: 'hanime1', name: 'Hanime1', board: 'hanime' },
        { key: 'hanimetv', name: 'Hanime.tv', board: 'hanime' },
        { key: 'cycanime', name: '次元城动画', board: 'anime' },
        { key: 'moxmoe', name: 'Kmoe漫画', board: 'comic' },
        { key: 'komiic', name: 'Komiic', board: 'comic' },
        { key: 'manhuagui', name: '漫画柜', board: 'comic' },
        { key: 'wenku8', name: '轻小说文库', board: 'comic' }
    ];
    // 入口 view 名 -> 板块
    const BOARD_OF_VIEW = {
        watch: 'av',
        'watch-anime': 'anime',
        'watch-comic': 'comic',
        'watch-hanime': 'hanime'
    };
    // 各板块的标题（窗口标题条 / 空状态文案用）
    const BOARD_TITLE = {
        av: 'AV在线观看',
        anime: '动漫在线观看',
        comic: '漫画在线观看',
        hanime: '里番在线观看'
    };
    // 当前板块 + 每个板块各自记住的活跃标签（切板块回来还在原来那页）
    // 默认站挑选原则：**优先能直接内嵌/反代的**，别一进来就是「列表模式」或「被阻断」。
    //   里番板块不用 hanime1 打头：它是 Cloudflare 挑战站（403），只能退化成应用内列表；
    //   91动漫 实测可内嵌且列表齐全，作为开场更合适。
    const BOARD_DEFAULT_SITE = { av: 'javbus', anime: 'cycanime', comic: 'moxmoe', hanime: 'dongman' };
    let watchBoard = 'av';
    const activeByBoard = {};

    // 服务端下发的站点档案：key -> { canProxy, canSearch, categories, canList }
    let SITE_CAPS = {};
    let capsLoaded = null;

    async function loadCaps() {
        if (capsLoaded) return capsLoaded;
        capsLoaded = (async () => {
            try {
                const r = await (await fetch('/api/webview/sites')).json();
                if (r.code === 0) {
                    (r.data || []).forEach((s) => { SITE_CAPS[s.key] = s; });
                    // 以服务端名字为准，前端这份只提供顺序
                    WATCH_SITES = WATCH_SITES.map((s) => ({ ...s, ...(SITE_CAPS[s.key] || {}) }));
                }
            } catch (e) { /* 用默认值，退化成列表模式 */ }
            return SITE_CAPS;
        })();
        return capsLoaded;
    }

    let watchTabs = [];      // 常驻标签：[{ key, name, pane }]
    let watchActive = '';
    // 刚开出来的标签：用集合记 400ms，保证期间任何一次重渲染都还带着入场动画类，
    // 否则首个标签加载完触发的那次重渲染会把动画掐掉（只播了几十毫秒，看不出来）
    const freshTabs = new Set();

    /** 让嵌入区撑满「标签条以下到窗口底部」的剩余高度 */
    function fitWatch() {
        const stage = $('#watchStage');
        if (!stage) return;
        const top = stage.getBoundingClientRect().top;
        stage.style.height = Math.max(360, window.innerHeight - top - 14) + 'px';
    }

    /** 窗口标题 / 站点栏高亮：跟着当前标签走 */
    function syncWatchChrome() {
        const t = watchTabs.find((x) => x.key === watchActive);
        const title = $('#watchTitle');
        if (title) {
            title.innerHTML = t
                ? `<b>${escapeHtml(t.name)}</b>${t.addr ? ' · ' + escapeHtml(String(t.addr).replace(/^https?:\/\//, '').replace(/\/$/, '')) : ''}`
                : `${BOARD_TITLE[watchBoard] || '在线观看'} · 点下面任一站点开新标签`;
        }
        document.querySelectorAll('[data-open]').forEach((b) => {
            b.classList.toggle('is-open', watchTabs.some((x) => x.key === b.dataset.open));
        });
    }

    function renderWatchTabs() {
        const strip = $('#watchTabs');
        if (!strip) return;
        // ★ 只渲染当前板块的标签：四个板块各自一套标签栈，互不串台
        strip.innerHTML = watchTabs.filter((t) => (t.board || 'av') === watchBoard).map((t) => `
            <div class="watch-tab ${t.key === watchActive ? 'on' : ''}${freshTabs.has(t.key) ? ' is-new' : ''}"
                 data-tab="${t.key}" title="${escapeHtml(t.name)}">
                <span class="fav"></span>
                <span class="n">${escapeHtml(t.name)}</span>
                <span class="x" data-close="${t.key}" title="关闭标签">✕</span>
            </div>`).join('');
        strip.querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', (e) => {
            if (e.target.dataset.close) return;
            activateWatchTab(el.dataset.tab);
        }));
        strip.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', (e) => {
            e.stopPropagation();
            closeWatchTab(el.dataset.close);
        }));
        // 选中标签滚进可视区（只滚标签条自己，别动整页）
        const on = strip.querySelector('.watch-tab.on');
        if (on) {
            const l = on.offsetLeft, r = l + on.offsetWidth;
            if (l < strip.scrollLeft) strip.scrollTo({ left: Math.max(0, l - 6), behavior: 'smooth' });
            else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: r - strip.clientWidth + 6, behavior: 'smooth' });
        }
        syncWatchChrome();
    }

    function activateWatchTab(key) {
        const target = watchTabs.find((t) => t.key === key);
        if (!target) return;
        watchActive = key;
        activeByBoard[target.board || 'av'] = key;   // 记住这个板块停在哪个标签，切回来还在原地
        // 用 class 切 visibility（不是 display）——见 style.css 里的说明：display:none 会把状态清掉
        // 这里遍历的是**全部**标签：顺带把别的板块的 pane 也摘掉 .on，避免两个板块同时可见
        watchTabs.forEach((t) => t.pane.classList.toggle('on', t.key === key));
        renderWatchTabs();
        fitWatch();
    }

    function closeWatchTab(key) {
        const i = watchTabs.findIndex((t) => t.key === key);
        if (i < 0) return;
        const board = watchTabs[i].board || 'av';
        watchTabs[i].pane.remove();
        watchTabs.splice(i, 1);
        if (watchActive === key) {
            // 回退只在**同一板块**里找，别跳到别的板块去
            const same = watchTabs.filter((t) => (t.board || 'av') === board);
            if (same.length) activateWatchTab(same[same.length - 1].key);
            else { watchActive = ''; renderWatchTabs(); syncSiteBar(); }
        } else renderWatchTabs();
    }

    /** 站点栏：只画当前板块的站点（切板块只重画这一条，绝不重建外壳） */
    function renderSiteBar() {
        const bar = $('#watchToolbar');
        if (!bar) return;
        const list = WATCH_SITES.filter((s) => (s.board || 'av') === watchBoard);
        bar.innerHTML = list.map((s) => `<button class="watch-site" data-open="${s.key}">${s.name}</button>`).join('');
        bar.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openWatchTab(b.dataset.open)));
        syncWatchChrome();
    }

    /**
     * 「在线观看」四个板块共用这一个入口（设计与交互完全一致，只有站点集合不同）。
     * @param {string} viewName watch / watch-anime / watch-comic / watch-hanime
     */
    async function showWatch(viewName) {
        watchBoard = BOARD_OF_VIEW[viewName] || 'av';
        await loadCaps();          // 先拿到服务端下发的 board，再决定站点栏放什么
        const view = $('#featureView');
        view.style.display = 'block';

        // 外壳只搭一次：重建外壳会连带把已有 iframe 全杀掉
        if (!$('#watchStage')) {
            // ★ 走到这说明外壳是被重建的（切去别的视图再切回来）——旧 pane 已随上一次
            //   innerHTML 一起销毁，标签表必须清空，否则会留下「有标签没内容」的幽灵标签
            watchTabs.length = 0;
            watchActive = '';
            Object.keys(activeByBoard).forEach((k) => delete activeByBoard[k]);
            view.innerHTML = `
                <div class="panel-section watch-full">
                    <div class="watch-window" id="watchWindow">
                        <div class="watch-titlebar">
                            <div class="watch-lights">
                                <i class="l-r" id="wmRed" title="关闭当前标签"></i>
                                <i class="l-y" id="wmYellow" title="收起 / 展开站点栏"></i>
                                <i class="l-g" id="wmGreen" title="专注模式：只看网页"></i>
                            </div>
                            <div class="watch-title" id="watchTitle">在线观看 · 点下面任一站点开新标签</div>
                            <span class="sp"></span>
                            <button class="wm-tool" id="watchSwitchAddr" title="重新逐级探测该站的所有地址">🔁 换线路</button>
                        </div>
                        <div class="watch-tabstrip">
                            <div class="watch-tabs" id="watchTabs"></div>
                        </div>
                        <!-- 站点栏内容由 renderSiteBar() 按当前板块填充 -->
                        <div class="watch-toolbar" id="watchToolbar"></div>
                        <div class="watch-body" id="watchStage"></div>
                    </div>
                </div>`;
            view.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openWatchTab(b.dataset.open)));
            $('#watchSwitchAddr').addEventListener('click', async () => {
                const tab = watchTabs.find((t) => t.key === watchActive);
                const site = tab && WATCH_SITES.find((s) => s.key === tab.key);
                if (!tab || !site) return;
                showNotification('正在重新选线路', '逐级探测该站的所有地址');
                await loadWatchPane(tab, site, true);
                if (watchActive === tab.key) activateWatchTab(tab.key);
            });

            // 交通灯：Mac 上这三个点是「窗口控制」，这里给它们真实职能
            const win = $('#watchWindow');
            $('#wmRed').addEventListener('click', () => {
                if (watchActive) closeWatchTab(watchActive);
            });
            const toggleCompact = () => win.classList.toggle('is-compact');
            $('#wmYellow').addEventListener('click', toggleCompact);
            $('#wmGreen').addEventListener('click', () => {
                win.classList.remove('is-compact');
                win.classList.toggle('is-zen');
                fitWatch();
            });

            window.removeEventListener('resize', fitWatch);
            window.addEventListener('resize', fitWatch);
            fitWatch();
        }

        // 站点栏按当前板块重画；标签也按板块恢复（每个板块各记各的活跃标签）
        renderSiteBar();
        const mine = watchTabs.filter((t) => (t.board || 'av') === watchBoard);
        if (!mine.length) {
            // 这个板块还没开过标签 → 自动开一个默认站，别让用户面对空白
            const def = BOARD_DEFAULT_SITE[watchBoard]
                || (WATCH_SITES.find((s) => (s.board || 'av') === watchBoard) || {}).key;
            if (def) await openWatchTab(def);
        } else {
            activateWatchTab(activeByBoard[watchBoard] || mine[0].key);
        }
        fitWatch();
    }

    async function openWatchTab(key) {
        const site = WATCH_SITES.find((s) => s.key === key);
        if (!site) return;
        const open = watchTabs.find((t) => t.key === key);
        if (open) return activateWatchTab(key);          // 已经开过就只是切过去，不重新加载

        const pane = document.createElement('div');
        pane.className = 'watch-pane';
        pane.innerHTML = `<div class="lan-loading" style="padding:60px 0;text-align:center;">正在加载 ${site.name}…</div>`;
        $('#watchStage').appendChild(pane);
        const tab = { key, name: site.name, pane, board: site.board || watchBoard };
        watchTabs.push(tab);
        freshTabs.add(key);
        setTimeout(() => { freshTabs.delete(key); if (watchTabs.some((t) => t.key === key)) renderWatchTabs(); }, 380);
        activateWatchTab(key);
        await loadWatchPane(tab, site);
        // loadWatchPane 里的 fillPane* 会重置 pane.className（把 .on 冲掉），这里补点亮
        if (watchActive === tab.key) activateWatchTab(tab.key);
    }

    async function loadWatchPane(tab, site, force) {
        const pane = tab.pane;
        await loadCaps();                     // 拿站点能力档案（决定用哪种模式）

        let info = null;
        try {
            const r = await (await fetch(`/api/webview/site?key=${encodeURIComponent(site.key)}${force ? '&force=1' : ''}`)).json();
            if (r.code === 0) info = r.data;
            else { fillPaneBlocked(pane, { name: site.name, url: '' }, { reason: r.msg }); return; }
        } catch (e) {
            fillPaneBlocked(pane, { name: site.name, url: '' }, { reason: '接口异常：' + e.message });
            return;
        }

        tab.url = info.url;
        tab.addr = info.url;
        tab.info = info;

        const caps = SITE_CAPS[site.key] || {};

        // ① 支持整站反代 → 首选。这是唯一能「完美复现站点全部功能」的模式：
        //    页面、登录、翻页、搜索、播放器全部在我们自己的域下跑，不跳外链。
        if (caps.canProxy) {
            return fillPaneProxy(pane, site, tab, info);
        }

        // ② 站点禁止内嵌，但有列表抓取能力 → 退到「应用内列表」
        if (info.frameable === false) {
            if (info.canList) return fillPaneList(pane, site, tab);
            return fillPaneBlocked(pane, { name: sceneName(info), url: info.url }, info);
        }

        // ③ 本身可内嵌（如 91动漫）→ 直接 iframe
        fillPaneFrame(pane, info.url, info.unknown ? `探测失败（网络抖动），已直接尝试内嵌；当前线路 ${info.url}` : `线路 ${info.url}`);
    }

    function sceneName(info) { return info.name || ''; }

    function fillPaneFrame(pane, url, note) {
        pane.className = 'watch-pane';
        pane.innerHTML = `
            ${note ? `<div class="watch-note">${escapeHtml(note)}</div>` : ''}
            <iframe src="${url}" referrerpolicy="no-referrer" allowfullscreen
                    style="width:100%;height:100%;border:0;background:#fff;display:block;"></iframe>`;
        fitWatch();
    }

    /**
     * 整站反代模式：把站点整个搬到本应用的一个子路径下（/{key}/…），
     * 服务端剥掉 X-Frame-Options 并重写所有链接，所以这里就只是个普通 iframe。
     * 与 fillPaneFrame 的区别：src 指向本应用自己的路径（同源），因此
     *   - 站点 cookie 由服务端罐统一管理，浏览器侧看不到跨站 cookie
     *   - 站点 JS 发的 fetch/XHR 会被注入脚本拉回同源，不会跳出去
     *
     * 顶部那条工具条是「保险绳」：反代任何站点都可能碰上没覆盖到的路径形态，
     * 给用户一个「换线路 / 开外部窗口」的出口，不至于完全卡死。
     */
    function fillPaneProxy(pane, site, tab, info) {
        pane.className = 'watch-pane watch-proxied';
        // root 是「这个站挂在本应用下的路径前缀」；entry 是首页入口。
        // 有的站首页不在 /（porndude 中文首页在 /zh），服务端用 entryPath 声明，
        // 这里沿用，省得整站模式一进来落在英文页。
        const root = `/${site.key}`;
        const entry = root + (site.entryPath || '/');

        const bar = document.createElement('div');
        bar.className = 'watch-tool watch-tool--proxy';
        bar.innerHTML = `
            <span class="watch-badge" title="页面由本应用代理，所有功能都在应用内">🛰️ 整站模式</span>
            <span style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(info.url || '')}</span>
            <span style="flex:1"></span>
            <button class="btn btn-sm btn-secondary" data-px="reload">↻ 刷新</button>
            <button class="btn btn-sm btn-secondary" data-px="list" title="改用轻量列表模式（抓取更快）">☰ 列表模式</button>
            <button class="btn btn-sm btn-secondary" data-px="ext">🔗 外部窗口</button>`;

        const frame = document.createElement('iframe');
        frame.className = 'watch-frame';
        // allow 要给全：站点播放器常用全屏/画中画；sandbox 不加，加了会禁掉站点的弹窗与脚本
        frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
        frame.setAttribute('allowfullscreen', '');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.src = entry;

        pane.innerHTML = '';
        pane.appendChild(bar);
        pane.appendChild(frame);

        // 记录真实浏览地址：站点内部用 pushState 换页时 iframe 的 URL 会变，
        // 「换线路」重载要回到用户当前所在页，而不是永远回首页。
        tab.proxyPath = entry;
        try {
            frame.addEventListener('load', () => {
                try {
                    const p = frame.contentWindow.location.pathname;
                    if (p && p.startsWith(root)) tab.proxyPath = p + frame.contentWindow.location.search;
                } catch (e) { /* 同源读不到就保持原值 */ }
            });
        } catch (e) { /* 忽略 */ }

        bar.querySelectorAll('[data-px]').forEach((b) => b.addEventListener('click', async () => {
            const act = b.dataset.px;
            if (act === 'reload') {
                frame.src = tab.proxyPath || entry;
            } else if (act === 'list') {
                if (!(SITE_CAPS[site.key] || {}).canList) {
                    showNotification('该站没有列表模式', '这个站点只能以整站模式使用');
                    return;
                }
                fillPaneList(pane, site, tab);
            } else if (act === 'ext') {
                window.open(info.url, '_blank', 'noopener');
            }
        }));

        fitWatch();
    }

    function fillPaneBlocked(pane, site, probe) {
        pane.className = 'watch-pane watch-blocked';
        pane.innerHTML = `
            <div style="padding:56px 24px;text-align:center;max-width:640px;margin:0 auto;">
                <div style="font-size:44px;margin-bottom:14px;">🚫🖼️</div>
                <h3 style="margin-bottom:10px;">${site.name} 不能被内嵌</h3>
                <p style="color:var(--text-muted);font-size:13px;line-height:1.9;margin-bottom:18px;">
                    ${escapeHtml((probe && probe.reason) || '站点禁止被其它网站内嵌')}<br>
                    这是站点自己的声明（X-Frame-Options / CSP），任何网站都嵌不进来，不是本应用的限制。
                </p>
                ${site.url ? `<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
                    <button class="btn" onclick="window.open('${escapeHtml(site.url)}','_blank','noopener')">🔗 在浏览器新标签打开 ${escapeHtml(site.name)}</button>
                </div>` : ''}
            </div>`;
        fitWatch();
    }

    // 站点不让内嵌时，用容器里的浏览器把它的列表抓回来，渲染进这个标签自己的 pane。
    // 支持「搜索」「分类切换」「加载下一页」（jable 这类站点一页只有 24 条，用户反馈过要补全）。
    async function fillPaneList(pane, site, tab) {
        pane.className = 'watch-pane watch-scroll';

        // 站点能力已由 loadCaps() 预取并缓存，这里不再多打一次接口
        const c = SITE_CAPS[site.key] || {};
        const caps = { canSearch: !!c.canSearch, categories: c.categories || [] };

        // 工具条：搜索框（该站支持才画）+ 分类按钮；支持反代的站再给个回整站模式的入口
        const bar = document.createElement('div');
        bar.className = 'watch-tool';
        bar.innerHTML = `
            ${(c.canProxy) ? `<button class="btn btn-sm btn-secondary" data-pxback="1" title="回到完整网页（登录/翻页/播放全支持）">🛰️ 整站模式</button>` : ''}
            ${caps.canSearch ? `
            <div class="watch-search">
                <input type="search" id="wsq" placeholder="在 ${escapeHtml(site.name)} 搜索番号 / 关键字…" autocomplete="off">
                <button class="btn btn-sm" id="wsgo">搜索</button>
            </div>` : `<div class="watch-search"><span style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(site.name)} 不支持站内搜索</span></div>`}
            <div class="watch-cats">
                ${caps.categories.map((c) => `<button class="btn btn-sm btn-secondary" data-cat="${escapeHtml(c.path)}">${escapeHtml(c.name)}</button>`).join('')}
            </div>`;

        const grid = document.createElement('div');
        grid.className = 'watch-grid';
        const foot = document.createElement('div');
        foot.className = 'watch-more';

        const addCards = (items) => {
            items.forEach((it) => {
                const el = document.createElement('div');
                el.className = 'watch-card';
                el.dataset.play = it.href;
                el.innerHTML = `<img src="${escapeHtml(it.cover)}" loading="lazy" alt="">
                    <div class="t">${escapeHtml(it.title || '')}</div>
                    ${it.duration ? `<div class="d">${escapeHtml(it.duration)}</div>` : ''}`;
                el.addEventListener('click', () => playWebPage(el.dataset.play));
                grid.appendChild(el);
            });
        };

        let page = 0;
        let busy = false;
        let query = '';       // { q, path } 二选一，空串表示默认列表
        let mode = { type: 'list' };

        const load = async (p, nextMode) => {
            if (busy) return;
            busy = true;
            if (nextMode) mode = nextMode;
            if (p === 1) { grid.innerHTML = ''; }
            foot.textContent = `正在抓取第 ${p} 页…（约 15 秒）`;

            let url = `/api/webview/list?site=${encodeURIComponent(site.key)}&page=${p}`;
            if (mode.type === 'search') url += `&q=${encodeURIComponent(mode.q)}`;
            else if (mode.type === 'cat') url += `&path=${encodeURIComponent(mode.path)}`;

            let d = null;
            try { d = await (await fetch(url)).json(); } catch (e) { /* 下面报 */ }
            busy = false;

            if (!d || d.code !== 0) {
                foot.innerHTML = `<span style="color:var(--text-muted);font-size:12.5px;">抓取失败：${escapeHtml((d && d.msg) || '网络异常')}</span>`;
                return;
            }
            const items = (d.data && d.data.items) || [];
            addCards(items);
            page = p;
            if (!items.length) {
                foot.innerHTML = `<div style="color:var(--text-muted);font-size:12.5px;line-height:1.9;">
                    ${mode.type === 'search' ? `没搜到「${escapeHtml(mode.q)}」相关内容` : '这个站没抓到内容（结构变了或本来就没列表页）'}<br>
                    <button class="btn btn-sm" style="margin-top:8px;" onclick="window.open('${escapeHtml((d.data && d.data.addr) || site.url || 'about:blank')}','_blank','noopener')">🔗 在浏览器新标签打开 ${escapeHtml(site.name)}</button>
                </div>`;
                return;
            }
            foot.innerHTML = `<button class="btn btn-secondary btn-sm" id="watchMore">⬇ 加载下一页（第 ${p + 1} 页）</button>`;
            const b = foot.querySelector('#watchMore');
            if (b) b.addEventListener('click', () => load(page + 1));
        };

        pane.innerHTML = '';
        pane.appendChild(bar);
        pane.appendChild(grid);
        pane.appendChild(foot);

        // 搜索
        const doSearch = () => {
            const inp = bar.querySelector('#wsq');
            const v = (inp && inp.value || '').trim();
            if (!v) return;
            load(1, { type: 'search', q: v });
        };
        const sgo = bar.querySelector('#wsgo');
        if (sgo) sgo.addEventListener('click', doSearch);
        const sq = bar.querySelector('#wsq');
        if (sq) sq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

        // 分类切换（高亮当前项）
        bar.querySelectorAll('[data-cat]').forEach((btn) => {
            btn.addEventListener('click', () => {
                bar.querySelectorAll('[data-cat]').forEach((x) => x.classList.remove('on'));
                btn.classList.add('on');
                load(1, { type: 'cat', path: btn.dataset.cat });
            });
        });

        // 回整站模式：tab 上存着 info，直接复用（不重新探测，省一次往返）
        const back = bar.querySelector('[data-pxback]');
        if (back) back.addEventListener('click', () => fillPaneProxy(pane, site, tab, tab.info || {}));

        await load(1, { type: 'list' });
        fitWatch();
    }

    /** 解析该页的视频流，并交给应用自己的播放器播 */
    async function playWebPage(pageUrl) {
        if (!pageUrl) return;
        showNotification('正在解析视频流', '需要几秒，用容器里的浏览器嗅探 m3u8');
        try {
            const r = await (await fetch(`/api/webview/resolve?url=${encodeURIComponent(pageUrl)}`)).json();
            if (r.code !== 0) {
                showNotification('解析失败', r.msg || '未知错误');
                return;
            }
            showVideoPlayer(r.data.url, '', r.data.kind);
        } catch (e) {
            showNotification('解析失败', e.message);
        }
    }

    // ================= 导出 =================
    window.Features = {
        loadProgressMap,
        saveProgress,
        resumeProgress,
        renderProfile,
        showFailures,
        showAnnual,
        showPosterHealth,
        showWatch,
        playWebPage,
        loadFailureCount
    };
})();
