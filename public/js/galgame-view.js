// ================================================================
// galgame-view.js —— GALGAME 资料库（Kungal 主源 / InariGal 直链 / TouchGal 外链）
//
//   左：作品列表（海报卡）｜右：作品详情 + 资源列表
//   资源 → 下载面板（网盘链接/提取码/解压密码 或 Inari 直链）
//
//   TouchGal 整站被 Cloudflare Managed Challenge 挡死（含 /api），
//   在接入 developer.touchgal.com 的 tgal_ Token 之前只做外部入口，
//   不假装能抓取；Kungal 与它是同一生态（Kungal 官方源码即 kun-galgame-forum）。
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

    const G = {
        built: false,
        src: 'kungal',
        sort: 'resource_updated_desc',
        nsfw: false,
        q: '',
        page: 1,
        items: [],
        detail: null,
        seq: 0,
        loading: false,
        sources: null,
    };

    function root() { return document.getElementById('galgameView'); }
    function q(sel) { return root() && root().querySelector(sel); }

    function adultUnlocked() {
        return !(typeof window.isAdultNavHidden === 'function' && window.isAdultNavHidden());
    }

    function build() {
        const r = root();
        if (!r || G.built) return;
        G.nsfw = adultUnlocked();   // 已解锁的用户默认带上 R18；未解锁永远不带
        r.innerHTML = '<div class="gal-page">'
            + '<header class="wk-head">'
            + '<div class="wk-head-copy"><h2>Galgame 资料库</h2><p>Kungal 社区库 · InariGal 直链 · 原生下载面板</p></div>'
            + '<form class="wk-search" id="galForm">'
            + '<input id="galInput" type="search" placeholder="搜索作品，例如：白色相簿2、秽翼的尤斯蒂娅" autocomplete="off">'
            + '<button type="submit">搜索</button></form></header>'
            + '<div class="gal-toolbar">'
            + '<div class="gal-src-tabs" id="galSrcTabs">'
            + '<button data-gal-src="kungal" class="active">Kungal 作品库</button>'
            + '<button data-gal-src="inari">InariGal 下载榜</button>'
            + '<button data-gal-src="touchgal">TouchGal ↗</button>'
            + '</div>'
            + '<select id="galSort" aria-label="排序">'
            + '<option value="resource_updated_desc">最近更新</option>'
            + '<option value="rating_desc">评分最高</option>'
            + '<option value="released_desc">最新发售</option>'
            + '<option value="view_desc">最多浏览</option>'
            + '</select>'
            + '<label class="gal-nsfw" id="galNsfwWrap"><input type="checkbox" id="galNsfw"> 显示 R18</label>'
            + '</div>'
            + '<div class="gal-body">'
            + '<aside class="gal-list" id="galList"><div class="wk-loading"><span class="wk-spin"></span>加载作品库…</div></aside>'
            + '<section class="gal-detail" id="galDetail"><div class="wk-welcome">'
            + '<div class="wk-welcome-icon">💗</div><h3>Galgame 资料库</h3>'
            + '<p>左边选一部作品查看简介、截图与社区资源；资源支持网盘链接（Kungal）与直链下载（InariGal）。<br>'
            + '后续会在这里内置 Galgame 模拟器，实现下载/一键安装/直接游玩。</p>'
            + '</div></section>'
            + '</div></div>'
            + '<div id="galDlHost"></div>';
        G.built = true;

        const nsfwWrap = q('#galNsfwWrap');
        const nsfwBox = q('#galNsfw');
        if (nsfwWrap) nsfwWrap.style.display = adultUnlocked() ? '' : 'none';
        if (nsfwBox) {
            nsfwBox.checked = G.nsfw;
            nsfwBox.addEventListener('change', () => { G.nsfw = nsfwBox.checked; G.page = 1; loadList(); });
        }
        const form = q('#galForm');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            G.q = q('#galInput').value.trim();
            G.page = 1;
            loadList();
        });
        q('#galSrcTabs').addEventListener('click', (e) => {
            const b = e.target.closest('[data-gal-src]');
            if (!b) return;
            G.src = b.getAttribute('data-gal-src');
            q('#galSrcTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
            if (G.src === 'touchgal') {
                renderTouchGal();
                return;
            }
            q('#galSort').style.display = G.src === 'kungal' ? '' : 'none';
            G.detail = null;
            G.page = 1;
            loadList();
        });
        q('#galSort').addEventListener('change', () => {
            G.sort = q('#galSort').value;
            G.page = 1;
            loadList();
        });
        q('#galList').addEventListener('click', (e) => {
            const card = e.target.closest('[data-gal-id]');
            if (card) openDetail(card.getAttribute('data-gal-source') || G.src, card.getAttribute('data-gal-id'));
        });
        q('#galDetail').addEventListener('click', (e) => {
            const res = e.target.closest('[data-gal-res]');
            if (res) {
                getDownload(res.getAttribute('data-gal-source') || 'kungal', res.getAttribute('data-gal-res'));
                return;
            }
            const shot = e.target.closest('[data-gal-shot]');
            if (shot) {
                const src = shot.getAttribute('data-gal-shot');
                const big = q('#galShotBig');
                if (big) { big.src = src; big.style.display = ''; }
            }
        });
    }

    async function loadList() {
        if (G.src === 'touchgal') { renderTouchGal(); return; }
        const box = q('#galList');
        if (box) box.innerHTML = '<div class="wk-loading"><span class="wk-spin"></span>加载中…</div>';
        G.loading = true;
        try {
            let url;
            if (G.src === 'inari') {
                url = '/api/galgame/' + (G.q
                    ? 'list?source=inari&page=' + G.page + '&limit=30&q=' + encodeURIComponent(G.q) + (G.nsfw ? '&nsfw=1' : '')
                    : 'rank?source=inari' + (G.nsfw ? '&nsfw=1' : ''));
            } else {
                url = '/api/galgame/list?source=kungal&page=' + G.page + '&limit=24'
                    + '&sort=' + encodeURIComponent(G.sort)
                    + (G.q ? '&q=' + encodeURIComponent(G.q) : '')
                    + (G.nsfw ? '&nsfw=1' : '');
            }
            const r = await api(url, { timeout: 45000 });
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '加载失败');
            G.items = (r.data && r.data.items) || [];
            renderList(r.data || {});
        } catch (e) {
            if (box) box.innerHTML = '<div class="wk-error">' + esc(e.message) + '</div>';
        } finally { G.loading = false; }
    }

    function renderList(data) {
        const box = q('#galList');
        if (!box) return;
        if (!G.items.length) {
            box.innerHTML = '<div class="wk-placeholder">没有找到作品。<br>换个关键词，或切换来源试试。</div>';
            return;
        }
        const total = Number(data.total) || G.items.length;
        box.innerHTML = '<div class="wk-side-label">作品 · ' + (total > G.items.length ? G.items.length + ' / ' + total : total) + '</div>'
            + G.items.map((w) => {
                const rating = w.rating && w.rating.score ? '★ ' + Number(w.rating.score).toFixed(1) : '';
                const meta = [rating, w.date ? String(w.date).slice(0, 4) : '', w.maker].filter(Boolean).join(' · ');
                const dl = w.downloads ? '↓ ' + w.downloads : '';
                return '<button class="gal-card' + (G.detail && G.detail.id === w.id ? ' active' : '') + '"'
                    + ' data-gal-id="' + esc(w.id) + '" data-gal-source="' + esc(w.source) + '">'
                    + '<span class="gal-cover">' + (w.cover
                        ? '<img src="' + esc(w.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
                        : '<i class="gal-cover-ph"></i>')
                    + (w.nsfw && G.nsfw ? '<em class="gal-r18">R18</em>' : '') + '</span>'
                    + '<span class="gal-card-copy"><b>' + esc(w.title) + '</b>'
                    + (w.titleJp && w.titleJp !== w.title ? '<small class="gal-jp">' + esc(w.titleJp) + '</small>' : '')
                    + '<small>' + esc(meta || '—') + (dl ? ' · ' + esc(dl) : '') + '</small></span>'
                    + '</button>';
            }).join('')
            + (data.total && G.items.length < Math.min(Number(data.total), 240)
                ? '<button class="gal-more" data-gal-more="1">加载更多</button>' : '');
        const more = box.querySelector('[data-gal-more]');
        if (more) more.addEventListener('click', () => { G.page += 1; loadList(); });
    }

    function renderTouchGal() {
        const box = q('#galList');
        const dt = q('#galDetail');
        if (box) {
            box.innerHTML = '<div class="wk-side-label">外部站点</div>'
                + '<a class="gal-linkcard" href="https://www.touchgal.ink/" target="_blank" rel="noopener noreferrer">'
                + '<b>TouchGal</b><small>Cloudflare 保护 · 需开发者 Token 才能站内接入</small></a>';
        }
        if (dt) {
            dt.innerHTML = '<div class="wk-art"><div class="wk-art-kicker">外部来源</div>'
                + '<h1>TouchGal</h1>'
                + '<p class="gal-note">TouchGal 整站（含 <code>/api</code>）使用 Cloudflare Managed Challenge，'
                + '纯 HTTP 与无头浏览器都会返回 403。要站内接入需要先在 '
                + '<a href="https://developer.touchgal.com/" target="_blank" rel="noopener noreferrer">developer.touchgal.com</a> '
                + '申请 <code>tgal_</code> 开头的开发者 Token，配置后即可启用搜索/详情。</p>'
                + '<p class="gal-note">当前 Galgame 页已用 Kungal（同一生态，官方源码即 '
                + '<a href="https://github.com/KunMoe/kun-galgame-forum" target="_blank" rel="noopener noreferrer">kun-galgame-forum</a>）'
                + '覆盖作品库与网盘资源，InariGal 覆盖直链下载。</p>'
                + '<div class="wk-art-actions"><a class="svd-btn" href="https://www.touchgal.ink/" target="_blank" rel="noopener noreferrer">打开 TouchGal ↗</a>'
                + '<a class="svd-btn" href="https://github.com/KunMoe/kun-galgame-forum" target="_blank" rel="noopener noreferrer">KunMoe 仓库 ↗</a></div>'
                + '</div>';
        }
    }

    async function openDetail(source, id) {
        const dt = q('#galDetail');
        if (!dt || !id) return;
        dt.innerHTML = '<div class="wk-loading"><span class="wk-spin"></span>打开作品…</div>';
        const seq = ++G.seq;
        try {
            const [d, res] = await Promise.all([
                api('/api/galgame/detail?source=' + encodeURIComponent(source) + '&id=' + encodeURIComponent(id), { timeout: 45000 }),
                source === 'kungal'
                    ? api('/api/galgame/resources?id=' + encodeURIComponent(id), { timeout: 45000 }).catch(() => null)
                    : Promise.resolve(null),
            ]);
            if (seq !== G.seq) return;
            if (!d || d.code !== 0 || !d.data) throw new Error((d && d.msg) || '打开失败');
            G.detail = d.data;
            const resources = (d.data.resources && d.data.resources.length)
                ? d.data.resources
                : ((res && res.code === 0 && res.data && res.data.items) || []);
            renderDetail(d.data, resources);
        } catch (e) {
            if (seq !== G.seq) return;
            dt.innerHTML = '<div class="wk-error">打开失败：' + esc(e.message) + '</div>';
        }
    }

    function renderDetail(d, resources) {
        const dt = q('#galDetail');
        if (!dt) return;
        const rating = d.rating && d.rating.score ? Number(d.rating.score).toFixed(1) : '';
        const meta = [
            rating ? '<span class="gal-score">★ ' + esc(rating) + '</span>' : '',
            d.date ? '<span>' + esc(String(d.date).slice(0, 10)) + '</span>' : '',
            d.maker ? '<span>' + esc(d.maker) + '</span>' : '',
            (d.nsfw && G.nsfw) ? '<span class="gal-r18-chip">R18</span>' : '',
        ].filter(Boolean).join('<i class="svd-dot"></i>');
        const tags = (d.tags || []).map((t) => '<span class="gal-tag">' + esc(t) + '</span>').join('');
        const intro = String(d.intro || '').split(/\n+/).filter(Boolean)
            .map((p) => '<p>' + esc(p) + '</p>').join('');
        const shots = (d.screenshots || []).length
            ? '<div class="gal-shots">' + d.screenshots.map((s) =>
                '<button class="gal-shot" data-gal-shot="' + esc(s) + '"><img src="' + esc(s) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></button>').join('') + '</div>'
            : '';
        const chars = (d.characters || []).length
            ? '<div class="gal-chars">' + d.characters.map((c) =>
                '<div class="gal-char">' + (c.image ? '<img src="' + esc(c.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '')
                + '<b>' + esc(c.name) + '</b><small>' + esc(c.role || '') + '</small></div>').join('') + '</div>'
            : '';
        dt.innerHTML = '<div class="gal-art">'
            + '<header class="gal-head">'
            + '<div class="gal-poster-lg">' + (d.cover
                ? '<img src="' + esc(d.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add(\'broken\')">' : '')
            + '</div>'
            + '<div class="gal-head-copy">'
            + '<div class="wk-art-kicker">' + esc(d.source === 'inari' ? 'InariGal' : 'Kungal') + ' 资料</div>'
            + '<h1>' + esc(d.title) + '</h1>'
            + (d.titleJp && d.titleJp !== d.title ? '<div class="gal-title-jp">' + esc(d.titleJp) + '</div>' : '')
            + '<div class="wk-art-meta">' + meta + '</div>'
            + (tags ? '<div class="gal-tags">' + tags + '</div>' : '')
            + (d.aliases && d.aliases.length ? '<div class="gal-alias">别名：' + esc(d.aliases.slice(0, 4).join(' / ')) + '</div>' : '')
            + '</div></header>'
            + (intro ? '<div class="gal-intro">' + intro + '</div>' : '')
            + shots
            + (chars ? '<h3 class="gal-h3">角色</h3>' + chars : '')
            + '<h3 class="gal-h3">资源 · ' + resources.length + '</h3>'
            + (resources.length ? '<div class="gal-res-list">' + resources.map((r) => {
                const meta2 = [r.groupLabel, (r.platforms || []).join('/'), r.size,
                    (r.providers || []).join('/'), r.downloads ? '↓ ' + r.downloads : ''].filter(Boolean).join(' · ');
                return '<div class="gal-res">'
                    + '<div class="gal-res-main"><b>' + esc(r.title || '资源') + '</b>'
                    + '<small>' + esc(meta2) + '</small>'
                    + (r.note ? '<p>' + esc(r.note) + '</p>' : '')
                    + (r.password ? '<small class="gal-pwd">解压密码：' + esc(r.password) + '</small>' : '')
                    + '</div>'
                    + '<button class="gal-dl" data-gal-res="' + esc(r.id) + '" data-gal-source="' + esc(r.source || d.source) + '">'
                    + (r.source === 'inari' ? '直链下载' : '获取下载') + '</button>'
                    + '</div>';
            }).join('') + '</div>'
                : '<div class="wk-placeholder">这个作品还没有资源。可以换一部，或稍后再看。</div>')
            + '<div id="galShotBigWrap" class="gal-shot-big"><img id="galShotBig" alt="" style="display:none"></div>'
            + '</div>';
        // 列表里高亮当前作品
        q('#galList') && q('#galList').querySelectorAll('.gal-card').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-gal-id') === String(d.id));
        });
    }

    async function getDownload(source, resourceId) {
        if (!resourceId) return;
        const host = document.getElementById('galDlHost');
        if (!host) return;
        host.innerHTML = '<div class="svd-mask" data-gal-close="1"><div class="gal-dl-modal">'
            + '<div class="wk-loading"><span class="wk-spin"></span>正在获取下载地址…</div></div></div>';
        const close = () => { host.innerHTML = ''; };
        host.querySelectorAll('[data-gal-close="1"]').forEach((el) => el.addEventListener('click', (e) => {
            if (e.target === el) close();
        }));
        try {
            const r = await api('/api/galgame/download', {
                method: 'POST', timeout: 60000,
                body: JSON.stringify({ source: source || 'kungal', resourceId }),
            });
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '获取失败');
            const d = r.data || {};
            const urls = d.urls || [];
            const panel = host.querySelector('.gal-dl-modal');
            if (!panel) return;
            panel.innerHTML = '<div class="gal-dl-head"><h3>下载地址</h3>'
                + '<button class="svd-close" data-gal-close="1">✕</button></div>'
                + '<div class="gal-dl-body">'
                + (urls.length ? urls.map((u, i) => {
                    let label = u;
                    try { label = new URL(u).hostname; } catch (e) { /* 保留原串 */ }
                    return '<div class="gal-dl-row"><span class="gal-dl-host">' + esc(label) + '</span>'
                        + '<a class="gal-dl-open" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">打开 ↗</a>'
                        + '<button class="gal-dl-copy" data-copy="' + esc(u) + '">复制</button></div>';
                }).join('') : '<div class="wk-placeholder">没有拿到下载地址（资源可能已过期）。</div>')
                + (d.code ? '<div class="gal-dl-kv"><span>提取码</span><b>' + esc(d.code) + '</b><button data-copy="' + esc(d.code) + '">复制</button></div>' : '')
                + (d.password ? '<div class="gal-dl-kv"><span>解压密码</span><b>' + esc(d.password) + '</b><button data-copy="' + esc(d.password) + '">复制</button></div>' : '')
                + (d.expired && d.expired.length ? '<div class="gal-dl-warn">另有 ' + d.expired.length + ' 个已过期链接未显示</div>' : '')
                + '<div class="gal-dl-note">链接来自社区（Kungal / InariGal），请自行判断安全性；后续内置模拟器会在这里直接下载/安装/启动。</div>'
                + '</div>';
            panel.querySelectorAll('[data-gal-close="1"]').forEach((el) => el.addEventListener('click', close));
            panel.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
                const text = b.getAttribute('data-copy');
                try { await navigator.clipboard.writeText(text); notify('已复制', text); }
                catch (e) { notify('复制失败', '请手动选中复制'); }
            }));
        } catch (e) {
            const panel = host.querySelector('.gal-dl-modal');
            if (panel) panel.innerHTML = '<div class="wk-error">' + esc(e.message) + '</div>'
                + '<div style="text-align:center;padding-bottom:14px"><button class="svd-btn" data-gal-close="1">关闭</button></div>';
            host.querySelectorAll('[data-gal-close="1"]').forEach((el) => el.addEventListener('click', close));
        }
    }

    function show() {
        const r = root();
        if (!r) return;
        r.style.display = 'block';
        document.body.classList.add('gal-mode');
        build();
        if (!G.items.length && G.src !== 'touchgal') loadList();
    }
    function hide() {
        const r = root();
        if (r) r.style.display = 'none';
        document.body.classList.remove('gal-mode');
        const host = document.getElementById('galDlHost');
        if (host) host.innerHTML = '';
    }

    window.GalgameView = { show, hide };
})();
