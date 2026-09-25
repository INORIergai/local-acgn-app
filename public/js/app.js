// ========== 全局状态 ==========
let currentView = 'movies';
let currentSort = 'hot';
let currentMovies = [];
let scanTimer = null;
let scanStatusTimer = null;
let currentScanModule = 'movie';
let selectedMovies = new Set();
let galleryTimer = null;
let galleryIndex = 0;
// 翻页特效状态：真实显示的那一页 + 方向（+1 向后翻 / -1 向前翻）。
// 2026-09-22：原来所有 slide 排成一条横向长条做 translateX，切换时会「两张海报连在一起」，
// 现在改成同位置叠放的翻页牌组，靠 CSS 3D rotateY 做翻页。
let galleryShownIndex = -1;
let galleryDir = 1;
let galleryMovies = [];

// 标签弹窗方块用的糖果色池（与 av-board CANDY 同源）
const TAG_CANDY = ['#ffdbfd', '#FAED8F', '#DDFCFC', '#CAF7C8', '#fbb663', '#f49978', '#feb6fa', '#c2b4eb', '#997ade', '#00ecef'];
let currentPlayerMovie = null;
// 当前详情弹窗中的影片（用于详情弹窗内的按钮操作，不依赖列表缓存）
let currentDetailMovie = null;
// 当前列表筛选上下文（标签/女优筛选），用于数据变更后原地刷新保持状态
let currentFilter = null; // { kind: 'tag'|'actress', id, name }
let currentSearchQuery = '';

// 夸克网盘状态
let quarkCurrentFid = '0';
let quarkCurrentFolderName = '根目录';   // 面包屑要显示真名字，不能显示 fid
let quarkCurrentKind = 'comic';          // 收藏/历史按 漫画/小说 分开记
let cloudStarSet = new Set();            // 已收藏的 fid，渲染时点亮星标
let quarkPage = 1;                       // 网盘列表当前页
let quarkTotal = 0;                      // 当前文件夹的条目总数（夸克返回的 total）
const QUARK_PAGE_SIZE = 50;              // 每页 50 条，按用户要求
let quarkPathHistory = [];
let quarkCurrentFiles = [];

// 漫画/小说文件夹树状态（前端本地下钻）
let comicTree = null;
let novelTree = null;
let comicTreePath = '';
let novelTreePath = '';

// ========== 工具函数 ==========
function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return size.toFixed(1) + ' ' + units[i];
}

function formatDuration(seconds) {
    if (!seconds) return '0m';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
}

function formatTime(seconds) {
    if (!seconds) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// 海报加载失败时的占位图（避免出现破图/灰块）
const POSTER_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225"><rect width="400" height="225" fill="#241f18"/><text x="200" y="118" text-anchor="middle" font-size="64">🎬</text><text x="200" y="158" text-anchor="middle" fill="#9c9282" font-size="16">未找到封面</text></svg>'
);

function getPosterUrl(movie) {
    // 优先用posterPath（缓存文件），其次用localPosterPath
    let posterFile = movie.posterPath;
    if (!posterFile && movie.localPosterPath) {
        posterFile = movie.localPosterPath.split(/[\\/]/).pop();
    }
    if (!posterFile) return '';
    // 添加时间戳防止浏览器缓存
    return `/api/movie/poster/${posterFile}?t=${movie.lastScanTime || Date.now()}`;
}

// 显示通知
function showNotification(title, message, duration = 3000) {
    const notif = document.getElementById('notification');
    document.getElementById('notifTitle').textContent = title;
    document.getElementById('notifMessage').textContent = message;
    notif.classList.add('show');
    setTimeout(() => {
        notif.classList.remove('show');
    }, duration);
}

// ========== 分页状态 ==========
let currentPage = 1;
let currentPageSize = 50;
let currentTotal = 0;
let currentTotalPages = 0;

// ========== API 封装 ==========
const api = {
    async getMovies(sort = 'hot', filter = 'all', type = 'all', page = 1, pageSize = 50) {
        const res = await fetch(`/api/movie?sort=${sort}&filter=${filter}&type=${type}&page=${page}&pageSize=${pageSize}`);
        const data = await res.json();
        currentTotal = data.total || 0;
        currentTotalPages = data.totalPages || 0;
        currentPage = data.page || 1;
        return data.data || [];
    },
    
    async searchMovies(q) {
        const res = await fetch(`/api/movie/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getMovieDetail(id) {
        const res = await fetch(`/api/movie/${id}`);
        const data = await res.json();
        return data.data;
    },
    
    async playMovie(id) {
        await fetch(`/api/movie/play/${id}`, { method: 'POST' });
    },
    
    async toggleFavorite(id) {
        const res = await fetch(`/api/movie/favorite/${id}`, { method: 'POST' });
        const data = await res.json();
        return data.data;
    },
    
    async toggleWatched(id) {
        const res = await fetch(`/api/movie/watched/${id}`, { method: 'POST' });
        const data = await res.json();
        return data.data;
    },
    
    async rateMovie(id, rating) {
        await fetch(`/api/movie/rating/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating })
        });
    },
    
    async getActresses() {
        const res = await fetch('/api/actress');
        const data = await res.json();
        return data.data || [];
    },
    
    async getActressMovies(id) {
        const res = await fetch(`/api/actress/${id}/movies`);
        const data = await res.json();
        return data.data || [];
    },
    
    async toggleActressFollow(id) {
        const res = await fetch(`/api/actress/${id}/follow`, { method: 'POST' });
        const data = await res.json();
        return data.data;
    },
    
    async getTags() {
        const res = await fetch('/api/tags');
        const data = await res.json();
        return data.data || [];
    },
    
    async getTagMovies(id) {
        const res = await fetch(`/api/tags/${id}/movies`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getSimilarMovies(id, limit = 12) {
        const res = await fetch(`/api/recommend/similar/${id}?limit=${limit}`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getRandomMovies(limit = 24, type = 'all') {
        const res = await fetch(`/api/recommend/random?limit=${limit}&type=${type}`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getHotMovies(limit = 24) {
        const res = await fetch(`/api/recommend/hot?limit=${limit}`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getGuessMovies(limit = 24) {
        const res = await fetch(`/api/recommend/guess?limit=${limit}`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getUnwatchedMovies(limit = 50) {
        const res = await fetch(`/api/recommend/unwatched?limit=${limit}`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getStats(type) {
        const res = await fetch('/api/stats/overview' + (type ? `?type=${type}` : ''));
        const data = await res.json();
        return data.data;
    },
    
    async getScanStatus(module = 'movie') {
        const res = await fetch(`/api/scanner/status?module=${module}`);
        const data = await res.json();
        return data.data;
    },
    
    async startScan() {
        await fetch('/api/scanner/start', { method: 'POST' });
    },

    // 视频文件流
    getVideoUrl(filePath) {
        // 编码文件路径作为参数
        return `/api/movie/stream?path=${encodeURIComponent(filePath)}`;
    },

    // 播放列表
    async getPlaylists() {
        const res = await fetch('/api/playlist');
        const data = await res.json();
        return data.data || [];
    },
    
    async getPlaylistDetail(id) {
        const res = await fetch(`/api/playlist/${id}`);
        const data = await res.json();
        return data.data;
    },
    
    async createPlaylist(name, description) {
        const res = await fetch('/api/playlist/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
        });
        const data = await res.json();
        return data;
    },
    
    async addToPlaylist(playlistId, movieId) {
        const res = await fetch(`/api/playlist/${playlistId}/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ movieId })
        });
        const data = await res.json();
        return data;
    },
    
    async removeFromPlaylist(playlistId, movieId) {
        const res = await fetch(`/api/playlist/${playlistId}/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ movieId })
        });
        const data = await res.json();
        return data;
    }
};

// ========== 画廊模式 ==========
async function initGallery(view = 'movies') {
    try {
        let type = 'all';
        if (view === 'anime') type = 'anime';
        else if (view === 'comic') type = 'comic';
        else if (view === 'novel') type = 'novel';
        
        // 2026-09-22：用户反馈「推荐只有两部」——原来只请求 8 部再过滤掉无封面的，
        // 随机 8 部里有 6 部没海报就只剩 2 部了。现在多拿一些（后端本来就会 ×4 随机池），
        // 过滤有封面的后洗牌，固定输出 10 部；每次刷新都是新的随机组合。
        const pool = await api.getRandomMovies(40, type);
        const withPoster = pool.filter(m => m.localPosterPath || m.posterPath);
        galleryMovies = withPoster.sort(() => 0.5 - Math.random()).slice(0, 10);
        if (galleryMovies.length < 3) {
            hideGallery();
            return;
        }
        
        showGallery();
        renderGallery();
        startGalleryAutoPlay();
    } catch (e) {
        console.log('画廊初始化失败:', e);
    }
}

function renderGallery() {
    const track = document.getElementById('galleryTrack');
    const dots = document.getElementById('galleryDots');

    track.innerHTML = galleryMovies.map((m, i) => {
        const title = m.title || m.fileName || '未命名';
        // 2026-09-22：用户要求去掉底部信息遮罩层（gallery-overlay）——整幅海报干干净净
        return `
        <div class="gallery-slide${i === 0 ? ' is-active' : ' is-parked-fwd'}" data-id="${m.id}" title="${escapeHtml(title)}">
            <img src="${getPosterUrl(m)}" alt="${title}" loading="lazy">
        </div>
        `;
    }).join('');

    // 重新渲染后页码归零（galleryIndex 可能还停在上一份列表的位置）
    galleryIndex = 0;
    galleryShownIndex = 0;
    galleryDir = 1;

    dots.innerHTML = galleryMovies.map((_, i) => `
        <div class="gallery-dot ${i === 0 ? 'active' : ''}" data-index="${i}"></div>
    `).join('');

    // 绑定事件：整幅 slide 可点开详情，箭头/圆点切图
    track.querySelectorAll('.gallery-slide').forEach(slide => {
        slide.addEventListener('click', () => {
            const id = parseInt(slide.dataset.id);
            if (id) showMovieDetail(id);
        });
    });

    dots.querySelectorAll('.gallery-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = parseInt(dot.dataset.index);
            galleryDir = target >= galleryShownIndex ? 1 : -1;
            galleryIndex = target;
            updateGallery();
            resetGalleryAutoPlay();
        });
    });

    document.getElementById('galleryPrev').addEventListener('click', (e) => {
        e.stopPropagation();
        galleryDir = -1;
        galleryIndex = (galleryIndex - 1 + galleryMovies.length) % galleryMovies.length;
        updateGallery();
        resetGalleryAutoPlay();
    });

    document.getElementById('galleryNext').addEventListener('click', (e) => {
        e.stopPropagation();
        galleryDir = 1;
        galleryIndex = (galleryIndex + 1) % galleryMovies.length;
        updateGallery();
        resetGalleryAutoPlay();
    });

    // 悬停暂停
    const container = document.getElementById('galleryContainer');
    container.addEventListener('mouseenter', stopGalleryAutoPlay);
    container.addEventListener('mouseleave', startGalleryAutoPlay);
}

function updateGallery() {
    const track = document.getElementById('galleryTrack');
    if (!track) return;
    const slides = Array.from(track.querySelectorAll('.gallery-slide'));
    const n = slides.length;
    if (!n) return;

    const idx = ((galleryIndex % n) + n) % n;
    const prev = galleryShownIndex;
    syncGalleryDots(idx);
    if (prev === idx) return;

    const fwd = galleryDir >= 0;
    slides.forEach((s, i) => {
        const isActive = i === idx;
        const isOut = !isActive && i === prev;
        s.classList.toggle('is-active', isActive);
        s.classList.toggle('is-out-left', isOut && fwd);
        s.classList.toggle('is-out-right', isOut && !fwd);
        // 其它牌一律「停靠在翻页方向的入场位」——状态已经落盘，
        // 所以轮到它时只要摘掉停靠位就一定会走 transition（不需要强制回流）
        s.classList.remove('is-parked-fwd', 'is-parked-back');
        if (!isActive && !isOut) s.classList.add(fwd ? 'is-parked-fwd' : 'is-parked-back');
    });
    galleryShownIndex = idx;
}

function syncGalleryDots(idx) {
    document.querySelectorAll('.gallery-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === idx);
    });
}

function startGalleryAutoPlay() {
    if (galleryTimer) return;
    galleryTimer = setInterval(() => {
        galleryIndex = (galleryIndex + 1) % galleryMovies.length;
        updateGallery();
    }, 4000);
}

function stopGalleryAutoPlay() {
    if (galleryTimer) {
        clearInterval(galleryTimer);
        galleryTimer = null;
    }
}

function resetGalleryAutoPlay() {
    stopGalleryAutoPlay();
    startGalleryAutoPlay();
}

// ========== 渲染函数 ==========

// 渲染影片卡片（海报+番号，hover显示完整信息）
function renderMovieCard(movie) {
    const posterUrl = getPosterUrl(movie);
    const isFav = movie.favorite === 1;
    const isWatched = movie.watched === 1;
    const isSelected = selectedMovies.has(movie.id);
    const displayTitle = movie.title || movie.fileName;
    const avid = movie.avid || '';

    // 续播进度（齿孔进度条），由 features.js 维护 window.progressMap
    const pct = window.progressMap ? window.progressMap[movie.id] : 0;

    // NEW 角标：近 7 天入库
    const isNew = movie.addedTime && (Date.now() - Number(movie.addedTime)) < 7 * 864e5;

    // 副信息行：番号 + 体积（等宽字体，扫读对齐）
    const metaLine = [avid, movie.fileSize ? formatSize(movie.fileSize) : ''].filter(Boolean).join(' · ');

    return `
        <div class="movie-card movie-card-compact ${isFav ? 'favorite' : ''} ${isWatched ? 'watched' : ''} ${isSelected ? 'selected' : ''}" data-id="${movie.id}" title="${displayTitle}">
            <i class="am-glow" aria-hidden="true"></i>
            ${isFav ? '<span class="badge-fav">⭐</span>' : ''}
            ${isWatched ? '<span class="badge-watched">✓</span>' : ''}
            <div class="movie-poster-wrap">
                ${isNew ? '<span class="movie-badge-new">NEW</span>' : ''}
                <img class="movie-poster" src="${posterUrl || POSTER_PLACEHOLDER}" onerror="this.onerror=null;this.src=POSTER_PLACEHOLDER" alt="${displayTitle}" loading="lazy">
                <div class="movie-avid-overlay">${avid}</div>
                <div class="movie-hover-info">
                    <div class="movie-hover-title">${displayTitle}</div>
                    <div class="movie-hover-meta">
                        <span>${formatDuration(movie.duration)}</span>
                        <span>${formatSize(movie.fileSize)}</span>
                    </div>
                </div>
            </div>
            <div class="movie-title-below">${displayTitle}${metaLine ? `<span class="mtb-meta">${metaLine}</span>` : ''}</div>
            ${pct > 0 ? `<div class="card-progress" style="--p:${pct}%"></div>` : ''}
        </div>
    `;
}

// 渲染影片网格
function renderMovies(movies) {
    currentMovies = movies;
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    grid.classList.remove('tree-mode');
    
    if (!movies || movies.length === 0) {
        grid.innerHTML = '';
        emptyTip.style.display = 'block';
        return;
    }
    
    emptyTip.style.display = 'none';
    grid.innerHTML = movies.map(renderMovieCard).join('');

    // AMBIENT 皮肤：给每张新卡按海报色写入 --glow（环境光溢出用）
    applyAmbientGlow(grid);
    
    // 绑定点击事件
    grid.querySelectorAll('.movie-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const id = parseInt(card.dataset.id);
            // Ctrl+点击 多选
            if (e.ctrlKey || e.metaKey) {
                toggleSelect(id);
                return;
            }
            showMovieDetail(id);
        });
    });
}

/* ============================================================
   第 13 轮三个特色视图：热门 TOP 评选 / 未观看入库时间线 / 收藏博物馆
   ============================================================ */

// 通用：给一组卡片绑「点击开详情」（Ctrl 多选保持原行为）
function bindDetailClicks(root) {
    root.querySelectorAll('[data-mid]').forEach(card => {
        card.addEventListener('click', (e) => {
            const id = parseInt(card.dataset.mid);
            if (!id) return;
            if (e.ctrlKey || e.metaKey) { toggleSelect(id); return; }
            showMovieDetail(id);
        });
    });
}

// —— 热门排行：TOP3 领奖台 + 榜单行（点击次数可视化） ——
function renderHotRanking(movies) {
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    grid.classList.remove('tree-mode');
    if (!movies || !movies.length) { grid.innerHTML = ''; emptyTip.style.display = 'block'; return; }
    emptyTip.style.display = 'none';

    const plays = m => `▶ ${m.playCount || 0} 次`;
    const avid = m => m.avid ? `<span class="hr-avid">${escapeHtml(m.avid)}</span>` : '';

    // 领奖台：2-1-3，冠军最大、戴皇冠，台下基座刻名次
    const podiumOrder = [1, 0, 2];
    const medals = ['🥇', '🥈', '🥉'];
    const podium = podiumOrder.filter(i => movies[i]).map(i => {
        const m = movies[i];
        return `
        <div class="hp-step hp-${i + 1}" data-mid="${m.id}">
            <div class="hp-medal">${medals[i]}</div>
            <div class="hp-poster"><img src="${getPosterUrl(m)}" alt="" loading="lazy"></div>
            <div class="hp-base"><b>${i + 1}</b><span>${plays(m)}</span></div>
            <div class="hp-title" title="${escapeHtml(m.title || '')}">${escapeHtml(m.title || m.fileName || '')}</div>
            ${avid(m)}
        </div>`;
    }).join('');

    const maxHot = Math.max(1, ...movies.map(m => m.hotScore || 0));
    const rows = movies.slice(3).map((m, i) => `
        <div class="hr-row" data-mid="${m.id}">
            <span class="hr-rank">${String(i + 4).padStart(2, '0')}</span>
            <img class="hr-thumb" src="${getPosterUrl(m)}" alt="" loading="lazy">
            <div class="hr-main">
                <div class="hr-name" title="${escapeHtml(m.title || '')}">${escapeHtml(m.title || m.fileName || '')}</div>
                ${avid(m)}
                <div class="hr-hotbar"><i style="width:${Math.max(4, Math.round((m.hotScore || 0) / maxHot * 100))}%"></i></div>
            </div>
            <span class="hr-plays">${plays(m)}</span>
        </div>
    `).join('');

    grid.innerHTML = `
        <div class="hot-stage">
            <div class="hot-podium ${movies.length < 3 ? 'incomplete' : ''}">${podium}</div>
            <div class="hot-rest">${rows}</div>
        </div>`;
    bindDetailClicks(grid);
}

// —— 未观看：顶部入库时间线（横向滑动） + 下方常规网格 ——
function renderUnwatchedView(movies) {
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    grid.classList.remove('tree-mode');
    if (!movies || !movies.length) { grid.innerHTML = ''; emptyTip.style.display = 'block'; return; }
    emptyTip.style.display = 'none';

    const DAY = 86400000;
    // addedTime 是毫秒时间戳（数字），不能当字符串 localeCompare
    const byAdded = [...movies].sort((a, b) => (b.addedTime || 0) - (a.addedTime || 0));
    const now = Date.now();
    const tlCards = byAdded.slice(0, 30).map(m => {
        const days = m.addedTime ? Math.max(0, Math.round((now - new Date(m.addedTime).getTime()) / DAY)) : null;
        const label = days === null ? '' : (days === 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`);
        return `
        <div class="tl-card" data-mid="${m.id}" title="${escapeHtml(m.title || '')}">
            <div class="tl-poster"><img src="${getPosterUrl(m)}" alt="" loading="lazy"></div>
            <span class="tl-when">${label}</span>
            <span class="tl-name">${escapeHtml((m.title || m.fileName || '').slice(0, 18))}</span>
        </div>`;
    }).join('');

    grid.innerHTML = `
        <div class="tl-wrap">
            <div class="tl-head">
                <b>📥 入库时间线</b>
                <span>最近入库的 ${Math.min(30, byAdded.length)} 部还没看 · 按住拖动 / 滚轮左右滑</span>
            </div>
            <div class="tl-strip">${tlCards}</div>
        </div>
        <div class="uw-grid-title">全部未观看 · ${movies.length} 部</div>
        <div class="movie-grid uw-grid">${movies.map(renderMovieCard).join('')}</div>`;

    bindDetailClicks(grid);
    // 常规网格沿用原卡片点击（含 Ctrl 多选）
    grid.querySelectorAll('.uw-grid .movie-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const id = parseInt(card.dataset.id);
            if (e.ctrlKey || e.metaKey) { toggleSelect(id); return; }
            showMovieDetail(id);
        });
    });
    // 时间线拖动（与 av-slider 同款：位移超过 4px 才算拖，避免吞点击）
    const strip = grid.querySelector('.tl-strip');
    if (strip) {
        // 原生图片拖拽会打断 pointer 拖动（拖出浏览器假拖拽），直接掐掉
        strip.addEventListener('dragstart', e => e.preventDefault());
        let drag = null, moved = 0;
        strip.addEventListener('pointerdown', e => {
            if (e.pointerType === 'touch' || e.button !== 0) return;
            drag = { x: e.clientX, left: strip.scrollLeft }; moved = 0;
        });
        strip.addEventListener('pointermove', e => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            if (Math.abs(dx) > moved) moved = Math.abs(dx);
            if (moved <= 4) return;
            if (!strip.classList.contains('dragging')) {
                strip.classList.add('dragging');
                try { strip.setPointerCapture(drag.pid = e.pointerId); } catch (err) { }
            }
            strip.scrollLeft = drag.left - dx;
        });
        const end = () => {
            if (!drag) return;
            if (moved > 4) strip.__sup = true, setTimeout(() => strip.__sup = false, 90);
            drag = null; strip.classList.remove('dragging');
        };
        strip.addEventListener('pointerup', end);
        strip.addEventListener('pointercancel', end);
        strip.addEventListener('click', e => {
            if (strip.__sup) { e.stopPropagation(); e.preventDefault(); }
        }, true);
        strip.addEventListener('wheel', e => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (!d) return;
            const max = strip.scrollWidth - strip.clientWidth;
            if (max <= 1) return;
            if ((d < 0 && strip.scrollLeft <= 0) || (d > 0 && strip.scrollLeft >= max - 1)) return;
            e.preventDefault();
            strip.scrollLeft += d;
        }, { passive: false });
    }
}

/* ============================================================
   第 25 轮：我的收藏 · 个性化（筛选 / 件数 / 摆放）
   ------------------------------------------------------------
   用户要求「我的收藏里要可以在设置里面设置展示的筛选条件以及件数和摆放
   位置的更改，个性化内容要多一点」。这里把三件事做成收藏页顶部的一条
   工具栏（不必跳设置页），并持久化到 localStorage：
     · 类型筛选：全部 / 真人 / 动漫 / 漫画 / 小说
     · 每页件数：12 / 24 / 48 / 96
     · 排序：热度 / 最近入库 / 播放次数 / 最近观看 / 发行日期
     · 摆放：珍藏馆(默认) / 紧凑网格 / 大图海报 / 列表行
   ============================================================ */

const FAV_PREF_KEY = 'favPrefs_v1';
let favPrefs = {
    type: 'all',       // 类型筛选
    sort: '',          // 空 = 沿用 currentSort
    pageSize: 0,       // 0 = 沿用 currentPageSize
    layout: 'museum'   // museum | grid | large | list
};

function loadFavPrefs() {
    try {
        const raw = localStorage.getItem(FAV_PREF_KEY);
        if (raw) Object.assign(favPrefs, JSON.parse(raw) || {});
    } catch (e) { /* 存储损坏就用默认值 */ }
    applyFavLayoutClass();
}

function saveFavPrefs() {
    try { localStorage.setItem(FAV_PREF_KEY, JSON.stringify(favPrefs)); } catch (e) {}
}

function applyFavLayoutClass() {
    const grid = document.getElementById('movieGrid');
    if (!grid) return;
    grid.classList.remove('fav-layout-compact', 'fav-layout-large', 'fav-layout-list');
    if (typeof currentView !== 'undefined' && currentView !== 'favorites') return;
    if (favPrefs.layout === 'grid') grid.classList.add('fav-layout-compact');
    else if (favPrefs.layout === 'large') grid.classList.add('fav-layout-large');
    else if (favPrefs.layout === 'list') grid.classList.add('fav-layout-list');
}

function favTypes() {
    return [['all', '全部类型'], ['jav', '真人'], ['anime', '动漫'], ['comic', '漫画'], ['novel', '小说']];
}

function renderFavCustomBar() {
    const sorts = [
        ['', '默认排序'], ['hot', '热度'], ['recent', '最近入库'],
        ['play', '播放次数'], ['lastplay', '最近观看'], ['release', '发行日期']
    ];
    const layouts = [
        ['museum', '珍藏馆（漂浮海报）'], ['grid', '紧凑网格'],
        ['large', '大图海报'], ['list', '列表行']
    ];
    const sizes = [12, 24, 48, 96];
    const curSort = favPrefs.sort || currentSort;
    const curSize = favPrefs.pageSize || currentPageSize;
    return `
        <div class="fav-custom-bar" id="favCustomBar">
            <span class="fc-title">🎛 展示设置</span>
            <select id="favTypeSel" title="类型筛选">
                ${favTypes().map(([v, l]) => `<option value="${v}" ${favPrefs.type === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <select id="favSortSel" title="排序方式">
                ${sorts.map(([v, l]) => `<option value="${v}" ${curSort === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <span class="fc-sep"></span>
            <select id="favSizeSel" title="每页件数">
                ${sizes.map(n => `<option value="${n}" ${n === curSize ? 'selected' : ''}>每页 ${n} 件</option>`).join('')}
            </select>
            <select id="favLayoutSel" title="摆放位置">
                ${layouts.map(([v, l]) => `<option value="${v}" ${favPrefs.layout === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <button class="fc-reset" onclick="resetFavPrefs()">↺ 恢复默认</button>
        </div>`;
}

function bindFavCustomBar() {
    const bar = document.getElementById('favCustomBar');
    if (!bar) return;
    const typeSel = document.getElementById('favTypeSel');
    const sortSel = document.getElementById('favSortSel');
    const sizeSel = document.getElementById('favSizeSel');
    const layoutSel = document.getElementById('favLayoutSel');

    if (typeSel) typeSel.addEventListener('change', () => {
        favPrefs.type = typeSel.value; saveFavPrefs(); loadFavorites(1);
    });
    if (sortSel) sortSel.addEventListener('change', () => {
        favPrefs.sort = sortSel.value; saveFavPrefs(); loadFavorites(1);
    });
    if (sizeSel) sizeSel.addEventListener('change', () => {
        favPrefs.pageSize = parseInt(sizeSel.value) || 24; saveFavPrefs(); loadFavorites(1);
    });
    if (layoutSel) layoutSel.addEventListener('change', () => {
        favPrefs.layout = layoutSel.value; saveFavPrefs();
        applyFavLayoutClass();
        loadFavorites(currentPage || 1);
    });
}

function resetFavPrefs() {
    favPrefs = { type: 'all', sort: '', pageSize: 0, layout: 'museum' };
    saveFavPrefs();
    applyFavLayoutClass();
    loadFavorites(1);
}

// —— 我的收藏：珍藏博物馆（漂浮展品） ——
function renderMuseum(movies) {
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    grid.classList.remove('tree-mode');
    if (!movies || !movies.length) { grid.innerHTML = ''; emptyTip.style.display = 'block'; return; }
    emptyTip.style.display = 'none';

    // 每件展品一套随机漂浮参数（周期 / 延迟 / 摆角），肉眼上互不同步
    const exhibits = movies.map((m, i) => {
        const dur = (4.2 + ((i * 7) % 30) / 10).toFixed(2);      // 4.2 ~ 7.1s
        const delay = (-((i * 13) % 40) / 10).toFixed(2);        // 负延迟 → 一开场就在半程
        const tilt = (((i * 29) % 50) / 10 - 2.5).toFixed(1);    // -2.5 ~ 2.5deg
        return `
        <figure class="exhibit" data-mid="${m.id}"
                style="--mdur:${dur}s;--mdelay:${delay}s;--mtilt:${tilt}deg">
            <div class="exhibit-frame">
                <img src="${getPosterUrl(m)}" alt="${escapeHtml(m.title || '')}" loading="lazy">
            </div>
            <figcaption title="${escapeHtml(m.title || '')}">${escapeHtml(m.title || m.fileName || '')}</figcaption>
            <span class="exhibit-plaque">${m.avid ? escapeHtml(m.avid) : `No.${i + 1}`}</span>
        </figure>`;
    }).join('');

    grid.innerHTML = `
        <div class="fav-custom-bar-wrap" style="grid-column:1/-1;width:100%;">${renderFavCustomBar()}</div>
        <div class="museum">
            <div class="museum-hall">
                <div class="museum-marquee">
                    <span class="mm-star">🏛</span> 珍藏馆
                    <span class="mm-sub">— 馆藏 ${movies.length} 件 · 每一件都值得再看一遍 —</span>
                </div>
                <div class="museum-shelf">${exhibits}</div>
            </div>
        </div>`;
    bindDetailClicks(grid);
    bindFavCustomBar();
    // 第 15 轮：页面做满 —— 按实际列数给最后一行补「虚位以待」空金框
    requestAnimationFrame(() => {
        const shelf = grid.querySelector('.museum-shelf');
        if (!shelf) return;
        const cols = getComputedStyle(shelf).gridTemplateColumns.split(' ').filter(Boolean).length;
        const need = (cols - (movies.length % cols)) % cols;
        for (let i = 0; i < need; i++) {
            const f = document.createElement('figure');
            f.className = 'exhibit is-ghost';
            f.style.setProperty('--mdur', (5 + i).toFixed(2) + 's');
            f.innerHTML = '<div class="exhibit-frame"></div><figcaption>虚位以待</figcaption>';
            shelf.appendChild(f);
        }
    });
}

// —— 最近观看：一根线时间轴，两端手柄拖动筛选观看时间范围 ——
function renderRecentView(movies) {
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    grid.classList.remove('tree-mode');
    // 没看过的（无 lastPlayTime）不进这条时间线
    const watched = (movies || []).filter(m => Number(m.lastPlayTime) > 0)
        .sort((a, b) => (b.lastPlayTime || 0) - (a.lastPlayTime || 0));
    if (!watched.length) { grid.innerHTML = ''; emptyTip.style.display = 'block'; return; }
    emptyTip.style.display = 'none';

    const DAY = 86400000;
    const times = watched.map(m => Number(m.lastPlayTime));
    const tMin = Math.min(...times), tMax = Math.max(...times);
    const fmt = ts => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; };
    const ago = ts => {
        const d = Math.floor((Date.now() - ts) / DAY);
        if (d <= 0) return '今天'; if (d === 1) return '昨天';
        if (d < 30) return d + ' 天前';
        if (d < 365) return Math.floor(d / 30) + ' 个月前';
        return (d / 365).toFixed(1) + ' 年前';
    };
    const pos = ts => tMax === tMin ? 100 : ((ts - tMin) / (tMax - tMin)) * 100;

    grid.innerHTML = `
        <div class="rw-wrap">
            <div class="rw-head">
                <b>🕐 观看时间线</b>
                <span>拖动两端圆点，筛选最近观看的时间范围</span>
                <span class="rw-chips">
                    <button class="rw-chip" data-days="7">近7天</button>
                    <button class="rw-chip" data-days="30">近30天</button>
                    <button class="rw-chip" data-days="90">近90天</button>
                    <button class="rw-chip on" data-days="0">全部</button>
                </span>
                <span class="rw-count" id="rwCount"></span>
            </div>
            <div class="rw-axis" id="rwAxis">
                <div class="rw-track"><i class="rw-sel" id="rwSel"></i></div>
                ${times.map(t => `<i class="rw-tick" style="left:${pos(t).toFixed(2)}%" title="${ago(t)}"></i>`).join('')}
                <button class="rw-h" id="rwHa" style="left:0%" aria-label="起始时间"></button>
                <button class="rw-h" id="rwHb" style="left:100%" aria-label="结束时间"></button>
            </div>
            <div class="rw-labels">
                <span>最早 ${ago(tMin)}（${fmt(tMin)}）</span>
                <span class="rw-range" id="rwRange"></span>
                <span>最新 ${ago(tMax)}（${fmt(tMax)}）</span>
            </div>
            <div class="movie-grid rw-grid" id="rwGrid">${watched.map(renderMovieCard).join('')}</div>
        </div>`;

    // 常规卡片点击（含 Ctrl 多选）
    grid.querySelectorAll('#rwGrid .movie-card').forEach((card, i) => {
        card.dataset.lastplay = times[i] || 0;
        card.addEventListener('click', (e) => {
            const id = parseInt(card.dataset.id);
            if (e.ctrlKey || e.metaKey) { toggleSelect(id); return; }
            showMovieDetail(id);
        });
    });

    const axis = document.getElementById('rwAxis');
    const ha = document.getElementById('rwHa');
    const hb = document.getElementById('rwHb');
    const sel = document.getElementById('rwSel');
    const rangeLabel = document.getElementById('rwRange');
    const countLabel = document.getElementById('rwCount');
    let va = 0, vb = 100, active = null;

    const pctFrom = e => {
        const r = axis.getBoundingClientRect();
        return Math.min(100, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width) * 100));
    };
    const apply = () => {
        ha.style.left = va + '%';
        hb.style.left = vb + '%';
        sel.style.left = va + '%';
        sel.style.width = (vb - va) + '%';
        const ta = tMin + (tMax - tMin) * va / 100;
        const tb = tMin + (tMax - tMin) * vb / 100;
        let n = 0;
        grid.querySelectorAll('#rwGrid > .movie-card').forEach(card => {
            const t = Number(card.dataset.lastplay || 0);
            const on = t >= ta - 1 && t <= tb + 1;
            card.style.display = on ? '' : 'none';
            if (on) n++;
        });
        rangeLabel.textContent = `${fmt(ta)} — ${fmt(tb)}（${ago(tb)}）`;
        countLabel.textContent = `范围内 ${n} 部 / 共 ${watched.length} 部`;
    };

    axis.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const p = pctFrom(e);
        active = Math.abs(p - va) <= Math.abs(p - vb) ? 'a' : 'b';
        if (active === 'a') va = Math.min(p, vb); else vb = Math.max(p, va);
        try { axis.setPointerCapture(e.pointerId); } catch (err) { }
        apply();
        e.preventDefault();
    });
    axis.addEventListener('pointermove', e => {
        if (!active) return;
        const p = pctFrom(e);
        if (active === 'a') va = Math.min(p, vb - 0.5); else vb = Math.max(p, va + 0.5);
        apply();
    });
    const up = () => { active = null; };
    axis.addEventListener('pointerup', up);
    axis.addEventListener('pointercancel', up);

    // 快捷档位：近 N 天（右端拉满，左端按日历时间定位）
    grid.querySelectorAll('.rw-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            grid.querySelectorAll('.rw-chip').forEach(c => c.classList.remove('on'));
            chip.classList.add('on');
            const days = parseInt(chip.dataset.days) || 0;
            if (days > 0) {
                va = Math.max(0, Math.min(100, pos(Date.now() - days * DAY)));
                vb = 100;
            } else { va = 0; vb = 100; }
            apply();
        });
    });

    apply();
}

// 渲染分页控件
function renderPagination() {
    const pagination = document.getElementById('pagination');
    if (!pagination) return;
    
    if (currentTotalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }
    
    pagination.style.display = 'flex';
    
    let html = '';
    // 上一页
    html += `<button class="page-btn" ${currentPage <= 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">上一页</button>`;
    
    // 页码
    const maxButtons = 7;
    let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let endPage = Math.min(currentTotalPages, startPage + maxButtons - 1);
    if (endPage - startPage < maxButtons - 1) {
        startPage = Math.max(1, endPage - maxButtons + 1);
    }
    
    if (startPage > 1) {
        html += `<button class="page-btn" onclick="goToPage(1)">1</button>`;
        if (startPage > 2) html += `<span class="page-dots">...</span>`;
    }
    
    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }
    
    if (endPage < currentTotalPages) {
        if (endPage < currentTotalPages - 1) html += `<span class="page-dots">...</span>`;
        html += `<button class="page-btn" onclick="goToPage(${currentTotalPages})">${currentTotalPages}</button>`;
    }
    
    // 下一页
    html += `<button class="page-btn" ${currentPage >= currentTotalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">下一页</button>`;
    
    // 页码信息
    html += `<span class="page-info">第 ${currentPage}/${currentTotalPages} 页，共 ${currentTotal} 部</span>`;
    
    pagination.innerHTML = html;
}

// 跳转到指定页
function goToPage(page) {
    if (page < 1 || page > currentTotalPages) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    
    // 根据当前视图调用对应的加载函数
    switch (currentView) {
        case 'favorites':
            loadFavorites(page);
            break;
        case 'jav':
            loadJavMovies(page);
            break;
        case 'anime':
            loadAnime(page);
            break;
        case 'comic':
            loadComic(page);
            break;
        case 'novel':
            loadNovel(page);
            break;
        case 'playlists':
            loadPlaylists(page);
            break;
        default:
            loadMovies(page);
    }
}

