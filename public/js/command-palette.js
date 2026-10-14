/* ============================================================
   command-palette.js — Ctrl+K 全局命令面板
   FTS5 全文搜索影片 + 视图跳转 + 快捷动作
   依赖 app.js 的全局：switchView / showMovieDetail / getPosterUrl / escapeHtml
   ============================================================ */
(function () {
    'use strict';

    let cpItems = [];       // 当前候选
    let cpIndex = 0;        // 键盘高亮位置
    let cpTimer = null;

    const overlay = () => document.getElementById('cpOverlay');
    const input = () => document.getElementById('cpInput');
    const results = () => document.getElementById('cpResults');

    const QUICK_ACTIONS = [
        { glyph: '🎬', title: '全部影片', sub: '视图', run: () => switchView('movies') },
        { glyph: '🎥', title: '影片库', sub: '视图', run: () => switchView('jav') },
        { glyph: '🎌', title: '动漫库', sub: '视图', run: () => switchView('anime') },
        { glyph: '📚', title: '漫画库', sub: '视图', run: () => switchView('comic') },
        { glyph: '📖', title: '小说库', sub: '视图', run: () => switchView('novel') },
        { glyph: '⭐', title: '我的收藏', sub: '视图', run: () => switchView('favorites') },
        { glyph: '👩', title: '演员库', sub: '视图', run: () => switchView('actresses') },
        { glyph: '🏷️', title: '标签库', sub: '视图', run: () => switchView('tags') },
        { glyph: '📋', title: '播放列表', sub: '视图', run: () => switchView('playlists') },
        { glyph: '🎲', title: '随机来一部', sub: '动作', run: () => switchView('random') },
        { glyph: '✨', title: '猜你喜欢', sub: '视图', run: () => switchView('guess') },
        { glyph: '📈', title: '年度观影报告', sub: '视图', run: () => switchView('annual') },
        { glyph: '⚠️', title: '刮削失败清单', sub: '视图', run: () => switchView('scrape-failures') },
        { glyph: '🔔', title: '新作监视', sub: '视图', run: () => switchView('new-releases') },
        { glyph: '⚙️', title: '设置', sub: '视图', run: () => switchView('settings') }
    ];

    function openPalette() {
        overlay().classList.add('show');
        input().value = '';
        renderQuick('');
        setTimeout(() => input().focus(), 30);
    }

    function closePalette() {
        overlay().classList.remove('show');
    }

    function renderQuick(q) {
        // 无关键词时展示常用动作
        const list = q
            ? QUICK_ACTIONS.filter(a => a.title.toLowerCase().includes(q.toLowerCase()))
            : QUICK_ACTIONS.slice(0, 8);
        cpItems = [
            ...list.map(a => ({ kind: 'action', ...a })),
            ...searchLocal(q)
        ];
        cpIndex = 0;
        paint(q);
    }

    // 用已加载的列表做本地兜底匹配（FTS 请求返回前的即时反馈）
    function searchLocal(q) {
        if (!q || !window.currentMovies) return [];
        const ql = q.toLowerCase();
        return window.currentMovies
            .filter(m => {
                const t = (m.title || '') + (m.avid || '') + (m.fileName || '');
                return t.toLowerCase().includes(ql);
            })
            .slice(0, 6)
            .map(m => ({
                kind: 'movie',
                id: m.id,
                title: m.title || m.fileName,
                sub: [m.avid, m.duration ? formatDuration(m.duration) : ''].filter(Boolean).join(' · '),
                type: m.type || 'jav',
                poster: getPosterUrl(m)
            }));
    }

    async function search(q) {
        if (!q) { renderQuick(''); return; }
        let ftsResults = [];
        try {
            const res = await fetch(`/api/movie/fts-search?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            if (data.code === 0) {
                ftsResults = (data.data || []).map(m => ({
                    kind: 'movie',
                    id: m.id,
                    title: m.title || m.fileName,
                    sub: [m.avid, m.duration ? formatDuration(m.duration) : ''].filter(Boolean).join(' · '),
                    type: m.type || 'jav',
                    poster: getPosterUrl(m)
                }));
            }
        } catch (e) { }
        const actions = QUICK_ACTIONS.filter(a => a.title.toLowerCase().includes(q.toLowerCase()));
        cpItems = [
            ...ftsResults.map(r => ({ kind: 'movie', ...r })),
            ...actions.map(a => ({ kind: 'action', ...a }))
        ];
        cpIndex = 0;
        paint(q);
    }

    function paint(q) {
        const box = results();
        if (!cpItems.length) {
            box.innerHTML = `<div class="cp-empty">没有匹配「${escapeHtml(q)}」的结果</div>`;
            return;
        }
        let html = '';
        let lastKind = '';
        cpItems.forEach((item, i) => {
            if (item.kind !== lastKind) {
                html += `<div class="cp-group-label">${item.kind === 'movie' ? '影片' : '快捷'}</div>`;
                lastKind = item.kind;
            }
            html += `
                <div class="cp-item ${i === cpIndex ? 'hl' : ''}" data-index="${i}">
                    ${item.kind === 'movie'
                    ? (item.poster
                        ? `<img class="cp-item-poster" src="${item.poster}" alt="">`
                        : `<span class="cp-item-glyph">🎞️</span>`)
                    : `<span class="cp-item-glyph">${item.glyph}</span>`}
                    <div class="cp-item-main">
                        <div class="cp-item-title">${escapeHtml(item.title)}</div>
                        ${item.sub ? `<div class="cp-item-sub">${escapeHtml(item.sub)}</div>` : ''}
                    </div>
                    <span class="cp-item-type">${item.kind === 'movie' ? item.type : ''}</span>
                </div>
            `;
        });
        box.innerHTML = html;
        box.querySelectorAll('.cp-item').forEach(el => {
            el.addEventListener('click', () => activate(parseInt(el.dataset.index)));
            el.addEventListener('mousemove', () => {
                cpIndex = parseInt(el.dataset.index);
                box.querySelectorAll('.cp-item').forEach(x => x.classList.remove('hl'));
                el.classList.add('hl');
            });
        });
        // 高亮项滚入视野
        const hl = box.querySelector('.cp-item.hl');
        if (hl) hl.scrollIntoView({ block: 'nearest' });
    }

    function activate(i) {
        const item = cpItems[i];
        if (!item) return;
        closePalette();
        if (item.kind === 'movie') {
            showMovieDetail(item.id);
        } else {
            item.run();
        }
    }

    function onKeyDown(e) {
        const isOpen = overlay().classList.contains('show');
        // Ctrl+K / Cmd+K 全局开关
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            isOpen ? closePalette() : openPalette();
            return;
        }
        if (!isOpen) return;

        if (e.key === 'Escape') {
            e.preventDefault();
            closePalette();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            cpIndex = Math.min(cpIndex + 1, cpItems.length - 1);
            paint(input().value.trim());
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            cpIndex = Math.max(cpIndex - 1, 0);
            paint(input().value.trim());
        } else if (e.key === 'Enter') {
            e.preventDefault();
            activate(cpIndex);
        }
    }

    function bind() {
        const ov = overlay();
        if (!ov) return;
        // 点击遮罩关闭
        ov.addEventListener('click', (e) => {
            if (e.target === ov) closePalette();
        });
        input().addEventListener('input', () => {
            const q = input().value.trim();
            clearTimeout(cpTimer);
            // 先给本地即时反馈，再等 FTS
            if (!q) { renderQuick(''); return; }
            renderQuick(q);
            cpTimer = setTimeout(() => search(q), 160);
        });
        document.addEventListener('keydown', onKeyDown);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
