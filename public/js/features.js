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

    // ================= round34 批次B：分类切片器（⑨ 三视图共用） =================
    const R34_TYPES = [
        ['all', '全部'], ['jav', 'AV'], ['anime', '里番'], ['film', '影视'],
        ['cartoon', '动漫'], ['comic', '漫画'], ['novel', '轻小说']
    ];
    const r34Slice = { failures: 'all', poster: 'all', annual: 'all' };

    function r34SliceBar(kind, current) {
        return `<div class="r34-slice-bar" data-slice-kind="${kind}">
            ${R34_TYPES.map(([v, label]) =>
            `<button class="r34-slice-tab ${current === v ? 'active' : ''}" data-slice-type="${v}">${label}</button>`).join('')}
        </div>`;
    }
    function bindSliceBar(kind, onChange) {
        document.querySelectorAll(`.r34-slice-bar[data-slice-kind="${kind}"] .r34-slice-tab`).forEach(t => {
            t.addEventListener('click', () => {
                r34Slice[kind] = t.dataset.sliceType;
                document.querySelectorAll(`.r34-slice-bar[data-slice-kind="${kind}"] .r34-slice-tab`)
                    .forEach(x => x.classList.toggle('active', x.dataset.sliceType === r34Slice[kind]));
                onChange(r34Slice[kind]);
            });
        });
    }

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
        renderFailures(failures);
    }

    // round34 批次B：失败清单渲染拆出来 —— 切片切换只重渲染，不重新请求
    function renderFailures(failures) {
        const view = $('#featureView');
        if (!view) return;
        const cur = r34Slice.failures;
        // scrape_failures 自带 type 字段；老记录兜底用 JOIN 出的 movieType
        const filtered = cur === 'all' ? failures
            : failures.filter(f => (f.type || f.movieType || '') === cur);
        const sliced = filtered.length !== failures.length;

        const rows = filtered.map((f, i) => {
            const mid = f.movieId || '';
            return `
            <div class="fail-row is-clickable" data-fail-i="${failures.indexOf(f)}" data-movie-id="${mid}"
                 data-file-path="${escapeHtml(f.filePath || '')}" role="button" tabindex="0"
                 title="${mid ? '点击打开封面更换弹窗（可重新刮削 / 自己上传）' : '该文件已不在库中，点击查看处理建议'}">
                ${f.localPosterPath || f.posterPath
                ? `<img class="fail-poster" src="${getPosterUrl(f)}" alt="">`
                : `<div class="fail-glyph">🎞️</div>`}
                <div class="fail-main">
                    <div class="fail-title">${escapeHtml(f.title || f.fileName || f.filePath)}</div>
                    <div class="fail-reason" title="${escapeHtml(f.reason || '')}">${escapeHtml(f.reason || '未知原因')} · 重试 ${f.retryCount || 0} 次</div>
                </div>
                <span class="fail-time">${formatDateLabel(new Date(f.failedAt).toISOString().substring(0, 10))}</span>
                <span class="fail-open">🖼️ 换封面</span>
            </div>
        `;
        }).join('');

        view.innerHTML = `
            <div class="panel-section">
                <div class="panel-head">
                    <div class="toolbar-title" style="border:none;margin:0;padding:0;">⚠️ 刮削失败清单
                        <span class="toolbar-count">${sliced ? `该分类 ${filtered.length} 条 / 共 ${failures.length} 条` : `共 ${failures.length} 条`}</span>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-secondary btn-sm" id="failRefreshBtn">刷新</button>
                        <button class="btn btn-sm" id="failRescrapeBtn" ${failures.length === 0 ? 'disabled' : ''}>🔄 一键重刮失败项</button>
                    </div>
                </div>
                ${r34SliceBar('failures', cur)}
                ${filtered.length === 0
                ? `<div class="empty-state"><div class="icon">✨</div><div>${sliced ? '该分类下没有刮削失败的记录' : '没有刮削失败的影片，一切正常'}</div></div>`
                : rows}
                <div id="rescrapeStatus" style="margin-top:14px;font-family:var(--font-mono);font-size:12px;color:var(--text-muted);"></div>
            </div>
        `;

        $('#failRefreshBtn').addEventListener('click', showFailures);
        $('#failRescrapeBtn').addEventListener('click', startRescrape);
        bindSliceBar('failures', () => renderFailures(failures));

        /* ★ round26 #5：失败清单里的每一条都能点开。
         *   用户原话：「刮削失败功能里只能看到清单和刷新/一键刮取，
         *             不能直接在清单内点击对应项目打开它的弹窗做手动上传」。
         *   现在整行可点（含键盘 Enter/Space），打开的是封面更换弹窗
         *   showChangePosterModal —— 里面就有「重新刮削 / 自己上传 / 粘贴图片」。 */
        view.querySelectorAll('.fail-row.is-clickable').forEach(row => {
            const idx = parseInt(row.dataset.failI, 10);
            const go = () => openFailureRow(failures[idx]);
            row.addEventListener('click', go);
            row.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
            });
        });
    }

    // 打开某条失败记录的封面弹窗；记录已失效时给出可执行的下一步
    function openFailureRow(f) {
        if (!f) return;
        const mid = f.movieId || null;
        if (mid && typeof showChangePosterModal === 'function') {
            showChangePosterModal(mid);
            return;
        }
        showNotification(
            '这条记录已失效',
            `文件不在影片库中（可能已移动或删除）：${f.fileName || f.filePath}。`
            + '你可以点「一键重刮失败项」重试，或先扫描一次让文件重新入库。'
        );
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
            // round34 批次B：type 分册（all/jav/anime/film/cartoon/comic/novel）
            const t = r34Slice.annual || 'all';
            const res = await fetch(`/api/stats/annual?year=${annualYear}&type=${encodeURIComponent(t)}`);
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

                ${r34SliceBar('annual', r34Slice.annual || 'all')}

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
        bindSliceBar('annual', () => showAnnual(annualYear));
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

    // ================= 一键自动补封面（round26续） =================
    // 背景：后端早就有 cover-fallback 这条链路（漫画取 PDF 第 1 页 / 小说取 EPUB
    //   内封面图）和 /api/movie/auto-cover/batch + /status 两个接口，但前端**一个入口都没接**
    //   —— 海报健康页里只有「逐个修正封面」，那是纯手动：一部一部弹窗让人选图，
    //   176 部没封面的漫画就得点 176 次。这里把批量链路接出来，一次点完。
    const POSTER_AUTO_LABEL = '⚡ 一键自动补封面';
    let posterAutoTimer = null;

    async function startPosterAutoCover(btn) {
        if (posterAutoTimer) return;
        const label = btn ? btn.textContent : POSTER_AUTO_LABEL;
        const setBtn = (t, dis) => { if (btn && btn.isConnected) { btn.textContent = t; btn.disabled = !!dis; } };
        setBtn('⚡ 正在启动…', true);
        try {
            const r = await fetch('/api/movie/auto-cover/batch', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                // searchFirst:false = 不联网搜，直接取内容页。联网搜要几十秒/部，
                // 而且 kmoe / zlibrary 常年登录失效，批量跑它只会白等。
                // ★ round27：不再写死 types。原来固定 ['comic','novel']，而实际缺封面的
                //   往往是 anime/影片 ⇒ 后端扫完 0 条，用户体感「点了没反应、一个都没补」。
                //   现在省略 types，由后端按库内实况自动探测「谁缺封面补谁」。
                body: JSON.stringify({ searchFirst: false })
            });
            const j = await r.json();
            if (j.code !== 0) {
                showNotification('无法开始补封面', j.msg || '未知原因', 'error');
                setBtn(label, false);
                return;
            }
        } catch (e) {
            showNotification('无法开始补封面', e.message, 'error');
            setBtn(label, false);
            return;
        }
        showNotification('已开始补封面', '按库内实况自动挑「缺封面的」：漫画取 PDF 第 1 页 / 小说取 EPUB 内封面 / 视频抽帧，后台跑', 4000);
        posterAutoTimer = setInterval(async () => {
            let st;
            try { st = (await (await fetch('/api/movie/auto-cover/status')).json()).data; } catch (e) { return; }
            if (!st) return;
            if (st.running) { setBtn(`⚡ 补封面 ${st.done}/${st.total}`, true); return; }
            clearInterval(posterAutoTimer);
            posterAutoTimer = null;
            setBtn(POSTER_AUTO_LABEL, false);
            showNotification('封面补齐完成', `成功 ${st.ok || 0} 部 · 失败 ${st.fail || 0} 部`, 5000);
            if (typeof showPosterHealth === 'function') showPosterHealth();
        }, 2000);
    }
    window.startPosterAutoCover = startPosterAutoCover;

    // ================= 海报健康 =================
    /* r59：滚动位置固定 —— 换封面/刷新/切片重渲后留在原位；F5 后按 localStorage 续位继续修正。
     * 根因：showPosterHealth 一进来就把容器换成 loading 占位（内容高度骤降，滚动被浏览器钳到顶），
     * 而 refreshCurrentList 的 rAF 恢复早于异步渲染完成，恢复跑在重渲前面等于没恢复。
     * 口径：渲染前抓 window.scrollY → 渲染后立即+rAF 双保险还原；live 期间滚动节流落盘
     * posterHealthResume（含分类切片），hash 命中 poster-health 的启动/顶栏刷新路径消费它续位。 */
    const PH_RESUME_KEY = 'posterHealthResume';
    let phPendingY = -1;
    let phScrollBound = false;

    function phIsLive() {
        const v = $('#featureView');
        return !!(v && v.dataset.phActive === '1' && v.style.display === 'block');
    }

    function phPersistResume() {
        if (!phIsLive()) return;
        try {
            localStorage.setItem(PH_RESUME_KEY, JSON.stringify({
                y: Math.round(window.scrollY), slice: r34Slice.poster, ts: Date.now()
            }));
        } catch (e) { /* 忽略 */ }
    }

    function phRestoreScroll() {
        if (phPendingY < 0) return;
        const y = phPendingY;
        phPendingY = -1;
        window.scrollTo(0, y);
        requestAnimationFrame(() => window.scrollTo(0, y));   // 渲染后内容高度还会再变，双保险
        setTimeout(phPersistResume, 120);                     // 让续位记录的是还原后的位置
    }

    // F5（hash 恢复）/ 顶栏刷新进入海报健康前的续位申请：恢复滚动 + 分类切片
    function requestPosterHealthResume() {
        try {
            const saved = JSON.parse(localStorage.getItem(PH_RESUME_KEY) || 'null');
            if (saved && typeof saved.y === 'number') {
                phPendingY = saved.y;
                if (saved.slice) r34Slice.poster = saved.slice;
            }
        } catch (e) { /* 忽略 */ }
    }

    function bindPhScrollPersist() {
        if (phScrollBound) return;
        phScrollBound = true;
        let last = 0;
        window.addEventListener('scroll', () => {
            const now = Date.now();
            if (now - last < 250) return;
            last = now;
            phPersistResume();
        }, { passive: true });
    }

    async function showPosterHealth() {
        const view = $('#featureView');
        if (phIsLive()) phPendingY = window.scrollY;   // 原地刷新/换封面重渲：先抓位置，占位一换就被钳到顶
        bindPhScrollPersist();
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
        renderPosterHealth(d);
    }

    // round34 批次B：海报健康渲染拆出来 —— 切片只重渲染
    function renderPosterHealth(d) {
        const view = $('#featureView');
        if (!view || !d) return;
        if (phPendingY < 0 && phIsLive()) phPendingY = window.scrollY;   // 切片重渲入口：渲染前抓位置
        const cur = r34Slice.poster;
        const typeOf = (m) => (m.type || m.movieType || '').toLowerCase();
        const sliced = cur !== 'all';
        const missingAll = d.missing || [];
        const missing = sliced ? missingAll.filter(m => typeOf(m) === cur) : missingAll;
        const groupsAll = d.duplicateGroups || [];
        const dupGroups = sliced
            ? groupsAll.filter(g => (g.movies || []).some(m => typeOf(m) === cur))
            : groupsAll;

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
        missing.forEach(m => pushFix(m.id, m.title || m.fileName));
        dupGroups.forEach(g => {
            (g.movies || []).forEach(m => pushFix(m.id, m.title || m.fileName));
        });

        const missingRows = missing.map(m => `
            <div class="fail-row">
                <div class="fail-glyph">🖼️</div>
                <div class="fail-main">
                    <div class="fail-title">${escapeHtml(m.title || m.fileName)}</div>
                    <div class="fail-reason">缺少封面 · ${escapeHtml((m.type || '').toUpperCase())}</div>
                </div>
                <button class="btn btn-secondary btn-sm" onclick="showChangePosterModal(${m.id})">🖼️ 选封面</button>
                <button class="btn btn-secondary btn-sm" onclick="rescrapeMovie(${m.id})">🔄 重刮</button>
            </div>`).join('');

        const dupBlocks = dupGroups.map(g => `
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
                        <span class="toolbar-count">${sliced
                            ? `该分类 缺封面 ${missing.length} · 重复分组 ${dupGroups.length}`
                            : `缺封面 ${d.missingCount} · 重复分组 ${d.dupGroupsCount}`}</span>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-sm" id="posterAutoCover" title="自动挑出库里所有缺封面的影片：漫画取 PDF 第 1 页、小说取 EPUB 内封面、视频抽帧；不联网搜，每部零点几秒">${POSTER_AUTO_LABEL}</button>
                        <button class="btn btn-sm" id="posterFixStart" ${fixIds.length ? '' : 'disabled'}>🖼️ 逐个修正封面（${fixIds.length}）</button>
                        <button class="btn btn-secondary btn-sm" id="posterHealthRefresh">刷新</button>
                    </div>
                </div>

                ${r34SliceBar('poster', cur)}

                ${missing.length > 0 ? `
                <div class="annual-block" style="margin-bottom:14px;">
                    <h4>🈳 缺少封面（${missing.length} 部）</h4>
                    ${missingRows}
                </div>` : ''}

                ${dupGroups.length > 0 ? `
                <div style="margin-top:6px;">
                    <div class="annual-block" style="margin-bottom:12px;">
                        <h4>🔁 多部共用同一张封面（${dupGroups.length} 组）</h4>
                        <p style="font-size:12px;color:var(--text-muted);margin:4px 0 10px;">同一系列可能共用系列封面；点「选封面」可手动挑健康的海报，或点「逐个修正封面」挨个确认。</p>
                        ${dupBlocks}
                    </div>
                </div>` : ''}

                ${missing.length === 0 && dupGroups.length === 0 ? `
                <div class="empty-state"><div class="icon">✅</div><div>所有影片封面正常</div></div>` : ''}
            </div>
        `;

        $('#posterHealthRefresh').addEventListener('click', showPosterHealth);
        $('#posterAutoCover')?.addEventListener('click', function () { startPosterAutoCover(this); });
        $('#posterFixStart')?.addEventListener('click', () => startPosterFix(fixIds, fixTitles));
        bindSliceBar('poster', () => renderPosterHealth(d));

        // r59：渲染完成 → 标记 live → 还原滚动 → 记录续位
        view.dataset.phActive = '1';
        phRestoreScroll();
        phPersistResume();
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
        // round35：动漫板块的聚合入口页（animeko 式多源聚合）。hub:true = 本地生成页，
        // 不走 iframe/探测流程；源清单数据驱动 —— webview-sites.js 里加 board='anime'
        // 的站点就自动出现在聚合页里。
        { key: 'anime-hub', name: '🌐 聚合', board: 'anime', hub: true },
        { key: 'cycanime', name: '次元城动画', board: 'anime' },
        { key: 'moxmoe', name: 'Kmoe漫画', board: 'comic' },
        { key: 'koobone', name: 'Koobone', board: 'comic' },
        { key: 'komiic', name: 'Komiic', board: 'comic' },
        { key: 'manhuagui', name: '漫画柜', board: 'comic' },
        // round46：用户指定新增阅读站点（漫画 3 + 轻小说 1；档案在 routes/webview-sites.js）
        { key: 'acgndog', name: '次元狗', board: 'comic' },
        { key: 'dm5', name: '动漫屋', board: 'comic' },
        { key: 'zaimanhua', name: '再漫画', board: 'comic' },
        { key: 'mhua5', name: '漫画屋', board: 'comic' },
        // round53：漫画/小说补源（网络调研结论）；小说从 comic 板块拆成独立板块
        { key: 'copymanga', name: '拷贝漫画', board: 'comic' },
        { key: 'baozimh', name: '包子漫画', board: 'comic' },
        { key: 'wenku8', name: '轻小说文库', board: 'novel' },
        { key: 'esjzone', name: 'ESJ Zone', board: 'novel' },
        { key: 'lightnovel', name: '轻之国度', board: 'novel' },
        { key: 'zoolib', name: 'ZooLib 韩轻', board: 'novel' }
    ];
    // 入口 view 名 -> 板块
    const BOARD_OF_VIEW = {
        watch: 'av',
        'watch-anime': 'anime',
        'watch-comic': 'comic',
        'watch-novel': 'novel',
        'watch-hanime': 'hanime'
    };
    // 各板块的标题（窗口标题条 / 空状态文案用）
    const BOARD_TITLE = {
        av: 'AV在线观看',
        anime: '动漫在线观看',
        comic: '漫画在线观看',
        novel: '小说在线阅读',
        hanime: '里番在线观看'
    };
    // 当前板块 + 每个板块各自记住的活跃标签（切板块回来还在原来那页）
    // 默认站挑选原则：**优先能直接内嵌/反代的**，别一进来就是「列表模式」或「被阻断」。
    //   里番板块不用 hanime1 打头：它是 Cloudflare 挑战站（403），只能退化成应用内列表；
    //   91动漫 实测可内嵌且列表齐全，作为开场更合适。
    const BOARD_DEFAULT_SITE = { av: 'javbus', anime: 'anime-hub', comic: 'moxmoe', novel: 'wenku8', hanime: 'dongman' };
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

    // round52：标签用 uid 唯一标识（key 只是站点）—— 以前一个站点只能有一个标签，
    // 所以「同站点开第二个页面」做不到（用户说的「没有二级标签页」）。
    // key 仍然保留：站点栏高亮、能力档案查询都按站点走。
    let watchTabs = [];      // 常驻标签：[{ key, uid, name, pane }]
    let watchActive = '';    // 存的是 uid
    let tabSeq = 0;
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
        const t = watchTabs.find((x) => x.uid === watchActive);
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
        // 同站点多开时名字会重样 —— 序号只在同一站点出现第二次以后才显示，第一个还是干干净净的站名
        const dupCount = {};
        watchTabs.filter((t) => (t.board || 'av') === watchBoard).forEach((t) => {
            dupCount[t.key] = (dupCount[t.key] || 0) + 1;
        });
        const usedIdx = {};
        strip.innerHTML = watchTabs.filter((t) => (t.board || 'av') === watchBoard).map((t) => {
            usedIdx[t.key] = (usedIdx[t.key] || 0) + 1;
            const suffix = dupCount[t.key] > 1 ? ` ${usedIdx[t.key]}` : '';
            return `
            <div class="watch-tab ${t.uid === watchActive ? 'on' : ''}${freshTabs.has(t.uid) ? ' is-new' : ''}"
                 data-tab="${t.uid}" title="${escapeHtml(t.name)}">
                <span class="fav"></span>
                <span class="n">${escapeHtml(t.name + suffix)}</span>
                <span class="x" data-close="${t.uid}" title="关闭标签">✕</span>
            </div>`;
        }).join('');
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

    function activateWatchTab(uid) {
        const target = watchTabs.find((t) => t.uid === uid);
        if (!target) return;
        watchActive = uid;
        activeByBoard[target.board || 'av'] = uid;   // 记住这个板块停在哪个标签，切回来还在原地
        // 用 class 切 visibility（不是 display）——见 style.css 里的说明：display:none 会把状态清掉
        // 这里遍历的是**全部**标签：顺带把别的板块的 pane 也摘掉 .on，避免两个板块同时可见
        watchTabs.forEach((t) => t.pane.classList.toggle('on', t.uid === uid));
        renderWatchTabs();
        fitWatch();
    }

    function closeWatchTab(uid) {
        const i = watchTabs.findIndex((t) => t.uid === uid);
        if (i < 0) return;
        const board = watchTabs[i].board || 'av';
        watchTabs[i].pane.remove();
        watchTabs.splice(i, 1);
        if (watchActive === uid) {
            // 回退只在**同一板块**里找，别跳到别的板块去
            const same = watchTabs.filter((t) => (t.board || 'av') === board);
            if (same.length) activateWatchTab(same[same.length - 1].uid);
            else { watchActive = ''; renderWatchTabs(); syncSiteBar(); }
        } else renderWatchTabs();
    }

    /** 站点栏：带父子关系悬停动效（网站-网址-标签页） */
    function renderSiteBar() {
        const bar = $('#watchToolbar');
        if (!bar) return;
        const list = WATCH_SITES.filter((s) => (s.board || 'av') === watchBoard);
        bar.innerHTML = list.map((s) => {
            const addrs = Array.isArray(s.addrs) && s.addrs.length ? s.addrs : [s.url || '#'];
            const sameTabs = watchTabs.filter(t => t.key === s.key);
            const isSiteActive = sameTabs.some(t => t.uid === watchActive);

            return `
                <div class="watch-site-group${isSiteActive ? ' is-active' : ''}">
                    <button class="watch-site${isSiteActive ? ' is-open' : ''}" data-open="${s.key}">
                        ${s.name}
                        ${sameTabs.length ? `<span class="watch-site-badge">${sameTabs.length}</span>` : ''}
                    </button>
                    <div class="watch-site-pop">
                        <div class="watch-pop-title">
                            <span>${s.name}</span>
                            <span style="opacity:.6;font-size:10px;">${addrs.length} 条线路</span>
                        </div>
                        <div class="watch-pop-list">
                            ${addrs.map((url, idx) => `
                                <div class="watch-pop-item" data-site="${s.key}" data-url="${escapeHtml(url)}">
                                    <span class="wpi-label">线路 ${idx + 1}</span>
                                    <span class="wpi-url">${escapeHtml(url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>
                                </div>
                            `).join('')}
                        </div>
                        <button class="watch-pop-add" data-site-add="${s.key}">＋ 新建此站标签页</button>
                    </div>
                </div>
            `;
        }).join('');

        bar.querySelectorAll('.watch-site').forEach((b) => {
            b.addEventListener('click', () => openWatchTab(b.dataset.open));
        });
        bar.querySelectorAll('.watch-pop-item').forEach((item) => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                openWatchTab(item.dataset.site, '', { newTab: true, startPath: item.dataset.url });
            });
        });
        bar.querySelectorAll('[data-site-add]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openWatchTab(btn.dataset.siteAdd, '', { newTab: true });
            });
        });
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
                            <button class="wm-tool" id="watchCFBtn" title="打开真实浏览器完成 Cloudflare 人机验证（Hanime1 / Jable 专属）">🛡️ CF验证</button>
                            <button class="wm-tool" id="watchHealthCheckBtn" title="全站镜像线路实时健康测速与探活仪表盘">⚡ 测速探活</button>
                            <button class="wm-tool" id="watchSwitchAddr" title="重新逐级探测该站的所有地址">🔁 换线路</button>
                        </div>
                        <div class="watch-tabstrip">
                            <div class="watch-tabs" id="watchTabs"></div>
                            <button class="watch-tab-add" id="watchTabAdd" title="在当前站点再开一个标签页（同站点可以开多个）">＋</button>
                        </div>
                        <!-- 站点栏内容由 renderSiteBar() 按当前板块填充 -->
                        <div class="watch-toolbar" id="watchToolbar"></div>
                        <div class="watch-body" id="watchStage"></div>
                    </div>
                </div>`;
            view.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openWatchTab(b.dataset.open)));
            $('#watchCFBtn')?.addEventListener('click', () => {
                const cur = watchTabs.find((t) => t.uid === watchActive);
                const site = cur && WATCH_SITES.find((s) => s.key === cur.key);
                const targetUrl = (site && site.url) || 'https://hanime1.me';
                window.triggerCFVerification(targetUrl);
            });
            $('#watchHealthCheckBtn')?.addEventListener('click', () => {
                window.openWatchHealthModal(watchBoard || 'all');
            });
            $('#watchSwitchAddr').addEventListener('click', async () => {
                const tab = watchTabs.find((t) => t.uid === watchActive);
                const site = tab && WATCH_SITES.find((s) => s.key === tab.key);
                if (!tab || !site) return;
                showNotification('正在重新选线路', '逐级探测该站的所有地址');
                await loadWatchPane(tab, site, true);
                if (watchActive === tab.uid) activateWatchTab(tab.uid);
            });
            // round52：「＋ 新标签页」—— 同站点再开一个（二级标签页）。
            // 落点优先当前页地址（tab.proxyPath / tab.startPath），让用户「从这里再逛一份」。
            $('#watchTabAdd').addEventListener('click', () => {
                const cur = watchTabs.find((t) => t.uid === watchActive);
                if (!cur) { showNotification('先开一个站点', '点下面任意站点'); return; }
                const startPath = cur.proxyPath || cur.startPath || '';
                openWatchTab(cur.key, '', { newTab: true, startPath });
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
            activateWatchTab(activeByBoard[watchBoard] || mine[0].uid);
        }
        fitWatch();
    }

    /**
     * round52：opts.newTab = 同站点再开一个标签（「＋ 新标签页」与右键都用它），
     * startPath 可指定落点路径（如当前页），不传就落站点首页。
     */
    function makeWatchLoadingHtml(siteName) {
        const loaderSrc = (window.animState && window.animState.urls && window.animState.urls.loader)
            ? window.animState.urls.loader
            : 'img/extras/walk-character.webp';
        return `
            <div class="watch-pane-loading" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:65vh;gap:14px;">
                <img src="${loaderSrc}" style="width:72px;height:84px;object-fit:contain;filter:drop-shadow(0 6px 16px rgba(0,0,0,0.3));animation:nvxLongIn .4s ease both;" alt="">
                <div style="font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;">
                    <span>正在加载 ${escapeHtml(siteName || '站点')}</span>
                    <span class="nvx-bouncing-dots"><i></i><i></i><i></i></span>
                </div>
                <div style="font-size:12px;color:var(--text-muted);">正在连接站点并探测可用镜像线路…</div>
            </div>
        `;
    }

    async function openWatchTab(key, searchQ, opts) {
        const site = WATCH_SITES.find((s) => s.key === key);
        if (!site) return;
        const open = watchTabs.find((t) => t.key === key);
        if (open && !(opts && opts.newTab)) { activateWatchTab(open.uid); if (searchQ) navigateWatchTab(open, searchQ); return; }   // 已开过就切过去并补一次搜索

        const pane = document.createElement('div');
        pane.className = 'watch-pane';
        pane.innerHTML = makeWatchLoadingHtml(site.name);
        $('#watchStage').appendChild(pane);
        const tab = { key, uid: key + '#' + (++tabSeq), name: site.name, pane, board: site.board || watchBoard, initialQuery: searchQ || '' };
        if (opts && opts.startPath) tab.startPath = opts.startPath;
        watchTabs.push(tab);
        freshTabs.add(tab.uid);
        setTimeout(() => { freshTabs.delete(tab.uid); if (watchTabs.some((t) => t.uid === tab.uid)) renderWatchTabs(); }, 380);
        activateWatchTab(tab.uid);
        await loadWatchPane(tab, site);
        // loadWatchPane 里的 fillPane* 会重置 pane.className（把 .on 冲掉），这里补点亮
        if (watchActive === tab.uid) activateWatchTab(tab.uid);
    }

    /**
     * round34 批次B：给已开标签补一次站内搜索（榜单「去观看」联动用）。
     * 整站模式 → 把 iframe 导到 searchPath 展开后的代理路径；列表模式 → 触发站内搜索。
     */
    function navigateWatchTab(tab, q) {
        if (!tab || !q) return;
        const site = WATCH_SITES.find((s) => s.key === tab.key);
        if (!site) return;
        const caps = SITE_CAPS[site.key] || {};
        const sp = (caps.searchPath || site.searchPath || '');
        if (!sp) return;
        const target = sp.replace('{q}', encodeURIComponent(q));
        if (tab.pane && tab.pane.classList.contains('watch-proxied')) {
            const frame = tab.pane.querySelector('iframe.watch-frame');
            if (frame) frame.src = '/' + site.key + target;
        } else {
            const inp = tab.pane && tab.pane.querySelector('#wsq');
            const sgo = tab.pane && tab.pane.querySelector('#wsgo');
            if (inp) {
                inp.value = q;
                if (sgo) sgo.click(); else inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            } else {
                // round56b：iframe 整站内嵌模式（fillPaneFrame，如次元城）—— 复用旧标签时
                // 直接把 iframe 导到搜索结果页。此前这里落空 → 搜索词被丢，标签停在旧页面，
                // 用户只能自己在站内右上角搜索框再搜一遍才能看到结果。
                const frame = tab.pane && tab.pane.querySelector('iframe');
                if (frame && tab.addr) frame.src = tab.addr.replace(/\/+$/, '') + target;
            }
        }
    }

    async function loadWatchPane(tab, site, force) {
        const pane = tab.pane;
        // round35：聚合入口页 —— 本地生成，不走探测/iframe 流程
        if (site.hub) {
            const q0 = tab.initialQuery || '';
            tab.initialQuery = '';
            return fillPaneHub(pane, site, q0);
        }
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
        const q0 = tab.initialQuery || '';
        tab.initialQuery = '';       // 只在首次加载时生效

        // ① 支持整站反代 → 首选。这是唯一能「完美复现站点全部功能」的模式：
        //    页面、登录、翻页、搜索、播放器全部在我们自己的域下跑，不跳外链。
        if (caps.canProxy) {
            return fillPaneProxy(pane, site, tab, info, q0);
        }

        // ② 站点禁止内嵌或属 Cloudflare 防火墙站点 → 退到「应用内列表」或「人机验证助手」
        if (site.key === 'hanime1' || info.frameable === false || (info.unknown && site.direct === false)) {
            if (info.canList && site.key !== 'hanime1') return fillPaneList(pane, site, tab, q0);
            return fillPaneBlocked(pane, site, info);
        }

        // ③ 本身可内嵌（如 91动漫）→ 直接 iframe
        fillPaneFrame(pane, info.url, info.unknown ? `探测失败（网络抖动），已直接尝试内嵌；当前线路 ${info.url}` : `线路 ${info.url}`, q0, site, info);
    }

    function sceneName(info) { return info.name || ''; }

    /**
     * round35 · 动漫聚合入口页（animeko 式多源聚合）
     * ============================================================
     * 不嵌任何第三方页面，本地生成轻页：
     *   ① 一次搜索 → 分发到全部在线源（board=anime 的站点，带词打开）+ 本地动漫库命中
     *   ② 每个在线源实时状态灯（复用 /api/webview/site 探测）——源挂了立刻看得见，
     *     不再是「打开白屏猜原因」；单源死不阻塞（animeko 的核心思想：多源互补）
     *   ③ 热门番剧榜（/api/acg/rank，fankuhub 动画榜）→ 点击直接带词分发
     * 源清单是数据驱动的：webview-sites.js 加一个 board='anime' 的站即自动出现在这里。
     */
    function fillPaneHub(pane, site, searchQ) {
        pane.className = 'watch-pane watch-hub';
        const srcs = WATCH_SITES.filter((s) => (s.board || 'av') === 'anime' && !s.hub);
        pane.innerHTML = `
            <div class="hub-wrap">
                <div class="hub-head">
                    <div class="hub-title">🌐 动漫聚合</div>
                    <div class="hub-sub">一次搜索，分发到全部在线源与本地动漫库 · 单源失效不阻塞（多源互补）</div>
                    <div class="hub-search">
                        <input id="hubQ" type="text" placeholder="输入番剧名，如：葬送的芙莉莲" autocomplete="off">
                        <button class="btn btn-primary" id="hubGo">🔍 聚合搜索</button>
                        <!-- round36 批次B：把同一个词交给站点解析器（能出剧集并能应用内播放） -->
                        <button class="btn btn-secondary" id="hubMs" title="用站点解析器搜索：可读出剧集并直接在应用内播放">🔎 解析器搜索</button>
                    </div>
                </div>
                <div class="hub-h">📺 在线源 <span class="hub-tip">状态灯实时探测 · 点卡片带词打开</span></div>
                <div class="hub-cards" id="hubCards"></div>
                <div class="hub-h">📚 本地动漫库 <span class="hub-tip">影视/动漫库收录的番剧</span></div>
                <div class="hub-local" id="hubLocal"><div class="hub-empty">输入关键词后搜索本地库</div></div>
                <div class="hub-h">🔥 热门番剧 <span class="hub-tip">fankuhub 动画榜 · 点击直接分发搜索</span></div>
                <div class="hub-rank" id="hubRank"><div class="hub-empty">榜单加载中…</div></div>
            </div>`;

        const inp = pane.querySelector('#hubQ');
        const go = pane.querySelector('#hubGo');
        const cardsEl = pane.querySelector('#hubCards');
        const localEl = pane.querySelector('#hubLocal');
        const rankEl = pane.querySelector('#hubRank');

        // ---- 在线源卡：状态灯 + 带词打开 ------------------------------------
        let hubQ = '';
        const hubStatuses = {};      // key -> 探测结果（fillPaneHub 每次重建 pane，无跨会话污染）
        function renderCards() {
            cardsEl.innerHTML = srcs.map((s) => {
                const st = hubStatuses[s.key];
                const dot = !st ? '<span class="hub-dot grey" title="探测中"></span>'
                    : st.unknown ? `<span class="hub-dot amber" title="${escapeHtml(st.reason || '探测失败')}"></span>`
                    : st.frameable === false ? `<span class="hub-dot red" title="${escapeHtml(st.reason || '不可内嵌')}"></span>`
                    : '<span class="hub-dot green" title="可内嵌"></span>';
                const stTxt = !st ? '探测中…' : st.unknown ? '探测失败·仍可尝试' : st.frameable === false ? '不可内嵌' : '可内嵌';
                return `
                <div class="hub-card" data-src="${s.key}">
                    <div class="hub-card-top">${dot}<b>${escapeHtml(s.name)}</b><span class="hub-card-st">${stTxt}</span></div>
                    <div class="hub-card-actions">
                        <button class="btn btn-sm btn-primary" data-go="${s.key}">🔍 ${hubQ ? '搜索「' + escapeHtml(hubQ.slice(0, 12)) + '」' : '打开首页'}</button>
                    </div>
                </div>`;
            }).join('');
            cardsEl.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
                openWatchTab(b.dataset.go, hubQ || '');
            }));
        }
        renderCards();
        srcs.forEach(async (s) => {
            try {
                const r = await fetch(`/api/webview/site?key=${encodeURIComponent(s.key)}`);
                const j = await r.json();
                hubStatuses[s.key] = (j && j.code === 0) ? j.data : { unknown: true, reason: '接口异常' };
            } catch (e) {
                hubStatuses[s.key] = { unknown: true, reason: e.message };
            }
            renderCards();
        });

        // ---- 本地动漫库 ------------------------------------------------------
        async function searchLocal(q) {
            localEl.innerHTML = '<div class="hub-empty">搜索中…</div>';
            try {
                const r = await fetch(`/api/movie/search?q=${encodeURIComponent(q)}&type=cartoon`);
                const j = await r.json();
                const list = (j && j.code === 0 && Array.isArray(j.data)) ? j.data : [];
                if (!list.length) {
                    localEl.innerHTML = '<div class="hub-empty">本地动漫库没有命中 —— 也可以直接用上面的在线源</div>';
                    return;
                }
                localEl.innerHTML = list.slice(0, 12).map((m) => `
                    <div class="hub-local-item" data-id="${m.id}">
                        <span class="hub-local-t">${escapeHtml(m.title || m.fileName || ('#' + m.id))}</span>
                        <span class="hub-local-open">查看详情 →</span>
                    </div>`).join('');
                localEl.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', () => {
                    if (typeof window.jumpToMovieFromAI === 'function') window.jumpToMovieFromAI(Number(el.dataset.id));
                }));
            } catch (e) {
                localEl.innerHTML = `<div class="hub-empty">本地搜索失败：${escapeHtml(e.message)}</div>`;
            }
        }

        // ---- 聚合搜索 --------------------------------------------------------
        function doHubSearch(q) {
            hubQ = String(q || '').trim();
            if (!hubQ) return;
            if (inp.value !== hubQ) inp.value = hubQ;
            renderCards();
            searchLocal(hubQ);
        }

        go.addEventListener('click', () => doHubSearch(inp.value));
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doHubSearch(inp.value); });
        // 跳转「番剧解析」视图，并把这个词带过去（一级导航 → 二级 tab 的联动）
        const msBtn = pane.querySelector('#hubMs');
        if (msBtn) msBtn.addEventListener('click', () => {
            const q = (inp.value || '').trim();
            if (!q) { if (inp) inp.focus(); return; }
            if (window.MediaSource && typeof window.switchView === 'function') {
                window.switchView('ms');
                window.MediaSource.openWithQuery(q, 'search');
            }
        });

        // ---- 热门番剧榜 ------------------------------------------------------
        (async () => {
            try {
                const r = await fetch('/api/acg/rank?source=all');
                const j = await r.json();
                const out = (j && j.data) || {};
                const items = [];
                ['fankuhub', 'acghub'].forEach((src) => {
                    (out[src] && Array.isArray(out[src].items) ? out[src].items : []).slice(0, 10).forEach((it) => {
                        if (it.title) items.push({ title: it.title, score: it.score, tags: it.tags || [], src });
                    });
                });
                if (!items.length) { rankEl.innerHTML = '<div class="hub-empty">榜单暂不可用（网络原因），不影响上面的聚合搜索</div>'; return; }
                rankEl.innerHTML = items.slice(0, 20).map((it, i) => `
                    <div class="hub-rank-item" data-q="${escapeHtml(it.title)}">
                        <span class="hub-rank-n ${i < 3 ? 'top' + (i + 1) : ''}">${i + 1}</span>
                        <span class="hub-rank-t">${escapeHtml(it.title)}</span>
                        ${it.score != null ? `<span class="hub-rank-s">★ ${it.score}</span>` : ''}
                        <span class="hub-rank-src">${it.src === 'fankuhub' ? '番库' : 'ACGHub'}</span>
                    </div>`).join('');
                rankEl.querySelectorAll('[data-q]').forEach((el) => el.addEventListener('click', () => {
                    doHubSearch(el.dataset.q);
                }));
            } catch (e) {
                rankEl.innerHTML = `<div class="hub-empty">榜单加载失败：${escapeHtml(e.message)}</div>`;
            }
        })();

        // 带词打开（榜单「去观看」联动 / tab.initialQuery）：直接触发一次聚合搜索
        if (searchQ) doHubSearch(searchQ);
        fitWatch();
    }

    function fillPaneFrame(pane, url, note, searchQ, site, info) {
        pane.className = 'watch-pane';
        let src = url;
        // round34 批次B：带词打开 → 首页直接落在搜索结果页（91动漫等可内嵌站）
        if (searchQ && site) {
            const sp = (SITE_CAPS[site.key] || {}).searchPath || '';
            if (sp) src = (url || '').replace(/\/+$/, '') + sp.replace('{q}', encodeURIComponent(searchQ));
        }
        const loaderSrc = (window.animState && window.animState.urls && window.animState.urls.loader)
            ? window.animState.urls.loader
            : 'img/extras/walk-character.webp';
        pane.innerHTML = `
            ${note ? `<div class="watch-note">${escapeHtml(note)}</div>` : ''}
            <div class="watch-frame-mask" style="position:absolute;inset:0;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:5;transition:opacity .35s ease;">
                <img src="${loaderSrc}" style="width:72px;height:84px;object-fit:contain;filter:drop-shadow(0 6px 16px rgba(0,0,0,0.3));" alt="">
                <div style="font-size:14.5px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;">
                    <span>正在加载 ${escapeHtml(site ? site.name : '')}</span>
                    <span class="nvx-bouncing-dots"><i></i><i></i><i></i></span>
                </div>
            </div>
            <iframe src="${src}" referrerpolicy="no-referrer" allowfullscreen
                    onload="const m=this.previousElementSibling;if(m&&m.classList.contains('watch-frame-mask')){m.style.opacity='0';setTimeout(()=>m.remove(),350);}"
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
    function fillPaneProxy(pane, site, tab, info, searchQ) {
        pane.className = 'watch-pane watch-proxied';
        // root 是「这个站挂在本应用下的路径前缀」；entry 是首页入口。
        // 有的站首页不在 /（porndude 中文首页在 /zh），服务端用 entryPath 声明，
        // 这里沿用，省得整站模式一进来落在英文页。
        // ★ round34 批次B：带词打开 → entry 直接落在 searchPath 展开后的搜索结果页。
        const root = `/${site.key}`;
        const sp = (SITE_CAPS[site.key] || {}).searchPath || '';
        // round52：「＋ 新标签页」带着 tab.startPath 进来（当前页地址，已含 root 前缀）→ 直接落那里
        const entry = (tab.startPath && String(tab.startPath).startsWith(root))
            ? tab.startPath
            : root + (searchQ && sp
                ? sp.replace('{q}', encodeURIComponent(searchQ))
                : (site.entryPath || '/'));
        tab.startPath = '';

        const bar = document.createElement('div');
        bar.className = 'watch-tool watch-tool--proxy';
        bar.innerHTML = `
            <span class="watch-badge" title="页面由本应用代理，所有功能都在应用内">🛰️ 整站模式</span>
            <!-- round52：后退 / 前进 —— iframe 走的是本应用同源反代，history 是我们自己的，直接调 -->
            <button class="btn btn-sm btn-secondary" data-px="back" title="后退（上一页）">←</button>
            <button class="btn btn-sm btn-secondary" data-px="fwd" title="前进（下一页）">→</button>
            <span class="watch-addr" id="pxAddr_${site.key}" style="font-size:12.5px;color:var(--text-muted);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(info.url || '')}</span>
            <span style="flex:1"></span>
            <button class="btn btn-sm btn-secondary" data-px="reload">↻ 刷新</button>
            <button class="btn btn-sm btn-secondary" data-px="list" title="改用轻量列表模式（抓取更快）">☰ 列表模式</button>
            <button class="btn btn-sm btn-secondary" data-px="fav" title="把当前页面（标题+封面+地址）存进收藏夹">⭐ 收藏本页</button>
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
        // round52：顺带把地址写进工具条（后退/前进时肉眼可见页面在哪）。
        tab.proxyPath = entry;
        const addrEl = bar.querySelector('.watch-addr');
        try {
            frame.addEventListener('load', () => {
                try {
                    const w = frame.contentWindow;
                    const p = w.location.pathname;
                    if (p && p.startsWith(root)) {
                        tab.proxyPath = p + w.location.search;
                        if (addrEl) addrEl.textContent = w.location.host + p + w.location.search;
                    }
                } catch (e) { /* 同源读不到就保持原值 */ }
            });
        } catch (e) { /* 忽略 */ }

        bar.querySelectorAll('[data-px]').forEach((b) => b.addEventListener('click', async () => {
            const act = b.dataset.px;
            if (act === 'reload') {
                frame.src = tab.proxyPath || entry;
            } else if (act === 'back' || act === 'fwd') {
                // round52：后退/前进。iframe 与本应用同源（整站反代），history 可直接调；
                // 用户在站内点链接产生的历史也在里面 —— 这就是「回退上一页」。
                try {
                    const w = frame.contentWindow;
                    if (!w || !w.history) throw new Error('no history');
                    if (act === 'back') w.history.back(); else w.history.forward();
                } catch (e) {
                    showNotification('这个页面不支持后退', '当前模式不是整站反代（或跨域），history 摸不到');
                }
            } else if (act === 'list') {
                if (!(SITE_CAPS[site.key] || {}).canList) {
                    showNotification('该站没有列表模式', '这个站点只能以整站模式使用');
                    return;
                }
                fillPaneList(pane, site, tab);
            } else if (act === 'fav') {
                // round53：收藏本页。整站反代 iframe 同源 —— 标题/og:image/真实地址都能读到；
                // 真实地址转回站点原地址存（不带本应用代理前缀），点击时再按 host 找回站点。
                let url = info.url || '', title = '', cover = '';
                try {
                    const w = frame.contentWindow;
                    const p = w.location.pathname + w.location.search;
                    // 代理路径 /<siteKey>/xxx → 原站地址 https://host/xxx
                    if (p.startsWith(root)) url = info.url.replace(/\/$/, '') + p.slice(root.length);
                    title = (w.document && w.document.title || '').trim();
                    const og = w.document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[property="og:image secure_url"]');
                    if (og && og.content) {
                        try { cover = new URL(og.content, w.location.href).href; } catch (e2) { cover = ''; }
                    }
                } catch (e) { /* 跨域读不到就退回站点首页地址 */ }
                window.saveToFav({ board: FAV_BOARD_OF[watchBoard] || 'web', title, url, coverUrl: cover, source: site.name });
            } else if (act === 'ext') {
                window.open(info.url, '_blank', 'noopener');
            }
        }));

        const loaderSrc = (window.animState && window.animState.urls && window.animState.urls.loader)
            ? window.animState.urls.loader
            : 'img/extras/walk-character.webp';
        const mask = document.createElement('div');
        mask.className = 'watch-frame-mask';
        mask.style.cssText = 'position:absolute;inset:0;top:44px;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;z-index:5;transition:opacity .35s ease;';
        mask.innerHTML = `
            <img src="${loaderSrc}" style="width:72px;height:84px;object-fit:contain;filter:drop-shadow(0 6px 16px rgba(0,0,0,0.3));" alt="">
            <div style="font-size:14.5px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;">
                <span>正在加载 ${escapeHtml(site.name)}</span>
                <span class="nvx-bouncing-dots"><i></i><i></i><i></i></span>
            </div>
        `;
        frame.addEventListener('load', () => {
            mask.style.opacity = '0';
            setTimeout(() => mask.remove(), 350);
        });
        pane.appendChild(mask);

        fitWatch();
    }

    function fillPaneBlocked(pane, site, probe) {
        pane.className = 'watch-pane watch-blocked';
        const isCF = site.key === 'hanime1' || site.key === 'jable' || (probe && /cloudflare|403|attention|challenge/i.test(probe.reason || ''));
        const cfCard = isCF ? `
            <div class="cf-helper-box" style="margin-top:20px;padding:16px 20px;border-radius:14px;background:color-mix(in srgb, var(--primary) 12%, var(--card-bg));border:1px solid var(--primary);text-align:left;">
                <div style="font-weight:700;font-size:13.5px;color:var(--primary);margin-bottom:6px;display:flex;align-items:center;gap:6px;">
                    <span>🛡️ Cloudflare 人机验证助手</span>
                </div>
                <p style="font-size:12px;color:var(--text);line-height:1.6;margin-bottom:10px;">
                    该站点当前受 Cloudflare 人机验证防火墙拦截。点击下方按钮将自动调起真实浏览器，只需在弹出窗口中手动打勾一次，系统会自动抓取凭据（cf_clearance）并在站内恢复正常。
                </p>
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                    <button class="btn btn-sm" onclick="window.triggerCFVerification('${escapeHtml(site.url || 'https://hanime1.me')}')">
                        🛡️ 一键打开浏览器完成人机验证
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="const b=document.getElementById('watchSwitchAddr');if(b)b.click();">
                        🔄 重新选线路重试
                    </button>
                </div>
            </div>
        ` : '';

        pane.innerHTML = `
            <div style="padding:48px 24px;text-align:center;max-width:640px;margin:0 auto;">
                <div style="font-size:44px;margin-bottom:14px;">${isCF ? '🛡️' : '🚫🖼️'}</div>
                <h3 style="margin-bottom:10px;">${escapeHtml(site.name)} ${isCF ? '需要通过 Cloudflare 人机验证' : '不能被内嵌'}</h3>
                <p style="color:var(--text-muted);font-size:13px;line-height:1.9;margin-bottom:18px;">
                    ${escapeHtml((probe && probe.reason) || (isCF ? '站点防火墙开启了安全质询' : '站点禁止被其它网站内嵌'))}<br>
                    ${isCF ? '完成一次人机验证打勾即可在应用内正常浏览播放。' : '这是站点自己的声明（X-Frame-Options / CSP），不是本应用的限制。'}
                </p>
                ${cfCard}
                ${site.url ? `<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px;">
                    <button class="btn btn-secondary btn-sm" onclick="window.open('${escapeHtml(site.url)}','_blank','noopener')">🔗 在外部浏览器打开 ${escapeHtml(site.name)}</button>
                </div>` : ''}
            </div>`;
        fitWatch();
    }

    window.triggerCFVerification = async function(url) {
        const targetUrl = url || 'https://hanime1.me';
        showNotification('正在启动人机验证浏览器', '请在弹出的窗口中点击通过 Cloudflare 验证框，系统将自动捕获凭据', 6000);
        try {
            const res = await fetch('/api/config/browser/init-verification', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl })
            });
            const d = await res.json();
            if (d.code === 0) {
                showNotification('验证成功', 'Cloudflare 凭据已自动写入系统，正在重新加载页面…', 4000);
                setTimeout(() => {
                    const reloadBtn = document.querySelector('[data-px="reload"]');
                    if (reloadBtn) reloadBtn.click();
                    else {
                        const switchBtn = document.getElementById('watchSwitchAddr');
                        if (switchBtn) switchBtn.click();
                    }
                }, 1200);
            } else {
                showNotification('验证未完成', d.msg || '请重新尝试');
            }
        } catch (e) {
            showNotification('启动浏览器失败', e.message);
        }
    };

    // 站点不让内嵌时，用容器里的浏览器把它的列表抓回来，渲染进这个标签自己的 pane。
    // 支持「搜索」「分类切换」「加载下一页」（jable 这类站点一页只有 24 条，用户反馈过要补全）。
    async function fillPaneList(pane, site, tab, searchQ) {
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
            if (p === 1) {
                const loaderSrc = (window.animState && window.animState.urls && window.animState.urls.loader)
                    ? window.animState.urls.loader
                    : 'img/extras/walk-character.webp';
                grid.innerHTML = `
                    <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;height:55vh;gap:14px;">
                        <img src="${loaderSrc}" style="width:72px;height:84px;object-fit:contain;filter:drop-shadow(0 6px 16px rgba(0,0,0,0.3));animation:nvxLongIn .4s ease both;" alt="">
                        <div style="font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;">
                            <span>正在抓取 ${escapeHtml(site.name)} 列表</span>
                            <span class="nvx-bouncing-dots"><i></i><i></i><i></i></span>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);">正在解析页面并提取内容…</div>
                    </div>
                `;
            }
            foot.textContent = `正在抓取第 ${p} 页…（约 15 秒）`;

            let url = `/api/webview/list?site=${encodeURIComponent(site.key)}&page=${p}`;
            if (mode.type === 'search') url += `&q=${encodeURIComponent(mode.q)}`;
            else if (mode.type === 'cat') url += `&path=${encodeURIComponent(mode.path)}`;

            let d = null;
            try { d = await (await fetch(url)).json(); } catch (e) { /* 下面报 */ }
            busy = false;

            if (p === 1) grid.innerHTML = '';

            if (!d || d.code !== 0) {
                const isCF = site.key === 'hanime1' || (d && /cloudflare|403|challenge|verify/i.test(d.msg || ''));
                if (isCF) {
                    grid.innerHTML = `
                        <div class="cf-helper-box" style="grid-column:1/-1;margin:40px auto;max-width:560px;padding:26px 24px;border-radius:18px;background:color-mix(in srgb, var(--primary) 12%, var(--card-bg));border:1px solid var(--primary);text-align:center;">
                            <div style="font-size:38px;margin-bottom:10px;">🛡️</div>
                            <h3 style="font-size:16px;font-weight:700;color:var(--primary);margin-bottom:8px;">${escapeHtml(site.name)} 需要通过人机验证</h3>
                            <p style="font-size:13px;color:var(--text);line-height:1.7;margin-bottom:16px;">
                                该站点已开启 Cloudflare 防火墙保护。点击下方按钮将自动调起真实浏览器窗口，只需手动打勾一次验证框，系统会自动抓取凭据并在站内恢复正常浏览。
                            </p>
                            <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
                                <button class="btn btn-primary" onclick="window.triggerCFVerification('${escapeHtml((d && d.data && d.data.addr) || site.url || 'https://hanime1.me')}')">
                                    🛡️ 一键打开浏览器完成人机验证
                                </button>
                                <button class="btn btn-secondary" onclick="window.location.reload()">
                                    🔄 验证后重试
                                </button>
                            </div>
                        </div>
                    `;
                    foot.innerHTML = '';
                    return;
                }
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

        // round34 批次B：带词打开（榜单「去阅读」联动）→ 直接搜
        if (searchQ && caps.canSearch) {
            load(1, { type: 'search', q: searchQ });
        } else {
            await load(1, { type: 'list' });
        }
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

    /* ======================================================================
       round51：聚合在线搜索（我们自己的展示页）
       痛点：从榜单点「去观看」只能落到某一个站的内嵌网页里，要一源一源手动试，
             而且看到的是别人的页面 —— 逛榜和看片被切成两段。
       做法：一次搜遍当前板块所有「支持应用内搜索」的源，用我们自己的卡片墙
             渐进展示（限并发 2，先回来的先出图），点海报直接 resolve 后在
             应用内播放；每个源仍保留「应用内开原站 / 浏览器打开」两条退路。
       数据来自现有后端 /api/webview/list（真浏览器进站搜索→回结构化卡片）。
       ====================================================================== */
    const HUB_CONCURRENCY = 2;
    const HUB_BROWSE_LIMIT = 16;   // 浏览模式每源取多少条（多了慢，少了不成墙）
    const BOARD_VIEW = { anime: 'watch-anime', av: 'watch', hanime: 'watch-hanime', comic: 'watch-comic', novel: 'watch-novel' };
    const HUB_BOARDS = [['anime', '🌸 动漫'], ['av', '📺 AV'], ['hanime', '🔞 里番'], ['comic', '📚 漫画'], ['novel', '📖 小说']];

    // ================= round53：收藏夹 =================
    // 在线板块 → 收藏板块的默认落点（av/hanime 没有专门板块，落「其他网页」，弹窗里可改）。
    const FAV_BOARD_OF = { anime: 'anime', comic: 'comic', novel: 'novel', av: 'web', hanime: 'web' };
    const FAV_BOARDS = [['anime', '想看的动漫', '🌸'], ['comic', '漫画', '💥'], ['novel', '小说', '📖'], ['game', '想玩的游戏', '🎮'], ['web', '其他网页', '🌐']];

    // 收藏保存弹窗：所有入口（榜单详情 / 收藏本页 / 聚合卡片）都汇到这里。
    // prefill: { board, title, url, coverUrl, note, source }
    window.saveToFav = function (prefill) {
        const p = prefill || {};
        // 已有弹窗就先收掉，避免叠层
        const old = document.getElementById('favSaveModal');
        if (old) old.remove();

        const dm = document.createElement('div');
        dm.id = 'favSaveModal';
        dm.className = 'modal show';
        dm.innerHTML = `
            <div class="modal-box" style="max-width:460px;">
                <h3 style="margin:0 0 14px;">⭐ 收藏到收藏夹</h3>
                <label style="display:block;font-size:12.5px;color:var(--text-muted);margin-bottom:4px;">板块</label>
                <select id="favBoard" style="width:100%;margin-bottom:12px;">
                    ${FAV_BOARDS.map(([b, n]) => `<option value="${b}"${b === (p.board || 'web') ? ' selected' : ''}>${n}</option>`).join('')}
                </select>
                <label style="display:block;font-size:12.5px;color:var(--text-muted);margin-bottom:4px;">标题</label>
                <input id="favTitle" style="width:100%;margin-bottom:12px;" value="${escapeHtml(p.title || '')}" placeholder="没有就先随便起一个，之后能改">
                <label style="display:block;font-size:12.5px;color:var(--text-muted);margin-bottom:4px;">备注（可选）</label>
                <input id="favNote" style="width:100%;margin-bottom:12px;" value="" placeholder="例如：看到第 3 卷 / 朋友推荐">
                ${p.coverUrl ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">🖼 已识别到封面，保存后自动展示</div>` : ''}
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button class="btn btn-secondary" id="favCancel">取消</button>
                    <button class="btn" id="favOk">保存</button>
                </div>
            </div>`;
        document.body.appendChild(dm);

        const close = () => dm.remove();
        dm.querySelector('#favCancel').addEventListener('click', close);
        dm.addEventListener('click', (e) => { if (e.target === dm) close(); });
        dm.querySelector('#favOk').addEventListener('click', async () => {
            // 聚合卡片的封面是签名代理地址（/api/webview/stream?u=<b64url>&...），
            // 重启后签名会变 —— 收藏时把原始远程地址解出来存，展示交给 /api/acg/cover。
            let cover = p.coverUrl || '';
            const m = cover.match(/^\/api\/webview\/stream\?.*?[?&]u=([A-Za-z0-9_-]+)/);
            if (m) {
                try { cover = decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))); } catch (e) { cover = ''; }
            }
            const body = {
                board: dm.querySelector('#favBoard').value,
                title: dm.querySelector('#favTitle').value.trim(),
                note: dm.querySelector('#favNote').value.trim(),
                url: p.url || '',
                coverUrl: cover,
                source: p.source || ''
            };
            if (!body.title && !body.url) { showNotification('标题和地址至少填一个'); return; }
            try {
                const r = await (await fetch('/api/fav/links', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                })).json();
                if (r.code === 0) { showNotification('已收藏', `存进了「${(FAV_BOARDS.find(x => x[0] === body.board) || ['', body.board])[1]}」`); close(); }
                else if (r.code === 2) { showNotification('早就收藏过了', r.msg); close(); }
                else showNotification('收藏失败', r.msg || '');
            } catch (e) { showNotification('收藏失败', e.message); }
        });
        const ti = dm.querySelector('#favTitle');
        if (ti && ti.value) ti.select(); else ti && ti.focus();
    };

    // 点收藏卡在应用内打开：http(s) 地址按 host 找回站点标签；「/站点key/路径」是聚合页存的
    // 代理路径，直接当 startPath 用；两边都认不出 → 外部浏览器。
    window.openFavUrl = async function (url) {
        const u = String(url || '');
        if (!u) return;
        if (u.startsWith('/')) {
            const key = u.slice(1).split('/')[0];
            if (WATCH_SITES.some((s) => s.key === key)) {
                if (typeof window.switchView === 'function') {
                    const site = WATCH_SITES.find((s) => s.key === key);
                    window.switchView(Object.keys(BOARD_OF_VIEW).find((v) => BOARD_OF_VIEW[v] === (site.board || 'av')) || 'watch');
                }
                await showWatch(Object.keys(BOARD_OF_VIEW).find((v) => BOARD_OF_VIEW[v] === (WATCH_SITES.find((s) => s.key === key).board || 'av')) || 'watch');
                await openWatchTab(key, null, { startPath: u });
                return;
            }
        } else if (/^https?:\/\//i.test(u)) {
            try {
                const r = await (await fetch('/api/webview/resolve-url?url=' + encodeURIComponent(u))).json();
                if (r.code === 0 && r.data && r.data.key) {
                    const key = r.data.key;
                    const site = WATCH_SITES.find((s) => s.key === key);
                    const vn = Object.keys(BOARD_OF_VIEW).find((v) => BOARD_OF_VIEW[v] === (site ? site.board : 'av')) || 'watch';
                    if (typeof window.switchView === 'function') window.switchView(vn);
                    await showWatch(vn);
                    await openWatchTab(key, null, { startPath: '/' + key + (r.data.path === '/' ? '/' : r.data.path) });
                    return;
                }
            } catch (e) { /* 落外部 */ }
        }
        window.open(u, '_blank', 'noopener');
    };


    // mode: 'search' 走各站的搜索页（要 canSearch）；'browse' 走各站首页/最新（要 canList）。
    // 浏览模式是 round52 加的：聚合页不能只在用户输完关键词后才有内容 ——
    // 打开就该是我们自己的一面墙（这正是「没有一个我们自己的展示页」那条诉求的核心）。
    function hubSites(board, mode) {
        const want = mode === 'browse' ? 'canList' : 'canSearch';
        return WATCH_SITES.filter((s) => (s.board || 'av') === board
            && ((SITE_CAPS[s.key] || {})[want] || (SITE_CAPS[s.key] || {}).canSearch)
            && !s.hub);
    }

    async function showWatchHub(viewName, q) {
        await loadCaps();
        const board0 = BOARD_OF_VIEW[viewName] || 'av';
        const view = $('#featureView');
        view.style.display = 'block';
        let hubBoard = board0;
        let seq = 0;                     // 搜索代次：切板块/重搜后，旧回包一律作废

        view.innerHTML = `
            <div class="hub-wrap">
                <div class="hub-bar">
                    <div class="hub-boards">
                        ${HUB_BOARDS.map(([b, n]) => `<button class="hub-board${b === board0 ? ' on' : ''}" data-board="${b}">${n}</button>`).join('')}
                    </div>
                    <input id="hubQ" class="hub-input" type="search" placeholder="番号 / 片名 / 演员 —— 一次搜遍所有在线源" value="${escapeHtml(q || '')}">
                    <button class="btn btn-sm" id="hubGo">🔍 搜遍全部源</button>
                    <button class="btn btn-sm btn-secondary" id="hubBrowse" title="不输关键词，直接看各站当前最新的内容">🧭 看看最新</button>
                    <span class="hub-stat" id="hubStat"></span>
                </div>
                <div class="hub-results" id="hubResults">
                    <div class="hub-empty">
                        <b>这里是我们自己的展示墙</b><br>
                        进来先看各站当前最新；想找具体片子就在上面输关键词，
                        一次搜遍该板块所有在线源，点海报直接在应用内播放（不用一源一源去试）。
                    </div>
                </div>
            </div>`;

        const res = $('#hubResults');
        const stat = $('#hubStat');

        // 切板块：清空结果，若已有词立刻重搜
        view.querySelectorAll('.hub-board').forEach((b) => {
            b.addEventListener('click', () => {
                view.querySelectorAll('.hub-board').forEach((x) => x.classList.remove('on'));
                b.classList.add('on');
                hubBoard = b.dataset.board;
                const w = ($('#hubQ') || {}).value || '';
                seq++;
                res.innerHTML = `<div class="hub-empty">已切到「${({ anime: '动漫', av: 'AV', hanime: '里番', comic: '漫画', novel: '小说' })[hubBoard]}」板块${w.trim() ? '，正在重新搜索…' : '，正在取各站最新…'}</div>`;
                stat.textContent = '';
                // round52：没词不再干等 —— 直接铺一面「该板块各站最新」的墙
                runHubSearch(w, w.trim() ? 'search' : 'browse');
            });
        });

        // 应用内开原站（保留老路径：进站点窗口并带词搜索）
        const openInWindow = async (key, word) => {
            const vn = BOARD_VIEW[hubBoard] || 'watch';
            if (typeof window.switchView === 'function') window.switchView(vn);
            await showWatch(vn);
            await openWatchTab(key, word);
        };

        /** mode: 'search'（带词搜索）| 'browse'（直接看各站最新）。不给 mode 时按有没有词自动判。 */
        async function runHubSearch(word, mode) {
            const w = String(word || '').trim();
            const browsing = mode === 'browse' || (!mode && !w);
            if (!browsing && !w) { showNotification('请输入关键词', '番号 / 片名 / 演员都可以'); return; }
            // 隐私纪律：隐藏成人内容时，AV / 里番板块的在线搜索一并关掉。
            // （聚合页本身不整体归为成人入口 —— 它默认落动漫/漫画，否则从动漫榜单点「去观看」会被误拦。）
            if ((hubBoard === 'av' || hubBoard === 'hanime')
                && typeof isAdultNavHidden === 'function' && isAdultNavHidden()) {
                res.innerHTML = '<div class="hub-empty">当前处于「隐藏成人内容」状态，AV / 里番的在线内容已关闭。<br>可在 设置 → 隐私内容 里开启，或点顶栏 🔒 解锁。</div>';
                stat.textContent = '';
                return;
            }
            const my = ++seq;
            const sites = hubSites(hubBoard, browsing ? 'browse' : 'search');
            if (!sites.length) {
                res.innerHTML = '<div class="hub-empty">这个板块没有可用的在线源，可以切到别的板块，或用站点栏里的内嵌窗口。</div>';
                return;
            }

            res.innerHTML = sites.map((s) => `
                <section class="hub-src" data-key="${s.key}">
                    <header>
                        <i class="hub-dot wait"></i><b>${escapeHtml(s.name)}</b>
                        <span class="hub-note">排队中…</span>
                        <span class="sp"></span>
                        <button class="hub-mini" data-tab="${s.key}">应用内开原站</button>
                        <a class="hub-mini" href="${escapeHtml((s.addrs && s.addrs[0]) || s.url || '#')}" target="_blank" rel="noopener">浏览器 ↗</a>
                    </header>
                    <div class="hub-grid"></div>
                </section>`).join('');

            res.querySelectorAll('button[data-tab]').forEach((b) => {
                b.addEventListener('click', () => openInWindow(b.dataset.tab, w));
            });

            let done = 0, hits = 0;
            // round56（用户需求）：带词搜索时，首个命中源的结果一出来就自动
            // 「应用内开原站」（进站点窗口带词），不用再手动点一遍。
            // browse 模式不触发；聚合视图保留在背后，自动进站失败时切回来还能看到结果墙。
            let autoOpened = false;
            const paint = (final) => {
                const tail = browsing ? `已拿到 ${hits} 条` : `已命中 ${hits} 条`;
                stat.textContent = final
                    ? `完成：${done} 个源 · ${browsing ? '共' : '命中'} ${hits} 条`
                      + (!hits ? (browsing ? '（都没取到，可能是源暂时挂了）' : '（都没命中，可能是源暂时挂了或该站没有这条）') : '')
                    : `${browsing ? '取最新' : '搜索中'} ${done}/${sites.length} · ${tail}`;
            };
            paint(false);

            const queue = sites.slice();
            const worker = async () => {
                while (queue.length) {
                    const site = queue.shift();
                    if (my !== seq) return;
                    const sec = res.querySelector(`.hub-src[data-key="${site.key}"]`);
                    if (!sec) return;
                    const dot = sec.querySelector('.hub-dot');
                    const note = sec.querySelector('.hub-note');
                    const grid = sec.querySelector('.hub-grid');
                    dot.className = 'hub-dot load';
                    note.textContent = (browsing ? '正在取该站最新…' : '搜索中…') + '（首次进站约 15 秒）';

                    const url = browsing
                        ? `/api/webview/list?site=${encodeURIComponent(site.key)}&limit=${HUB_BROWSE_LIMIT}`
                        : `/api/webview/list?site=${encodeURIComponent(site.key)}&q=${encodeURIComponent(w)}&limit=24`;
                    let d = null;
                    let timedOut = false;
                    try {
                        const ctrl = new AbortController();
                        const to = setTimeout(() => { timedOut = true; ctrl.abort(); }, 18000);
                        const resp = await fetch(url, { signal: ctrl.signal });
                        clearTimeout(to);
                        d = await resp.json();
                    } catch (e) {
                        if (timedOut) d = { code: -1, msg: '请求超时（源站未在18秒内响应）' };
                    }
                    if (my !== seq) return;
                    done++;

                    const items = (d && d.code === 0 && d.data && d.data.items) || [];
                    if (items.length) {
                        hits += items.length;
                        dot.className = 'hub-dot ok';
                        note.textContent = `${items.length} 条`;
                        grid.innerHTML = items.map((it) => `
                            <div class="hub-card" data-play="${escapeHtml(it.href)}" data-ph="${escapeHtml(site.name)}" title="${escapeHtml(it.title || '')}">
                                <img src="${escapeHtml(it.cover)}" loading="lazy" alt="" onerror="this.closest('.hub-card').classList.add('noimg')">
                                <button class="hub-fav" data-fav="1" title="收藏到收藏夹">⭐</button>
                                <div class="t">${escapeHtml(it.title || '')}</div>
                            </div>`).join('');
                        grid.querySelectorAll('.hub-card').forEach((el) => {
                            el.addEventListener('click', (e) => {
                                // ⭐ 不触发播放（round53：聚合结果也能一键进收藏夹）
                                if (e.target && e.target.closest && e.target.closest('.hub-fav')) {
                                    e.stopPropagation();
                                    const img = el.querySelector('img');
                                    window.saveToFav({
                                        board: FAV_BOARD_OF[hubBoard] || 'web',
                                        title: (el.querySelector('.t') || {}).textContent || '',
                                        url: el.dataset.play,
                                        coverUrl: img && !el.classList.contains('noimg') ? img.src : '',
                                        source: el.dataset.ph
                                    });
                                    return;
                                }
                                playWebPage(el.dataset.play);
                            });
                        });
                        // round56：首个命中源 → 自动进站点窗口（搜索结果出来就打开，省一次手动点击）
                        if (!browsing && !autoOpened && my === seq) {
                            autoOpened = true;
                            openInWindow(site.key, w);
                        }
                    } else {
                        dot.className = 'hub-dot bad';
                        note.textContent = (browsing ? '没取到' : '没搜到') + (d && d.msg ? '（' + d.msg + '）' : '');
                    }
                    paint(false);
                }
            };
            await Promise.all(Array.from({ length: Math.min(HUB_CONCURRENCY, sites.length) }, worker));
            if (my !== seq) return;
            paint(true);
        }

        const val = () => ($('#hubQ') || {}).value || '';
        const go = () => {
            const w = val();
            runHubSearch(w, w.trim() ? 'search' : 'browse');
        };
        const goBtn = $('#hubGo');
        if (goBtn) goBtn.addEventListener('click', go);
        const browseBtn = $('#hubBrowse');
        if (browseBtn) browseBtn.addEventListener('click', () => runHubSearch('', 'browse'));
        const qi = $('#hubQ');
        if (qi) qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        // round52：进来就先铺一面墙（有词则直接搜）
        runHubSearch(q || '', q && String(q).trim() ? 'search' : 'browse');
    }

    // ================= 导出 =================
    /* round51：榜单/首页「去观看」的新落点 —— 我们自己的聚合搜索页。
       老的「跳进某个站的内嵌网页再搜」仍保留在 hub 每行的「应用内开原站」里。 */
    window.openWatchHub = function (viewName, q) {
        window.__hubView = viewName || 'watch-anime';
        window.__hubPendingQ = String(q || '');
        if (typeof window.switchView === 'function') window.switchView('watch-hub');
    };

    window.openWatchWithSearch = async function (viewName, q) {
        if (!q) return;
        window.openWatchHub(viewName, q);
    };

    window.Features = {
        loadProgressMap,
        saveProgress,
        resumeProgress,
        renderProfile,
        showFailures,
        showAnnual,
        showPosterHealth,
        requestPosterHealthResume,
        showWatch,
        showWatchHub,
        playWebPage,
        loadFailureCount
    };
})();