// ========== 原地刷新当前列表（保持页码与视窗位置，不重置筛选） ==========
async function refreshCurrentList() {
    const scrollY = window.scrollY;
    const page = currentPage || 1;
    
    // 有标签/女优筛选上下文时，用筛选条件刷新
    if (currentFilter) {
        try {
            if (currentFilter.kind === 'tag') {
                const movies = await api.getTagMovies(currentFilter.id);
                renderMovies(movies);
                renderPagination();
                updateToolbarTitle(`标签筛选 - ${currentFilter.name}`, movies.length);
            } else if (currentFilter.kind === 'actress') {
                const movies = await api.getActressMovies(currentFilter.id);
                renderMovies(movies);
                renderPagination();
                updateToolbarTitle(`女优 - ${currentFilter.name}`, movies.length);
            }
        } catch (e) {
            console.error('筛选列表刷新失败:', e);
        }
        requestAnimationFrame(() => window.scrollTo(0, scrollY));
        return;
    }
    
    if (currentSearchQuery) {
        const movies = await api.searchMovies(currentSearchQuery);
        renderMovies(movies);
        updateToolbarTitle(`搜索: ${currentSearchQuery}`, movies.length);
        requestAnimationFrame(() => window.scrollTo(0, scrollY));
        return;
    }
    switch (currentView) {
        case 'favorites':
            await loadFavorites(page);
            break;
        case 'jav':
            await loadJavMovies(page);
            break;
        case 'anime':
            await loadAnime(page);
            break;
        case 'comic':
            await loadComic(page);
            break;
        case 'novel':
            await loadNovel(page);
            break;
        case 'hot':
            await loadHot();
            break;
        case 'random':
            await loadRandom();
            break;
        case 'guess':
            // Aardvark 展台下「刷新」＝再挑一批；魔术视图下＝再抽一批
            if (window.AvBoard) {
                window.AvBoard.openGuess();
            } else if (window.MagicLikes && window.MagicLikes.state.movies.length) {
                await window.MagicLikes.refresh();
            } else {
                await loadGuess();
            }
            break;
        case 'guess-magic':
            if (window.MagicLikes) await window.MagicLikes.refresh();
            break;
        case 'guess-grid':
            await loadGuess();
            break;
        case 'unwatched':
            await loadUnwatched();
            break;
        case 'recent':
            await loadRecent();
            break;
        case 'playlists':
            await loadPlaylists();
            break;
        case 'movies':
        default:
            await loadMovies(page);
            break;
    }
    // 恢复滚动位置
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

// 渲染女优列表
function renderActresses(actresses) {
    const grid = document.getElementById('actressGrid');
    const emptyTip = document.getElementById('emptyTip');

    // 悬停海报预览缓存（每位演员只拉一次）
    const actressPreviewCache = new Map();

    if (!actresses || actresses.length === 0) {
        grid.innerHTML = '';
        emptyTip.style.display = 'block';
        return;
    }

    emptyTip.style.display = 'none';

    // 真正的女优 = 有作品关联的；无关联条目（多为刮削噪声）默认收起
    const withMovies = actresses.filter(a => (a.movieCount || 0) > 0);
    const zeroList = actresses.filter(a => !(a.movieCount || 0) > 0);

    function cardHtml(a) {
        const initial = a.name ? a.name.charAt(0) : '?';
        const isFollowed = a.followed === 1;
        return `
            <div class="actress-card" data-id="${a.id}">
                <div class="actress-follow-btn ${isFollowed ? 'active' : ''}" data-actress-id="${a.id}" title="${isFollowed ? '取消关注' : '关注新作'}">⭐</div>
                <div class="actress-avatar-wrap">
                    <div class="actress-avatar">
                        ${a.avatar
                            ? `<img src="${a.avatar}" alt="${escapeHtml(a.name)}" loading="lazy"
                                 onerror="this.remove();this.parentElement.classList.add('is-fallback')"><span class="actress-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
                            : `<span class="actress-avatar-fallback">${escapeHtml(initial)}</span>`}
                    </div>
                    <button class="actress-avatar-scrape" data-actress-id="${a.id}"
                            title="${a.avatar ? '重新刮削头像' : '刮削头像与档案'}">⟳</button>
                </div>
                <div class="actress-name">${escapeHtml(a.name)}</div>
                <div class="actress-count">${a.movieCount || 0} 部作品</div>
                <div class="actress-preview" aria-hidden="true"></div>
            </div>
        `;
    }

    grid.innerHTML = withMovies.map(cardHtml).join('') + (zeroList.length ? `
        <div class="actress-zero-bar" id="actressZeroBar">
            <input type="text" id="actressZeroFilter" class="tag-filter-input" placeholder="在 ${zeroList.length} 个无作品条目里搜名字…">
            <button class="btn btn-secondary btn-sm" id="actressZeroToggle">展开全部</button>
        </div>
        <div id="actressZeroList" class="actress-zero-list"></div>
    ` : '');

    // 展开/收起无作品条目（展开后按 200 个一批渲染，不再一次塞 1500 个节点）
    const zeroListEl = document.getElementById('actressZeroList');
    const zeroToggle = document.getElementById('actressZeroToggle');
    const zeroFilter = document.getElementById('actressZeroFilter');
    let zeroShown = 0;
    let zeroExpanded = false;

    function renderZeroChunk(reset) {
        if (!zeroListEl) return;
        const q = (zeroFilter && zeroFilter.value || '').trim().toLowerCase();
        const pool = q ? zeroList.filter(a => (a.name || '').toLowerCase().includes(q)) : zeroList;
        if (reset) { zeroListEl.innerHTML = ''; zeroShown = 0; }
        const slice = pool.slice(zeroShown, zeroShown + 200);
        zeroListEl.insertAdjacentHTML('beforeend', slice.map(cardHtml).join(''));
        zeroShown += slice.length;
        if (zeroToggle) {
            zeroToggle.textContent = zeroShown >= pool.length
                ? '收起' : `继续加载（还有 ${pool.length - zeroShown} 个）`;
        }
        bindCards(zeroListEl);
    }

    if (zeroToggle) zeroToggle.addEventListener('click', () => {
        if (!zeroExpanded) {
            zeroExpanded = true;
            renderZeroChunk(true);
        } else if (zeroToggle.textContent === '收起') {
            zeroExpanded = false;
            zeroListEl.innerHTML = '';
            zeroShown = 0;
            zeroToggle.textContent = '展开全部';
        } else {
            renderZeroChunk(false);
        }
    });
    if (zeroFilter) zeroFilter.addEventListener('input', () => {
        if (zeroExpanded) renderZeroChunk(true);
    });

    async function fillActressPreview(card) {
        if (card.__prevLoaded) return;
        card.__prevLoaded = true;
        const id = card.dataset.id;
        try {
            let movies = actressPreviewCache.get(id);
            if (!movies) {
                movies = await api.getActressMovies(id);
                actressPreviewCache.set(id, movies);
            }
            const pics = (movies || []).filter(m => m.localPosterPath || m.posterPath).slice(0, 5);
            const box = card.querySelector('.actress-preview');
            if (box && pics.length) {
                box.innerHTML = pics.map(m => `<img src="${getPosterUrl(m)}" alt="" loading="lazy">`).join('') +
                    `<span class="ap-more">+${Math.max(0, (movies || []).length - pics.length)}</span>`;
            }
        } catch (e) { /* 预览失败静默 */ }
    }

    bindCards(grid);

    function bindCards(root) {
        // 悬停浮起：把这位演员的相关影片海报填进预览层（缓存，只拉一次）
        root.querySelectorAll('.actress-card').forEach(card => {
            if (card.dataset.previewBound) return;
            card.dataset.previewBound = '1';
            card.addEventListener('mouseenter', () => fillActressPreview(card));
        });

        // 关注按钮点击（阻止冒泡）
        root.querySelectorAll('.actress-follow-btn').forEach(btn => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.actressId;
                try {
                    const result = await api.toggleActressFollow(id);
                    if (!result) throw new Error('未登录或会话已过期，请重新登录');
                    btn.classList.toggle('active', result.followed);
                    btn.title = result.followed ? '取消关注' : '关注新作';
                    showNotification(result.followed ? '已关注，将监控新作' : '已取消关注', '');
                } catch (err) {
                    showNotification('操作失败: ' + err.message, 'error');
                }
            });
        });

        // 单个女优刮削头像
        root.querySelectorAll('.actress-avatar-scrape').forEach(btn => {
            if (btn.dataset.bound) return;
            btn.dataset.bound = '1';
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (btn.classList.contains('busy')) return;
                const id = btn.dataset.actressId;
                btn.classList.add('busy');
                try {
                    const res = await fetch(`/api/actress/${id}/scrape-avatar`, { method: 'POST' });
                    const data = await res.json();
                    if (data.code === 0) {
                        const a = data.data;
                        const wrap = btn.closest('.actress-avatar-wrap');
                        const avatarEl = wrap.querySelector('.actress-avatar');
                        if (a.avatar) {
                            avatarEl.innerHTML = `<img src="${a.avatar}?t=${Date.now()}" alt="${escapeHtml(a.name)}" loading="lazy">`;
                            showNotification('刮削成功', `${a.name} 的头像已更新`);
                        } else {
                            showNotification('已完成', `${a.name}：javbus 上没有找到头像`);
                        }
                    } else {
                        showNotification('刮削失败', data.msg || '未知错误');
                    }
                } catch (err) {
                    showNotification('刮削失败', err.message);
                } finally {
                    btn.classList.remove('busy');
                }
            });
        });

        root.querySelectorAll('.actress-card').forEach(card => {
            if (card.dataset.bound) return;
            card.dataset.bound = '1';
            card.addEventListener('click', async () => {
                const id = card.dataset.id;
                const name = card.querySelector('.actress-name') ? card.querySelector('.actress-name').textContent : '';
                const movies = await api.getActressMovies(id);
                // 直接显示movieGrid，不调用switchView（避免重新加载全部影片）
                currentView = 'movies';
                currentFilter = { kind: 'actress', id, name };
                selectedMovies.clear();
                updateBatchToolbar();
                // 更新导航高亮
                document.querySelectorAll('.nav-item').forEach(nav => {
                    nav.classList.remove('active');
                });
                document.getElementById('movieGrid').style.display = 'grid';
                document.getElementById('actressGrid').style.display = 'none';
                document.getElementById('tagCloud').style.display = 'none';
                document.getElementById('statsPanel').style.display = 'none';
                document.getElementById('emptyTip').style.display = 'none';
                document.getElementById('sortSelect').parentElement.style.display = 'block';
                hideGallery();
                renderMoviesChunked(movies, `女优 - ${name}`);
                // 档案页眉：聚合该女优的观看统计 + 刮削到的头像/生日/三围
                if (window.Features && window.Features.renderProfile) {
                    const info = (actresses || []).find(a => String(a.id) === String(id)) || {};
                    window.Features.renderProfile('actress', name, movies, info);
                }
            });
        });
    }
}

// 按 tag id 直接进入筛选结果页（详情切片器 / 标签库共用）
async function openTagById(tagId, tagName) {
    closeModal();
    closeTagSlicerPreview();
    const movies = await api.getTagMovies(tagId);
    currentView = 'movies';
    currentFilter = { kind: 'tag', id: tagId, name: tagName };
    selectedMovies.clear();
    updateBatchToolbar();
    document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
    document.getElementById('movieGrid').style.display = 'grid';
    document.getElementById('actressGrid').style.display = 'none';
    document.getElementById('tagCloud').style.display = 'none';
    document.getElementById('statsPanel').style.display = 'none';
    document.getElementById('emptyTip').style.display = 'none';
    document.getElementById('sortSelect').parentElement.style.display = 'block';
    hideGallery();
    renderMoviesChunked(movies, `标签筛选 - ${tagName}`);
    if (window.Features && window.Features.renderProfile) {
        window.Features.renderProfile('tag', tagName, movies);
    }
}

/* 详情切片器悬停预览：浮层挂 body（fixed + z-index 580，压过抽屉 510），
   每个标签只拉一次数据。鼠标从标签移到浮层上不消失（浮层 pointer-events 关闭，不存在误触）。 */
const tagSlicerPreviewCache = new Map();
let tagSlicerHideTimer = null;

function scheduleHideTagSlicerPreview() {
    clearTimeout(tagSlicerHideTimer);
    tagSlicerHideTimer = setTimeout(closeTagSlicerPreview, 180);
}

function cancelHideTagSlicerPreview() { clearTimeout(tagSlicerHideTimer); }

function closeTagSlicerPreview() {
    cancelHideTagSlicerPreview();
    const pop = document.getElementById('tagSlicerPop');
    if (pop) pop.classList.remove('show');
}

async function showTagSlicerPreview(tagEl) {
    cancelHideTagSlicerPreview();
    let pop = document.getElementById('tagSlicerPop');
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'tagSlicerPop';
        pop.className = 'tag-slicer-pop';
        document.body.appendChild(pop);
    }
    pop.dataset.tagId = tagEl.dataset.tagId;
    pop.dataset.tagName = tagEl.dataset.tagName || '';

    const rect = tagEl.getBoundingClientRect();
    // 先定位再显示（内容后填，避免跳动）
    pop.innerHTML = '<span class="tsp-empty">加载中…</span>';
    pop.classList.add('show');
    const popW = Math.min(920, window.innerWidth * 0.94); // 第 15 轮：浮层放大后同步夹紧宽度
    let left = rect.left;
    if (left + popW > window.innerWidth - 12) left = Math.max(12, window.innerWidth - popW - 12);
    pop.style.left = left + 'px';
    pop.style.top = (rect.bottom + 8) + 'px';

    const tagId = tagEl.dataset.tagId;
    try {
        let movies = tagSlicerPreviewCache.get(tagId);
        if (!movies) {
            movies = await api.getTagMovies(tagId);
            tagSlicerPreviewCache.set(tagId, movies);
        }
        if (pop.dataset.tagId !== tagId) return; // 鼠标已移到别的标签
        const pics = (movies || []).filter(m => m.localPosterPath || m.posterPath).slice(0, 6);
        pop.innerHTML = pics.length
            ? pics.map(m => `<img src="${getPosterUrl(m)}" alt="" loading="lazy">`).join('')
            : '<span class="tsp-empty">该标签暂无带封面的影片</span>';
    } catch (e) {
        pop.innerHTML = '<span class="tsp-empty">预览加载失败</span>';
    }
}

// 第 15 轮：演员卡悬停预览放大后，边缘卡片会把浮层推出视口 —— 委托一级 mouseover 做视口夹紧
document.addEventListener('mouseover', e => {
    const prev = e.target && e.target.closest ? e.target.closest('.actress-preview') : null;
    if (!prev || !prev.isConnected) return;
    prev.style.left = '50%'; // 先复位再量，避免上次的夹紧值叠加
    const r = prev.getBoundingClientRect();
    const pad = 10;
    let delta = 0;
    if (r.left < pad) delta = pad - r.left;
    else if (r.right > window.innerWidth - pad) delta = (window.innerWidth - pad) - r.right;
    prev.style.left = delta ? 'calc(50% + ' + Math.round(delta) + 'px)' : '';
});

// 渲染标签云
function renderTagCloud(tags) {    const cloud = document.getElementById('tagCloud');
    const emptyTip = document.getElementById('emptyTip');

    // 只展示真实挂着影片的标签（幽灵标签已在数据层清理，这里再兜底一次）
    const real = (tags || []).filter(t => (t.movieCount || 0) > 0);

    if (!real.length) {
        cloud.innerHTML = '';
        emptyTip.style.display = 'block';
        return;
    }

    emptyTip.style.display = 'none';

    // 顶部筛选框：输入即过滤，不用在几百个标签里肉眼找
    cloud.innerHTML = `
        <div class="tag-filter-row">
            <input type="text" id="tagFilterInput" class="tag-filter-input" placeholder="筛选标签…（共 ${real.length} 个有作品的标签）">
        </div>
        <div class="tag-list" id="tagList"></div>
    `;

    const listEl = document.getElementById('tagList');
    const input = document.getElementById('tagFilterInput');

    // 悬停预览缓存：每个标签只拉一次相关影片
    const previewCache = new Map();

    function renderList(filterText) {
        const q = (filterText || '').trim().toLowerCase();
        const shown = q ? real.filter(t => (t.name || '').toLowerCase().includes(q)) : real;
        // 无筛选时也只先渲染前 300 个，避免一次性创建过多节点
        const cap = q ? shown.length : Math.min(shown.length, 300);
        listEl.innerHTML = shown.slice(0, cap).map((t, i) => `
            <div class="tag-block" data-id="${t.id}" style="--tb:${TAG_CANDY[i % TAG_CANDY.length]}">
                <div class="tb-head">
                    <span class="tb-name">${t.name}</span>
                    <span class="tb-count">${t.movieCount || 0} 部</span>
                </div>
                <div class="tb-preview" aria-hidden="true"></div>
            </div>
        `).join('') + (!q && shown.length > 300
            ? `<div class="tag-item tag-more-hint">输入关键字筛选其余 ${shown.length - 300} 个…</div>` : '');

        listEl.querySelectorAll('.tag-block[data-id]').forEach(item => {
            item.addEventListener('click', () => openTagMovies(item));
            // 悬停浮起时把相关影片海报填进预览层（缓存，只拉一次）
            item.addEventListener('mouseenter', () => fillTagPreview(item));
        });
    }

    async function fillTagPreview(item) {
        if (item.__prevLoaded) return;
        item.__prevLoaded = true;
        const id = item.dataset.id;
        try {
            let movies = previewCache.get(id);
            if (!movies) {
                movies = await api.getTagMovies(id);
                previewCache.set(id, movies);
            }
            const pics = (movies || []).filter(m => m.localPosterPath || m.posterPath).slice(0, 6);
            const box = item.querySelector('.tb-preview');
            if (box && pics.length) {
                box.innerHTML = pics.map(m => `<img src="${getPosterUrl(m)}" alt="" loading="lazy">`).join('');
            }
        } catch (e) { /* 预览失败静默（悬停不打扰主流程） */ }
    }

    async function openTagMovies(item) {
        const id = item.dataset.id;
        const tagName = item.querySelector('.tb-name') ? item.querySelector('.tb-name').textContent : '';
        await openTagById(id, tagName);
    }

    input.addEventListener('input', () => renderList(input.value));
    renderList('');
}

/* 分批渲染影片网格：首批 60 张立即可见，剩余滚动到底自动续批。
   currentMovies 一次性放全量（详情弹窗的上一部/下一部不受影响），
   只是 DOM 分批上屏 —— 卡死的原因是 300+ 卡片同时进 DOM，不是数据大。 */
function renderMoviesChunked(movies, title) {
    const CHUNK = 60;
    const grid = document.getElementById('movieGrid');
    currentMovies = movies;
    updateToolbarTitle(title, movies.length);

    // 清掉上一批的哨兵
    const oldSentinel = document.getElementById('chunkSentinel');
    if (oldSentinel) oldSentinel.remove();

    if (!movies || !movies.length) {
        grid.innerHTML = '';
        document.getElementById('emptyTip').style.display = 'block';
        return;
    }
    document.getElementById('emptyTip').style.display = 'none';

    let shown = 0;
    let sentinel = null;
    function appendChunk() {
        const slice = movies.slice(shown, shown + CHUNK);
        const html = slice.map(renderMovieCard).join('');
        // 有哨兵时插到哨兵前，保证新卡始终在自动加载触发点上方
        if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
        else grid.insertAdjacentHTML('beforeend', html);
        // 只给新增卡片绑事件
        const fresh = Array.from(grid.querySelectorAll('.movie-card')).slice(shown);
        fresh.forEach(card => {
            card.addEventListener('click', (e) => {
                const id = parseInt(card.dataset.id);
                if (e.ctrlKey || e.metaKey) { toggleSelect(id); return; }
                showMovieDetail(id);
            });
        });
        // AMBIENT 皮肤：新卡补 --glow
        applyAmbientGlow(grid);
        shown += slice.length;
        if (shown >= movies.length && sentinel) { sentinel.remove(); sentinel = null; }
    }

    grid.innerHTML = '';
    appendChunk();

    // 滚动到底自动续批（IntersectionObserver，优于 scroll 监听）
    if (shown < movies.length) {
        sentinel = document.createElement('div');
        sentinel.id = 'chunkSentinel';
        sentinel.style.cssText = 'grid-column:1/-1;height:1px;';
        grid.appendChild(sentinel);
        const io = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) appendChunk();
        }, { rootMargin: '600px' });
        io.observe(sentinel);
    }
}

// 更新统计
async function updateStats() {
    try {
        const stats = await api.getStats();
        document.getElementById('statTotal').textContent = stats.totalMovies || 0;
        document.getElementById('statSize').textContent = formatSize(stats.totalSize).replace(' GB', 'G').replace(' MB', 'M');
        document.getElementById('statWatched').textContent = stats.watchedCount || 0;
        document.getElementById('statPlays').textContent = stats.totalPlays || 0;
        document.getElementById('countAll').textContent = stats.totalMovies || 0;
        document.getElementById('countActress').textContent = stats.actressCount || 0;
        document.getElementById('countTag').textContent = stats.tagCount || 0;

        /* ★ round25 修复：侧栏「影片库 / 动漫库 / 漫画库 / 小说库」四个计数
         * 此前只有「点进该库」时才会被各自的分支填上，首屏恒为 0。
         * 这里按库各取一次总览，一次性把计数补齐。 */
        fillLibraryCounts();
    } catch (e) {}
}

// 补齐侧栏四个库的计数（不阻塞首屏：并行、静默失败）
async function fillLibraryCounts() {
    const map = [['jav', 'countJav'], ['anime', 'countAnime'], ['comic', 'countComic'], ['novel', 'countNovel']];
    await Promise.all(map.map(async ([type, elId]) => {
        try {
            const el = document.getElementById(elId);
            if (!el) return;
            const s = await api.getStats(type);
            const n = s && s.totalMovies;
            if (typeof n === 'number') el.textContent = n;
        } catch (e) { /* 单个库取不到就保持原值 */ }
    }));
}

// 更新工具栏标题
function updateToolbarTitle(title, count) {
    const toolbar = document.getElementById('toolbarTitle');
    if (count !== undefined) {
        toolbar.innerHTML = `${title} <span class="toolbar-count" id="movieCount">共 ${count} 部</span>`;
    } else {
        // 不带数量时保留 movieCount 元素，避免后续 getElementById('movieCount') 为空
        toolbar.innerHTML = `${title} <span class="toolbar-count" id="movieCount" style="display:none;"></span>`;
    }
}

// ========== 播放列表 ==========
let currentPlaylistId = null;

// 渲染播放列表页面
function renderPlaylists(lists) {
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    
    if (!lists || lists.length === 0) {
        grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:60px 20px;">
                <div style="font-size:64px;margin-bottom:16px;opacity:0.5;">📋</div>
                <div style="color:var(--text-muted);margin-bottom:20px;">暂无播放列表</div>
                <button class="btn" onclick="showCreatePlaylist()">+ 创建播放列表</button>
            </div>
        `;
        return;
    }
    
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
    
    grid.innerHTML = lists.map(list => `
        <div class="stats-card playlist-card" data-id="${list.id}" style="cursor:pointer;padding:20px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
                <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:24px;">📋</div>
                <div>
                    <div style="font-size:16px;font-weight:600;">${list.name}</div>
                    <div style="font-size:12px;color:var(--text-muted);">${list.movieCount || 0} 部影片</div>
                </div>
            </div>
            ${list.description ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;">${list.description}</div>` : ''}
            <div style="display:flex;gap:8px;">
                <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();playPlaylist(${list.id})">▶️ 播放</button>
                <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();deletePlaylist(${list.id})">🗑️ 删除</button>
            </div>
        </div>
    `).join('');
    
    // 绑定点击事件
    grid.querySelectorAll('.playlist-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = parseInt(card.dataset.id);
            showPlaylistDetail(id);
        });
    });
}

// 显示播放列表详情
async function showPlaylistDetail(id) {
    currentPlaylistId = id;
    const playlist = await api.getPlaylistDetail(id);
    if (!playlist) return;
    
    updateToolbarTitle(`📋 ${playlist.name}`, playlist.movieCount);
    
    const movies = playlist.movies || [];
    renderMovies(movies);
    
    // 增加播放列表操作
    const toolbar = document.querySelector('.toolbar');
    const actionsDiv = document.createElement('div');
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '8px';
    actionsDiv.innerHTML = `
        <button class="btn btn-sm" onclick="playPlaylist(${id})">▶️ 播放全部</button>
        <button class="btn btn-sm btn-secondary" onclick="switchView('playlists')">← 返回列表</button>
    `;
    toolbar.appendChild(actionsDiv);
}

// 创建播放列表弹窗
function showCreatePlaylist() {
    const name = prompt('请输入播放列表名称：');
    if (!name) return;
    
    const description = prompt('请输入播放列表描述（可选）：') || '';
    
    api.createPlaylist(name, description).then(data => {
        if (data.code === 0) {
            showNotification('创建成功', `播放列表「${name}」已创建`);
            loadPlaylists();
        } else {
            showNotification('创建失败', data.msg);
        }
    });
}

// 删除播放列表
async function deletePlaylist(id) {
    if (!confirm('确定要删除这个播放列表吗？')) return;
    
    try {
        await fetch(`/api/playlist/${id}`, { method: 'DELETE' });
        showNotification('删除成功', '播放列表已删除');
        loadPlaylists();
    } catch (e) {
        showNotification('删除失败', e.message);
    }
}

// 播放播放列表（连播）
async function playPlaylist(id) {
    const playlist = await api.getPlaylistDetail(id);
    if (!playlist || !playlist.movies || playlist.movies.length === 0) {
        showNotification('播放列表为空', '请先添加影片');
        return;
    }
    
    // 播放第一部
    const firstMovie = playlist.movies[0];
    playMovieInline(firstMovie.id);
    
    // 设置连播
    window.currentPlaylist = playlist.movies;
    window.currentPlaylistIndex = 0;
    
    showNotification('连播模式', `共 ${playlist.movies.length} 部影片，播放完自动下一部`);
}

// 加载播放列表
async function loadPlaylists() {
    updateToolbarTitle('📋 播放列表');
    const lists = await api.getPlaylists();
    renderPlaylists(lists);
}

// 加载动漫列表
async function loadAnime(page = 1) {
    updateToolbarTitle('🎌 动漫库');
    currentView = 'anime';
    currentPage = page;
    
    try {
        const sort = currentSort;
        const movies = await api.getMovies(sort, 'all', 'anime', page, 50);
        currentMovies = movies;
        renderMovies(currentMovies);
        renderPagination();
        document.getElementById('countAnime').textContent = currentTotal;
    } catch (e) {
        console.error('加载动漫失败:', e);
    }
}

// 加载漫画列表
async function loadComic(page = 1) {
    updateToolbarTitle('📚 漫画库');
    currentView = 'comic';
    currentPage = page;
    
    // 增加切换按钮
    const toolbarRight = document.querySelector('.toolbar-right');
    if (toolbarRight && !document.getElementById('comicCloudToggle')) {
        toolbarRight.insertAdjacentHTML('afterbegin', `
            <div class="view-toggle" id="comicCloudToggle">
                <button class="toggle-btn active" onclick="switchComicView('local')">本地</button>
                <button class="toggle-btn" onclick="switchComicView('cloud')">网盘</button>
            </div>
        `);
    }
    
    try {
        const res = await fetch('/api/comic/tree');
        const data = await res.json();
        if (data.code === 0 && data.data && data.data.tree) {
            comicTree = data.data.tree;
            comicTreePath = '';
            renderTreeLibrary('comic');
            document.getElementById('countComic').textContent = countTreeItems(comicTree);
        } else {
            // 兜底：普通列表
            const sort = currentSort;
            const movies = await api.getMovies(sort, 'all', 'comic', page, 50);
            currentMovies = movies;
            renderMovies(currentMovies);
            renderPagination();
            document.getElementById('countComic').textContent = currentTotal;
        }
        loadReadingStatsBanner('comic');
    } catch (e) {
        console.error('加载漫画失败:', e);
    }
}

// 统计树中的条目数
function countTreeItems(node) {
    let count = node.items ? node.items.length : 0;
    if (node.children) {
        for (const c of node.children) count += countTreeItems(c);
    }
    return count;
}

// ========== 漫画/小说文件夹树（前端本地逐级下钻） ==========

// 取当前库的树与路径状态
function getTreeState(type) {
    return type === 'comic' ? { tree: comicTree, path: comicTreePath } : { tree: novelTree, path: novelTreePath };
}

function setTreePath(type, path) {
    if (type === 'comic') comicTreePath = path;
    else novelTreePath = path;
}

// 按 path 在树中定位节点（'' 表示根）
function findTreeNode(tree, path) {
    if (!path) return tree;
    const segments = String(path).split('/').filter(Boolean);
    let node = tree;
    for (const seg of segments) {
        if (!node || !node.children) return null;
        node = node.children.find(c => c.name === seg);
    }
    return node || null;
}

// 递归统计文件夹内作品总数
function countItemsInFolder(node) {
    if (!node) return 0;
    let count = node.items ? node.items.length : 0;
    if (node.children) {
        for (const c of node.children) count += countItemsInFolder(c);
    }
    return count;
}

// 渲染文件夹卡片
function renderFolderCard(child) {
    const count = countItemsInFolder(child);
    return `
        <div class="folder-card" data-path="${escapeHtml(child.path || child.name || '')}">
            <div class="folder-card-icon">📁</div>
            <div class="folder-card-name">${escapeHtml(child.name || '未命名文件夹')}</div>
            <div class="folder-card-count">${count} 部作品</div>
        </div>
    `;
}

// 渲染面包屑 + 返回上级（挂在内容区顶部）
function renderTreeBreadcrumb(type, node) {
    const crumb = document.getElementById('treeBreadcrumb');
    if (!crumb) return;
    const path = getTreeState(type).path;
    const segments = path ? String(path).split('/').filter(Boolean) : [];

    let html = `<button class="tree-back-btn" data-path="${escapeHtml(segments.slice(0, -1).join('/'))}">← 返回上级</button>`;
    html += `<span class="tree-crumb" data-path="">根目录</span>`;
    let acc = '';
    segments.forEach((seg, i) => {
        acc = acc ? acc + '/' + seg : seg;
        const isLast = i === segments.length - 1;
        html += `<span class="tree-crumb-sep">/</span>`;
        html += `<span class="tree-crumb ${isLast ? 'current' : ''}" data-path="${escapeHtml(acc)}">${escapeHtml(seg)}</span>`;
    });

    crumb.innerHTML = html;
    crumb.style.display = 'flex';

    // 根目录时隐藏返回上级
    const backBtn = crumb.querySelector('.tree-back-btn');
    if (segments.length === 0 && backBtn) backBtn.style.display = 'none';

    crumb.querySelectorAll('[data-path]').forEach(el => {
        el.addEventListener('click', () => {
            enterTreeFolder(type, el.getAttribute('data-path'));
        });
    });
}

// 隐藏面包屑
function hideTreeBreadcrumb() {
    const crumb = document.getElementById('treeBreadcrumb');
    if (crumb) crumb.style.display = 'none';
}

// 进入指定层（复用：面包屑点击 / 返回上级 / 文件夹卡片）
function enterTreeFolder(type, path) {
    setTreePath(type, path || '');
    renderTreeLibrary(type);
}

// 进入子层（文件夹卡片点击入口，全局可用）
function enterComicFolder(path) { enterTreeFolder('comic', path); }
function enterNovelFolder(path) { enterTreeFolder('novel', path); }

// 渲染当前层：文件夹卡片网格 + 作品卡片网格
function renderTreeLibrary(type) {
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    const { tree, path } = getTreeState(type);

    hidePagination();
    grid.classList.add('tree-mode');

    if (!tree) {
        grid.innerHTML = '';
        emptyTip.style.display = 'block';
        hideTreeBreadcrumb();
        return;
    }

    let node = findTreeNode(tree, path);
    if (!node) {
        // 路径失效（如数据刷新后），回退根目录
        setTreePath(type, '');
        renderTreeLibrary(type);
        return;
    }

    const children = node.children || [];
    const items = node.items || [];

    // 空状态：当前层无文件夹也无作品
    if (children.length === 0 && items.length === 0) {
        renderTreeBreadcrumb(type, node);
        grid.innerHTML = `
            <div class="tree-empty" style="grid-column:1/-1;">
                <div class="tree-empty-icon">📂</div>
                <div>此文件夹为空</div>
                <button class="btn" data-back-path="${escapeHtml(segmentsForUp(path))}">← 返回上级</button>
            </div>
        `;
        const backBtn = grid.querySelector('[data-back-path]');
        if (backBtn) backBtn.addEventListener('click', () => enterTreeFolder(type, backBtn.getAttribute('data-back-path')));
        return;
    }

    emptyTip.style.display = 'none';
    renderTreeBreadcrumb(type, node);

    const folderCards = children.map(c => renderFolderCard(c)).join('');
    const itemCards = items.map(item => renderComicTreeCard(item)).join('');

    // AvBoard：Aardvark 书架层接管本层渲染（文件缺失/渲染失败时自动走下方旧网格兜底）
    if (window.AvBoard && window.AvBoard.renderTreeLevel) {
        try {
            const pathSegs = path ? String(path).split('/').filter(Boolean) : [];
            // 展示名带上一级：「日月同错 · 单话版」「吸血鬼要上夜班 · epub」比孤零零的格式目录名有信息量
            const placeName = pathSegs.length >= 2
                ? pathSegs[pathSegs.length - 2] + ' · ' + pathSegs[pathSegs.length - 1]
                : (pathSegs[0] || '');
            if (window.AvBoard.renderTreeLevel(type, node, placeName)) return;
        } catch (e) {
            console.error('[AvBoard] 树层渲染失败，回退旧网格:', e);
        }
    }

    grid.innerHTML = folderCards + itemCards;

    // 绑定文件夹卡片点击 → 下钻
    grid.querySelectorAll('.folder-card').forEach(card => {
        card.addEventListener('click', () => {
            enterTreeFolder(type, card.dataset.path);
        });
    });

    // 绑定作品卡片点击 → 详情
    grid.querySelectorAll('.movie-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const id = parseInt(card.dataset.id);
            if (e.ctrlKey || e.metaKey) {
                toggleSelect(id);
                return;
            }
            showMovieDetail(id);
        });
    });
}

// 计算返回上级的路径（去掉最后一段）
function segmentsForUp(path) {
    if (!path) return '';
    const segments = String(path).split('/').filter(Boolean);
    return segments.slice(0, -1).join('/');
}

// 在同级列表中定位作品所在父节点
function findNodeWithItem(node, movieId) {
    if (!node) return null;
    if (node.items && node.items.some(it => String(it.id) === String(movieId))) return node;
    if (node.children) {
        for (const c of node.children) {
            const r = findNodeWithItem(c, movieId);
            if (r) return r;
        }
    }
    return null;
}

// 计算某作品的同级列表 [{ id, title }]（无同级/找不到返回 []）
function findSiblings(type, movieId) {
    const { tree } = getTreeState(type);
    if (!tree) return [];
    const parent = findNodeWithItem(tree, movieId);
    if (!parent || !parent.items) return [];
    return parent.items.map(it => ({
        id: it.id,
        title: it.displayTitle || it.title || it.fileName || it.folderName || '未命名'
    }));
}

// 计算详情弹窗/阅读器的上一本/下一本导航信息
function getSiblingNav(type, movieId) {
    const siblings = findSiblings(type, movieId);
    const idx = siblings.findIndex(s => String(s.id) === String(movieId));
    if (idx < 0 || siblings.length <= 1) return null;
    return {
        prev: idx > 0 ? siblings[idx - 1] : null,
        next: idx < siblings.length - 1 ? siblings[idx + 1] : null,
        index: idx,
        total: siblings.length
    };
}

// 渲染文件夹树中的单个漫画卡片（用 displayTitle 兜底文件夹名）
// 【AvBoard 兜底路径】正常会被 av-board.js 接管，只有该文件缺失时才走这里
function renderComicTreeCard(movie) {
    const posterUrl = getPosterUrl(movie);
    const isFav = movie.favorite === 1;
    const isWatched = movie.watched === 1;
    const displayTitle = movie.displayTitle || movie.title || movie.fileName || movie.folderName || '未命名';
    const avid = movie.avid || '';
    const isNew = movie.addedTime && (Date.now() - Number(movie.addedTime)) < 7 * 864e5;
    const metaLine = [movie.folderName || '', movie.fileSize ? formatSize(movie.fileSize) : ''].filter(Boolean).join(' · ');

    return `
        <div class="movie-card movie-card-compact ${isFav ? 'favorite' : ''} ${isWatched ? 'watched' : ''}" data-id="${movie.id}" title="${displayTitle}">
            ${isFav ? '<span class="badge-fav">⭐</span>' : ''}
            ${isWatched ? '<span class="badge-watched">✓</span>' : ''}
            <div class="movie-poster-wrap">
                ${isNew ? '<span class="movie-badge-new">NEW</span>' : ''}
                <img class="movie-poster" src="${posterUrl || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 200%22%3E%3Crect fill=%22%23e2e8f0%22 width=%22400%22 height=%22200%22/%3E%3Ctext x=%22200%22 y=%22115%22 text-anchor=%22middle%22 fill=%22%2394a3b8%22 font-size=%2240%22%3E📚%3C/text%3E%3C/svg%3E'}" alt="${displayTitle}" loading="lazy">
                <div class="movie-avid-overlay">${avid}</div>
                <div class="movie-hover-info">
                    <div class="movie-hover-title">${escapeHtml(displayTitle)}</div>
                    <div class="movie-hover-meta">
                        <span>${movie.folderName ? escapeHtml(movie.folderName) : ''}</span>
                        <span>${formatSize(movie.fileSize)}</span>
                    </div>
                </div>
            </div>
            <div class="movie-title-below">${escapeHtml(displayTitle)}${metaLine ? `<span class="mtb-meta">${metaLine}</span>` : ''}</div>
        </div>
    `;
}

function hidePagination() {
    const pagination = document.getElementById('pagination');
    if (pagination) pagination.style.display = 'none';
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 切换小说视图（本地/网盘）
async function switchNovelView(view) {
    document.querySelectorAll('#novelCloudToggle .toggle-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');

    if (view === 'local') {
        loadNovel();
    } else {
        // 小说网盘直接用夸克网盘文件浏览
        loadQuarkFiles('0', true, 'novel');
    }
}

// 切换漫画视图（本地/网盘）
async function switchComicView(view) {
    // 更新按钮状态
    document.querySelectorAll('#comicCloudToggle .toggle-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    if (view === 'local') {
        loadComic();
    } else {
        showCloudSourceSelect();
    }
}

// 显示网盘源选择
async function showCloudSourceSelect() {
    const grid = document.getElementById('movieGrid');
    updateToolbarTitle('☁️ 网盘资源');
    currentView = 'comic-cloud';
    await loadCloudStars('comic');
    const shortcuts = await cloudShortcutsHtml('comic');
    hideTreeBreadcrumb();
    grid.classList.remove('tree-mode');
    
    grid.innerHTML = `
        <div style="grid-column:1/-1;display:flex;gap:20px;justify-content:center;padding:40px;">
            <div class="cloud-source-card" onclick="loadKmoeComic()" style="cursor:pointer;padding:30px;border:2px solid var(--border);border-radius:16px;text-align:center;min-width:200px;transition:all 0.3s;" onmouseover="this.style.borderColor='var(--primary)';this.style.transform='translateY(-4px)'" onmouseout="this.style.borderColor='var(--border)';this.style.transform=''">
                <div style="font-size:48px;margin-bottom:12px;">📚</div>
                <div style="font-size:18px;font-weight:600;margin-bottom:8px;">Kmoe / KOOBONE</div>
                <div style="font-size:13px;color:var(--text-muted);">Kindle/epub漫画</div>
                <button class="btn" style="margin-top:16px;">进入</button>
            </div>
            <div class="cloud-source-card" onclick="loadQuarkFiles('0', true, 'comic')" style="cursor:pointer;padding:30px;border:2px solid var(--border);border-radius:16px;text-align:center;min-width:200px;transition:all 0.3s;" onmouseover="this.style.borderColor='var(--primary)';this.style.transform='translateY(-4px)'" onmouseout="this.style.borderColor='var(--border)';this.style.transform=''">
                <div style="font-size:48px;margin-bottom:12px;">☁️</div>
                <div style="font-size:18px;font-weight:600;margin-bottom:8px;">夸克网盘</div>
                <div style="font-size:13px;color:var(--text-muted);">视频/漫画/小说</div>
                <button class="btn" style="margin-top:16px;">进入</button>
            </div>
        </div>
        ${shortcuts}
    `;
}

// 加载Kmoe漫画
async function loadKmoeComic() {
    updateToolbarTitle('☁️ 网盘漫画 (Kmoe)');
    currentView = 'comic-cloud-kmoe';
    
    // 检查登录状态
    try {
        const res = await fetch('/api/cloud/kmoe/hot');
        const data = await res.json();
        
        if (data.code === 0 && data.data && data.data.length > 0) {
            renderCloudComics(data.data);
        } else {
            // 显示登录界面
            showKmoeLogin();
        }
    } catch (e) {
        showKmoeLogin();
    }
}

// 显示Kmoe登录界面
function showKmoeLogin() {
    const grid = document.getElementById('movieGrid');
    grid.innerHTML = `
        <div style="grid-column:1/-1;display:flex;justify-content:center;padding:40px;">
            <div style="background:var(--card-bg);border-radius:16px;padding:32px;box-shadow:var(--shadow-lg);max-width:400px;width:100%;">
                <h3 style="text-align:center;margin-bottom:24px;">🔐 Kmoe 登录</h3>
                <div style="margin-bottom:16px;">
                    <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">邮箱账号</label>
                    <input type="text" id="kmoeUsername" class="search-input" style="width:100%;" placeholder="请输入邮箱" value="417810572@qq.com">
                </div>
                <div style="margin-bottom:20px;">
                    <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">密码</label>
                    <input type="password" id="kmoePassword" class="search-input" style="width:100%;" placeholder="请输入密码">
                </div>
                <button class="btn" style="width:100%;" onclick="doKmoeLogin()">登录</button>
                <p style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:16px;">
                    登录后即可浏览和下载网盘漫画
                </p>
            </div>
        </div>
    `;
}

// 执行Kmoe登录
async function doKmoeLogin() {
    const username = document.getElementById('kmoeUsername').value;
    const password = document.getElementById('kmoePassword').value;
    
    if (!username || !password) {
        showNotification('请输入账号和密码', 'error');
        return;
    }
    
    try {
        const res = await fetch('/api/cloud/kmoe/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('登录成功！', 'success');
            loadKmoeComic();
        } else {
            showNotification('登录失败: ' + data.msg, 'error');
        }
    } catch (e) {
        showNotification('登录失败: ' + e.message, 'error');
    }
}

// 加载夸克网盘文件
async function loadQuarkFiles(fid = '0', addToHistory = true, kind = '', folderName = '', page = 1) {
    updateToolbarTitle('☁️ 夸克网盘');
    currentView = 'comic-cloud-quark';
    if (kind) quarkCurrentKind = kind;
    
    // 保存路径历史（存 {fid,name}，否则面包屑只能显示一串 fid）
    if (addToHistory && fid !== quarkCurrentFid) {
        quarkPathHistory.push({ fid: quarkCurrentFid, name: quarkCurrentFolderName });
    }
    quarkCurrentFid = fid;
    if (folderName) quarkCurrentFolderName = folderName;
    else if (fid === '0') quarkCurrentFolderName = '根目录';
    await loadCloudStars(quarkCurrentKind);
    quarkPage = page;
    
    // 检查是否有cookie
    try {
        const res = await fetch(`/api/cloud/quark/files?fid=${fid}&page=${page}&pageSize=${QUARK_PAGE_SIZE}`);
        const data = await res.json();
        
        if (data.code === 0 && data.data) {
            quarkCurrentFiles = data.data.list || [];
            quarkTotal = Number(data.data.total) || quarkCurrentFiles.length;
            renderQuarkFiles(data.data);
        } else {
            showQuarkCookieInput();
        }
    } catch (e) {
        showQuarkCookieInput();
    }
}

// 返回上一级文件夹
function quarkGoBack() {
    if (quarkPathHistory.length > 0) {
        const prev = quarkPathHistory.pop();
        const fid = (prev && typeof prev === 'object') ? prev.fid : prev;
        const name = (prev && typeof prev === 'object') ? prev.name : '';
        loadQuarkFiles(fid, false, '', name);
    }
}

// 显示夸克网盘cookie输入
function showQuarkCookieInput() {
    const grid = document.getElementById('movieGrid');
    grid.innerHTML = `
        <div style="grid-column:1/-1;display:flex;justify-content:center;padding:40px;">
            <div style="background:var(--card-bg);border-radius:16px;padding:32px;box-shadow:var(--shadow-lg);max-width:500px;width:100%;">
                <h3 style="text-align:center;margin-bottom:24px;">🔐 夸克网盘登录</h3>
                <div style="margin-bottom:20px;">
                    <button class="btn" style="width:100%;background:linear-gradient(135deg,#667eea,#764ba2);color:white;border:none;" onclick="quarkCDPLogin()">
                        🚀 一键登录（自动打开浏览器）
                    </button>
                    <p style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:8px;">
                        点击后会自动打开夸克网盘登录页，登录成功后自动获取Cookie
                    </p>
                </div>
                <div style="display:flex;align-items:center;gap:12px;margin:20px 0;">
                    <div style="flex:1;height:1px;background:var(--border);"></div>
                    <span style="font-size:12px;color:var(--text-muted);">或手动粘贴Cookie</span>
                    <div style="flex:1;height:1px;background:var(--border);"></div>
                </div>
                <div style="margin-bottom:20px;">
                    <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">Cookie</label>
                    <textarea id="quarkCookie" class="search-input" style="width:100%;height:120px;resize:vertical;" placeholder="请粘贴夸克网盘的Cookie"></textarea>
                </div>
                <button class="btn" style="width:100%;" onclick="setQuarkCookie()">设置 Cookie</button>
                <p style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:16px;">
                    请先在浏览器登录夸克网盘，然后复制Cookie粘贴到这里
                </p>
            </div>
        </div>
    `;
}

// 夸克网盘CDP一键登录
async function quarkCDPLogin() {
    try {
        showNotification('正在启动浏览器', '请在弹出的浏览器中登录夸克网盘...');
        const res = await fetch('/api/cloud/quark/login', { method: 'POST' });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('登录成功！', 'Cookie已自动保存，正在加载文件列表...');
            setTimeout(() => loadQuarkFiles(), 1000);
        } else {
            showNotification('登录失败', data.msg || '未知错误');
        }
    } catch (e) {
        showNotification('登录失败', e.message);
    }
}

// 设置夸克网盘cookie
async function setQuarkCookie() {
    const cookie = document.getElementById('quarkCookie').value;
    
    if (!cookie) {
        showNotification('请输入Cookie', 'error');
        return;
    }
    
    try {
        const res = await fetch('/api/cloud/quark/set-cookie', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('Cookie设置成功！', 'success');
            loadQuarkFiles();
        } else {
            showNotification('设置失败: ' + data.msg, 'error');
        }
    } catch (e) {
        showNotification('设置失败: ' + e.message, 'error');
    }
}

// 获取文件图标
function getFileIcon(file) {
    const fileName = file.file_name || file.name || '';
    const ext = fileName.split('.').pop().toLowerCase();
    
    // 文件夹
    if (file.file_type === 0 || file.type === 'folder' || file.category === 0) {
        return '📁';
    }
    
    // 视频文件
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg'];
    if (videoExts.includes(ext)) {
        return '🎬';
    }
    
    // 图片文件
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff'];
    if (imageExts.includes(ext)) {
        return '🖼️';
    }
    
    // 音频文件
    const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a'];
    if (audioExts.includes(ext)) {
        return '🎵';
    }
    
    // 文档文件
    const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'];
    if (docExts.includes(ext)) {
        return '📄';
    }
    
    // 压缩文件
    const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
    if (archiveExts.includes(ext)) {
        return '📦';
    }
    
    // 漫画/电子书
    const bookExts = ['epub', 'mobi', 'azw3', 'cbz', 'cbr', 'pdf'];
    if (bookExts.includes(ext)) {
        return '📚';
    }
    
    // 默认
    return '📄';
}

// 判断是否是文件夹
function isFolder(file) {
    return file.file_type === 0 || file.type === 'folder' || file.category === 0 || (file.size === 0 && file.include_items !== undefined);
}

// 渲染夸克网盘文件
async function renderQuarkFiles(filesData) {
    const grid = document.getElementById('movieGrid');
    grid.style.display = 'grid';
    
    const files = filesData.list || filesData || [];
    // 收藏/最近只在一级页显示，进到子文件夹就别刷屏了
    const showShortcuts = quarkCurrentFid === '0' && quarkPage === 1;   // 翻到第 2 页就别再重复那两排了
    const shortcuts = showShortcuts ? await cloudShortcutsHtml(quarkCurrentKind) : '';
    
    // 面包屑导航
    const breadcrumb = `
        <div style="grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:12px 16px;background:var(--card-bg);border-radius:12px;box-shadow:var(--shadow-sm);">
            ${quarkPathHistory.length > 0 ? `
                <button class="btn" style="padding:8px 16px;font-size:14px;" onclick="quarkGoBack()">
                    ← 返回
                </button>
            ` : ''}
            <span style="color:var(--text-muted);font-size:14px;">
                ${['📍 夸克网盘',
                   ...quarkPathHistory.map(h => `<a href="#" onclick="event.preventDefault();loadQuarkFiles('${h.fid}',false,'','${String(h.name).replace(/'/g, '')}')" style="color:var(--primary);text-decoration:none;">${escapeHtml(String(h.name))}</a>`),
                   `<strong style="color:var(--text);">${escapeHtml(String(quarkCurrentFolderName))}</strong>`].join(' / ')}
            </span>
            <button class="btn btn-sm" onclick="toggleQuarkStar('${quarkCurrentFid}','${String(quarkCurrentFolderName).replace(/'/g, '')}',1,0)" title="收藏当前文件夹">
                ${cloudStarSet.has(quarkCurrentFid) ? '✳ 已收藏' : '✳ 收藏此文件夹'}
            </button>
            <span style="margin-left:auto;color:var(--text-muted);font-size:13px;">
                共 ${quarkTotal || files.length} 个项目${Math.ceil((quarkTotal || files.length) / QUARK_PAGE_SIZE) > 1 ? ` · 第 ${quarkPage}/${Math.ceil((quarkTotal || files.length) / QUARK_PAGE_SIZE)} 页` : ''}
            </span>
        </div>
    `;
    
    if (!files || files.length === 0) {
        grid.innerHTML = breadcrumb + `
            <div class="empty-state" style="grid-column:1/-1;">
                <div style="font-size:48px;margin-bottom:16px;">📭</div>
                <div style="color:var(--text-muted);">暂无文件</div>
            </div>
        `;
        return;
    }
    
    // 排序：文件夹在前，文件在后
    const sortedFiles = [...files].sort((a, b) => {
        const aIsFolder = isFolder(a);
        const bIsFolder = isFolder(b);
        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
        return (a.file_name || a.name || '').localeCompare(b.file_name || b.name || '');
    });
    
    grid.innerHTML = breadcrumb + shortcuts + sortedFiles.map(file => {
        const isFolderFile = isFolder(file);
        const fileName = String(file.file_name || file.name || '');
        const fileSize = file.size ? formatSize(file.size) : (isFolderFile ? `${file.include_items || 0} 项` : '');
        const safeName = fileName.replace(/'/g, '');
        const starred = cloudStarSet.has(file.fid);
        
        return `
            <div class="movie-card cloud-card">
                <div class="cloud-tile" onclick="quarkOpenEntry('${file.fid}','${safeName}',${isFolderFile ? 1 : 0},${Number(file.size) || 0})">
                    <span style="font-size:56px;">${getFileIcon(file)}</span>
                    ${isFolderFile ? '' : `
                        <div class="poster-overlay">
                            <div class="play-btn">▶</div>
                        </div>
                    `}
                </div>
                <div class="movie-info">
                    <div class="movie-title cloud-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
                    <div class="movie-meta">
                        <span class="source-tag">${fileSize}</span>
                    </div>
                </div>
                <button class="cloud-star ${starred ? 'on' : ''}" title="${starred ? '取消收藏' : '收藏'}"
                    onclick="event.stopPropagation();toggleQuarkStar('${file.fid}','${safeName}',${isFolderFile ? 1 : 0},${Number(file.size) || 0})">${starred ? '✳' : '☆'}</button>
                ${isFolderFile ? '' : `<button class="cloud-star cloud-more" title="详情 / 下载" style="left:6px;right:auto;"
                    onclick="event.stopPropagation();openQuarkFile('${file.fid}')">⋯</button>`}
            </div>
        `;
    }).join('') + quarkPagerHtml();
}

// 网盘翻页条（复用影片分页的 .page-btn 样式）
function quarkPagerHtml() {
    const total = quarkTotal || quarkCurrentFiles.length;
    const pages = Math.max(1, Math.ceil(total / QUARK_PAGE_SIZE));
    if (pages <= 1) return '';
    const btn = (label, p, disabled) => `<button class="page-btn" ${disabled ? 'disabled' : ''} onclick="quarkGoPage(${p})">${label}</button>`;
    const around = [];
    for (let p = Math.max(1, quarkPage - 2); p <= Math.min(pages, quarkPage + 2); p++) around.push(p);
    return `
        <div class="pagination" style="grid-column:1/-1;display:flex;justify-content:center;align-items:center;gap:6px;margin:22px 0 6px;flex-wrap:wrap;">
            ${btn('上一页', quarkPage - 1, quarkPage <= 1)}
            ${around.map(p => `<button class="page-btn ${p === quarkPage ? 'current' : ''}" onclick="quarkGoPage(${p})">${p}</button>`).join('')}
            ${btn('下一页', quarkPage + 1, quarkPage >= pages)}
            <span style="color:var(--text-muted);font-size:12px;margin-left:8px;">共 ${total} 项 / ${pages} 页</span>
        </div>`;
}

// 翻到指定页（保持当前文件夹、面包屑和类型不变）
function quarkGoPage(p) {
    if (p < 1) return;
    loadQuarkFiles(quarkCurrentFid, false, '', quarkCurrentFolderName, p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ========== 网盘星标 / 历史 ==========
// 打开一个网盘条目：文件夹就进去，文件按类型直接调起对应工具（不再多弹一层选项框）
const QUARK_VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts'];
const QUARK_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];

function quarkOpenEntry(fid, name, isDir, size) {
    fetch('/api/cloud/quark/touch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fid, name, is_dir: isDir, size, kind: quarkCurrentKind, pdir_fid: quarkCurrentFid })
    }).catch(() => {});
    if (isDir) return loadQuarkFiles(fid, true, '', name);

    const ext = String(name || '').split('.').pop().toLowerCase();
    if (QUARK_VIDEO_EXTS.includes(ext)) return playQuarkVideo(fid, name);
    if (['pdf', 'epub', 'txt'].includes(ext)) return openCloudReader(fid, name);
    if (QUARK_IMAGE_EXTS.includes(ext)) return showQuarkImage(fid, name);
    return openQuarkFile(fid); // 其他格式（zip/cbz…）：保留详情弹窗，走下载
}

async function loadCloudStars(kind) {
    try {
        const d = await (await fetch(`/api/cloud/quark/starred?kind=${kind || ''}`)).json();
        cloudStarSet = new Set(((d && d.data) || []).map(x => String(x.fid)));
    } catch (e) { cloudStarSet = new Set(); }
}

async function toggleQuarkStar(fid, name, isDir, size) {
    const on = !cloudStarSet.has(String(fid));
    try {
        const r = await (await fetch('/api/cloud/quark/star', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fid, name, is_dir: isDir, size, kind: quarkCurrentKind, pdir_fid: quarkCurrentFid, starred: on })
        })).json();
        if (r.code !== 0) throw new Error(r.msg || '保存失败');
        if (on) cloudStarSet.add(String(fid)); else cloudStarSet.delete(String(fid));
        showNotification(on ? '已收藏' : '已取消收藏', name);
        renderQuarkFiles({ list: quarkCurrentFiles });
    } catch (e) { showNotification('操作失败', e.message, 'error'); }
}

// 主页顶部那一排：收藏 + 最近打开
async function cloudShortcutsHtml(kind) {
    try {
        const [sr, rr] = await Promise.all([
            fetch(`/api/cloud/quark/starred?kind=${kind || ''}`).then(x => x.json()),
            fetch(`/api/cloud/quark/recent?kind=${kind || ''}&limit=24`).then(x => x.json())
        ]);
        const stars = (sr && sr.data) || [];
        const recents = ((rr && rr.data) || []).filter(x => !stars.some(y => String(y.fid) === String(x.fid)));
        if (!stars.length && !recents.length) return '';
        const card = (it, tag) => `
            <div class="movie-card cloud-card">
                <div class="cloud-tile" onclick="quarkOpenEntry('${it.fid}','${String(it.name || '').replace(/'/g, '')}',${it.is_dir ? 1 : 0},${Number(it.size) || 0})">
                    <span style="font-size:52px;">${it.is_dir ? '📁' : '📄'}</span>
                </div>
                <div class="movie-info">
                    <div class="movie-title cloud-name">${escapeHtml(String(it.name || ''))}</div>
                    <div class="movie-meta"><span class="source-tag">${tag}</span></div>
                </div>
            </div>`;
        return `
            ${stars.length ? `<div class="cloud-sec" style="grid-column:1/-1;">✳ 我的收藏 · ${stars.length}</div>` + stars.map(x => card(x, '收藏')).join('') : ''}
            ${recents.length ? `<div class="cloud-sec" style="grid-column:1/-1;">🕘 最近打开</div>` + recents.map(x => card(x, '最近')).join('') : ''}`;
    } catch (e) { return ''; }
}

// 打开夸克网盘文件
async function openQuarkFile(fid) {
    try {
        // 记一笔打开历史（主页「最近打开」要用）
        const _f = (quarkCurrentFiles || []).find(x => String(x.fid) === String(fid));
        if (_f) {
            fetch('/api/cloud/quark/touch', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fid, name: _f.file_name || _f.name || '', is_dir: 0, size: _f.size || 0, kind: quarkCurrentKind, pdir_fid: quarkCurrentFid })
            }).catch(() => {});
        }
        const res = await fetch(`/api/cloud/quark/detail?fid=${fid}`);
        const data = await res.json();
        
        if (data.code === 0 && data.data) {
            const file = data.data;
            showQuarkFileDetail(file);
        }
    } catch (e) {
        showNotification('获取文件详情失败: ' + e.message, 'error');
    }
}

// 判断夸克文件是否可在线阅读
function isQuarkReadableFile(fileName) {
    if (!fileName) return false;
    const ext = fileName.split('.').pop().toLowerCase();
    return ['epub', 'pdf', 'txt', 'cbz', 'cbr', 'zip'].includes(ext);
}

// 在线阅读夸克网盘文件（详情弹窗里的按钮复用这里）
async function readQuarkFile(fid, fileName) {
    const ext = fileName.split('.').pop().toLowerCase();

    if (['pdf', 'epub', 'txt'].includes(ext)) {
        closeQuarkDetail();
        return openCloudReader(fid, fileName);
    }

    // 其他格式（cbz/cbr/zip）：提示下载后阅读
    showNotification('该格式暂不支持在线阅读', '请先下载到本地后阅读');
}

// 在应用内置阅读器里打开网盘文件（pdf / epub / txt）
function openCloudReader(fid, fileName) {
    // 网盘文件不在片库里，上一本/下一本不适用
    currentReaderBookId = null;
    currentReaderType = null;
    document.getElementById('readerTitle').textContent = fileName;
    document.getElementById('readerFrame').src =
        `/cloud-reader.html?fid=${encodeURIComponent(fid)}&name=${encodeURIComponent(fileName)}`;
    document.getElementById('readerView').classList.add('show');
    document.body.style.overflow = 'hidden';
    const prev = document.getElementById('readerPrevBtn');
    const next = document.getElementById('readerNextBtn');
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    showNotification('已打开阅读器', fileName);
}

// 图片：全屏灯箱（方向键翻同文件夹的图片，带页数）
// 注意：必须用 .modal + .show —— .detail-modal 只是内容类（max-width:720px），
// 单独 append 到 body 会变成普通块级元素，图片就跑到页面最下面且关不掉。
let cloudImageList = [];
let cloudImageIndex = 0;

function showQuarkImage(fid, fileName) {
    const inFolder = (quarkCurrentFiles || []).filter((f) => {
        if (isFolder(f)) return false;
        const n = String(f.file_name || f.name || '');
        return QUARK_IMAGE_EXTS.includes(n.split('.').pop().toLowerCase());
    }).map((f) => ({ fid: String(f.fid), name: String(f.file_name || f.name || '') }));

    const at = inFolder.findIndex((x) => x.fid === String(fid));
    if (at >= 0) {
        cloudImageList = inFolder;
        cloudImageIndex = at;
    } else {
        // 从收藏/最近打开进来的，当前文件夹列表里没有它
        cloudImageList = [{ fid: String(fid), name: fileName || '' }];
        cloudImageIndex = 0;
    }
    renderCloudImage();
}

function renderCloudImage() {
    const old = document.getElementById('cloudImageViewer');
    if (old) old.remove();
    const cur = cloudImageList[cloudImageIndex];
    if (!cur) return;
    const many = cloudImageList.length > 1;

    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'cloudImageViewer';
    el.onclick = (e) => { if (e.target === el) closeCloudImage(); };
    el.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:12px;max-width:94vw;">
            <img src="/api/cloud/quark/stream?fid=${encodeURIComponent(cur.fid)}" alt="${escapeHtml(cur.name)}"
                 style="max-width:92vw;max-height:80vh;object-fit:contain;border-radius:10px;display:block;">
            <div style="color:#fff;font-size:13px;display:flex;gap:14px;align-items:center;">
                ${many ? '<button class="btn btn-sm" onclick="stepCloudImage(-1)" title="上一张（←）">←</button>' : ''}
                <span>${escapeHtml(cur.name)} · ${cloudImageIndex + 1} / ${cloudImageList.length}</span>
                ${many ? '<button class="btn btn-sm" onclick="stepCloudImage(1)" title="下一张（→）">→</button>' : ''}
            </div>
        </div>
        <button class="detail-close" onclick="closeCloudImage()" title="关闭（Esc）">×</button>
    `;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
}

