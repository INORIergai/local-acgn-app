// ================================================================
// series-view.js —— 追番（v4，Kazumi 式「先选源 → 再全集顺序看」）
//
//   首页：Hero 大 Banner → 本周放送（周一~周日）→ 热门排行 → 我的追番海报墙
//   详情：点番先并发搜全部在线源 → 用户选一个源 → 直接拉这个源的全集
//         → 点集数播放，播完自动下一集（进度写回 episode_progress）
//
//   纪律：
//   · 颜色只取语义令牌（--text/--text-muted/--bg-elevated/--border/--primary）
//   · 事件委托（data-act），不用内联 onclick
//   · 所有渲染入口都要能容忍「接口失败/为空」，绝不把页面卡在加载态
// ================================================================
(function () {
    'use strict';

    const ROOT_ID = 'seriesView';
    const LS_LAST_SRC = 'cv.svLastSource';

    const STATUS_LABELS = { watching: '追番中', planned: '计划看', onhold: '搁置', completed: '已完成', dropped: '抛弃' };
    const STATUS_ORDER = ['watching', 'planned', 'onhold', 'completed', 'dropped'];

    const S = {
        built: false,
        bound: false,
        tab: '',
        board: [],
        calDays: [],
        calItems: [],
        calDay: '',
        calScore: {},
        rank: [],
        heroItems: [],
        heroIndex: 0,
        heroTimer: 0,
        ratings: {},
        ratingTried: {},
        ratingRetried: {},
        detail: null,
        detailSeq: 0,
        sources: [],
        srcSeq: 0,
        epSeq: 0,
        playSeq: 0,
        srcPicked: '',
        season: null,
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const api = async (url, opts) => {
        const o = Object.assign({ credentials: 'same-origin' }, opts || {});
        /* 有 body 的请求必须显式带 JSON Content-Type，否则 express.json() 不解析，req.body = {} */
        if (o.body && typeof o.body === 'string') {
            o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
        }
        const ms = Number(o.timeout) || 20000;
        delete o.timeout;
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        if (ac) {
            o.signal = ac.signal;
            timer = setTimeout(() => ac.abort(), ms);
        }
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

    function root() { return document.getElementById(ROOT_ID); }
    function ensureHost(id) {
        let host = document.getElementById(id);
        if (!host) { host = document.createElement('div'); host.id = id; document.body.appendChild(host); }
        return host;
    }
    const q = (sel) => document.querySelector(sel);

    // ================================================================
    // 评分（Bangumi）
    // ================================================================
    function ratingOf(seriesId) {
        const id = Number(seriesId);
        const r = S.ratings[id];
        if (r && r.score) return r;
        const sc = S.calScore[id];
        return sc ? { score: Number(sc), votes: 0, rank: 0, fallback: true } : null;
    }

    function applyRatings() {
        document.querySelectorAll('[data-rating-sid]').forEach((el) => {
            const r = ratingOf(el.getAttribute('data-rating-sid'));
            if (r && r.score) {
                el.textContent = '★ ' + Number(r.score).toFixed(1);
                el.style.display = '';
                el.title = r.fallback ? '放送表评分' : ('Bangumi 评分' + (r.votes ? ' · ' + r.votes + ' 人评分' : ''));
            } else {
                el.style.display = 'none';
            }
        });
    }

    async function ensureRatings(ids) {
        const need = [...new Set((ids || []).map(Number).filter(Boolean))]
            .filter((id) => S.ratings[id] === undefined && !S.ratingTried[id]);
        if (!need.length) return;
        need.forEach((id) => { S.ratingTried[id] = true; });
        try {
            const r = await api('/api/series/ratings?ids=' + need.slice(0, 60).join(','), { timeout: 35000 });
            if (!r || r.code !== 0 || !r.data) return;
            Object.assign(S.ratings, r.data.ratings || {});
            applyRatings();
            /* 后端预算到点会返回 pending（没来得及查完的）；只补拉一次，避免网络坏时死循环 */
            const pending = (r.data.pending || []).filter((id) => !S.ratingRetried[id]);
            pending.forEach((id) => { S.ratingRetried[id] = true; delete S.ratingTried[id]; });
            if (pending.length) setTimeout(() => ensureRatings(pending), 5000);
        } catch (e) {
            need.forEach((id) => { delete S.ratingTried[id]; });
        }
    }

    // ================================================================
    // 首页数据
    // ================================================================
    async function loadBoard() {
        const box = q('#svBoard');
        if (box && !S.board.length) box.innerHTML = '<div class="sv-empty">加载中…</div>';
        try {
            const r = await api('/api/series/follows');
            S.board = (r && r.code === 0 && Array.isArray(r.data)) ? r.data : [];
        } catch (e) {
            S.board = [];
        }
        renderBoard();
        renderHeadSub();
        ensureRatings(S.board.map((b) => b.id));
    }

    async function loadCalendar(force) {
        const cal = q('#svCalendar');
        if (cal && !S.calDays.length) cal.innerHTML = '<div class="sv-empty-line">加载中…</div>';
        try {
            const r = await api('/api/series/from-calendar' + (force ? '?force=1' : ''), { timeout: 40000 });
            const d = (r && r.code === 0 && r.data) || {};
            S.calItems = Array.isArray(d.items) ? d.items : [];
            S.calDays = Array.isArray(d.days) && d.days.length
                ? d.days
                : groupItemsByDate(S.calItems);
        } catch (e) {
            S.calItems = [];
            S.calDays = [];
        }
        S.calScore = {};
        S.calItems.forEach((it) => {
            if (it.seriesId && it.score) S.calScore[Number(it.seriesId)] = Number(it.score);
        });
        if (!S.calDay || !S.calDays.some((d) => d.date === S.calDay)) {
            S.calDay = S.calDays.length ? S.calDays[0].date : '';
        }
        renderDays();
        renderCalendar();
        S.heroItems = [];
        renderHero();
        renderHeadSub();
        const day = S.calDays.find((d) => d.date === S.calDay);
        ensureRatings(((day && day.items) || []).map((it) => it.seriesId));
    }

    function groupItemsByDate(items) {
        const map = new Map();
        (items || []).forEach((it) => {
            const key = it.date || '';
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(it);
        });
        return [...map.entries()].map(([date, list]) => ({ date, label: date, items: list }));
    }

    async function loadRank(force) {
        const box = q('#svRank');
        if (box && !S.rank.length) box.innerHTML = '<div class="sv-empty-line">加载中…</div>';
        try {
            let r = await api('/api/acg/rank?source=fankuhub' + (force ? '&force=1' : ''), { timeout: 30000 });
            let list = (r && r.code === 0 && r.data && r.data.items) ? r.data.items : [];
            if (!list.length) {
                r = await api('/api/acg/rank?source=acghub' + (force ? '&force=1' : ''), { timeout: 30000 });
                list = (r && r.code === 0 && r.data && r.data.items) ? r.data.items : [];
            }
            S.rank = list.slice(0, 10);
        } catch (e) {
            S.rank = [];
        }
        renderRank();
    }

    function renderHeadSub() {
        const el = q('#svHeadSub');
        if (!el) return;
        const calCount = new Set(S.calItems.map((x) => x.title).filter(Boolean)).size;
        el.textContent = (calCount ? calCount + ' 部本周在播' : '') + (S.board.length ? (calCount ? ' · ' : '') + '已追 ' + S.board.length + ' 部' : '');
    }

    // ================================================================
    // 首页渲染
    // ================================================================
    function renderHero() {
        const el = q('#svHero');
        if (!el) return;
        if (S.heroTimer) { clearInterval(S.heroTimer); S.heroTimer = 0; }
        if (!S.heroItems.length) {
            const seen = new Set();
            const pool = S.calItems.filter((it) => it.cover && it.seriesId).filter((it) => {
                const k = String(it.title || '').trim();
                if (!k || seen.has(k)) return false;
                seen.add(k);
                return true;
            });
            S.heroItems = pool.slice(0, 8);
            S.heroIndex = 0;
        }
        if (!S.heroItems.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
        el.style.display = '';
        const it = S.heroItems[S.heroIndex % S.heroItems.length];
        const r = ratingOf(it.seriesId);
        const following = it.followStatus === 'watching';
        const wd = weekdayLabel(it.date);
        const epLabel = it.episode != null ? '第 ' + it.episode + ' 集' : (it.totalEps ? '全 ' + it.totalEps + ' 集' : '放送中');
        const dots = S.heroItems.map((_, i) => '<button class="svh-hero-dot' + (i === S.heroIndex % S.heroItems.length ? ' active' : '')
            + '" data-act="hero-dot" data-idx="' + i + '" aria-label="第' + (i + 1) + '个"></button>').join('');
        el.innerHTML = '<div class="svh-hero-bg"><img src="' + esc(it.cover) + '" alt="" loading="lazy"></div>'
            + '<div class="svh-hero-shade"></div>'
            + '<div class="svh-hero-inner">'
            + '<div class="svh-hero-poster"><img src="' + esc(it.cover) + '" alt="" loading="lazy"></div>'
            + '<div class="svh-hero-copy">'
            + '<div class="svh-hero-eyebrow">' + esc(wd) + ' · 本周新番</div>'
            + '<h1 class="svh-hero-title">' + esc(it.title) + '</h1>'
            + '<div class="svh-hero-meta">'
            + '<span class="svh-rating big" data-rating-sid="' + esc(it.seriesId) + '" style="display:none"></span>'
            + (r ? '' : '')
            + '<span>' + esc(epLabel) + '</span>'
            + '<span class="svh-chip">' + (following ? '追番中' : '放送中') + '</span>'
            + '</div>'
            + '<div class="svh-hero-actions">'
            + '<button class="svh-btn primary" data-act="detail" data-sid="' + esc(it.seriesId) + '">查看详情 · 选源播放</button>'
            + '<button class="svh-btn' + (following ? ' ghost' : '') + '" data-act="follow" data-sid="' + esc(it.seriesId) + '" data-title="' + esc(it.title) + '" data-status="watching">'
            + (following ? '✓ 已追番' : '+ 加入追番') + '</button>'
            + '</div></div></div>'
            + '<div class="svh-hero-dots">' + dots + '</div>';
        applyRatings();
        if (S.heroItems.length > 1 && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
            S.heroTimer = setInterval(() => {
                S.heroIndex = (S.heroIndex + 1) % S.heroItems.length;
                renderHero();
            }, 8000);
        }
    }

    function weekdayLabel(date) {
        const parts = String(date || '').split('-').map(Number);
        if (parts.length === 3 && parts[0]) {
            const d = new Date(parts[0], parts[1] - 1, parts[2]);
            return '周' + '日一二三四五六'[d.getDay()];
        }
        return '本周';
    }

    function renderDays() {
        const box = q('#svDays');
        if (!box) return;
        if (!S.calDays.length) { box.innerHTML = ''; return; }
        box.innerHTML = S.calDays.map((d, i) => {
            const active = d.date === S.calDay;
            const parts = String(d.date || '').split('-');
            const short = parts.length === 3 ? (Number(parts[1]) + '/' + Number(parts[2])) : '';
            return '<button class="svh-day' + (active ? ' active' : '') + '" data-act="day" data-date="' + esc(d.date) + '">'
                + '<b>' + (i === 0 ? '今天' : weekdayLabel(d.date)) + '</b>'
                + (short ? '<small>' + short + '</small>' : '')
                + '</button>';
        }).join('');
    }

    function renderCalendar() {
        const box = q('#svCalendar');
        if (!box) return;
        const day = S.calDays.find((d) => d.date === S.calDay) || S.calDays[0];
        const items = (day && day.items) || [];
        if (!items.length) {
            box.innerHTML = '<div class="sv-empty-line">' + (S.calDays.length ? '这一天没有放送安排' : '放送表暂无数据，点右上「刷新放送表」重试') + '</div>';
            return;
        }
        box.innerHTML = items.slice(0, 40).map((it) => {
            const sid = Number(it.seriesId) || 0;
            const following = it.followStatus === 'watching';
            const ep = it.episode != null ? '第 ' + it.episode + ' 集' : (it.totalEps ? '全 ' + it.totalEps + ' 集' : '');
            return '<article class="svh-card' + (sid ? '' : ' disabled') + '"' + (sid ? ' data-act="detail" data-sid="' + sid + '" role="button" tabindex="0"' : '') + '>'
                + '<div class="svh-poster">'
                + (it.cover ? '<img src="' + esc(it.cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<div class="svh-poster-ph">' + esc((it.title || '').slice(0, 6)) + '</div>')
                + '<span class="svh-rating" data-rating-sid="' + esc(sid) + '" style="display:none"></span>'
                + (ep ? '<span class="svh-ep-badge">' + esc(ep) + '</span>' : '')
                + (sid ? '<button class="svh-follow' + (following ? ' on' : '') + '" data-act="follow" data-sid="' + sid + '" data-title="' + esc(it.title) + '" data-status="watching">' + (following ? '✓' : '+ 追番') + '</button>' : '')
                + '</div>'
                + '<div class="svh-card-title" title="' + esc(it.title) + '">' + esc(it.title) + '</div>'
                + '</article>';
        }).join('');
        applyRatings();
    }

    function renderRank() {
        const box = q('#svRank');
        if (!box) return;
        if (!S.rank.length) {
            box.innerHTML = '<div class="sv-empty-line">排行榜暂时取不到（源不可达），不影响追番</div>';
            return;
        }
        box.innerHTML = S.rank.map((it, i) => {
            const cover = String(it.cover || '');
            const proxied = cover ? '/api/acg/cover?u=' + encodeURIComponent(cover) : '';
            const sc = it.score != null ? Number(it.score).toFixed(1) : '';
            return '<button class="svh-rank-row" data-act="rank-open" data-title="' + esc(it.title) + '">'
                + '<span class="svh-rank-no' + (i < 3 ? ' top' : '') + '">' + (it.rank || i + 1) + '</span>'
                + '<span class="svh-rank-cover">' + (proxied ? '<img src="' + esc(proxied) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') + '</span>'
                + '<span class="svh-rank-main"><b title="' + esc(it.title) + '">' + esc(it.title) + '</b>'
                + '<small>' + esc((it.tags || []).slice(0, 2).join(' · ') || it.source || '') + '</small></span>'
                + (sc ? '<span class="svh-rank-score">' + esc(sc) + '</span>' : '')
                + '</button>';
        }).join('');
    }

    function renderBoard() {
        const box = q('#svBoard');
        if (!box) return;
        const list = (S.board || []).filter((b) => !S.tab || b.followStatus === S.tab);
        const count = q('#svMineCount');
        if (count) count.textContent = S.board.length ? '共 ' + S.board.length + ' 部' : '';
        if (!list.length) {
            const tips = {
                watching: '还没有在追的番。从上面的本周放送点「查看详情」选个源就能看。',
                planned: '计划看列表是空的。',
                onhold: '搁置列表是空的。',
                completed: '还没有已完成的番。',
                dropped: '抛弃列表是空的。',
            };
            box.innerHTML = '<div class="sv-empty">' + (tips[S.tab] || '暂无数据，去本周放送挑一部吧') + '</div>';
            return;
        }
        box.innerHTML = list.map((b) => {
            const total = Number(b.episodeTotal || 0);
            const watched = Number(b.watchedCount || 0);
            const pct = total ? Math.round(watched / total * 100) : 0;
            const next = b.nextEpisode;
            const label = next != null ? '▶ 继续看第 ' + next + ' 集' : (total ? '✓ 已看完' : '▶ 打开选源');
            return '<article class="svh-card svh-mine-card' + (b.followStatus !== 'watching' ? ' off' : '') + '" data-act="detail" data-sid="' + b.id + '" role="button" tabindex="0">'
                + '<div class="svh-poster">'
                + (b.posterPath ? '<img src="' + esc(b.posterPath) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<div class="svh-poster-ph">' + esc((b.title || '').slice(0, 6)) + '</div>')
                + '<span class="svh-rating" data-rating-sid="' + esc(b.id) + '" style="display:none"></span>'
                + '<span class="svh-pct">' + pct + '%</span>'
                + '<span class="svh-prog"><i style="width:' + pct + '%"></i></span>'
                + (b.followStatus && b.followStatus !== 'watching' ? '<span class="svh-state">' + esc(STATUS_LABELS[b.followStatus] || b.followStatus) + '</span>' : '')
                + '</div>'
                + '<div class="svh-card-title" title="' + esc(b.title) + '">' + esc(b.title) + '</div>'
                + '<div class="svh-card-sub">已看 ' + watched + ' / ' + total + ' 集</div>'
                + '<button class="svh-continue" data-act="detail" data-sid="' + b.id + '">' + label + '</button>'
                + '</article>';
        }).join('');
        applyRatings();
    }

    // ================================================================
    // 详情（源优先）
    // ================================================================
    async function openDetail(seriesId) {
        const sid = Number(seriesId);
        if (!sid) return;
        const host = ensureHost('svDetailHost');
        const seq = ++S.detailSeq;
        S.detail = null;
        S.season = null;
        window.__svSeason = null;
        S.sources = [];
        S.srcPicked = '';
        host.innerHTML = '<div class="svd-mask"><div class="svd-panel svd-loading"><span class="svd-spin"></span>正在打开…</div></div>';
        document.body.classList.add('sv-detail-open');
        let d;
        try {
            const r = await api('/api/series/' + sid + '/detail', { timeout: 25000 });
            if (seq !== S.detailSeq) return;
            if (!r || r.code !== 0 || !r.data) throw new Error((r && r.msg) || '番剧不存在');
            d = r.data;
        } catch (e) {
            if (seq !== S.detailSeq) return;
            host.innerHTML = '<div class="svd-mask" data-act="close-detail"><div class="svd-panel svd-loading">打开失败：' + esc(e.message)
                + '<button class="svd-btn" data-act="close-detail">关闭</button></div></div>';
            return;
        }
        S.detail = d;
        renderDetail();
        ensureRatings([sid]);
        searchSources(false);
    }

    function renderDetail() {
        const d = S.detail;
        const host = document.getElementById('svDetailHost');
        if (!d || !host) return;
        const s = d.series || {};
        const following = d.followStatus || '';
        const localCount = (d.episodes || []).filter((e) => e.movieId).length;
        const year = String(s.airDate || '').slice(0, 4);
        const meta = [
            '<span class="svd-score" data-rating-sid="' + esc(s.id) + '" style="display:none"></span>',
            year ? '<span>' + esc(year) + '</span>' : '',
            s.episodeCount ? '<span>全 ' + esc(s.episodeCount) + ' 集</span>' : '',
            '<span>' + (s.status === 'finished' ? '已完结' : '放送中') + '</span>',
        ].filter(Boolean).join('<i class="svd-dot"></i>');
        host.innerHTML = '<div class="svd-mask" data-act="close-detail">'
            + '<div class="svd-panel" role="dialog" aria-modal="true" aria-label="番剧详情">'
            + '<button class="svd-close" data-act="close-detail" aria-label="关闭">✕</button>'
            + '<div class="svd-hero">'
            + '<div class="svd-poster">'
            + (s.posterPath ? '<img src="' + esc(s.posterPath) + '" alt="" onerror="this.style.display=\'none\'">' : '<div class="svd-poster-ph">' + esc((s.title || '').slice(0, 6)) + '</div>')
            + '</div>'
            + '<div class="svd-info">'
            + '<div class="svd-eyebrow">' + esc(s.originalTitle || '动画') + '</div>'
            + '<h2 class="svd-title">' + esc(s.title) + '</h2>'
            + '<div class="svd-meta">' + meta + '</div>'
            + '<p class="svd-overview" data-act="toggle-overview">' + esc(s.overview || '暂无简介。') + '</p>'
            + '<div class="svd-actions">'
            + '<button class="svd-btn primary" data-act="continue-watch">▶ 继续观看</button>'
            + '<select class="svd-follow" aria-label="追番状态">'
            + '<option value=""' + (!following ? ' selected' : '') + '>未追番</option>'
            + STATUS_ORDER.map((st) => '<option value="' + st + '"' + (following === st ? ' selected' : '') + '>' + STATUS_LABELS[st] + '</option>').join('')
            + '</select>'
            + '<button class="svd-btn" data-act="search-bt" data-title="' + esc(s.title) + '">🔍 搜 BT</button>'
            + '<button class="svd-btn" data-act="rescan">↻ 重新搜源</button>'
            + '</div></div></div>'
            + '<div class="svd-body">'
            + '<div class="svd-block" id="svdSrcBlock">'
            + '<div class="svd-block-head"><h4>播放源</h4><span class="svd-stat" id="svdSrcStat">正在并发搜索所有在线源…</span></div>'
            + '<div class="svd-src-list" id="svdSrcList">' + '<div class="svd-src-skel"></div>'.repeat(3) + '</div>'
            + '<div class="svd-src-foot" id="svdSrcFoot"></div>'
            + '</div>'
            + '<div class="svd-block" id="svdEpsBlock" style="display:none">'
            + '<div class="svd-block-head"><button class="svd-back" data-act="back-src">← 换源</button>'
            + '<span class="svd-src-name" id="svdEpsSource"></span><span class="svd-stat" id="svdEpsStat"></span></div>'
            + '<div class="svd-ep-hero" id="svdEpHero"></div>'
            + '<div class="svd-ep-grid" id="svdEpGrid"></div>'
            + '<div class="svd-note">点击集数播放 · 播完自动下一集 · 进度自动记录</div>'
            + '</div>'
            + '</div></div></div>';
        applyRatings();
        const sel = host.querySelector('.svd-follow');
        if (sel) sel.addEventListener('change', onFollowSelect);
    }

    function closeDetail() {
        S.detailSeq++;
        const host = document.getElementById('svDetailHost');
        if (host) host.innerHTML = '';
        document.body.classList.remove('sv-detail-open');
    }

    // ---------------- 播放源搜索 ----------------
    async function searchSources(force) {
        const d = S.detail;
        if (!d) return;
        const seq = ++S.srcSeq;
        const list = q('#svdSrcList');
        const stat = q('#svdSrcStat');
        const foot = q('#svdSrcFoot');
        const srcBlock = q('#svdSrcBlock');
        const epsBlock = q('#svdEpsBlock');
        if (srcBlock) srcBlock.style.display = '';
        if (epsBlock) epsBlock.style.display = 'none';
        if (list) list.innerHTML = '<div class="svd-src-skel"></div>'.repeat(3);
        if (foot) foot.innerHTML = '';
        if (stat) stat.textContent = '正在并发搜索所有在线源…';
        const startedAt = Date.now();
        const tick = setInterval(() => {
            if (stat) stat.textContent = '正在并发搜索所有在线源… ' + Math.round((Date.now() - startedAt) / 1000) + 's';
        }, 1000);
        try {
            const r = await api('/api/series/sources', {
                method: 'POST',
                body: JSON.stringify({ seriesId: d.series.id, keyword: d.series.title, force: force === true }),
                timeout: 75000,
            });
            if (seq !== S.srcSeq) return;
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '搜索失败');
            S.sources = (r.data && r.data.sources) || [];
            renderSources(r.data || {});
        } catch (e) {
            if (seq !== S.srcSeq) return;
            if (list) list.innerHTML = '<div class="svd-empty">搜源失败：' + esc(e.message || '网络异常') + '</div>';
            if (stat) stat.textContent = '搜索失败';
            if (foot) foot.innerHTML = '<button class="svd-btn" data-act="rescan">↻ 重新搜索</button>'
                + '<button class="svd-btn" data-act="search-bt" data-title="' + esc(d.series.title) + '">🔍 搜 BT 兜底</button>';
        } finally {
            clearInterval(tick);
        }
    }

    function renderSources(data) {
        const d = S.detail;
        const list = q('#svdSrcList');
        const stat = q('#svdSrcStat');
        const foot = q('#svdSrcFoot');
        if (!list || !d) return;
        const st = data.states || {};
        if (stat) {
            stat.textContent = '扫描 ' + (data.scanned || 0) + ' 个源 · 命中 ' + S.sources.length + ' 个'
                + ' · 无结果 ' + (st.noResult || 0) + ' · 不可用 ' + (st.error || 0)
                + (st.captcha ? ' · 需验证 ' + st.captcha : '')
                + (st.cooling ? ' · 冷却 ' + st.cooling : '');
        }
        const localCount = (d.episodes || []).filter((e) => e.movieId).length;
        const last = lastSource(d.series.id);
        const rows = [];
        if (localCount) {
            rows.push('<button class="svd-src local" data-act="pick-local">'
                + '<span class="svd-src-icon">📁</span>'
                + '<span class="svd-src-main"><b>本地文件</b><small>已下载 ' + localCount + ' 集 · 直接播放</small></span>'
                + '<span class="svd-src-go">▶</span></button>');
        }
        S.sources.forEach((src, i) => {
            const isLast = last && last.sourceId === src.sourceId;
            const fac = src.factory === 'json-api' ? '直连' : (src.factory === 'kazumi' ? '嗅探' : '网页');
            rows.push('<button class="svd-src' + (S.srcPicked === src.sourceId ? ' active' : '') + '" data-act="pick-src" data-idx="' + i + '" data-source-id="' + esc(src.sourceId) + '">'
                + '<span class="svd-src-main"><b>' + esc(src.sourceName) + (isLast ? '<em class="svd-tag">上次</em>' : '') + '</b>'
                + '<small title="' + esc(src.entryName) + '">' + esc(src.entryName) + '</small></span>'
                + '<span class="svd-src-side"><i class="svd-fac">' + fac + '</i>'
                + '<i class="svd-score">' + Math.round((src.score || 0) * 100) + '%</i></span>'
                + '<span class="svd-src-go">▶</span></button>');
        });
        if (!S.sources.length) {
            rows.push('<div class="svd-empty">没有找到标题匹配的在线源。<br>'
                + '<span class="svd-stat">扫描 ' + (data.scanned || 0) + ' 个源 · 无结果 ' + (st.noResult || 0)
                + ' · 不可用 ' + (st.error || 0) + (st.captcha ? ' · 需验证 ' + st.captcha : '') + '</span><br>'
                + '可以「搜 BT 兜底」，或稍后点「重新搜源」。</div>');
        }
        list.innerHTML = rows.join('');
        applyRatings();
        if (foot) {
            const verify = (data.needsVerify || []);
            foot.innerHTML = (verify.length
                ? '<div class="svd-verify"><span>这些源需要人机验证，通过后命中率更高：</span>'
                  + verify.map((v) => '<button data-act="verify-source" data-src="' + esc(v.sourceId) + '">' + esc(v.sourceName) + ' 去验证</button>').join('')
                  + '</div>'
                : '')
                + (S.sources.length ? '<button class="svd-btn" data-act="search-bt" data-title="' + esc(d.series.title) + '">🔍 搜 BT 兜底</button>' : '');
        }
        /* 上次用过的源自动选中：Kazumi 也是这样，老用户点开就能接着看 */
        if (!S.season && last) {
            const idx = S.sources.findIndex((x) => x.sourceId === last.sourceId);
            if (idx >= 0) setTimeout(() => { if (!S.season && S.detail === d) pickSource(S.sources[idx], { auto: true }); }, 300);
        }
    }

    function markActiveSource(sourceId) {
        document.querySelectorAll('#svdSrcList .svd-src').forEach((el) => {
            el.classList.toggle('active', el.getAttribute('data-source-id') === sourceId);
        });
    }

    function lastSource(seriesId) {
        try {
            const all = JSON.parse(localStorage.getItem(LS_LAST_SRC) || '{}');
            return all[String(seriesId)] || null;
        } catch (e) { return null; }
    }

    function saveLastSource(seriesId, src) {
        try {
            const all = JSON.parse(localStorage.getItem(LS_LAST_SRC) || '{}');
            all[String(seriesId)] = { sourceId: src.sourceId, detailUrl: src.detailUrl, entryName: src.entryName || '' };
            localStorage.setItem(LS_LAST_SRC, JSON.stringify(all));
        } catch (e) { /* 忽略 */ }
    }

    async function pickSource(src, opts = {}) {
        const d = S.detail;
        if (!d || !src) return false;
        S.srcPicked = src.sourceId;
        markActiveSource(src.sourceId);
        const block = q('#svdEpsBlock');
        const srcName = q('#svdEpsSource');
        const epsStat = q('#svdEpsStat');
        const grid = q('#svdEpGrid');
        const hero = q('#svdEpHero');
        if (block) block.style.display = '';
        if (srcName) srcName.textContent = src.sourceName + (src.entryName ? ' · ' + src.entryName : '');
        if (epsStat) epsStat.textContent = '正在加载全集…';
        if (grid) grid.innerHTML = '<i class="svd-ep-skel"></i>'.repeat(12);
        if (hero) hero.innerHTML = '';
        const seq = ++S.epSeq;
        try {
            const r = await api('/api/series/source-episodes', {
                method: 'POST',
                body: JSON.stringify({
                    seriesId: d.series.id, seasonNo: 1,
                    sourceId: src.sourceId, detailUrl: src.detailUrl, entryName: src.entryName,
                }),
                timeout: 75000,
            });
            if (seq !== S.epSeq) return false;
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '这个源没有可播放剧集');
            const data = r.data || {};
            S.season = {
                mode: 'online',
                seriesId: d.series.id,
                title: d.series.title,
                sourceId: src.sourceId,
                sourceName: data.sourceName || src.sourceName,
                entryName: data.entryName || src.entryName || '',
                detailUrl: src.detailUrl,
                episodes: data.episodes || [],
                progress: data.progress || {},
                nextEpisode: data.nextEpisode || 0,
                current: -1,
            };
            window.__svSeason = S.season;
            saveLastSource(d.series.id, src);
            renderEpisodes();
            /* 选完源就收起源列表，只留「← 换源」入口 —— 和 Kazumi 一样把注意力交给集数 */
            const srcBlock = q('#svdSrcBlock');
            const epsBlock = q('#svdEpsBlock');
            if (srcBlock) srcBlock.style.display = 'none';
            if (epsBlock) epsBlock.style.display = '';
            if (!opts.silent) notify('已加载 ' + S.season.episodes.length + ' 集', S.season.sourceName + ' · 点集数直接播放');
            return true;
        } catch (e) {
            if (seq !== S.epSeq) return false;
            if (epsStat) epsStat.textContent = '加载失败';
            if (grid) grid.innerHTML = '<div class="svd-empty">' + esc(e.message || '加载失败') + '<br>可以点上面的「← 换源」换一个源，或用「搜 BT 兜底」。</div>';
            if (!opts.silent) notify('这个源不可用', e.message || '换一个源试试');
            return false;
        }
    }

    function pickLocal() {
        const d = S.detail;
        if (!d) return;
        const eps = (d.episodes || []).filter((e) => e.movieId);
        if (!eps.length) { notify('没有本地文件', '这一季还没有挂接本地影片'); return; }
        S.srcPicked = 'local';
        markActiveSource('local');
        const block = q('#svdEpsBlock');
        const srcName = q('#svdEpsSource');
        const epsStat = q('#svdEpsStat');
        if (block) block.style.display = '';
        if (srcName) srcName.textContent = '本地文件';
        if (epsStat) epsStat.textContent = '共 ' + eps.length + ' 集';
        S.season = {
            mode: 'local',
            seriesId: d.series.id,
            title: d.series.title,
            sourceId: 'local',
            sourceName: '本地文件',
            entryName: '',
            episodes: eps.map((e) => ({ episodeNo: e.episodeNo, title: e.title || ('第' + e.episodeNo + '集'), movieId: e.movieId })),
            progress: {},
            nextEpisode: 0,
            current: -1,
        };
        eps.forEach((e) => {
            S.season.progress[e.episodeNo] = {
                id: e.id, watched: e.watched === 1,
                position: Number(e.position) || 0,
                duration: Number(e.progressDuration || e.duration) || 0,
            };
        });
        for (const ep of S.season.episodes) {
            const p = S.season.progress[ep.episodeNo];
            if (!p || !p.watched) { S.season.nextEpisode = ep.episodeNo; break; }
        }
        window.__svSeason = null;   // 本地连播交给 app.js 的播放列表
        renderEpisodes();
    }

    function renderEpisodes() {
        const season = S.season;
        const grid = q('#svdEpGrid');
        const hero = q('#svdEpHero');
        const epsStat = q('#svdEpsStat');
        if (!season || !grid) return;
        const eps = season.episodes || [];
        const watched = eps.filter((e) => {
            const p = season.progress[e.episodeNo];
            return p && p.watched;
        }).length;
        if (epsStat) epsStat.textContent = '共 ' + eps.length + ' 集 · 已看 ' + watched + ' 集';
        const nextIdx = eps.findIndex((e) => e.episodeNo === season.nextEpisode);
        const startIdx = nextIdx >= 0 ? nextIdx : 0;
        if (hero) {
            hero.innerHTML = '<button class="svd-btn primary big" data-act="play-next">▶ 从第 ' + esc(eps[startIdx] ? eps[startIdx].episodeNo : 1) + ' 集开始</button>'
                + '<button class="svd-btn" data-act="play-ep" data-idx="0">从头播放</button>';
        }
        grid.innerHTML = eps.map((ep, i) => {
            const p = season.progress[ep.episodeNo] || {};
            const cls = p.watched ? ' watched' : (ep.episodeNo === season.nextEpisode ? ' next' : (p.position > 3 ? ' partial' : ''));
            return '<button class="svd-ep' + cls + '" data-act="play-ep" data-idx="' + i + '" title="' + esc(ep.title || ('第' + ep.episodeNo + '集')) + '">'
                + esc(ep.episodeNo) + '</button>';
        }).join('');
    }

    // ---------------- 播放 ----------------
    function playNextEpisode() {
        const season = S.season;
        if (!season) return;
        const eps = season.episodes || [];
        let idx = season.current >= 0 ? season.current + 1 : -1;
        if (idx < 0 || idx >= eps.length) {
            idx = eps.findIndex((e) => !(season.progress[e.episodeNo] || {}).watched);
            if (idx < 0) idx = 0;
        }
        playEpisodeByIndex(idx, {});
    }

    async function playEpisodeByIndex(idx, opts = {}) {
        const season = S.season;
        if (!season || !season.episodes) return;
        const ep = season.episodes[idx];
        if (!ep) return;
        if (season.mode === 'local') return playLocalEpisode(idx);

        const token = ++S.playSeq;
        const epsStat = q('#svdEpsStat');
        if (epsStat) epsStat.textContent = '正在解析第 ' + ep.episodeNo + ' 集…';
        const p = (season.progress || {})[ep.episodeNo] || {};
        const startAt = (!p.watched && Number(p.position) > 5) ? Number(p.position) : 0;
        try {
            const url = '/api/media-source/resolve?source=' + encodeURIComponent(season.sourceId)
                + '&url=' + encodeURIComponent(ep.url);
            const d = await api(url, { timeout: 42000 });
            if (token !== S.playSeq) return;
            if (!d || d.code !== 0) throw new Error((d && d.msg) || '该源解析失败');
            season.current = idx;
            season.lastPlayedAt = Date.now();
            window.__svSeason = season;
            window.__svPlayingEpisode = p.id || 0;
            window.__svPlayingTitle = season.title;
            closeDetail();
            if (typeof window.showVideoPlayer === 'function') {
                window.showVideoPlayer(d.data.streamUrl, season.title + ' · 第' + ep.episodeNo + '集',
                    d.data.kind, startAt, p.id || 0);
            } else {
                notify('播放器不可用', '请刷新页面后重试');
            }
        } catch (e) {
            if (token !== S.playSeq) return;
            if (opts.tried && opts.tried.length >= 4) {
                notify('多个源都解析失败', '先停一下，稍后再试或换个关键词');
                return;
            }
            notify('解析失败', ((e && /超时/.test(e.message)) ? '这个源 42 秒没返回播放地址，' : '') + '正在自动换源…');
            playFromNextSource(ep.episodeNo, (opts.tried || [season.sourceId]));
        }
    }

    async function playFromNextSource(epNo, tried) {
        const cand = (S.sources || []).find((s) => !tried.includes(s.sourceId));
        if (!cand) { notify('没有更多可用源', '可以换关键词后重新搜源，或用 BT 兜底'); return; }
        if (!S.detail) {
            notify('已离开详情页', '重新打开这部番再试');
            return;
        }
        const ok = await pickSource(cand, { silent: true });
        if (!ok) return playFromNextSource(epNo, tried.concat([cand.sourceId]));
        const idx = (S.season.episodes || []).findIndex((e) => e.episodeNo === epNo);
        if (idx < 0) return playFromNextSource(epNo, tried.concat([cand.sourceId]));
        playEpisodeByIndex(idx, { tried: tried.concat([cand.sourceId]) });
    }

    function playLocalEpisode(idx) {
        const season = S.season;
        if (!season) return;
        const eps = season.episodes || [];
        const ep = eps[idx];
        if (!ep || !ep.movieId) return;
        season.current = idx;
        window.__svSeason = null;
        window.currentPlaylist = eps.map((e) => ({
            id: e.movieId,
            title: season.title + ' · 第' + e.episodeNo + '集',
        }));
        window.currentPlaylistIndex = idx;
        closeDetail();
        if (typeof window.playMovieInline === 'function') {
            window.playMovieInline(ep.movieId, { keepPlaylist: true });
        } else {
            notify('播放器不可用', '请刷新页面后重试');
        }
    }

    /* 播放器 ended 回调（app.js 调用）：标记看完 + 自动下一集 */
    function onPlayerEnded() {
        const season = window.__svSeason;
        if (!season || !season.episodes) return;
        const idx = Number(season.current);
        const ep = season.episodes[idx];
        if (ep) {
            const p = (season.progress || {})[ep.episodeNo] || {};
            if (p.id) {
                fetch('/api/series/episode/progress', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ episodeId: p.id, position: 1, duration: 1, watched: 1 }),
                }).catch(() => {});
                if (season.progress[ep.episodeNo]) season.progress[ep.episodeNo].watched = true;
            }
        }
        const next = idx + 1;
        if (next < (season.episodes || []).length) {
            notify('自动连播', '即将播放第 ' + season.episodes[next].episodeNo + ' 集');
            setTimeout(() => playEpisodeByIndex(next, {}), 1400);
        } else {
            notify('已看完', '这个源下的剧集已经全部播放完毕');
        }
    }

    // ---------------- 追番状态 ----------------
    async function setFollow(seriesId, status, title) {
        const sid = Number(seriesId);
        if (!sid) return;
        try {
            if (!status) {
                await api('/api/series/unfollow', { method: 'POST', body: JSON.stringify({ seriesId: sid }) });
            } else {
                await api('/api/series/follow', { method: 'POST', body: JSON.stringify({ seriesId: sid, status }) });
            }
            if (S.detail && Number(S.detail.series.id) === sid) S.detail.followStatus = status || null;
            notify(status ? '已加入' + (STATUS_LABELS[status] || '追番') : '已移出追番',
                status ? (title || '') : '');
            loadBoard();
            loadCalendar(false);
            if (S.detail) {
                const sel = document.querySelector('#svDetailHost .svd-follow');
                if (sel) sel.value = status || '';
            }
        } catch (e) {
            notify('操作失败', e.message || '网络异常');
        }
    }

    function onFollowSelect(e) {
        const sel = e.target && e.target.closest && e.target.closest('.svd-follow');
        if (!sel) return;
        const sid = S.detail && S.detail.series ? S.detail.series.id : 0;
        if (!sid) return;
        setFollow(sid, sel.value, S.detail.series.title);
    }

    // ---------------- 继续观看 ----------------
    async function startWatching() {
        const d = S.detail;
        if (!d) return;
        if (S.season && S.season.mode === 'online') { playNextEpisode(); return; }
        if (S.season && S.season.mode === 'local') { playNextEpisode(); return; }
        const localCount = (d.episodes || []).filter((e) => e.movieId).length;
        if (localCount) {
            pickLocal();
            const idx = Math.max(0, (S.season.episodes || []).findIndex((e) => !(S.season.progress[e.episodeNo] || {}).watched));
            playEpisodeByIndex(idx, {});
            return;
        }
        if (S.sources && S.sources.length) {
            const ok = await pickSource(S.sources[0], { silent: true });
            if (ok) { playNextEpisode(); return; }
        }
        notify('还在搜源', '等播放源列表出来，点一个源就能开始看');
    }

    // ================================================================
    // BT 兜底 / 本地挂接（沿用旧实现）
    // ================================================================
    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch (e) {
            const ta = document.createElement('textarea'); ta.value = text;
            ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
            ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
            document.body.removeChild(ta); return ok;
        }
    }

    async function openBtSearch(title) {
        const kw = String(title || '').trim();
        if (!kw) return;
        const host = ensureHost('svBtHost');
        host.innerHTML = '<div class="sv-modal-mask" data-act="close-bt"><div class="sv-modal sv-bt-modal" role="dialog" aria-modal="true">'
            + '<div class="sv-modal-head"><h3>🔍 BT 搜索：' + esc(kw) + '</h3>'
            + '<button class="sv-modal-close" data-act="close-bt">✕</button></div>'
            + '<div class="sv-bt-body" id="svBtBody"><div class="sv-empty">搜索中…</div></div>'
            + '<div class="sv-bt-tip">只展示磁力链接，应用不下载任何内容。复制后粘到夸克/下载器离线，完成后自动入库并挂到本集。</div>'
            + '</div></div>';
        host.querySelectorAll('[data-act="close-bt"]').forEach((el) => el.addEventListener('click', (e) => {
            if (e.target === el || el.classList.contains('sv-modal-close')) host.innerHTML = '';
        }));
        try {
            const r = await api('/api/bt/search?kw=' + encodeURIComponent(kw));
            const items = (r && r.code === 0 && Array.isArray(r.data)) ? r.data : [];
            const body = document.getElementById('svBtBody');
            if (!body) return;
            if (!items.length) { body.innerHTML = '<div class="sv-empty">未找到种子（BT 源可能不可达，可稍后重试）</div>'; return; }
            body.innerHTML = items.slice(0, 40).map((it) =>
                '<div class="sv-bt-item"><div class="sv-bt-title" title="' + esc(it.title) + '">' + esc(it.title) + '</div>'
                + '<div class="sv-bt-meta">' + esc(it.size || '') + ' · ' + esc(it.date || '').slice(0, 16) + ' · ' + esc(it.sourceName || '') + '</div>'
                + '<button class="sv-bt-copy" data-act="copy-magnet" data-magnet="' + esc(it.magnet) + '">复制磁力</button></div>'
            ).join('');
        } catch (e) {
            const body = document.getElementById('svBtBody');
            if (body) body.innerHTML = '<div class="sv-empty">搜索失败：' + esc(e.message) + '</div>';
        }
    }

    // ================================================================
    // 事件
    // ================================================================
    async function onClick(e) {
        const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        const sid = Number(btn.getAttribute('data-sid'));

        if (act === 'close-detail') {
            if (e.target === btn || btn.classList.contains('svd-close') || btn.classList.contains('sv-modal-close')) {
                closeDetail();
                const bt = document.getElementById('svBtHost'); if (bt) bt.innerHTML = '';
            }
            return;
        }
        if (act === 'detail') { openDetail(sid); return; }
        if (act === 'hero-dot') {
            S.heroIndex = Number(btn.getAttribute('data-idx')) || 0;
            renderHero();
            return;
        }
        if (act === 'day') {
            S.calDay = btn.getAttribute('data-date') || '';
            renderDays();
            renderCalendar();
            const day = S.calDays.find((d) => d.date === S.calDay);
            ensureRatings(((day && day.items) || []).map((it) => it.seriesId));
            return;
        }
        if (act === 'follow') {
            const status = btn.getAttribute('data-status') || 'watching';
            if (btn.disabled) return;
            btn.disabled = true;
            setFollow(sid, status, btn.getAttribute('data-title') || '').finally(() => { btn.disabled = false; });
            return;
        }
        if (act === 'rank-open') {
            const title = btn.getAttribute('data-title') || '';
            if (title && typeof window.openWatchWithSearch === 'function') window.openWatchWithSearch('watch-anime', title);
            else notify('无法打开', '在线源模块未加载');
            return;
        }
        if (act === 'rescan') { searchSources(true); return; }
        if (act === 'check-updates') { checkUpdates(btn); return; }
        if (act === 'pick-src') {
            const idx = Number(btn.getAttribute('data-idx'));
            const src = S.sources[idx];
            if (src) pickSource(src, {});
            return;
        }
        if (act === 'pick-local') { pickLocal(); return; }
        if (act === 'back-src') {
            const srcBlock = q('#svdSrcBlock');
            if (srcBlock) srcBlock.style.display = '';
            const epsBlock = q('#svdEpsBlock');
            if (epsBlock) epsBlock.style.display = 'none';
            return;
        }
        if (act === 'toggle-overview') {
            btn.classList.toggle('open');
            return;
        }
        if (act === 'continue-watch') { startWatching(); return; }
        if (act === 'play-next') { playNextEpisode(); return; }
        if (act === 'play-ep') {
            const idx = Number(btn.getAttribute('data-idx'));
            if (S.season && S.season.mode === 'local') playLocalEpisode(idx);
            else playEpisodeByIndex(idx, {});
            return;
        }
        if (act === 'search-bt') { openBtSearch(btn.getAttribute('data-title') || ''); return; }
        if (act === 'copy-magnet') {
            copyText(btn.getAttribute('data-magnet') || '').then((ok) => {
                notify(ok ? '磁力已复制' : '复制失败', ok ? '粘贴到夸克/下载器离线下载' : '请手动复制');
            });
            return;
        }
        if (act === 'verify-source') {
            const src = btn.getAttribute('data-src') || '';
            const old = btn.textContent;
            btn.disabled = true;
            btn.textContent = '等待验证…';
            notify('请在刚打开的浏览器窗口里完成验证', '通过后会自动保存 Cookie，最多等 2 分钟');
            try {
                const r = await api('/api/media-source/verify', { method: 'POST', body: JSON.stringify({ sourceId: src }), timeout: 130000 });
                notify(r && r.code === 0 ? '验证通过' : '验证未通过', r && r.code === 0 ? '正在用新 Cookie 重新搜索…' : ((r && r.msg) || '窗口关了或超时'));
                if (r && r.code === 0) searchSources(true);
            } catch (err) {
                notify('验证失败', err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = old;
            }
            return;
        }
    }

    function onKeydown(e) {
        if (e.key !== 'Escape') return;
        closeDetail();
        const bt = document.getElementById('svBtHost'); if (bt) bt.innerHTML = '';
    }

    // ================================================================
    // 外壳 / 生命周期
    // ================================================================
    function buildShell(r) {
        if (r.dataset.built === '1') return;
        r.innerHTML = '<div class="sv-wrap sv-home">'
            + '<div class="sv-head">'
            + '<div class="sv-head-title"><h2>追番</h2><span class="sv-head-sub" id="svHeadSub"></span></div>'
            + '<div class="sv-head-actions">'
            + '<button class="sv-refresh" data-act="check-updates">检查更新</button>'
            + '<button class="sv-refresh" id="svSourcesBtn">🔌 在线源</button>'
            + '<button class="sv-refresh" id="svRefreshBtn">刷新放送表</button>'
            + '</div></div>'
            + '<section class="svh-hero" id="svHero" style="display:none"></section>'
            + '<div class="svh-grid">'
            + '<section class="svh-panel svh-week">'
            + '<header class="svh-panel-head"><h3>本周放送</h3><div class="svh-days" id="svDays"></div></header>'
            + '<div class="svh-week-grid" id="svCalendar"><div class="sv-empty-line">加载中…</div></div>'
            + '</section>'
            + '<section class="svh-panel svh-rank">'
            + '<header class="svh-panel-head"><h3>热门排行</h3><span class="svh-panel-sub">实时热度 · 点击去搜源</span></header>'
            + '<div class="svh-rank-list" id="svRank"><div class="sv-empty-line">加载中…</div></div>'
            + '</section>'
            + '</div>'
            + '<section class="svh-panel svh-mine">'
            + '<header class="svh-panel-head"><h3>我的追番 <small id="svMineCount"></small></h3>'
            + '<div class="sv-tabs" id="svTabs">'
            + '<button data-tab="" class="active">全部</button>'
            + '<button data-tab="watching">追番中</button>'
            + '<button data-tab="planned">计划看</button>'
            + '<button data-tab="onhold">搁置</button>'
            + '<button data-tab="completed">已完成</button>'
            + '<button data-tab="dropped">抛弃</button>'
            + '</div></header>'
            + '<div class="svh-wall" id="svBoard"><div class="sv-empty">加载中…</div></div>'
            + '</section>'
            + '</div>';
        r.dataset.built = '1';
        const refresh = r.querySelector('#svRefreshBtn');
        if (refresh) refresh.addEventListener('click', () => loadCalendar(true));
        const sources = r.querySelector('#svSourcesBtn');
        if (sources) sources.addEventListener('click', () => {
            if (window.SourcePicker) window.SourcePicker.open();
            else notify('暂不可用', '源管理模块未加载');
        });
        const tabs = r.querySelector('#svTabs');
        if (tabs) tabs.addEventListener('click', (e) => {
            const b = e.target.closest('[data-tab]');
            if (!b) return;
            S.tab = b.getAttribute('data-tab') || '';
            tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
            renderBoard();
        });
    }

    function show() {
        const r = root();
        if (!r) return;
        r.style.display = 'block';
        buildShell(r);
        document.body.classList.add('sv-mode');
        if (!S.bound) {
            document.addEventListener('click', onClick);
            document.addEventListener('keydown', onKeydown);
            document.addEventListener('change', onFollowSelect);
            S.bound = true;
        }
        loadBoard();
        loadCalendar(false);
        loadRank(false);
        if (window.SeriesGraph && window.SeriesGraph.injectButton) window.SeriesGraph.injectButton();
        if (window.JellyfinPanel && window.JellyfinPanel.injectButton) window.JellyfinPanel.injectButton();
        autoRefreshSources();
    }

    function hide() {
        const r = root();
        if (r) r.style.display = 'none';
        document.body.classList.remove('sv-mode');
        if (S.heroTimer) { clearInterval(S.heroTimer); S.heroTimer = 0; }
        closeDetail();
        if (S.bound) {
            document.removeEventListener('click', onClick);
            document.removeEventListener('keydown', onKeydown);
            document.removeEventListener('change', onFollowSelect);
            S.bound = false;
        }
    }

    // 源规则新鲜度：超过 7 天后台拉一次（不阻塞 UI）
    let __sourceRefreshDone = false;
    async function autoRefreshSources() {
        if (__sourceRefreshDone) return;
        __sourceRefreshDone = true;
        try {
            const f = await api('/api/media-source/freshness');
            if (!f || f.code !== 0 || !f.data || !f.data.stale) return;
            const r = await api('/api/media-source/refresh', { method: 'POST', body: '{}' });
            if (r && r.code === 0) notify('在线源规则已更新', '拉取了 ' + r.data.updated + ' 份最新规则，搜源更准');
        } catch (e) { /* 网络不通下次再试 */ }
    }

    async function checkUpdates(btn) {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '检查中…';
        try {
            const r = await api('/api/series/check-updates', { method: 'POST', body: '{}', timeout: 60000 });
            if (r && r.code === 0) {
                const n = (r.data && r.data.notified) || 0;
                notify('更新检查完成', n ? '发现 ' + n + ' 部追番有新集，已发通知' : '暂无新集');
            }
        } catch (e) {
            notify('检查失败', e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    // check-updates 按钮走事件委托里的 data-act 分支（见 onClick）

    window.SeriesView = Object.assign(window.SeriesView || {}, {
        show,
        hide,
        openDetail,
        loadBoard,
        loadCalendar,
        refresh: () => { loadBoard(); loadCalendar(false); loadRank(false); },
        onPlayerEnded,
    });
})();