function stepCloudImage(delta) {
    if (cloudImageList.length < 2) return;
    cloudImageIndex = (cloudImageIndex + delta + cloudImageList.length) % cloudImageList.length;
    renderCloudImage();
}

function closeCloudImage() {
    const el = document.getElementById('cloudImageViewer');
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 150);
}

document.addEventListener('keydown', (e) => {
    if (!document.getElementById('cloudImageViewer')) return;
    if (e.key === 'Escape') closeCloudImage();
    else if (e.key === 'ArrowLeft') stepCloudImage(-1);
    else if (e.key === 'ArrowRight') stepCloudImage(1);
});


// 显示夸克网盘文件详情
function showQuarkFileDetail(file) {
    const fileName = file.file_name || file.name || '';
    const fileSize = file.size ? formatSize(file.size) : '未知';
    const isVideo = isVideoFile(file);
    const fileIcon = getFileIcon(file);
    
    // 格式化时间
    const createdTime = file.l_created_at ? new Date(file.l_created_at).toLocaleString() : '未知';
    const updatedTime = file.l_updated_at ? new Date(file.l_updated_at).toLocaleString() : '未知';
    
    const detailHtml = `
        <div class="detail-modal" id="quarkDetailModal" onclick="if(event.target === this) closeQuarkDetail()">
            <div class="detail-content">
                <button class="detail-close" onclick="closeQuarkDetail()">×</button>
                <div class="detail-header" style="flex-direction:column;align-items:center;text-align:center;">
                    <div style="font-size:96px;margin-bottom:20px;">${fileIcon}</div>
                    <div style="flex:1;">
                        <h2 style="margin-bottom:8px;">${fileName}</h2>
                        <div style="color:var(--text-muted);font-size:14px;margin-bottom:16px;">
                            ${fileSize}
                        </div>
                    </div>
                </div>
                
                <div class="detail-actions" style="justify-content:center;flex-wrap:wrap;gap:10px;">
                    ${isVideo ? `
                        <button class="btn btn-primary" onclick="playQuarkVideo('${file.fid}', '${fileName}')">
                            ▶ 在线播放
                        </button>
                    ` : ''}
                    ${isQuarkReadableFile(fileName) ? `
                        <button class="btn btn-primary" onclick="readQuarkFile('${file.fid}', '${fileName.replace(/'/g, "\\'")}')">
                            📖 在线阅读
                        </button>
                    ` : ''}
                    <button class="btn" onclick="downloadQuarkFile('${file.fid}')">
                        ⬇️ 下载文件
                    </button>
                    <button class="btn" onclick="copyQuarkFileName('${fileName}')">
                        📋 复制文件名
                    </button>
                </div>
                
                <div class="detail-meta">
                    <div class="meta-item">
                        <span class="meta-label">文件大小</span>
                        <span class="meta-value">${fileSize}</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">创建时间</span>
                        <span class="meta-value">${createdTime}</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">修改时间</span>
                        <span class="meta-value">${updatedTime}</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">文件ID</span>
                        <span class="meta-value" style="font-size:12px;">${file.fid}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // 插入到页面
    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = detailHtml;
    document.body.appendChild(modalContainer.firstElementChild);
    
    // 添加动画类
    setTimeout(() => {
        document.getElementById('quarkDetailModal').classList.add('show');
    }, 10);
}

// 关闭夸克文件详情
function closeQuarkDetail() {
    const modal = document.getElementById('quarkDetailModal');
    if (modal) {
        modal.classList.remove('show');
        setTimeout(() => modal.remove(), 300);
    }
}

// 判断是否是视频文件
function isVideoFile(file) {
    const fileName = file.file_name || file.name || '';
    const ext = fileName.split('.').pop().toLowerCase();
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg'];
    return videoExts.includes(ext);
}

// 播放夸克网盘视频（地址由服务端代理，浏览器只拿本站 URL）
async function playQuarkVideo(fid, fileName) {
    try {
        showNotification('正在获取播放地址', fileName || '夸克网盘');
        const res = await fetch(`/api/cloud/quark/video?fid=${fid}`);
        const data = await res.json();

        if (data.code !== 0 || !data.data) {
            showNotification('无法播放', data.msg || '未知错误');
            return;
        }

        closeQuarkDetail();
        showVideoPlayer(data.data.url, fileName, data.data.kind);
    } catch (e) {
        showNotification('无法播放', e.message);
    }
}

// 下载夸克网盘文件
async function downloadQuarkFile(fid) {
    try {
        showNotification('正在获取下载链接...', 'info');
        
        const res = await fetch(`/api/cloud/quark/download?fid=${fid}`);
        const data = await res.json();
        
        if (data.code === 0 && data.data && data.data.url) {
            // 打开下载链接
            window.open(data.data.url, '_blank');
            showNotification('开始下载...', 'success');
        } else {
            showNotification('获取下载链接失败: ' + (data.msg || '未知错误'), 'error');
        }
    } catch (e) {
        showNotification('获取下载链接失败: ' + e.message, 'error');
    }
}

// 复制文件名
function copyQuarkFileName(fileName) {
    navigator.clipboard.writeText(fileName).then(() => {
        showNotification('文件名已复制', 'success');
    }).catch(() => {
        showNotification('复制失败', 'error');
    });
}

// 加载网盘漫画
async function loadCloudComic() {
    showCloudSourceSelect();
}

// 渲染网盘漫画
function renderCloudComics(comics) {
    const grid = document.getElementById('movieGrid');
    grid.style.display = 'grid';
    
    if (comics.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1;">
                <div style="font-size:48px;margin-bottom:16px;">📭</div>
                <div style="color:var(--text-muted);">暂无漫画</div>
            </div>
        `;
        return;
    }
    
    grid.innerHTML = comics.map(comic => `
        <div class="movie-card" onclick="showCloudComicDetail('${comic.url}')">
            <div class="movie-poster">
                <img src="${comic.cover}" alt="${comic.title}" loading="lazy">
                <div class="poster-overlay">
                    <div class="play-btn">▶</div>
                </div>
            </div>
            <div class="movie-info">
                <div class="movie-title">${comic.title}</div>
                <div class="movie-meta">
                    <span class="source-tag">KMOE</span>
                </div>
            </div>
        </div>
    `).join('');
}

// 显示网盘漫画详情
async function showCloudComicDetail(url) {
    try {
        showNotification('正在获取详情...');
        const res = await fetch(`/api/cloud/kmoe/detail?url=${encodeURIComponent(url)}`);
        const data = await res.json();
        
        if (data.code === 0) {
            const comic = data.data;
            // 显示详情弹窗
            showCloudComicModal(comic);
        } else {
            showNotification(data.msg || '获取详情失败', 'error');
        }
    } catch (e) {
        showNotification('获取详情失败: ' + e.message, 'error');
    }
}

// 显示网盘漫画详情弹窗
function showCloudComicModal(comic) {
    const html = `

        <div class="detail-header">

            <div class="detail-poster">

                <img src="${comic.cover || ''}" alt="${comic.title}">

            </div>

            <div class="detail-info">

                <div class="detail-title">${comic.title || ''}</div>

                <span class="detail-avid">KMOE</span>

                

                <div class="detail-meta-grid">

                    <div class="detail-meta-item">

                        <div class="detail-meta-label">作者</div>

                        <div class="detail-meta-value">${comic.author || '-'}</div>

                    </div>

                    <div class="detail-meta-item">

                        <div class="detail-meta-label">状态</div>

                        <div class="detail-meta-value">${comic.status || '-'}</div>

                    </div>

                    <div class="detail-meta-item">

                        <div class="detail-meta-label">章节数</div>

                        <div class="detail-meta-value">${comic.chapters?.length || 0} 章</div>

                    </div>

                </div>

                

                <div class="detail-actions">

                    <button class="btn" onclick="downloadCloudComic('${comic.url}')">📥 下载</button>

                    <button class="btn btn-secondary btn-sm" onclick="readCloudComic('${comic.url}')">📖 在线阅读</button>

                </div>

            </div>

        </div>

        

        ${comic.description ? `<div class="detail-overview" style="margin-top:12px;">${comic.description}</div>` : ''}
    `;

    document.getElementById('detailBody').innerHTML = html;
    // 右侧抽屉：先 .show（display:flex 就位），下一帧再加 .in 触发滑入过渡
    const dm = document.getElementById('detailModal');
    dm.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => dm.classList.add('in')));
}

// 下载网盘漫画
async function downloadCloudComic(url) {
    try {
        showNotification('正在获取下载链接...');
        const res = await fetch(`/api/cloud/kmoe/download?url=${encodeURIComponent(url)}&format=epub`);
        const data = await res.json();
        
        if (data.code === 0 && data.data.url) {
            window.open(data.data.url, '_blank');
            showNotification('下载链接已打开');
        } else {
            showNotification(data.msg || '获取下载链接失败', 'error');
        }
    } catch (e) {
        showNotification('获取下载链接失败: ' + e.message, 'error');
    }
}

// 在线阅读
async function readCloudComic(url) {
    showNotification('在线阅读功能开发中...');
}

// 阅读章节
async function readChapter(url) {
    showNotification('在线阅读功能开发中...');
}

// 加载小说列表
async function loadNovel(page = 1) {
    updateToolbarTitle('📖 小说库');
    currentView = 'novel';
    currentPage = page;
    
    // 增加切换按钮
    const toolbarRight = document.querySelector('.toolbar-right');
    if (toolbarRight && !document.getElementById('novelCloudToggle')) {
        toolbarRight.insertAdjacentHTML('afterbegin', `
            <div class="view-toggle" id="novelCloudToggle">
                <button class="toggle-btn active" onclick="switchNovelView('local')">本地</button>
                <button class="toggle-btn" onclick="switchNovelView('cloud')">网盘</button>
            </div>
        `);
    }
    
    try {
        const res = await fetch('/api/novel/tree');
        const data = await res.json();
        if (data.code === 0 && data.data && data.data.tree) {
            novelTree = data.data.tree;
            novelTreePath = '';
            renderTreeLibrary('novel');
            document.getElementById('countNovel').textContent = countTreeItems(novelTree);
        } else {
            // 兜底：普通列表
            const sort = currentSort;
            const movies = await api.getMovies(sort, 'all', 'novel', page, 50);
            currentMovies = movies;
            renderMovies(currentMovies);
            renderPagination();
            document.getElementById('countNovel').textContent = currentTotal;
        }
        loadReadingStatsBanner('novel');
    } catch (e) {
        console.error('加载小说失败:', e);
    }
}

// ========== 阅读时长统计横幅（漫画/小说库顶部） ==========
function formatDurationHMS(seconds) {
    seconds = parseInt(seconds) || 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}小时${m}分`;
    return `${m}分钟`;
}

function formatDateLabel(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
}

// 生成纯CSS柱状图
function renderBarChart(daily) {
    if (!daily || daily.length === 0) return '';
    const maxSec = Math.max(...daily.map(d => d.seconds), 1);
    const bars = daily.map(d => {
        const pct = Math.round((d.seconds / maxSec) * 100);
        const today = d.date === new Date().toISOString().slice(0, 10);
        return `
            <div class="read-chart-col" title="${d.date} · ${formatDurationHMS(d.seconds)}">
                <div class="read-chart-bar-wrap">
                    <div class="read-chart-bar ${today ? 'today' : ''}" style="height:${Math.max(pct, 2)}%">
                        ${d.seconds > 0 ? `<span class="read-chart-val">${Math.round(d.seconds / 60)}m</span>` : ''}
                    </div>
                </div>
                <div class="read-chart-label">${formatDateLabel(d.date)}</div>
            </div>
        `;
    }).join('');
    return `<div class="read-chart">${bars}</div>`;
}

// 2026-09-22：漫画/小说库改为左右分栏后，统计图表改由 av-board 的 #avStatsSlot 调这个函数；
// 老的顶部横幅只在无分栏（移动端/兜底）时显示
async function loadReadingStatsInto(type, slot) {
    if (!slot) return;
    try {
        const res = await fetch(`/api/${type === 'comic' ? 'comic' : 'novel'}/stats/overview?days=7`);
        const data = await res.json();
        if (data.code !== 0 || !data.data) { slot.innerHTML = ''; return; }
        const stats = data.data;
        const totalSec = stats.totalSeconds || 0;
        const sessionCount = stats.sessionCount || 0;
        const daily = stats.daily || [];
        const maxSec = Math.max(1, ...daily.map(d => d.seconds || 0));
        slot.innerHTML = `
            <div class="avs-card">
                <div class="avs-head">📊 阅读统计 <span>近7天</span></div>
                <div class="avs-nums">
                    <div><b>${formatDurationHMS(totalSec)}</b><span>累计</span></div>
                    <div><b>${sessionCount}</b><span>次数</span></div>
                </div>
                <div class="avs-bars">
                    ${daily.map(d => {
                        const pct = Math.round((d.seconds || 0) / maxSec * 100);
                        return `<div class="avs-col" title="${d.date}：${Math.round((d.seconds || 0) / 60)} 分钟">
                            <i style="height:${Math.max(pct, d.seconds > 0 ? 8 : 2)}%"></i><em>${(d.date || '').slice(8)}</em>
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
    } catch (e) { slot.innerHTML = ''; }
}

async function loadReadingStatsBanner(type) {
    const banner = document.getElementById('readingStatsBanner');
    if (!banner) return;

    // 分栏布局在 → 统计进右上角槽位，顶部横幅不再显示
    const slot = document.getElementById('avStatsSlot');
    if (slot) {
        banner.style.display = 'none';
        loadReadingStatsInto(type, slot);
        return;
    }

    try {
        const res = await fetch(`/api/${type === 'comic' ? 'comic' : 'novel'}/stats/overview?days=7`);
        const data = await res.json();
        if (data.code !== 0 || !data.data) {
            banner.style.display = 'none';
            return;
        }
        const stats = data.data;
        const totalSec = stats.totalSeconds || 0;
        const sessionCount = stats.sessionCount || 0;
        const top = (stats.top || []).slice(0, 3);
        
        // 有数据才显示横幅，否则隐藏
        if (totalSec <= 0 && sessionCount <= 0 && top.length === 0) {
            banner.style.display = 'none';
            return;
        }
        
        banner.style.display = 'block';
        banner.innerHTML = `
            <div class="reading-stats-card">
                <div class="reading-stats-head">
                    <span class="reading-stats-title">📊 阅读时长统计</span>
                    <span class="reading-stats-sub">近7天</span>
                </div>
                <div class="reading-stats-main">
                    <div class="reading-stats-metrics">
                        <div class="reading-stat-item">
                            <div class="reading-stat-num">${formatDurationHMS(totalSec)}</div>
                            <div class="reading-stat-label">累计阅读</div>
                        </div>
                        <div class="reading-stat-item">
                            <div class="reading-stat-num">${sessionCount}</div>
                            <div class="reading-stat-label">阅读次数</div>
                        </div>
                        <div class="reading-stat-item">
                            <div class="reading-stat-num">${top.length > 0 ? formatDurationHMS(top[0].seconds) : '--'}</div>
                            <div class="reading-stat-label">最久单部</div>
                        </div>
                    </div>
                    <div class="reading-chart-wrap">
                        ${renderBarChart(stats.daily || [])}
                    </div>
                </div>
                ${top.length > 0 ? `
                <div class="reading-stats-top">
                    <span class="reading-stats-sub">🎯 阅读排行</span>
                    <div class="reading-top-list">
                        ${top.map((t, i) => `
                            <span class="reading-top-item" onclick="openReaderByType(${t.movieId}, '${type}')" title="${t.title}">
                                <b>${i + 1}</b> ${t.title} <em>${formatDurationHMS(t.seconds)}</em>
                            </span>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    } catch (e) {
        banner.style.display = 'none';
    }
}

// 从排行榜打开阅读器
function openReaderByType(movieId, type) {
    if (type === 'comic') openComicReader(movieId);
    else openNovelReader(movieId);
}

// 详情弹窗：加载单个作品的阅读时长
async function loadMovieReadTime(movieId, type) {
    try {
        const res = await fetch(`/api/${type === 'comic' ? 'comic' : 'novel'}/${movieId}/stats`);
        const data = await res.json();
        const el = document.getElementById('detailReadTime');
        if (!el) return;
        if (data.code === 0 && data.data) {
            const sec = data.data.totalSeconds || 0;
            const sessions = data.data.sessionCount || 0;
            el.textContent = sec > 0 ? `${formatDurationHMS(sec)}（${sessions}次）` : '暂无记录';
        } else {
            el.textContent = '暂无记录';
        }
    } catch (e) {
        const el = document.getElementById('detailReadTime');
        if (el) el.textContent = '暂无记录';
    }
}

// ========== 新作监视（全女优 + 漫画，近一月时间线） ==========
// 结构：顶部一排「有出新作的女优」名字（点一下检索她的近一月作品）
//       下面按日期倒序的时间线，展开所有女优近一月的新作
//       再下面是漫画新作（kmoe 同名检索到的新卷）
// 数据源：/api/new-release/timeline、/api/new-release/actresses

let nrState = {
    kind: 'all',            // all | jav | comic
    days: 30,
    groups: [],             // 时间线分组
    actressChips: [],       // 顶部女优名
    total: 0,
    selectedActress: null,  // 点了哪位女优（高亮用）
    loading: false,
    polling: null,
};

async function loadNewReleases() {
    updateToolbarTitle('🔔 新作监视');
    currentView = 'new-releases';

    const grid = document.getElementById('movieGrid');
    if (!grid) return;
    grid.style.display = 'block';
    renderNewReleaseSkeleton();

    await refreshNewReleases();

    // 若后台正在扫描，起轮询把新结果陆续刷出来
    startNewReleasePolling();
}

function renderNewReleaseSkeleton() {
    const grid = document.getElementById('movieGrid');
    if (!grid) return;
    grid.innerHTML = `
        <div class="nr-wrap">
            <div class="nr-skeleton-title"></div>
            <div class="nr-skeleton-chips">
                ${Array.from({ length: 10 }).map(() => '<span class="nr-skeleton-chip"></span>').join('')}
            </div>
            <div class="nr-skeleton-card"></div>
            <div class="nr-skeleton-card"></div>
        </div>
    `;
}

async function refreshNewReleases() {
    const grid = document.getElementById('movieGrid');
    if (!grid) return;
    nrState.loading = true;
    try {
        const [tlRes, acRes] = await Promise.all([
            fetch(`/api/new-release/timeline?kind=${encodeURIComponent(nrState.kind)}&days=${nrState.days}&limit=800`).then(r => r.json()),
            fetch(`/api/new-release/actresses?days=${nrState.days}`).then(r => r.json()),
        ]);

        if (tlRes.code !== 0) throw new Error(tlRes.msg || '时间线加载失败');

        nrState.groups = (tlRes.data && tlRes.data.groups) || [];
        nrState.total = (tlRes.data && tlRes.data.total) || 0;
        nrState.actressChips = (acRes.code === 0 && acRes.data) || [];

        renderNewReleasePage();
        // 侧边栏未读数
        refreshNewReleaseBadge();
    } catch (e) {
        console.error('加载新作失败:', e);
        grid.innerHTML = `
            <div class="nr-wrap">
                <div class="nr-empty">
                    <div class="nr-empty-icon">😵</div>
                    <div class="nr-empty-title">加载失败</div>
                    <div class="nr-empty-desc">${escapeHtml(e.message || '未知错误')}</div>
                    <button class="nr-btn" onclick="refreshNewReleases()">重试</button>
                </div>
            </div>`;
    } finally {
        nrState.loading = false;
    }
}

async function refreshNewReleaseBadge() {
    try {
        const res = await fetch('/api/notification/unread-count');
        const data = await res.json();
        const el = document.getElementById('countNewReleases');
        if (el && data.code === 0) el.textContent = data.data || 0;
    } catch (e) { /* 忽略 */ }
}

function renderNewReleasePage() {
    const grid = document.getElementById('movieGrid');
    if (!grid) return;

    const chipsHtml = renderActressChips();
    const tabsHtml = renderNrTabs();
    const bodyHtml = renderNrBody();

    grid.innerHTML = `
        <div class="nr-wrap">
            <div class="nr-head">
                <div class="nr-head-left">
                    <h2 class="nr-head-title">🔔 新作监视</h2>
                    <p class="nr-head-sub">全女优 · 近 ${nrState.days} 天 · 共 <b>${nrState.total}</b> 部</p>
                </div>
                <div class="nr-head-actions">
                    <button class="nr-btn" onclick="triggerNewReleaseCheck('all')" id="nrCheckAllBtn">🔄 立即检查</button>
                </div>
            </div>

            <div class="nr-chip-section">
                <div class="nr-chip-head">
                    <span class="nr-chip-title">👩 近一月有出新作的女优</span>
                    <span class="nr-chip-hint">点名字查她的近一月新作</span>
                    <button class="nr-mini-btn" onclick="clearNrActressFilter()" id="nrClearBtn" style="display:none">✕ 取消筛选</button>
                </div>
                <div class="nr-chips" id="nrChips">${chipsHtml}</div>
            </div>

            ${tabsHtml}
            ${bodyHtml}
        </div>
    `;

    // 已选女优时显示取消按钮
    const clearBtn = document.getElementById('nrClearBtn');
    if (clearBtn && nrState.selectedActress) clearBtn.style.display = '';
}

function renderActressChips() {
    const chips = nrState.actressChips || [];
    if (!chips.length) {
        return `<div class="nr-chips-empty">还没有数据 —— 点右上角「立即检查」开始扫描全库女优</div>`;
    }
    return chips.map(c => {
        const active = nrState.selectedActress && nrState.selectedActress.name === c.name;
        const initial = (c.name || '?').slice(0, 1);
        return `
            <button class="nr-chip ${active ? 'active' : ''}" onclick="filterByActressName('${escapeAttr(c.name)}', ${c.actressId || 'null'})" title="${escapeAttr(c.name)} · 近一月 ${c.count} 部">
                <span class="nr-chip-avatar">${escapeHtml(initial)}</span>
                <span class="nr-chip-name">${escapeHtml(c.name)}</span>
                <span class="nr-chip-count">${c.count}</span>
            </button>
        `;
    }).join('');
}

function renderNrTabs() {
    const t = (k, label) => `
        <button class="nr-tab ${nrState.kind === k ? 'active' : ''}" onclick="setNrKind('${k}')">${label}</button>
    `;
    return `
        <div class="nr-tabs">
            ${t('all', '全部')}
            ${t('jav', '🎬 女优新作')}
            ${t('comic', '📚 漫画新卷')}
            <div class="nr-tabs-spacer"></div>
            <button class="nr-tab ghost" onclick="triggerNewReleaseCheck('comic')" id="nrCheckComicBtn">🔄 检查漫画</button>
        </div>
    `;
}

function renderNrBody() {
    let groups = nrState.groups || [];

    // 按选中的女优过滤
    if (nrState.selectedActress) {
        const want = nrState.selectedActress.name;
        groups = groups
            .map(g => ({ ...g, items: g.items.filter(n => n.actress === want) }))
            .filter(g => g.items.length);
    }

    if (!groups.length) {
        const who = nrState.selectedActress ? `「${escapeHtml(nrState.selectedActress.name)}」` : '';
        return `
            <div class="nr-empty">
                <div class="nr-empty-icon">📭</div>
                <div class="nr-empty-title">${who ? who + ' 近一月没有新作' : '暂无新作'}</div>
                <div class="nr-empty-desc">点右上角「立即检查」扫描全库女优与漫画的最近更新</div>
                <div class="nr-empty-actions">
                    <button class="nr-btn" onclick="triggerNewReleaseCheck('all')">🔄 立即检查</button>
                    ${nrState.selectedActress ? `<button class="nr-btn ghost" onclick="clearNrActressFilter()">查看全部</button>` : ''}
                </div>
            </div>`;
    }

    return groups.map(g => `
        <section class="nr-day">
            <div class="nr-day-head">
                <span class="nr-day-label">${escapeHtml(g.label)}</span>
                <span class="nr-day-date">${escapeHtml(g.date)}</span>
                <span class="nr-day-line"></span>
                <span class="nr-day-count">${g.items.length}</span>
            </div>
            <div class="nr-day-items">
                ${g.items.map(renderNrCard).join('')}
            </div>
        </section>
    `).join('');
}

function renderNrCard(n) {
    const isComic = n.type === 'comic_new_release';
    const cover = n.cover || '';
    // 漫画卷没有发行日期，就不挂「日期未知」的牌子了（女优新作才需要这个兜底提示）
    const dateBadge = n.releaseDate
        ? `<span class="nr-card-date">${escapeHtml(n.releaseDate)}</span>`
        : (isComic
            ? ''
            : `<span class="nr-card-date unknown" title="来源未提供发行日期，按入库时间排列">日期未知</span>`);

    const who = isComic
        ? (n.comicTitle ? `<span class="nr-card-who">📚 ${escapeHtml(n.comicTitle)}</span>` : '')
        : (n.actress ? `<span class="nr-card-who">👩 ${escapeHtml(n.actress)}</span>` : '');

    // 标题与番号常常一模一样（javbus 列表页只有番号没有标题），
    // 完全重复就只留一个，避免「MIRD-754 新作 / MIRD-754」这种噪音。
    const rawTitle = String(n.title || '').trim();
    const numStr = String(n.avid || '').trim();
    const titleIsNum = rawTitle && numStr && rawTitle.toLowerCase() === numStr.toLowerCase();
    const titleIsPlaceholder = !rawTitle || /^新作(发布)?/.test(rawTitle) || /^.+ 新作$/.test(rawTitle);

    const numTag = (numStr && !titleIsNum)
        ? `<span class="nr-card-num">${escapeHtml(numStr)}</span>` : '';

    // 漫画卷号：volume 可能已经是「卷 14」这种自带前缀的写法，
    // 别再套一层「第 … 卷」，否则会出现「第 卷 14 卷」。
    const volStr = String(n.volume || '').trim();
    const volTag = volStr
        ? `<span class="nr-card-num">${escapeHtml(/^卷|^第|^Vol/i.test(volStr) ? volStr : `第 ${volStr} 卷`)}</span>`
        : '';

    // 标题行：
    //  - 漫画：文件名 `005：第5回-時間停止勇者.pdf` 又长又吵，
    //    而且系列名已经在 meta 行了，标题行直接用「系列名 新卷」最干净。
    //  - 女优：优先真标题；没有真标题就显示番号（仍占住标题位，不重复渲染）。
    let headline;
    if (isComic) {
        const seriesName = String(n.seriesName || '').replace(/\.(pdf|cbz|cbr|zip|rar|epub)$/i, '').trim();
        headline = seriesName ? `${escapeHtml(seriesName)} 新卷` : '漫画新卷';
    } else if (!titleIsNum && !titleIsPlaceholder) {
        headline = escapeHtml(rawTitle);
    } else if (numStr) {
        headline = `<span class="nr-card-num-inline">${escapeHtml(numStr)}</span>`;
    } else {
        headline = '新作';
    }

    const click = n.url
        ? `onclick="window.open('${escapeAttr(n.url)}', '_blank')"`
        : (n.movieId ? `onclick="showMovieDetail(${n.movieId})"` : '');

    // 描述行：把「番号：xxx」「发行日期：xxx」这类已经在 meta 行/标题位展示过的内容剔掉，
    // 剩下的才有必要显示（画面上就不会出现 MIRD-754 · 番号: MIRD-754 这种重复）。
    let descText = String(n.content || '').replace(/\n/g, ' · ').trim();
    descText = descText
        .replace(/番号[:：]\s*\S+/g, '')
        .replace(/发行日期[:：]\s*\S+/g, '')
        .replace(/(?:^|\s·\s)·+/g, ' · ')
        .replace(/^\s*·\s*|\s*·\s*$/g, '')
        .trim();

    // 番号压在海报左下角（比塞进文字行显眼得多），meta 行就不再重复它了
    const coverNum = (numStr && !titleIsNum) ? numStr : (volStr || '');

    return `
        <article class="nr-card ${isComic ? 'is-comic' : ''} ${n.read === 0 ? 'unread' : ''}" data-id="${n.id}">
            <div class="nr-card-cover" ${click}>
                ${cover
                    ? `<img src="${escapeAttr(cover)}" alt="" loading="lazy" data-nr-cover="${escapeAttr(n.id)}" onerror="nrCoverFallback(this)">
                       <span class="nr-card-cover-fallback" hidden>${isComic ? '📚' : '🎬'}</span>`
                    : `<div class="nr-card-cover-fallback">${isComic ? '📚' : '🎬'}</div>`}
                ${coverNum ? `<span class="nr-card-cover-num">${escapeHtml(coverNum)}</span>` : ''}
                ${n.read === 0 ? '<span class="nr-card-dot"></span>' : ''}
            </div>
            <div class="nr-card-main">
                <div class="nr-card-meta">
                    ${who}
                    ${volTag}
                    ${dateBadge}
                </div>
                <h3 class="nr-card-title" ${click} style="${n.url || n.movieId ? 'cursor:pointer' : ''}">${headline}</h3>
                ${descText ? `<p class="nr-card-desc">${escapeHtml(descText)}</p>` : ''}
                <div class="nr-card-actions">
                    ${n.url ? `<button class="nr-act" onclick="event.stopPropagation();window.open('${escapeAttr(n.url)}', '_blank')">查看详情 ↗</button>` : ''}
                    ${!isComic && n.actress ? `<button class="nr-act" onclick="event.stopPropagation();filterByActressName('${escapeAttr(n.actress)}', ${n.actressId || 'null'})">只看她</button>` : ''}
                    <button class="nr-act ghost" onclick="event.stopPropagation();markNotificationRead(${n.id})">${n.read === 0 ? '标为已读' : '已读'}</button>
                    <button class="nr-act ghost danger" onclick="event.stopPropagation();deleteNewReleaseNotification(${n.id})">删除</button>
                </div>
            </div>
        </article>
    `;
}

/**
 * 海报加载失败时的兜底。
 * 老通知里可能残留 javbus 外链封面（浏览器直连 403），
 * 这里改用服务端补抓接口，抓到就换图，抓不到再退回 emoji 占位。
 */
const nrCoverRetry = new Set();
function nrCoverFallback(img) {
    const id = img.getAttribute('data-nr-cover');
    const holder = img.parentElement;
    const fb = holder ? holder.querySelector('.nr-card-cover-fallback') : null;
    const showFallback = () => {
        if (fb) { fb.hidden = false; }
        img.remove();
    };

    if (!id || nrCoverRetry.has(id)) { showFallback(); return; }
    nrCoverRetry.add(id);

    img.src = `/api/new-release/cover/${id}`;
    img.onerror = () => showFallback();
    img.onload = () => { if (fb) fb.hidden = true; };
}

// ---------- 交互 ----------
function setNrKind(kind) {
    nrState.kind = kind;
    renderNewReleasePage();
    refreshNewReleases();
}

function filterByActressName(name, actressId) {
    if (nrState.selectedActress && nrState.selectedActress.name === name) {
        clearNrActressFilter();
        return;
    }
    nrState.selectedActress = { name, actressId: actressId || null };
    if (nrState.kind === 'comic') nrState.kind = 'all';
    renderNewReleasePage();
    // 滚到时间线
    const el = document.querySelector('.nr-tabs');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearNrActressFilter() {
    nrState.selectedActress = null;
    renderNewReleasePage();
}

async function triggerNewReleaseCheck(scope) {
    const scopeLabel = scope === 'comic' ? '漫画新卷' : '全库女优';
    showNotification('正在检查', `正在扫描${scopeLabel}的近一月新作，需要一点时间…`);
    try {
        const res = await fetch('/api/new-release/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: scope || 'all' }),
        });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('已开始', data.msg || '检查已在后台运行');
            startNewReleasePolling();
        } else {
            showNotification('检查失败', data.msg || '未知错误');
        }
    } catch (e) {
        showNotification('检查失败', e.message);
    }
}

/** 后台扫描期间轮询刷新，让新结果陆续出现 */
function startNewReleasePolling() {
    stopNewReleasePolling();
    let ticks = 0;
    nrState.polling = setInterval(async () => {
        ticks++;
        if (currentView !== 'new-releases' || ticks > 60) {
            stopNewReleasePolling();
            return;
        }
        try {
            const st = await fetch('/api/new-release/status').then(r => r.json());
            const running = st.code === 0 && (st.data.movie?.checking || st.data.comic?.checking);
            await refreshNewReleases();
            if (!running) stopNewReleasePolling();
        } catch (e) { /* 忽略 */ }
    }, 8000);
}

function stopNewReleasePolling() {
    if (nrState.polling) {
        clearInterval(nrState.polling);
        nrState.polling = null;
    }
}

async function markNotificationRead(id) {
    try {
        await fetch(`/api/notification/read/${id}`, { method: 'POST' });
        await refreshNewReleases();
    } catch (e) {
        console.error('标记已读失败:', e);
    }
}

async function markAllNotificationsRead() {
    try {
        await fetch('/api/notification/read-all', { method: 'POST' });
        showNotification('已全部标记为已读');
        await refreshNewReleases();
    } catch (e) {
        console.error('全部已读失败:', e);
    }
}

async function deleteNewReleaseNotification(id) {
    if (!confirm('确定要删除这条通知吗？')) return;
    try {
        await fetch(`/api/notification/${id}`, { method: 'DELETE' });
        await refreshNewReleases();
    } catch (e) {
        console.error('删除通知失败:', e);
    }
}

function formatNotificationTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    return date.toLocaleDateString('zh-CN');
}

// HTML 属性里嵌字符串：转义引号，避免女优名里的 ' 把属性截断
function escapeAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 加载设置页面
async function loadSettings() {
    updateToolbarTitle('⚙️ 设置');
    currentView = 'settings';
    const view = document.getElementById('settingsView');

    try {
        const res = await fetch('/api/config');
        const data = await res.json();

        if (data.code === 0) {
            renderSettings(data.data);
            refreshAuthTip();
            // 加载AI配置
            setTimeout(() => loadAIConfig(), 100);
        } else {
            /* ★ 不再静默失败。
             * 之前这里只 console.error，如果接口 401（未登录 / 会话过期），
             * settingsView 会一直停在 display:none，用户看到的就是
             * 「点设置 → 右侧一片空白」，完全不知道发生了什么。
             * 现在明确告诉用户原因，并给一个重新登录的出口。 */
            view.textContent = '';
            const box = document.createElement('div');
            box.style.cssText = 'padding:48px 8px;color:var(--text-muted);font-size:14px;line-height:2;';
            box.innerHTML = '设置加载失败：' + (data.msg || ('接口返回 code=' + data.code)) +
                '<br><button class="btn btn-sm" style="margin-top:12px;" onclick="location.href=\'/login.html?type=jav\'">重新登录</button>';
            view.style.display = 'block';
            view.appendChild(box);
        }
    } catch (e) {
        console.error('加载配置失败:', e);
        view.textContent = '';
        const box = document.createElement('div');
        box.style.cssText = 'padding:48px 8px;color:var(--text-muted);font-size:14px;line-height:2;';
        box.textContent = '设置加载失败：' + e.message + '（后端可能没在运行）';
        view.style.display = 'block';
        view.appendChild(box);
    }
}

// 设置页分组导航切换
function switchSettingsGroup(name) {
    document.querySelectorAll('#settingsView .settings-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.group === name);
    });
    document.querySelectorAll('#settingsView .settings-section').forEach(sec => {
        sec.style.display = sec.dataset.group === name ? 'block' : 'none';
    });
    // 进入「外观」时同步一次女优头像覆盖率（该分组里有头像刮削入口）
    if (name === 'appearance') refreshAvatarStats();
}

/* ==========================================================================
   高度自定义（设置 → 个性化）
   全部状态存 localStorage('uiCustom')，通过 html 的 CSS 变量 / data 属性生效，
   round14.css 消费这些变量。背景图文件存服务端 data/custom/，走 /custom 静态服务。
   ========================================================================== */
const UI_CUSTOM_KEY = 'uiCustom';

function getUiCustom() {
    try {
        return Object.assign(
            { posterScale: 1, posterRatio: 'wide', playerSize: 'md', playerPos: 'center', pageBgVeil: 72 },
            JSON.parse(localStorage.getItem(UI_CUSTOM_KEY) || '{}')
        );
    } catch (e) {
        return { posterScale: 1, posterRatio: 'wide', playerSize: 'md', playerPos: 'center', pageBgVeil: 72 };
    }
}

function setUiCustom(patch) {
    const c = getUiCustom();
    Object.assign(c, patch);
    localStorage.setItem(UI_CUSTOM_KEY, JSON.stringify(c));
    applyUiCustom();
}

function toggleUiFlag(btn, key) {
    const c = getUiCustom();
    const next = !c[key];
    setUiCustom({ [key]: next });
    // 更新按钮文案
    btn.classList.toggle('btn-secondary', key === 'hideCharts' ? next : !next);
    if (key === 'sidebarCollapse') btn.textContent = next ? '✓ 已开启' : '已关闭';
    if (key === 'hideCharts') btn.textContent = next ? '已隐藏' : '✓ 显示中';
}

function applyUiCustom() {
    const c = getUiCustom();
    const h = document.documentElement;

    // 背景图
    if (c.pageBg) { h.style.setProperty('--page-bg-image', `url("${c.pageBg}")`); h.setAttribute('data-page-bg', ''); }
    else { h.style.removeProperty('--page-bg-image'); h.removeAttribute('data-page-bg'); }
    h.style.setProperty('--page-bg-veil', c.pageBgVeil ?? 72);
    if (c.bannerBg) { h.style.setProperty('--banner-bg-image', `url("${c.bannerBg}")`); h.setAttribute('data-banner-bg', ''); }
    else { h.style.removeProperty('--banner-bg-image'); h.removeAttribute('data-banner-bg'); }

    // 布局开关
    if (c.sidebarCollapse) h.setAttribute('data-sidebar-collapse', ''); else h.removeAttribute('data-sidebar-collapse');
    if (c.hideCharts) h.setAttribute('data-hide-charts', ''); else h.removeAttribute('data-hide-charts');

    // 海报
    h.style.setProperty('--card-w-scale', c.posterScale || 1);
    if (c.posterRatio === 'portrait') h.setAttribute('data-poster-ratio', 'portrait');
    else h.removeAttribute('data-poster-ratio');

    // 播放器
    const sizes = { sm: '720px', md: '980px', lg: '1280px', xl: '94vw' };
    h.style.setProperty('--player-w', sizes[c.playerSize] || '980px');
    if (c.playerPos === 'high') h.setAttribute('data-player-pos', 'high');
    else h.removeAttribute('data-player-pos');
}

async function uploadWallpaper(type, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
        showNotification('图片太大', '背景图不能超过 12MB');
        input.value = '';
        return;
    }
    const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
    try {
        const res = await fetch('/api/customization/wallpaper', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, imageData: b64 })
        });
        const data = await res.json();
        if (data.code !== 0) { showNotification('上传失败', data.msg); return; }
        if (type === 'page') setUiCustom({ pageBg: data.url });
        else setUiCustom({ bannerBg: data.url });
        // 更新缩略图
        const thumb = document.getElementById(type === 'page' ? 'pageBgThumb' : 'bannerBgThumb');
        if (thumb) { thumb.style.backgroundImage = `url('${data.url}')`; thumb.classList.remove('empty'); thumb.textContent = ''; }
        showNotification('背景已更换', '刷新页面也能保持');
    } catch (e) {
        showNotification('上传失败', e.message);
    }
    input.value = '';
}

async function clearWallpaper(type) {
    try { await fetch(`/api/customization/wallpaper/${type}`, { method: 'DELETE' }); } catch (e) { /* 忽略 */ }
    if (type === 'page') setUiCustom({ pageBg: '' });
    else setUiCustom({ bannerBg: '' });
    const thumb = document.getElementById(type === 'page' ? 'pageBgThumb' : 'bannerBgThumb');
    if (thumb) { thumb.style.backgroundImage = ''; thumb.classList.add('empty'); thumb.textContent = '未设置'; }
    showNotification('已清除背景图');
}

// 渲染设置页面（独立全宽页面 + 侧边分组导航）
function renderSettings(config) {
    const view = document.getElementById('settingsView');
    view.style.display = 'block';

    // 数据源「可填写凭证」的显示名与占位提示
    // （哪些字段要显示由 config 里该源的 configFields 数组声明，前端不写死源名）
    const SOURCE_FIELD_LABELS = {
        apiId: 'API ID',
        affiliateId: 'Affiliate ID',
        username: '用户名',
        password: '密码',
        cookie: 'Cookie',
        baseUrl: '接口地址',
        token: '令牌',
    };
    const SOURCE_FIELD_PLACEHOLDER = {
        apiId: '在 affiliate.dmm.com 申请',
        affiliateId: '在 affiliate.dmm.com 申请',
    };

    // 访问密码当前状态（后端只回传开关，不回传明文）
    const authOn = !!(config.auth && config.auth.enabled);
    const authHasPwd = !!(config.auth && config.auth.hasPassword);

    const groups = [
        { id: 'appearance', icon: '🎨', name: '外观' },
        { id: 'customize', icon: '🎛️', name: '个性化' },
        { id: 'paths', icon: '📂', name: '扫描路径' },
        { id: 'sources', icon: '🌐', name: '数据源' },
        { id: 'player', icon: '🎬', name: '播放' },
        { id: 'ai', icon: '🤖', name: 'AI 设置' },
        { id: 'notify', icon: '🔒', name: '安全与通知' },
        { id: 'tools', icon: '🔧', name: '工具维护' },
        { id: 'cookies', icon: '🍪', name: 'Cookie' },
        { id: 'about', icon: 'ℹ️', name: '关于' }
    ];

    view.innerHTML = `
        <div class="settings-shell">
            <aside class="settings-nav">
                ${groups.map((g, i) => `
                    <div class="settings-nav-item ${i === 0 ? 'active' : ''}" data-group="${g.id}" onclick="switchSettingsGroup('${g.id}')">
                        <span class="settings-nav-icon">${g.icon}</span>
                        <span>${g.name}</span>
                    </div>
                `).join('')}
            </aside>

            <main class="settings-main">

                <!-- 🎨 外观 -->
                <section class="settings-section" data-group="appearance">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🎨 外观</h3>
                        <p class="settings-section-desc">选择界面主题风格与明暗模式</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">主题风格</div>
                        <div class="theme-selector">
                            <div class="theme-card ${getCurrentTheme() === 'ios' ? 'active' : ''}" onclick="switchThemeStyle('ios')">
                                <div class="theme-swatch" style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);"></div>
                                <div class="theme-card-info">
                                    <div style="font-weight: 600; font-size: 14px;">iOS 风格</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">毛玻璃 · 弹簧动效</div>
                                </div>
                            </div>
                            <div class="theme-card ${getCurrentTheme() === 'stylekit' ? 'active' : ''}" onclick="switchThemeStyle('stylekit')">
                                <div class="theme-swatch" style="background: linear-gradient(135deg, #0ea5e9 0%, #8b5cf6 100%);"></div>
                                <div class="theme-card-info">
                                    <div style="font-weight: 600; font-size: 14px;">StyleKit</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">设计系统 · AI友好</div>
                                </div>
                            </div>
                            <div class="theme-card ${getCurrentTheme() === 'shader' ? 'active' : ''}" onclick="switchThemeStyle('shader')">
                                <div class="theme-swatch" style="background: linear-gradient(135deg, #8b5cf6 0%, #ec4899 50%, #f59e0b 100%);"></div>
                                <div class="theme-card-info">
                                    <div style="font-weight: 600; font-size: 14px;">Shader 渐变</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">发光效果 · 炫彩渐变</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-item settings-item-row">
                            <div>
                                <div style="font-size: 14px; font-weight: 600;">深色模式</div>
                                <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">影院风暗色视觉</div>
                            </div>
                            <button id="darkModeToggle" class="btn btn-sm" onclick="toggleDarkMode()">
                                ${isDarkMode() ? '☀️ 浅色' : '🌙 深色'}
                            </button>
                        </div>
                    </div>

                    <!-- 点击海报后的详情呈现方式 -->
                    <div class="settings-group">
                        <div class="settings-group-title">点击海报后打开</div>
                        <div class="detail-mode-selector">
                            <div class="detail-mode-card ${getDetailMode() === 'drawer' ? 'active' : ''}" data-detail-mode="drawer" onclick="setDetailMode('drawer')">
                                <div class="detail-mode-thumb">
                                    <span class="dmt-panel dmt-panel-right"></span>
                                </div>
                                <div class="detail-mode-info">
                                    <div style="font-weight: 600; font-size: 14px;">右侧抽屉</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">从右侧滑出 · 不遮挡列表</div>
                                </div>
                                <span class="detail-mode-check">✓</span>
                            </div>
                            <div class="detail-mode-card ${getDetailMode() === 'modal' ? 'active' : ''}" data-detail-mode="modal" onclick="setDetailMode('modal')">
                                <div class="detail-mode-thumb">
                                    <span class="dmt-panel dmt-panel-center"></span>
                                </div>
                                <div class="detail-mode-info">
                                    <div style="font-weight: 600; font-size: 14px;">居中弹窗</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">经典大弹窗 · 海报居中</div>
                                </div>
                                <span class="detail-mode-check">✓</span>
                            </div>
                        </div>
                    </div>

                    <!-- 女优头像刮削 -->
                    <div class="settings-group">
                        <div class="settings-group-title">女优头像与档案</div>
                        <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px;line-height:1.6;">
                            从 javbus 刮削女优头像、生日、身高、三围等档案信息。<br>
                            逐个请求 + 限速，400 多位大约需要 5-8 分钟，可随时关闭页面，任务在后台继续。
                        </p>
                        <div id="avatarScrapeBox" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                            <button class="btn btn-sm" id="avatarScrapeBtn" onclick="startAvatarScrape()">✨ 开始刮削女优头像</button>
                            <button class="btn btn-sm btn-secondary" onclick="startAvatarScrape(true)">刮削全部（含无作品）</button>
                            <span id="avatarScrapeStat" style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);"></span>
                        </div>
                        <div id="avatarScrapeBarWrap" style="display:none;margin-top:10px;height:6px;border-radius:6px;background:var(--bg);overflow:hidden;">
                            <div id="avatarScrapeBar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--pl-amber),var(--pl-pink));transition:width .4s ease;"></div>
                        </div>
                    </div>
                </section>

                <!-- 🎛️ 个性化（高度自定义：背景图 / 布局 / 海报 / 播放器） -->
                <section class="settings-section" data-group="customize" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🎛️ 个性化</h3>
                        <p class="settings-section-desc">背景图、布局、海报、播放器随心调 —— 修改即时生效，保存在本机浏览器</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🖼️ 背景图</div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>主页背景图</b>
                                <span>整站页面背景，建议 1920×1080 以上</span>
                            </div>
                            <div class="cr-ctrl">
                                <div id="pageBgThumb" class="customize-thumb ${getUiCustom().pageBg ? '' : 'empty'}" style="${getUiCustom().pageBg ? `background-image:url('${getUiCustom().pageBg}')` : ''}">${getUiCustom().pageBg ? '' : '未设置'}</div>
                                <input type="file" id="pageBgInput" accept="image/*" style="display:none;" onchange="uploadWallpaper('page', this)">
                                <button class="btn btn-sm" onclick="document.getElementById('pageBgInput').click()">上传</button>
                                <button class="btn btn-sm btn-secondary" onclick="clearWallpaper('page')">清除</button>
                            </div>
                        </div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>Banner 背景图</b>
                                <span>各功能页顶部水波纹横幅的底图，水纹会叠在图上</span>
                            </div>
                            <div class="cr-ctrl">
                                <div id="bannerBgThumb" class="customize-thumb ${getUiCustom().bannerBg ? '' : 'empty'}" style="${getUiCustom().bannerBg ? `background-image:url('${getUiCustom().bannerBg}')` : ''}">${getUiCustom().bannerBg ? '' : '未设置'}</div>
                                <input type="file" id="bannerBgInput" accept="image/*" style="display:none;" onchange="uploadWallpaper('banner', this)">
                                <button class="btn btn-sm" onclick="document.getElementById('bannerBgInput').click()">上传</button>
                                <button class="btn btn-sm btn-secondary" onclick="clearWallpaper('banner')">清除</button>
                            </div>
                        </div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>背景纱遮罩强度</b>
                                <span>设了主页背景图后，给内容区垫一层底色保证文字可读（%）</span>
                            </div>
                            <div class="cr-ctrl">
                                <input type="range" min="0" max="100" step="5" value="${getUiCustom().pageBgVeil ?? 72}" style="width:150px;" oninput="setUiCustom({ pageBgVeil: +this.value })">
                                <span style="font-family:var(--font-mono);font-size:12px;" id="pageBgVeilVal">${getUiCustom().pageBgVeil ?? 72}%</span>
                            </div>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">📐 布局</div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>左侧导航收缩模式</b>
                                <span>桌面端侧栏收成图标窄条，悬停浮出展开</span>
                            </div>
                            <div class="cr-ctrl">
                                <button class="btn btn-sm ${getUiCustom().sidebarCollapse ? '' : 'btn-secondary'}" onclick="toggleUiFlag(this, 'sidebarCollapse')">${getUiCustom().sidebarCollapse ? '✓ 已开启' : '已关闭'}</button>
                            </div>
                        </div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>统计图表显示</b>
                                <span>关闭后隐藏首页统计、阅读统计等图表区块</span>
                            </div>
                            <div class="cr-ctrl">
                                <button class="btn btn-sm ${getUiCustom().hideCharts ? 'btn-secondary' : ''}" onclick="toggleUiFlag(this, 'hideCharts')">${getUiCustom().hideCharts ? '已隐藏' : '✓ 显示中'}</button>
                            </div>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🎞️ 海报展示</div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>海报大小</b>
                                <span>影片网格卡片尺寸（放大后每行张数变少）</span>
                            </div>
                            <div class="cr-ctrl">
                                <input type="range" min="0.7" max="1.6" step="0.05" value="${getUiCustom().posterScale || 1}" style="width:150px;" oninput="setUiCustom({ posterScale: +this.value }); this.nextElementSibling.textContent = Math.round(this.value * 100) + '%'">
                                <span style="font-family:var(--font-mono);font-size:12px;">${Math.round((getUiCustom().posterScale || 1) * 100)}%</span>
                            </div>
                        </div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>海报比例</b>
                                <span>宽幅 16:9（影片封面原生） / 竖版 3:4（海报馆模式）</span>
                            </div>
                            <div class="cr-ctrl">
                                <select class="settings-input" style="width:auto;padding:6px 10px;" onchange="setUiCustom({ posterRatio: this.value })">
                                    <option value="wide" ${getUiCustom().posterRatio !== 'portrait' ? 'selected' : ''}>宽幅 16:9</option>
                                    <option value="portrait" ${getUiCustom().posterRatio === 'portrait' ? 'selected' : ''}>竖版 3:4</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🎬 播放器</div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>播放器大小</b>
                                <span>弹窗播放器的窗口宽度</span>
                            </div>
                            <div class="cr-ctrl">
                                <select class="settings-input" style="width:auto;padding:6px 10px;" onchange="setUiCustom({ playerSize: this.value })">
                                    <option value="sm" ${getUiCustom().playerSize === 'sm' ? 'selected' : ''}>小 720px</option>
                                    <option value="md" ${!getUiCustom().playerSize || getUiCustom().playerSize === 'md' ? 'selected' : ''}>中 980px</option>
                                    <option value="lg" ${getUiCustom().playerSize === 'lg' ? 'selected' : ''}>大 1280px</option>
                                    <option value="xl" ${getUiCustom().playerSize === 'xl' ? 'selected' : ''}>特大 94% 视窗</option>
                                </select>
                            </div>
                        </div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>播放器位置</b>
                                <span>垂直居中 / 偏上（边看边滚列表更舒服）</span>
                            </div>
                            <div class="cr-ctrl">
                                <select class="settings-input" style="width:auto;padding:6px 10px;" onchange="setUiCustom({ playerPos: this.value })">
                                    <option value="center" ${getUiCustom().playerPos !== 'high' ? 'selected' : ''}>居中</option>
                                    <option value="high" ${getUiCustom().playerPos === 'high' ? 'selected' : ''}>偏上</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- 📂 扫描路径 -->
                <section class="settings-section" data-group="paths" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">📂 扫描路径</h3>
                        <p class="settings-section-desc">配置四个模块的资源扫描文件夹，修改后需重启服务生效</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🎬 影片扫描路径</div>
                        <div class="folder-list" id="movieFolders">
                            ${(config.scanFolders || []).map(f => `
                                <div class="folder-item">
                                    <span class="folder-path">${f}</span>
                                    <button class="btn btn-sm btn-danger" onclick="removeFolder('movie', '${f}')">删除</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="folder-add">
                            <input type="text" class="folder-input" id="movieFolderInput" placeholder="输入文件夹路径，如 D:\\Movies">
                            <button class="btn btn-sm" onclick="addFolder('movie')">添加</button>
                        </div>
                        <button class="btn btn-sm scan-module-btn" onclick="startModuleScan('movie')">▶️ 扫描影片</button>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🎌 动漫扫描路径</div>
                        <div class="folder-list" id="animeFolders">
                            ${(config.animeFolders || []).map(f => `
                                <div class="folder-item">
                                    <span class="folder-path">${f}</span>
                                    <button class="btn btn-sm btn-danger" onclick="removeFolder('anime', '${f}')">删除</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="folder-add">
                            <input type="text" class="folder-input" id="animeFolderInput" placeholder="输入文件夹路径">
                            <button class="btn btn-sm" onclick="addFolder('anime')">添加</button>
                        </div>
                        <button class="btn btn-sm scan-module-btn" onclick="startModuleScan('anime')">▶️ 扫描动漫</button>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">📚 漫画扫描路径</div>
                        <div class="folder-list" id="comicFolders">
                            ${(config.comicFolders || []).map(f => `
                                <div class="folder-item">
                                    <span class="folder-path">${f}</span>
                                    <button class="btn btn-sm btn-danger" onclick="removeFolder('comic', '${f}')">删除</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="folder-add">
                            <input type="text" class="folder-input" id="comicFolderInput" placeholder="输入文件夹路径">
                            <button class="btn btn-sm" onclick="addFolder('comic')">添加</button>
                        </div>
                        <button class="btn btn-sm scan-module-btn" onclick="startModuleScan('comic')">▶️ 扫描漫画</button>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">📖 小说扫描路径</div>
                        <div class="folder-list" id="novelFolders">
                            ${(config.novelFolders || []).map(f => `
                                <div class="folder-item">
                                    <span class="folder-path">${f}</span>
                                    <button class="btn btn-sm btn-danger" onclick="removeFolder('novel', '${f}')">删除</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="folder-add">
                            <input type="text" class="folder-input" id="novelFolderInput" placeholder="输入文件夹路径">
                            <button class="btn btn-sm" onclick="addFolder('novel')">添加</button>
                        </div>
                        <button class="btn btn-sm scan-module-btn" onclick="startModuleScan('novel')">▶️ 扫描小说</button>
                    </div>
                </section>

                <!-- 🌐 数据源 -->
                <section class="settings-section" data-group="sources" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🌐 数据源</h3>
                        <p class="settings-section-desc">配置代理、刮削数据源与浏览器验证</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">代理设置</div>
                        <div class="settings-item">
                            <label>代理服务器地址</label>
                            <input type="text" class="settings-input" id="proxyServer" value="${config.network?.proxyServer || ''}" placeholder="http://127.0.0.1:7890">
                        </div>
                        <div class="settings-item">
                            <label>请求超时（毫秒）</label>
                            <input type="number" class="settings-input" id="requestTimeout" value="${config.network?.timeout || 10000}">
                        </div>
                        <div class="settings-item">
                            <label>请求间隔（毫秒）</label>
                            <input type="number" class="settings-input" id="requestInterval" value="${config.network?.requestInterval || 800}">
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">刮削数据源</div>
                        <div class="source-list">
                            ${Object.entries(config.sources || {}).map(([key, src]) => `
                                <div class="source-item${src.unavailable ? ' is-unavailable' : ''}">
                                    <label class="source-label">
                                        <input type="checkbox" class="source-checkbox" data-source="${key}" ${src.enabled ? 'checked' : ''}>
                                        <span class="source-name">${key.toUpperCase()}</span>
                                    </label>
                                    <span class="source-url">${src.baseUrl || ''}</span>
                                    ${Array.isArray(src.configFields) && src.configFields.length ? `
                                    <div class="source-fields">
                                        ${src.configFields.map(f => `
                                            <label class="source-field">
                                                <span>${SOURCE_FIELD_LABELS[f] || f}</span>
                                                <input type="text" class="settings-input source-field-input"
                                                       data-source="${key}" data-field="${f}"
                                                       value="${String(src[f] == null ? '' : src[f]).replace(/"/g, '&quot;')}"
                                                       placeholder="${SOURCE_FIELD_PLACEHOLDER[f] || ''}">
                                            </label>
                                        `).join('')}
                                    </div>` : ''}
                                    ${src.note ? `<span class="source-note">${src.note}</span>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🌐 浏览器验证（Cloudflare绕过）</div>
                        <p class="settings-tip" style="margin-top:0;">动漫等站点有Cloudflare防护，首次使用需在浏览器中手动通过一次验证，之后cookie会自动保存，后台刮削无需再操作。</p>
                        <div id="browserVerifyStatus" class="browser-verify-status">状态：未检查</div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" style="background: var(--primary); color: white;" onclick="initBrowserVerification()">🔐 初始化验证</button>
                            <button class="btn btn-sm" onclick="checkBrowserCookie()">🔍 检查状态</button>
                            <button class="btn btn-sm btn-danger" onclick="closeBrowser()">❌ 关闭浏览器</button>
                        </div>
                    </div>

                    <div class="settings-save-bar">
                        <button class="btn btn-primary" onclick="saveSettings()">💾 保存设置</button>
                    </div>
                </section>

                <!-- 🎬 播放 -->
                <section class="settings-section" data-group="player" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🎬 播放</h3>
                        <p class="settings-section-desc">配置播放器与视频截图相关选项</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-item">
                            <label>FFmpeg 路径</label>
                            <input type="text" class="settings-input" id="ffmpegPath" value="${config.ffmpeg?.binPath || ''}" placeholder="D:\\tools\\ffmpeg\\bin">
                        </div>
                        <div class="settings-item">
                            <label>截图时间（秒）</label>
                            <input type="number" class="settings-input" id="screenshotTime" value="${config.ffmpeg?.screenshotTime || 15}">
                        </div>
                        <div class="settings-item">
                            <label>PotPlayer 路径</label>
                            <input type="text" class="settings-input" id="potPlayerPath" value="${config.player?.potPlayerPath || ''}" placeholder="D:\PotPlayer\PotPlayerMini64.exe">
                            <p class="settings-tip" style="margin-top:4px;">用于「用 PotPlayer 打开」按钮。应用在 Docker 中运行时，通过本机 potplayer:// 协议唤起播放器。</p>
                        </div>
                    </div>

                    <div class="settings-save-bar">
                        <button class="btn btn-primary" onclick="saveSettings()">💾 保存设置</button>
                    </div>
                </section>

                <!-- 🤖 AI 设置 -->
                <section class="settings-section" data-group="ai" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🤖 AI 设置</h3>
                        <p class="settings-section-desc">配置AI模型，支持本地Ollama和云端API（DeepSeek、OpenAI等）</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-item">
                            <label>AI 提供商</label>
                            <select class="settings-input" id="aiProvider" onchange="switchAIProvider(this.value)">
                                <option value="ollama">Ollama（本地模型）</option>
                                <option value="deepseek">DeepSeek</option>
                                <option value="openai">OpenAI</option>
                                <option value="custom">自定义（OpenAI兼容）</option>
                            </select>
                        </div>

                        <div id="aiConfigOllama" class="ai-provider-config" style="display:none; margin-top:12px;">
                            <div class="settings-item">
                                <label>Ollama 地址</label>
                                <input type="text" class="settings-input" id="ollamaBaseUrl" placeholder="http://127.0.0.1:11434">
                            </div>
                            <div class="settings-item">
                                <label>模型</label>
                                <div class="settings-inline-row">
                                    <select class="settings-input" id="ollamaModel" style="flex:1;">
                                        <option value="">正在读取本地 Ollama 模型…</option>
                                    </select>
                                    <button class="btn btn-sm" onclick="loadAIModels('ollama')">🔄 刷新</button>
                                </div>
                            </div>
                        </div>

                        <div id="aiConfigDeepseek" class="ai-provider-config" style="display:none; margin-top:12px;">
                            <div class="settings-item">
                                <label>API Key</label>
                                <input type="password" class="settings-input" id="deepseekApiKey" placeholder="sk-...">
                            </div>
                            <div class="settings-item">
                                <label>API 地址</label>
                                <input type="text" class="settings-input" id="deepseekBaseUrl" value="https://api.deepseek.com" placeholder="https://api.deepseek.com">
                            </div>
                            <div class="settings-item">
                                <label>模型</label>
                                <div class="settings-inline-row">
                                    <select class="settings-input" id="deepseekModel" style="flex:1;">
                                        <option value="deepseek-chat">deepseek-chat</option>
                                        <option value="deepseek-reasoner">deepseek-reasoner</option>
                                    </select>
                                    <button class="btn btn-sm" onclick="loadAIModels('deepseek')">🔄 刷新</button>
                                </div>
                            </div>
                            <div class="settings-btn-row">
                                <button class="btn btn-sm" onclick="testAIKey('deepseek')">🔍 测试连接</button>
                                <span id="deepseekTestStatus" style="font-size:12px;margin-left:8px;"></span>
                            </div>
                        </div>

                        <div id="aiConfigOpenai" class="ai-provider-config" style="display:none; margin-top:12px;">
                            <div class="settings-item">
                                <label>API Key</label>
                                <input type="password" class="settings-input" id="openaiApiKey" placeholder="sk-...">
                            </div>
                            <div class="settings-item">
                                <label>API 地址</label>
                                <input type="text" class="settings-input" id="openaiBaseUrl" value="https://api.openai.com/v1" placeholder="https://api.openai.com/v1">
                            </div>
                            <div class="settings-item">
                                <label>opencode 会话 ID（可选）</label>
                                <input type="text" class="settings-input" id="openaiSession" placeholder="仅 opencode.ai 网关需要，可留空">
                                <p class="settings-tip">使用 https://opencode.ai/zen 网关时需填 <code>x-opencode-session</code>，从 opencode.ai 获取；本地/官方等无需。</p>
                            </div>
                            <div class="settings-item">
                                <label>模型</label>
                                <div class="settings-inline-row">
                                    <select class="settings-input" id="openaiModel" style="flex:1;">
                                        <option value="gpt-4o-mini">gpt-4o-mini</option>
                                        <option value="gpt-4o">gpt-4o</option>
                                        <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
                                    </select>
                                    <button class="btn btn-sm" onclick="loadAIModels('openai')">🔄 刷新</button>
                                </div>
                            </div>
                            <div class="settings-btn-row">
                                <button class="btn btn-sm" onclick="testAIKey('openai')">🔍 测试连接</button>
                                <span id="openaiTestStatus" style="font-size:12px;margin-left:8px;"></span>
                            </div>
                        </div>

                        <div id="aiConfigCustom" class="ai-provider-config" style="display:none; margin-top:12px;">
                            <div class="settings-item">
                                <label>API Key</label>
                                <input type="password" class="settings-input" id="customApiKey" placeholder="sk-...">
                            </div>
                            <div class="settings-item">
                                <label>API 地址（OpenAI兼容）</label>
                                <input type="text" class="settings-input" id="customBaseUrl" placeholder="https://api.example.com/v1">
                            </div>
                            <div class="settings-item">
                                <label>模型</label>
                                <div class="settings-inline-row">
                                    <input type="text" class="settings-input" id="customModel" style="flex:1;" placeholder="模型名称">
                                    <button class="btn btn-sm" onclick="loadAIModels('custom')">🔄 获取</button>
                                </div>
                            </div>
                            <div class="settings-btn-row">
                                <button class="btn btn-sm" onclick="testAIKey('custom')">🔍 测试连接</button>
                                <span id="customTestStatus" style="font-size:12px;margin-left:8px;"></span>
                            </div>
                        </div>

                        <div class="settings-item">
                            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                                <input type="checkbox" id="enableAgent" checked>
                                <span>启用 Agent 工具调用（搜索、播放、切换模块等）</span>
                            </label>
                        </div>

                        <div class="settings-save-bar">
                            <button class="btn btn-primary" onclick="saveAIConfig()">💾 保存AI设置</button>
                            <span id="aiConfigStatus" style="font-size:12px;margin-left:8px;"></span>
                        </div>
                    </div>
                </section>

                <!-- 🔒 安全与通知 -->
                <section class="settings-section" data-group="notify" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🔒 安全与通知</h3>
                        <p class="settings-section-desc">访问密码开关、新作监控消息推送到手机</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🔑 访问密码</div>
                        <div class="settings-item">
                            <label class="auth-switch">
                                <input type="checkbox" id="authEnabled" onchange="onAuthToggle()" ${authOn ? 'checked' : ''}>
                                <span>进入影库需要输入密码</span>
                            </label>
                            <p class="settings-tip" id="authStateTip" data-has-pwd="${authHasPwd ? '1' : '0'}"></p>
                        </div>
                        <div id="authFields" style="display:${authOn ? 'block' : 'none'};">
                            <div class="settings-item" id="authCurrentWrap" style="display:${authOn && authHasPwd ? 'block' : 'none'};">
                                <label style="font-size:12px;color:var(--text-muted);">当前密码</label>
                                <input type="password" class="settings-input" id="authCurrent" autocomplete="current-password"
                                       placeholder="修改或关闭密码前，请先输入当前正在使用的密码">
                                <p class="settings-tip">已开启密码时的安全确认，防止他人趁你已登录时把密码直接关掉。</p>
                            </div>
                            <div class="settings-item">
                                <label id="authPasswordLabel" style="font-size:12px;color:var(--text-muted);">${authHasPwd ? '新密码（留空表示不改）' : '设置密码（至少 4 位）'}</label>
                                <input type="password" class="settings-input" id="authPassword" autocomplete="new-password"
                                       placeholder="${authHasPwd ? '留空则沿用当前密码' : '至少 4 位'}">
                            </div>
                            <div class="settings-item">
                                <label style="font-size:12px;color:var(--text-muted);">确认密码</label>
                                <input type="password" class="settings-input" id="authPassword2" autocomplete="new-password" placeholder="再输入一次">
                            </div>
                        </div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" style="background:var(--primary);" onclick="saveAuthSettings()">保存访问设置</button>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">消息推送</div>
                        <div class="settings-item">
                            <label style="font-size:12px;color:var(--text-muted);">Bark 推送地址（iPhone）</label>
                            <input type="text" class="settings-input" id="pushBarkUrl" value="${(config.push && config.push.barkUrl) || ''}" placeholder="https://api.day.app/你的Key">
                            <p class="settings-tip">留空则不启用 Bark。新作监视发现女优近一月新作 / 漫画新卷时会推送。</p>
                        </div>
                        <div class="settings-item">
                            <label style="font-size:12px;color:var(--text-muted);">Telegram Bot Token</label>
                            <input type="text" class="settings-input" id="pushTgToken" value="${(config.push && config.push.tgBotToken) || ''}" placeholder="123456:ABC-DEF...">
                        </div>
                        <div class="settings-item">
                            <label style="font-size:12px;color:var(--text-muted);">Telegram Chat ID</label>
                            <input type="text" class="settings-input" id="pushTgChatId" value="${(config.push && config.push.tgChatId) || ''}" placeholder="123456789">
                        </div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" onclick="savePushConfig()">保存推送配置</button>
                        </div>
                    </div>

                </section>

                <!-- 🔧 工具维护 -->
                <section class="settings-section" data-group="tools" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🔧 工具维护</h3>
                        <p class="settings-section-desc">批量重命名、NFO 导出与海报管理</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">📝 批量重命名</div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" onclick="previewRename()">🔍 预览重命名</button>
                            <button class="btn btn-sm" style="background:var(--primary);" onclick="startBatchRename()">🚀 开始重命名</button>
                        </div>
                        <div id="renameStatus" style="font-size:13px;color:var(--text-muted);margin-top:8px;">
                            点击「预览重命名」查看将要重命名的文件列表
                        </div>
                        <div id="renamePreview" style="display:none;margin-top:12px;">
                            <div class="rename-preview-box">
                                <table style="width:100%;font-size:12px;border-collapse:collapse;">
                                    <thead>
                                        <tr style="border-bottom:1px solid var(--border);">
                                            <th style="text-align:left;padding:8px;color:var(--text-muted);">原文件名</th>
                                            <th style="text-align:left;padding:8px;color:var(--text-muted);">新文件名</th>
                                        </tr>
                                    </thead>
                                    <tbody id="renamePreviewBody"></tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">NFO 管理</div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" onclick="startExportNfo(false)">📤 导出缺失的NFO</button>
                            <button class="btn btn-sm" style="background:rgba(239,68,68,0.1);color:#ef4444;" onclick="startExportNfo(true)">🔄 覆盖全部导出</button>
                        </div>
                        <div id="exportNfoStatus" style="font-size:12px;color:var(--text-muted);margin-top:8px;">
                            点击按钮开始批量导出NFO文件到视频同目录
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">海报管理</div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" onclick="startBatchPoster(0)">🔄 更换海报（第1个结果）</button>
                            <button class="btn btn-sm" onclick="startBatchPoster(2)">🔄 更换海报（第3个结果）</button>
                            <button class="btn btn-sm" onclick="startPosterRefetch()">🖼️ 重新爬取所有海报</button>
                            <button class="btn btn-sm" style="background:rgba(239,68,68,0.1);color:#ef4444;" onclick="clearAllPosters()">🗑️ 清空所有海报</button>
                        </div>
                        <div id="batchPosterStatus" style="font-size:12px;color:var(--text-muted);margin-top:8px;">
                            一键更换：从搜索结果中选择第1或第3个封面，同步更新到本地文件
                        </div>
                        <div id="posterStatus" style="font-size:12px;color:var(--text-muted);margin-top:6px;">
                            重新爬取：删除现有海报后重新从网络爬取（耗时较长）
                        </div>
                    </div>
                </section>

                <!-- 🍪 Cookie -->
                <section class="settings-section" data-group="cookies" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🍪 Cookie</h3>
                        <p class="settings-section-desc">管理各数据源的登录Cookie，过期后可在此更新</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">Kmoe / KOOBONE</div>
                        <div class="settings-item">
                            <label>Cookie（登录后复制粘贴）</label>
                            <textarea class="settings-input" id="kmoeCookie" style="height:80px;resize:vertical;" placeholder="粘贴Kmoe的Cookie"></textarea>
                        </div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" onclick="testCookie('kmoe')">🔍 测试有效性</button>
                            <button class="btn btn-sm" style="background:var(--primary);" onclick="saveCookie('kmoe')">💾 保存Cookie</button>
                        </div>
                        <div id="kmoeCookieStatus" style="font-size:12px;color:var(--text-muted);margin-top:8px;">状态：未检测</div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">夸克网盘</div>
                        <div class="settings-item">
                            <label>Cookie（登录后复制粘贴）</label>
                            <textarea class="settings-input" id="quarkCookieSetting" style="height:80px;resize:vertical;" placeholder="粘贴夸克网盘的Cookie"></textarea>
                        </div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" onclick="testCookie('quark')">🔍 测试有效性</button>
                            <button class="btn btn-sm" style="background:var(--primary);" onclick="saveCookie('quark')">💾 保存Cookie</button>
                        </div>
                        <div id="quarkCookieStatus" style="font-size:12px;color:var(--text-muted);margin-top:8px;">状态：未检测</div>
                    </div>
                </section>

                <!-- ℹ️ 关于 -->
                <section class="settings-section" data-group="about" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">ℹ️ 关于</h3>
                        <p class="settings-section-desc">本地影库管理系统</p>
                    </div>
                    <div class="settings-about">
                        <p>版本 1.0.0</p>
                        <p style="color: var(--text-muted); font-size: 13px;">Node.js + Express + SQLite</p>
                        <p style="color: var(--text-muted); font-size: 12px;margin-top:8px;">支持：影片/动漫/漫画/小说 全模块管理</p>
                    </div>

                    <!-- 局域网访问 -->
                    <div class="settings-group">
                        <div class="settings-group-title">📱 局域网访问</div>
                        <div class="settings-lan-box" id="lanAccessBox">
                            <div class="lan-loading">正在获取局域网地址...</div>
                        </div>
                        <p style="font-size:12px;color:var(--text-muted);margin-top:12px;">
                            💡 手机和电脑连接同一个WiFi，扫码或输入地址即可访问
                        </p>
                    </div>
                </section>

            </main>
        </div>
    `;
    
    // 加载局域网访问信息
    loadLanInfo();
}

// 加载局域网访问信息
async function loadLanInfo() {
    const box = document.getElementById('lanAccessBox');
    if (!box) return;
    
    try {
        const res = await fetch('/api/config/lan-info');
        const data = await res.json();
        
        if (data.code === 0 && data.data) {
            const { ip, port, url } = data.data;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=10&data=${encodeURIComponent(url)}`;
            
            box.innerHTML = `
                <div style="display:flex;gap:20px;align-items:center;">
                    <div style="flex-shrink:0;background:white;padding:8px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
                        <img src="${qrUrl}" alt="二维码" style="width:140px;height:140px;display:block;" 
                             onerror="this.style.display='none';document.getElementById('lanQrFallback').style.display='block';">
                        <div id="lanQrFallback" style="display:none;width:140px;height:140px;display:flex;align-items:center;justify-content:center;background:#f0f0f0;border-radius:8px;font-size:12px;color:#999;">
                            二维码加载失败
                        </div>
                    </div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;color:var(--text-muted);margin-bottom:6px;">手机浏览器访问地址：</div>
                        <div style="font-size:18px;font-weight:700;color:var(--primary);word-break:break-all;margin-bottom:12px;">
                            ${url}
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">
                            🖥️ 本机IP：${ip}
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);">
                            🔌 端口：${port}
                        </div>
                        <button class="btn btn-sm" style="margin-top:12px;" onclick="copyText('${url}')">
                            📋 复制地址
                        </button>
                    </div>
                </div>
            `;
        } else {
            box.innerHTML = `<div style="color:var(--text-muted);">获取局域网地址失败</div>`;
        }
    } catch (e) {
        box.innerHTML = `<div style="color:var(--text-muted);">获取失败：${e.message}</div>`;
    }
}

// 复制文本到剪贴板
function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
        showNotification('复制成功', '地址已复制到剪贴板');
    }).catch(() => {
        // 降级方案
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showNotification('复制成功', '地址已复制到剪贴板');
    });
}

// 添加文件夹
async function addFolder(type) {
    const inputId = `${type}FolderInput`;
    const input = document.getElementById(inputId);
    const folderPath = input.value.trim();
    
    if (!folderPath) {
        showNotification('请输入文件夹路径', 'error');
        return;
    }
    
    try {
        const res = await fetch(`/api/config/folders/${type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('添加成功，重启后生效');
            loadSettings();
        } else {
            showNotification(data.msg || '添加失败', 'error');
        }
    } catch (e) {
        showNotification('添加失败: ' + e.message, 'error');
    }
}

// 删除文件夹
async function removeFolder(type, folderPath) {
    try {
        const res = await fetch(`/api/config/folders/${type}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('删除成功，重启后生效');
            loadSettings();
        } else {
            showNotification(data.msg || '删除失败', 'error');
        }
    } catch (e) {
        showNotification('删除失败: ' + e.message, 'error');
    }
}

// 保存设置
async function saveSettings() {
    try {
        const config = {
            network: {
                proxyServer: document.getElementById('proxyServer').value,
                timeout: parseInt(document.getElementById('requestTimeout').value) || 10000,
                requestInterval: parseInt(document.getElementById('requestInterval').value) || 800
            },
            ffmpeg: {
                binPath: document.getElementById('ffmpegPath').value,
                screenshotTime: parseInt(document.getElementById('screenshotTime').value) || 15
            },
            player: {
                potPlayerPath: document.getElementById('potPlayerPath').value
            },
            sources: {}
        };
        
        // 收集数据源状态
        document.querySelectorAll('.source-checkbox').forEach(cb => {
            const source = cb.dataset.source;
            config.sources[source] = {
                enabled: cb.checked
            };
        });

        // 收集数据源的可填写凭证（如 FANZA 的 apiId / affiliateId）
        // 后端 POST /api/config 对 sources 做深合并，未提交的字段会保留，不会丢。
        document.querySelectorAll('.source-field-input').forEach(inp => {
            const source = inp.dataset.source;
            if (!config.sources[source]) config.sources[source] = {};
            config.sources[source][inp.dataset.field] = inp.value.trim();
        });
        
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('设置保存成功，重启后生效');
        } else {
            showNotification(data.msg || '保存失败', 'error');
        }
    } catch (e) {
        showNotification('保存失败: ' + e.message, 'error');
    }
}

// ========== 浏览器验证（Cloudflare绕过） ==========

// 初始化浏览器验证
async function initBrowserVerification() {
    const statusEl = document.getElementById('browserVerifyStatus');
    if (statusEl) {
        statusEl.innerHTML = '状态：<span style="color: var(--primary);">正在启动浏览器...</span><br><small>浏览器窗口将弹出，请在其中完成Cloudflare验证（点击验证按钮即可）</small>';
    }
    
    try {
        const res = await fetch('/api/config/browser/init-verification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://hanime1.me' })
        });
        const data = await res.json();
        
        if (statusEl) {
            if (data.code === 0) {
                statusEl.innerHTML = `<span style="color: #10b981;">✅ ${data.msg}</span>`;
                showNotification('浏览器验证成功，cookie已保存');
            } else {
                statusEl.innerHTML = `<span style="color: #ef4444;">❌ ${data.msg}</span>`;
                showNotification(data.msg || '验证失败', 'error');
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.innerHTML = `<span style="color: #ef4444;">❌ 失败: ${e.message}</span>`;
        }
        showNotification('初始化失败: ' + e.message, 'error');
    }
}

// 检查浏览器cookie状态
async function checkBrowserCookie() {
    const statusEl = document.getElementById('browserVerifyStatus');
    if (statusEl) {
        statusEl.innerHTML = '状态：检查中...';
    }
    
    try {
        const res = await fetch('/api/config/browser/check-cookie?url=https://hanime1.me');
        const data = await res.json();
        
        if (statusEl) {
            if (data.data?.valid) {
                statusEl.innerHTML = '<span style="color: #10b981;">✅ Cookie有效，可正常刮削</span>';
            } else {
                statusEl.innerHTML = '<span style="color: #f59e0b;">⚠️ Cookie无效或已过期，请点击「初始化验证」重新验证</span>';
            }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.innerHTML = `<span style="color: #ef4444;">❌ 检查失败: ${e.message}</span>`;
        }
    }
}

// 关闭浏览器
async function closeBrowser() {
    try {
        await fetch('/api/config/browser/close', { method: 'POST' });
        const statusEl = document.getElementById('browserVerifyStatus');
        if (statusEl) {
            statusEl.innerHTML = '状态：浏览器已关闭';
        }
        showNotification('浏览器已关闭');
    } catch (e) {
        showNotification('关闭失败: ' + e.message, 'error');
    }
}

// ========== AI 配置管理 ==========

// 切换AI提供商
function switchAIProvider(provider) {
    // 隐藏所有提供商配置
    document.querySelectorAll('.ai-provider-config').forEach(el => {
        el.style.display = 'none';
    });
    // 显示当前提供商配置
    const configEl = document.getElementById('aiConfig' + provider.charAt(0).toUpperCase() + provider.slice(1));
    if (configEl) {
        configEl.style.display = 'block';
    }

    /* ★ round25 修复 #106：切换提供商后自动拉一次模型列表。
     * 之前只有「🔄 刷新」按钮会调 loadAIModels，且 ollama 的 <select> 初始
     * 文案写死是「加载中...」，用户不点刷新就永远停在那句上 —— 看起来就是
     * 「点了获取/切了提供商也没有模型可选」。这里不再新增按钮，切过去就自动拉。 */
    if (provider === 'ollama' || provider === 'deepseek' || provider === 'openai' || provider === 'custom') {
        // 等 DOM 显示完成、输入框 value 就绪后再拉（避免读到空值）
        setTimeout(() => { loadAIModels(provider); }, 60);
    }
}

// 加载AI配置
async function loadAIConfig() {
    try {
        const res = await fetch('/api/ai/config');
        const data = await res.json();
        
        if (data.code === 0 && data.data) {
            const config = data.data;
            const providerSelect = document.getElementById('aiProvider');
            if (providerSelect) {
                providerSelect.value = config.provider || 'ollama';
                switchAIProvider(config.provider || 'ollama');
            }
            
            // 加载各提供商配置
            if (config.providers) {
                // Ollama
                if (config.providers.ollama) {
                    const ollamaBaseUrl = document.getElementById('ollamaBaseUrl');
                    if (ollamaBaseUrl) ollamaBaseUrl.value = config.providers.ollama.baseUrl || 'http://127.0.0.1:11434';
                    const ollamaModel = document.getElementById('ollamaModel');
                    if (ollamaModel && config.providers.ollama.model) {
                        ollamaModel.value = config.providers.ollama.model;
                    }
                }
                
                // DeepSeek
                if (config.providers.deepseek) {
                    const deepseekApiKey = document.getElementById('deepseekApiKey');
                    if (deepseekApiKey) deepseekApiKey.value = config.providers.deepseek.apiKey || '';
                    const deepseekBaseUrl = document.getElementById('deepseekBaseUrl');
                    if (deepseekBaseUrl) deepseekBaseUrl.value = config.providers.deepseek.baseUrl || 'https://api.deepseek.com';
                    const deepseekModel = document.getElementById('deepseekModel');
                    if (deepseekModel && config.providers.deepseek.model) {
                        // 如果模型不在选项中，添加一个选项
                        if (!Array.from(deepseekModel.options).some(o => o.value === config.providers.deepseek.model)) {
                            const opt = document.createElement('option');
                            opt.value = config.providers.deepseek.model;
                            opt.textContent = config.providers.deepseek.model;
                            deepseekModel.appendChild(opt);
                        }
                        deepseekModel.value = config.providers.deepseek.model;
                    }
                }
                
                // OpenAI
                if (config.providers.openai) {
                    const openaiApiKey = document.getElementById('openaiApiKey');
                    if (openaiApiKey) openaiApiKey.value = config.providers.openai.apiKey || '';
                    const openaiBaseUrl = document.getElementById('openaiBaseUrl');
                    if (openaiBaseUrl) openaiBaseUrl.value = config.providers.openai.baseUrl || 'https://api.openai.com/v1';
                    const openaiSession = document.getElementById('openaiSession');
                    if (openaiSession) openaiSession.value = config.providers.openai?.session || config.opencode?.session || '';
                    const openaiModel = document.getElementById('openaiModel');
                    if (openaiModel && config.providers.openai.model) {
                        if (!Array.from(openaiModel.options).some(o => o.value === config.providers.openai.model)) {
                            const opt = document.createElement('option');
                            opt.value = config.providers.openai.model;
                            opt.textContent = config.providers.openai.model;
                            openaiModel.appendChild(opt);
                        }
                        openaiModel.value = config.providers.openai.model;
                    }
                }
                
                // Custom
                if (config.providers.custom) {
                    const customApiKey = document.getElementById('customApiKey');
                    if (customApiKey) customApiKey.value = config.providers.custom.apiKey || '';
                    const customBaseUrl = document.getElementById('customBaseUrl');
                    if (customBaseUrl) customBaseUrl.value = config.providers.custom.baseUrl || '';
                    const customModel = document.getElementById('customModel');
                    if (customModel) customModel.value = config.providers.custom.model || '';
                }
            }
            
            // Agent开关
            const enableAgent = document.getElementById('enableAgent');
            if (enableAgent) enableAgent.checked = config.enableAgent !== false;

            /* ★ round25 修复 #106：配置填好之后立刻拉一次模型列表。
             * 这是「进设置页 → 模型下拉就是当前可用的模型」的关键一步，
             * 之前完全没有调用点（只有手动点「🔄 刷新」才会拉），
             * 所以 ollama 的 select 永远停在「加载中...」。 */
            const activeProvider = config.provider || 'ollama';
            setTimeout(() => { loadAIModels(activeProvider); }, 120);
        }
    } catch (e) {
        console.log('加载AI配置失败:', e.message);
    }
}

// 加载模型列表
async function loadAIModels(provider) {
    try {
        const statusEl = document.getElementById(provider + 'TestStatus') || document.getElementById('aiConfigStatus');
        if (statusEl) statusEl.textContent = '加载模型列表中...';
        
        let apiKey = '';
        let baseUrl = '';
        
        if (provider === 'ollama') {
            baseUrl = document.getElementById('ollamaBaseUrl')?.value || '';
        } else {
            apiKey = document.getElementById(provider + 'ApiKey')?.value || '';
            baseUrl = document.getElementById(provider + 'BaseUrl')?.value || '';
        }
        
        const params = new URLSearchParams({ provider });
        if (apiKey) params.append('apiKey', apiKey);
        if (baseUrl) params.append('baseUrl', baseUrl);
        
        const res = await fetch('/api/ai/models?' + params.toString());
        const data = await res.json();
        
        if (data.code === 0 && data.data?.models) {
            const modelSelect = document.getElementById(provider + 'Model');
            if (modelSelect && modelSelect.tagName === 'SELECT') {
                const currentValue = modelSelect.value;
                modelSelect.innerHTML = '';
                if (!data.data.models.length) {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = '（该服务商未返回可用模型）';
                    modelSelect.appendChild(opt);
                } else {
                    data.data.models.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id || m.name;
                        opt.textContent = m.name || m.id;
                        modelSelect.appendChild(opt);
                    });
                    // 没有已选值（首次加载）时，默认选中列表里保存的那个模型，否则选第一个
                    if (currentValue) modelSelect.value = currentValue;
                    if (!modelSelect.value && modelSelect.options.length) {
                        modelSelect.selectedIndex = 0;
                    }
                }
            } else if (modelSelect) {
                // 自定义服务商的模型框是文本框：挂一个原生 datalist，既能下拉选也能手打
                let list = document.getElementById(provider + 'ModelList');
                if (!list) {
                    list = document.createElement('datalist');
                    list.id = provider + 'ModelList';
                    modelSelect.parentNode.appendChild(list);
                }
                modelSelect.setAttribute('list', list.id);
                list.innerHTML = data.data.models.map(m => {
                    const id = escapeHtml(String(m.id || m.name || ''));
                    return `<option value="${id}">${escapeHtml(String(m.name || m.id || ''))}</option>`;
                }).join('');
            }
            if (statusEl) statusEl.textContent = `✅ 已加载 ${data.data.models.length} 个模型`;
        } else {
            /* ★ round25：给出可执行的下一步，而不是干巴巴一句「加载失败」。
             * 最常见的两种失败就是 ollama 没开、API Key 写错。 */
            const reason = data.data?.error || data.msg || '未知错误';
            let hint = '';
            if (provider === 'ollama') hint = '（请确认本地 Ollama 已启动，地址默认 http://127.0.0.1:11434）';
            else if (/401|403|key|unauthor/i.test(String(reason))) hint = '（API Key 可能不正确）';
            else if (/ENOTFOUND|ECONNREFUSED|fetch failed|timeout/i.test(String(reason))) hint = '（网络不通，可在设置里开启代理后重试）';
            if (statusEl) statusEl.textContent = '❌ 加载失败: ' + reason + hint;
            // 下拉框不要停在「正在读取…」这种假加载态
            const ms = document.getElementById(provider + 'Model');
            if (ms && ms.tagName === 'SELECT' && !ms.options.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = '（未获取到模型，可点刷新重试）';
                ms.appendChild(opt);
            }
        }
    } catch (e) {
        const statusEl = document.getElementById(provider + 'TestStatus') || document.getElementById('aiConfigStatus');
        let hint = '';
        if (provider === 'ollama') hint = '（请确认本地 Ollama 已启动）';
        else if (/fetch failed|NetworkError/i.test(e.message)) hint = '（网络不通，可开启代理后重试）';
        if (statusEl) statusEl.textContent = '❌ 加载失败: ' + e.message + hint;
        const ms = document.getElementById(provider + 'Model');
        if (ms && ms.tagName === 'SELECT' && !ms.options.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '（未获取到模型，可点刷新重试）';
            ms.appendChild(opt);
        }
    }
}

// 测试API Key
async function testAIKey(provider) {
    try {
        const statusEl = document.getElementById(provider + 'TestStatus');
        if (statusEl) statusEl.textContent = '测试中...';
        
        let apiKey = '';
        let baseUrl = '';
        let model = '';
        
        if (provider === 'ollama') {
            baseUrl = document.getElementById('ollamaBaseUrl')?.value || '';
        } else {
            apiKey = document.getElementById(provider + 'ApiKey')?.value || '';
            baseUrl = document.getElementById(provider + 'BaseUrl')?.value || '';
            const modelEl = document.getElementById(provider + 'Model');
            model = modelEl ? (modelEl.value || modelEl.options?.[0]?.value) : '';
        }
        
        const res = await fetch('/api/ai/test-api-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, apiKey, baseUrl, model })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            if (statusEl) statusEl.innerHTML = '<span style="color:#10b981;">✅ ' + (data.data?.message || '测试成功') + '</span>';
            // 如果有模型列表，更新下拉框
            if (data.data?.models && data.data.models.length > 0) {
                const modelSelect = document.getElementById(provider + 'Model');
                if (modelSelect && modelSelect.tagName === 'SELECT') {
                    const currentValue = modelSelect.value;
                    modelSelect.innerHTML = '';
                    data.data.models.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id || m.name;
                        opt.textContent = m.name || m.id;
                        modelSelect.appendChild(opt);
                    });
                    if (currentValue) modelSelect.value = currentValue;
                }
            }
        } else {
            if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">❌ ' + (data.data?.message || data.msg || '测试失败') + '</span>';
        }
    } catch (e) {
        const statusEl = document.getElementById(provider + 'TestStatus');
        if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">❌ 测试失败: ' + e.message + '</span>';
    }
}

// 保存AI配置
async function saveAIConfig() {
    try {
        const statusEl = document.getElementById('aiConfigStatus');
        if (statusEl) statusEl.textContent = '保存中...';
        
        const provider = document.getElementById('aiProvider')?.value || 'ollama';
        const enableAgent = document.getElementById('enableAgent')?.checked !== false;
        
        let providerConfig = {};
        
        if (provider === 'ollama') {
            providerConfig = {
                baseUrl: document.getElementById('ollamaBaseUrl')?.value || '',
                model: document.getElementById('ollamaModel')?.value || ''
            };
        } else {
            providerConfig = {
                apiKey: document.getElementById(provider + 'ApiKey')?.value || '',
                baseUrl: document.getElementById(provider + 'BaseUrl')?.value || '',
                model: document.getElementById(provider + 'Model')?.value || '',
                session: document.getElementById(provider + 'Session')?.value || ''
            };
        }
        
        const res = await fetch('/api/ai/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, providerConfig, enableAgent })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            if (statusEl) statusEl.innerHTML = '<span style="color:#10b981;">✅ 保存成功，重启后生效</span>';
            showNotification('AI配置保存成功');
        } else {
            if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">❌ 保存失败: ' + (data.msg || '未知错误') + '</span>';
        }
    } catch (e) {
        const statusEl = document.getElementById('aiConfigStatus');
        if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">❌ 保存失败: ' + e.message + '</span>';
    }
}

// ========== Cookie 管理 ==========

// 测试Cookie有效性
async function testCookie(source) {
    const statusEl = document.getElementById(source + 'CookieStatus');
    statusEl.textContent = '状态：测试中...';
    statusEl.style.color = 'var(--text-muted)';
    
    try {
        // 读取输入框中的cookie值（如果有）
        const cookieEl = document.getElementById(source === 'quark' ? 'quarkCookieSetting' : 'kmoeCookie');
        const cookieValue = cookieEl ? cookieEl.value.trim() : '';
        
        const res = await fetch(`/api/config/cookies/${source}/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: cookieValue })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            if (data.data.valid) {
                statusEl.textContent = '✅ 状态：' + data.data.message;
                statusEl.style.color = '#22c55e';
            } else {
                statusEl.textContent = '❌ 状态：' + data.data.message;
                statusEl.style.color = '#ef4444';
            }
        } else {
            statusEl.textContent = '❌ 测试失败：' + data.msg;
            statusEl.style.color = '#ef4444';
        }
    } catch (e) {
        statusEl.textContent = '❌ 测试失败：' + e.message;
        statusEl.style.color = '#ef4444';
    }
}

// 保存Cookie
async function saveCookie(source) {
    const cookieEl = document.getElementById(source === 'quark' ? 'quarkCookieSetting' : 'kmoeCookie');
    const cookie = cookieEl.value.trim();
    
    if (!cookie) {
        showNotification('请输入Cookie', 'error');
        return;
    }
    
    try {
        const res = await fetch(`/api/config/cookies/${source}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('Cookie保存成功，重启后生效', 'success');
            testCookie(source);
        } else {
            showNotification('保存失败: ' + data.msg, 'error');
        }
    } catch (e) {
        showNotification('保存失败: ' + e.message, 'error');
    }
}

// ========== NFO 导出 ==========

// 开始导出NFO
async function startExportNfo(overwrite = false) {
    if (!confirm(overwrite ? '确定要覆盖导出所有NFO文件吗？这可能会覆盖已有的NFO。' : '确定要导出缺失的NFO文件吗？')) {
        return;
    }
    
    const statusEl = document.getElementById('exportNfoStatus');
    statusEl.textContent = '状态：正在导出...';
    
    try {
        const res = await fetch('/api/scanner/export-nfo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overwrite })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('已开始批量导出NFO');
            // 定时更新状态
            const interval = setInterval(async () => {
                try {
                    const statusRes = await fetch('/api/scanner/export-nfo/status');
                    const statusData = await statusRes.json();
                    
                    if (statusData.code === 0) {
                        const s = statusData.data;
                        if (s.running) {
                            statusEl.textContent = `状态：导出中 ${s.current}/${s.total}（成功：${s.success}，失败：${s.failed}，跳过：${s.skipped}）`;
                        } else {
                            statusEl.textContent = `✅ 完成！成功：${s.success}，失败：${s.failed}，跳过：${s.skipped}`;
                            clearInterval(interval);
                        }
                    }
                } catch (e) {
                    clearInterval(interval);
                }
            }, 2000);
        } else {
            statusEl.textContent = '❌ 启动失败：' + data.msg;
        }
    } catch (e) {
        statusEl.textContent = '❌ 启动失败：' + e.message;
    }
}

// ========== 海报管理 ==========

// 重新爬取所有海报
function startPosterRefetch() {
    if (!confirm('确定要重新爬取所有海报吗？这将删除现有海报并重新从网络爬取，耗时较长。')) {
        return;
    }
    
    showNotification('已开始重新爬取海报，请在后台查看进度');
    // 调用后端API（待实现）
    // 目前可以通过运行 clean-posters.js 脚本来实现
}

// 清空所有海报
async function clearAllPosters() {
    if (!confirm('确定要清空所有海报吗？此操作不可恢复！')) {
        return;
    }
    
    if (!confirm('再次确认：真的要删除所有海报吗？')) {
        return;
    }
    
    try {
        const res = await fetch('/api/movie/clear-all-posters', { method: 'POST' });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('所有海报已清空');
            refreshCurrentList();
        } else {
            showNotification('清空失败: ' + data.msg, 'error');
        }
    } catch (e) {
        showNotification('清空失败: ' + e.message, 'error');
    }
}

// 一键批量更换海报
let batchPosterTimer = null;

async function startBatchPoster(searchIndex) {
    const label = searchIndex === 0 ? '第1个' : '第3个';
    if (!confirm(`确定要一键更换所有海报吗？将使用搜索结果的${label}封面，同步更新到本地文件，耗时较长。`)) {
        return;
    }
    
    try {
        const res = await fetch('/api/movie/batch-poster/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ searchIndex })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('已开始批量更换海报，请查看进度');
            // 开始轮询状态
            if (batchPosterTimer) clearInterval(batchPosterTimer);
            batchPosterTimer = setInterval(updateBatchPosterStatus, 2000);
        } else {
            showNotification('启动失败: ' + data.msg, 'error');
        }
    } catch (e) {
        showNotification('启动失败: ' + e.message, 'error');
    }
}

// 更新批量更换海报状态
async function updateBatchPosterStatus() {
    try {
        const res = await fetch('/api/movie/batch-poster/status');
        const data = await res.json();
        
        if (data.code === 0 && data.data) {
            const status = data.data;
            const statusEl = document.getElementById('batchPosterStatus');
            if (statusEl) {
                if (status.running) {
                    statusEl.innerHTML = `🔄 更换中：${status.current}/${status.total}，成功 ${status.success}，失败 ${status.failed} - 当前：${status.currentFile || ''}`;
                    statusEl.style.color = 'var(--primary)';
                } else if (status.total > 0) {
                    statusEl.innerHTML = `✅ 完成！共 ${status.total} 部，成功 ${status.success}，失败 ${status.failed}`;
                    statusEl.style.color = '#10b981';
                    if (batchPosterTimer) {
                        clearInterval(batchPosterTimer);
                        batchPosterTimer = null;
                    }
                    refreshCurrentList();
                }
            }
        }
    } catch (e) {
        // 忽略错误
    }
}

// ========== Ollama 测试 ==========

/* 显示更换海报弹窗
 * ★ round25 修复 #7：
 *   ① 原来只认「视频截帧」，漫画(PDF)/小说(EPUB) 走后端新出的「内容页/内封面」候选，
 *      这里改成按 kind 分组、文案通用化；
 *   ② 一条候选都没有时，不再只丢一句「未刮削到」，而是给出**可执行的诊断**：
 *      代理是否开启、刮削接口返回了什么、以及内容截图为什么没出来；
 *   ③ 「自己上传 / 粘贴图片」入口**始终**存在（原来只在刮削为空时出现）。 */
async function showChangePosterModal(movieId) {
    currentMovieId = movieId;
    const modal = document.getElementById('posterModal');
    const grid = document.getElementById('posterGrid');

    grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">正在搜索海报…（同时准备内容截图候选）</div>';
    modal.classList.add('show');

    const [scraped, frames, cfg] = await Promise.all([
        fetch(`/api/movie/${movieId}/search-posters`).then(r => r.json()).catch(e => ({ code: -1, msg: e.message })),
        fetch(`/api/movie/${movieId}/frame-candidates`).then(r => r.json()).catch(e => ({ code: -1, msg: e.message })),
        fetch('/api/config').then(r => r.json()).catch(() => null)
    ]);

    const found = (scraped.code === 0 && scraped.data) || [];
    const shots = (frames.code === 0 && frames.data) || [];
    const proxyOn = !!(cfg && cfg.data && cfg.data.network && cfg.data.network.proxyServer);

    const card = (p) => `
        <div class="poster-option" onclick="changePoster(${movieId}, '${p.url}')">
            <img src="${p.display || p.url}" alt="${p.title || ''}" loading="lazy">
            <div class="poster-option-info">
                <span class="poster-option-source">${String(p.source || '').toUpperCase()}</span>
                ${p.title ? `<span class="poster-option-title">${p.title}</span>` : ''}
            </div>
        </div>`;

    const uploadBtn = `
        <button class="btn btn-sm" onclick="closePosterModal();showUploadPosterModal(${movieId})">📤 自己上传 / 粘贴图片</button>`;

    let html = '';

    // —— 1. 刮削结果 ——
    if (found.length) {
        html += `<div class="poster-section-label">🔍 刮削结果（${found.length}）</div>` + found.map(card).join('');
    } else {
        // 诊断块：告诉用户「为什么没有」，而不是只报「没有」
        const reasons = [];
        if (scraped.code !== 0) {
            reasons.push(`刮削接口未返回结果${scraped.msg ? '：' + scraped.msg : ''}`);
        } else {
            reasons.push('各刮削源都没有这部作品的封面（片名/番号可能对不上，或站点没有收录）');
        }
        reasons.push(proxyOn
            ? '代理已开启；若仍是空，多为站点本身没有该条目，或站点被 Cloudflare 拦截'
            : '⚠️ 当前**未配置代理**，境外刮削源大概率连不上 —— 可到「设置 → 数据源 → 代理设置」填好代理后重试');
        html += `
            <div class="poster-empty-diagnosis">
                <div style="font-weight:600;color:var(--text);margin-bottom:6px;">未刮削到任何封面</div>
                <ul style="margin:0 0 10px 18px;padding:0;line-height:1.7;">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="btn btn-sm" onclick="showChangePosterModal(${movieId})">🔄 重新刮削</button>
                    ${uploadBtn}
                </div>
            </div>`;
    }

    // —— 2. 内容截图候选（视频抽帧 / PDF 页 / EPUB 内封面）——
    if (shots.length) {
        const kinds = new Set(shots.map(s => s.kind));
        const label = kinds.has('pdf') ? 'PDF 内容页'
            : kinds.has('epub') ? 'EPUB 内封面'
                : '视频截帧';
        html += `<div class="poster-section-label">🎞️ ${label}（点一张就用作封面）</div>` + shots.map(card).join('');
    } else if (scraped.code === 0 && frames.code === 0) {
        html += `
            <div class="poster-section-label" style="opacity:.75;">🎞️ 内容截图</div>
            <div style="grid-column:1/-1;font-size:12.5px;color:var(--text-muted);padding:4px 2px 10px;">
                这部作品没有可用的内容截图（视频截帧需要文件可读且装了 ffmpeg；漫画/小说需要 PDF / EPUB 内确实有图）。
            </div>`;
    }

    // —— 3. 兜底：上传入口始终可达 ——
    if (found.length) {
        html += `<div style="grid-column:1/-1;margin-top:12px;display:flex;justify-content:flex-end;">${uploadBtn}</div>`;
    }

    grid.innerHTML = html;
}

// 关闭海报弹窗
function closePosterModal() {
    document.getElementById('posterModal').classList.remove('show');
}

// 更换海报
async function changePoster(movieId, posterUrl) {
    try {
        const res = await fetch(`/api/movie/${movieId}/change-poster`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posterUrl })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('海报更换成功');
            // 逐个修正封面队列：选完自动进下一部，否则维持原逻辑
            if (window.posterFixActive && window.posterFixAdvance) {
                window.posterFixAdvance(true);
            } else {
                closePosterModal();
                showMovieDetail(movieId);
                // 原地刷新列表（保持页码与视窗位置）
                refreshCurrentList();
            }
        } else {
            showNotification(data.msg || '更换失败', 'error');
        }
    } catch (e) {
        showNotification('更换失败: ' + e.message, 'error');
    }
}

// 预览重命名
async function previewRename() {
    try {
        const res = await fetch('/api/scanner/rename/preview', {
            method: 'POST'
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('预览已启动，请稍候...');
            // 轮询获取预览结果
            const interval = setInterval(async () => {
                const statusRes = await fetch('/api/scanner/rename/preview');
                const statusData = await statusRes.json();
                
                if (statusData.code === 0 && statusData.data && statusData.data.length > 0) {
                    clearInterval(interval);
                    showRenamePreview(statusData.data);
                    showNotification(`预览完成，共 ${statusData.data.length} 个文件`);
                }
            }, 2000);
        } else {
            showNotification(data.msg || '启动失败', 'error');
        }
    } catch (e) {
        showNotification('启动失败: ' + e.message, 'error');
    }
}

// 显示重命名预览
function showRenamePreview(list) {
    const previewDiv = document.getElementById('renamePreview');
    const tbody = document.getElementById('renamePreviewBody');
    const statusDiv = document.getElementById('renameStatus');
    
    previewDiv.style.display = 'block';
    statusDiv.textContent = `共 ${list.length} 个文件将被重命名`;
    
    tbody.innerHTML = list.map(item => `
        <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px;color:var(--text-muted);">${item.oldName}</td>
            <td style="padding:8px;color:var(--primary);">${item.newName}</td>
        </tr>
    `).join('');
}

// 开始批量重命名
async function startBatchRename() {
    if (!confirm('确定要开始批量重命名吗？此操作会直接修改本地文件名！')) {
        return;
    }
    
    try {
        const res = await fetch('/api/scanner/rename/start', {
            method: 'POST'
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('批量重命名已启动');
            // 轮询状态
            const interval = setInterval(async () => {
                const statusRes = await fetch('/api/scanner/rename/status');
                const statusData = await statusRes.json();
                
                if (statusData.code === 0) {
                    const status = statusData.data;
                    const statusDiv = document.getElementById('renameStatus');
                    
                    if (status.running) {
                        statusDiv.innerHTML = `
                            正在重命名：${status.current}/${status.total}<br>
                            当前文件：${status.currentFile}<br>
                            成功：${status.success}，失败：${status.failed}，跳过：${status.skipped}
                        `;
                    } else {
                        clearInterval(interval);
                        statusDiv.innerHTML = `
                            重命名完成！<br>
                            成功：${status.success}，失败：${status.failed}，跳过：${status.skipped}
                        `;
                        showNotification(`重命名完成！成功 ${status.success} 个`);
                        // 原地刷新列表（保持页码与视窗位置）
                        refreshCurrentList();
                    }
                }
            }, 2000);
        } else {
            showNotification(data.msg || '启动失败', 'error');
        }
    } catch (e) {
        showNotification('启动失败: ' + e.message, 'error');
    }
}

// 显示AI助手
function showAIAssistant() {
    document.getElementById('aiModal').classList.add('show');
}

// 关闭AI助手
function closeAIModal() {
    document.getElementById('aiModal').classList.remove('show');
}

// 发送AI消息
async function sendAIMessage() {
    const input = document.getElementById('aiInput');
    const message = input.value.trim();
    if (!message) return;
    
    const messagesDiv = document.getElementById('aiMessages');
    
    // 添加用户消息
    messagesDiv.innerHTML += `
        <div style="margin-bottom:12px;text-align:right;">
            <div style="display:inline-block;padding:10px 14px;background:var(--primary);color:white;border-radius:12px 12px 0 12px;max-width:80%;">
                ${message}
            </div>
        </div>
    `;
    
    input.value = '';
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // 添加AI正在输入的提示
    const typingId = 'typing-' + Date.now();
    messagesDiv.innerHTML += `
        <div id="${typingId}" style="margin-bottom:12px;">
            <div style="display:inline-block;padding:10px 14px;background:var(--card-bg);border-radius:12px 12px 12px 0;color:var(--text-muted);">
                正在思考...
            </div>
        </div>
    `;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    try {
        const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        
        // 移除正在输入提示
        document.getElementById(typingId)?.remove();
        
        if (data.code === 0) {
            const reply = data.data.reply || '抱歉，我没有理解你的问题';
            const movieRefs = data.data.movieRefs || [];
            const toolCalls = data.data.toolCalls || [];
            
            // 把回答中的 [[ID|标题]] 替换成可点击的标记
            let formattedReply = reply.replace(/\[\[(\d+)\|([^\]]+)\]\]/g, (match, id, title) => {
                return `<span class="ai-movie-ref" data-movie-id="${id}" onclick="jumpToMovieFromAI(${id})" style="color:var(--accent);cursor:pointer;text-decoration:underline;">📎 ${title}</span>`;
            });
            
            // 生成相关影片卡片HTML
            let movieCardsHtml = '';
            if (movieRefs.length > 0) {
                movieCardsHtml = `
                    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
                        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">📚 相关影片 (${movieRefs.length})</div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap;">
                            ${movieRefs.map(movie => {
                                const posterUrl = movie.posterPath ? `/api/movie/poster/${movie.posterPath}` : '';
                                const tagsHtml = movie.tags && movie.tags.length > 0 
                                    ? movie.tags.slice(0, 3).map(t => `<span style="font-size:10px;padding:1px 5px;background:var(--bg);border-radius:8px;color:var(--text-muted);">${t.name}</span>`).join('')
                                    : '';
                                const actressesHtml = movie.actresses && movie.actresses.length > 0
                                    ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">👩 ${movie.actresses.map(a => a.name).slice(0, 2).join(', ')}</div>`
                                    : '';
                                return `
                                    <div class="ai-movie-card" onclick="jumpToMovieFromAI(${movie.id})" style="width:120px;cursor:pointer;border-radius:8px;overflow:hidden;background:var(--bg);border:1px solid var(--border);transition:all 0.2s ease;" onmouseover="this.style.borderColor='var(--accent)';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border)';this.style.transform=''">
                                        <div style="width:100%;aspect-ratio:2/3;background:var(--bg-elevated);overflow:hidden;">
                                            ${posterUrl ? `<img src="${posterUrl}" style="width:100%;height:100%;object-fit:cover;" alt="${movie.title}">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:24px;opacity:0.3;">🎬</div>`}
                                        </div>
                                        <div style="padding:6px;">
                                            <div style="font-size:11px;font-weight:600;color:var(--text);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${movie.title || movie.avid || '未知'}</div>
                                            ${movie.avid ? `<div style="font-size:10px;color:var(--accent);margin-top:2px;">${movie.avid}</div>` : ''}
                                            ${actressesHtml}
                                            <div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap;">${tagsHtml}</div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }
            
            messagesDiv.innerHTML += `
                <div style="margin-bottom:12px;">
                    <div style="display:inline-block;padding:10px 14px;background:var(--card-bg);border-radius:12px 12px 12px 0;max-width:90%;">
                        <div style="white-space:pre-wrap;line-height:1.6;">${formattedReply}</div>
                        ${movieCardsHtml}
                    </div>
                </div>
            `;
            
            // 执行AI返回的工具调用
            if (toolCalls.length > 0) {
                await executeAIToolCalls(toolCalls, messagesDiv);
            }
        } else {
            messagesDiv.innerHTML += `
                <div style="margin-bottom:12px;">
                    <div style="display:inline-block;padding:10px 14px;background:rgba(239,68,68,0.1);color:#ef4444;border-radius:12px 12px 12px 0;">
                        出错了：${data.msg || '未知错误'}
                    </div>
                </div>
            `;
        }
    } catch (e) {
        document.getElementById(typingId)?.remove();
        messagesDiv.innerHTML += `
            <div style="margin-bottom:12px;">
                <div style="display:inline-block;padding:10px 14px;background:rgba(239,68,68,0.1);color:#ef4444;border-radius:12px 12px 12px 0;">
                    出错了：${e.message}
                </div>
            </div>
        `;
    }
    
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// 从AI回答跳转到影片详情
function jumpToMovieFromAI(movieId) {
    // 关闭AI弹窗
    closeAIModal();
    // 切换到全部影片视图
    switchView('movies');
    // 显示影片详情
    setTimeout(() => {
        showMovieDetail(movieId);
    }, 300);
}

// ========== AI Agent 工具调用执行 ==========

// 执行AI返回的工具调用
async function executeAIToolCalls(toolCalls, messagesDiv) {
    if (!toolCalls || toolCalls.length === 0) return;
    
    for (const toolCall of toolCalls) {
        const toolName = toolCall.function?.name;
        let toolArgs = {};
        try {
            toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
        } catch (e) {
            console.log('解析工具参数失败:', e.message);
        }
        
        // 显示工具调用状态
        const statusId = 'tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        messagesDiv.innerHTML += `
            <div id="${statusId}" style="margin-bottom:8px;margin-left:20px;font-size:12px;color:var(--text-muted);">
                🔧 执行操作: ${toolName}...
            </div>
        `;
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        
        try {
            // 敏感操作需要用户确认
            const sensitiveTools = ['play_movie', 'add_tags', 'translate_movie', 'rename_movie', 'scrape_poster'];
            if (sensitiveTools.includes(toolName)) {
                const confirmMsg = getToolConfirmMessage(toolName, toolArgs);
                if (!confirm(confirmMsg)) {
                    document.getElementById(statusId)?.remove();
                    messagesDiv.innerHTML += `
                        <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:var(--text-muted);">
                            ⏭️ 已跳过: ${toolName}（用户取消）
                        </div>
                    `;
                    continue;
                }
            }
            
            // 调用后端执行工具
            const res = await fetch('/api/ai/execute-tool', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ toolName, arguments: toolArgs })
            });
            const data = await res.json();
            
            document.getElementById(statusId)?.remove();
            
            if (data.code === 0) {
                const result = data.data || {};
                
                // 处理需要前端执行的操作
                if (result.action === 'play_movie') {
                    messagesDiv.innerHTML += `
                        <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#10b981;">
                            ✅ 正在播放影片 ID: ${result.movie_id}
                        </div>
                    `;
                    // 关闭AI弹窗并播放
                    setTimeout(() => {
                        closeAIModal();
                        openWithPotPlayer(result.movie_id);
                    }, 500);
                } else if (result.action === 'switch_module') {
                    messagesDiv.innerHTML += `
                        <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#10b981;">
                            ✅ 正在切换到: ${result.module}
                        </div>
                    `;
                    setTimeout(() => {
                        closeAIModal();
                        switchView(result.module);
                    }, 500);
                } else if (result.action === 'open_folder') {
                    messagesDiv.innerHTML += `
                        <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#10b981;">
                            ✅ 正在打开文件夹 ID: ${result.movie_id}
                        </div>
                    `;
                    setTimeout(() => {
                        openMovieFolder(result.movie_id);
                    }, 300);
                } else if (result.action === 'rename_movie') {
                    messagesDiv.innerHTML += `
                        <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#10b981;">
                            ✅ 正在重命名影片 ID: ${result.movie_id}
                        </div>
                    `;
                    setTimeout(() => {
                        closeAIModal();
                        doRename(result.movie_id);
                    }, 500);
                } else if (result.action === 'scrape_poster') {
                    messagesDiv.innerHTML += `
                        <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#10b981;">
                            ✅ 正在重新刮削海报 ID: ${result.movie_id}
                        </div>
                    `;
                    setTimeout(() => {
                        closeAIModal();
                        rescrapeMovie(result.movie_id);
                    }, 500);
                } else {
                    // 显示工具执行结果
                    const resultText = formatToolResult(toolName, result);
                    messagesDiv.innerHTML += `
                        <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#10b981;">
                            ✅ ${resultText}
                        </div>
                    `;
                    
                    // 如果结果是影片列表，渲染成可点击的海报卡片
                    if (Array.isArray(result) && result.length > 0 && result[0].id && result[0].title) {
                        const cardsHtml = renderAIMovieCards(result);
                        messagesDiv.innerHTML += `
                            <div style="margin:8px 0 12px 20px;padding:12px;background:var(--bg-elevated);border-radius:12px;">
                                <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">🎬 搜索结果 (${result.length}部)</div>
                                <div style="display:flex;gap:8px;flex-wrap:wrap;">${cardsHtml}</div>
                            </div>
                        `;
                    }
                }
            } else {
                messagesDiv.innerHTML += `
                    <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#ef4444;">
                        ❌ 执行失败: ${data.msg || '未知错误'}
                    </div>
                `;
            }
        } catch (e) {
            document.getElementById(statusId)?.remove();
            messagesDiv.innerHTML += `
                <div style="margin-bottom:8px;margin-left:20px;font-size:12px;color:#ef4444;">
                    ❌ 执行异常: ${e.message}
                </div>
            `;
        }
        
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
}

// 获取工具确认消息
function getToolConfirmMessage(toolName, toolArgs) {
    switch (toolName) {
        case 'play_movie':
            return `确定要播放影片 ID: ${toolArgs.movie_id} 吗？`;
        case 'add_tags':
            return `确定要为影片 ID: ${toolArgs.movie_id} 生成AI标签吗？`;
        case 'translate_movie':
            return `确定要翻译影片 ID: ${toolArgs.movie_id} 的标题和简介吗？`;
        case 'rename_movie':
            return `确定要重命名影片 ID: ${toolArgs.movie_id} 吗？这将修改本地文件名。`;
        case 'scrape_poster':
            return `确定要为影片 ID: ${toolArgs.movie_id} 重新刮削海报吗？`;
        default:
            return `确定要执行 ${toolName} 操作吗？`;
    }
}

// 格式化工具执行结果
function formatToolResult(toolName, result) {
    switch (toolName) {
        case 'search_movies':
            return `搜索完成，找到 ${result.length || 0} 部影片`;
        case 'get_movie_detail':
            return `获取影片详情成功: ${result.title || '未知'}`;
        case 'get_random_movies':
            return `随机推荐 ${result.length || 0} 部影片`;
        case 'get_recommendations':
            return `AI推荐 ${result.length || 0} 部影片`;
        case 'get_statistics':
            return `统计完成：共 ${result.totalMovies || 0} 部影片`;
        case 'add_tags':
            return `标签生成成功：${result.tags?.length || 0}个标签，${result.actresses?.length || 0}位演员`;
        case 'translate_movie':
            return `翻译完成`;
        case 'get_actress_list':
            return `找到 ${result.length || 0} 位女优`;
        case 'get_tag_list':
            return `找到 ${result.length || 0} 个标签`;
        case 'read_project_file':
            return result.error ? `读取文件失败: ${result.error}` : `读取文件成功: ${result.file_path} (${result.totalLength}字符${result.truncated ? '，已截断' : ''})`;
        default:
            return `${toolName} 执行成功`;
    }
}

// 渲染AI返回的影片卡片（可点击跳转，带播放按钮）
function renderAIMovieCards(movies) {
    if (!movies || movies.length === 0) return '';
    return movies.slice(0, 8).map(movie => {
        const posterUrl = movie.poster ? `/api/movie/poster/${movie.poster}` : '';
        return `
            <div class="ai-movie-card" style="width:110px;cursor:pointer;border-radius:10px;overflow:hidden;background:var(--card-bg);border:1px solid var(--border);transition:all 0.2s ease;" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,0.15)'" onmouseout="this.style.transform='';this.style.boxShadow=''" onclick="jumpToMovieFromAI(${movie.id})">
                <div style="width:100%;aspect-ratio:2/3;background:var(--bg-elevated);overflow:hidden;position:relative;">
                    ${posterUrl ? `<img src="${posterUrl}" style="width:100%;height:100%;object-fit:cover;" alt="${movie.title}" onerror="this.style.display='none';this.parentElement.innerHTML='<div style=\\'width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:32px;\\'>🎬</div>'">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:32px;">🎬</div>`}
                    <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.7));padding:16px 6px 6px;display:flex;gap:4px;">
                        <button style="flex:1;padding:4px 0;background:rgba(255,255,255,0.9);border:none;border-radius:6px;font-size:10px;cursor:pointer;font-weight:600;" onclick="event.stopPropagation();closeAIModal();setTimeout(()=>openWithPotPlayer(${movie.id}),300)">▶ 播放</button>
                        <button style="flex:1;padding:4px 0;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);border-radius:6px;font-size:10px;cursor:pointer;color:white;" onclick="event.stopPropagation();jumpToMovieFromAI(${movie.id})">详情</button>
                    </div>
                </div>
                <div style="padding:6px 8px;">
                    <div style="font-size:11px;font-weight:600;color:var(--text);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${movie.title || '未命名'}</div>
                    ${movie.avid ? `<div style="font-size:10px;color:var(--accent);margin-top:2px;font-weight:500;">${movie.avid}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// AI翻译影片
async function aiTranslate(movieId) {
    try {
        showNotification('正在翻译，请稍候...');
        
        const res = await fetch(`/api/ai/translate/${movieId}`, {
            method: 'POST'
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('翻译完成');
            // 重新加载详情
            showMovieDetail(movieId);
            // 原地刷新列表（保持页码与视窗位置）
            refreshCurrentList();
        } else {
            showNotification(data.msg || '翻译失败', 'error');
        }
    } catch (e) {
        showNotification('翻译失败: ' + e.message, 'error');
    }
}

// AI生成标签
async function aiGenerateTags(movieId) {
    try {
        showNotification('正在生成标签，请稍候...');
        
        const res = await fetch(`/api/ai/tags/${movieId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overwrite: false })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            const result = data.data || {};
            const tags = result.tags || [];
            const actresses = result.actresses || [];
            
            if (tags.length > 0 || actresses.length > 0) {
                // 后端已自动保存到数据库，直接显示结果并刷新
                let msg = 'AI标签生成成功！';
                if (tags.length > 0) msg += `\n标签：${tags.join('、')}`;
                if (actresses.length > 0) msg += `\n女优：${actresses.join('、')}`;
                showNotification(msg, 'success');
                showMovieDetail(movieId);
            } else {
                showNotification('未能生成标签', 'error');
            }
        } else {
            showNotification(data.msg || '生成失败', 'error');
        }
    } catch (e) {
        showNotification('生成失败: ' + e.message, 'error');
    }
}

// 显示相关影片关系图（魔术按钮）
async function showRelationGraph(movieId) {
    try {
        showNotification('正在查找相关影片...');
        
        // 获取影片详情
        const movie = await api.getMovieDetail(movieId);
        if (!movie) return;
        
        // 获取所有影片用于匹配
        const allMovies = await api.getMovies({ limit: 1000 });
        const movieList = allMovies.data || allMovies || [];
        
        // 找出相同女优的影片
        const actressNames = (movie.actresses || []).map(a => a.name);
        const sameActressMovies = movieList.filter(m => {
            if (m.id === movieId) return false;
            return m.actresses && m.actresses.some(a => actressNames.includes(a.name));
        }).slice(0, 12);
        
        // 找出相同标签的影片
        const tagNames = (movie.tags || []).map(t => t.name);
        const sameTagMovies = movieList.filter(m => {
            if (m.id === movieId) return false;
            if (sameActressMovies.some(s => s.id === m.id)) return false; // 去重
            return m.tags && m.tags.some(t => tagNames.includes(t.name));
        }).slice(0, 12);
        
        // 创建关系图HTML
        const relationHtml = `
            <div class="detail-section" id="relationGraphSection">
                <h4>✨ 相关影片 <button class="btn btn-sm btn-secondary" style="float:right;padding:4px 10px;font-size:12px;" onclick="document.getElementById('relationGraphSection').remove()">关闭</button></h4>
                
                ${sameActressMovies.length > 0 ? `
                <div style="margin-bottom:20px;">
                    <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">👩 相同女优 (${sameActressMovies.length}部)</div>
                    <div class="similar-grid">
                        ${sameActressMovies.map(s => `
                            <div class="similar-card" onclick="showMovieDetail(${s.id})">
                                <img class="similar-poster" src="${getPosterUrl(s)}" alt="${s.title}" loading="lazy">
                                <div class="similar-title">${s.title || s.avid || ''}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                ${sameTagMovies.length > 0 ? `
                <div>
                    <div style="font-size:13px;color:var(--text-muted);margin-bottom:10px;">🏷️ 相似标签 (${sameTagMovies.length}部)</div>
                    <div class="similar-grid">
                        ${sameTagMovies.map(s => `
                            <div class="similar-card" onclick="showMovieDetail(${s.id})">
                                <img class="similar-poster" src="${getPosterUrl(s)}" alt="${s.title}" loading="lazy">
                                <div class="similar-title">${s.title || s.avid || ''}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                ${sameActressMovies.length === 0 && sameTagMovies.length === 0 ? `
                    <div style="text-align:center;padding:40px;color:var(--text-muted);">
                        暂无相关影片
                    </div>
                ` : ''}
            </div>
        `;
        
        // 插入到详情页中
        const detailBody = document.getElementById('detailBody');
        const existingSection = document.getElementById('relationGraphSection');
        if (existingSection) {
            existingSection.remove();
        }
        
        // 插入到相似推荐前面
        const similarSection = detailBody.querySelector('.similar-section');
        if (similarSection) {
            similarSection.insertAdjacentHTML('beforebegin', relationHtml);
        } else {
            detailBody.insertAdjacentHTML('beforeend', relationHtml);
        }
        
        showNotification('已找到相关影片');
        
    } catch (e) {
        showNotification('查找失败: ' + e.message, 'error');
    }
}

// 添加到播放列表（2026-09-22：去掉原生 prompt 序列号，改成卡片式选择弹窗；
// 只有一个列表时直接加入，零打扰）
let playlistPickMovieId = null;

async function addToPlaylist(movieId) {
    const lists = await api.getPlaylists();

    if (lists.length === 0) {
        showNotification('暂无播放列表', '请先创建播放列表');
        return;
    }

    // 只有一个列表 → 直接加入，不再确认
    if (lists.length === 1) {
        await doAddToPlaylist(lists[0], movieId);
        return;
    }

    playlistPickMovieId = movieId;
    const box = document.getElementById('playlistPickList');
    box.innerHTML = lists.map(l => `
        <div class="plp-item" onclick="pickPlaylistForAdd(${l.id})">
            <span class="plp-ico">🎬</span>
            <span class="plp-name">${escapeHtml(l.name)}</span>
            <span class="plp-count">${l.movieCount || 0} 部</span>
        </div>
    `).join('');
    document.getElementById('playlistPickModal').style.display = 'flex';
}

async function pickPlaylistForAdd(listId) {
    const lists = await api.getPlaylists();
    const list = lists.find(l => l.id === listId);
    closePlaylistPickModal();
    if (list && playlistPickMovieId != null) await doAddToPlaylist(list, playlistPickMovieId);
    playlistPickMovieId = null;
}

function closePlaylistPickModal() {
    document.getElementById('playlistPickModal').style.display = 'none';
}

async function doAddToPlaylist(list, movieId) {
    const result = await api.addToPlaylist(list.id, movieId);
    if (result.code === 0) {
        showNotification('添加成功', `已添加到「${list.name}」`);
    } else {
        showNotification('添加失败', result.msg);
    }
}

// 画廊显示/隐藏
function showGallery() {
    document.getElementById('gallerySection').style.display = 'block';
}

function hideGallery() {
    document.getElementById('gallerySection').style.display = 'none';
}

// ========== 视图切换 ==========
function switchView(view) {
    currentView = view;
    currentFilter = null; // 切换视图时清除标签/女优筛选上下文
    currentSearchQuery = '';
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
    selectedMovies.clear();
    updateBatchToolbar();
    
    // 更新导航高亮（guess-grid / guess-magic 是「猜你喜欢」的其他模式，高亮仍归到 guess）
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.view === view ||
            ((view === 'guess-grid' || view === 'guess-magic') && item.dataset.view === 'guess')) {
            item.classList.add('active');
        }
    });

    // 隐藏所有视图
    document.getElementById('movieGrid').style.display = 'none';
    document.getElementById('movieGrid').classList.remove('tree-mode');
    // 第 25 轮：离开收藏页时摘掉个性化布局类，避免污染其它视图
    if (view !== 'favorites') {
        document.getElementById('movieGrid').classList.remove('fav-layout-compact', 'fav-layout-large', 'fav-layout-list');
    }
    document.getElementById('actressGrid').style.display = 'none';
    document.getElementById('tagCloud').style.display = 'none';
    document.getElementById('statsPanel').style.display = 'none';
    document.getElementById('emptyTip').style.display = 'none';
    document.getElementById('settingsView').style.display = 'none';
    const featureView = document.getElementById('featureView');
    if (featureView) featureView.style.display = 'none';
    const profileStrip = document.getElementById('profileStrip');
    if (profileStrip) profileStrip.style.display = 'none';
    document.getElementById('sortSelect').parentElement.style.display = 'block';
    document.getElementById('pagination').style.display = 'none';

    // 魔术卡片视图（猜你喜欢）：由它自己的 case 决定是否打开
    const magicView = document.getElementById('magicView');
    if (magicView) {
        magicView.style.display = 'none';
        magicView.classList.remove('show');
    }
    if (window.MagicLikes) window.MagicLikes.close();
    
    // 阅读统计横幅仅在 漫画/小说 库显示
    const banner = document.getElementById('readingStatsBanner');
    if (banner && !['comic', 'novel'].includes(view)) {
        banner.style.display = 'none';
    }

    // 面包屑仅在 漫画/小说 库显示
    if (!['comic', 'novel'].includes(view)) {
        hideTreeBreadcrumb();
    }
    
    // 首页/动漫/漫画/小说显示画廊
    const galleryViews = ['movies', 'anime', 'comic', 'novel'];
    if (galleryViews.includes(view)) {
        showGallery();
        initGallery(view);
    } else {
        hideGallery();
    }
    
    // 显示对应视图
    switch (view) {
        case 'movies':
            document.getElementById('movieGrid').style.display = 'grid';
            loadMovies();
            break;
        case 'jav':
            document.getElementById('movieGrid').style.display = 'grid';
            hideGallery();
            loadJavMovies();
            break;
        case 'favorites':
            document.getElementById('movieGrid').style.display = 'grid';
            loadFavorites();
            break;
        case 'actresses':
            document.getElementById('actressGrid').style.display = 'grid';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            loadActresses();
            break;
        case 'tags':
            document.getElementById('tagCloud').style.display = 'flex';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            loadTags();
            break;
        case 'playlists':
            document.getElementById('movieGrid').style.display = 'grid';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            loadPlaylists();
            break;
        case 'settings':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            loadSettings();
            break;        case 'new-releases':
            document.getElementById('movieGrid').style.display = 'grid';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            loadNewReleases();
            break;
        case 'anime':
            document.getElementById('movieGrid').style.display = 'grid';
            document.getElementById('sortSelect').parentElement.style.display = 'block';
            hideGallery();
            loadAnime();
            break;
        case 'comic':
            document.getElementById('movieGrid').style.display = 'grid';
            document.getElementById('sortSelect').parentElement.style.display = 'block';
            hideGallery();
            loadComic();
            break;
        case 'novel':
            document.getElementById('movieGrid').style.display = 'grid';
            document.getElementById('sortSelect').parentElement.style.display = 'block';
            hideGallery();
            loadNovel();
            break;
        case 'hot':
            document.getElementById('movieGrid').style.display = 'grid';
            loadHot();
            break;
        case 'random':
            document.getElementById('movieGrid').style.display = 'grid';
            loadRandom();
            break;
        case 'guess':
            // Aardvark 散落展台（默认）。AvBoard 缺失时退回魔术牌堆，再退网格。
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('✨ 猜你喜欢');
            if (window.AvBoard) {
                document.getElementById('movieGrid').style.display = 'grid';
                window.AvBoard.openGuess();
                break;
            }
            if (!window.MagicLikes) {
                document.getElementById('movieGrid').style.display = 'grid';
                loadGuess();
                break;
            }
            document.getElementById('movieGrid').style.display = 'none';
            window.MagicLikes.open();
            break;
        case 'guess-magic':
            // 魔术牌堆模式（从 Aardvark 展台的 🃏 按钮进入）
            if (!window.MagicLikes) { switchView('guess'); break; }
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('✨ 猜你喜欢');
            window.MagicLikes.open();
            break;
        case 'guess-grid':
            // 列表模式：保留原来的网格浏览（魔术视图里的 ☰ 按钮切过来）
            document.getElementById('movieGrid').style.display = 'grid';
            loadGuess();
            break;
        case 'unwatched':
            document.getElementById('movieGrid').style.display = 'grid';
            loadUnwatched();
            break;
        case 'recent':
            document.getElementById('movieGrid').style.display = 'grid';
            loadRecent();
            break;
        case 'annual':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('📈 年度报告');
            if (window.Features && window.Features.showAnnual) window.Features.showAnnual();
            break;
        case 'scrape-failures':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('⚠️ 刮削失败');
            if (window.Features && window.Features.showFailures) window.Features.showFailures();
            break;
        // ★ 四个在线观看板块（第 16 轮）：共用同一套 macOS 窗口与交互，只是站点集合不同。
        //   板块归属由 Features 里的 BOARD_OF_VIEW 决定，这里只负责把 view 名透传过去。
        case 'watch':
        case 'watch-anime':
        case 'watch-comic':
        case 'watch-hanime': {
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            const watchTitles = {
                watch: '📺 AV在线观看',
                'watch-anime': '🌸 动漫在线观看',
                'watch-comic': '📚 漫画在线观看',
                'watch-hanime': '🔞 里番在线观看'
            };
            updateToolbarTitle(watchTitles[currentView] || '📺 在线观看');
            if (window.Features && window.Features.showWatch) window.Features.showWatch(currentView);
            break;
        }
        case 'poster-health':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('🖼️ 海报健康');
            if (window.Features && window.Features.showPosterHealth) window.Features.showPosterHealth();
            break;
    }
}

// ========== 数据加载 ==========
async function loadMovies(page = 1) {
    currentPage = page;
    const movies = await api.getMovies(currentSort, 'all', 'all', page, currentPageSize);
    renderMovies(movies);
    renderPagination();
    updateToolbarTitle('全部影片', currentTotal);
}

async function loadJavMovies(page = 1) {
    currentPage = page;
    const movies = await api.getMovies(currentSort, 'all', 'jav', page, currentPageSize);
    renderMovies(movies);
    renderPagination();
    updateToolbarTitle('🎥 影片库', currentTotal);
    // 更新导航计数
    const countJavEl = document.getElementById('countJav');
    if (countJavEl) countJavEl.textContent = currentTotal;
}

async function loadFavorites(page = 1) {
    currentPage = page;
    // 第 25 轮：收藏页有自己的筛选 / 排序 / 件数偏好，不再直接吃全局值
    const sort = favPrefs.sort || currentSort;
    const size = favPrefs.pageSize || currentPageSize;
    const type = favPrefs.type || 'all';
    const movies = await api.getMovies(sort, 'favorite', type, page, size);
    currentPageSize = size;

    applyFavLayoutClass();
    if (favPrefs.layout === 'museum') {
        renderMuseum(movies);
    } else {
        // 非珍藏馆布局：走普通卡片网格，但顶部仍保留同一套设置条
        const grid = document.getElementById('movieGrid');
        const emptyTip = document.getElementById('emptyTip');
        grid.classList.remove('tree-mode');
        if (!movies || !movies.length) {
            grid.innerHTML = `<div class="fav-custom-bar-wrap" style="grid-column:1/-1;width:100%;">${renderFavCustomBar()}</div>`;
            bindFavCustomBar();
            emptyTip.style.display = 'block';
        } else {
            emptyTip.style.display = 'none';
            grid.innerHTML = `<div class="fav-custom-bar-wrap" style="grid-column:1/-1;width:100%;">${renderFavCustomBar()}</div>`
                + movies.map(m => renderMovieCard(m)).join('');
            applyAmbientGlow(grid);
            bindFavCustomBar();
            grid.querySelectorAll('.movie-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    const id = parseInt(card.dataset.id);
                    if (e.ctrlKey || e.metaKey) { toggleSelect(id); return; }
                    showMovieDetail(id);
                });
            });
        }
    }
    renderPagination();
    const typeLabel = (favTypes().find(t => t[0] === type) || ['all', '全部类型'])[1];
    updateToolbarTitle(type === 'all' ? '我的收藏' : `我的收藏 · ${typeLabel}`, currentTotal);
}

async function loadActresses() {
    updateToolbarTitle('女优库');
    const actresses = await api.getActresses();
    renderActresses(actresses);
}

async function loadTags() {
    updateToolbarTitle('标签库');
    const tags = await api.getTags();
    renderTagCloud(tags);
}

async function loadHot() {
    updateToolbarTitle('🔥 热门排行');
    // 第 15 轮：48 → 100，榜单行铺满整页
    const movies = await api.getHotMovies(100);
    renderHotRanking(movies);
}

async function loadRandom() {
    updateToolbarTitle('🎲 随机推荐');
    const movies = await api.getRandomMovies(48);
    renderMovies(movies);
}

async function loadGuess() {
    updateToolbarTitle('✨ 猜你喜欢');
    const movies = await api.getGuessMovies(48);
    renderMovies(movies);
}

async function loadUnwatched() {
    updateToolbarTitle('📺 未观看');
    const movies = await api.getUnwatchedMovies(50);
    renderUnwatchedView(movies);
}

async function loadRecent() {
    updateToolbarTitle('🕐 最近观看');
    // 第 15 轮：改按 lastPlayTime 倒序（原来是 playCount），并渲染时间线筛选视图
    const movies = await api.getMovies('lastplay', 'all', 'all', 1, 300);
    renderRecentView(movies);
}

// ========== 详情弹窗 ==========

/**
 * 详情元信息 → 「方块散落堆积」数据
 * ------------------------------------------------------------
 * 设计意图：不是把信息塞进均匀的 grid 挤成一排，而是让每个方块大小不一、
 * 带随机微旋转与错峰入场，像散落下来又堆在一起的一摞卡片。
 *  - color 决定方块顶部的糖果色条（同色系呼应 Aardvark 配色）
 *  - 顺序刻意打乱长/短字段，避免同类宽度挨在一起显得呆板
 */
const META_BLOCK_COLORS = ['#ffdbfd', '#FAED8F', '#DDFCFC', '#CAF7C8', '#fbb663', '#f49978', '#c2b4eb', '#997ade'];

function metaBlocks(movie) {
  const out = [];
  const push = (label, value, wide) => {
    if (value === undefined || value === null || value === '' || value === '-') return;
    out.push({ label, value, wide: !!wide });
  };

  // 有信息的字段优先，按「短-长-中」交错排布，堆积时才有层次
  push('发行日期', movie.releaseDate);
  push('厂商', movie.producer, true);
  push('时长', movie.duration ? formatDuration(movie.duration) : '');
  if (movie.publisher && movie.publisher !== movie.producer) push('发行商', movie.publisher, true);
  push('导演', movie.director);
  push('分辨率', movie.width ? `${movie.width}×${movie.height}` : '');
  push('系列', movie.serial, true);
  push('体积', movie.fileSize ? formatSize(movie.fileSize) : '');
  push('评分', movie.score ? movie.score.toFixed(1) : '');
  push('播放', movie.playCount ? `${movie.playCount} 次` : '');
  push('来源', movie.source && movie.source !== 'local' ? movie.source : '');

  return out.map((b, i) => ({ ...b, color: META_BLOCK_COLORS[i % META_BLOCK_COLORS.length] }));
}

async function showMovieDetail(id) {
    const movie = await api.getMovieDetail(id);
    if (!movie) return;
    
    currentDetailMovie = movie;
    const posterUrl = getPosterUrl(movie);
    const similar = await api.getSimilarMovies(id, 8);
    
    // 计算上一部/下一部
    const currentIndex = currentMovies.findIndex(m => m.id === id);
    const prevMovie = currentIndex > 0 ? currentMovies[currentIndex - 1] : null;
    const nextMovie = currentIndex < currentMovies.length - 1 ? currentMovies[currentIndex + 1] : null;

    // 漫画/小说：同级文件夹内的上一本/下一本
    let bookNav = null;
    if (movie.type === 'comic' || movie.type === 'novel') {
        bookNav = getSiblingNav(movie.type, id);
    }

    const bookNavHtml = bookNav ? `
        <div class="detail-book-nav">
            <button class="btn btn-secondary btn-sm" ${bookNav.prev ? `onclick="showMovieDetail(${bookNav.prev.id})" title="上一本：${escapeHtml(bookNav.prev.title)}"` : 'disabled'}>◀ 上一本</button>
            <span class="detail-book-nav-info">${bookNav.index + 1} / ${bookNav.total}</span>
            <button class="btn btn-secondary btn-sm" ${bookNav.next ? `onclick="showMovieDetail(${bookNav.next.id})" title="下一本：${escapeHtml(bookNav.next.title)}"` : 'disabled'}>下一本 ▶</button>
        </div>
    ` : '';

        const html = `
        <div class="detail-head">
            <div class="detail-poster-wrap">
                <img class="detail-poster${posterUrl ? ' is-zoomable' : ''}" src="${posterUrl || ''}" alt="${escapeHtml(movie.title || '')}"${posterUrl ? ' title="单击放大"' : ''}>
                ${posterUrl ? `<span class="poster-zoom-hint">🔍 单击放大</span>` : ''}
            </div>
            <div class="detail-head-main">
                <div class="detail-title">${movie.title || movie.fileName}</div>
                ${movie.avid ? `<span class="detail-avid">${movie.avid}</span>` : ''}
                <div class="detail-head-meta dm-blocks" id="detailMetaBlocks">
                    ${metaBlocks(movie).map((b, i) => `
                        <div class="dm-block" style="--di:${i};--dc:${b.color}" title="${escapeHtml(b.label)}：${escapeHtml(String(b.value))}">
                            <span class="dm-block-k">${escapeHtml(b.label)}</span>
                            <span class="dm-block-v">${escapeHtml(String(b.value))}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="detail-primary-actions">
                    ${(movie.type === 'comic') ? `
                        <button class="btn btn-primary" onclick="openComicReader(${movie.id})">📖 开始阅读</button>
                    ` : (movie.type === 'novel') ? `
                        <button class="btn btn-primary" onclick="openNovelReader(${movie.id})">📖 开始阅读</button>
                    ` : `
                        <button class="btn btn-primary" onclick="playMovieInline(${movie.id})">▶ 在线播放</button>
                        <button class="btn btn-secondary" onclick="openWithPotPlayer()">🎬 PotPlayer</button>
                    `}
                </div>
            </div>
        </div>

        <div class="detail-scroll">
            ${bookNavHtml}

            <div class="detail-path">
                <span>📄</span><code id="detailFileName">${escapeHtml(movie.fileName || '')}</code>
                <button class="btn btn-sm btn-secondary" onclick="copyText(document.getElementById('detailFileName').textContent)">复制</button>
            </div>

            ${movie.actresses && movie.actresses.length > 0 ? `
            <div class="detail-section">
                <h4>👩 女优（${movie.actresses.length}）</h4>
                <div class="detail-actresses">
                    ${movie.actresses.map(a => `
                        <div class="detail-actress" data-actress-id="${a.id}">
                            <div class="detail-actress-avatar">
                                ${a.avatar ? `<img src="${a.avatar}" alt="${escapeHtml(a.name)}" loading="lazy"
                                    onerror="this.style.display='none';this.parentElement.textContent='${(a.name || '?').charAt(0)}'">`
                                    : (a.name ? a.name.charAt(0) : '?')}
                            </div>
                            <span class="detail-actress-name">${escapeHtml(a.name)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            ` : ''}

            ${movie.tags && movie.tags.length > 0 ? `
            <div class="detail-section">
                <h4>🏷️ 标签 <button class="btn btn-sm btn-secondary" style="float:right;padding:3px 10px;font-size:12px;" onclick="showAddTagModal(${movie.id})">+ 添加</button></h4>
                <div class="detail-tags">
                    ${movie.tags.map((t, i) => `
                        <span class="detail-tag tag-slicer" data-tag-id="${t.id}" data-tag-name="${escapeHtml(t.name)}" title="点击进入「${escapeHtml(t.name)}」筛选结果">
                            <span class="dt-name">${escapeHtml(t.name)}</span>
                            <span class="dt-x" title="删除该标签" onclick="event.stopPropagation();removeTagFromMovie(${movie.id}, ${t.id}, '${t.name}')">×</span>
                        </span>
                    `).join('')}
                </div>
            </div>
            ` : ''}

            ${movie.overview ? `
            <div class="detail-section">
                <h4>📝 简介</h4>
                <div class="detail-overview">${movie.overview}</div>
            </div>
            ` : ''}

            <div class="detail-section">
                <h4>⭐ 我的评分</h4>
                <div class="detail-rating">
                    <div class="stars" id="ratingStars">
                        ${[1,2,3,4,5].map(i => `
                            <span class="star ${i <= Math.round(movie.rating || 0) ? 'active' : ''}" data-rating="${i}">★</span>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div class="detail-section">
                <h4>🛠️ 工具</h4>
                <div class="detail-actions">
                    <button class="dbtn" title="上传封面" aria-label="上传封面" onclick="showUploadPosterModal(${movie.id})">📤</button>
                    <button class="dbtn" title="关系图谱" aria-label="关系图谱" onclick="showRelationGraph(${movie.id})">✨</button>
                    <button class="dbtn" title="${movie.favorite === 1 ? '取消收藏' : '收藏'}" aria-label="收藏" onclick="toggleFav(${movie.id})">${movie.favorite === 1 ? '⭐' : '☆'}</button>
                    <button class="dbtn" title="${movie.watched === 1 ? '标记未看' : '标记已看'}" aria-label="已看标记" onclick="toggleWatch(${movie.id})">${movie.watched === 1 ? '✓' : '○'}</button>
                    <button class="dbtn" title="添加到播放列表" aria-label="播放列表" onclick="addToPlaylist(${movie.id})">📋</button>
                    <button class="dbtn" title="AI 翻译片名" aria-label="AI 翻译" onclick="aiTranslate(${movie.id})">🌐</button>
                    <button class="dbtn" title="AI 生成标签" aria-label="AI 标签" onclick="aiGenerateTags(${movie.id})">🏷️</button>
                    <button class="dbtn" title="重命名文件" aria-label="重命名" onclick="showRenameModal(${movie.id})">✏️</button>
                    <button class="dbtn" title="更换海报" aria-label="更换海报" onclick="showChangePosterModal(${movie.id})">🖼️</button>
                    <button class="dbtn" title="打开所在文件夹" aria-label="打开文件夹" onclick="openMovieFolder(${movie.id})">📁</button>
                    <button class="dbtn" title="重新刮削" aria-label="重新刮削" onclick="rescrapeMovie(${movie.id})">🔄</button>
                    <button class="dbtn danger" title="删除海报" aria-label="删除海报" onclick="deletePoster(${movie.id})">🗑️</button>
                    <button class="dbtn danger" title="删除文件" aria-label="删除文件" onclick="deleteMovie(${movie.id})">🗑️</button>
                </div>
            </div>

            ${similar && similar.length > 0 ? `
            <div class="similar-section">
                <h4 style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--text-muted);margin-bottom:12px;">🎬 相似推荐</h4>
                <div class="similar-grid">
                    ${similar.map(s => `
                        <div class="similar-card" data-similar-id="${s.id}" onclick="showMovieDetail(${s.id})">
                            <img class="similar-poster" src="${getPosterUrl(s)}" alt="${s.title}" loading="lazy">
                            <div class="similar-title">${s.title || s.avid || ''}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
            ` : ''}
        </div>
    `;
document.getElementById('detailBody').innerHTML = html;
    // 右侧抽屉：先 .show（display:flex 就位），下一帧再加 .in 触发滑入过渡
    const dm = document.getElementById('detailModal');
    dm.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => dm.classList.add('in')));
    
    // 漫画/小说：加载该作品的阅读时长
    if (movie.type === 'comic' || movie.type === 'novel') {
        loadMovieReadTime(id, movie.type);
    }

    // 单击海报 → 放大看大图（灯箱）
    const detailPoster = document.querySelector('#detailBody .detail-poster');
    if (detailPoster && posterUrl) {
        detailPoster.addEventListener('click', () => {
            openPosterLightbox(posterUrl, movie.title || movie.avid || movie.fileName || '');
        });
    }
    
    // 绑定评分事件
    document.querySelectorAll('#ratingStars .star').forEach(star => {
        star.addEventListener('click', async () => {
            const rating = parseInt(star.dataset.rating);
            await api.rateMovie(id, rating);
            document.querySelectorAll('#ratingStars .star').forEach((s, i) => {
                s.classList.toggle('active', i < rating);
            });
            showNotification('评分成功', `已给影片打 ${rating} 星`);
        });
    });
    
    // 绑定女优点击
    document.querySelectorAll('.detail-actress').forEach(item => {
        item.addEventListener('click', async () => {
            const actressId = item.dataset.actressId;
            closeModal();
            const movies = await api.getActressMovies(actressId);
            switchView('movies');
            renderMovies(movies);
            updateToolbarTitle('女优作品', movies.length);
        });
    });
    
    // 绑定标签切片器：点击 → 筛选结果页；悬停 → 相关影片海报预览；× → 删除
    document.querySelectorAll('.detail-tag.tag-slicer').forEach(item => {
        item.addEventListener('click', () => {
            openTagById(item.dataset.tagId, item.dataset.tagName || '');
        });
        item.addEventListener('mouseenter', () => showTagSlicerPreview(item));
        item.addEventListener('mouseleave', scheduleHideTagSlicerPreview);
    });
    
    // 绑定相似影片点击
    document.querySelectorAll('.similar-card').forEach(card => {
        card.addEventListener('click', () => {
            const similarId = card.dataset.similarId;
            // 滚动回modal顶部，带平滑动画
            const modalContent = document.querySelector('#detailModal .modal-content');
            if (modalContent) {
                modalContent.scrollTo({
                    top: 0,
                    behavior: 'smooth'
                });
            }
            // 稍微延迟一下，等滚动开始再加载新内容
            setTimeout(() => {
                showMovieDetail(similarId);
            }, 150);
        });
    });
}

function closeModal() {
    const dm = document.getElementById('detailModal');
    // 先滑出，再在过渡结束后隐藏（240ms 与 av-board.css 的抽屉过渡时长对应）
    dm.classList.remove('in');
    setTimeout(() => dm.classList.remove('show'), 240);
}

/* ==========================================================================
   海报灯箱：详情弹窗里单击海报 → 全屏看大图
   - 用 fixed 遮罩（z-index 600，压过 #detailModal 的 520）
   - 关闭按钮自身 z-index 最高，避免被覆盖层挡住（历史踩过的坑）
   - 点遮罩空白 / Esc / 点关闭按钮均可关
   ========================================================================== */
function openPosterLightbox(src, caption) {
    if (!src) return;
    const lb = document.getElementById('posterLightbox');
    const img = document.getElementById('plbImg');
    const cap = document.getElementById('plbCaption');
    if (!lb || !img) return;

    img.src = src;
    if (cap) cap.textContent = caption || '';
    lb.classList.add('show');
    // 下一帧再加 .in，让 scale/opacity 过渡真正跑起来
    requestAnimationFrame(() => requestAnimationFrame(() => lb.classList.add('in')));
}

function closePosterLightbox() {
    const lb = document.getElementById('posterLightbox');
    if (!lb || !lb.classList.contains('show')) return;
    lb.classList.remove('in');
    setTimeout(() => {
        lb.classList.remove('show');
        const img = document.getElementById('plbImg');
        if (img) img.removeAttribute('src');
    }, 260);
}

window.openPosterLightbox = openPosterLightbox;
window.closePosterLightbox = closePosterLightbox;

// 一次性绑定灯箱自身的关闭交互（放在函数定义后，document 已就绪时执行）
(function bindPosterLightbox() {
    const setup = () => {
        const lb = document.getElementById('posterLightbox');
        if (!lb) return;
        const closeBtn = document.getElementById('plbClose');
        if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePosterLightbox(); });
        // 点遮罩空白处关（点图片本身不关）
        lb.addEventListener('click', (e) => { if (e.target === lb) closePosterLightbox(); });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
})();

/* ==========================================================================
   工具按钮：按下回弹 + 删除类按钮的「粉碎」特效
   - 按下：给按钮加 .pressed 跑 squash 动画，动画结束自动摘掉 class
   - 粉碎：把按钮渲染成网格碎片，拍照式的颜色取样 → 碎片向外迸散淡出，
     同时中心扩散一个冲击环。动画纯装饰，**不拦截原 onclick**。
   - prefers-reduced-motion 下直接跳过特效。
   ========================================================================== */
function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function playDbtnPress(btn) {
    if (!btn || prefersReducedMotion()) return;
    btn.classList.remove('pressed');
    // 强制 reflow，保证连续点击也能重启动画
    void btn.offsetWidth;
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 340);
}

// 删除按钮「粉碎」：把按钮按网格切片，每片按径向方向飞散
function playCrushEffect(btn) {
    if (!btn || prefersReducedMotion()) return;
    const rect = btn.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;

    const host = document.createElement('div');
    host.className = 'dbtn-crush-host';
    document.body.appendChild(host);

    // 取按钮当前背景色做碎片基色；danger 用桃红，普通用琥珀
    const isDanger = btn.classList.contains('danger');
    const baseColor = isDanger ? '#ff008c' : '#F9A220';

    const COLS = 7;
    const ROWS = 7;
    const cw = rect.width / COLS;
    const ch = rect.height / ROWS;
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const frag = document.createDocumentFragment();
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const chip = document.createElement('div');
            chip.className = 'crush-chip';
            chip.style.left = (rect.left + c * cw) + 'px';
            chip.style.top = (rect.top + r * ch) + 'px';
            chip.style.width = Math.ceil(cw) + 'px';
            chip.style.height = Math.ceil(ch) + 'px';

            // 从中心出发的径向方向 + 一点随机扰动。
            // 力度刻意收敛（40~100px）：碎片飞太远会冲出抽屉/视口边缘被裁掉，
            // 观感反而像「掉出了页面」。宁可小而完整，也不要大而残缺。
            const px = (c + 0.5) * cw - cx;
            const py = (r + 0.5) * ch - cy;
            const dist = Math.hypot(px, py) || 1;
            const power = 40 + Math.random() * 60;
            chip.style.setProperty('--dx', (px / dist * power + (Math.random() - 0.5) * 34).toFixed(1) + 'px');
            chip.style.setProperty('--dy', (py / dist * power + (Math.random() - 0.5) * 34 - 12).toFixed(1) + 'px');
            chip.style.setProperty('--rot', ((Math.random() - 0.5) * 460).toFixed(0) + 'deg');
            chip.style.setProperty('--crush-dur', (0.62 + Math.random() * 0.34).toFixed(2) + 's');

            // 交替两种色 + 少量透明，做出「碎渣」的杂色感
            const t = (r + c) % 3;
            chip.style.background = t === 0 ? baseColor : (t === 1 ? 'rgba(255,255,255,.85)' : baseColor);
            chip.style.opacity = t === 2 ? '0.72' : '1';
            frag.appendChild(chip);
        }
    }

    // 中心冲击环
    const ring = document.createElement('div');
    ring.className = 'crush-ring';
    const ringSize = Math.max(rect.width, rect.height) * 0.6;
    ring.style.left = (rect.left + cx - ringSize / 2) + 'px';
    ring.style.top = (rect.top + cy - ringSize / 2) + 'px';
    ring.style.width = ringSize + 'px';
    ring.style.height = ringSize + 'px';
    if (!isDanger) ring.style.borderColor = 'rgba(249, 162, 32, .55)';
    frag.appendChild(ring);

    host.appendChild(frag);

    // 碎片飞散期间把原按钮淡化，避免「本体还在 + 碎片飞走」的穿帮
    btn.style.transition = 'opacity .12s linear';
    btn.style.opacity = '.25';
    setTimeout(() => { btn.style.opacity = ''; btn.style.transition = ''; }, 160);

    setTimeout(() => host.remove(), 1100);
}

// 统一接管工具按钮的按下/粉碎
document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.detail-actions .dbtn');
    if (!btn) return;
    playDbtnPress(btn);
    if (btn.classList.contains('danger')) playCrushEffect(btn);
}, true);

// 灯箱 Esc 关闭：挂在 window 捕获阶段，优先于「Esc 关详情弹窗」的既有逻辑
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const lb = document.getElementById('posterLightbox');
    if (lb && lb.classList.contains('show')) {
        e.stopPropagation();
        closePosterLightbox();
    }
}, true);

// 在线播放
async function playMovieInline(id) {
    const movie = await api.getMovieDetail(id);
    if (!movie) return;

    currentPlayerMovie = movie;
    await api.playMovie(id);

    const video = document.getElementById('videoPlayer');
    const videoUrl = `/api/movie/stream?path=${encodeURIComponent(movie.filePath)}`;
    video.src = videoUrl;

    document.getElementById('playerTitle').textContent = movie.title || movie.fileName;
    const av = document.getElementById('playerAvid');
    if (av) av.textContent = movie.avid || '';
    document.getElementById('playerModal').classList.add('show');
    closeModal();

    // 续播：有保存的进度且未看完时自动跳转
    if (window.Features && window.Features.resumeProgress) {
        window.Features.resumeProgress(video, movie.id);
    }

    // 播放进度更新 + 每15秒保存续播点
    let lastSaved = 0;
    video.ontimeupdate = () => {
        const progress = (video.currentTime / video.duration) * 100;
        document.getElementById('playerProgressFill').style.width = progress + '%';
        document.getElementById('playerTime').textContent =
            `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
        if (window.Features && window.Features.saveProgress &&
            Date.now() - lastSaved > 15000 && video.duration > 0) {
            lastSaved = Date.now();
            window.Features.saveProgress(movie.id, video.currentTime, video.duration);
        }
    };

    // 播放结束自动下一部（连播模式）
    video.onended = () => {
        if (window.Features && window.Features.saveProgress) {
            window.Features.saveProgress(movie.id, video.duration, video.duration);
        }
        if (window.currentPlaylist && window.currentPlaylistIndex !== undefined) {
            const nextIndex = window.currentPlaylistIndex + 1;
            if (nextIndex < window.currentPlaylist.length) {
                window.currentPlaylistIndex = nextIndex;
                const nextMovie = window.currentPlaylist[nextIndex];
                showNotification('自动连播', `正在播放：${nextMovie.title || nextMovie.fileName}`);
                playMovieInline(nextMovie.id);
            } else {
                showNotification('播放完成', '播放列表已全部播放完毕');
                window.currentPlaylist = null;
                window.currentPlaylistIndex = null;
            }
        }
    };

    // 点击进度条跳转
    document.getElementById('playerProgress').onclick = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        video.currentTime = percent * video.duration;
    };

    updateStats();
}

// hls.js 实例（m3u8 播放用，关播放器时要销毁）
let hlsInstance = null;

/* ==========================================================================
   内置播放器键盘控制
   --------------------------------------------------------------------------
   需求（2026-09-22）：
     1) 「按一次左右键快进回退的太多了，短一点」
        → 单次步长从原来的 10s 收到 5s（可在 player-seek 设置里改）
     2) 「长按可以倍速」
        → 按住左右键不放：右侧 2x / 3x 加速播放，左侧 0.5x 慢放，
           松开恢复 1x，并在画面上给出 OSD 反馈

   关键实现细节：
   - 浏览器 keydown 会以系统重复速率（约 30Hz）连续触发，不能直接用 e.repeat 判断长按，
     必须自己起定时器：首次 keydown 只记时，超过 LONG_PRESS_MS 才进入长按态。
   - 单次快进/回退必须延迟到"确认不是长按"之后再执行（否则按下去就跳 5s 又立刻倍速，
     手感很怪）。所以短按在 keyup 时结算，长按则取消这次跳转。
   - 左右键同时按住时以最后按下的方向为准。
   ========================================================================== */
const PLAYER_SEEK_STEP = 5;        // 单次左右键步长（秒）—— 用户要求"短一点"
const PLAYER_LONG_PRESS_MS = 380;  // 超过这个时长算长按（进入倍速）
const PLAYER_FAST_RATE = 2.0;      // 长按右键倍速
const PLAYER_FAST_RATE_MAX = 4.0;  // 一直按住可继续升到上限
const PLAYER_SLOW_RATE = 0.5;      // 长按左键慢放

let playerKeyState = {
    bound: false,
    dir: 0,            // -1 左 / 1 右 / 0 无
    timer: null,       // 长按判定定时器
    speedTimer: null,  // 倍速爬升定时器
    isLong: false,     // 已进入长按态
    osdTimer: null,
};

function playerOsd(text, tone) {
    const el = document.getElementById('playerOsd');
    if (!el) return;
    el.textContent = text;
    el.className = 'player-osd show' + (tone ? ' ' + tone : '');
    clearTimeout(playerKeyState.osdTimer);
    // 倍速提示常驻（松手才消失），普通提示 900ms 淡出
    if (tone !== 'rate') {
        playerKeyState.osdTimer = setTimeout(() => el.classList.remove('show'), 900);
    }
}

function resetPlayerSpeed() {
    const video = document.getElementById('videoPlayer');
    if (!video) return;
    video.playbackRate = 1.0;
    clearInterval(playerKeyState.speedTimer);
    playerKeyState.speedTimer = null;
    const el = document.getElementById('playerOsd');
    if (el) el.classList.remove('show');
}

function bindPlayerShortcuts() {
    if (playerKeyState.bound) return;
    playerKeyState.bound = true;

    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('playerModal');
        if (!modal || !modal.classList.contains('show')) return;

        // 焦点在输入框里时不劫持
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();

        const video = document.getElementById('videoPlayer');
        if (!video || !isFinite(video.duration) || video.duration <= 0) return;

        const dir = e.key === 'ArrowRight' ? 1 : -1;

        // 系统重复触发（已经在长按态）：忽略，交给定时器
        if (e.repeat) return;
        // 换方向：先清理上一个方向的状态
        if (playerKeyState.dir !== dir) {
            clearTimeout(playerKeyState.timer);
            resetPlayerSpeed();
            playerKeyState.dir = dir;
            playerKeyState.isLong = false;
        }

        // 起长按判定
        playerKeyState.timer = setTimeout(() => {
            playerKeyState.isLong = true;
            const base = dir > 0 ? PLAYER_FAST_RATE : PLAYER_SLOW_RATE;
            video.playbackRate = base;
            playerOsd((dir > 0 ? '▶▶ ' : '◀◀ ') + base.toFixed(1) + '×', 'rate');

            // 继续按住：右键倍速逐级爬升（2x→3x→4x），左键保持慢放
            if (dir > 0) {
                playerKeyState.speedTimer = setInterval(() => {
                    const next = Math.min(PLAYER_FAST_RATE_MAX, +(video.playbackRate + 0.5).toFixed(1));
                    if (next === video.playbackRate) return;
                    video.playbackRate = next;
                    playerOsd('▶▶ ' + next.toFixed(1) + '×', 'rate');
                }, 900);
            }
            if (video.paused) video.play().catch(() => {});
        }, PLAYER_LONG_PRESS_MS);
    });

    document.addEventListener('keyup', (e) => {
        const modal = document.getElementById('playerModal');
        if (!modal || !modal.classList.contains('show')) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

        const video = document.getElementById('videoPlayer');
        if (!video) return;

        const dir = e.key === 'ArrowRight' ? 1 : -1;
        clearTimeout(playerKeyState.timer);

        if (playerKeyState.isLong) {
            // 长按结束：恢复 1x
            resetPlayerSpeed();
            playerKeyState.isLong = false;
        } else if (playerKeyState.dir === dir && isFinite(video.duration)) {
            // 短按：在 keyup 结算，这样长按不会先跳一段再倍速
            const target = Math.max(0, Math.min(video.duration, video.currentTime + dir * PLAYER_SEEK_STEP));
            video.currentTime = target;
            playerOsd((dir > 0 ? '快进 ' : '回退 ') + PLAYER_SEEK_STEP + 's');
        }
        playerKeyState.dir = 0;
    });

    // 播放器关闭时一定要清干净，否则倍速会带到下一部片
    document.getElementById('closePlayer')?.addEventListener('click', resetPlayerSpeed);
    document.getElementById('playerModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'playerModal') resetPlayerSpeed();
    });
}

function closePlayer() {
    const video = document.getElementById('videoPlayer');
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    video.pause();
    if (typeof resetPlayerSpeed === 'function') resetPlayerSpeed();
    video.removeAttribute('src');
    video.src = '';
    document.getElementById('playerModal').classList.remove('show');
    currentPlayerMovie = null;
}

// 通用视频播放函数（kind='hls' 时用 hls.js 播 m3u8）
function showVideoPlayer(videoUrl, title = '视频播放', kind = '') {
    const video = document.getElementById('videoPlayer');
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    const isHls = kind === 'hls' || /\.m3u8(\?|$)/.test(videoUrl);
    if (isHls && window.Hls && window.Hls.isSupported()) {
        hlsInstance = new window.Hls({ maxBufferLength: 30 });
        hlsInstance.loadSource(videoUrl);
        hlsInstance.attachMedia(video);
    } else {
        video.src = videoUrl;
    }
    
    document.getElementById('playerTitle').textContent = title;
    document.getElementById('playerModal').classList.add('show');
    
    // 播放进度更新
    video.ontimeupdate = () => {
        const progress = (video.currentTime / video.duration) * 100;
        document.getElementById('playerProgressFill').style.width = progress + '%';
        document.getElementById('playerTime').textContent = 
            `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    };
    
    // 点击进度条跳转
    document.getElementById('playerProgress').onclick = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        video.currentTime = percent * video.duration;
    };
}

// 通过自定义协议在宿主机唤起本地应用（PotPlayer / 资源管理器）
// 仅 Docker 部署时走协议（容器内无法直接 spawn）；
// 本地直跑必须走后端 —— 此前本地模式误发协议导致"打开失败"。
let deploymentMode = null;
async function getDeploymentMode() {
    if (deploymentMode) return deploymentMode;
    try {
        const res = await fetch('/api/config/lan-info');
        const data = await res.json();
        deploymentMode = data.data?.deployment || 'local';
    } catch (e) {
        deploymentMode = 'local';
    }
    return deploymentMode;
}

async function launchHostProtocol(proto, hostPath) {
    if (!hostPath) return false;
    if (await getDeploymentMode() !== 'docker') return false;
    try {
        const bytes = new TextEncoder().encode(hostPath);
        let bin = '';
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        window.location.href = `${proto}://open?p=${b64}`;
        return true;
    } catch (e) {
        console.error('launchHostProtocol 失败:', e);
        return false;
    }
}

// 用 PotPlayer 打开
async function openWithPotPlayer(id) {
    let movie = null;
    if (id) {
        movie = currentMovies.find(m => m.id === id) || (currentDetailMovie && currentDetailMovie.id === id ? currentDetailMovie : null);
        if (!movie) {
            try { movie = await api.getMovieDetail(id); } catch (e) {}
        }
    } else {
        // 播放器弹窗内调用：优先当前播放的影片（此前回退到详情弹窗的旧数据，容易"打开失败"）
        movie = currentPlayerMovie || currentDetailMovie;
    }
    if (!movie) {
        showNotification('无法打开', '网盘在线视频没有本地文件，请先下载到本地后播放');
        return;
    }
    // Docker 场景：通过协议在宿主机唤起 PotPlayer
    if (movie.hostPath && await launchHostProtocol('lmlplayer', movie.hostPath)) {
        showNotification('已调起 PotPlayer', '正在用外部播放器打开...');
        return;
    }
    // 本机直跑场景：走后端唤起
    try {
        const res = await fetch(`/api/movie/open-player/${movie.id}`, { method: 'POST' });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('已调起 PotPlayer', '正在用外部播放器打开...');
        } else {
            showNotification('调起失败', data.msg);
        }
    } catch (e) {
        showNotification('调起失败', e.message);
    }
}

// 当前阅读的作品信息（用于父页面上一本下一本切换）
let currentReaderBookId = null;
let currentReaderType = null;

// 构建阅读器 URL（带同级列表参数）
function buildReaderUrl(page, movieId, type) {
    const siblings = findSiblings(type, movieId);
    let url = `/${page}?id=${movieId}`;
    if (siblings.length > 1) {
        url += `&siblings=${encodeURIComponent(JSON.stringify(siblings))}`;
    }
    return url;
}

// 打开漫画阅读器
function openComicReader(movieId) {
    currentReaderBookId = movieId;
    currentReaderType = 'comic';
    const siblings = findSiblings('comic', movieId);
    const cur = siblings.find(s => String(s.id) === String(movieId));
    const movie = currentMovies.find(m => m.id === movieId);
    const title = (cur && cur.title) || (movie && movie.title) || '漫画阅读器';
    document.getElementById('readerTitle').textContent = title;
    document.getElementById('readerFrame').src = buildReaderUrl('comic-reader.html', movieId, 'comic');
    document.getElementById('readerView').classList.add('show');
    document.body.style.overflow = 'hidden';
    updateReaderNavButtons();
    showNotification('已打开漫画阅读器', '点击右上角关闭按钮返回');
}

// 打开小说阅读器
function openNovelReader(movieId) {
    currentReaderBookId = movieId;
    currentReaderType = 'novel';
    const siblings = findSiblings('novel', movieId);
    const cur = siblings.find(s => String(s.id) === String(movieId));
    const movie = currentMovies.find(m => m.id === movieId);
    const title = (cur && cur.title) || (movie && movie.title) || '小说阅读器';
    document.getElementById('readerTitle').textContent = title;
    document.getElementById('readerFrame').src = buildReaderUrl('novel-reader.html', movieId, 'novel');
    document.getElementById('readerView').classList.add('show');
    document.body.style.overflow = 'hidden';
    updateReaderNavButtons();
    showNotification('已打开小说阅读器', '点击右上角关闭按钮返回');
}

// 更新阅读器导航按钮状态
function updateReaderNavButtons() {
    if (!currentReaderBookId || !currentReaderType) return;
    const nav = getSiblingNav(currentReaderType, currentReaderBookId);
    const prevBtn = document.getElementById('readerPrevBtn');
    const nextBtn = document.getElementById('readerNextBtn');
    if (prevBtn) prevBtn.disabled = !nav || !nav.prev;
    if (nextBtn) nextBtn.disabled = !nav || !nav.next;
}

// 切换阅读器的上一本/下一本
function switchReaderBook(direction) {
    if (!currentReaderBookId || !currentReaderType) return;
    const nav = getSiblingNav(currentReaderType, currentReaderBookId);
    if (!nav) return;
    const target = direction === 'prev' ? nav.prev : nav.next;
    if (!target) return;
    
    currentReaderBookId = target.id;
    document.getElementById('readerTitle').textContent = target.title;
    const readerPage = currentReaderType === 'comic' ? 'comic-reader.html' : 'novel-reader.html';
    document.getElementById('readerFrame').src = buildReaderUrl(readerPage, target.id, currentReaderType);
    updateReaderNavButtons();
}

// 关闭阅读器
function closeReader() {
    document.getElementById('readerView').classList.remove('show');
    document.getElementById('readerFrame').src = '';
    document.body.style.overflow = '';
    currentReaderBookId = null;
    currentReaderType = null;
}

// 打开文件所在文件夹
async function openMovieFolder(id) {
    let movie = (currentDetailMovie && currentDetailMovie.id === id) ? currentDetailMovie : currentMovies.find(m => m.id === id);
    if (!movie) {
        try { movie = await api.getMovieDetail(id); } catch (e) {}
    }
    if (!movie) { showNotification('无法打开', '未找到影片'); return; }
    // Docker 场景：通过协议在宿主机打开资源管理器
    if (movie.hostPath && await launchHostProtocol('lmlfolder', movie.hostPath)) {
        showNotification('已打开文件夹', '正在打开文件所在位置...');
        return;
    }
    // 宿主机直跑场景：走后端唤起
    try {
        const res = await fetch(`/api/movie/open-folder/${movie.id}`, { method: 'POST' });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('已打开文件夹', '正在打开文件所在位置...');
        } else {
            showNotification('打开失败', data.msg);
        }
    } catch (e) {
        showNotification('打开失败', e.message);
    }
}

// 显示上传封面弹窗
let currentUploadPosterId = null;
function showUploadPosterModal(id) {
    currentUploadPosterId = id;
    const modal = document.getElementById('uploadPosterModal');
    if (modal) {
        modal.style.display = 'flex';
        // 重置表单
        const preview = document.getElementById('uploadPosterPreview');
        if (preview) preview.src = '';
        const fileInput = document.getElementById('uploadPosterInput');
        if (fileInput) fileInput.value = '';
    }
}

function closeUploadPosterModal() {
    const modal = document.getElementById('uploadPosterModal');
    if (modal) modal.style.display = 'none';
    currentUploadPosterId = null;
}

// 处理封面文件选择
function handlePosterFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // 检查文件类型
    if (!file.type.startsWith('image/')) {
        showNotification('格式错误', '请选择图片文件');
        return;
    }
    
    // 检查文件大小（限制5MB）
    if (file.size > 5 * 1024 * 1024) {
        showNotification('文件过大', '图片大小不能超过5MB');
        return;
    }
    
    // 预览图片
    const reader = new FileReader();
    reader.onload = (event) => {
        const preview = document.getElementById('uploadPosterPreview');
        if (preview) {
            preview.src = event.target.result;
            preview.style.display = 'block';
        }
    };
    reader.readAsDataURL(file);
}

// 从URL预览封面（用后端代理绕过防盗链）
function previewPosterFromUrl() {
    const urlInput = document.getElementById('uploadPosterUrl');
    const preview = document.getElementById('uploadPosterPreview');
    if (!urlInput || !preview) return;
    
    const url = urlInput.value.trim();
    if (!url) {
        showNotification('请输入URL', '请先粘贴图片URL');
        return;
    }
    
    if (!url.startsWith('http')) {
        showNotification('URL格式错误', '请输入有效的图片URL（以http开头）');
        return;
    }
    
    // 用后端代理URL预览，绕过防盗链
    const proxyUrl = `/api/movie/poster/proxy?url=${encodeURIComponent(url)}`;
    preview.src = proxyUrl;
    preview.style.display = 'block';
    preview.onload = () => {
        showNotification('预览成功', '图片已加载，点击确认上传');
    };
    preview.onerror = () => {
        showNotification('加载失败', '无法加载该URL的图片，请检查URL是否正确，或尝试使用剪贴板粘贴');
        preview.style.display = 'none';
    };
}

// 从剪贴板粘贴图片
async function pasteImageFromClipboard() {
    try {
        if (!navigator.clipboard || !navigator.clipboard.read) {
            showNotification('不支持', '当前浏览器不支持剪贴板读取，请使用Ctrl+V快捷键');
            return;
        }

        const items = await navigator.clipboard.read();
        for (const item of items) {
            const imageType = item.types.find(type => type.startsWith('image/'));
            if (imageType) {
                const blob = await item.getType(imageType);
                const reader = new FileReader();
                reader.onload = (e) => {
                    const preview = document.getElementById('uploadPosterPreview');
                    if (preview) {
                        preview.src = e.target.result;
                        preview.style.display = 'block';
                        // 清空URL输入框，标记为剪贴板图片
                        const urlInput = document.getElementById('uploadPosterUrl');
                        if (urlInput) urlInput.value = '';
                        showNotification('粘贴成功', '图片已从剪贴板加载，点击确认上传');
                    }
                };
                reader.readAsDataURL(blob);
                return;
            }
        }
        showNotification('剪贴板无图片', '请先复制一张图片到剪贴板');
    } catch (e) {
        showNotification('粘贴失败', '无法读取剪贴板：' + e.message + '，请尝试Ctrl+V快捷键');
    }
}

// 监听全局paste事件（上传封面弹窗打开时生效）
document.addEventListener('paste', (e) => {
    const modal = document.getElementById('uploadPosterModal');
    if (!modal || modal.style.display !== 'flex') return;
    
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const preview = document.getElementById('uploadPosterPreview');
                    if (preview) {
                        preview.src = ev.target.result;
                        preview.style.display = 'block';
                        const urlInput = document.getElementById('uploadPosterUrl');
                        if (urlInput) urlInput.value = '';
                        showNotification('粘贴成功', '图片已从剪贴板加载，点击确认上传');
                    }
                };
                reader.readAsDataURL(file);
            }
            break;
        }
    }
});

// 确认上传封面
async function confirmUploadPoster() {
    if (!currentUploadPosterId) return;
    
    const preview = document.getElementById('uploadPosterPreview');
    const urlInput = document.getElementById('uploadPosterUrl');
    const imageUrl = urlInput ? urlInput.value.trim() : '';
    
    if (!preview || !preview.src || preview.src === window.location.href) {
        showNotification('请选择图片', '请先选择要上传的封面图片或输入图片URL');
        return;
    }
    
    try {
        showNotification('上传中', '正在上传封面...');
        
        let res;
        if (imageUrl && imageUrl.startsWith('http')) {
            // URL上传：后端下载图片
            res = await fetch(`/api/movie/${currentUploadPosterId}/upload-poster-url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: imageUrl })
            });
        } else {
            // 本地上传：base64数据
            res = await fetch(`/api/movie/${currentUploadPosterId}/upload-poster`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData: preview.src })
            });
        }
        
        // 检查HTTP状态
        if (!res.ok) {
            const text = await res.text();
            console.error('[上传失败] HTTP', res.status, text.substring(0, 500));
            showNotification('上传失败', `HTTP ${res.status}: ${text.substring(0, 100)}`);
            return;
        }
        
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('上传成功', '封面已更新并保存到数据库');
            closeUploadPosterModal();
            // 刷新详情页
            showMovieDetail(currentUploadPosterId);
            // 刷新列表
            if (currentView === 'movies') loadMovies(currentPage);
            else if (currentView === 'anime') loadAnime(currentPage);
            else if (currentView === 'comic') loadComic(currentPage);
            else if (currentView === 'novel') loadNovel(currentPage);
            else if (currentView === 'jav') loadJavMovies(currentPage);
        } else {
            showNotification('上传失败', data.msg);
        }
    } catch (e) {
        showNotification('上传失败', e.message);
    }
}

// 切换收藏
async function toggleFav(id) {
    await api.toggleFavorite(id);
    showMovieDetail(id);
    updateStats();
    showNotification('收藏成功', '影片收藏状态已更新');
}

// 切换已看
async function toggleWatch(id) {
    await api.toggleWatched(id);
    showMovieDetail(id);
    updateStats();
    showNotification('状态更新', '观看状态已更新');
}

// ========== 批量操作 ==========
function toggleSelect(id) {
    if (selectedMovies.has(id)) {
        selectedMovies.delete(id);
    } else {
        selectedMovies.add(id);
    }
    updateBatchToolbar();
    // 重新渲染当前列表
    if (currentView === 'movies' || currentView === 'favorites' || 
        currentView === 'hot' || currentView === 'random' ||
        currentView === 'guess' || currentView === 'unwatched' ||
        currentView === 'recent') {
        renderMovies(currentMovies);
    }
}

function updateBatchToolbar() {
    const toolbar = document.getElementById('batchToolbar');
    document.getElementById('batchCount').textContent = `已选 ${selectedMovies.size} 部`;
    
    if (selectedMovies.size > 0) {
        toolbar.classList.add('show');
    } else {
        toolbar.classList.remove('show');
    }
}

function clearSelection() {
    selectedMovies.clear();
    updateBatchToolbar();
    renderMovies(currentMovies);
}

async function batchAction(action) {
    if (selectedMovies.size === 0) return;
    
    const ids = Array.from(selectedMovies);
    for (const id of ids) {
        if (action === 'favorite') {
            await api.toggleFavorite(id);
        } else if (action === 'watched') {
            await api.toggleWatched(id);
        }
    }
    
    showNotification('批量操作完成', `已处理 ${ids.length} 部影片`);
    clearSelection();
    updateStats();
    
    // 原地刷新当前列表（保持页码与视窗位置）
    refreshCurrentList();
}

// ========== 深色模式 ==========
function toggleTheme() {
    const body = document.body;
    const btn = document.getElementById('themeToggle');
    
    if (body.classList.contains('dark')) {
        body.classList.remove('dark');
        btn.textContent = '🌙';
        localStorage.setItem('theme', 'light');
    } else {
        body.classList.add('dark');
        btn.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
    }
}

function initTheme() {
    // 读取主题风格
    const savedThemeStyle = localStorage.getItem('themeStyle') || 'ios';
    document.body.setAttribute('data-theme', savedThemeStyle);

    // 详情呈现方式（右侧抽屉 / 居中弹窗）—— 越早打上越好，避免首帧闪一下
    applyDetailMode(getDetailMode());

    // V4 皮肤（Classic / Aurora / Ambient）
    if (typeof initV4Skin === 'function') initV4Skin();
    
    // 读取深色模式
    const savedDarkMode = localStorage.getItem('darkMode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    if (savedDarkMode === 'true' || (!savedDarkMode && prefersDark)) {
        document.body.classList.add('dark');
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) themeToggle.textContent = '☀️';
    }
}

// ========== 主题切换相关函数 ==========

// 获取当前主题风格
function getCurrentTheme() {
    return document.body.getAttribute('data-theme') || 'ios';
}

// 切换主题风格
function switchThemeStyle(theme) {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('themeStyle', theme);
    
    // 更新设置页面的主题卡片选中状态
    const themeCards = document.querySelectorAll('.theme-card');
    if (themeCards.length > 0) {
        const themes = ['ios', 'stylekit', 'shader'];
        themeCards.forEach((card, index) => {
            if (themes[index] === theme) {
                card.style.borderColor = 'var(--primary)';
            } else {
                card.style.borderColor = 'var(--border)';
            }
        });
    }
    
    showNotification('主题已切换', `已切换到${theme === 'ios' ? 'iOS风格' : theme === 'stylekit' ? 'StyleKit' : 'Shader渐变'}主题`);
}

// 判断是否是深色模式
function isDarkMode() {
    return document.body.classList.contains('dark');
}

// 切换深色模式
function toggleDarkMode() {
    const body = document.body;
    const btn = document.getElementById('themeToggle');
    const darkBtn = document.getElementById('darkModeToggle');

    if (body.classList.contains('dark')) {
        body.classList.remove('dark');
        if (btn) btn.textContent = '🌙';
        if (darkBtn) darkBtn.textContent = '🌙 深色';
        localStorage.setItem('darkMode', 'false');
    } else {
        body.classList.add('dark');
        if (btn) btn.textContent = '☀️';
        if (darkBtn) darkBtn.textContent = '☀️ 浅色';
        localStorage.setItem('darkMode', 'true');
    }
}

// ========== V4 皮肤（Classic / Aurora / Ambient）==========
// 2026-09-21：设计师给的 V4.1 AURORA 与 V4.4 AMBIENT 两稿，做成首页右上角的风格切换。
//   classic = 现在的 Aardvark 白底纸感（默认，theme-v4.css 不参与）
//   aurora  = 深蓝紫 + 漂移极光背景场 + 玻璃卡片 + 卡片扫光
//   ambient = 中性炭黑 + 卡片环境光溢出 + 3D 微倾斜
// 实现：给 <html> 打 data-v4skin，皮肤规则全部写在 theme-v4.css。

var V4_SKIN_KEY = 'v4Skin';
var V4_SKINS = ['classic', 'aurora', 'ambient'];
var V4_SKIN_NAMES = { classic: '经典 · Aardvark', aurora: 'V4.1 · 极光 AURORA', ambient: 'V4.4 · 暮色 AMBIENT' };

function getV4Skin() {
    try {
        var v = localStorage.getItem(V4_SKIN_KEY);
        return V4_SKINS.indexOf(v) >= 0 ? v : 'classic';
    } catch (e) {
        return 'classic';
    }
}

/* AMBIENT 的签名是"每张卡片用自己海报的主色溢出成环境光"。
   没有取色能力，就用海报 URL 做稳定哈希映射到一组预设主色 —— 同一张海报
   每次拿到的颜色都一样，且不同海报颜色不同，视觉上足够"各是各的"。 */
var AMBIENT_GLOWS = [
    'rgba(62,111,163,.5)', 'rgba(200,107,168,.5)', 'rgba(87,163,131,.5)',
    'rgba(212,168,107,.5)', 'rgba(123,140,201,.5)', 'rgba(212,154,138,.5)',
    'rgba(148,201,201,.5)', 'rgba(204,138,158,.5)'
];
function ambientGlowFor(seed) {
    var s = String(seed || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
    return AMBIENT_GLOWS[h % AMBIENT_GLOWS.length];
}

/* 给当前网格里每张卡写入 --glow（只在 ambient 皮肤下有意义，写入成本极低） */
function applyAmbientGlow(root) {
    if (getV4Skin() !== 'ambient') return;
    var scope = root || document;
    scope.querySelectorAll('.movie-card, .movie-card-compact').forEach(function (card) {
        if (card.dataset.amGlowDone) return;
        var img = card.querySelector('img');
        var seed = (img && (img.getAttribute('src') || '')) || card.getAttribute('data-id') || card.textContent || '';
        card.style.setProperty('--glow', ambientGlowFor(seed));
        card.dataset.amGlowDone = '1';
    });
}

function applyV4Skin(skin) {
    if (V4_SKINS.indexOf(skin) < 0) skin = 'classic';
    document.documentElement.setAttribute('data-v4skin', skin);

    // 同步切换器选中态
    document.querySelectorAll('.v4-skin-btn').forEach(function (btn) {
        var on = btn.dataset.skin === skin;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    // ambient 需要给卡片写 --glow
    if (skin === 'ambient') {
        applyAmbientGlow(document);
        // 网格是异步渲染的，稍后再补一次
        setTimeout(function () { applyAmbientGlow(document); }, 600);
    }
}

function setV4Skin(skin) {
    if (V4_SKINS.indexOf(skin) < 0) return;
    try { localStorage.setItem(V4_SKIN_KEY, skin); } catch (e) { /* 隐私模式忽略 */ }
    applyV4Skin(skin);
    if (typeof showNotification === 'function') {
        showNotification('风格已切换', V4_SKIN_NAMES[skin] || skin);
    }
}

function initV4Skin() {
    applyV4Skin(getV4Skin());
}

// ========== 详情呈现方式（右侧抽屉 / 居中弹窗） ==========
// 2026-09-21：用户要求可在设置里切换「点击海报后」的呈现方式。
//   drawer = 右侧滑出抽屉（默认）      modal = 改动之前的居中大弹窗
// 实现：给 <html> 打 data-detail-mode，由 detail-mode.css 负责两套布局；
//      同时把偏好写进 localStorage，刷新后保持。

var DETAIL_MODE_KEY = 'detailMode';
var DETAIL_MODE_DEFAULT = 'drawer';

function getDetailMode() {
    try {
        var v = localStorage.getItem(DETAIL_MODE_KEY);
        return (v === 'modal' || v === 'drawer') ? v : DETAIL_MODE_DEFAULT;
    } catch (e) {
        return DETAIL_MODE_DEFAULT;
    }
}

function applyDetailMode(mode) {
    document.documentElement.setAttribute('data-detail-mode', mode);
}

function setDetailMode(mode) {
    if (mode !== 'modal' && mode !== 'drawer') return;
    try { localStorage.setItem(DETAIL_MODE_KEY, mode); } catch (e) { /* 隐私模式下忽略 */ }
    applyDetailMode(mode);

    // 同步设置页卡片选中态
    document.querySelectorAll('.detail-mode-card').forEach(function (card) {
        card.classList.toggle('active', card.dataset.detailMode === mode);
    });

    if (typeof showNotification === 'function') {
        showNotification('已切换', mode === 'drawer' ? '点击海报从右侧滑出抽屉' : '点击海报弹出居中弹窗');
    }
}

// ========== 推送配置 & 修改密码 ==========
async function savePushConfig() {
    try {
        const cfg = {
            push: {
                barkUrl: document.getElementById('pushBarkUrl').value.trim(),
                tgBotToken: document.getElementById('pushTgToken').value.trim(),
                tgChatId: document.getElementById('pushTgChatId').value.trim()
            }
        };
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg)
        });
        const data = await res.json();
        showNotification(data.code === 0 ? '已保存' : '保存失败', data.code === 0 ? '推送配置已更新，重启服务后生效' : data.msg);
    } catch (e) {
        showNotification('保存失败', e.message);
    }
}

/* ========== 访问密码（可选开关） ==========
 * 用户自己决定「进入影库要不要密码」。
 * 开 = 四个库（影片/动漫/漫画/小说）统一要先登录；关 = 全部免密。
 * 之所以必须统一：library.html 是一体式界面，所有数据都走 /api/*，
 * 若一部分要登录一部分免密，免密进去的那个会变成「半死界面」——
 * 计数全 0、点设置一片空白。详见 docs/reports/round22-需求达成报告.md
 */
function refreshAuthTip() {
    const tip = document.getElementById('authStateTip');
    const chk = document.getElementById('authEnabled');
    if (!tip || !chk) return;
    const hasPwd = tip.dataset.hasPwd === '1';
    tip.innerHTML = chk.checked
        ? (hasPwd
            ? '已开启：进入影库（含手机端）需要先输入密码。<br>忘记密码时，可在数据目录的 config.json 里删除 auth 段，重启后即变为免密。'
            : '填一个至少 4 位的密码再保存，立即生效。')
        : '当前<b>不设密码</b>：同一局域网内的任何人都能直接打开影库。自己家里用可以保持关闭；<b>一旦把本机端口暴露到公网，请务必开启</b>。';
}

function onAuthToggle() {
    const chk = document.getElementById('authEnabled');
    const fields = document.getElementById('authFields');
    if (fields && chk) fields.style.display = chk.checked ? 'block' : 'none';
    syncAuthCurrentField();
    refreshAuthTip();
}

/** 「当前密码」框只在「已勾选开启 且 本来就设过密码」时才出现 —— 那才是需要二次确认的场景 */
function syncAuthCurrentField() {
    const chk = document.getElementById('authEnabled');
    const tip = document.getElementById('authStateTip');
    const wrap = document.getElementById('authCurrentWrap');
    if (!wrap) return;
    const on = !!(chk && chk.checked);
    const hasPwd = !!(tip && tip.dataset.hasPwd === '1');
    wrap.style.display = (on && hasPwd) ? 'block' : 'none';
}

async function saveAuthSettings() {
    const chk = document.getElementById('authEnabled');
    const tip = document.getElementById('authStateTip');
    if (!chk) return;
    const on = !!chk.checked;
    const p1 = (document.getElementById('authPassword') || { value: '' }).value;
    const p2 = (document.getElementById('authPassword2') || { value: '' }).value;
    const cur = (document.getElementById('authCurrent') || { value: '' }).value;
    const hasPwd = tip ? tip.dataset.hasPwd === '1' : false;

    if (on) {
        if (!p1 && !hasPwd) { showNotification('请设置密码', '开启访问密码需要先填一个至少 4 位的密码'); return; }
        if (p1 && p1.length < 4) { showNotification('密码太短', '至少 4 位'); return; }
        if (p1 && p1 !== p2) { showNotification('两次输入不一致', '请重新确认密码'); return; }
    }
    /* 已启用密码 → 换密码 / 关密码都要先验当前密码（防止他人趁你已登录时把密码直接关掉） */
    if (hasPwd && !cur) {
        showNotification('请输入当前密码', '为确认是本人操作，修改或关闭密码前需要输入当前正在使用的密码');
        return;
    }

    try {
        const res = await fetch('/api/auth/access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(on
                ? { enabled: true, password: p1, currentPassword: cur }
                : { enabled: false, currentPassword: cur })
        });
        const data = await res.json();
        if (data.code !== 0) { showNotification('保存失败', data.msg || '未知错误'); return; }

        const a = document.getElementById('authPassword');
        const b = document.getElementById('authPassword2');
        const c = document.getElementById('authCurrent');
        if (a) a.value = '';
        if (b) b.value = '';
        if (c) c.value = '';
        /* ★ 就地更新状态，**不重拉整页配置**。
         * 重拉会踩到一个很坑的时序：刚开启密码的那一瞬间，本页还没有会话，
         * 紧接着的 /api/config 必然 401 → 设置页会被换成「加载失败」，
         * 用户会以为自己的设置被弄坏了。（后端现已顺带签发会话，这里是双保险，
         * 也顺便避开了整页重绘的闪烁。） */
        if (tip) tip.dataset.hasPwd = on ? '1' : '0';
        const lbl = document.getElementById('authPasswordLabel');
        if (lbl) lbl.textContent = on ? '新密码（留空表示不改）' : '设置密码（至少 4 位）';
        if (a) a.placeholder = on ? '留空则沿用当前密码' : '至少 4 位';
        refreshAuthTip();
        syncAuthCurrentField();
        showNotification(
            on ? '已开启访问密码' : '已关闭访问密码',
            on ? '下次打开影库需要输入新密码（本机这次不用重新登录）' : '现在进入影库不再需要密码'
        );
    } catch (e) {
        showNotification('保存失败', e.message);
    }
}

/** 旧入口保留：等价于「开启并设置新密码」（兼容可能残留的旧页面缓存） */
async function changePassword() {
    const oldPassword = document.getElementById('oldPassword');
    const newPassword = document.getElementById('newPassword');
    if (!oldPassword || !newPassword) return saveAuthSettings();
    if (!newPassword.value) { showNotification('请填写完整', '需要新口令'); return; }
    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value })
        });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('口令已修改', '请牢记新口令，本机会话仍然有效');
            oldPassword.value = '';
            newPassword.value = '';
        } else {
            showNotification('修改失败', data.msg);
        }
    } catch (e) {
        showNotification('修改失败', e.message);
    }
}

// ========== 扫描状态 ==========
async function checkScanStatus() {
    try {
        const status = await api.getScanStatus(currentScanModule);
        const btn = document.getElementById('scanBtn');
        const statusEl = document.getElementById('scanStatus');
        const progressBar = document.getElementById('scanProgressBar');
        
        if (status.running) {
            btn.textContent = '扫描中...';
            btn.disabled = true;
            const percent = status.total > 0 ? (status.current / status.total * 100) : 0;
            progressBar.style.width = percent + '%';
            const stats = status.stats || {};
            statusEl.textContent = `${status.current}/${status.total} | 本地:${stats.localHit||0} 网络:${stats.webScraped||0} 失败:${stats.failed||0}`;
        } else {
            btn.textContent = '开始扫描';
            btn.disabled = false;
            const stats = status.stats || {};
            const seen = stats.localHit || stats.webScraped || stats.failed || stats.skipped || stats.added || stats.removed;
            if (!seen) {
                statusEl.textContent = '';
                progressBar.style.width = '0%';
                return;
            }
            // 扫描结束后保留最终结果，别把状态清空（用户要看的就是这个）
            progressBar.style.width = '100%';
            const parts = [];
            if (stats.added != null) parts.push(`新增 ${stats.added}`);
            if (stats.removed != null) parts.push(`移除 ${stats.removed}`);
            parts.push(`本地命中 ${stats.localHit||0}`, `网络刮削 ${stats.webScraped||0}`, `失败 ${stats.failed||0}`);
            if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
            if (status.unreadableDirs && status.unreadableDirs.length) parts.push(`不可读目录 ${status.unreadableDirs.length}`);
            statusEl.innerHTML = escapeHtml(`上次扫描 ${parts.join(' · ')}`);
            if (stats.failed > 0) {
                const a = document.createElement('a');
                a.href = '#';
                a.textContent = ' 查看失败清单';
                a.style.color = 'var(--primary)';
                a.onclick = (ev) => { ev.preventDefault(); switchView('scrape-failures'); };
                statusEl.appendChild(a);
            }
        }
    } catch (e) {}
}

// 按模块启动扫描
async function startModuleScan(module) {
    const moduleNames = {
        movie: '影片',
        anime: '动漫',
        comic: '漫画',
        novel: '小说'
    };
    
    try {
        const res = await fetch(`/api/scanner/${module}`, { method: 'POST' });
        const data = await res.json();
        
        if (data.code === 0) {
            currentScanModule = module;
            showNotification(`${moduleNames[module]}扫描已启动`);
            // 开始检查扫描状态
            if (!scanStatusTimer) {
                scanStatusTimer = setInterval(checkScanStatus, 2000);
            }
        } else {
            showNotification('启动失败: ' + data.msg, 'error');
        }
    } catch (e) {
        showNotification('启动失败: ' + e.message, 'error');
    }
}

// ========== 搜索 ==========
let searchTimeout = null;
function handleSearch(e) {
    const q = e.target.value.trim();
    clearTimeout(searchTimeout);
    
    if (!q) {
        currentSearchQuery = '';
        // 清空搜索词：原地刷新当前列表，保持页码与视窗位置
        refreshCurrentList();
        return;
    }
    
    currentSearchQuery = q;
    searchTimeout = setTimeout(async () => {
        const movies = await api.searchMovies(q);
        document.getElementById('movieGrid').style.display = 'grid';
        document.getElementById('actressGrid').style.display = 'none';
        document.getElementById('tagCloud').style.display = 'none';
        hideGallery();
        renderMovies(movies);
        updateToolbarTitle(`搜索: ${q}`, movies.length);
    }, 300);
}

// ========== 初始化 ==========
function bindEvents() {
    // 导航点击
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            if (view) switchView(view);
        });
    });
    
    // 排序选择
    document.getElementById('sortSelect').addEventListener('change', (e) => {
        currentSort = e.target.value;
        refreshCurrentList();
    });
    
    // 搜索
    document.getElementById('searchInput').addEventListener('input', handleSearch);
    
    // 扫描按钮
    document.getElementById('scanBtn').addEventListener('click', async () => {
        try {
            const res = await fetch('/api/scanner/start', { method: 'POST' });
            const data = await res.json();
            if (data.code === 0) {
                showNotification('扫描开始', '正在扫描影片库...');
                currentScanModule = 'movie';
                // 立刻刷一次并开始轮询，否则前端看不到进度和最终结果
                if (typeof checkScanStatus === 'function') checkScanStatus();
                if (!scanStatusTimer) scanStatusTimer = setInterval(checkScanStatus, 2000);
            } else {
                showNotification('无法开始扫描', data.msg || '未知错误');
            }
        } catch (e) {
            showNotification('无法开始扫描', e.message);
        }
    });

    // 通知按钮
    const notificationBtn = document.getElementById('notificationBtn');
    if (notificationBtn) {
        notificationBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleNotificationPanel();
        });
    }
    
    // 点击外部关闭通知面板
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('notificationPanel');
        const btn = document.getElementById('notificationBtn');
        if (panel && panel.classList.contains('show')) {
            if (!panel.contains(e.target) && !btn.contains(e.target)) {
                panel.classList.remove('show');
            }
        }
    });
    
    // 关闭详情弹窗
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('detailModal').addEventListener('click', (e) => {
        if (e.target.id === 'detailModal') closeModal();
    });
    // Esc 关闭详情抽屉（抽屉打开时优先于其他 Esc 行为生效）
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('detailModal').classList.contains('show')) closeModal();
    });
    
    // 关闭播放器
    document.getElementById('closePlayer').addEventListener('click', closePlayer);
    document.getElementById('playerModal').addEventListener('click', (e) => {
        if (e.target.id === 'playerModal') closePlayer();
    });
    bindPlayerShortcuts();
    
    // PotPlayer 按钮（播放器弹窗内：明确传当前播放影片的 id）
    document.getElementById('openPotPlayer').addEventListener('click', () => {
        openWithPotPlayer(currentPlayerMovie ? currentPlayerMovie.id : undefined);
    });
    
    // 主题切换
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
}

function init() {
    // 鉴权已由服务端会话接管（未登录访问 jav/anime 库会被重定向到 login.html），
    // 旧的前端密码弹窗流程已移除。

    initTheme();
    bindEvents();
    loadFavPrefs();   // 第 25 轮：我的收藏个性化偏好（类型/排序/件数/摆放）

    // 监听阅读器iframe的关闭消息
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'closeReader') {
            closeReader();
        }
    });

    // 读取URL参数，判断是否需要切换到指定模块
    const urlParams = new URLSearchParams(window.location.search);
    const typeParam = urlParams.get('type');

    if (typeParam && ['jav', 'anime', 'comic', 'novel'].includes(typeParam)) {
        // 从欢迎页点击对应模块进入，直接切换到该模块
        switchView(typeParam);
    } else {
        // 默认进入全部影片
        initGallery();
        loadMovies();
    }

    updateStats();
    checkScanStatus();
    loadNotifications();

    // 加载续播进度表（卡片齿孔进度条用）
    if (window.Features && window.Features.loadProgressMap) {
        window.Features.loadProgressMap();
    }
    // 加载刮削失败计数（侧栏角标）
    if (window.Features && window.Features.loadFailureCount) {
        window.Features.loadFailureCount();
    }

    // 定时更新扫描状态
    scanTimer = setInterval(checkScanStatus, 1500);

    // 定时更新通知
    setInterval(loadNotifications, 60000);

    // 扫描中每10秒刷新列表（保持页码与视窗位置）
    setInterval(async () => {
        try {
            const status = await api.getScanStatus();
            if (status.running && (currentView === 'movies' || currentView === 'jav')) {
                refreshCurrentList();
                updateStats();
            }
        } catch (e) {}
    }, 10000);
}

// ========== 女优头像批量刮削 ==========
let avatarScrapePoll = null;

async function startAvatarScrape(all = false) {
    const btn = document.getElementById('avatarScrapeBtn');
    const stat = document.getElementById('avatarScrapeStat');
    const barWrap = document.getElementById('avatarScrapeBarWrap');
    const bar = document.getElementById('avatarScrapeBar');

    try {
        const res = await fetch('/api/actress/scrape-avatars', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: !!all })
        });
        const data = await res.json();
        if (data.code !== 0) {
            showNotification('无法启动', data.msg || '未知错误');
            return;
        }
        showNotification('已开始', '女优头像正在后台刮削');
        btn.disabled = true;
        btn.textContent = '⏳ 刮削中…';
        if (barWrap) barWrap.style.display = 'block';

        clearInterval(avatarScrapePoll);
        avatarScrapePoll = setInterval(async () => {
            try {
                const r = await fetch('/api/actress/avatar-stats');
                const d = (await r.json()).data || {};
                const p = d.progress || {};
                if (stat) stat.textContent = `${p.done || 0}/${p.total || 0} · 成功 ${p.ok || 0} · 失败 ${p.fail || 0}`;
                if (bar && p.total) bar.style.width = Math.round((p.done / p.total) * 100) + '%';
                if (!d.running) {
                    clearInterval(avatarScrapePoll);
                    avatarScrapePoll = null;
                    btn.disabled = false;
                    btn.textContent = '✨ 开始刮削女优头像';
                    if (stat) stat.textContent = `完成 · 已有头像 ${d.withAvatar}/${d.total}`;
                    showNotification('刮削完成', `女优头像：${d.withAvatar}/${d.total}（${Math.round(d.withAvatar / (d.total || 1) * 100)}%）`);
                    // 若当前正在看演员库，刷新一下让头像显示出来
                    if (document.getElementById('actressGrid')?.offsetParent) {
                        const list = await (await fetch('/api/actress')).json();
                        if (list.data) renderActresses(list.data);
                    }
                }
            } catch (e) { /* 轮询失败忽略 */ }
        }, 2000);
    } catch (e) {
        showNotification('启动失败', e.message);
    }
}

// 打开设置页时同步一次头像覆盖率
async function refreshAvatarStats() {
    try {
        const d = (await (await fetch('/api/actress/avatar-stats')).json()).data || {};
        const stat = document.getElementById('avatarScrapeStat');
        if (stat && !avatarScrapePoll) {
            stat.textContent = d.running ? '刮削进行中…' : `已有头像 ${d.withAvatar}/${d.total}`;
        }
    } catch (e) {}
}

// ========== 手动重新刮削 ==========
// （旧的前端密码验证流程已删除：鉴权由服务端会话接管）
async function rescrapeMovie(id) {
    try {
        const res = await fetch(`/api/movie/rescrape/${id}`, { method: 'POST' });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('重新刮削', '已开始重新刮削，完成后自动刷新');
            closeModal();
            // 5秒后原地刷新（保持页码与视窗位置）
            setTimeout(() => {
                refreshCurrentList();
            }, 5000);
        }
    } catch (e) {
        showNotification('错误', '重新刮削失败');
    }
}

// ========== 删除海报 ==========
async function deletePoster(id) {
    if (!confirm('确定要删除这张海报吗？删除后将显示无封面状态。')) return;
    
    try {
        const res = await fetch(`/api/movie/${id}/delete-poster`, { method: 'POST' });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('删除成功', '海报已删除');
            // 刷新详情页
            showMovieDetail(id);
            // 原地刷新列表（保持页码与视窗位置）
            setTimeout(() => {
                refreshCurrentList();
            }, 500);
        } else {
            showNotification('删除失败', data.msg || '未知错误');
        }
    } catch (e) {
        showNotification('错误', '删除海报失败');
    }
}

// ========== 重命名文件 ==========
function showRenameModal(id) {
    const movie = (currentDetailMovie && currentDetailMovie.id === id) ? currentDetailMovie : currentMovies.find(m => m.id === id);
    if (!movie) return;
    
    // 去掉扩展名
    const nameWithoutExt = movie.fileName.replace(/\.[^.]+$/, '');
    
    const html = `
        <div style="padding: 24px;">
            <h3 style="margin-bottom:20px;font-size:18px;">✏️ 重命名文件</h3>
            <div style="margin-bottom:16px;">
                <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">新文件名（不含扩展名）</label>
                <input type="text" id="renameInput" class="select-input" style="width:100%;height:40px;" value="${nameWithoutExt}">
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:20px;padding:10px;background:var(--bg);border-radius:8px;">
                ⚠️ 将同时重命名视频文件、NFO 文件和封面文件
            </div>
            <div style="display:flex;gap:12px;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn" onclick="doRename(${id})">确认重命名</button>
            </div>
        </div>
    `;
    
    document.getElementById('detailBody').innerHTML = html;
    setTimeout(() => {
        const input = document.getElementById('renameInput');
        if (input) {
            input.focus();
            input.select();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') doRename(id);
            });
        }
    }, 100);
}

async function doRename(id) {
    const newName = document.getElementById("renameInput").value.trim();
    if (!newName) {
        showNotification("错误", "文件名不能为空");
        return;
    }
    try {
        const res = await fetch(`/api/movie/${id}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName })
        });
        const data = await res.json();
        if (data.code === 0) {
            showNotification("重命名完成");
            showMovieDetail(id); //刷新详情面板
            // 根据当前视图刷新对应列表
            switch (currentView) {
                case 'anime':
                    loadAnime(currentPage);
                    break;
                case 'comic':
                    loadComic(currentPage);
                    break;
                case 'novel':
                    loadNovel(currentPage);
                    break;
                case 'jav':
                    loadJavMovies(currentPage);
                    break;
                default:
                    loadMovies(currentPage);
                    break;
            }
        } else {
            showNotification("失败：" + data.msg);
        }
    } catch (err) {
        showNotification("请求异常：" + err.message);
    }
}

// ========== 删除文件 ==========
async function deleteMovie(id) {
    const movie = currentMovies.find(m => m.id === id);
    if (!movie) return;
    
    if (!confirm(`确定要删除文件「${movie.fileName}」吗？\n\n此操作将从磁盘删除视频文件、NFO 和封面，无法恢复！`)) {
        return;
    }
    
    try {
        const res = await fetch(`/api/movie/${id}`, { method: 'DELETE' });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('删除成功', '文件已删除');
            closeModal();
            refreshCurrentList();
            updateStats();
        } else {
            showNotification('删除失败', data.msg);
        }
    } catch (e) {
        showNotification('删除失败', e.message);
    }
}

// ========== 标签管理 ==========
function showAddTagModal(movieId) {
    const html = `
        <div style="padding: 24px;">
            <h3 style="margin-bottom:20px;font-size:18px;">🏷️ 添加标签</h3>
            <div style="margin-bottom:16px;">
                <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">标签名称</label>
                <input type="text" id="addTagInput" class="select-input" style="width:100%;height:40px;" placeholder="输入标签名称">
            </div>
            <div style="display:flex;gap:12px;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeModal()">取消</button>
                <button class="btn" onclick="doAddTag(${movieId})">添加</button>
            </div>
        </div>
    `;
    
    document.getElementById('detailBody').innerHTML = html;
    setTimeout(() => {
        const input = document.getElementById('addTagInput');
        if (input) {
            input.focus();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') doAddTag(movieId);
            });
        }
    }, 100);
}

async function doAddTag(movieId) {
    const tagName = document.getElementById('addTagInput').value.trim();
    if (!tagName) {
        showNotification('错误', '标签名称不能为空');
        return;
    }
    
    try {
        const res = await fetch(`/api/movie/${movieId}/add-tag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tagName })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('添加成功', `标签「${tagName}」已添加`);
            // 重新打开详情页
            showMovieDetail(movieId);
        } else {
            showNotification('添加失败', data.msg);
        }
    } catch (e) {
        showNotification('添加失败', e.message);
    }
}

async function removeTagFromMovie(movieId, tagId, tagName) {
    if (!confirm(`确定要移除标签「${tagName}」吗？`)) return;
    
    try {
        const res = await fetch(`/api/movie/${movieId}/remove-tag`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tagId })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('已移除', `标签「${tagName}」已移除`);
            // 重新打开详情页
            showMovieDetail(movieId);
        } else {
            showNotification('移除失败', data.msg);
        }
    } catch (e) {
        showNotification('移除失败', e.message);
    }
}

// ========== 通知中心 ==========
let notifications = [];

async function loadNotifications() {
    try {
        const res = await fetch('/api/notification');
        const data = await res.json();
        if (data.code === 0) {
            notifications = data.data.list || [];
            updateNotificationBadge(data.data.unreadCount || 0);
            renderNotifications();
        }
    } catch (e) {}
}

async function updateNotificationBadge(count) {
    const badge = document.getElementById('notificationBadge');
    if (!badge) return;
    
    if (count > 0) {
        badge.style.display = 'flex';
        badge.textContent = count > 99 ? '99+' : count;
    } else {
        badge.style.display = 'none';
    }
}

function renderNotifications() {
    const list = document.getElementById('notificationList');
    if (!list) return;
    
    if (notifications.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted);">暂无通知</div>';
        return;
    }
    
    list.innerHTML = notifications.map(n => `
        <div class="notification-item ${n.read === 0 ? 'unread' : ''}" onclick="handleNotificationClick(${n.id}, '${n.url || ''}')">
            <div class="notification-item-actions">
                <button class="notification-item-action" onclick="event.stopPropagation();deleteNotification(${n.id})" title="删除">✕</button>
            </div>
            <div class="notification-item-title">${n.title}</div>
            ${n.content ? `<div class="notification-item-content">${n.content}</div>` : ''}
            <div class="notification-item-time">${formatTime(n.createdAt)}</div>
        </div>
    `).join('');
}

function toggleNotificationPanel() {
    const panel = document.getElementById('notificationPanel');
    if (!panel) return;
    
    panel.classList.toggle('show');
    
    if (panel.classList.contains('show')) {
        loadNotifications();
    }
}

async function handleNotificationClick(id, url) {
    // 标记已读
    try {
        await fetch(`/api/notification/read/${id}`, { method: 'POST' });
    } catch (e) {}
    
    // 关闭面板
    document.getElementById('notificationPanel').classList.remove('show');
    
    // 如果有 URL，跳转
    if (url) {
        if (url.startsWith('http')) {
            window.open(url, '_blank');
        } else {
            window.location.href = url;
        }
    }
    
    // 刷新通知
    loadNotifications();
}

async function markAllRead() {
    try {
        await fetch('/api/notification/read-all', { method: 'POST' });
        loadNotifications();
        showNotification('通知', '已全部标记为已读');
    } catch (e) {}
}

async function deleteNotification(id) {
    try {
        await fetch(`/api/notification/${id}`, { method: 'DELETE' });
        loadNotifications();
    } catch (e) {}
}

function formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ========== 元数据编辑 ==========
let editingMovieId = null;

function showEditModal(id) {
    editingMovieId = id;
    const movie = currentMovies.find(m => m.id === id);
    if (!movie) return;
    
    const html = `
        <div style="padding: 24px;">
            <h3 style="margin-bottom:20px;font-size:18px;">✏️ 编辑元数据</h3>
            <div style="display:flex;flex-direction:column;gap:16px;">
                <div>
                    <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">标题</label>
                    <input type="text" id="editTitle" class="select-input" style="width:100%;height:40px;" value="${movie.title || ''}">
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                    <div>
                        <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">发行日期</label>
                        <input type="text" id="editRelease" class="select-input" style="width:100%;height:40px;" value="${movie.releaseDate || ''}">
                    </div>
                    <div>
                        <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">片商</label>
                        <input type="text" id="editProducer" class="select-input" style="width:100%;height:40px;" value="${movie.producer || ''}">
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                    <div>
                        <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">系列</label>
                        <input type="text" id="editSerial" class="select-input" style="width:100%;height:40px;" value="${movie.serial || ''}">
                    </div>
                    <div>
                        <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">导演</label>
                        <input type="text" id="editDirector" class="select-input" style="width:100%;height:40px;" value="${movie.director || ''}">
                    </div>
                </div>
                <div>
                    <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">简介</label>
                    <textarea id="editOverview" class="select-input" style="width:100%;height:100px;padding:10px;resize:vertical;">${movie.overview || ''}</textarea>
                </div>
            </div>
            <div style="display:flex;gap:12px;margin-top:24px;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeEditModal()">取消</button>
                <button class="btn" onclick="saveEdit()">保存</button>
            </div>
        </div>
    `;
    
    document.getElementById('detailBody').innerHTML = html;
}

function closeEditModal() {
    closeModal();
}

async function saveEdit() {
    if (!editingMovieId) return;
    
    const title = document.getElementById('editTitle').value;
    const overview = document.getElementById('editOverview').value;
    const releaseDate = document.getElementById('editRelease').value;
    const producer = document.getElementById('editProducer').value;
    const serial = document.getElementById('editSerial').value;
    const director = document.getElementById('editDirector').value;
    
    try {
        const res = await fetch(`/api/movie/update/${editingMovieId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, overview, releaseDate, producer, serial, director })
        });
        const data = await res.json();
        
        if (data.code === 0) {
            showNotification('保存成功', '元数据已更新');
            closeModal();
            // 原地刷新（保持页码与视窗位置）
            refreshCurrentList();
        } else {
            showNotification('保存失败', data.msg);
        }
    } catch (e) {
        showNotification('保存失败', e.message);
    }
}

document.addEventListener('DOMContentLoaded', init);
// 启动即应用个性化设置（背景图/侧栏收缩/海报比例/播放器大小等，幂等）
document.addEventListener('DOMContentLoaded', applyUiCustom);
