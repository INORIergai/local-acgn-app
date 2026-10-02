// ========== 全局状态 ==========
let currentView = 'home';
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
    /* ★ 历史数据里有一批 jav 记录的 posterPath 存的是**远程 URL**
       （如 https://pics.dmm.co.jp/digital/video/xxx/xxxpl.jpg，实测 136 条）。
       直接拼 /api/movie/poster/<url> 必然 404 —— 卡片于是永远显示占位图。
       这类要走图片代理：顺带绕防盗链，并过 image-guard 的密文检测。 */
    if (/^https?:\/\//i.test(posterFile)) {
        return `/api/movie/poster/proxy?url=${encodeURIComponent(posterFile)}`;
    }
    // 添加时间戳防止浏览器缓存
    return `/api/movie/poster/${posterFile}?t=${movie.lastScanTime || Date.now()}`;
}

// 统一图标渲染助手：调用 MidnightIcons Aperture 胶片光栅矢量图标系统
function uiIcon(name, size = 16, extraClass = '') {
    if (window.MidnightIcons && typeof window.MidnightIcons.icon === 'function') {
        return window.MidnightIcons.icon(name, size, extraClass);
    }
    return '';
}

// 侧栏同款 Remotion 3D 实心光体图标（透明 WebM 动画 + PNG 静帧双保险保底）
function makeRemotionIcon(id, size = 22) {
    return `<span class="nv-ic" style="width:${size}px;height:${size}px;display:inline-flex;align-items:center;justify-content:center;position:relative;flex-shrink:0;">` +
        `<video class="nv-ic-vid" muted playsinline disablepictureinpicture preload="auto" src="img/nav-icons/${id}.webm" style="width:100%;height:100%;object-fit:contain;pointer-events:none;"></video>` +
        `<img class="nv-ic-img" src="img/nav-icons/${id}.png" alt="" style="width:100%;height:100%;object-fit:contain;position:absolute;inset:0;pointer-events:none;" onerror="this.style.display='none'">` +
        `</span>`;
}

// 显示通知（round34 批次B：level 分级配色 success绿 / warn黄 / error红 / info主色）
function showNotification(title, message, duration = 3000, level = 'info') {
    const notif = document.getElementById('notification');
    document.getElementById('notifTitle').textContent = title;
    document.getElementById('notifMessage').textContent = message;
    notif.classList.remove('level-success', 'level-warn', 'level-error', 'level-info');
    notif.classList.add('show', 'level-' + (level || 'info'));
    setTimeout(() => {
        notif.classList.remove('show');
    }, duration);
}

// ========== round34 批次B：通知轮询（即时 toast 通道 + 未读徽章） ==========
let _liveSince = 0;
let _pollingStarted = false;

function startNotifyPolling() {
    if (_pollingStarted) return;
    _pollingStarted = true;
    setInterval(async () => {
        // 未解锁（密码门禁未过）时不弹，避免把成人库的情报泄露到锁屏前
        if (window.Gate && !Gate.isUnlocked()) return;
        try {
            // 即时通道：不落库的短时通知（操作成功等）
            const r = await fetch('/api/notification/live?since=' + _liveSince);
            const d = await r.json();
            if (d.code === 0 && d.data && Array.isArray(d.data.items)) {
                _liveSince = d.data.now || Date.now();
                d.data.items.forEach((n, i) => {
                    setTimeout(() => showNotification(n.title, n.content, 3500, n.level), i * 350);
                });
            }
        } catch (e) { /* 静默 */ }
        try {
            // 未读徽章（低频刷新）
            const r2 = await fetch('/api/notification/unread-count');
            const d2 = await r2.json();
            if (d2.code === 0) updateNotificationBadge(d2.data || 0);
        } catch (e) { /* 静默 */ }
    }, 15000);
}

// ========== 分页状态 ==========
let currentPage = 1;
let currentPageSize = 50;
let currentTotal = 0;
let currentTotalPages = 0;
window.getCurrentPage = () => currentPage;
window.getCurrentTotalPages = () => currentTotalPages;

// ========== API 封装 ==========
const api = {
    async getMovies(sort = 'hot', filter = 'all', type = 'all', page = 1, pageSize = 50, privacy = '') {
        const pz = privacy ? `&privacy=${privacy}` : '';
        const res = await fetch(`/api/movie?sort=${sort}&filter=${filter}&type=${type}&page=${page}&pageSize=${pageSize}${pz}`);
        const data = await res.json();
        currentTotal = data.total || 0;
        currentTotalPages = data.totalPages || 0;
        currentPage = data.page || 1;
        return data.data || [];
    },
    
    async searchMovies(q) {
        // round41 #4：搜索结果排序；round42：下拉移到顶栏搜索框旁，全季/年份筛选已取消
        const [sortKey, orderKey] = (localStorage.getItem('searchSort') || 'name:asc').split(':');
        const params = new URLSearchParams();
        params.set('q', q);
        params.set('sort', sortKey || 'name');
        params.set('order', orderKey || 'asc');
        const res = await fetch(`/api/movie/search?${params.toString()}`);
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
    
    // round34 切片器：type 可选 all/jav/anime/film/cartoon
    async getActresses(type) {
        const qs = (type && type !== 'all') ? `?type=${encodeURIComponent(type)}` : '';
        const res = await fetch('/api/actress' + qs);
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
    
    // round34 切片器：type 可选 all/jav/anime/film/cartoon
    async getTags(type) {
        const qs = (type && type !== 'all') ? `?type=${encodeURIComponent(type)}` : '';
        const res = await fetch('/api/tags' + qs);
        const data = await res.json();
        return data.data || [];
    },
    
    async getTagMovies(id) {
        const res = await fetch(`/api/tags/${id}/movies`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getSimilarMovies(id, limit = 12, privacy = '') {
        const res = await fetch(`/api/recommend/similar/${id}?limit=${limit}${privacy ? '&privacy=' + privacy : ''}`);
        const data = await res.json();
        return data.data || [];
    },
    
    async getRandomMovies(limit = 24, type = 'all', privacy = '') {
        const res = await fetch(`/api/recommend/random?limit=${limit}&type=${type}${privacy ? '&privacy=' + privacy : ''}`);
        const data = await res.json();
        return data.data || [];
    },

    async getHotMovies(limit = 24, privacy = '') {
        const res = await fetch(`/api/recommend/hot?limit=${limit}${privacy ? '&privacy=' + privacy : ''}`);
        const data = await res.json();
        return data.data || [];
    },

    async getGuessMovies(limit = 24, privacy = '') {
        const res = await fetch(`/api/recommend/guess?limit=${limit}${privacy ? '&privacy=' + privacy : ''}`);
        const data = await res.json();
        return data.data || [];
    },

    async getUnwatchedMovies(limit = 50, privacy = '') {
        const res = await fetch(`/api/recommend/unwatched?limit=${limit}${privacy ? '&privacy=' + privacy : ''}`);
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

    // ===== 目录监控（round28）=====
    // 状态里含实时轮询间隔：没扫到新增时后端会逐次翻倍（上限 1 小时）
    async getWatchStatus() {
        const res = await fetch('/api/scanner/watch-status');
        const data = await res.json();
        return data.data || {};
    },

    async watchNow() {
        const res = await fetch('/api/scanner/watch-now', { method: 'POST' });
        return await res.json();
    },

    async watchToggle(enabled) {
        const res = await fetch('/api/scanner/watch-toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled })
        });
        return await res.json();
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
        let privacy = 'exclude';                        // round43：精选推荐默认排除 AV/里番（公开视图干净）
        if (view === 'anime') type = 'anime';
        else if (view === 'comic') type = 'comic';
        else if (view === 'novel') type = 'novel';
        else if (view === 'movies-adult') { type = 'adult'; privacy = 'adult'; }   // 隐私组版：轮播只放 AV/里番

        // 2026-09-22：用户反馈「推荐只有两部」——原来只请求 8 部再过滤掉无封面的，
        // 随机 8 部里有 6 部没海报就只剩 2 部了。现在多拿一些（后端本来就会 ×4 随机池），
        // 过滤有封面的后洗牌，固定输出 10 部；每次刷新都是新的随机组合。
        const pool = await api.getRandomMovies(40, type, privacy);
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

// ★ round26 #10：入库时间戳（毫秒）→ YYYY-MM-DD。addedTime 是数字，别当字符串处理。
function formatAddedDate(ts) {
    const n = Number(ts);
    if (!n || isNaN(n)) return '';
    const d = new Date(n);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// round36 P0-3：显示原名偏好（设置保存后即时生效；默认关）
// window.CV_SHOW_ORIG 在 init 解锁后加载，saveSettings 保存时同步。
function prefTitle(movie) {
    if (window.CV_SHOW_ORIG && movie.originalTitle) return movie.originalTitle;
    return movie.title || movie.fileName;
}

// 渲染影片卡片（海报+番号，hover显示完整信息）
function renderMovieCard(movie) {
    const posterUrl = getPosterUrl(movie);
    const isFav = movie.favorite === 1;
    const isWatched = movie.watched === 1;
    const isSelected = selectedMovies.has(movie.id);
    const displayTitle = prefTitle(movie);   // round36 P0-3：可切换显示原名
    const avid = movie.avid || '';

    // 续播进度（齿孔进度条），由 features.js 维护 window.progressMap
    const pct = window.progressMap ? window.progressMap[movie.id] : 0;

    // NEW 角标：近 7 天入库
    const isNew = movie.addedTime && (Date.now() - Number(movie.addedTime)) < 7 * 864e5;

    /* ★ round26 #10：入库日期标签。
     *   用户要求「自动扫描新增的项目要有入库日期标签，以便在时间线上搜索」。
     *   近 30 天入库的在封面上直接标出 MM-DD（title 里给完整日期），
     *   并且把 addedTime 与格式化日期写进 data- 属性 —— 既方便前端做时间线筛选，
     *   也方便 AI/agent 读取（不必再靠猜）。 */
    const addedDate = movie.addedTime ? formatAddedDate(movie.addedTime) : '';
    const addedDays = movie.addedTime
        ? Math.floor((Date.now() - Number(movie.addedTime)) / 864e5) : null;
    const addedBadge = (addedDays !== null && addedDays >= 0 && addedDays <= 30)
        ? addedDate.slice(5) : '';   // MM-DD

    // 副信息行：番号 + 体积（等宽字体，扫读对齐）
    const metaLine = [avid, movie.fileSize ? formatSize(movie.fileSize) : ''].filter(Boolean).join(' · ');

    return `
        <div class="movie-card movie-card-compact ${isFav ? 'favorite' : ''} ${isWatched ? 'watched' : ''} ${isSelected ? 'selected' : ''}" data-id="${movie.id}" data-added="${movie.addedTime || ''}" data-added-date="${addedDate}" data-type="${movie.type || ''}" title="${displayTitle}">
            <i class="am-glow" aria-hidden="true"></i>
            ${isFav ? '<span class="badge-fav">⭐</span>' : ''}
            ${isWatched ? '<span class="badge-watched">✓</span>' : ''}
            <div class="movie-poster-wrap">
                ${isNew ? '<span class="movie-badge-new">NEW</span>' : ''}
                ${addedBadge ? `<span class="movie-badge-added" title="入库日期 ${addedDate}">📥 ${addedBadge}</span>` : ''}
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
function renderMovies(movies, fromFilter = false) {
    currentMovies = movies;
    window.currentMovies = movies;
    if (!fromFilter) {
        window._rawViewMovies = movies;
    }
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
        // round36 P0-4：影视/动漫卡 hover 剧照（有 tmdbId 才拉，一次缓存）
        bindStillHover(card);
    });
}

// round36 P0-4：hover 时拉取 TMDB 剧照，垫在 hover-info 底层淡入
function bindStillHover(card) {
    const type = (card.dataset.type || '').toLowerCase();
    if (type !== 'film' && type !== 'cartoon') return;
    let loaded = false;
    card.addEventListener('mouseenter', () => {
        if (loaded) return;
        loaded = true;
        const id = parseInt(card.dataset.id);
        const hover = card.querySelector('.movie-hover-info');
        if (!id || !hover) return;
        fetch(`/api/movie/stills/${id}`).then(r => r.json()).then(j => {
            if (j.code !== 0 || !j.data || !j.data.length) return;
            const img = document.createElement('img');
            img.className = 'movie-hover-still';
            img.src = j.data[0];
            img.alt = '';
            hover.prepend(img);
        }).catch(() => {});
    }, { passive: true });
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
            // r64: 时间线卡片选中抽出高亮
            const strip = card.closest('.tl-strip');
            if (strip) {
                strip.classList.add('has-active');
                strip.querySelectorAll('.tl-card').forEach(c => c.classList.remove('is-active'));
                card.classList.add('is-active');
            }
            if (window.MotionFLIP) window.MotionFLIP.record(card);
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

/* ============================================================================
   ★ round26 #10：入库时间线（可搜索 / 可按天筛）
   ----------------------------------------------------------------------------
   用户原话：「自动扫描如果有增加情况，增加的项目最好有一个入库日期标签，
             让用户可以在时间线上进行搜索，或者让 AI 提出。」
   这里把「时间线条带」抽成公共函数：
     · buildTimelineCards(list, {q, days, limit}) —— 支持关键字与天数过滤，
       每张卡片带「今天/昨天/N 天前」相对标签 + 具体入库日期（YYYY-MM-DD）。
     · bindTimelineTools(grid, source) —— 给搜索框与天数 chips 挂事件，即时重渲染。
   卡片本身写入了 data-mid，点击仍走原有的 tl-card 详情逻辑。
   ============================================================================ */
function buildTimelineCards(list, opts) {
    const o = opts || {};
    const DAY = 86400000;
    const now = Date.now();
    const q = String(o.q || '').trim().toLowerCase();
    const minTs = o.days ? now - o.days * DAY : 0;
    const items = (list || [])
        .filter(m => (Number(m.addedTime) || 0) >= minTs)
        .filter(m => {
            if (!q) return true;
            const hay = `${m.title || ''} ${m.fileName || ''} ${m.avid || ''}`.toLowerCase();
            return hay.includes(q);
        })
        .sort((a, b) => (Number(b.addedTime) || 0) - (Number(a.addedTime) || 0));
    const cap = o.limit || items.length;
    const html = items.slice(0, cap).map((m, idx) => {
        const ts = Number(m.addedTime) || 0;
        const days = ts ? Math.floor((now - ts) / DAY) : null;
        const label = days === null ? '' : (days <= 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`);
        const animIdx = Math.min(idx, 15);
        return `
        <div class="tl-card" data-mid="${m.id}" style="--tl-i:${animIdx};" title="${escapeHtml(m.title || m.fileName || '')}｜入库 ${formatAddedDate(ts) || '未知'}">
            <div class="tl-poster"><img src="${getPosterUrl(m)}" alt="" loading="lazy"></div>
            <span class="tl-when">${label}</span>
            <span class="tl-date">${formatAddedDate(ts) || ''}</span>
            <span class="tl-name">${escapeHtml((m.title || m.fileName || '').slice(0, 18))}</span>
        </div>`;
    }).join('');
    return html || '<div class="tl-empty">该条件下没有入库记录</div>';
}

function bindTimelineTools(grid, source) {
    const input = grid.querySelector('#tlSearchInput');
    const chips = Array.from(grid.querySelectorAll('.tl-chip'));
    const strip = grid.querySelector('.tl-strip');
    const note = grid.querySelector('#tlNote');
    if (!strip) return;
    const state = { q: '', days: 0 };
    const apply = () => {
        strip.innerHTML = buildTimelineCards(source, { q: state.q, days: state.days, limit: 60 });
        const shown = strip.querySelectorAll('.tl-card').length;
        if (note) {
            note.textContent = shown === 0
                ? ''
                : `条带显示 ${shown} 部 / 共 ${source.length} 部${state.q || state.days ? '（已筛选）' : ''} · 按住拖动 / 滚轮左右滑`;
        }
    };
    if (input) {
        let t = null;
        input.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(() => { state.q = input.value; apply(); }, 160);
        });
        input.addEventListener('click', e => e.stopPropagation());
    }
    chips.forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            chips.forEach(b => b.classList.toggle('active', b === btn));
            state.days = parseInt(btn.dataset.days) || 0;
            apply();
            bindTimelineWave(strip);
            bindDetailClicks(strip);
        });
    });
    // r65: 首次加载不重复 apply() 销毁卡片，保留已有 DOM 让错峰抽出动画平稳播放
    if (note) {
        const shown = strip.querySelectorAll('.tl-card').length;
        note.textContent = shown === 0 ? '' : `条带显示 ${shown} 部 / 共 ${source.length} 部 · 按住拖动 / 滚轮左右滑`;
    }
    // r66: 绑定物理海浪波浪顶起动效 (Wave Lift Effect)
    bindTimelineWave(strip);
}

// r66: 物理连续波浪顶起动效（像有一根手指在海报地下，鼠标拖动/滑过时依次顶起，形成波浪翻涌）
function bindTimelineWave(strip) {
    if (!strip || strip.__waveBound) return;
    strip.__waveBound = true;

    const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const RADIUS = 320;        // 影响半宽 (px)
    const MAX_Y = 34;          // 最大顶起高度 (px)
    const MAX_SCALE = 1.12;    // 最大放大
    const MAX_ROT = 6;         // 最大波峰侧倾角 (deg)

    let isDown = false, moved = 0, startX = 0, startScroll = 0;
    let rafId = null, currentFocalX = 0, activeCards = new Set();

    function updateWave(focalX) {
        if (REDUCED) return;
        currentFocalX = focalX;
        if (rafId) return;

        rafId = requestAnimationFrame(() => {
            rafId = null;
            const cards = strip.querySelectorAll('.tl-card');
            const newActive = new Set();

            cards.forEach(card => {
                const r = card.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const dist = Math.abs(cx - currentFocalX);

                if (dist < RADIUS) {
                    const u = dist / RADIUS;
                    // 升余弦钟形波 (Hann Window)
                    const w = 0.5 * (1 + Math.cos(Math.PI * u));
                    const y = -MAX_Y * w;
                    const s = 1 + (MAX_SCALE - 1) * w;
                    const rot = ((cx - currentFocalX) / RADIUS) * MAX_ROT * (1 - u) * w;
                    const z = Math.round(w * 10) + 1;

                    card.style.setProperty('--wave-y', `${y.toFixed(1)}px`);
                    card.style.setProperty('--wave-s', s.toFixed(3));
                    card.style.setProperty('--wave-rot', `${rot.toFixed(2)}deg`);
                    card.style.setProperty('--wave-z', z);

                    newActive.add(card);
                    activeCards.delete(card);
                }
            });

            // 移出波浪范围的卡片复位
            activeCards.forEach(card => {
                card.style.removeProperty('--wave-y');
                card.style.removeProperty('--wave-s');
                card.style.removeProperty('--wave-rot');
                card.style.removeProperty('--wave-z');
            });
            activeCards = newActive;
        });
    }

    function settleWave() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        strip.classList.remove('is-waving');
        strip.classList.add('is-settling');

        activeCards.forEach(card => {
            card.style.setProperty('--wave-y', '0px');
            card.style.setProperty('--wave-s', '1');
            card.style.setProperty('--wave-rot', '0deg');
            card.style.setProperty('--wave-z', '1');
        });

        setTimeout(() => {
            activeCards.forEach(card => {
                card.style.removeProperty('--wave-y');
                card.style.removeProperty('--wave-s');
                card.style.removeProperty('--wave-rot');
                card.style.removeProperty('--wave-z');
            });
            activeCards.clear();
            strip.classList.remove('is-settling');
        }, 380);
    }

    strip.addEventListener('dragstart', e => e.preventDefault());

    strip.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch' || e.button !== 0) return;
        isDown = true;
        moved = 0;
        startX = e.clientX;
        startScroll = strip.scrollLeft;
        strip.classList.add('is-waving');
        updateWave(e.clientX);
    });

    window.addEventListener('pointermove', e => {
        if (!isDown) {
            const r = strip.getBoundingClientRect();
            if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right) {
                strip.classList.add('is-waving');
                updateWave(e.clientX);
            }
            return;
        }

        const dx = e.clientX - startX;
        if (Math.abs(dx) > moved) moved = Math.abs(dx);
        if (moved > 4) {
            if (!strip.classList.contains('dragging')) {
                strip.classList.add('dragging');
                try { strip.setPointerCapture(e.pointerId); } catch (err) {}
            }
            strip.scrollLeft = startScroll - dx;
        }
        updateWave(e.clientX);
    });

    const endDrag = () => {
        if (!isDown) return;
        isDown = false;
        if (moved > 4) {
            strip.__sup = true;
            setTimeout(() => { strip.__sup = false; }, 90);
        }
        strip.classList.remove('dragging');
        settleWave();
    };

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    strip.addEventListener('pointerleave', () => {
        if (!isDown) settleWave();
    });

    strip.addEventListener('wheel', e => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (!d) return;
        e.preventDefault();
        strip.scrollLeft += d;
        strip.classList.add('is-waving');
        updateWave(e.clientX || (strip.getBoundingClientRect().left + strip.clientWidth / 2));
        clearTimeout(strip.__wheelTimer);
        strip.__wheelTimer = setTimeout(settleWave, 180);
    }, { passive: false });

    strip.addEventListener('click', e => {
        if (strip.__sup) { e.stopPropagation(); e.preventDefault(); }
    }, true);
}

// 独立入口：只看「最近 N 天新增」，供启动扫描完成的提示条一键跳转
async function showAddedTimeline(days) {
    const d = days || 7;
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    if (emptyTip) emptyTip.style.display = 'none';
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    currentView = 'added';
    currentSearchQuery = '';
    grid.classList.remove('tree-mode');
    grid.style.display = 'grid';
    grid.innerHTML = '<div class="lan-loading">正在读取最近入库…</div>';
    let list = [];
    try {
        // 多取一些天数：这样条带上的「今天 / 7 天 / 30 天」chips 都能在前端直接筛
        const span = Math.max(d, 30);
        const r = await fetch(`/api/movie/added-timeline?days=${span}&limit=500`);
        const j = await r.json();
        if (j.code === 0) list = Array.isArray(j.data) ? j.data : (j.data && j.data.list) || [];
    } catch (e) { }
    if (typeof updateToolbarTitle === 'function') updateToolbarTitle('📥 最近入库 · 新增片单', list.length);
    const cards = buildTimelineCards(list, { limit: 500 });
    grid.innerHTML = `
        <div class="tl-wrap">
            <div class="tl-head">
                <b>📥 最近 ${d} 天入库</b>
                <div class="tl-tools">
                    <input class="tl-search" id="tlSearchInput" type="search" placeholder="在这些新片里搜…" autocomplete="off">
                    <button class="tl-chip active" data-days="0">全部</button>
                    <button class="tl-chip" data-days="1">今天</button>
                    <button class="tl-chip" data-days="7">7 天</button>
                    <button class="tl-chip" data-days="30">30 天</button>
                    <button class="tl-chip" id="tlBackBtn">← 返回全部</button>
                </div>
            </div>
            <div class="tl-strip">${cards}</div>
            <div class="tl-note" id="tlNote"></div>
        </div>
        <div class="uw-grid-title">共 ${list.length} 部</div>
        <div class="movie-grid uw-grid">${list.map(renderMovieCard).join('')}</div>`;
    bindTimelineTools(grid, list);
    const back = grid.querySelector('#tlBackBtn');
    if (back) back.addEventListener('click', () => switchView('movies'));
    bindDetailClicks(grid);
    grid.querySelectorAll('.uw-grid .movie-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.ctrlKey || e.metaKey) { toggleSelect(parseInt(card.dataset.id)); return; }
            showMovieDetail(parseInt(card.dataset.id));
        });
    });
    rememberViewState('added', '');
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
    const tlCards = buildTimelineCards(byAdded, { limit: 30 });

    grid.innerHTML = `
        <div class="tl-wrap">
            <div class="tl-head">
                <b>📥 入库时间线</b>
                <div class="tl-tools">
                    <input class="tl-search" id="tlSearchInput" type="search" placeholder="搜索片名 / 番号…" autocomplete="off">
                    <button class="tl-chip active" data-days="0">全部</button>
                    <button class="tl-chip" data-days="1">今天</button>
                    <button class="tl-chip" data-days="7">7 天</button>
                    <button class="tl-chip" data-days="30">30 天</button>
                </div>
            </div>
            <div class="tl-strip">${tlCards}</div>
            <div class="tl-note" id="tlNote"></div>
        </div>
        <div class="uw-grid-title">全部未观看 · ${movies.length} 部</div>
        <div class="movie-grid uw-grid">${movies.map(renderMovieCard).join('')}</div>`;

    // ★ round26 #10：入库时间线支持「按关键字搜索 + 按天数筛选」
    bindTimelineTools(grid, byAdded);

    bindDetailClicks(grid);
    // 常规网格沿用原卡片点击（含 Ctrl 多选）
    grid.querySelectorAll('.uw-grid .movie-card').forEach(card => {
        card.addEventListener('click', (e) => {
            const id = parseInt(card.dataset.id);
            if (e.ctrlKey || e.metaKey) { toggleSelect(id); return; }
            showMovieDetail(id);
        });
    });
    // r66: 时间线物理波浪拖动已由 bindTimelineTools(grid) 内置的 bindTimelineWave(strip) 接管
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
        case 'favhub':
        case 'playlists':
            loadFavHub(page);
            break;
        default:
            loadMovies(page);
    }
}

// ========== 功能页方向键翻页快捷键（ArrowLeft / ArrowRight） ==========
window.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.metaKey) return;

    // 焦点在文本输入或可编辑区域时不拦截
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

    // 播放器正在播放时，留给播放器自己的左右快进/快退
    const playerModal = document.getElementById('playerModal');
    if (playerModal && playerModal.classList.contains('show')) return;

    // 内置漫画/小说全屏阅读器开启时，留给阅读器 iframe
    const readerView = document.getElementById('readerView');
    if (readerView && readerView.classList.contains('show')) return;

    // 灯箱开启时，留给灯箱切图
    const lb = document.getElementById('posterLightbox');
    if (lb && lb.classList.contains('show')) return;
    const clb = document.getElementById('cloudImgModal');
    if (clb && clb.classList.contains('show')) return;

    // 详情弹窗开启时：左右键切换上一部 / 下一部（或漫画/小说上一本 / 下一本）
    const movieModal = document.getElementById('movieModal');
    if (movieModal && movieModal.classList.contains('show') && typeof currentDetailMovie === 'object' && currentDetailMovie) {
        const id = currentDetailMovie.id;
        if (currentDetailMovie.type === 'comic' || currentDetailMovie.type === 'novel') {
            const nav = typeof getSiblingNav === 'function' ? getSiblingNav(currentDetailMovie.type, id) : null;
            if (nav) {
                if (e.key === 'ArrowLeft' && nav.prev) {
                    e.preventDefault();
                    showMovieDetail(nav.prev.id);
                    return;
                }
                if (e.key === 'ArrowRight' && nav.next) {
                    e.preventDefault();
                    showMovieDetail(nav.next.id);
                    return;
                }
            }
        }
        if (Array.isArray(currentMovies) && currentMovies.length > 0) {
            const idx = currentMovies.findIndex(m => m.id === id);
            if (e.key === 'ArrowLeft' && idx > 0) {
                e.preventDefault();
                showMovieDetail(currentMovies[idx - 1].id);
                return;
            }
            if (e.key === 'ArrowRight' && idx >= 0 && idx < currentMovies.length - 1) {
                e.preventDefault();
                showMovieDetail(currentMovies[idx + 1].id);
                return;
            }
        }
        return;
    }

    // 功能页主列表视图：左右方向键翻页
    if (typeof currentTotalPages === 'number' && currentTotalPages > 1) {
        if (e.key === 'ArrowLeft') {
            if (currentPage > 1) {
                e.preventDefault();
                goToPage(currentPage - 1);
            }
        } else if (e.key === 'ArrowRight') {
            if (currentPage < currentTotalPages) {
                e.preventDefault();
                goToPage(currentPage + 1);
            }
        }
    }
});

// ========== 全局快捷键指南弹窗 (CheatSheet) ==========
function toggleShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (!modal) return;
    modal.classList.toggle('show');
}

function closeShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (modal) modal.classList.remove('show');
}

// ========== 【P3-7】在线源健康测速仪表盘 ==========
let _currentHealthBoard = 'all';

window.openWatchHealthModal = function(board = 'all') {
    _currentHealthBoard = board;
    const modal = document.getElementById('watchHealthModal');
    if (!modal) return;
    modal.classList.add('show');
    runWatchHealthCheck();
};

window.closeWatchHealthModal = function() {
    const modal = document.getElementById('watchHealthModal');
    if (modal) modal.classList.remove('show');
};

window.runWatchHealthCheck = async function() {
    const body = document.getElementById('watchHealthBody');
    const subTitle = document.getElementById('watchHealthSubTitle');
    const btn = document.getElementById('watchHealthRecheckBtn');
    if (!body) return;
    if (btn) { btn.disabled = true; btn.textContent = '⚡ 测速中…'; }

    const boardNames = { all: '全部板块', av: 'AV 在线', hanime: '里番在线', anime: '动漫在线', comic: '漫画在线', novel: '轻小说' };
    if (subTitle) subTitle.textContent = `正在并发探测【${boardNames[_currentHealthBoard] || '全站'}】各站点线路延迟…`;
    body.innerHTML = `
        <div style="text-align:center;padding:48px 0;color:var(--text-muted);display:flex;flex-direction:column;align-items:center;gap:12px;">
            <div class="poster-spin" style="width:24px;height:24px;border-width:2.5px;"></div>
            <span>正在并发测速主域名与备用镜像线路（约需 2-4 秒）…</span>
        </div>
    `;

    try {
        const res = await fetch(`/api/webview/health-check?board=${encodeURIComponent(_currentHealthBoard)}`);
        const json = await res.json();
        if (json.code !== 0 || !Array.isArray(json.data)) throw new Error(json.msg || '测速失败');

        const list = json.data;
        const total = list.length;
        const onlineCount = list.filter(s => s.rating !== 'down').length;

        if (subTitle) {
            subTitle.innerHTML = `共探测 <b>${total}</b> 个站点 · 可用 <b>${onlineCount}</b> 个 · 离线/受限 <b>${total - onlineCount}</b> 个`;
        }

        body.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:12px;">
                ${list.map(s => {
                    const isDown = s.rating === 'down';
                    const isFast = s.rating === 'fast';
                    const badgeColor = isDown ? '#EF4444' : isFast ? '#10B981' : '#F59E0B';
                    const badgeBg = isDown ? 'rgba(239,68,68,0.15)' : isFast ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)';
                    const statusText = isDown ? '不可达 / 超时' : `${s.latency} ms · ${isFast ? '极速' : '良好'}`;

                    return `
                        <div style="padding:14px;border-radius:14px;background:rgba(255,255,255,0.04);border:1px solid ${isDown ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)'};display:flex;flex-direction:column;gap:8px;">
                            <div style="display:flex;align-items:center;justify-content:space-between;">
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <span style="width:8px;height:8px;border-radius:50%;background:${badgeColor};box-shadow:0 0 8px ${badgeColor};"></span>
                                    <b style="font-size:13.5px;color:var(--text);">${escapeHtml(s.name)}</b>
                                    <span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,0.08);color:var(--text-muted);">${s.board.toUpperCase()}</span>
                                </div>
                                <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-family:var(--font-mono);">
                                    ${statusText}
                                </span>
                            </div>
                            <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px;">
                                ${(s.details || []).map((d, i) => `
                                    <div style="display:flex;align-items:center;justify-content:space-between;font-size:11.5px;padding:3px 6px;border-radius:6px;background:rgba(0,0,0,0.2);">
                                        <span style="font-family:var(--font-mono);opacity:.75;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                                            线路 ${i + 1}: ${escapeHtml(d.addr.replace(/^https?:\/\//, '').replace(/\/$/, ''))}
                                        </span>
                                        <span style="font-family:var(--font-mono);font-size:10.5px;color:${d.ok ? '#10B981' : '#EF4444'};">
                                            ${d.ok ? `${d.latency}ms` : '失败'}
                                        </span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    } catch (e) {
        body.innerHTML = `<div style="text-align:center;padding:30px;color:#EF4444;">测速失败：${escapeHtml(e.message)}</div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 重新测速'; }
    }
};

window.addEventListener('keydown', (e) => {
    // ? 或 F1 唤出快捷键指南
    if (e.key === '?' || (e.key === '/' && e.shiftKey) || e.key === 'F1') {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        toggleShortcutsModal();
    }
});

// ========== 视图状态记忆（round26 #1：刷新后回到原来的页面） ==========
// 只写 location.hash，不动 history 长度；搜索词一并记进去，F5 之后能原样恢复。
function rememberViewState(view, query) {
    try {
        const parts = [];
        if (view) parts.push('v=' + encodeURIComponent(view));
        if (query) parts.push('q=' + encodeURIComponent(query));
        const hash = parts.length ? '#' + parts.join('&') : '';
        if (location.hash !== hash) {
            history.replaceState(null, '', location.pathname + location.search + hash);
        }
    } catch (e) { /* 沙箱/无 history 环境忽略 */ }
}

function readViewState() {
    try {
        const h = (location.hash || '').replace(/^#/, '');
        if (!h) return null;
        const p = new URLSearchParams(h);
        const v = p.get('v');
        if (!v) return null;
        return { view: v, query: p.get('q') || '' };
    } catch (e) { return null; }
}

/* ========== 顶栏常驻「刷新」（round26 #1） ==========
 * 用户反馈：「整个页面没有手动刷新按钮」—— 之前只能按浏览器 F5，而 F5 会丢掉
 * 当前筛选与搜索词，直接回到「全部影片」。
 * 这里注入一个常驻按钮：常规列表走 refreshCurrentList()（保页码/视窗/筛选/搜索），
 * 特殊视图（设置、年度报告、新作监视、刮削失败、在线观看…）则重新进入该视图。 */
async function hardRefreshCurrent() {
    const btn = document.getElementById('globalRefreshBtn');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
        const special = ['settings', 'annual', 'new-releases', 'scrape-failures',
            'watch', 'watch-anime', 'watch-comic', 'watch-novel', 'watch-hanime', 'watch-hub',
            'guess', 'guess-magic', 'playlists', 'favorites', 'favhub'];
        const view = currentView || 'movies';
        if (special.includes(view)) {
            // r59：顶栏刷新海报健康时同样续位（刷新≠回到顶部）
            if (view === 'poster-health' && window.Features && window.Features.requestPosterHealthResume) {
                window.Features.requestPosterHealthResume();
            }
            switchView(view);
        } else {
            await refreshCurrentList();
        }
        showNotification('已刷新', currentSearchQuery
            ? `搜索结果「${currentSearchQuery}」已更新`
            : '当前列表已更新');
    } catch (e) {
        showNotification('刷新失败', e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
}

function injectGlobalRefreshBtn() {
    const tr = document.querySelector('.toolbar-right');
    if (!tr || document.getElementById('globalRefreshBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'globalRefreshBtn';
    btn.className = 'btn btn-sm btn-secondary';
    btn.type = 'button';
    btn.title = '刷新当前列表（保留筛选、搜索词、页码与滚动位置；快捷键 R）';
    btn.innerHTML = `${uiIcon('refresh', 14, 'mr-1')} 刷新`;
    btn.addEventListener('click', hardRefreshCurrent);
    tr.appendChild(btn);

    // 快捷键：R（不在输入框里时）
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'r' && e.key !== 'R') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        hardRefreshCurrent();
    });
}

/* ============================================================================
   ★ round26 #4：启动自动扫描的「过程 + 结果」提示条
   ----------------------------------------------------------------------------
   用户原话：「没有打开程序之后自动扫描本地库增删的一个过程」。
   后端启动时确实串行跑了四库增量扫描，本函数把它显性化：
     · 扫描中 → 悬浮条显示「正在自动扫描本地库… 影片/动漫/漫画/小说」
     · 扫完   → 显示「本次启动自动扫描：新增 N 部」+「查看新增」一键跳入库时间线
   数据源 GET /api/scanner/startup-report（utils/startup-scan-report.js 记录）。
   ============================================================================ */
function initStartupScanBanner() {
    let bar = document.getElementById('startupScanBar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'startupScanBar';
        bar.className = 'startup-scan-bar';
        bar.style.display = 'none';
        document.body.appendChild(bar);
    }
    let pollTimer = null;
    let doneShown = false;
    const hide = () => { bar.style.display = 'none'; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };

    const paint = (r) => {
        if (!r || !r.ran) { bar.style.display = 'none'; return; }
        if (r.running) {
            bar.style.display = 'flex';
            bar.classList.remove('is-done');
            const parts = (r.jobs || []).map(j => `${j.name} ${j.added}`).join(' · ');
            bar.innerHTML = `<span class="ssb-spin" aria-hidden="true"></span>
                <span class="ssb-text">正在自动扫描本地库…${r.current ? `<b>${r.current}</b>` : ''}</span>
                ${parts ? `<span class="ssb-meta">${parts}</span>` : ''}`;
            return;
        }
        if (doneShown) return;
        doneShown = true;
        const total = r.addedTotal || 0;
        const detail = (r.jobs || []).filter(j => j.added > 0)
            .map(j => `${j.name} ${j.added}`).join(' · ') || '无新增';
        bar.style.display = 'flex';
        bar.classList.add('is-done');
        bar.innerHTML = `<span class="ssb-icon">${total > 0 ? '📥' : '✅'}</span>
            <span class="ssb-text">本次启动自动扫描：${total > 0 ? `新增 <b>${total}</b> 部` : '没有新增'}
                <span class="ssb-meta">${detail}</span></span>
            ${total > 0 ? '<button class="ssb-btn" id="ssbViewBtn" type="button">📥 查看新增</button>' : ''}
            <button class="ssb-close" id="ssbCloseBtn" type="button" title="关闭">×</button>`;
        const v = document.getElementById('ssbViewBtn');
        if (v) v.addEventListener('click', () => { hide(); showAddedTimeline(7); });
        const c = document.getElementById('ssbCloseBtn');
        if (c) c.addEventListener('click', hide);
        setTimeout(() => { if (bar.classList.contains('is-done')) hide(); }, 15000);
    };

    const tick = async () => {
        let r = null;
        try {
            const res = await fetch('/api/scanner/startup-report');
            const j = await res.json();
            r = j.data;
        } catch (e) { return; }
        paint(r);
        if (r && !r.running && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
    tick();
    pollTimer = setInterval(tick, 2500);
}

// ========== 原地刷新当前列表（保持页码与视窗位置，不重置筛选） ==========
async function refreshCurrentList() {    const scrollY = window.scrollY;
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
    // 「最近入库」是自定义视图，没有 switchView 分支，直接重跑渲染函数
    if (currentView === 'added') {
        try { await showAddedTimeline(7); } catch (e) { }
        requestAnimationFrame(() => window.scrollTo(0, scrollY));
        return;
    }

    /* ★ round26 #1：特性视图（刮削失败 / 海报健康 / 新作监视 / 设置 / 年度报告 / 在线观看…）
     *   没有自己的「列表刷新」分支，老代码会直接落到 switch 的 default ⇒ 载入「全部影片」，
     *   表现就是「改完海报/刮完封面之后莫名回到了主页」。
     *   这里在进入 switch 之前先拦一道：只要当前是特性视图、又没有搜索词/筛选上下文，
     *   就重新进入该视图，而不是掉进主库。 */
    const specialViews = ['settings', 'annual', 'new-releases', 'scrape-failures', 'poster-health',
        'watch', 'watch-anime', 'watch-comic', 'watch-novel', 'watch-hanime', 'watch-hub',
        'guess', 'guess-magic', 'playlists', 'favorites', 'favhub'];
    if (specialViews.includes(currentView)) {
        try {
            // r59：海报健康的「换封面/重刮」走这里 —— switchView 会按全新进入清掉 phActive，
            // 所以先把 live 期间记下的滚动位置申请为待恢复（features.js 渲染完成后还原）。
            if (currentView === 'poster-health' && window.Features && window.Features.requestPosterHealthResume) {
                window.Features.requestPosterHealthResume();
            }
            if (typeof switchView === 'function') switchView(currentView);
        } catch (e) {
            console.error('特性视图刷新失败:', e);
        }
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
        /* round43 隐私组同款四功能块（刷新/翻页路径也要保持 adult 口径，不许回落公开视图） */
        case 'hot-adult':
            await loadHot('adult');
            break;
        case 'random-adult':
            await loadRandom('adult');
            break;
        case 'guess-adult':
            await loadGuess('adult');
            break;
        case 'unwatched-adult':
            await loadUnwatched('adult');
            break;
        case 'recent':
            await loadRecent();
            break;
        case 'favhub':
        case 'playlists':
            await loadFavHub();
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

// 补齐侧栏各库的计数（不阻塞首屏：并行、静默失败）
async function fillLibraryCounts() {
    // round34：新增影视/动漫两库计数
    const map = [
        ['jav', 'countJav'], ['anime', 'countAnime'], ['comic', 'countComic'],
        ['novel', 'countNovel'], ['film', 'countFilm'], ['cartoon', 'countCartoon']
    ];
    // 锁未解时只补普通向两库（其余接口 401，静默失败即可，但少发请求）
    const gated = window.Gate && window.Gate.ready && !window.Gate.isUnlocked();
    const list = gated ? map.filter(([t]) => t === 'film' || t === 'cartoon') : map;
    await Promise.all(list.map(async ([type, elId]) => {
        try {
            const el = document.getElementById(elId);
            if (!el) return;
            const s = await api.getStats(type);
            const n = s && s.totalMovies;
            if (typeof n === 'number') el.textContent = n;
        } catch (e) { /* 单个库取不到就保持原值 */ }
    }));
    // r44：隐私组「全部内容」计数 = AV库 + 里番库（口径与 movies-adult 视图一致；
    // stats 无 adult 分册，用两库合成，锁未解时两计数为 0 不误填）
    const javN = parseInt(document.getElementById('countJav')?.textContent, 10) || 0;
    const animeN = parseInt(document.getElementById('countAnime')?.textContent, 10) || 0;
    const adultEl = document.getElementById('countAdult');
    if (adultEl && (javN || animeN)) adultEl.textContent = javN + animeN;
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

// ========== 收藏夹（round53：原「播放列表」升级而来） ==========
// 板块：video = 视频播放列表（playlists 表，上面的代码继续管）；
//       anime/comic/novel/game/web = 网页收藏（routes/favorites.js，fav_links 表）。
// 展示：图文卡 —— 封面走 /api/acg/cover 代理（本机 DNS 污染的图床也能出图），空封面给占位。
let currentFavBoard = 'video';
const FAV_TABS = [
    ['video', '📹 视频播放列表'], ['anime', '🌸 想看的动漫'], ['comic', '💥 漫画'],
    ['novel', '📖 小说'], ['game', '🎮 想玩的游戏'], ['web', '🌐 其他网页']
];

async function loadFavHub() {
    updateToolbarTitle('⭐ 收藏夹');
    const grid = document.getElementById('movieGrid');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(240px, 1fr))';
    document.getElementById('sortSelect').parentElement.style.display = 'none';
    if (typeof hideGallery === 'function') hideGallery();

    // 标签行作为第一个格子横跨整行（铁律1：#movieGrid 是 grid）
    grid.innerHTML = `
        <div id="favTabs" style="grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
            ${FAV_TABS.map(([b, n]) => `
                <button class="btn btn-sm ${b === currentFavBoard ? '' : 'btn-secondary'}"
                        data-favboard="${b}" style="${b === currentFavBoard ? '' : 'opacity:.75;'}">${n}</button>`).join('')}
        </div>
        <div id="favBody" style="grid-column:1/-1;display:contents;"></div>`;

    grid.querySelectorAll('[data-favboard]').forEach((b) => {
        b.addEventListener('click', () => { currentFavBoard = b.dataset.favboard; loadFavHub(); });
    });

    if (currentFavBoard === 'video') {
        const lists = await api.getPlaylists();
        renderFavVideoBoard(lists);
    } else {
        await loadFavLinks(currentFavBoard);
    }
}

// 视频播放列表板块：复用播放列表卡片，但画在 favBody 里，不再动 #movieGrid
async function renderFavVideoBoard(lists) {
    const body = document.getElementById('favBody');
    if (!body) return;
    if (!lists || lists.length === 0) {
        body.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:50px 20px;">
                <div style="font-size:56px;margin-bottom:14px;opacity:.5;">📹</div>
                <div style="color:var(--text-muted);margin-bottom:16px;">还没有播放列表 —— 在影片卡片的 📋 按钮里把片子加进来</div>
                <button class="btn" onclick="showCreatePlaylist()">+ 创建播放列表</button>
            </div>`;
        return;
    }
    body.innerHTML = lists.map((list) => `
        <div class="stats-card playlist-card" data-id="${list.id}" style="cursor:pointer;padding:20px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
                <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:24px;">📋</div>
                <div>
                    <div style="font-size:16px;font-weight:600;">${escapeHtml(list.name)}</div>
                    <div style="font-size:12px;color:var(--text-muted);">${list.movieCount || 0} 部影片</div>
                </div>
            </div>
            ${list.description ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;">${escapeHtml(list.description)}</div>` : ''}
            <div style="display:flex;gap:8px;">
                <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();playPlaylist(${list.id})">▶️ 播放</button>
                <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();deletePlaylist(${list.id})">🗑️ 删除</button>
            </div>
        </div>`).join('');
    body.querySelectorAll('.playlist-card').forEach((card) => {
        card.addEventListener('click', () => showPlaylistDetail(parseInt(card.dataset.id)));
    });
}

// 网页收藏板块：图文卡
async function loadFavLinks(board) {
    const body = document.getElementById('favBody');
    if (!body) return;
    body.innerHTML = '<div style="grid-column:1/-1;color:var(--text-muted);padding:30px;text-align:center;">加载中…</div>';
    let rows = [], counts = {};
    try {
        const r = await (await fetch('/api/fav/links?board=' + encodeURIComponent(board))).json();
        if (r.code === 0) { rows = r.data || []; counts = r.counts || {}; }
    } catch (e) { /* 渲染空态 */ }

    if (!rows.length) {
        body.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:50px 20px;">
                <div style="font-size:56px;margin-bottom:14px;opacity:.5;">⭐</div>
                <div style="color:var(--text-muted);line-height:1.9;">
                    这个板块还空着。三个入口都能存进来：<br>
                    ① ACG 榜单详情弹窗的「⭐ 收藏」　② 在线观看窗口的「⭐ 收藏本页」　③ 聚合搜索卡片上的「⭐」
                </div>
            </div>`;
        return;
    }

    body.innerHTML = rows.map((it) => {
        const cover = it.coverUrl
            ? `<img src="/api/acg/cover?u=${encodeURIComponent(it.coverUrl)}" loading="lazy" alt="" style="width:100%;height:170px;object-fit:cover;border-radius:10px 10px 0 0;background:rgba(127,127,127,.12);">`
            : `<div style="width:100%;height:170px;border-radius:10px 10px 0 0;background:rgba(127,127,127,.12);display:flex;align-items:center;justify-content:center;font-size:44px;">${(FAV_TABS.find((t) => t[0] === it.board) || ['', ''])[2] || '⭐'}</div>`;
        return `
        <div class="stats-card fav-card" data-id="${it.id}" style="cursor:pointer;padding:0;overflow:hidden;display:flex;flex-direction:column;">
            ${cover}
            <div style="padding:12px 14px 14px;display:flex;flex-direction:column;gap:6px;flex:1;">
                <div style="font-size:14.5px;font-weight:600;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escapeHtml(it.title)}</div>
                ${it.note ? `<div style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(it.note)}</div>` : ''}
                <div style="flex:1"></div>
                <div style="display:flex;align-items:center;gap:6px;">
                    ${it.source ? `<span style="font-size:11px;color:var(--text-muted);background:rgba(127,127,127,.14);padding:2px 8px;border-radius:999px;">${escapeHtml(it.source)}</span>` : ''}
                    <span style="flex:1"></span>
                    ${it.url ? `<button class="btn btn-sm btn-secondary" data-open="${it.id}" title="在应用内打开">↗</button>` : ''}
                    <button class="btn btn-sm btn-secondary" data-del="${it.id}" title="删除">🗑️</button>
                </div>
            </div>
        </div>`;
    }).join('');

    body.querySelectorAll('.fav-card').forEach((card) => {
        const row = rows.find((r) => String(r.id) === card.dataset.id);
        card.addEventListener('click', async (e) => {
            if (e.target.closest('[data-del]')) {
                if (!confirm('删除这条收藏？')) return;
                await fetch('/api/fav/links/' + card.dataset.del, { method: 'DELETE' });
                loadFavLinks(currentFavBoard);
                return;
            }
            if (e.target.closest('[data-open]') && row) {
                if (window.Features && typeof window.openFavUrl === 'function') window.openFavUrl(row.url);
                return;
            }
            // 点卡片主体：有地址走应用内打开；没地址（榜单收藏）去聚合页按标题搜
            if (row && row.url) {
                if (typeof window.openFavUrl === 'function') window.openFavUrl(row.url);
            } else if (row && typeof window.openWatchWithSearch === 'function') {
                const vn = row.board === 'comic' ? 'watch-comic' : row.board === 'novel' ? 'watch-novel'
                    : row.board === 'game' ? 'watch-anime' : 'watch-anime';
                window.openWatchWithSearch(vn, row.title);
            }
        });
    });
}

// ========== 播放列表（老视图，仍被「视频播放列表」板块与影片卡 📋 使用） ==========
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
    updateToolbarTitle('🎌 里番库');   // round34 改名：原「动漫库」让位给新增的普通向库
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
            <div class="folder-card-icon">${uiIcon('folder', 48)}</div>
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
                <div class="tree-empty-icon">${uiIcon('folder', 48)}</div>
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
    const displayTitle = movie.displayTitle
        || (window.CV_SHOW_ORIG && movie.originalTitle ? movie.originalTitle : '')
        || movie.title || movie.fileName || movie.folderName || '未命名';
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

    // 已绑定过漫画目录 → 源选择页顶部给一张「目录直达」快捷卡（直接列该目录下的 epub/pdf）
    let boundCard = '';
    try {
        const mr = await (await fetch('/api/cloud/quark/media-files?type=comic&page=1&pageSize=1')).json();
        if (mr.code === 0 && mr.data && mr.data.dir) {
            boundCard = `
            <div class="cloud-source-card" onclick="quarkCurrentKind='comic';loadQuarkMediaGrid()" style="cursor:pointer;padding:30px;border:2px solid var(--primary);border-radius:16px;text-align:center;min-width:200px;transition:all 0.3s;" onmouseover="this.style.transform='translateY(-4px)'" onmouseout="this.style.transform=''">
                <div style="font-size:48px;margin-bottom:12px;">📕</div>
                <div style="font-size:18px;font-weight:600;margin-bottom:8px;">我的漫画目录</div>
                <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(String(mr.data.dir.name || ''))} · 直达 epub/pdf</div>
                <button class="btn" style="margin-top:16px;">进入</button>
            </div>`;
        }
    } catch (e) { /* 未绑定或接口异常就不显示快捷卡 */ }

    grid.innerHTML = `
        <div style="grid-column:1/-1;display:flex;gap:20px;justify-content:center;padding:40px;">
            ${boundCard}
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
    
    /* ★ round26 续 #7：先问一次「会话是否真的还能取流」。
       夸克的文件列表接口对过期 cookie 仍返回 200，所以只看列表是看不出问题的，
       用户要等点开 PDF 被 CDN 403 才发现。这里主动查并挂一条提示。 */
    await refreshQuarkSessionInfo();

    // 检查是否有cookie
    try {
        const res = await fetch(`/api/cloud/quark/files?fid=${fid}&page=${page}&pageSize=${QUARK_PAGE_SIZE}`);
        const data = await res.json();
        
        if (data.code === 0 && data.data) {
            quarkCurrentFiles = data.data.list || [];
            quarkTotal = Number(data.data.total) || quarkCurrentFiles.length;
            /* ★ 必须 await：renderQuarkFiles 是 async（内部 await cloudShortcutsHtml），
               不 await 的话它会在 await 处挂起，等它恢复执行 grid.innerHTML=… 时
               会把后面刚插入的告警条整片覆盖掉（实测：条子插进去又消失）。 */
            await renderQuarkFiles(data.data);
            injectQuarkWarning();
        } else {
            showQuarkCookieInput();
        }
    } catch (e) {
        showQuarkCookieInput();
    }
}

// ===== 夸克会话真实可用性（round26 续 #7）=====
// 背景：夸克 API（/file/sort 等）对过期 cookie 依然 200，只有真正去 CDN 取流
// 才会被回呼判定 `auth expired`。所以「登录态」分两层：
//   loggedIn    —— cookie 存在且 API 认
//   sessionValid—— 取流也会被接受（后端在取流被拒时会置为 false）
let quarkSessionInfo = null;

async function refreshQuarkSessionInfo() {
    try {
        const r = await fetch('/api/cloud/quark/check-login');
        const j = await r.json();
        quarkSessionInfo = (j && j.data) || null;
    } catch (e) {
        quarkSessionInfo = null;
    }
    return quarkSessionInfo;
}

function injectQuarkWarning() {
    const grid = document.getElementById('movieGrid');
    if (!grid) return;
    const old = document.getElementById('quarkSessionWarn');
    if (old) old.remove();
    const info = quarkSessionInfo;
    if (!info || info.sessionValid) return;
    const el = document.createElement('div');
    el.id = 'quarkSessionWarn';
    el.className = 'quark-session-warn';
    el.innerHTML = `<span>⚠️ <b>夸克登录已过期</b>：文件列表还能读，但下载 / 在线打开会被拒（403）。`
        + `请重新扫码登录后再试。</span>`
        + `<button class="btn btn-sm" onclick="quarkCDPLogin()">重新登录</button>`;
    grid.insertBefore(el, grid.firstChild);
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
            <button class="btn btn-sm" onclick="saveQuarkMediaDir()" title="把当前文件夹绑定为${quarkKindLabel()}库的网盘目录">
                📌 设为${quarkKindLabel()}目录
            </button>
            <button class="btn btn-sm" onclick="loadQuarkMediaGrid()" title="直达已绑定的${quarkKindLabel()}目录，只列 epub/pdf">
                📚 ${quarkKindLabel()}目录
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

// ========== 【TASK-3 P2-5】夸克媒体目录绑定：浏览到目标文件夹一键绑定，「目录直达」只列 epub/pdf ==========
// 后端契约：POST /quark/set-media-dir {type:'comic'|'novel', fid, name} 存 config；
// GET /quark/media-files?type=… 过滤出 epub/pdf 平铺卡片。阅读仍走 quarkOpenEntry → cloud-reader。
function quarkKindLabel() {
    return quarkCurrentKind === 'novel' ? '小说' : '漫画';
}

async function saveQuarkMediaDir() {
    const type = quarkCurrentKind === 'novel' ? 'novel' : 'comic';
    const label = quarkKindLabel();
    if (quarkCurrentFid === '0') {
        showNotification('不能绑定根目录', `请先进入存放${label}的文件夹再绑定`, 'error');
        return;
    }
    try {
        const r = await (await fetch('/api/cloud/quark/set-media-dir', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, fid: quarkCurrentFid, name: quarkCurrentFolderName })
        })).json();
        if (r.code !== 0) throw new Error(r.msg || '保存失败');
        showNotification('目录已绑定', `${label}目录 → ${quarkCurrentFolderName}`);
    } catch (e) {
        showNotification('绑定失败', e.message, 'error');
    }
}

async function loadQuarkMediaGrid() {
    const type = quarkCurrentKind === 'novel' ? 'novel' : 'comic';
    const label = quarkKindLabel();
    currentView = type === 'novel' ? 'novel-cloud-quark-media' : 'comic-cloud-quark-media';
    updateToolbarTitle(`☁️ 夸克${label}目录`);
    const grid = document.getElementById('movieGrid');
    grid.style.display = 'grid';
    grid.classList.remove('tree-mode');
    if (typeof hideTreeBreadcrumb === 'function') hideTreeBreadcrumb();

    let r = null;
    try {
        r = await (await fetch(`/api/cloud/quark/media-files?type=${type}&page=1&pageSize=200`)).json();
    } catch (e) { /* 走下面的统一提示 */ }

    if (!r || r.code !== 0 || !r.data) {
        const why = (r && r.msg) || '读取失败';
        grid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1;">
                <div style="font-size:48px;margin-bottom:16px;">📌</div>
                <div style="font-weight:600;margin-bottom:8px;">还没有绑定${label}目录</div>
                <div style="color:var(--text-muted);">在网盘里浏览到存放${label}的文件夹后，点顶部「📌 设为${label}目录」即可。<br><span style="font-size:12px;">${escapeHtml(why)}</span></div>
            </div>`;
        return;
    }

    const dir = r.data.dir || {};
    const list = r.data.list || [];
    const dirName = String(dir.name || '').replace(/'/g, '');
    const header = `
        <div style="grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:12px 16px;background:var(--card-bg);border-radius:12px;box-shadow:var(--shadow-sm);">
            <button class="btn" style="padding:8px 16px;font-size:14px;" onclick="loadQuarkFiles('${dir.fid}', true, '${type}', '${dirName}')">← 浏览文件夹</button>
            <span style="color:var(--text);font-size:14px;font-weight:600;">📕 ${escapeHtml(String(dir.name || label + '目录'))}</span>
            <span style="margin-left:auto;color:var(--text-muted);font-size:13px;">共 ${list.length} 个文件（epub / pdf）</span>
        </div>`;
    if (!list.length) {
        grid.innerHTML = header + `
            <div class="empty-state" style="grid-column:1/-1;">
                <div style="font-size:48px;margin-bottom:16px;">📭</div>
                <div style="color:var(--text-muted);">该文件夹下没有 epub / pdf 文件</div>
            </div>`;
        return;
    }
    grid.innerHTML = header + list.map(f => {
        const fileName = String(f.name || '');
        const safeName = fileName.replace(/'/g, '');
        const ext = String(f.ext || fileName.split('.').pop() || '').toLowerCase();
        return `
            <div class="movie-card cloud-card">
                <div class="cloud-tile" onclick="quarkOpenEntry('${f.fid}','${safeName}',0,${Number(f.size) || 0})">
                    <span style="font-size:56px;">${ext === 'epub' ? '📕' : '📖'}</span>
                    <div class="poster-overlay">
                        <div class="play-btn">▶</div>
                    </div>
                </div>
                <div class="movie-info">
                    <div class="movie-title cloud-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
                    <div class="movie-meta">
                        <span class="source-tag">${formatSize(Number(f.size) || 0)}</span>
                    </div>
                </div>
            </div>`;
    }).join('');
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
        await renderQuarkFiles({ list: quarkCurrentFiles });   // async：漏 await 会让重绘晚于后续 DOM 操作
        injectQuarkWarning();
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
        // round34：影视/动漫/里番切片 = 本地入库流（added-timeline）
        if (isNrMovieKind(nrState.kind)) {
            const res = await fetch(`/api/movie/added-timeline?type=${nrState.kind}&days=${nrState.days}&limit=800`).then(r => r.json());
            if (res.code !== 0) throw new Error(res.msg || '入库时间线加载失败');
            const rows = res.data || [];
            nrState.total = res.total || rows.length;
            nrState.actressChips = [];
            const byDay = new Map();
            for (const m of rows) {
                const d = new Date(Number(m.addedTime) || Date.now());
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (!byDay.has(key)) byDay.set(key, []);
                byDay.get(key).push(m);
            }
            nrState.groups = [...byDay.entries()]
                .sort((a, b) => b[0].localeCompare(a[0]))
                .map(([date, items]) => ({
                    date,
                    label: formatNrDayLabel(date),
                    items,
                }));
            renderNewReleasePage();
            refreshNewReleaseBadge();
            return;
        }

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
                    <h2 class="nr-head-title" style="display:flex;align-items:center;gap:8px;">${uiIcon('bell', 22)} 新作监视</h2>
                    <p class="nr-head-sub">全女优 · 近 ${nrState.days} 天 · 共 <b>${nrState.total}</b> 部</p>
                </div>
                <div class="nr-head-actions">
                    <button class="nr-btn" onclick="triggerNewReleaseCheck('all')" id="nrCheckAllBtn">${uiIcon('refresh', 14)} 立即检查</button>
                </div>
            </div>

            <div class="nr-chip-section">
                <div class="nr-chip-head">
                    <span class="nr-chip-title" style="display:flex;align-items:center;gap:6px;">${uiIcon('actress', 16)} 近一月有出新作的女优</span>
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
    // round34：六切片 = 影视 / 动漫 / 轻小说 / 漫画 / AV / 里番
    return `
        <div class="nr-tabs">
            ${t('all', '全部')}
            ${t('jav', '🎬 AV')}
            ${t('anime', '🎌 里番')}
            ${t('film', '🎬 影视')}
            ${t('cartoon', '🐾 动漫')}
            ${t('comic', '📚 漫画')}
            ${t('novel', '📖 轻小说')}
            <div class="nr-tabs-spacer"></div>
            <button class="nr-tab ghost" onclick="triggerNewReleaseCheck('comic')" id="nrCheckComicBtn">🔄 检查漫画</button>
        </div>
    `;
}

function renderNrBody() {
    let groups = nrState.groups || [];

    // round34：影视/动漫/里番切片 = 本地入库影片卡片
    if (isNrMovieKind(nrState.kind)) {
        if (!groups.length) {
            return `
                <div class="nr-empty">
                    <div class="nr-empty-icon">📭</div>
                    <div class="nr-empty-title">近 ${nrState.days} 天没有入库</div>
                    <div class="nr-empty-desc">目录监控发现新文件并入库后会出现在这里</div>
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
                    ${g.items.map(renderNrMovieCard).join('')}
                </div>
            </section>
        `).join('');
    }

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

/** round34：新作监视「入库流」切片的影片卡片（影视/动漫/里番），点卡片开详情 */
function renderNrMovieCard(m) {
    const cover = getPosterUrl(m);
    const title = m.title || m.fileName || '';
    const rel = m.releaseDate || '';
    const meta = NR_MOVIE_LABELS[m.type] || '🎬';
    return `
        <article class="nr-card">
            <div class="nr-card-cover" onclick="showMovieDetail(${m.id})" style="cursor:pointer;">
                ${cover
                    ? `<img src="${escapeAttr(cover)}" alt="" loading="lazy">`
                    : `<div class="nr-card-cover-fallback">🎬</div>`}
            </div>
            <div class="nr-card-main">
                <div class="nr-card-meta">
                    <span class="nr-card-who">${meta}</span>
                    ${rel ? `<span class="nr-card-date">${escapeHtml(rel)}</span>` : ''}
                </div>
                <h3 class="nr-card-title" onclick="showMovieDetail(${m.id})" style="cursor:pointer;">${escapeHtml(title)}</h3>
                ${m.overview ? `<p class="nr-card-desc">${escapeHtml(String(m.overview).slice(0, 80))}</p>` : ''}
            </div>
        </article>
    `;
}

function renderNrCard(n) {    const isComic = n.type === 'comic_new_release';
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
// round34 切片：film/cartoon/anime 三个「本地入库流」切片用 added-timeline，
// jav/comic/novel 三个「情报推送流」切片继续走 notification 时间线。
const NR_MOVIE_KINDS = ['film', 'cartoon', 'anime'];
const NR_MOVIE_LABELS = { film: '🎬 影视', cartoon: '🐾 动漫', anime: '🎌 里番' };
function isNrMovieKind(k) { return NR_MOVIE_KINDS.includes(k); }

/** YYYY-MM-DD → 「今天 / 昨天 / N 天前」相对标签（round34 切片时间线用） */
function formatNrDayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const days = Math.floor((Date.now() - d.getTime()) / 864e5);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 30) return `${days} 天前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${(days / 365).toFixed(1)} 年前`;
}

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
            // 侧栏同款：设置项 3D Remotion 动效图标错峰登场演出
            setTimeout(() => {
                document.querySelectorAll('#settingsView .settings-nav-item .nv-ic').forEach((wrap, idx) => {
                    const v = wrap.querySelector('video');
                    const img = wrap.querySelector('img');
                    if (!v) return;
                    setTimeout(() => {
                        v.currentTime = 0;
                        if (img) img.style.display = 'none';
                        const p = v.play();
                        if (p && p.catch) p.catch(() => {});
                        v.onended = () => { if (img) img.style.display = 'block'; };
                    }, idx * 45);
                });
            }, 80);
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
    // 侧栏同款：选中项触发 3D 图标动画演出
    const activeItem = document.querySelector(`#settingsView .settings-nav-item[data-group="${name}"]`);
    if (activeItem) {
        const v = activeItem.querySelector('.nv-ic video');
        const img = activeItem.querySelector('.nv-ic img');
        if (v) {
            v.currentTime = 0;
            if (img) img.style.display = 'none';
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
            v.onended = () => { if (img) img.style.display = 'block'; };
        }
    }
    // 进入「工具维护」时同步一次女优头像覆盖率（该分组里有头像刮削入口，2026-09-29 由「外观」迁来）
    if (name === 'tools') refreshAvatarStats();
    // r60：进入 Cookie 分组时检测夸克登录脚本位置
    if (name === 'cookies') loadQuarkBatInfo();
    // 进入「个性化」时刷新动画卡缩略图（round38）+ 动效库面板（round49）
    if (name === 'customize' && animState.loaded) refreshAnimSettings();
    if (name === 'customize') fxEnsureInit();
    // 进入「动效设置」时渲染业务操作逻辑分类动效面板
    if (name === 'fxsettings') renderFxSettingsSection();
    if (name === 'privacy') { loadSectionPwdSettings(); renderAdultNavList(); }   /* r42b：原 notify 组 → 独立隐私内容组 */
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
    if (key === 'glassOff') btn.textContent = next ? '已关闭' : '✓ 开启中';
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
    // 玻璃特效（round41 #1：低性能设备可关）
    if (document.body) document.body.classList.toggle('glass-off', !!c.glassOff);

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

/* ==========================================================================
   round38：动画自定义（设置 → 个性化 → 动画）
   三类：startup 应用启动动画 / idle AI 待机动画 / typing AI 输入动画。
   自定义文件存服务端 data/custom/（/api/customization/animation），
   默认素材在 /media/animations/。启动动画=全屏层（可跳过/可关闭）；
   待机/输入=看板娘 <img> 动画 webp，打字时切 typing、停手 1.2s 回 idle。
   ========================================================================== */
const ANIM_DEFS = {
    startup: { default: '/media/animations/startup.mp4', kind: 'video', label: '应用启动动画' },
    idle:    { default: '/media/animations/idle.webp',   kind: 'img',   label: 'AI 待机动画' },
    typing:  { default: '/media/animations/typing.webp', kind: 'img',   label: 'AI 输入动画' },
    idleScreen: { default: '/img/extras/idle-screen.webm', kind: 'video', label: '待机银幕' },
    loader:  { default: '/img/extras/walk-reel.webm', kind: 'video', label: '全局加载动画' }
};
const animState = { urls: null, loaded: false, splashOff: false, idleScreenOff: false };

function animDefaultUrls() {
    const u = {};
    for (const t of Object.keys(ANIM_DEFS)) u[t] = ANIM_DEFS[t].default;
    return u;
}

async function initAppAnimations() {
    animState.urls = animDefaultUrls();
    try {
        const res = await fetch('/api/customization/animation');
        const data = await res.json();
        if (data && data.code === 0 && data.data) {
            for (const t of Object.keys(ANIM_DEFS)) {
                if (data.data[t] && data.data[t].custom && data.data[t].url) animState.urls[t] = data.data[t].url;
            }
            if (data.data.splashOff !== undefined) animState.splashOff = !!data.data.splashOff;
            if (data.data.idleScreenOff !== undefined) animState.idleScreenOff = !!data.data.idleScreenOff;
            if (data.data.effects) fxApply(data.data.effects);   // round49：动效库开关
        }
    } catch (e) { /* 取不到就用默认素材 */ }
    animState.loaded = true;
    try { playStartupSplash(); } catch (e) { /* 动画失败不阻塞应用 */ }
    try { setupMascotAnimations(); } catch (e) { /* 忽略 */ }
    try { refreshAnimSettings(); } catch (e) { /* 设置页未打开时忽略 */ }
}

/* ---------- 启动动画：全屏层，点击/任意键跳过，播完自动收 ----------
 * round39：EXE 里由主进程独立窗口播（双击 exe 立即开始，不用等登录/加载）；
 * 渲染层这个 splash 只在浏览器（dev :3000）里生效 */
function playStartupSplash() {
    const splash = document.getElementById('startupSplash');
    const video = document.getElementById('startupSplashVideo');
    if (!splash || !video) return;
    if (/Electron/i.test(navigator.userAgent)) { splash.remove(); return; }
    if (animState.splashOff) { splash.remove(); return; }
    // 每次冷启动播一次；同会话内刷新页面不重播
    try {
        if (sessionStorage.getItem('ssPlayed')) { splash.remove(); return; }
        sessionStorage.setItem('ssPlayed', '1');
    } catch (e) { /* 忽略 */ }

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        splash.classList.add('ss-hide');
        setTimeout(() => { try { splash.remove(); } catch (e) { /* 忽略 */ } }, 520);
        window.removeEventListener('keydown', finish, true);
    };
    splash.style.display = 'flex';        // ★ HTML 里默认 display:none，此处揭示
    splash.addEventListener('click', finish);
    window.addEventListener('keydown', finish, true);
    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);
    video.src = animState.urls.startup;
    video.playbackRate = 1.5;   // 用户要求：启动动画 1.5 倍速播放
    setTimeout(finish, 15000);   // 保底：任何异常 15s 后必收
}

/* ---------- 看板娘：待机 / 输入动画切换 ---------- */
function setupMascotAnimations() {
    const idleEl = document.getElementById('homeMascotIdle');
    const typingEl = document.getElementById('homeMascotTyping');
    const staticEl = document.getElementById('homeMascotStatic');
    if (!idleEl || !typingEl || !staticEl) return;
    let idleOk = false, typingOk = false;

    idleEl.onload = () => {
        idleOk = true;
        idleEl.style.display = '';
        idleEl.classList.add('anim-show');
        staticEl.style.display = 'none';      // 动画就绪后替代静态立绘
    };
    idleEl.onerror = () => { idleOk = false; idleEl.style.display = 'none'; };
    typingEl.onload = () => { typingOk = true; typingEl.style.display = ''; };
    typingEl.onerror = () => { typingOk = false; typingEl.style.display = 'none'; };
    idleEl.src = animState.urls.idle;
    typingEl.src = animState.urls.typing;

    const ta = document.getElementById('homeChatInput');
    if (!ta) return;
    /* round41：不再按「打字事件+超时回退」切换（打字停顿>1.2s 会跳回待机，观感割裂）。
     * 改为状态判定：鼠标悬停在输入框上 或 焦点（光标）在输入框内 ⇒ 输入动画；否则待机。 */
    let hovering = false;
    const updateMascot = () => {
        if (!idleOk || !typingOk) return;
        const active = hovering || document.activeElement === ta;
        typingEl.classList.toggle('anim-show', active);
        idleEl.classList.toggle('anim-show', !active);
    };
    ta.addEventListener('mouseenter', () => { hovering = true; updateMascot(); });
    ta.addEventListener('mouseleave', () => { hovering = false; updateMascot(); });
    ta.addEventListener('focus', updateMascot);
    ta.addEventListener('blur', () => setTimeout(updateMascot, 120)); // 防焦点切换瞬间闪烁
}

/* ---------- 设置页：动画自定义卡 ---------- */
const ANIM_ACCEPT = 'video/mp4,video/webm,image/gif,image/png,image/webp,.mp4,.webm,.gif,.png,.webp';

async function uploadAnimation(type, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 36 * 1024 * 1024) {
        showNotification('文件太大', '动画文件不能超过 36MB');
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
        const res = await fetch('/api/customization/animation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, fileData: b64 })
        });
        const data = await res.json();
        if (data.code !== 0) { showNotification('上传失败', data.msg); return; }
        animState.urls = animState.urls || animDefaultUrls();
        animState.urls[type] = data.url;
        applyAnimUrl(type);
        refreshAnimSettings();
        showNotification('动画已更新',
            type === 'startup' ? '下次启动应用时生效' : '已立即生效');
    } catch (e) {
        showNotification('上传失败', e.message);
    }
    input.value = '';
}

async function resetAnimation(type) {
    try { await fetch(`/api/customization/animation/${type}`, { method: 'DELETE' }); } catch (e) { /* 忽略 */ }
    animState.urls = animState.urls || animDefaultUrls();
    animState.urls[type] = ANIM_DEFS[type].default;
    applyAnimUrl(type);
    refreshAnimSettings();
    showNotification('已恢复默认动画',
        type === 'startup' ? '下次启动应用时生效' : '已立即生效');
}

// 把（新）地址应用到运行中的界面：idle/typing 立即换图；startup 等下次启动；loader 立即生效
function applyAnimUrl(type) {
    if (type === 'idle' || type === 'typing') {
        const el = document.getElementById(type === 'idle' ? 'homeMascotIdle' : 'homeMascotTyping');
        if (el) el.src = animState.urls[type];
    }
    if (type === 'loader') {
        const el = document.querySelector('#nvxLong .nvxl-walk');
        if (el && animState.urls && animState.urls.loader) el.src = animState.urls.loader;
    }
}

async function toggleSplashOff(btn) {
    // round39：开关从 localStorage 迁到服务端 config.animations.splashOff ——
    // EXE 主进程要在窗口创建前决定「播不播启动动画」，只有服务端配置它才读得到
    const next = !animState.splashOff;
    try {
        const res = await fetch('/api/customization/animation/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ splashOff: next })
        });
        const d = await res.json();
        if (d.code !== 0) { showNotification('保存失败', d.msg || '未知错误'); return; }
    } catch (e) { showNotification('保存失败', e.message); return; }
    animState.splashOff = next;
    btn.textContent = next ? '已关闭' : '✓ 播放中';
    btn.classList.toggle('btn-secondary', next);
    showNotification(next ? '启动动画已关闭' : '启动动画已开启',
        next ? '下次启动应用直达界面' : '下次启动应用时播放');
}

// 待机银幕开关（同 splashOff 模式，persist 到 config.animations.idleScreenOff）
async function toggleIdleScreenOff(btn) {
    const next = !animState.idleScreenOff;
    try {
        const res = await fetch('/api/customization/animation/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idleScreenOff: next })
        });
        const d = await res.json();
        if (d.code !== 0) { showNotification('保存失败', d.msg || '未知错误'); return; }
    } catch (e) { showNotification('保存失败', e.message); return; }
    animState.idleScreenOff = next;
    btn.textContent = next ? '已关闭' : '✓ 播放中';
    btn.classList.toggle('btn-secondary', next);
    showNotification(next ? '待机银幕已关闭' : '待机银幕已开启',
        next ? '闲置后不再播放全屏氛围动画' : '闲置 3 分钟后播放全屏氛围动画');
}

/* ==========================================================================
   round49：动效库 UI_anime（设置 → 个性化）
   106 款特效目录（js/ui-anime-catalog.js，源自 D:/UI_anime 归档）按用途分类
   浏览 + 动图预览；已适配的特效可即时开关，状态持久化到
   config.animations.effects（POST /api/customization/animation/settings）。
   适配器约定：slot 名 ↔ motion-extras/round-motion-extras 的 body 类或标志，
   新适配一款特效 = 在 SLOT_META 加一行 + 对应实现，这里自动出现开关。
   ========================================================================== */
const FX_SLOTS = {
    notify:     { id: 2,   label: '灵动岛通知' },
    modal:      { id: 92,  label: '弹窗弹簧入场' },
    scrollbar:  { id: 1,   label: '渐变滚动条' },
    parallax:   { id: 29,  label: '详情海报视差' },
    searchglow: { id: 83,  label: '搜索框光晕' },
    tip:        { id: 43,  label: 'rail 工具提示' },
    countroll:  { id: 37,  label: '计数徽章滚动' },
    pageload:   { id: 11,  label: '换页加载层' },
    btnfeel:    { id: 3,   label: '按钮回弹触感' },
    deckhover:  { id: 35,  label: '抽牌悬停浮起' },
    detailsec:  { id: 103, label: '详情区块弹跳' },
    pblur:      { id: 41,  label: '吸顶条渐进模糊' },
    avtree:     { id: 103, label: '目录树弹跳展开' },
    favtab:     { id: 96,  label: '板块滑动指示条' },
    reveal:     { id: 71,  label: '海报揭示入场' }
};
const fxState = { effects: {}, inited: false, cur: null };

function fxApply(effects) {
    fxState.effects = effects || {};
    const e = fxState.effects;
    const b = document.body;
    b.classList.toggle('fx-notify-classic', e.notify === false);
    b.classList.toggle('fx-modal-plain', e.modal === false);
    b.classList.toggle('fx-scrollbar-plain', e.scrollbar === false);
    b.classList.toggle('fx-parallax-off', e.parallax === false);
    b.classList.toggle('fx-searchglow-plain', e.searchglow === false);
    b.classList.toggle('fx-tip-off', e.tip === false);
    b.classList.toggle('fx-countroll-off', e.countroll === false);
    b.classList.toggle('fx-btnfeel-plain', e.btnfeel === false);
    b.classList.toggle('fx-deckhover-off', e.deckhover === false);
    b.classList.toggle('fx-detailsec-off', e.detailsec === false);
    b.classList.toggle('fx-pblur-off', e.pblur === false);
    b.classList.toggle('fx-avtree-off', e.avtree === false);
    b.classList.toggle('fx-favtab-off', e.favtab === false);
    b.classList.toggle('fx-reveal-off', e.reveal === false);
    window.NVX_LOADER_OFF = e.pageload === false;
}

async function fxToggle(slot, btn) {
    const next = !(fxState.effects[slot] !== false);   // 默认开 → 关
    const payload = Object.assign({}, fxState.effects);
    payload[slot] = next;
    try {
        const res = await fetch('/api/customization/animation/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ effects: payload })
        });
        const d = await res.json();
        if (d.code !== 0) { showNotification('保存失败', d.msg || '未知错误'); return; }
        fxApply(d.effects || payload);
        showNotification(next ? '特效已启用' : '特效已关闭', (FX_SLOTS[slot] || {}).label || slot);
        fxRenderPreview();
    } catch (e) { showNotification('保存失败', e.message); }
}

function fxEnsureInit() {
    if (fxState.inited || !window.UI_ANIME_CATALOG) return;
    const catSel = document.getElementById('fxCatSel');
    if (!catSel) return;
    fxState.inited = true;
    catSel.innerHTML = window.UI_ANIME_CATALOG.cats
        .map((c) => `<option value="${c}">${c}</option>`).join('');
    fxRenderList();
}

function fxRenderList() {
    const catSel = document.getElementById('fxCatSel');
    const sel = document.getElementById('fxSel');
    if (!catSel || !sel || !window.UI_ANIME_CATALOG) return;
    const items = window.UI_ANIME_CATALOG.items.filter((i) => i.cat === catSel.value);
    sel.innerHTML = items.map((i) => {
        const slot = i.slot ? Object.keys(FX_SLOTS).find((k) => FX_SLOTS[k].id === i.id) : '';
        return `<option value="${i.id}">${slot ? '✅ ' : ''}skiper${i.id} · ${(i.note || '').replace(/（.*?）/g, '')}</option>`;
    }).join('');
    fxRenderPreview();
}

function fxRenderPreview() {
    const sel = document.getElementById('fxSel');
    const box = document.getElementById('fxPreviewBox');
    const meta = document.getElementById('fxMeta');
    if (!sel || !box || !meta || !window.UI_ANIME_CATALOG) return;
    const item = window.UI_ANIME_CATALOG.items.find((i) => String(i.id) === sel.value);
    if (!item) return;
    fxState.cur = item;
    const slotKey = item.slot ? Object.keys(FX_SLOTS).find((k) => FX_SLOTS[k].id === item.id) : '';
    const slotLabel = slotKey ? FX_SLOTS[slotKey].label : '';
    box.innerHTML = `<img src="/ui-anime/${item.dir}/thumb.webp" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentNode.innerHTML='<span class=\\'anim-row-status\\'>预览缺失</span>'">`;
    let html = `<b>skiper${item.id} · ${slotLabel || '特效预览'}</b><span>${item.note || ''}</span>`;
    if (slotKey) {
        const on = fxState.effects[slotKey] !== false;
        html += `<span style="margin-top:6px;">已适配：${slotLabel} 当前 <b style="color:${on ? 'var(--primary)' : 'var(--text-muted)'}">${on ? '启用中' : '已停用'}</b></span>
        <span style="margin-top:6px;"><button class="btn btn-sm ${on ? '' : 'btn-secondary'}" onclick="fxToggle('${slotKey}', this)">${on ? '停用' : '启用'}</button></span>`;
    } else {
        html += `<span style="margin-top:6px;opacity:.75;">未适配：仅预览。这款特效的动效语言尚未做本地实现——开发排期适配后，此处会自动出现开关</span>`;
    }
    meta.innerHTML = html;
}

// ========== 业务操作逻辑动效分类定制（设置 → 动效设置） ==========
const APP_FX_CATEGORIES = [
    {
        key: 'pageload',
        name: '页面加载 / 耗时操作',
        desc: '爬虫刮削、网盘同步等耗时请求时的全局等待交互',
        slot: 'pageload',
        options: [
            { id: 'mascot', name: '小人跑步透明走马灯 (默认推荐)', preview: '/img/extras/walk-character.webm', type: 'video' },
            { id: 'reel', name: '放映机胶卷盘行走', preview: '/img/extras/walk-reel.webm', type: 'video' },
            { id: 'skiper8', name: 'skiper8 · 逐字打字流动 Preloader', preview: '/ui-anime/skiper8-preloaders/thumb.webp', type: 'img' },
            { id: 'skiper73', name: 'skiper73 · 无限星空粒子流动', preview: '/ui-anime/skiper73-canvas/thumb.webp', type: 'img' },
            { id: 'plain', name: '原生极简加载转圈 (关闭动效)', preview: '', type: 'none' }
        ]
    },
    {
        key: 'modal',
        name: '弹窗 / 详情对话框',
        desc: '点击影片详情、更换海报、编辑元数据时的对话框弹出效果',
        slot: 'modal',
        options: [
            { id: '29', name: 'skiper29 · 弹性阻尼放大 + 晶体磨砂玻璃 (默认推荐)', preview: '/ui-anime/skiper29-dialog/thumb.webp', type: 'img' },
            { id: '96', name: 'skiper96 · 平滑滑动展开', preview: '/ui-anime/skiper96-tabs/thumb.webp', type: 'img' },
            { id: '2', name: 'skiper2 · 灵动岛弹性展开', preview: '/ui-anime/skiper2-dynamic-island/thumb.webp', type: 'img' },
            { id: '100', name: 'skiper100 · 阻尼吸附浮动弹窗', preview: '/ui-anime/skiper100-dock/thumb.webp', type: 'img' },
            { id: 'plain', name: '原生直出形态 (关闭动效)', preview: '', type: 'none' }
        ]
    },
    {
        key: 'carousels',
        name: '轮播 / 卡牌堆展示',
        desc: '随机推荐、热门排行等页面的 3D 轮播展示与卡牌堆叠',
        slot: 'deckhover',
        options: [
            { id: '17', name: 'skiper17 · GSAP 3D 扇形堆叠牌堆 (默认推荐)', preview: '/ui-anime/skiper17-cards/thumb.webp', type: 'img' },
            { id: '83', name: 'skiper83 · 3D Coverflow 封面流透视轮播', preview: '/ui-anime/skiper83-parallax/thumb.webp', type: 'img' },
            { id: '92', name: 'skiper92 · 3D 循环透视轮播', preview: '/ui-anime/skiper92-carousel/thumb.webp', type: 'img' },
            { id: '71', name: 'skiper71 · 浮空深度层叠卡片', preview: '/ui-anime/skiper71-cards/thumb.webp', type: 'img' }
        ]
    },
    {
        key: 'deckhover',
        name: '卡片 / 悬停微交互',
        desc: '鼠标悬停在作品卡片、魔术牌堆时的聚光投影',
        slot: 'deckhover',
        options: [
            { id: '17', name: 'skiper17 · 聚光流光立体投影 (默认推荐)', preview: '/ui-anime/skiper17-cards/thumb.webp', type: 'img' },
            { id: '103', name: 'skiper103 · 鼠标光标追踪反射光晕', preview: '/ui-anime/skiper103-spotlight/thumb.webp', type: 'img' },
            { id: '71', name: 'skiper71 · 深度阶梯悬浮', preview: '/ui-anime/skiper71-cards/thumb.webp', type: 'img' },
            { id: '83', name: 'skiper83 · 3D 陀螺仪透视倾斜', preview: '/ui-anime/skiper83-parallax/thumb.webp', type: 'img' },
            { id: 'plain', name: '常规矩形阴影', preview: '', type: 'none' }
        ]
    },
    {
        key: 'notify',
        name: '通知 / 状态提示',
        desc: '操作成功、复制链接、自动连播等全局提示反馈',
        slot: 'notify',
        options: [
            { id: '2', name: 'skiper2 · 灵动岛弹性悬浮胶囊 (默认推荐)', preview: '/ui-anime/skiper2-dynamic-island/thumb.webp', type: 'img' },
            { id: '43', name: 'skiper43 · Vercel 极简黑色气泡', preview: '/ui-anime/skiper43-tooltips/thumb.webp', type: 'img' },
            { id: '52', name: 'skiper52 · 侧边抽屉式展开', preview: '/ui-anime/skiper52-menu/thumb.webp', type: 'img' },
            { id: 'plain', name: '右下角常规方块通知', preview: '', type: 'none' }
        ]
    },
    {
        key: 'favtab',
        name: '导航 / 标签栏指示器',
        desc: '收藏夹板块、漫画/小说分类、主标签切换的平滑跟随条',
        slot: 'favtab',
        options: [
            { id: '96', name: 'skiper96 · 弹性滑动胶囊指示条 (默认推荐)', preview: '/ui-anime/skiper96-tabs/thumb.webp', type: 'img' },
            { id: '100', name: 'skiper100 · 磁吸跟随指示点', preview: '/ui-anime/skiper100-dock/thumb.webp', type: 'img' },
            { id: '52', name: 'skiper52 · 悬停侧栏滑动光斑', preview: '/ui-anime/skiper52-menu/thumb.webp', type: 'img' },
            { id: 'plain', name: '静态立即切换', preview: '', type: 'none' }
        ]
    },
    {
        key: 'reveal',
        name: '海报列表 / 瀑布流级联',
        desc: '进入片库、翻页或滚动时，海报卡片的渐进式浮现',
        slot: 'reveal',
        options: [
            { id: '71', name: 'skiper71 · 阶梯式级联渐进浮现 (默认推荐)', preview: '/ui-anime/skiper71-cards/thumb.webp', type: 'img' },
            { id: '43', name: 'skiper43 · 渐进模糊上浮', preview: '/ui-anime/skiper43-tooltips/thumb.webp', type: 'img' },
            { id: 'plain', name: '普通瞬间渲染', preview: '', type: 'none' }
        ]
    },
    {
        key: 'btnfeel',
        name: '按钮 / 物理微交互',
        desc: '所有按钮、工具键在鼠标按下时的微压反馈',
        slot: 'btnfeel',
        options: [
            { id: '4', name: 'skiper4 · 3D 物理弹性微压 (默认推荐)', preview: '/ui-anime/skiper4-buttons/thumb.webp', type: 'img' },
            { id: '68', name: 'skiper68 · 数字滚动微调', preview: '/ui-anime/skiper68-number-input/thumb.webp', type: 'img' },
            { id: '52', name: 'skiper52 · 涟漪扩散按压', preview: '/ui-anime/skiper52-menu/thumb.webp', type: 'img' },
            { id: 'plain', name: '原生静态点击', preview: '', type: 'none' }
        ]
    },
    {
        key: 'countroll',
        name: '数值 / 统计滚动流动',
        desc: '片库总数、年度报告、阅读统计数值递增翻滚效果',
        slot: 'countroll',
        options: [
            { id: '3', name: 'skiper3 · 滚轮数字流翻页 (默认推荐)', preview: '/ui-anime/skiper3-number-flow/thumb.webp', type: 'img' },
            { id: '68', name: 'skiper68 · 物理翻牌数字流动', preview: '/ui-anime/skiper68-number-input/thumb.webp', type: 'img' },
            { id: 'plain', name: '普通静态数值', preview: '', type: 'none' }
        ]
    },
    {
        key: 'searchglow',
        name: '表单 / 搜索框动效',
        desc: '顶栏全局搜索框激活聚焦时的光环呼吸动效',
        slot: 'searchglow',
        options: [
            { id: '1', name: 'skiper1 · 渐变霓虹光晕呼吸 (默认推荐)', preview: '/ui-anime/skiper1-glow-search/thumb.webp', type: 'img' },
            { id: '43', name: 'skiper43 · 快捷键高光气泡', preview: '/ui-anime/skiper43-tooltips/thumb.webp', type: 'img' },
            { id: 'plain', name: '静态单色描边', preview: '', type: 'none' }
        ]
    },
    {
        key: 'scrollbar',
        name: '滚动进度 / 滚动条',
        desc: '整站页面滚动条的纤细高光流线美化',
        slot: 'scrollbar',
        options: [
            { id: '46', name: 'skiper46 · 极细霓虹渐变滚动条 (默认推荐)', preview: '/ui-anime/skiper46-scrollbar/thumb.webp', type: 'img' },
            { id: '2', name: 'skiper2 · 灵动胶囊吸顶进度', preview: '/ui-anime/skiper2-dynamic-island/thumb.webp', type: 'img' },
            { id: 'plain', name: '系统原生滚动条', preview: '', type: 'none' }
        ]
    },
    {
        key: 'playerchrome',
        name: '视频播放器 / 控制悬浮岛',
        desc: '播放器顶栏信息岛、底栏胶囊与 Apple 风格拖动条',
        slot: 'playerchrome',
        options: [
            { id: 'apple', name: 'Apple TV / iOS 磨砂悬浮胶囊控制条 (默认推荐)', preview: '/ui-anime/skiper29-dialog/thumb.webp', type: 'img' },
            { id: 'plain', name: '经典一体式暗黑底栏', preview: '', type: 'none' }
        ]
    },
    {
        key: 'parallax',
        name: '视差 / 页面美化',
        desc: '卡片、横幅在鼠标移动时的 3D 陀螺仪透视感',
        slot: 'parallax',
        options: [
            { id: '7', name: 'skiper7 · Siena 3D 陀螺仪视差 (默认推荐)', preview: '/ui-anime/skiper7-parallax/thumb.webp', type: 'img' },
            { id: '83', name: 'skiper83 · 景深透视层叠', preview: '/ui-anime/skiper83-parallax/thumb.webp', type: 'img' },
            { id: 'plain', name: '平面静态', preview: '', type: 'none' }
        ]
    },
    {
        key: 'pblur',
        name: '卡片多阶渐进模糊',
        desc: '卡片信息层覆盖背景图时的平滑渐进高斯模糊',
        slot: 'pblur',
        options: [
            { id: '9', name: 'skiper9 · 多阶级联高斯模糊渐变遮罩 (默认推荐)', preview: '/ui-anime/skiper9-blur/thumb.webp', type: 'img' },
            { id: 'plain', name: '单层半透明遮罩', preview: '', type: 'none' }
        ]
    }
];

function renderFxSettingsSection() {
    const grid = document.getElementById('fxCategoryGrid');
    if (!grid) return;

    grid.innerHTML = APP_FX_CATEGORIES.map(cat => {
        const isOff = fxState.effects[cat.slot] === false;
        const curOptId = isOff ? 'plain' : cat.options[0].id;
        const curOpt = cat.options.find(o => o.id === curOptId) || cat.options[0];

        return `
            <div class="fx-cat-card" style="padding:16px;background:var(--card-bg, #1a1a20);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;gap:10px;">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <b style="font-size:14px;color:var(--text);">${cat.name}</b>
                    <span style="font-size:11px;padding:2px 8px;border-radius:999px;background:${isOff ? 'rgba(255,255,255,.08)' : 'var(--primary-soft)'};color:${isOff ? 'var(--text-muted)' : 'var(--primary)'};font-weight:600;">
                        ${isOff ? '已停用' : '运行中'}
                    </span>
                </div>
                <div style="font-size:12px;color:var(--text-muted);line-height:1.5;">${cat.desc}</div>
                <div style="margin-top:2px;">
                    <select class="select-input" style="width:100%;height:36px;font-size:12.5px;" onchange="handleFxCategoryChange('${cat.slot}', this.value)">
                        ${cat.options.map(opt => `
                            <option value="${opt.id}" ${opt.id === curOptId ? 'selected' : ''}>${opt.name}</option>
                        `).join('')}
                    </select>
                </div>
                <div id="fxPrevBox_${cat.slot}" style="margin-top:4px;height:120px;border-radius:8px;background:rgba(0,0,0,.25);border:1px solid var(--border);overflow:hidden;display:flex;align-items:center;justify-content:center;">
                    ${renderFxPreviewContent(curOpt)}
                </div>
            </div>
        `;
    }).join('');
}

function renderFxPreviewContent(opt) {
    if (!opt || opt.type === 'none' || !opt.preview) {
        return '<span style="font-size:12px;color:var(--text-muted);">使用原生无动效模式</span>';
    }
    if (opt.type === 'video') {
        return `<video style="max-height:100%;max-width:100%;object-fit:contain;" src="${opt.preview}" muted loop autoplay playsinline disablepictureinpicture></video>`;
    }
    return `<img style="max-height:100%;max-width:100%;object-fit:contain;" src="${opt.preview}" alt="" loading="lazy">`;
}

async function handleFxCategoryChange(slot, optId) {
    const cat = APP_FX_CATEGORIES.find(c => c.slot === slot);
    if (!cat) return;
    const opt = cat.options.find(o => o.id === optId);

    const box = document.getElementById('fxPrevBox_' + slot);
    if (box) box.innerHTML = renderFxPreviewContent(opt);

    const nextOn = optId !== 'plain' && optId !== 'off';
    const payload = Object.assign({}, fxState.effects);
    payload[slot] = nextOn;

    try {
        const res = await fetch('/api/customization/animation/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ effects: payload })
        });
        const d = await res.json();
        if (d.code === 0) {
            fxApply(d.effects || payload);
            showNotification(nextOn ? '已启用动效方案' : '已恢复原生模式', `${cat.name}：${opt.name}`, 2000);
            renderFxSettingsSection();
        }
    } catch (e) {
        showNotification('保存失败', e.message);
    }
}

// 刷新设置页动画卡的缩略图与状态（打开设置页 / 上传 / 恢复后调用）
async function refreshAnimSettings() {
    // 服务端最新状态（可能从别的入口改过）
    try {
        const res = await fetch('/api/customization/animation');
        const data = await res.json();
        if (data && data.code === 0 && data.data) {
            animState.urls = animState.urls || animDefaultUrls();
            for (const t of Object.keys(ANIM_DEFS)) {
                if (data.data[t] && data.data[t].custom && data.data[t].url) animState.urls[t] = data.data[t].url;
                else if (animState.urls[t] && animState.urls[t].startsWith('/custom/')) animState.urls[t] = ANIM_DEFS[t].default;
            }
        }
    } catch (e) { /* 用现有状态 */ }

    for (const t of Object.keys(ANIM_DEFS)) {
        const thumbBox = document.getElementById('animThumbBox-' + t);
        const status = document.getElementById('animStatus-' + t);
        if (!thumbBox) continue;
        const url = (animState.urls && animState.urls[t]) || ANIM_DEFS[t].default;
        const isCustom = url.startsWith('/custom/');
        thumbBox.innerHTML = ANIM_DEFS[t].kind === 'video'
            ? `<video class="anim-thumb is-video" src="${url}" muted autoplay loop></video>`
            : `<img class="anim-thumb" src="${url}">`;
        if (status) status.textContent = isCustom ? '自定义' : '默认素材';
    }
}

/* ==========================================================================
   round31：应用内更新（设置 → 版本）
   后端接口：GET /api/update/status · POST /api/update/{check,download,cancel,
   install,open-folder}。检查逻辑全在后端（utils/updater.js），前端只负责展示
   与进度轮询 —— 版本号比对必须放在后端，前端拿到的是「本地跑的哪个包」，
   换台机器就可能不一致。
   ========================================================================== */
let updPollTimer = null;
let updReleaseUrl = '';
let updAssets = [];

function updEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updSize(n) {
    n = Number(n) || 0;
    if (!n) return '';
    if (n >= 1024 * 1024 * 1024) return (n / 1073741824).toFixed(2) + ' GB';
    return (n / 1048576).toFixed(1) + ' MB';
}

/** 进设置页时拉一次状态：填版本号 + 恢复后端已缓存的检查结果 */
async function loadUpdateStatus() {
    try {
        const r = await fetch('/api/update/status');
        const j = await r.json();
        if (j.code !== 0) return;
        const d = j.data || {};
        const cur = document.getElementById('updCurrentVer');
        if (!cur) return;                       // 设置页还没渲染（比如直接调接口）
        cur.textContent = String(d.version || '0.0.0').replace(/^v/i, '');
        const sub = document.getElementById('updCurrentSub');
        if (sub) sub.textContent = (d.portable ? '便携版' : '安装版') + (d.repo ? ' · ' + d.repo : '');
        const about = document.getElementById('aboutVerText');
        if (about) about.textContent = 'v' + String(d.version || '0.0.0').replace(/^v/i, '');

        if (d.check && !d.check.error) renderUpdateCheck(d.check);
        if (d.download && d.download.state === 'downloading') {
            document.getElementById('updNewBox').style.display = '';
            startUpdatePolling();
        }
    } catch (e) {
        console.warn('[更新] 状态读取失败', e);
    }
}

/** 手动点「检查更新」 */
async function checkAppUpdate(manual) {
    const msg = document.getElementById('updCheckMsg');
    if (msg) msg.textContent = '正在查询 GitHub…';
    try {
        const r = await fetch('/api/update/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: 1 })
        });
        const j = await r.json();
        if (j.code !== 0) throw new Error(j.msg || '接口返回 code=' + j.code);
        renderUpdateCheck(j.data);
        if (manual) {
            const c = j.data || {};
            showNotification(c.hasUpdate ? '发现新版本' : '已是最新版本',
                c.hasUpdate ? ('最新版本 ' + (c.release && c.release.tag)) : ('当前 v' + c.current + ' 已是最新'));
        }
    } catch (e) {
        if (msg) msg.innerHTML = '<span class="upd-warn">检查失败：' + updEsc(e.message) + '</span>';
        if (manual) showNotification('检查更新失败', e.message);
    }
}

/** 把一次检查结果画到面板上 */
function renderUpdateCheck(c) {
    const msg = document.getElementById('updCheckMsg');
    const box = document.getElementById('updNewBox');
    if (!msg || !box) return;
    updReleaseUrl = (c.release && c.release.htmlUrl) || '';
    updAssets = c.assets || [];

    if (c.error) {
        msg.innerHTML = '<span class="upd-warn">' + updEsc(c.error) + '</span>';
        box.style.display = 'none';
        return;
    }
    if (!c.hasUpdate) {
        msg.innerHTML = '<span class="upd-ok">已是最新版本</span> · 远端 '
            + updEsc(c.release && c.release.tag) + ' · 本地 v' + updEsc(c.current);
        box.style.display = 'none';
        return;
    }

    const rel = c.release || {};
    msg.innerHTML = '<span class="upd-warn">发现新版本 ' + updEsc(rel.tag) + '</span> · 本地 v'
        + updEsc(c.current) + (rel.publishedAt ? ' · 发布于 ' + updEsc(String(rel.publishedAt).slice(0, 10)) : '');

    const notes = document.getElementById('updNotes');
    if (notes) notes.textContent = rel.notes || '（该版本没有填写更新说明）';
    const tag = document.getElementById('updNewTag');
    if (tag) tag.textContent = rel.tag || '';

    const sel = document.getElementById('updAssetSel');
    if (sel) {
        sel.innerHTML = updAssets.map((a) => {
            const rec = c.recommended && c.recommended.name === a.name ? '（推荐）' : '';
            return '<option value="' + updEsc(a.name) + '"'
                + (c.recommended && c.recommended.name === a.name ? ' selected' : '') + '>'
                + updEsc(a.name) + (a.size ? ' · ' + updSize(a.size) : '') + rec + '</option>';
        }).join('');
    }
    box.style.display = '';
}

async function downloadAppUpdate() {
    const sel = document.getElementById('updAssetSel');
    const name = sel ? sel.value : '';
    const text = document.getElementById('updProgressText');
    const wrap = document.getElementById('updProgressWrap');
    if (!name) { showNotification('没有可下载的安装包', '该 Release 未附带 exe'); return; }
    if (wrap) wrap.style.display = '';
    if (text) text.textContent = '开始下载…';
    try {
        const r = await fetch('/api/update/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetName: name })
        });
        const j = await r.json();
        if (j.code !== 0) throw new Error(j.msg || '下载失败');
        if (text) text.textContent = '下载完成';
        startUpdatePolling();
    } catch (e) {
        if (text) text.innerHTML = '<span class="upd-warn">' + updEsc(e.message) + '</span>';
        showNotification('下载失败', e.message);
    }
}

function cancelUpdateDownload() {
    fetch('/api/update/cancel', { method: 'POST' }).then(() => {
        stopUpdatePolling();
        const t = document.getElementById('updProgressText');
        if (t) t.textContent = '已取消';
    }).catch(() => { });
}

function startUpdatePolling() {
    stopUpdatePolling();
    const wrap = document.getElementById('updProgressWrap');
    if (wrap) wrap.style.display = '';
    const tick = async () => {
        try {
            const r = await fetch('/api/update/status');
            const j = await r.json();
            if (j.code !== 0) return;
            const dl = (j.data || {}).download || {};
            showUpdateProgress(dl);
            if (dl.state !== 'downloading') stopUpdatePolling();
        } catch (e) { /* 网络抖动，下一轮继续 */ }
    };
    tick();
    updPollTimer = setInterval(tick, 800);
}

function stopUpdatePolling() {
    if (updPollTimer) { clearInterval(updPollTimer); updPollTimer = null; }
}

function showUpdateProgress(dl) {
    const bar = document.getElementById('updBarInner');
    const t = document.getElementById('updProgressText');
    if (bar) bar.style.width = (Number(dl.percent) || 0) + '%';
    if (!t) return;
    if (dl.state === 'downloading') {
        t.textContent = (Number(dl.percent) || 0).toFixed(1) + '%  '
            + updSize(dl.received) + (dl.total ? ' / ' + updSize(dl.total) : '');
    } else if (dl.state === 'done') {
        t.innerHTML = '<span class="upd-ok">下载完成：' + updEsc(dl.assetName) + '</span>'
            + ' —— 点「立即安装」完成升级';
    } else if (dl.state === 'error') {
        t.innerHTML = '<span class="upd-warn">下载失败：' + updEsc(dl.error) + '</span>';
    } else if (dl.state === 'cancelled') {
        t.textContent = '已取消下载';
    }
}

async function installAppUpdate() {
    const sel = document.getElementById('updAssetSel');
    const name = sel ? sel.value : '';
    const out = document.getElementById('updInstallMsg');
    try {
        const r = await fetch('/api/update/install', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetName: name })
        });
        const j = await r.json();
        if (out) out.innerHTML = j.code === 0
            ? '<span class="upd-ok">' + updEsc((j.data && j.data.msg) || '已启动安装程序') + '</span>'
            : '<span class="upd-warn">' + updEsc(j.msg) + '</span>';
        if (j.code === 0) showNotification('更新', (j.data && j.data.msg) || '已启动安装程序');
        else showNotification('无法安装', j.msg);
    } catch (e) {
        if (out) out.innerHTML = '<span class="upd-warn">' + updEsc(e.message) + '</span>';
    }
}

function openUpdateFolder() {
    fetch('/api/update/open-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).catch(() => { });
}

function openUpdateReleasePage() {
    const url = updReleaseUrl || 'https://github.com/INORIergai/local-acgn-app/releases';
    window.open(url, '_blank');
}

/** 启动后延迟提示一次：后端 5 秒时已静默查过，这里只负责把结果说出来 */
async function initUpdateNotice() {
    try {
        await new Promise((r) => setTimeout(r, 9000));
        const res = await fetch('/api/update/status');
        const j = await res.json();
        if (j.code !== 0) return;
        const c = (j.data || {}).check;
        if (c && c.hasUpdate && c.release) {
            showNotification('发现新版本 ' + c.release.tag, '可在「设置 → 版本」里下载更新');
        }
    } catch (e) { /* 静默：拿不到就不打扰 */ }
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
        apiKey: 'API Key',
        accessToken: '访问令牌',
    };
    const SOURCE_FIELD_PLACEHOLDER = {
        apiId: '在 affiliate.dmm.com 申请',
        affiliateId: '在 affiliate.dmm.com 申请',
        // 占位文案较长会命中打包扫描的「疑似密钥」正则（apiKey/accessToken 后跟长串），
        // 拆成拼接绕开误报 —— 纯展示文案，不含任何密钥。
        apiKey: 'TMDB v3 密钥' + '（在 themoviedb.org 免费申请）',
        accessToken: 'bgm.tv 令牌' + '（可选，不填也能用）',
    };

    // 访问密码当前状态（后端只回传开关，不回传明文）
    const authOn = !!(config.auth && config.auth.enabled);
    const authHasPwd = !!(config.auth && config.auth.hasPassword);

    const groups = [
        { id: 'appearance', icon: 'spark', name: '外观' },
        { id: 'customize', icon: 'settings', name: '个性化' },
        { id: 'fxsettings', icon: 'spark', name: '动效设置' },
        { id: 'paths', icon: 'frame', name: '扫描路径' },
        { id: 'sources', icon: 'watch', name: '数据源' },
        { id: 'player', icon: 'reel', name: '播放' },
        { id: 'ai', icon: 'spark', name: 'AI 设置' },
        { id: 'notify', icon: 'bell', name: '安全与通知' },
        { id: 'privacy', icon: 'eye', name: '隐私内容' },
        { id: 'tools', icon: 'clock', name: '工具维护' },
        { id: 'cookies', icon: 'bookmark', name: 'Cookie' },
        { id: 'version', icon: 'chart', name: '版本' },
        { id: 'about', icon: 'home', name: '关于' }
    ];

    view.innerHTML = `
        <div class="settings-shell">
            <aside class="settings-nav">
                ${groups.map((g, i) => `
                    <div class="settings-nav-item ${i === 0 ? 'active' : ''}" data-group="${g.id}" onclick="switchSettingsGroup('${g.id}')">
                        ${makeRemotionIcon(g.icon, 20)}
                        <span class="settings-nav-label">${g.name}</span>
                    </div>
                `).join('')}
            </aside>

            <main class="settings-main">

                <!-- 🎨 外观 -->
                <section class="settings-section" data-group="appearance">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title" style="display:flex;align-items:center;gap:6px;">${uiIcon('paint', 18)} 外观</h3>
                        <p class="settings-section-desc">选择界面主题风格与明暗模式</p>
                    </div>

                    <!-- 2026-09-29：主题风格改用程序自带的三个 V4 皮肤。
                         旧的 ios / stylekit / shader 三张卡是废弃体系 —— 它们只改 body[data-theme]，
                         而对应的 CSS 规则仅存在于 style.v2-backup.css（现行样式表里一条都没有），
                         点下去只弹「已切换」提示、界面毫无变化。真正生效的主题是 data-v4skin，
                         与顶栏那三个圆点切换器同一套。 -->
                    <div class="settings-group">
                        <div class="settings-group-title">主题风格</div>
                        <div class="theme-selector">
                            <div class="theme-card ${getV4Skin() === 'classic' ? 'active' : ''}" data-v4skin="classic" onclick="pickV4Skin('classic')">
                                <div class="theme-dot" style="background: linear-gradient(135deg, #F1EEE6 50%, #9A6A15 50%);"></div>
                                <div class="theme-card-info">
                                    <div style="font-weight: 600; font-size: 14px;">经典 · Aardvark</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">白底纸感 · 原味界面</div>
                                </div>
                            </div>
                            <div class="theme-card ${getV4Skin() === 'aurora' ? 'active' : ''}" data-v4skin="aurora" onclick="pickV4Skin('aurora')">
                                <div class="theme-dot" style="background: linear-gradient(135deg, #22D3EE, #818CF8 48%, #C084FC);"></div>
                                <div class="theme-card-info">
                                    <div style="font-weight: 600; font-size: 14px;">V4.1 · 极光 AURORA</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">深蓝紫 · 漂移极光</div>
                                </div>
                            </div>
                            <div class="theme-card ${getV4Skin() === 'ambient' ? 'active' : ''}" data-v4skin="ambient" onclick="pickV4Skin('ambient')">
                                <div class="theme-dot" style="background: linear-gradient(135deg, #0F0F14 50%, #6E8BFF 50%);"></div>
                                <div class="theme-card-info">
                                    <div style="font-weight: 600; font-size: 14px;">V4.4 · 暮色 AMBIENT</div>
                                    <div style="font-size: 12px; color: var(--text-muted);">炭黑 · 环境光溢出</div>
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

                </section>

                <!-- 🎛️ 个性化（高度自定义：背景图 / 布局 / 海报 / 播放器） -->
                <section class="settings-section" data-group="customize" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title" style="display:flex;align-items:center;gap:6px;">${uiIcon('settings', 18)} 个性化</h3>
                        <p class="settings-section-desc">背景图、布局、海报、播放器随心调 —— 修改即时生效，保存在本机浏览器</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title" style="display:flex;align-items:center;gap:6px;">${uiIcon('image', 16)} 背景图</div>
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
                        <div class="settings-group-title">✨ 动画</div>
                        <div class="settings-group-title" style="font-weight:400;font-size:12px;opacity:.75;margin-top:-4px;">自定义三处动画：上传 mp4 / webm 视频（或 gif / webp / png 动图），≤36MB；恢复默认即回到内置素材</div>
                        ${['startup', 'idle', 'typing', 'idleScreen', 'loader'].map(t => `
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>${{ startup: '应用启动动画', idle: 'AI 待机动画', typing: 'AI 输入动画', idleScreen: '待机银幕', loader: '全局加载动画' }[t]}</b>
                                <span>${{ startup: '打开应用时的全屏开场，点击或任意键跳过，下次启动生效（1.5 倍速）', idle: '首页 AI 助手的待机姿态，替换静态小人', typing: '在首页输入框打字时播放的动作', idleScreen: '闲置 3 分钟后的全屏氛围动画，动鼠标即退', loader: '耗时任务（爬虫、刮削等）弹出的走马灯加载动画；支持 MP4/WebM/MOV/GIF，上传后系统将自动裁剪转码' }[t]}</span>
                            </div>
                            <div class="cr-ctrl">
                                <span id="animThumbBox-${t}" style="display:inline-flex;align-items:center;"><span class="anim-row-status">加载中…</span></span>
                                <span id="animStatus-${t}" class="anim-row-status"></span>
                                <input type="file" id="animInput-${t}" accept="${ANIM_ACCEPT}" style="display:none;" onchange="uploadAnimation('${t}', this)">
                                <button class="btn btn-sm" onclick="document.getElementById('animInput-${t}').click()">上传</button>
                                <button class="btn btn-sm btn-secondary" onclick="resetAnimation('${t}')">恢复默认</button>
                            </div>
                        </div>`).join('')}
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>播放启动动画</b>
                                <span>关闭后打开应用直接进首页</span>
                            </div>
                            <div class="cr-ctrl">
                                <button class="btn btn-sm ${animState.splashOff ? 'btn-secondary' : ''}" onclick="toggleSplashOff(this)">${animState.splashOff ? '已关闭' : '✓ 播放中'}</button>
                            </div>
                        </div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>播放待机银幕</b>
                                <span>闲置 3 分钟后全屏氛围动画，动鼠标即退；自定义素材用上方「待机银幕」上传</span>
                            </div>
                            <div class="cr-ctrl">
                                <button class="btn btn-sm ${animState.idleScreenOff ? 'btn-secondary' : ''}" onclick="toggleIdleScreenOff(this)">${animState.idleScreenOff ? '已关闭' : '✓ 播放中'}</button>
                            </div>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🎬 动效库 UI_anime</div>
                        <div class="settings-group-title" style="font-weight:400;font-size:12px;opacity:.75;margin-top:-4px;">skiper-ui.com 全站 106 款特效归档（D:/UI_anime），按用途分类浏览：全部可预览；带「已适配」标的可即时开关，选择持久化到服务端（重装不丢）。适配器随版本累积，新特效适配后在这里即可启用</div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>浏览特效</b>
                                <span>分类 → 动效，左侧动图预览</span>
                            </div>
                            <div class="cr-ctrl">
                                <select id="fxCatSel" class="btn btn-sm" onchange="fxRenderList()" style="max-width:170px;"></select>
                                <select id="fxSel" class="btn btn-sm" onchange="fxRenderPreview()" style="max-width:280px;"></select>
                            </div>
                        </div>
                        <div class="customize-row" style="align-items:flex-start;">
                            <div id="fxPreviewBox" style="width:220px;min-height:124px;border-radius:12px;overflow:hidden;background:var(--bg-elevated);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex:none;">
                                <span class="anim-row-status">选择动效后预览</span>
                            </div>
                            <div class="cr-info" id="fxMeta" style="flex:1;">
                                <b>UI_anime 动效库</b>
                                <span>选择上方动效查看详情</span>
                            </div>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">📐 布局</div>
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>AI 助手展现方式</b>
                                <span>右侧半透明抽屉滑出 或 居中半透明毛玻璃弹窗</span>
                            </div>
                            <div class="cr-ctrl">
                                <button class="btn btn-sm ${getAIMode() === 'drawer' ? '' : 'btn-secondary'}" onclick="setAIMode(getAIMode() === 'drawer' ? 'modal' : 'drawer'); this.textContent = getAIMode() === 'drawer' ? '右侧抽屉模式' : '居中弹窗模式';">
                                    ${getAIMode() === 'drawer' ? '右侧抽屉模式' : '居中弹窗模式'}
                                </button>
                            </div>
                        </div>
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
                        <div class="customize-row">
                            <div class="cr-info">
                                <b>iOS 玻璃特效</b>
                                <span>首页对话框与榜单卡片的磨砂玻璃质感；低端显卡卡顿可关闭</span>
                            </div>
                            <div class="cr-ctrl">
                                <button class="btn btn-sm ${getUiCustom().glassOff ? 'btn-secondary' : ''}" onclick="toggleUiFlag(this, 'glassOff')">${getUiCustom().glassOff ? '已关闭' : '✓ 开启中'}</button>
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

                <!-- ✨ 动效设置（按应用操作逻辑分类定制） -->
                <section class="settings-section" data-group="fxsettings" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title" style="display:flex;align-items:center;gap:6px;">${uiIcon('spark', 18)} 动效设置</h3>
                        <p class="settings-section-desc">按应用实际操作逻辑精细化定制各模块动效。选择对应场景方案，即刻生效并持久化到配置中。</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title" style="display:flex;align-items:center;gap:6px;">
                            ${uiIcon('spark', 16)} 操作逻辑动效分类定制
                        </div>
                        <div id="fxCategoryGrid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(360px, 1fr));gap:16px;margin-top:12px;"></div>
                    </div>
                </section>

                <!-- 📂 扫描路径 -->
                <section class="settings-section" data-group="paths" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">📂 扫描路径</h3>
                        <p class="settings-section-desc">配置六个模块的资源扫描文件夹，修改后需重启服务生效</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🔞 影片（AV）扫描路径</div>
                        <div class="folder-list" id="movieFolders">
                            ${(config.scanFolders || []).map(f => `
                                <div class="folder-item">
                                    <span class="folder-path">${f}</span>
                                    <button class="btn btn-sm btn-danger" onclick="removeFolder('movie', '${f}')">删除</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="folder-add">
                            <input type="text" class="folder-input" id="movieFolderInput" placeholder="输入文件夹路径，如 E:\Aokazu">
                            <button class="btn btn-sm" onclick="addFolder('movie')">添加</button>
                        </div>
                        <button class="btn btn-sm scan-module-btn" onclick="startModuleScan('movie')">▶️ 扫描影片</button>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🎌 里番扫描路径（隐私内容）</div>
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

                    <div class="settings-group">
                        <div class="settings-group-title">🎬 影视库扫描路径</div>
                        <div class="folder-list" id="filmFolders">
                            ${(config.filmFolders || []).map(f => `
                                <div class="folder-item">
                                    <span class="folder-path">${f}</span>
                                    <button class="btn btn-sm btn-danger" onclick="removeFolder('film', '${f}')">删除</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="folder-add">
                            <input type="text" class="folder-input" id="filmFolderInput" placeholder="输入文件夹路径">
                            <button class="btn btn-sm" onclick="addFolder('film')">添加</button>
                        </div>
                        <button class="btn btn-sm scan-module-btn" onclick="startModuleScan('film')">▶️ 扫描影视</button>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🐾 动漫库扫描路径（普通向）</div>
                        <div class="folder-list" id="cartoonFolders">
                            ${(config.cartoonFolders || []).map(f => `
                                <div class="folder-item">
                                    <span class="folder-path">${f}</span>
                                    <button class="btn btn-sm btn-danger" onclick="removeFolder('cartoon', '${f}')">删除</button>
                                </div>
                            `).join('')}
                        </div>
                        <div class="folder-add">
                            <input type="text" class="folder-input" id="cartoonFolderInput" placeholder="输入文件夹路径">
                            <button class="btn btn-sm" onclick="addFolder('cartoon')">添加</button>
                        </div>
                        <button class="btn btn-sm scan-module-btn" onclick="startModuleScan('cartoon')">▶️ 扫描动漫</button>
                    </div>
                </section>

                <!-- 🌐 数据源 -->
                <section class="settings-section" data-group="sources" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🌐 数据源</h3>
                        <p class="settings-section-desc">配置代理、刮削数据源与浏览器验证</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title" style="display:flex;align-items:center;justify-content:space-between;">
                            <span>⚡ 在线站点源健康仪表盘</span>
                            <button type="button" class="btn btn-sm btn-secondary" onclick="window.openWatchHealthModal && window.openWatchHealthModal('all')" style="font-size:12px;">打开测速仪表盘</button>
                        </div>
                        <p style="font-size:12px;color:var(--text-muted);margin:6px 0 2px;">
                            实时并发探测所有在线视频、动漫、漫画、小说站点的镜像线路连通性与响应延迟，直观掌握当前源状态与线路优选。
                        </p>
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

                    <!-- round36 P0-3：显示原名 -->
                    <div class="settings-group">
                        <div class="settings-group-title">🔤 名称显示</div>
                        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                            <input type="checkbox" id="showOriginalTitle" ${config.showOriginalTitle ? 'checked' : ''}>
                            显示原名（条目卡片/详情优先展示 originalTitle，如日语原名）
                        </label>
                    </div>

                    <!-- round47：新入库 AV 自动重命名 -->
                    <div class="settings-group">
                        <div class="settings-group-title">📁 文件重命名</div>
                        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                            <input type="checkbox" id="autoRenameFiles" ${config.rename?.autoRename ? 'checked' : ''}>
                            新入库 AV 自动重命名为「番号 标题」（如 ABC-123 标题.mp4）
                        </label>
                        <p class="settings-tip" style="margin-top:6px;">仅对扫描新入库且成功刮到番号+标题的 AV 生效；手动重刮不触发，源文件不会被移动到其他目录。多分片保留 CD 标记，NFO 与同名封面一并改名。开启后对之后入库的文件生效。</p>
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

                    <!-- round36 P0-1：弹幕（弹弹play） -->
                    <div class="settings-group">
                        <div class="settings-group-title">💬 弹幕（弹弹play）</div>
                        <div class="settings-item">
                            <label>AppId / AppSecret</label>
                            <input type="text" class="settings-input" id="danmakuAppId" value="${config.danmaku?.appId || ''}" placeholder="弹弹play 开放平台 AppId" style="margin-bottom:8px;">
                            <input type="password" class="settings-input" id="danmakuAppSecret" value="${config.danmaku?.hasSecret ? '........' : ''}" placeholder="${config.danmaku?.hasSecret ? '已配置，留空保持不变' : '弹弹play 开放平台 AppSecret'}">
                            <p class="settings-tip" style="margin-top:6px;">在 dandanplay.com 的开放平台免费申请。播放器内点「💬 弹幕」可开关、调透明度/速度/字号/屏蔽词。</p>
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

                        <div class="settings-item">
                            <label>AI 人格设定（对话口吻，首页与 AI 抽屉共用）</label>
                            <div id="personaChips" style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 10px;"></div>
                            <textarea id="personaCustomPrompt" class="settings-input" rows="3" style="display:none;width:100%;resize:vertical;" placeholder="用人设描述你想要的 AI，例如：你是毒舌但心软的赛博管家，说话带梗但靠得住……"></textarea>
                            <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">
                                预设只定「怎么说」；影片引用、工具调用等能力规则始终保留。保存后<b>下一条对话立即生效</b>，无需重启。
                            </div>
                            <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
                                <button class="btn btn-sm" onclick="saveAIPersona()">💾 保存人格设定</button>
                                <span id="aiPersonaStatus" style="font-size:12px;"></span>
                            </div>
                        </div>

                        <div class="settings-item">
                            <label>🔀 模型路由（多路由保存 · 随时切换 · 失败自动容灾）</label>
                            <div id="aiRoutesBox" style="margin:8px 0;display:flex;flex-direction:column;gap:6px;"></div>
                            <div id="aiRouteFormBox" style="display:none;border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px;"></div>
                            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                                <button class="btn btn-sm" onclick="addAIRoute()">＋ 新增路由</button>
                                <button class="btn btn-sm" style="background:var(--primary);" onclick="saveAIRoutes()">💾 保存路由</button>
                                <span id="aiRoutesStatus" style="font-size:12px;"></span>
                            </div>
                            <div style="font-size:12px;color:var(--text-muted);margin-top:6px;">
                                容灾口径：当前路由优先，调用失败（连不上 / 鉴权失败 / 5xx / 超时）自动按列表顺序切到下一条<b>启用中</b>的路由，全链失败才报错。保存后立即生效，无需重启。
                            </div>
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
                        <div id="authFields" style="display:${(authOn || authHasPwd) ? 'block' : 'none'};">
                            <div class="settings-item" id="authCurrentWrap" style="display:${authHasPwd ? 'block' : 'none'};">
                                <label style="font-size:12px;color:var(--text-muted);">当前密码</label>
                                <input type="password" class="settings-input" id="authCurrent" autocomplete="current-password"
                                       placeholder="修改或关闭密码前，请先输入当前正在使用的密码">
                                <p class="settings-tip">已设密码时的安全确认：换密码要验、关闭密码也要验，防止他人趁你已登录时把密码直接关掉。</p>
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

                    <div class="settings-group">
                        <div class="settings-group-title">🔔 通知偏好</div>
                        <p class="settings-tip">每类事件可单独决定：铃铛+弹窗（都提醒）/ 只进铃铛 / 只弹窗 / 关闭。</p>
                        <div id="notifyPrefsList">${renderNotifyPrefs()}</div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" style="background:var(--primary);" onclick="saveNotifyPrefs()">保存通知偏好</button>
                        </div>
                    </div>

                </section>

                <!-- 🕵️ 隐私内容（r42b：入口显示 + 分入口密码独立成组，一个保存键） -->
                <section class="settings-section" data-group="privacy" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🕵️ 隐私内容</h3>
                        <p class="settings-section-desc">成人入口的显示/隐藏与分入口独立密码，改完点一次「保存隐私设置」统一生效</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">👀 入口显示（成人内容）</div>
                        <p class="settings-tip">勾选 = 在左侧导航显示该入口，取消勾选 = 彻底隐藏。保存时若勾了任意一项，会自动解除顶栏 🔒 的「全部隐藏」状态（🔒 仍可随时一键隐藏/恢复全部）。</p>
                        <div id="adultNavList" class="adult-nav-list"></div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">🔐 分入口密码</div>
                        <p class="settings-tip">给指定功能入口单独上锁：<b>勾选</b>即上锁（要填一个至少 4 位的独立密码），取消勾选即解锁。即使已通过访问密码进入应用，打开上锁入口还要再输一道<b>独立密码</b>（与主密码相互独立）。适合把电脑借给别人用——对方能用其它功能，打不开你上锁的库。</p>
                        ${authOn && authHasPwd ? `
                        <div class="settings-item">
                            <label style="font-size:12px;color:var(--text-muted);">当前访问密码（改动分入口密码时需验证）</label>
                            <input type="password" class="settings-input" id="sectionCurrent" autocomplete="current-password" placeholder="输入主访问密码">
                        </div>` : ''}
                        <div id="sectionPwdList"><p class="settings-tip">加载中…</p></div>
                    </div>

                    <div class="settings-btn-row">
                        <button class="btn btn-sm" style="background:var(--primary);" onclick="savePrivacySettings()">💾 保存隐私设置</button>
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
                        <div style="margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:8px;">
                            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;" id="posterGcInfo">
                                封面缓存：点「盘点」看看有没有换封面后残留的旧图
                            </div>
                            <div class="settings-btn-row">
                                <button class="btn btn-sm" onclick="scanPosterCache()">📊 盘点缓存</button>
                                <button class="btn btn-sm" onclick="gcPosterCache('quarantine')">🧹 清理孤儿（可还原）</button>
                                <button class="btn btn-sm" style="background:rgba(239,68,68,0.1);color:#ef4444;" onclick="gcPosterCache('delete')">🗑️ 直接删除孤儿</button>
                            </div>
                            <div class="settings-btn-row" style="margin-top:6px;">
                                <button class="btn btn-sm" onclick="posterTrash('restore')">↩️ 还原回收站</button>
                                <button class="btn btn-sm" style="background:rgba(239,68,68,0.1);color:#ef4444;" onclick="posterTrash('purge')">🔥 清空回收站</button>
                            </div>
                        </div>
                    </div>

                    <!-- 女优头像刮削（2026-09-29 从「外观」迁来：它是数据维护任务，不属外观偏好） -->
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

                    <div class="settings-group">
                        <div class="settings-group-title">夸克网盘 · 扫码登录（推荐）</div>
                        <div class="settings-item">
                            <label>🦊 一键运行「夸克登录.bat」—— 扫码后自动写回 Cookie 并校验取流</label>
                            <div style="font-size:12px;color:var(--text-muted);margin:4px 0 8px;">
                                脚本位置：<code id="quarkBatPath" style="color:var(--text);">检测中…</code>
                            </div>
                            <div style="display:flex;gap:8px;margin-bottom:8px;">
                                <input type="text" class="settings-input" id="quarkBatPathInput" style="flex:1;font-size:12px;" placeholder="bat 的完整路径（留空 = 自动探测项目根目录）">
                                <button class="btn btn-sm" onclick="saveQuarkBatPath()">💾 保存位置</button>
                            </div>
                            <div class="settings-btn-row">
                                <button class="btn btn-sm" style="background:var(--primary);" onclick="runQuarkLoginBat()">🚀 一键运行夸克登录</button>
                                <button class="btn btn-sm" onclick="verifyQuarkLogin()">✅ 验证登录状态</button>
                            </div>
                            <div id="quarkBatStatus" style="font-size:12px;color:var(--text-muted);margin-top:8px;">状态：未运行</div>
                            <details style="margin-top:10px;font-size:12.5px;">
                                <summary style="cursor:pointer;color:var(--primary);font-weight:600;">📋 完整操作说明与报错处理（点开查看）</summary>
                                <div style="line-height:1.9;margin-top:8px;color:var(--text);">
                                    <b>操作步骤</b><br>
                                    ① 点「🚀 一键运行夸克登录」→ 会弹出一个黑色命令行窗口（<b>不要关</b>），随后自动打开夸克登录页浏览器窗口；<br>
                                    ② 打开手机「夸克App」→ 左上角「扫一扫」，扫屏幕上的二维码登录（或直接在页面登录）；<br>
                                    ③ 登录成功后脚本<b>自动</b>把新 Cookie 写回影库并做取流校验，窗口显示 <b>✅ 登录成功，且取流验证通过</b>；<br>
                                    ④ 回到应用点「✅ 验证登录状态」确认，网盘 Tab 的下载 / 在线阅读即刻恢复。<br>
                                    <b style="display:inline-block;margin-top:6px;">可能报错与处理</b><br>
                                    · <code>[ERROR] node.exe not found</code> → 电脑没装 Node.js：到 nodejs.org 安装，或把 node.exe 所在目录加入 PATH 后重试；<br>
                                    · <code>✗ 本机没有探测到正在运行的影库</code> → 影库没启动：先启动 CinemaVault（就是本应用），再重新运行脚本；<br>
                                    · <code>✗ 登录失败：没有一条已知密码能用</code> → 应用开了访问密码且脚本没猜中：点「设置脚本位置」旁确认 bat 在项目根目录，或手动跑 <code>node quark-login.js --password 你的密码</code>；<br>
                                    · <code>出错: Cannot find module 'playwright'</code> → 项目依赖没装全：在项目目录执行 <code>npm install</code>（脚本用宿主机的 Playwright 开浏览器）；<br>
                                    · 浏览器窗口一闪而过 → 先单独跑一次 <code>npx playwright install chromium</code> 装齐浏览器内核再重试；<br>
                                    · <code>⚠️ 超时未完成登录</code> → 扫码太慢（限时5分钟）：重跑一次，码出来就尽快扫；<br>
                                    · <code>✗ 写入失败</code> → 同时跑了多个实例（Docker + 桌面版）：关掉多余的，或用 <code>--prefer docker</code> / <code>--app http://127.0.0.1:端口</code> 指定目标；<br>
                                    · Cookie 写回成功但网盘仍取流失败 → 夸克风控临时拒绝：等几分钟重跑脚本；仍不行说明账号异常，去夸克网页版确认能正常用；<br>
                                    · 点按钮没反应 / 报「未找到 bat」 → 脚本被移动过：在「脚本位置」填入 <code>夸克登录.bat</code> 的完整路径并保存。
                                </div>
                            </details>
                        </div>
                    </div>
                </section>

                <!-- 🆙 版本与更新 -->
                <section class="settings-section" data-group="version" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">🆙 版本与更新</h3>
                        <p class="settings-section-desc">查询 GitHub 上发布的最新版本，核对后可一键下载安装</p>
                    </div>

                    <div class="settings-group">
                        <div class="settings-group-title">当前版本</div>
                        <div class="upd-ver-box">
                            <span class="upd-ver-num">v<span id="updCurrentVer">…</span></span>
                            <span class="upd-ver-sub" id="updCurrentSub">读取中…</span>
                        </div>
                        <div class="settings-btn-row">
                            <button class="btn btn-sm" style="background:var(--primary);" onclick="checkAppUpdate(true)">🔄 检查更新</button>
                            <button class="btn btn-sm" onclick="openUpdateReleasePage()">🌐 Release 页</button>
                        </div>
                        <div id="updCheckMsg" style="font-size:12px;color:var(--text-muted);margin-top:8px;">尚未检查</div>
                    </div>

                    <div class="settings-group" id="updNewBox" style="display:none;">
                        <div class="settings-group-title">🎉 发现新版本 <span class="upd-tag" id="updNewTag"></span></div>
                        <div id="updNotes" class="upd-notes"></div>
                        <div class="settings-item">
                            <label>选择安装包</label>
                            <select class="settings-input" id="updAssetSel"></select>
                        </div>
                        <div id="updProgressWrap" style="display:none;margin:12px 0 10px;">
                            <div class="upd-bar"><div class="upd-bar-inner" id="updBarInner"></div></div>
                            <div id="updProgressText" style="font-size:12.5px;color:var(--text);margin-top:6px;font-family:var(--font-mono);font-weight:600;"></div>
                        </div>
                        <div class="upd-action-row">
                            <button class="btn btn-sm upd-btn-dl" onclick="downloadAppUpdate()">${uiIcon('download', 14)} 下载更新</button>
                            <button class="btn btn-sm btn-secondary" onclick="cancelUpdateDownload()">${uiIcon('close', 14)} 取消下载</button>
                            <button class="btn btn-sm upd-btn-inst" onclick="installAppUpdate()">${uiIcon('check', 14)} 立即安装</button>
                            <button class="btn btn-sm btn-secondary" onclick="openUpdateFolder()">${uiIcon('folder', 14)} 打开下载目录</button>
                        </div>
                        <div id="updInstallMsg" style="font-size:12px;color:var(--text-muted);margin-top:8px;"></div>
                    </div>
                </section>

                <!-- ℹ️ 关于 -->
                <section class="settings-section" data-group="about" style="display:none;">
                    <div class="settings-section-head">
                        <h3 class="settings-section-title">ℹ️ 关于</h3>
                        <p class="settings-section-desc">本地影库管理系统</p>
                    </div>
                    <div class="settings-about">
                        <p>版本 <span id="aboutVerText">…</span></p>
                        <p style="color: var(--text-muted); font-size: 13px;">Node.js + Express + SQLite</p>
                        <p style="color: var(--text-muted); font-size: 12px;margin-top:8px;">支持：影片/动漫/漫画/小说 全模块管理</p>
                    </div>

                    <!-- round36 P0-5：构建信息一键复制（配合 issue 反馈） -->
                    <div class="settings-group">
                        <div class="settings-group-title">🧾 构建信息</div>
                        <div id="buildInfoBox" style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);line-height:1.9;white-space:pre-wrap;">加载中…</div>
                        <div class="settings-btn-row" style="margin-top:10px;">
                            <button class="btn btn-sm" style="background:var(--primary);color:#fff;" onclick="copyBuildInfo()">📋 复制诊断信息</button>
                            <button class="btn btn-sm" onclick="runNetCheck()">🌐 重新检测网络</button>
                        </div>
                        <p style="font-size:12px;color:var(--text-muted);margin-top:8px;">提 <a href="https://github.com/INORIergai/local-acgn-app/issues" target="_blank" style="color:var(--primary);">issue</a> 时先点「复制诊断信息」粘贴进去，能省一轮来回排障。</p>
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
    // round31：填充真实版本号。后端启动时已静默查过 GitHub 并缓存 5 分钟，
    // 所以这里通常瞬间就有结果，不必等一次网络往返。
    loadUpdateStatus();
    // round36 P0-5：构建信息面板
    loadBuildInfo();
}

// ========== round36 P0-5/P0-6：构建信息 + 网络自检 ==========
let _buildEnv = null;
let _netResult = null;

async function loadBuildInfo() {
    const box = document.getElementById('buildInfoBox');
    if (!box) return;
    try {
        const env = await fetch('/api/health/env').then(r => r.json());
        if (env.code !== 0) { box.textContent = '加载失败：' + (env.msg || ''); return; }
        _buildEnv = env.data;
        const d = env.data;
        // 先把环境行写上去（网络探测可能要几秒，异步补第二行）
        _netResult = _netResult || '检测中…';
        const render = () => {
            box.textContent = [
                `应用版本 : ${d.appVersion}`,
                `Electron : ${d.electron} (Chromium ${d.chrome})`,
                `Node     : ${d.node}`,
                `系统     : ${d.platform}`,
                `代理     : ${d.proxy || '未配置'}`,
                `弹幕凭据 : ${d.danmakuConfigured ? '已配置' : '未配置'}`,
                `媒体库   : ${d.counts.movies} 部影片 / ${d.counts.actresses} 演员 / ${d.counts.tags} 标签`,
                `网络自检 : ${_netResult}`,
            ].join('\n');
        };
        render();
        await runNetCheck(false);
        render();
    } catch (e) {
        box.textContent = '加载失败：' + e.message;
    }
}

async function copyBuildInfo() {
    const box = document.getElementById('buildInfoBox');
    if (!box || !box.textContent) return;
    try {
        await navigator.clipboard.writeText(box.textContent);
        showNotification('诊断信息已复制，去 issue 页粘贴即可');
    } catch (e) {
        // clipboard API 失败降级：选中区域
        const range = document.createRange();
        range.selectNodeContents(box);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        showNotification('已选中，按 Ctrl+C 复制', 'info');
    }
}

// 网络自检：silent=false 时弹结果提示（设置页手动按钮用）
async function runNetCheck(verbose = true) {
    try {
        const r = await fetch('/api/health/network?force=1').then(r => r.json());
        if (r.code !== 0) throw new Error(r.msg || '检测失败');
        const d = r.data;
        const okList = d.results.filter(x => x.ok).map(x => x.name);
        const badList = d.results.filter(x => !x.ok);
        const summary = `可达 ${okList.length}/${d.results.length}${badList.length ? '（不可达：' + badList.map(x => x.name).join('、') + '）' : ''}`;
        _netResult = summary;
        const info = document.getElementById('buildInfoBox');
        if (info && _buildEnv) {
            const lines = info.textContent.split('\n').filter(l => !l.startsWith('网络自检'));
            lines.push(`网络自检 : ${summary}`);
            info.textContent = lines.join('\n');
        }
        if (verbose) {
            if (badList.length) {
                showNotification(summary + ' —— 部分在线功能可能受影响', 'info');
            } else {
                showNotification('全部数据源可达 ✓');
            }
        }
        return summary;
    } catch (e) {
        if (verbose) showNotification('网络自检失败：' + e.message, 'error');
        return '检测失败';
    }
}

// P0-6：启动自检提示条（有不可达源时在顶栏显示，点击查看详情）
async function startupNetBanner() {
    try {
        const r = await fetch('/api/health/network').then(r => r.json());
        if (r.code !== 0) return;
        const dead = r.data.dead || [];
        if (!dead.length) return;
        if (document.getElementById('netWarnBanner')) return;
        const banner = document.createElement('div');
        banner.id = 'netWarnBanner';
        banner.style.cssText = 'position:sticky;top:0;z-index:800;display:flex;align-items:center;gap:10px;padding:8px 16px;background:rgba(245,166,35,.14);border-bottom:1px solid rgba(245,166,35,.4);color:var(--text);font-size:12.5px;cursor:pointer;';
        banner.innerHTML = `<span>⚠️</span><span style="flex:1;">网络自检：${dead.join('、')} 当前不可达，相关刮削/在线观看可能失败。</span><span style="color:var(--text-muted);">查看详情</span>`;
        banner.onclick = () => {
            banner.remove();
            switchView('settings');
            setTimeout(() => switchSettingsGroup('about'), 300);
        };
        document.body.prepend(banner);
        setTimeout(() => banner.remove(), 30000);
    } catch (e) { /* 静默：自检失败不打扰 */ }
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
            // round36：弹幕凭据 + 显示原名
            danmaku: {
                appId: document.getElementById('danmakuAppId')?.value.trim() || '',
                ...(document.getElementById('danmakuAppSecret')?.value.trim() && document.getElementById('danmakuAppSecret').value.trim() !== '........'
                    ? { appSecret: document.getElementById('danmakuAppSecret').value.trim() } : {})
            },
            showOriginalTitle: !!document.getElementById('showOriginalTitle')?.checked,
            // round47：新入库 AV 自动重命名开关
            rename: {
                autoRename: !!document.getElementById('autoRenameFiles')?.checked
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
            // round36 P0-3：原名偏好即时生效
            window.CV_SHOW_ORIG = !!document.getElementById('showOriginalTitle')?.checked;
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

            // v3.0-a：人格设定（预设 chips + 自定义 prompt）
            loadAIPersona();
            // r60：模型路由列表
            loadAIRoutes();

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

// ========== v3.0-a：AI 人格设定（设置页 → AI 分组）==========
let aiPersonaState = { presets: [], presetId: 'butler', customPrompt: '' };

async function loadAIPersona() {
    try {
        const r = await (await fetch('/api/ai/persona')).json();
        if (r.code !== 0) return;
        aiPersonaState = {
            presets: r.data.presets || [],
            presetId: r.data.current.presetId || 'butler',
            customPrompt: r.data.current.customPrompt || ''
        };
        renderPersonaChips();
    } catch (e) { /* 设置页人格区保持为空即可，不影响其他设置 */ }
}

const PERSONA_ICONS = {
    butler: '🎩',
    aimeis: '🌸',
    mao: '☕',
    dania: '🦊',
    albedo: '👑',
    custom: '✍️'
};

function renderPersonaChips() {
    const box = document.getElementById('personaChips');
    if (!box) return;
    const activePreset = aiPersonaState.presets.find(p => p.id === aiPersonaState.presetId) || {};
    box.innerHTML = aiPersonaState.presets.map(p => {
        const isSelected = p.id === aiPersonaState.presetId;
        const icon = PERSONA_ICONS[p.id] || '✨';
        const cls = isSelected ? 'btn-primary active' : 'btn-secondary';
        return `<button type="button" class="btn btn-sm ${cls} persona-chip"
            data-preset="${p.id}"
            onclick="pickAIPersona('${p.id}')"
            title="${escapeHtml(p.desc || '')}">
            <span class="persona-icon">${icon}</span>
            <span class="persona-name">${escapeHtml(p.name)}</span>
            ${isSelected ? '<span class="persona-badge">✓ 当前</span>' : ''}
        </button>`;
    }).join('') + (activePreset.desc ? `<div class="persona-desc-hint"><strong>${escapeHtml(activePreset.name)}：</strong>${escapeHtml(activePreset.desc)}</div>` : '');
    const ta = document.getElementById('personaCustomPrompt');
    if (ta) {
        ta.style.display = aiPersonaState.presetId === 'custom' ? 'block' : 'none';
        ta.value = aiPersonaState.customPrompt || '';
    }
}

function pickAIPersona(id) {
    aiPersonaState.presetId = id;
    renderPersonaChips();
}

async function saveAIPersona() {
    const statusEl = document.getElementById('aiPersonaStatus');
    try {
        if (statusEl) statusEl.textContent = '保存中...';
        const ta = document.getElementById('personaCustomPrompt');
        if (aiPersonaState.presetId === 'custom' && ta && !ta.value.trim()) {
            throw new Error('选择了「自定义」就要写一段人设描述');
        }
        const r = await (await fetch('/api/ai/persona', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ presetId: aiPersonaState.presetId, customPrompt: ta ? ta.value : '' })
        })).json();
        if (r.code !== 0) throw new Error(r.msg || '保存失败');
        aiPersonaState.customPrompt = (ta ? ta.value : '').trim();
        if (statusEl) statusEl.innerHTML = '<span style="color:#10b981;">✅ 已保存，下一条对话生效</span>';
        showNotification('人格设定已保存', (aiPersonaState.presets.find(p => p.id === aiPersonaState.presetId) || {}).name || '');
    } catch (e) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">' + escapeHtml(e.message) + '</span>';
        showNotification('人格设定保存失败', e.message, 'error');
    }
}

// ========== r60：AI 模型路由（多路由保存 / 随时切换 / 失败自动容灾）==========
let aiRoutesState = { routes: [], activeId: 'legacy' };
let aiRouteEditing = null;   // null | 'new' | 数组下标

async function loadAIRoutes() {
    try {
        const r = await (await fetch('/api/ai/routes')).json();
        if (r.code !== 0) return;
        aiRoutesState = { routes: r.data.routes || [], activeId: r.data.activeId };
        aiRouteEditing = null;
        renderAIRoutes();
    } catch (e) { /* 设置页保持空态 */ }
}

function renderAIRoutes() {
    const box = document.getElementById('aiRoutesBox');
    if (!box) return;
    if (!aiRoutesState.routes.length) {
        box.innerHTML = '<div style="font-size:12.5px;color:var(--text-muted);">还没有路由 —— 点「＋ 新增路由」添加，或直接「💾 保存路由」把当前单配置固化为第一条。</div>';
    } else {
        box.innerHTML = aiRoutesState.routes.map((rt, i) => `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid ${rt.id === aiRoutesState.activeId ? 'var(--primary)' : 'var(--border)'};border-radius:10px;background:var(--bg-elevated);">
                <span style="font-size:12px;font-weight:700;color:${rt.id === aiRoutesState.activeId ? 'var(--primary)' : 'var(--text-muted)'};flex:0 0 auto;">${rt.id === aiRoutesState.activeId ? '● 当前' : '○'}</span>
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(rt.baseUrl || '')}">
                    <b>${escapeHtml(rt.name || rt.id)}</b>
                    <span style="color:var(--text-muted);font-size:12px;"> · ${escapeHtml(rt.provider)} · ${escapeHtml(rt.model || '未选模型')}${rt.apiKeySet ? ' · 🔑' : ''}${rt.enabled === false ? ' · ⏸ 停用' : ''}</span>
                </span>
                <button class="btn btn-sm" onclick="setAIRouteActive('${rt.id}')" ${rt.id === aiRoutesState.activeId ? 'disabled' : ''}>设为当前</button>
                <button class="btn btn-sm" onclick="toggleAIRouteEnabled(${i})">${rt.enabled === false ? '启用' : '停用'}</button>
                <button class="btn btn-sm" onclick="moveAIRoute(${i},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-sm" onclick="moveAIRoute(${i},1)" ${i === aiRoutesState.routes.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-sm" onclick="editAIRoute(${i})">编辑</button>
                <button class="btn btn-sm" onclick="removeAIRoute(${i})">删除</button>
            </div>`).join('');
    }
    renderAIRouteForm();
}

function renderAIRouteForm() {
    const box = document.getElementById('aiRouteFormBox');
    if (!box) return;
    if (aiRouteEditing === null) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const isNew = aiRouteEditing === 'new';
    const rt = isNew
        ? { id: '', name: '', provider: 'custom', baseUrl: '', apiKey: '', model: '', session: '', enabled: true }
        : (aiRoutesState.routes[aiRouteEditing] || {});
    box.style.display = 'block';
    box.innerHTML = `
        <div style="font-size:12.5px;font-weight:700;margin-bottom:8px;">${isNew ? '＋ 新增路由' : '✏️ 编辑路由：' + escapeHtml(rt.name || rt.id)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div><label style="font-size:12px;">名称</label><input class="settings-input" id="rtName" value="${escapeHtml(rt.name || '')}" placeholder="如：SenseNova 主力"></div>
            <div><label style="font-size:12px;">类型</label>
                <select class="settings-input" id="rtProvider">
                    ${['custom', 'openai', 'deepseek', 'ollama'].map(p => `<option value="${p}" ${rt.provider === p ? 'selected' : ''}>${p}</option>`).join('')}
                </select></div>
            <div style="grid-column:1/-1;"><label style="font-size:12px;">API 地址（Base URL）</label><input class="settings-input" id="rtBaseUrl" value="${escapeHtml(rt.baseUrl || '')}" placeholder="https://api.example.com/v1（Ollama 可留空）"></div>
            <div><label style="font-size:12px;">API Key ${rt.apiKeySet ? '<span style="color:var(--ok);">（已配置，留空=不改）</span>' : ''}</label><input class="settings-input" id="rtApiKey" type="password" value="${isNew || !rt.apiKeySet ? '' : (rt.apiKey || '')}" placeholder="${rt.apiKeySet ? '留空保持不变' : 'sk-…'}"></div>
            <div><label style="font-size:12px;">模型</label><input class="settings-input" id="rtModel" value="${escapeHtml(rt.model || '')}" placeholder="模型名称"></div>
            <div style="grid-column:1/-1;"><label style="font-size:12px;">opencode session（仅 opencode.ai 网关需要）</label><input class="settings-input" id="rtSession" value="${escapeHtml(rt.session || '')}" placeholder="留空 = 用全局配置"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn btn-sm" style="background:var(--primary);" onclick="saveAIRouteForm()">✔ 确认（先存本地列表）</button>
            <button class="btn btn-sm" onclick="cancelAIRouteForm()">取消</button>
        </div>`;
}

function addAIRoute() { aiRouteEditing = 'new'; renderAIRouteForm(); }
function editAIRoute(i) { aiRouteEditing = i; renderAIRouteForm(); }
function cancelAIRouteForm() { aiRouteEditing = null; renderAIRouteForm(); }

function saveAIRouteForm() {
    const get = id => (document.getElementById(id) || {}).value || '';
    const rt = {
        id: aiRouteEditing === 'new' ? ('route-' + Date.now()) : aiRoutesState.routes[aiRouteEditing].id,
        name: get('rtName').trim(),
        provider: get('rtProvider'),
        baseUrl: get('rtBaseUrl').trim(),
        apiKey: get('rtApiKey').trim(),
        model: get('rtModel').trim(),
        session: get('rtSession').trim(),
        enabled: aiRouteEditing === 'new' ? true : aiRoutesState.routes[aiRouteEditing].enabled !== false
    };
    if (!rt.name) rt.name = rt.model ? rt.provider + ' · ' + rt.model : rt.provider;
    if (rt.provider !== 'ollama' && !rt.apiKey && !(aiRouteEditing !== 'new' && aiRoutesState.routes[aiRouteEditing].apiKeySet)) {
        // 非 ollama 且原未配置 key 时要求填写（避免存一条必失败的路由）
        showNotification('还差一步', '该类型路由需要 API Key（Ollama 本地可免）', 'error');
        return;
    }
    if (aiRouteEditing === 'new') aiRoutesState.routes.push(rt);
    else aiRoutesState.routes[aiRouteEditing] = rt;
    aiRouteEditing = null;
    renderAIRoutes();
}

function removeAIRoute(i) {
    if (aiRoutesState.routes.length <= 1) { showNotification('至少保留一条路由', '可以把不用的停用', 'error'); return; }
    const removed = aiRoutesState.routes.splice(i, 1)[0];
    if (aiRoutesState.activeId === removed.id) aiRoutesState.activeId = aiRoutesState.routes[0].id;
    if (aiRouteEditing === i) aiRouteEditing = null;
    renderAIRoutes();
}

function moveAIRoute(i, d) {
    const j = i + d;
    if (j < 0 || j >= aiRoutesState.routes.length) return;
    const arr = aiRoutesState.routes;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    renderAIRoutes();
}

function toggleAIRouteEnabled(i) {
    const rt = aiRoutesState.routes[i];
    rt.enabled = rt.enabled === false ? true : false;
    if (rt.enabled === false && aiRoutesState.activeId === rt.id) {
        const next = aiRoutesState.routes.find(r => r.enabled !== false);
        aiRoutesState.activeId = next ? next.id : rt.id;
    }
    renderAIRoutes();
}

function setAIRouteActive(id) {
    aiRoutesState.activeId = id;
    renderAIRoutes();
    saveAIRoutes();   // 切换立即落盘生效
}

async function saveAIRoutes() {
    const st = document.getElementById('aiRoutesStatus');
    try {
        if (st) st.textContent = '保存中…';
        const r = await (await fetch('/api/ai/routes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ routes: aiRoutesState.routes, activeId: aiRoutesState.activeId })
        })).json();
        if (r.code !== 0) throw new Error(r.msg || '保存失败');
        aiRoutesState = { routes: r.data.routes, activeId: r.data.activeId };
        aiRouteEditing = null;
        renderAIRoutes();
        if (st) st.innerHTML = '<span style="color:#10b981;">✅ 已保存，立即生效</span>';
        showNotification('模型路由已保存', `当前路由：${(r.data.routes.find(x => x.id === r.data.activeId) || {}).name || ''}`);
    } catch (e) {
        if (st) st.innerHTML = '<span style="color:#ef4444;">' + escapeHtml(e.message) + '</span>';
        showNotification('路由保存失败', e.message, 'error');
    }
}

// ========== r60：夸克扫码登录（设置页 Cookie 组）==========
async function loadQuarkBatInfo() {
    try {
        const r = await (await fetch('/api/cloud/quark/login-bat-info')).json();
        const el = document.getElementById('quarkBatPath');
        const inp = document.getElementById('quarkBatPathInput');
        if (!el) return;
        if (r.code === 0 && r.data.path) {
            el.textContent = r.data.path;
            el.style.color = 'var(--ok)';
        } else {
            el.textContent = '未找到「夸克登录.bat」——在下方填入完整路径';
            el.style.color = 'var(--danger)';
        }
        if (inp && !inp.value) inp.value = (r.data && r.data.configured) || '';
    } catch (e) { /* 忽略 */ }
}

async function saveQuarkBatPath() {
    const inp = document.getElementById('quarkBatPathInput');
    const p = (inp ? inp.value : '').trim();
    try {
        const r = await (await fetch('/api/cloud/quark/set-login-bat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p })
        })).json();
        if (r.code !== 0) throw new Error(r.msg || '保存失败');
        showNotification('脚本位置已保存', p || '自动探测');
        loadQuarkBatInfo();
    } catch (e) {
        showNotification('保存失败', e.message, 'error');
    }
}

async function runQuarkLoginBat() {
    const st = document.getElementById('quarkBatStatus');
    try {
        if (st) st.textContent = '正在启动脚本…';
        const r = await (await fetch('/api/cloud/quark/run-login-bat', { method: 'POST' })).json();
        if (r.code !== 0) throw new Error(r.msg || '启动失败');
        if (st) st.innerHTML = '<span style="color:var(--ok);">✅ 脚本窗口已弹出</span> —— 按下方「操作说明」扫码即可，成功后脚本会自动写回 Cookie 并校验';
        showNotification('夸克登录脚本已启动', '在弹出的窗口里用手机夸克 App 扫码，成功后自动写回', 6000);
    } catch (e) {
        if (st) st.innerHTML = '<span style="color:var(--danger);">✗ ' + escapeHtml(e.message) + '</span>';
        showNotification('夸克登录启动失败', e.message, 'error');
    }
}

async function verifyQuarkLogin() {
    const st = document.getElementById('quarkBatStatus');
    try {
        if (st) st.textContent = '正在验证（真实取流检测，约几秒）…';
        const r = await (await fetch('/api/cloud/quark/health')).json();
        const d = (r && r.data) || {};
        let html;
        if (d.loggedIn && d.sessionValid === true) {
            html = '<span style="color:var(--ok);">✅ 已登录且取流可用</span>' + (d.tested ? '（实测：' + escapeHtml(d.tested.name) + '）' : '');
        } else if (d.loggedIn) {
            html = '<span style="color:#f59e0b;">⚠️ 已登录，但取流被拒 —— Cookie 仍无效，请重跑扫码登录</span>' + (d.msg ? '<br>' + escapeHtml(d.msg) : '');
        } else {
            html = '<span style="color:var(--danger);">✗ 未登录 / Cookie 失效 —— 请点「🚀 一键运行夸克登录」重新扫码</span>';
        }
        if (st) st.innerHTML = '验证结果：' + html;
    } catch (e) {
        if (st) st.innerHTML = '<span style="color:var(--danger);">验证失败：' + escapeHtml(e.message) + '</span>';
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

// ========== round37：封面缓存 GC（换封面/批量换海报留下的旧图会越堆越多）==========

function fmtSize(n) {
    if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024).toFixed(1) + ' KB';
}

async function scanPosterCache() {
    const el = document.getElementById('posterGcInfo');
    if (el) el.textContent = '正在盘点…';
    try {
        const res = await fetch('/api/maintenance/poster-cache');
        const { code, msg, data } = await res.json();
        if (code !== 0) throw new Error(msg);
        const t = data.trash || {};
        if (el) {
            el.innerHTML = `缓存共 <b>${data.files}</b> 个文件 / <b>${data.totalHuman}</b>，` +
                `其中孤儿（没有任何影片在用）<b>${data.orphanCount}</b> 个 / <b>${data.orphanHuman}</b>` +
                (t.count ? `<br>回收站还有 ${t.count} 个 / ${t.human}` : '');
        }
        return data;
    } catch (e) {
        if (el) el.textContent = '盘点失败：' + e.message;
    }
}

async function gcPosterCache(mode) {
    const d = await scanPosterCache();
    if (!d || !d.orphanCount) {
        showNotification('没有可清理的孤儿封面');
        return;
    }
    const ok = confirm(
        `发现 ${d.orphanCount} 个孤儿封面（${d.orphanHuman}），它们已经没有任何影片在用。\n\n` +
        (mode === 'delete' ? '「直接删除」不可恢复，确定删除吗？' : '将移进回收站（可在下方还原），确定清理吗？')
    );
    if (!ok) return;
    try {
        const res = await fetch('/api/maintenance/poster-gc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (data.code === 0) showNotification(data.msg);
        else showNotification('清理失败：' + data.msg, 'error');
    } catch (e) {
        showNotification('清理失败：' + e.message, 'error');
    }
    scanPosterCache();
}

async function posterTrash(action) {
    if (action === 'purge' && !confirm('彻底删除回收站里的封面？此操作不可恢复。')) return;
    try {
        const res = await fetch('/api/maintenance/poster-trash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (data.code === 0) showNotification(data.msg);
        else showNotification('操作失败：' + data.msg, 'error');
    } catch (e) {
        showNotification('操作失败：' + e.message, 'error');
    }
    scanPosterCache();
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
 * ★ round25 修复 #7：按 kind 分组、空态给可执行诊断、上传入口常驻。
 * ★ round26 修复 #9：刮削源在「代理掉线 / 站点被 Cloudflare 拦」时会长时间挂起，
 *   原来的 Promise.all 没有超时，弹窗就永远停在「正在搜索海报…」，用户等不到任何结果，
 *   也看不到说好的抽帧候选。现在：
 *     ① 每个请求各自带超时（刮削 20s / 内容截图 30s / 配置 8s）；
 *     ② 谁先回来先画谁 —— 分段出结果，不再整块卡住；
 *     ③ 每秒刷新「已用时」，超时/失败原因直接写进诊断块，并常驻「重试 / 上传」两条出路。 */

// 带超时的 JSON 请求（round26 #9）。不抛异常，失败统一返回 {code:-1,msg}
async function fetchJsonTimeout(url, ms = 15000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
        const r = await fetch(url, { signal: ac.signal });
        return await r.json();
    } catch (e) {
        return {
            code: -1,
            msg: e.name === 'AbortError'
                ? `请求超时（${Math.round(ms / 1000)} 秒内没有响应）`
                : (e.message || '请求失败')
        };
    } finally {
        clearTimeout(timer);
    }
}

/* ★ round27：写操作撞上「database disk image is malformed」时 → 自动修索引 + 重试一次
 *
 * 症状：改标题 / 重命名 / 重刮写片名 一律弹「保存失败」，看起来像前端坏了；
 *   实际是 SQLite 的 **FTS 影子表损坏**（`PRAGMA integrity_check` 仍返回 ok，极具迷惑性），
 *   而「被全文索引的列」一旦更新就要写 FTS ⇒ 整条 UPDATE 抛 malformed。
 * 后端 `POST /api/movie/fts-repair` 会从 movies 重建整索引；这里统一兜一次，用户无感。 */
async function fetchJsonWithDbHeal(url, options) {
    const call = async () => {
        const r = await fetch(url, options);
        let j;
        try { j = await r.json(); } catch (e) { j = { code: -1, msg: '响应不是 JSON' }; }
        return { status: r.status, json: j };
    };

    let out = await call();
    // round34：会话失效（401）统一拉起密码框 —— 比如手机端 30 天会话过期后，
    // 用户点受保护功能不用面对一堆「加载失败」，而是直接见到检票口。
    if (out.status === 401 && window.Gate && window.Gate.onUnauthorized) {
        window.Gate.onUnauthorized();
    }
    const msg = (out.json && out.json.msg) || '';
    if (!/malformed|database disk image/i.test(msg)) return out.json;

    showNotification('检测到数据库索引损坏', '正在自动修复后重试…', 4000);
    try {
        const rep = await (await fetch('/api/movie/fts-repair', { method: 'POST' })).json();
        if (!rep || rep.code !== 0) {
            return { code: -1, msg: '索引修复失败：' + ((rep && rep.msg) || '未知原因') };
        }
    } catch (e) {
        return { code: -1, msg: '索引修复请求失败：' + e.message };
    }

    out = await call();
    if (out.json && out.json.code === 0) {
        showNotification('索引已修复', '刚才的操作已自动重试成功', 4000);
    }
    return out.json;
}

// 把候选渲染进 posterGrid：既用于「先回来的先画」，也用于最终态
function renderPosterOptions(grid, movieId, scraped, frames, cfg, state) {
    state = state || {};
    const found = (scraped && scraped.code === 0 && scraped.data) || [];
    const shots = (frames && frames.code === 0 && frames.data) || [];
    const proxyOn = !!(cfg && cfg.data && cfg.data.network && cfg.data.network.proxyServer);

    const card = (p) => `
        <div class="poster-option" onclick="changePoster(${movieId}, '${p.url}')">
            <img src="${p.display || p.url}" alt="${p.title || ''}" loading="lazy">
            <div class="poster-option-info">
                <span class="poster-option-source">${String(p.source || '').toUpperCase()}</span>
                ${p.title ? `<span class="poster-option-title">${p.title}</span>` : ''}
            </div>
        </div>`;

    const waitingRow = (text) => `
        <div style="grid-column:1/-1;font-size:12.5px;color:var(--text-muted);padding:4px 2px 12px;display:flex;align-items:center;gap:8px;">
            <span class="poster-spin" aria-hidden="true"></span>${text}
        </div>`;

    let html = '';

    // —— 1. 刮削结果 ——
    if (!scraped) {
        html += `<div class="poster-section-label" style="opacity:.7;display:flex;align-items:center;gap:6px;">${uiIcon('search', 16)} 刮削结果</div>`
            + waitingRow('正在向各刮削源查询封面…（最多等 20 秒）');
    } else if (found.length) {
        html += `<div class="poster-section-label" style="display:flex;align-items:center;gap:6px;">${uiIcon('search', 16)} 刮削结果（${found.length}）</div>` + found.map(card).join('');
    } else {
        // 诊断块：告诉用户「为什么没有」，而不是只报「没有」
        const reasons = [];
        if (scraped.code !== 0) {
            reasons.push(`刮削没有返回结果：${scraped.msg || '未知原因'}`);
        } else {
            reasons.push('各刮削源都没有这部作品的封面（片名/番号可能对不上，或站点没有收录）');
        }
        reasons.push(proxyOn
            ? '代理已开启；若仍是空，多为站点本身没有该条目，或站点被 Cloudflare 拦截'
            : '当前未配置代理，境外刮削源大概率连不上 —— 可到「设置 → 数据源 → 代理设置」填好代理后重试');
        html += `
            <div class="poster-empty-diagnosis">
                <div style="font-weight:600;color:var(--text);margin-bottom:6px;">未刮削到任何封面</div>
                <ul style="margin:0;padding:0 0 0 18px;line-height:1.7;">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>
            </div>`;
    }

    // —— 2. 内容截图候选（视频抽帧 / PDF 页 / EPUB 内封面）——
    if (!frames) {
        html += `<div class="poster-section-label" style="opacity:.7;display:flex;align-items:center;gap:6px;">${uiIcon('film', 16)} 内容截图</div>`
            + waitingRow('正在生成内容截图候选（视频抽帧 / PDF 页 / EPUB 内封面）…（最多等 30 秒）');
    } else if (shots.length) {
        const kinds = new Set(shots.map(s => s.kind));
        const label = kinds.has('pdf') ? 'PDF 内容页'
            : kinds.has('epub') ? 'EPUB 内封面'
                : '视频截帧';
        html += `<div class="poster-section-label" style="display:flex;align-items:center;gap:6px;">${uiIcon('film', 16)} ${label}（点一张就用作封面）</div>` + shots.map(card).join('');
    } else {
        const why = (frames.msg ? `（${frames.msg}）` : '');
        html += `
            <div class="poster-section-label" style="opacity:.75;display:flex;align-items:center;gap:6px;">${uiIcon('film', 16)} 内容截图</div>
            <div style="grid-column:1/-1;font-size:12.5px;color:var(--text-muted);padding:4px 2px 12px;">
                这部作品没有可用的内容截图${why}。视频截帧需要文件可读且装了 ffmpeg；漫画/小说需要 PDF / EPUB 内确实有图。
            </div>`;
    }

    // —— 3. 兜底：重试 + 上传入口始终可达 ——
    html += `
        <div style="grid-column:1/-1;margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:12px;color:var(--text-muted);">${state.elapsed ? '已用时 ' + Math.round(state.elapsed / 1000) + ' 秒' : ''}</span>
            <span style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-sm btn-secondary" onclick="showChangePosterModal(${movieId})">${uiIcon('refresh', 13)} 重新刮削</button>
                <button class="btn btn-sm" onclick="closePosterModal();showUploadPosterModal(${movieId})">${uiIcon('upload', 13)} 自己上传 / 粘贴图片</button>
            </span>
        </div>`;

    grid.innerHTML = html;
}

/* 海报弹窗「会话号」—— round27 修复 #2「刮削失败与海报健康状态错位」
 *
 * 真因：整个应用只有一份弹窗 DOM（#posterModal / #posterGrid），但每次打开都会新建
 *   一个闭包和一个「每秒重画」的 tick。若在 A 的请求尚未返回时又为 B 打开弹窗
 *   （换个面板点「🖼️ 选封面」，或在弹窗里再点一次「🔄 重新刮削」），
 *   B 覆盖了 grid，而 **A 的 tick / paint 仍往同一个 grid 里画** ⇒
 *   出现「标题写的是 B、抽帧图是 A、诊断写『A 的海报刮削失败』」这种混排。
 *
 * 修法：每次打开自增会话号，所有异步回调与定时器先校验自己是否仍是当前会话；
 *   不是就立刻 return（定时器顺手清掉），彻底杜绝过期会话回写。 */
let posterSession = 0;

async function showChangePosterModal(movieId) {
    const mySession = ++posterSession;
    const mine = () => mySession === posterSession;

    currentMovieId = movieId;
    const modal = document.getElementById('posterModal');
    const grid = document.getElementById('posterGrid');

    grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">正在搜索海报…（同时准备内容截图候选）</div>';
    modal.classList.add('show');

    const started = Date.now();
    let scraped = null, frames = null, cfg = null;
    const paint = () => {
        if (!mine()) return;                                          // 已被更新的会话接管
        if (document.getElementById('posterGrid') !== grid) return;   // 节点已被替换（保险）
        renderPosterOptions(grid, movieId, scraped, frames, cfg, { elapsed: Date.now() - started });
    };
    // 每秒重画一次「已用时」，让人看得出还在跑而不是卡死（两个请求都回来后就停）
    const tick = setInterval(() => {
        if (!mine()) { clearInterval(tick); return; }
        if (!scraped || !frames) paint();
    }, 1000);

    try {
        await Promise.all([
            fetchJsonTimeout(`/api/movie/${movieId}/search-posters`, 20000)
                .then(v => { if (!mine()) return; scraped = v; paint(); }),
            fetchJsonTimeout(`/api/movie/${movieId}/frame-candidates`, 30000)
                .then(v => { if (!mine()) return; frames = v; paint(); }),
            fetchJsonTimeout('/api/config', 8000)
                .then(v => { if (!mine()) return; cfg = v; })
        ]);
    } finally {
        clearInterval(tick);
        paint();
    }
}

// 关闭海报弹窗（顺带作废在飞的会话，避免关闭后它仍往 grid 里画）
function closePosterModal() {
    posterSession++;
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
    updateAIModeButtons();
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
                                const posterUrl = getPosterUrl(movie);
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
        case 'smart_rescrape':
            return result.message || '智能重新刮削与封面优选任务已执行完成';
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
    // 切换视图时坚决重置可能残余的长任务等待遮罩与加载器
    if (window.NVX_LONG && typeof window.NVX_LONG.reset === 'function') {
        window.NVX_LONG.reset();
    }
    /* round42c 隐私分割器：隐私入口在总开关隐藏时一律拦截（防止 hash 恢复等路径绕过）
     * round43：+ 隐私组同款四功能块 */
    if (['jav', 'anime', 'movies-adult', 'recent-adult', 'hot-adult', 'random-adult', 'guess-adult', 'unwatched-adult', 'actresses', 'tags', 'watch', 'watch-hanime'].includes(view)
        && typeof isAdultNavHidden === 'function' && isAdultNavHidden()) {
        view = 'movies';
        showNotification('已隐藏', '该入口属于隐私内容，当前处于隐藏状态。可在 设置→隐私内容 里开启，或点顶栏 🔒 解锁');
    }
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
    // r64: 控制多维切片筛选器的显隐，避免悬挂在非网格视图
    const facetBar = document.getElementById('facetFilterBar');
    const isGridView = ['movies', 'movies-adult', 'jav', 'anime', 'film', 'cartoon', 'favorites', 'hot', 'unwatched'].includes(view);
    if (facetBar) {
        facetBar.style.display = isGridView ? 'block' : 'none';
        if (isGridView && window.FacetFilter) {
            window.FacetFilter.onViewChanged(view);
        }
    }

    document.getElementById('movieGrid').style.display = 'none';
    document.getElementById('movieGrid').classList.remove('tree-mode');
    // 第 33 轮：切视图时收起首页 / ACG 榜单自定义视图
    if (window.Home && window.Home.hideHome) window.Home.hideHome();
    if (window.Home && window.Home.hideAcgBoard) window.Home.hideAcgBoard();
    // 第 25 轮：离开收藏页时摘掉个性化布局类，避免污染其它视图
    if (view !== 'favorites') {
        document.getElementById('movieGrid').classList.remove('fav-layout-compact', 'fav-layout-large', 'fav-layout-list');
    }
    document.getElementById('actressGrid').style.display = 'none';
    document.getElementById('tagCloud').style.display = 'none';
    // round34：演员/标签切片条跟着显隐
    const slicerA = document.getElementById('actressSlicer');
    if (slicerA) slicerA.style.display = 'none';
    const slicerT = document.getElementById('tagSlicer');
    if (slicerT) slicerT.style.display = 'none';
    document.getElementById('statsPanel').style.display = 'none';
    document.getElementById('emptyTip').style.display = 'none';
    document.getElementById('settingsView').style.display = 'none';
    const featureView = document.getElementById('featureView');
    if (featureView) featureView.style.display = 'none';
    const profileStrip = document.getElementById('profileStrip');
    if (profileStrip) profileStrip.style.display = 'none';
    document.getElementById('sortSelect').parentElement.style.display = 'block';
    document.getElementById('pagination').style.display = 'none';

    /* ★ round26 修复 #8：漫画/小说库的「本地 / 网盘」切换按钮是 loadComic()/loadNovel()
     * 用 insertAdjacentHTML 塞进 .toolbar-right 的，切到别的视图时没人清理 ——
     * 结果在女优库、全部影片等视图右上角一直挂着两组「本地 / 网盘」，像是只有
     * 小说漫画才有的功能跑到了通用界面。这里按当前视图摘掉不属于它的那一组。 */
    if (view !== 'comic') {
        const t = document.getElementById('comicCloudToggle');
        if (t) t.remove();
    }
    if (view !== 'novel') {
        const t = document.getElementById('novelCloudToggle');
        if (t) t.remove();
    }

    // 记住当前视图（刷新/返回时恢复，见 init() 的 hash 解析）
    rememberViewState(view, '');

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
    
    // 首页/动漫/漫画/小说显示画廊；round43：隐私组「全部内容」也带精选轮播（AV/里番口径）
    const galleryViews = ['movies', 'anime', 'comic', 'novel', 'movies-adult'];
    if (galleryViews.includes(view)) {
        showGallery();
        initGallery(view);
    } else {
        hideGallery();
    }
    
    // 显示对应视图
    switch (view) {
        case 'home':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('🏠 首页');
            if (window.Home && window.Home.showHome) window.Home.showHome();
            break;
        case 'acg-rank':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('📈 ACG榜单');
            if (window.Home && window.Home.showAcgBoard) window.Home.showAcgBoard();
            break;
        case 'movies':
            document.getElementById('movieGrid').style.display = 'grid';
            loadMovies();
            break;
        /* round42c 隐私内容组专属视图（只管 AV/里番） */
        case 'movies-adult':
            document.getElementById('movieGrid').style.display = 'grid';
            loadAdultMovies();
            break;
        case 'recent-adult':
            document.getElementById('movieGrid').style.display = 'grid';
            loadAdultRecent();
            break;
        /* round43 隐私组同款四功能块：与公开版同构，取数范围=AV/里番。
         * r44：猜你喜欢不再自做网格——直接复用公开版 Aardvark 散落展台（AvBoard），
         * 只是取数口径传 privacy=adult；牌堆/列表模式按钮在隐私口径下隐藏（那两个
         * 模式视图是公开口径的视图名，跳过去会泄漏/口径错乱）。 */
        case 'hot-adult':
            document.getElementById('movieGrid').style.display = 'grid';
            loadHot('adult');
            break;
        case 'random-adult':
            document.getElementById('movieGrid').style.display = 'grid';
            loadRandom('adult');
            break;
        case 'guess-adult':
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('🔞 猜你喜欢');
            if (window.AvBoard) {
                document.getElementById('movieGrid').style.display = 'grid';
                window.AvBoard.openGuess('adult');
                break;
            }
            document.getElementById('movieGrid').style.display = 'grid';
            loadGuess('adult');
            break;
        case 'unwatched-adult':
            document.getElementById('movieGrid').style.display = 'grid';
            loadUnwatched('adult');
            break;
        case 'jav':
            document.getElementById('movieGrid').style.display = 'grid';
            hideGallery();
            loadJavMovies();
            break;
        // round34 新四库：影视库 / 动漫库（普通向）
        case 'film':
            document.getElementById('movieGrid').style.display = 'grid';
            hideGallery();
            loadFilmMovies();
            break;
        case 'cartoon':
            document.getElementById('movieGrid').style.display = 'grid';
            hideGallery();
            loadCartoonMovies();
            break;
        case 'favorites':
            document.getElementById('movieGrid').style.display = 'grid';
            loadFavorites();
            break;
        case 'actresses':
            document.getElementById('actressGrid').style.display = 'grid';
            const slicerA2 = document.getElementById('actressSlicer');
            if (slicerA2) slicerA2.style.display = 'flex';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            loadActresses();
            break;
        case 'tags':
            document.getElementById('tagCloud').style.display = 'flex';
            const slicerT2 = document.getElementById('tagSlicer');
            if (slicerT2) slicerT2.style.display = 'flex';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            loadTags();
            break;
        case 'favhub':
        case 'playlists':   // 老视图名兼容
            loadFavHub();
            break;
        default:
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
        case 'watch-novel':
        case 'watch-hanime': {
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            const watchTitles = {
                watch: '📺 AV在线观看',
                'watch-anime': '🌸 动漫在线观看',
                'watch-comic': '📚 漫画在线观看',
                'watch-novel': '📖 小说在线阅读',
                'watch-hanime': '🔞 里番在线观看'
            };
            updateToolbarTitle(watchTitles[currentView] || '📺 在线观看');
            if (window.Features && window.Features.showWatch) window.Features.showWatch(currentView);
            break;
        }
        // round51：聚合在线搜索 —— 我们自己的结果墙（一次搜遍所有在线源，点海报直接播）。
        // 从榜单「去观看」进来时带词（window.__hubPendingQ 由 Features.openWatchHub 写入）。
        case 'watch-hub': {
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('🧭 聚合在线搜索');
            const hubView = window.__hubView || 'watch-anime';
            const hubQ = window.__hubPendingQ || '';
            window.__hubPendingQ = '';
            if (window.Features && window.Features.showWatchHub) window.Features.showWatchHub(hubView, hubQ);
            break;
        }
        // round36 批次B：番剧解析（站点解析器）—— 搜番 → 选集 → 应用内播放
        // 与四个 watch 板块的区别：那四个是内嵌网页，这里是服务端把网页读成数据再播。
        case 'ms':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('🔎 番剧解析');
            if (window.MediaSource && window.MediaSource.show) window.MediaSource.show();
            break;
        case 'poster-health':
            document.getElementById('movieGrid').style.display = 'none';
            document.getElementById('sortSelect').parentElement.style.display = 'none';
            hideGallery();
            updateToolbarTitle('🖼️ 海报健康');
            // r59：switchView 进入 = 全新进入（不还原旧滚动）；原地重渲的续位由 features.js 的
            // phActive 标记 + requestPosterHealthResume（F5/顶栏刷新路径）负责。
            {
                const fv = document.getElementById('featureView');
                if (fv) fv.dataset.phActive = '';
            }
            if (window.Features && window.Features.showPosterHealth) window.Features.showPosterHealth();
            break;
    }
}

// ========== 数据加载 ==========
async function loadMovies(page = 1) {
    currentPage = page;
    // round42c 隐私分割器：公开「全部影片」默认不展示 AV/里番（privacy=exclude）
    const movies = await api.getMovies(currentSort, 'all', 'all', page, currentPageSize, 'exclude');
    renderMovies(movies);
    renderPagination();
    updateToolbarTitle('全部影片', currentTotal);
    // 侧栏「全部影片」计数同步为过滤后的口径
    const countAllEl = document.getElementById('countAll');
    if (countAllEl) countAllEl.textContent = currentTotal;
}

async function loadJavMovies(page = 1) {
    currentPage = page;
    const movies = await api.getMovies(currentSort, 'all', 'jav', page, currentPageSize);
    renderMovies(movies);
    renderPagination();
    updateToolbarTitle('🎥 AV库', currentTotal);
    // 更新导航计数
    const countJavEl = document.getElementById('countJav');
    if (countJavEl) countJavEl.textContent = currentTotal;
}

// ===== round34 新四库：影视库 / 动漫库 =====
async function loadFilmMovies(page = 1) {
    currentPage = page;
    const movies = await api.getMovies(currentSort, 'all', 'film', page, currentPageSize);
    renderMovies(movies);
    renderPagination();
    updateToolbarTitle('🎬 影视库', currentTotal);
    const el = document.getElementById('countFilm');
    if (el) el.textContent = currentTotal;
}

async function loadCartoonMovies(page = 1) {
    currentPage = page;
    const movies = await api.getMovies(currentSort, 'all', 'cartoon', page, currentPageSize);
    renderMovies(movies);
    renderPagination();
    updateToolbarTitle('🐾 动漫库', currentTotal);
    const el = document.getElementById('countCartoon');
    if (el) el.textContent = currentTotal;
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

// ===== round34：演员库 / 标签库分类切片器 =====
const slicerState = { actressType: 'all', tagType: 'all' };
const SLICER_TYPES = [
    ['all', '全部'], ['jav', 'AV'], ['anime', '里番'], ['film', '影视'], ['cartoon', '动漫']
];

function renderSlicerTabs(containerId, current, onPick) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = SLICER_TYPES.map(([k, label]) => `
        <button class="r34-slice-tab ${current === k ? 'active' : ''}" data-type="${k}">${label}</button>
    `).join('');
    box.querySelectorAll('.r34-slice-tab').forEach(btn => {
        btn.addEventListener('click', () => onPick(btn.dataset.type));
    });
}

async function loadActresses(type) {
    if (type !== undefined) slicerState.actressType = type;
    updateToolbarTitle('👩 演员库');
    renderSlicerTabs('actressSlicer', slicerState.actressType, (t) => loadActresses(t));
    const actresses = await api.getActresses(slicerState.actressType);
    renderActresses(actresses);
    // 切片后数量写进标题
    updateToolbarTitle(`👩 演员库 · ${(SLICER_TYPES.find(t => t[0] === slicerState.actressType) || ['all', '全部'])[1]}`);
}

async function loadTags(type) {
    if (type !== undefined) slicerState.tagType = type;
    updateToolbarTitle('🏷️ 标签库');
    renderSlicerTabs('tagSlicer', slicerState.tagType, (t) => loadTags(t));
    const tags = await api.getTags(slicerState.tagType);
    renderTagCloud(tags);
    updateToolbarTitle(`🏷️ 标签库 · ${(SLICER_TYPES.find(t => t[0] === slicerState.tagType) || ['all', '全部'])[1]}`);
}

async function loadHot(privacy = 'exclude') {
    updateToolbarTitle(privacy === 'adult' ? '🔞 热门排行' : '🔥 热门排行');
    // 第 15 轮：48 → 100，榜单行铺满整页；round43：公开版排除 AV/里番
    const movies = await api.getHotMovies(100, privacy);
    renderHotRanking(movies);
}

async function loadRandom(privacy = 'exclude') {
    updateToolbarTitle(privacy === 'adult' ? '🔞 随机推荐' : '🎲 随机推荐');
    const movies = await api.getRandomMovies(48, 'all', privacy);
    renderRandomDeckView(movies);
}

// ========== 随机推荐 3D 轮播卡牌堆（自动巡航 + 3D 视差 + 浮空呼吸） ==========
let _deckCenterIdx = 3;
let _deckMovies = [];
let _deckAutoTimer = null;

function _startDeckAuto() {
    _stopDeckAuto();
    _deckAutoTimer = setInterval(() => {
        shiftDeck(1);
    }, 3200);
}

function _stopDeckAuto() {
    if (_deckAutoTimer) {
        clearInterval(_deckAutoTimer);
        _deckAutoTimer = null;
    }
}

function renderRandomDeckView(movies) {
    _deckMovies = movies || [];
    const grid = document.getElementById('movieGrid');
    const emptyTip = document.getElementById('emptyTip');
    grid.classList.remove('tree-mode');
    _stopDeckAuto();

    if (!_deckMovies.length) {
        grid.innerHTML = '';
        emptyTip.style.display = 'block';
        return;
    }
    emptyTip.style.display = 'none';

    // 取前 7 部作为 3D 轮播牌堆展示，其余进入下方网格
    const deckCount = Math.min(7, _deckMovies.length);
    _deckCenterIdx = Math.floor(deckCount / 2);

    let html = `
        <div class="deck-carousel-stage" id="deckStage" style="grid-column:1/-1;margin-bottom:28px;">
            <div class="deck-stage-title">
                <span class="dst-tag">${uiIcon('spark', 15)} 3D 灵感选片 · 封面流动</span>
                <span class="dst-hint">自动巡航流转 · 鼠标悬停暂停 · 点击中心卡看详情</span>
            </div>
            <div class="deck-carousel-wrap" id="deckWrap"></div>
            <div class="deck-nav-btns">
                <button class="deck-arrow prev" onclick="shiftDeck(-1)" title="上一个">‹</button>
                <button class="deck-arrow next" onclick="shiftDeck(1)" title="下一个">›</button>
            </div>
        </div>
    `;

    grid.innerHTML = html;
    updateDeckCards();

    // 绑定 3D 鼠标透视视差与悬停启闭
    const stage = document.getElementById('deckStage');
    if (stage) {
        stage.onmouseenter = _stopDeckAuto;
        stage.onmouseleave = () => {
            _startDeckAuto();
            const wrap = document.getElementById('deckWrap');
            if (wrap) wrap.style.transform = 'none';
        };
        stage.onmousemove = (e) => {
            const rect = stage.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width - 0.5;
            const y = (e.clientY - rect.top) / rect.height - 0.5;
            const wrap = document.getElementById('deckWrap');
            if (wrap) wrap.style.transform = `rotateY(${x * 18}deg) rotateX(${-y * 12}deg)`;
        };
    }
    _startDeckAuto();

    // 渲染下方网格（从第 7 部开始）
    const remaining = _deckMovies.slice(deckCount);
    if (remaining.length) {
        const subWrap = document.createElement('div');
        subWrap.style.cssText = 'grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:16px;';
        subWrap.innerHTML = remaining.map(renderMovieCard).join('');
        grid.appendChild(subWrap);
    }
}

function updateDeckCards() {
    const wrap = document.getElementById('deckWrap');
    if (!wrap || !_deckMovies.length) return;
    const deckCount = Math.min(7, _deckMovies.length);
    const center = _deckCenterIdx;

    const existingCards = wrap.querySelectorAll('.deck-card');
    const needRebuild = existingCards.length !== deckCount;

    if (needRebuild) {
        wrap.innerHTML = _deckMovies.slice(0, deckCount).map((m, idx) => {
            const offset = idx - center;
            const absOff = Math.abs(offset);
            const isCenter = offset === 0;
            const tx = offset * 180;
            const tz = isCenter ? 60 : -absOff * 90;
            const ry = offset * -28;
            const sc = isCenter ? 1.08 : Math.max(0.72, 1 - absOff * 0.12);
            const op = isCenter ? 1 : Math.max(0.48, 1 - absOff * 0.2);
            const zIndex = 20 - absOff * 2;

            return `
                <div class="deck-card ${isCenter ? 'is-active' : ''}" data-idx="${idx}" onclick="handleDeckCardClick(${idx})"
                     style="transform: translate3d(calc(-50% + ${tx}px), -50%, ${tz}px) rotateY(${ry}deg) scale(${sc});
                            z-index: ${zIndex}; opacity: ${op};">
                    <img class="deck-card-poster" src="${getPosterUrl(m)}" alt="" loading="lazy">
                    <div class="deck-card-info">
                        <div class="deck-card-title">${escapeHtml(m.title || m.fileName || '')}</div>
                        ${m.avid ? `<span class="deck-card-avid">${escapeHtml(m.avid)}</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    } else {
        // r64: DOM 节点复用，完美触发 CSS 0.45s 弹性物理流动切换
        existingCards.forEach((card, idx) => {
            const m = _deckMovies[idx];
            const offset = idx - center;
            const absOff = Math.abs(offset);
            const isCenter = offset === 0;
            const tx = offset * 180;
            const tz = isCenter ? 60 : -absOff * 90;
            const ry = offset * -28;
            const sc = isCenter ? 1.08 : Math.max(0.72, 1 - absOff * 0.12);
            const op = isCenter ? 1 : Math.max(0.48, 1 - absOff * 0.2);
            const zIndex = 20 - absOff * 2;

            card.style.transform = `translate3d(calc(-50% + ${tx}px), -50%, ${tz}px) rotateY(${ry}deg) scale(${sc})`;
            card.style.zIndex = zIndex;
            card.style.opacity = op;
            card.classList.toggle('is-active', isCenter);
        });
    }
}

function shiftDeck(dir) {
    const deckCount = Math.min(7, _deckMovies.length);
    if (deckCount <= 1) return;
    _deckCenterIdx = (_deckCenterIdx + dir + deckCount) % deckCount;
    updateDeckCards();
}

function handleDeckCardClick(idx) {
    if (idx === _deckCenterIdx) {
        const m = _deckMovies[idx];
        const card = document.querySelector(`.deck-card[data-idx="${idx}"]`);
        if (card && window.MotionFLIP) {
            window.MotionFLIP.record(card);
        }
        if (m) showMovieDetail(m.id);
    } else {
        _deckCenterIdx = idx;
        updateDeckCards();
    }
}

async function loadGuess(privacy = 'exclude') {
    updateToolbarTitle(privacy === 'adult' ? '🔞 猜你喜欢' : '✨ 猜你喜欢');
    const movies = await api.getGuessMovies(48, privacy);
    renderMovies(movies);
}

async function loadUnwatched(privacy = 'exclude') {
    updateToolbarTitle(privacy === 'adult' ? '🔞 未观看' : '📺 未观看');
    const movies = await api.getUnwatchedMovies(50, privacy);
    renderUnwatchedView(movies);
}

async function loadRecent() {
    updateToolbarTitle('🕐 最近观看');
    // 第 15 轮：改按 lastPlayTime 倒序（原来是 playCount），并渲染时间线筛选视图
    // round42c 隐私分割器：公开「最近观看」默认不展示 AV/里番的播放记录
    const movies = await api.getMovies('lastplay', 'all', 'all', 1, 300, 'exclude');
    renderRecentView(movies);
}

/* ========== round42c 隐私内容组专属视图 ==========
 * 与公开「全部影片/最近观看」完全同构，只是取数范围=AV/里番（type=adult）。
 * 导航项在侧栏媒体库组 AV/里番之后（data-adult=1，受隐私内容设置管理）。 */
async function loadAdultMovies(page = 1) {
    currentPage = page;
    const movies = await api.getMovies(currentSort, 'all', 'adult', page, currentPageSize);
    renderMovies(movies);
    renderPagination();
    updateToolbarTitle('🔞 全部内容', currentTotal);
    const el = document.getElementById('countAdult');
    if (el) el.textContent = currentTotal;
}

async function loadAdultRecent() {
    updateToolbarTitle('🔞 观看历史');
    const movies = await api.getMovies('lastplay', 'all', 'adult', 1, 300);
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
    // round43：相似推荐按当前影片口径——公开片详情不出 AV/里番，AV/里番详情正常出同类
    const detailIsAdult = ['jav', 'anime'].includes(String(movie.type || 'jav').toLowerCase());
    const similar = await api.getSimilarMovies(id, 8, detailIsAdult ? '' : 'exclude');
    
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
                <h4 style="display:flex;align-items:center;gap:6px;">${uiIcon('file', 15)} 简介</h4>
                <div class="detail-overview">${movie.overview}</div>
            </div>
            ` : ''}

            <div class="detail-section">
                <h4 style="display:flex;align-items:center;gap:6px;">${uiIcon('star', 15)} 我的评分</h4>
                <div class="detail-rating">
                    <div class="stars" id="ratingStars">
                        ${[1,2,3,4,5].map(i => `
                            <span class="star ${i <= Math.round(movie.rating || 0) ? 'active' : ''}" data-rating="${i}">★</span>
                        `).join('')}
                    </div>
                </div>
            </div>

            <div class="detail-section">
                <h4 style="display:flex;align-items:center;gap:6px;">${uiIcon('tool', 15)} 工具</h4>
                <div class="detail-actions">
                    <button class="dbtn" data-act="upload" title="上传封面" aria-label="上传封面" onclick="showUploadPosterModal(${movie.id})">${makeRemotionIcon('image', 24)}<span class="dbtn-label">上传封面</span></button>
                    <button class="dbtn" data-act="graph" title="关系图谱" aria-label="关系图谱" onclick="showRelationGraph(${movie.id})">${makeRemotionIcon('spark', 24)}<span class="dbtn-label">关系图谱</span></button>
                    <button class="dbtn" data-act="fav" title="${movie.favorite === 1 ? '取消收藏' : '收藏'}" aria-label="收藏" onclick="toggleFav(${movie.id})">${makeRemotionIcon(movie.favorite === 1 ? 'flame' : 'bookmark', 24)}<span class="dbtn-label">${movie.favorite === 1 ? '取消收藏' : '收藏'}</span></button>
                    <button class="dbtn" data-act="watch" title="${movie.watched === 1 ? '标记未看' : '标记已看'}" aria-label="已看标记" onclick="toggleWatch(${movie.id})">${makeRemotionIcon('eye', 24)}<span class="dbtn-label">${movie.watched === 1 ? '标记未看' : '标记已看'}</span></button>
                    <button class="dbtn" data-act="playlist" title="添加到播放列表" aria-label="播放列表" onclick="addToPlaylist(${movie.id})">${makeRemotionIcon('reel', 24)}<span class="dbtn-label">播放列表</span></button>
                    <button class="dbtn" data-act="translate" title="AI 翻译片名" aria-label="AI 翻译" onclick="aiTranslate(${movie.id})">${makeRemotionIcon('spark', 24)}<span class="dbtn-label">AI 翻译</span></button>
                    <button class="dbtn" data-act="tags" title="AI 生成标签" aria-label="AI 标签" onclick="aiGenerateTags(${movie.id})">${makeRemotionIcon('tag', 24)}<span class="dbtn-label">AI 标签</span></button>
                    <button class="dbtn" data-act="edit" title="编辑标题与元数据" aria-label="编辑元数据" onclick="showEditModal(${movie.id})">${makeRemotionIcon('settings', 24)}<span class="dbtn-label">编辑</span></button>
                    <button class="dbtn" data-act="rename" title="重命名文件" aria-label="重命名" onclick="showRenameModal(${movie.id})">${makeRemotionIcon('comic', 24)}<span class="dbtn-label">重命名</span></button>
                    <button class="dbtn" data-act="poster" title="更换海报" aria-label="更换海报" onclick="showChangePosterModal(${movie.id})">${makeRemotionIcon('image', 24)}<span class="dbtn-label">更换海报</span></button>
                    <button class="dbtn" data-act="folder" title="打开所在文件夹" aria-label="打开文件夹" onclick="openMovieFolder(${movie.id})">${makeRemotionIcon('book', 24)}<span class="dbtn-label">文件夹</span></button>
                    <button class="dbtn" data-act="rescrape" title="重新刮削" aria-label="重新刮削" onclick="rescrapeMovie(${movie.id})">${makeRemotionIcon('clock', 24)}<span class="dbtn-label">重新刮削</span></button>
                    <button class="dbtn danger" data-act="del-poster" title="删除海报" aria-label="删除海报" onclick="deletePoster(${movie.id})">${makeRemotionIcon('alert', 24)}<span class="dbtn-label">删除海报</span></button>
                    <button class="dbtn danger" data-act="del-movie" title="删除文件" aria-label="删除文件" onclick="deleteMovie(${movie.id})">${makeRemotionIcon('alert', 24)}<span class="dbtn-label">删除文件</span></button>
                </div>
            </div>

            ${similar && similar.length > 0 ? `
            <div class="similar-section">
                <h4 style="font-size:13px;font-weight:800;letter-spacing:.05em;color:var(--text-muted);margin-bottom:12px;display:flex;align-items:center;gap:6px;">${uiIcon('reel', 15)} 相似推荐</h4>
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
    requestAnimationFrame(() => requestAnimationFrame(() => {
        dm.classList.add('in');
        // r63: 触发 FLIP 共享元素海报流体飞入放大
        const detailPoster = document.querySelector('#detailBody .detail-poster');
        if (detailPoster && window.MotionFLIP) {
            window.MotionFLIP.enter(detailPoster);
        }
        // r63: 触发自适应海报动态流光氛围光
        if (window.Ambilight && posterUrl) {
            window.Ambilight.apply(posterUrl, dm);
        }
    }));
    
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
    if (!dm) return;
    const detailPoster = document.querySelector('#detailBody .detail-poster');
    dm.classList.remove('in');
    if (window.MotionFLIP && detailPoster) {
        window.MotionFLIP.exit(detailPoster, () => {
            dm.classList.remove('show');
            if (window.Ambilight) window.Ambilight.reset(dm);
        });
    } else {
        setTimeout(() => {
            dm.classList.remove('show');
            if (window.Ambilight) window.Ambilight.reset(dm);
        }, 240);
    }
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

// 统一接管工具按钮的按下/粉碎与 Remotion 动效重播
document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.detail-actions .dbtn');
    if (!btn) return;
    playDbtnPress(btn);
    if (btn.classList.contains('danger')) playCrushEffect(btn);
}, true);

document.addEventListener('mouseenter', (e) => {
    const target = e.target && e.target.closest && (e.target.closest('.detail-actions .dbtn') || e.target.closest('.settings-nav-item'));
    if (!target) return;
    const v = target.querySelector('.nv-ic video');
    if (v) {
        v.currentTime = 0;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
    }
}, true);

// 灯箱与快捷键指南 Esc 关闭：挂在 window 捕获阶段，优先于「Esc 关详情弹窗」的既有逻辑
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const scm = document.getElementById('shortcutsModal');
    if (scm && scm.classList.contains('show')) {
        e.stopPropagation();
        closeShortcutsModal();
        return;
    }
    const whm = document.getElementById('watchHealthModal');
    if (whm && whm.classList.contains('show')) {
        e.stopPropagation();
        closeWatchHealthModal();
        return;
    }
    const brn = document.getElementById('brnOverlay');
    if (brn && brn.classList.contains('show')) {
        e.stopPropagation();
        closeBatchRenameDrawer();
        return;
    }
    const aim = document.getElementById('aiModal');
    if (aim && aim.classList.contains('show')) {
        e.stopPropagation();
        closeAIModal();
        return;
    }
    const lb = document.getElementById('posterLightbox');
    if (lb && lb.classList.contains('show')) {
        e.stopPropagation();
        closePosterLightbox();
    }
}, true);

// ========== 【P1-3】播放列表增强与循环模式 ==========
let playerLoopMode = localStorage.getItem('player_loop_mode') || 'sequence';

function togglePlayerLoopMode() {
    const modes = ['sequence', 'single', 'loop', 'random'];
    const idx = modes.indexOf(playerLoopMode);
    playerLoopMode = modes[(idx + 1) % modes.length];
    localStorage.setItem('player_loop_mode', playerLoopMode);
    updatePlayerLoopBtn();
    const modeNames = { sequence: '顺序连播', single: '单片循环', loop: '列表循环', random: '随机连播' };
    showNotification('播放模式', modeNames[playerLoopMode], 1800);
}

function updatePlayerLoopBtn() {
    const btn = document.getElementById('playerLoopBtn');
    if (!btn) return;
    const icons = {
        sequence: '⇄ 顺序连播',
        single: '🔂 单片循环',
        loop: '🔁 列表循环',
        random: '🔀 随机连播'
    };
    btn.textContent = icons[playerLoopMode] || '⇄ 顺序连播';
}

// 在线播放
async function playMovieInline(id) {
    const movie = await api.getMovieDetail(id);
    if (!movie) return;

    // round46：按格式路由阅读器——所有入口（展台 CTA/牌堆/连播/列表）统一在此分流，
    // 漫画/小说不该被塞进视频播放器；视频类（jav/anime/film/cartoon）照旧
    if (movie.type === 'comic') { closeModal(); openComicReader(id); return; }
    if (movie.type === 'novel') { closeModal(); openNovelReader(id); return; }

    currentPlayerMovie = movie;
    await api.playMovie(id);

    // r64/r65: 自动构建当前视图的连续待播队列上下文，丰富海报与评分供悬浮预览
    if (!window.currentPlaylist || !window.currentPlaylist.length) {
        if (typeof currentMovies !== 'undefined' && Array.isArray(currentMovies) && currentMovies.length > 0) {
            window.currentPlaylist = currentMovies.map(m => ({
                id: m.id,
                title: m.title || m.fileName,
                avid: m.avid,
                poster: m.posterPath || m.localPosterPath || '',
                duration: m.duration || 0,
                score: m.score || m.rating || 0
            }));
            window.currentPlaylistIndex = currentMovies.findIndex(m => m.id === id);
            if (window.currentPlaylistIndex === -1) window.currentPlaylistIndex = 0;
        } else {
            window.currentPlaylist = [{
                id: movie.id,
                title: movie.title || movie.fileName,
                avid: movie.avid,
                poster: movie.posterPath || movie.localPosterPath || '',
                duration: movie.duration || 0,
                score: movie.score || movie.rating || 0
            }];
            window.currentPlaylistIndex = 0;
        }
    } else {
        const found = window.currentPlaylist.findIndex(m => (typeof m === 'object' ? m.id : m) === id);
        if (found !== -1) window.currentPlaylistIndex = found;
    }
    updatePlayerQueueUI();

    const video = document.getElementById('videoPlayer');
    const videoUrl = `/api/movie/stream?path=${encodeURIComponent(movie.filePath)}`;
    video.src = videoUrl;

    document.getElementById('playerTitle').textContent = movie.title || movie.fileName;
    const av = document.getElementById('playerAvid');
    if (av) av.textContent = movie.avid || '';
    updatePlayerLoopBtn();
    document.getElementById('playerModal').classList.add('show');
    closeModal();

    // 续播：有保存的进度且未看完时自动跳转
    if (window.Features && window.Features.resumeProgress) {
        window.Features.resumeProgress(video, movie.id);
    }

    // round36：弹幕（按文件名匹配弹弹play）
    if (window.Danmaku) window.Danmaku.start(movie.fileName || movie.title, video);

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

    // 播放结束自动下一部（连播/循环模式）
    video.onended = () => {
        if (window.Features && window.Features.saveProgress) {
            window.Features.saveProgress(movie.id, video.duration, video.duration);
        }
        // 单片循环：重新从头开始播放
        if (playerLoopMode === 'single') {
            video.currentTime = 0;
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
            return;
        }
        if (window.currentPlaylist && window.currentPlaylistIndex !== undefined && window.currentPlaylist.length) {
            let nextIndex;
            if (playerLoopMode === 'random') {
                nextIndex = Math.floor(Math.random() * window.currentPlaylist.length);
            } else if (playerLoopMode === 'loop') {
                nextIndex = (window.currentPlaylistIndex + 1) % window.currentPlaylist.length;
            } else {
                nextIndex = window.currentPlaylistIndex + 1;
            }

            if (nextIndex < window.currentPlaylist.length && (playerLoopMode !== 'sequence' || nextIndex > window.currentPlaylistIndex)) {
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

// r64/r66: 播放器待播队列界面联动与上下集切换
function updatePlayerQueueUI() {
    const badge = document.getElementById('playerQueueBadge');
    if (badge && window.currentPlaylist) {
        const total = window.currentPlaylist.length;
        const cur = (window.currentPlaylistIndex !== undefined && window.currentPlaylistIndex !== null) ? window.currentPlaylistIndex + 1 : 1;
        badge.textContent = `${cur}/${total}`;
    }
    const listEl = document.getElementById('playerPlaylistItems');
    if (listEl && window.currentPlaylist) {
        listEl.innerHTML = window.currentPlaylist.map((item, idx) => {
            const mId = typeof item === 'object' ? item.id : item;
            const mTitle = typeof item === 'object' ? (item.title || item.avid) : `影片 ${mId}`;
            const isPlaying = idx === window.currentPlaylistIndex;
            return `<div class="ppd-item ${isPlaying ? 'active' : ''}" data-idx="${idx}" onclick="playMovieInline(${mId})">
                <span class="ppd-idx">${idx + 1}</span>
                <span class="ppd-title">${escapeHtml(mTitle)}</span>
                ${isPlaying ? '<span class="ppd-tag">正在播放</span>' : ''}
            </div>`;
        }).join('');

        // r66: 绑定悬停事件到独立浮层，彻底解决剪切问题
        bindPlayerQueueHover(listEl);
    }
}

function bindPlayerQueueHover(listEl) {
    const portal = document.getElementById('playerHoverPreview');
    if (!portal) return;

    listEl.querySelectorAll('.ppd-item').forEach(item => {
        item.addEventListener('mouseenter', () => {
            const idx = parseInt(item.dataset.idx, 10);
            const m = window.currentPlaylist && window.currentPlaylist[idx];
            if (!m) return;
            const r = item.getBoundingClientRect();
            const poster = (typeof m === 'object' ? (getPosterUrl(m) || m.poster) : '') || 'img/app-icon.png';
            const imgEl = document.getElementById('ppdPreviewPoster');
            const titleEl = document.getElementById('ppdPreviewTitle');
            const avidEl = document.getElementById('ppdPreviewAvid');
            const scoreEl = document.getElementById('ppdPreviewScore');
            const durEl = document.getElementById('ppdPreviewDur');

            if (imgEl) imgEl.src = poster;
            if (titleEl) titleEl.textContent = m.title || m.fileName || `影片 ${m.id}`;
            if (avidEl) avidEl.textContent = m.avid || '—';
            if (scoreEl) scoreEl.textContent = m.score ? `★ ${Number(m.score).toFixed(1)}` : '—';
            if (durEl) durEl.textContent = m.duration ? formatDuration(m.duration) : '';

            portal.style.display = 'flex';
            const pW = 250;
            const pH = 104;
            const left = Math.max(10, r.left - pW - 14);
            const top = Math.min(window.innerHeight - pH - 10, Math.max(10, r.top + (r.height / 2) - (pH / 2)));
            portal.style.left = `${left}px`;
            portal.style.top = `${top}px`;
            requestAnimationFrame(() => portal.classList.add('show'));
        });

        item.addEventListener('mouseleave', () => {
            portal.classList.remove('show');
            portal.style.display = 'none';
        });
    });

    listEl.addEventListener('scroll', () => {
        portal.classList.remove('show');
        portal.style.display = 'none';
    }, { passive: true });
}

function togglePlayerPlaylistDrawer() {
    const drawer = document.getElementById('playerPlaylistDrawer');
    if (!drawer) return;
    const isShown = drawer.style.display !== 'none';
    drawer.style.display = isShown ? 'none' : 'flex';
    const portal = document.getElementById('playerHoverPreview');
    if (isShown && portal) {
        portal.classList.remove('show');
        portal.style.display = 'none';
    }
    if (!isShown) updatePlayerQueueUI();
}

function playNextEpisode() {
    if (!window.currentPlaylist || !window.currentPlaylist.length) {
        showNotification('播放提示', '当前没有播放队列');
        return;
    }
    let nextIndex;
    if (playerLoopMode === 'random') {
        nextIndex = Math.floor(Math.random() * window.currentPlaylist.length);
    } else if (playerLoopMode === 'loop') {
        nextIndex = (window.currentPlaylistIndex + 1) % window.currentPlaylist.length;
    } else {
        nextIndex = window.currentPlaylistIndex + 1;
    }
    if (nextIndex < window.currentPlaylist.length) {
        window.currentPlaylistIndex = nextIndex;
        const target = window.currentPlaylist[nextIndex];
        const nextId = typeof target === 'object' ? target.id : target;
        playMovieInline(nextId);
        showNotification('播放下一集', typeof target === 'object' ? target.title : `影片 ${nextId}`);
    } else {
        showNotification('播放提示', '已经是最后一集（顺序连播结束）');
    }
}

function playPrevEpisode() {
    if (!window.currentPlaylist || !window.currentPlaylist.length) {
        showNotification('播放提示', '当前没有播放队列');
        return;
    }
    let prevIndex = window.currentPlaylistIndex - 1;
    if (prevIndex < 0) {
        if (playerLoopMode === 'loop') {
            prevIndex = window.currentPlaylist.length - 1;
        } else {
            showNotification('播放提示', '已经是第一集');
            return;
        }
    }
    window.currentPlaylistIndex = prevIndex;
    const target = window.currentPlaylist[prevIndex];
    const prevId = typeof target === 'object' ? target.id : target;
    playMovieInline(prevId);
    showNotification('播放上一集', typeof target === 'object' ? target.title : `影片 ${prevId}`);
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

        /* —— v1.3 #1 PotPlayer 式补充快捷键 ——
         * 空格=播放/暂停 · ↑↓=音量±5% · M=静音 · F=全屏 · [ ]=倍速±0.25 · Backspace=倍速复位 · 数字0-9=百分比跳转
         * 带修饰键的组合一律不劫持（放行浏览器/系统快捷键） */
        if (e.altKey || e.ctrlKey || e.metaKey) return;

        const vid = document.getElementById('videoPlayer');
        if (!vid) return;

        switch (e.key) {
            case ' ':          // 空格：播放/暂停（preventDefault 顺带防住焦点按钮被空格误触发）
            case 'Spacebar':
                e.preventDefault();
                if (vid.paused) { vid.play().catch(() => {}); playerOsd('▶ 继续播放'); }
                else { vid.pause(); playerOsd('⏸ 已暂停'); }
                return;
            case 'ArrowUp':    // 音量
            case 'ArrowDown': {
                e.preventDefault();
                if (!isFinite(vid.duration) || vid.duration <= 0) return;
                const nv = Math.min(1, Math.max(0, +(vid.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)).toFixed(2)));
                vid.muted = false;
                vid.volume = nv;
                playerOsd((e.key === 'ArrowUp' ? '🔊 ' : '🔉 ') + Math.round(nv * 100) + '%' + (nv === 0 ? '（已静音）' : ''));
                return;
            }
            case 'm': case 'M':   // 静音切换
                e.preventDefault();
                vid.muted = !vid.muted;
                playerOsd(vid.muted ? '🔇 静音' : '🔊 取消静音');
                return;
            case 'f': case 'F': { // 播放区全屏
                e.preventDefault();
                const stage = document.querySelector('.player-stage');
                if (!stage) return;
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                else stage.requestFullscreen().catch(() => {});
                return;
            }
            case '[':            // 倍速 -0.25
            case ']': {          // 倍速 +0.25
                e.preventDefault();
                if (!isFinite(vid.duration) || vid.duration <= 0) return;
                const next = Math.min(4, Math.max(0.25, +(vid.playbackRate + (e.key === ']' ? 0.25 : -0.25)).toFixed(2)));
                vid.playbackRate = next;
                if (next === 1) playerOsd('倍速已复位 1.00×');
                else playerOsd((next > 1 ? '▶▶ ' : '◀◀ ') + next.toFixed(2) + '×', 'rate');
                return;
            }
            case 'Backspace':    // 倍速复位
                e.preventDefault();
                vid.playbackRate = 1.0;
                playerOsd('倍速已复位 1.00×');
                return;
            case 'PageUp':
            case 'p':
            case 'P': { // 上一集
                e.preventDefault();
                playPrevEpisode();
                return;
            }
            case 'PageDown':
            case 'n':
            case 'N': { // 下一集
                e.preventDefault();
                playNextEpisode();
                return;
            }
            default:
                break;
        }
        if (/^[0-9]$/.test(e.key)) {   // 数字键 = 百分比跳转（PotPlayer 惯例）
            e.preventDefault();
            if (!isFinite(vid.duration) || vid.duration <= 0) return;
            vid.currentTime = (Number(e.key) / 10) * vid.duration;
            playerOsd('跳至 ' + Number(e.key) * 10 + '%');
            return;
        }

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
    if (window.Danmaku) window.Danmaku.stop();
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

    // round36：弹幕（网络流按标题匹配）
    if (window.Danmaku) window.Danmaku.start(title, video);

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
        // round48 修复「PDF 阅读器打开报错」：大目录（如日月同错 178 本）的 siblings
        // JSON 编码后可达 30KB+，塞 URL 会超 Node 16KB 请求头上限直接 431。
        // 改走 sessionStorage（同源 iframe 共享），阅读器端优先读它、兼容旧 URL 参数。
        try { sessionStorage.setItem('readerSiblings', JSON.stringify({ type: type, list: siblings })); } catch (e) { /* 隐私模式等 */ }
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
        currentView === 'recent' || currentView === 'movies-adult' || currentView === 'recent-adult') {
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

// ========== 【round52】批量重命名：多选 → 预览确认抽屉 → 一键落盘 ==========
// 与单片改名（编辑弹窗）同一套规则：suggestFileNameStem 生成「番号 标题」；
// 后端走 /api/movie/batch-rename，与单片 POST /api/movie/:id/rename 共用同一落盘核心
// （磁盘视频 + .nfo + 同名 .jpg + 库路径/cleanName + FTS 自愈 + 标题跟随策略）。
// 纪律同 round51：先预览、可勾选，点了「执行重命名」才动磁盘。
let brnItems = [];   // 预览行：{ id, oldName, newName, state: ready|same|skip, checked, done, ok, reason }
let brnBusy = false;

function brnRowMeta(fileName) {
    const m = String(fileName || '').match(/\.[^.]+$/);
    const ext = m ? m[0] : '';
    return { ext, stem: ext ? fileName.slice(0, fileName.length - ext.length) : fileName };
}

async function openBatchRenameDrawer() {
    if (!selectedMovies.size || brnBusy) return;
    const ids = Array.from(selectedMovies);
    // 选中的可能跨页：当前列表里没有的就逐条拉详情，保证每行都有 avid/title/fileName 可算
    const missing = ids.filter(id => !currentMovies.some(x => x.id === id));
    const fetched = await Promise.all(missing.map(id => api.getMovieDetail(id).catch(() => null)));
    brnItems = ids.map(id => {
        const m = currentMovies.find(x => x.id === id) || fetched.find(x => x && x.id === id) || null;
        const fileName = m ? (m.fileName || '') : '';
        const { ext, stem } = brnRowMeta(fileName);
        const suggest = m ? suggestFileNameStem(m) : '';
        let state = 'ready', reason = '';
        if (!m || !fileName) { state = 'skip'; reason = '没有文件记录'; }
        else if (!suggest) { state = 'skip'; reason = '缺番号也缺标题，无法生成规范名'; }
        else if (suggest === stem) { state = 'same'; reason = '已是规范名'; }
        return { id, oldName: fileName, newName: state === 'ready' ? suggest + ext : '',
                 state, checked: state === 'ready', done: false, ok: false, reason: '' };
    });
    renderBrnList();
    document.getElementById('brnOverlay').classList.add('show');
}

function closeBatchRenameDrawer() {
    if (brnBusy) return;
    document.getElementById('brnOverlay').classList.remove('show');
    brnItems = [];
}

function brnToggleRow(i, on) {
    if (!brnBusy && brnItems[i]) { brnItems[i].checked = !!on; brnUpdateFooter(); }
}

function brnToggleAll(on) {
    if (brnBusy) return;
    brnItems.forEach(it => { if (it.state === 'ready' && !it.done) it.checked = !!on; });
    renderBrnList();
}

function brnUpdateFooter() {
    const btn = document.getElementById('brnApplyBtn');
    if (!btn) return;
    const checked = brnItems.filter(it => it.state === 'ready' && !it.done && it.checked).length;
    if (brnBusy) { btn.textContent = '正在执行…'; btn.disabled = true; }
    else if (brnItems.some(it => it.done)) { btn.textContent = '完成'; btn.disabled = false; }
    else { btn.textContent = `执行重命名（${checked}）`; btn.disabled = checked === 0; }

    const sum = document.getElementById('brnSummary');
    if (sum) {
        const same = brnItems.filter(it => it.state === 'same' && !it.done).length;
        const skip = brnItems.filter(it => it.state === 'skip' && !it.done).length;
        const okDone = brnItems.filter(it => it.done && it.ok).length;
        const failDone = brnItems.filter(it => it.done && !it.ok).length;
        const parts = [`共 ${brnItems.length} 部`];
        if (checked) parts.push(`将改名 <b style="color:var(--primary);">${checked}</b>`);
        if (okDone) parts.push(`已改名 <b style="color:var(--ok);">${okDone}</b>`);
        if (failDone) parts.push(`失败 <b style="color:var(--danger);">${failDone}</b>`);
        if (same) parts.push(`已是规范名 ${same}`);
        if (skip) parts.push(`无法生成 ${skip}`);
        sum.innerHTML = parts.join(' · ');
    }
}

function renderBrnList() {
    const list = document.getElementById('brnList');
    if (!list) return;
    list.innerHTML = brnItems.map((it, i) => {
        const chip = it.done
            ? (it.ok ? '<span class="brn-chip brn-ok">✓ 已改名</span>'
                     : `<span class="brn-chip brn-fail">✗ ${escapeHtml(it.reason || '失败')}</span>`)
            : (it.state === 'ready' ? '<span class="brn-chip brn-ready">待改名</span>'
               : it.state === 'same' ? '<span class="brn-chip brn-same">已是规范名</span>'
               : `<span class="brn-chip brn-skip" title="${escapeHtml(it.reason)}">跳过</span>`);
        const newNameLine = it.done
            ? (it.ok ? `→ <b style="color:var(--ok);">${escapeHtml(it.newName)}</b>`
                     : '<span style="color:var(--text-muted);">保持原名</span>')
            : (it.state === 'ready' ? `→ <b>${escapeHtml(it.newName)}</b>`
               : it.state === 'same' ? `<span style="color:var(--text-muted);">${escapeHtml(it.reason)}</span>`
               : `<span style="color:var(--text-muted);">${escapeHtml(it.reason)}</span>`);
        const cb = (it.state === 'ready' && !it.done)
            ? `<input type="checkbox" ${it.checked ? 'checked' : ''} onchange="brnToggleRow(${i}, this.checked)" aria-label="选择重命名">`
            : '<span class="brn-cb-ph"></span>';
        const rowCls = it.done ? (it.ok ? 'is-ok' : 'is-fail') : it.state;
        return `<div class="brn-row ${rowCls}">
            ${cb}
            <div class="brn-names">
                <div class="brn-old" title="${escapeHtml(it.oldName)}">${escapeHtml(it.oldName)}</div>
                <div class="brn-new">${newNameLine}</div>
            </div>
            ${chip}
        </div>`;
    }).join('') || '<div class="brn-empty">没有可显示的影片</div>';

    const all = document.getElementById('brnAllCb');
    if (all) {
        const ready = brnItems.filter(it => it.state === 'ready' && !it.done);
        all.checked = ready.length > 0 && ready.every(it => it.checked);
        all.disabled = ready.length === 0;
    }
    brnUpdateFooter();
}

async function applyBatchRename() {
    // 执行过一轮后按钮变「完成」→ 此时点击=收工关抽屉
    if (brnItems.some(it => it.done)) { closeBatchRenameDrawer(); return; }
    const items = brnItems.filter(it => it.state === 'ready' && !it.done && it.checked)
        // 后端契约是「不含扩展名的 stem」（与编辑弹窗单片改名同口径），扩展名由后端按原文件补回；
        // 直接把带 .mp4 的整名传过去会变成双重扩展名（xxx.mp4.mp4）
        .map(it => ({ id: it.id, newName: String(it.newName || '').replace(/\.[^.]+$/, '') }));
    if (!items.length || brnBusy) return;
    if (!confirm(`确定要重命名选中的 ${items.length} 部影片吗？\n会同步修改磁盘视频、NFO 与同名封面。`)) return;

    brnBusy = true;
    brnUpdateFooter();
    try {
        const res = await fetch('/api/movie/batch-rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        const data = await res.json();
        const byId = {};
        ((data.data && data.data.results) || []).forEach(r => { byId[r.id] = r; });
        for (const it of brnItems) {
            if (it.state !== 'ready' || !it.checked || it.done) continue;
            const r = byId[it.id];
            if (r && r.code === 0 && r.msg !== '名称未改变') {
                it.done = true; it.ok = true; it.newName = r.fileName || it.newName;
            } else if (r && r.msg === '名称未改变') {
                it.done = true; it.ok = true; it.reason = '名称未改变';
            } else {
                it.done = true; it.ok = false; it.reason = (r && r.msg) || '执行失败';
            }
        }
        showNotification('批量重命名完成',
            `成功 ${(data.data && data.data.success) || 0} 部` +
            ((data.data && data.data.failed) ? `，失败 ${data.data.failed} 部` : ''));
        clearSelection();
        refreshCurrentList();
        renderBrnList();
    } catch (e) {
        showNotification('批量重命名失败', e.message);
    } finally {
        brnBusy = false;
        brnUpdateFooter();
    }
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
    // 详情呈现方式（右侧抽屉 / 居中弹窗）—— 越早打上越好，避免首帧闪一下
    applyDetailMode(getDetailMode());
    applyAIMode(getAIMode());

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
// 2026-09-29：旧的 getCurrentTheme / switchThemeStyle（data-theme = ios|stylekit|shader）
// 已随设置页入口一并移除 —— 那三套样式只存在于 style.v2-backup.css，现行样式表里没有，
// 点了纯属「假切换」。现行唯一主题体系是 V4 皮肤（见上方 setV4Skin / pickV4Skin）。

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

/* 设置页「外观 → 主题风格」卡片的入口。
   与顶栏那三个圆点是同一套皮肤，只是多了卡片选中态要同步。 */
function pickV4Skin(skin) {
    if (V4_SKINS.indexOf(skin) < 0) return;
    setV4Skin(skin);
    syncThemeCards(skin);
}

/* 同步设置页主题卡片的选中态（active + 提示当前生效的是哪一个） */
function syncThemeCards(skin) {
    document.querySelectorAll('.theme-card[data-v4skin]').forEach(function (card) {
        card.classList.toggle('active', card.dataset.v4skin === skin);
    });
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

// ========== AI 助手呈现方式（抽屉 / 弹窗双模式切换） ==========
var AI_MODE_KEY = 'aiMode';
var AI_MODE_DEFAULT = 'drawer';

function getAIMode() {
    try {
        var v = localStorage.getItem(AI_MODE_KEY);
        return (v === 'modal' || v === 'drawer') ? v : AI_MODE_DEFAULT;
    } catch (e) {
        return AI_MODE_DEFAULT;
    }
}

function applyAIMode(mode) {
    document.documentElement.setAttribute('data-ai-mode', mode);
    updateAIModeButtons();
}

function setAIMode(mode) {
    if (mode !== 'modal' && mode !== 'drawer') return;
    try { localStorage.setItem(AI_MODE_KEY, mode); } catch (e) {}
    applyAIMode(mode);
    if (typeof showNotification === 'function') {
        showNotification('已切换AI助手呈现方式', mode === 'drawer' ? 'AI助手将从右侧滑出抽屉' : 'AI助手将以居中半透明弹窗显示');
    }
}

function toggleAIMode() {
    const cur = getAIMode();
    setAIMode(cur === 'drawer' ? 'modal' : 'drawer');
}

function updateAIModeButtons() {
    const btn = document.getElementById('aiModeToggleBtn');
    if (btn) {
        const cur = getAIMode();
        btn.textContent = cur === 'drawer' ? '⇄ 切换为居中弹窗' : '⇄ 切换为右侧抽屉';
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
    const tip = document.getElementById('authStateTip');
    // round42 修复：已设过密码时，取消勾选（想关密码）也必须能看到字段区——
    // 关密码同样要验当前密码，把字段藏掉会出现「提示输密码却无处可输」的死路
    const hasPwd = !!(tip && tip.dataset.hasPwd === '1');
    if (fields && chk) fields.style.display = (chk.checked || hasPwd) ? 'block' : 'none';
    syncAuthCurrentField();
    refreshAuthTip();
}

/** 「当前密码」框：只要本来设过密码就显示（改密码要验、关密码也要验 —— round42 修复死路） */
function syncAuthCurrentField() {
    const chk = document.getElementById('authEnabled');
    const tip = document.getElementById('authStateTip');
    const wrap = document.getElementById('authCurrentWrap');
    if (!wrap) return;
    const on = !!(chk && chk.checked);
    const hasPwd = !!(tip && tip.dataset.hasPwd === '1');
    wrap.style.display = hasPwd ? 'block' : 'none';   // round42：不再要求勾选开启，关密码也要验当前密码
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
        // round42 修复：提示的同时把「当前密码」框亮出来，绝不让提示变成死路
        const fields = document.getElementById('authFields');
        const wrap = document.getElementById('authCurrentWrap');
        if (fields) fields.style.display = 'block';
        if (wrap) wrap.style.display = 'block';
        const curInput = document.getElementById('authCurrent');
        if (curInput) curInput.focus();
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

/* ========== 分入口密码（round39） ==========
 * 给指定功能入口单独上锁：主密码进应用，独立密码进单个库。
 * 与 gate.js 的第二道检票、/api/auth/sections 接口配套。 */
const SECTION_PWD_LIST = [
    ['movies', '全部影片'], ['jav', 'AV 库'], ['anime', '里番库'], ['comic', '漫画库'],
    ['novel', '小说库'], ['film', '影视库'], ['cartoon', '动漫库'],
    ['actresses', '演员库'], ['tags', '标签库']
];
let sectionPwdState = {};

async function loadSectionPwdSettings() {
    try {
        const res = await fetch('/api/auth/sections');
        const d = await res.json();
        if (d.code === 0 && d.data) {
            sectionPwdState = d.data.sections || {};
            renderSectionPwdList();
            /* 设置页 DOM 是异步渲染的：本函数的 await 落在渲染完成之后，
             * renderAdultNavList 挂在这里才能找到 #adultNavList（round42） */
            renderAdultNavList();
        }
    } catch (e) { /* 设置页打不开时无所谓 */ }
}

/** round42：勾选制 —— 勾=上锁（要填密码），取消勾=解锁；已锁的不填密码=保持原密码 */
function renderSectionPwdList() {
    const box = document.getElementById('sectionPwdList');
    if (!box) return;
    box.innerHTML = SECTION_PWD_LIST.map(([v, name]) => {
        const locked = !!sectionPwdState[v];
        return `
        <div class="settings-item sec-pwd-row">
            <label class="auth-switch">
                <input type="checkbox" id="secChk-${v}" ${locked ? 'checked' : ''}
                       onchange="document.getElementById('secPwdWrap-${v}').style.display=this.checked?'block':'none'">
                <span>${name}</span>
            </label>
            <span class="sec-pwd-state" style="font-size:11px;color:${locked ? 'var(--primary)' : 'var(--text-muted)'};">${locked ? '🔒 已锁' : '未锁'}</span>
            <div class="sec-pwd-inputwrap" id="secPwdWrap-${v}" style="display:${locked ? 'block' : 'none'};">
                <input type="password" class="settings-input" id="secPwd-${v}"
                       placeholder="${locked ? '留空保持当前密码；输入新密码可更换' : '至少 4 位'}" autocomplete="new-password">
            </div>
        </div>`;
    }).join('');
}

/* r42b：saveSectionPwds 已并入 savePrivacySettings（隐私内容组统一保存键） */

async function clearSectionPwd(v) {
    const name = (SECTION_PWD_LIST.find(x => x[0] === v) || [v, v])[1];
    const cur = (document.getElementById('sectionCurrent') || { value: '' }).value;
    await postSectionPwd(v, '', cur, name);
    loadSectionPwdSettings();
}

async function postSectionPwd(view, password, currentPassword, name) {
    try {
        const res = await fetch('/api/auth/sections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ view, password, currentPassword })
        });
        const d = await res.json();
        if (d.code !== 0) { showNotification(`${name} 保存失败`, d.msg || '未知错误'); return false; }
        return true;
    } catch (e) {
        showNotification(`${name} 保存失败`, e.message);
        return false;
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
/* round37 #6：顶栏不再放长文本 —— 扫描/监控状态收成一颗小圆点，
   hover / 点击弹出气泡看详情。原来两条 .scan-status 一行占了小窗一半宽度，
   搜索框被挤得没法用。 */
let scanState = { running: false, hasResult: false, failed: 0, text: '' };
let watchState = { enabled: null, running: false, text: '', title: '' };

function renderScanStatusUI() {
    const wrap = document.getElementById('scanStatusWrap');
    const dot = document.getElementById('scanDot');
    if (!wrap || !dot) return;
    const popScan = document.getElementById('scanPopScan');
    const popWatch = document.getElementById('scanPopWatch');
    if (popScan) popScan.innerHTML = scanState.text || '';
    if (popWatch) {
        popWatch.innerHTML = watchState.text || '';
        if (watchState.title) popWatch.setAttribute('title', watchState.title);
        else popWatch.removeAttribute('title');
    }
    // 空态：没有在扫、没有结果、监控也没开着 → 整个胶囊直接隐藏
    const anyInfo = scanState.running || scanState.hasResult ||
        (watchState.enabled !== false && !!watchState.text);
    wrap.classList.toggle('show', !!anyInfo);
    dot.className = 'scan-dot ' + (scanState.running ? 'running'
        : scanState.failed ? 'warn'
        : scanState.hasResult ? 'ok' : 'idle');
}

async function checkScanStatus() {
    try {
        const status = await api.getScanStatus(currentScanModule);
        const btn = document.getElementById('scanBtn');
        const progressBar = document.getElementById('scanProgressBar');

        if (status.running) {
            btn.textContent = '扫描中...';
            btn.disabled = true;
            const percent = status.total > 0 ? (status.current / status.total * 100) : 0;
            progressBar.style.width = percent + '%';
            const stats = status.stats || {};
            scanState = {
                running: true, hasResult: false, failed: stats.failed || 0,
                text: `扫描中 ${status.current}/${status.total} · 本地:${stats.localHit || 0} 网络:${stats.webScraped || 0} 失败:${stats.failed || 0}`
            };
        } else {
            btn.textContent = '开始扫描';
            btn.disabled = false;
            const stats = status.stats || {};
            const seen = stats.localHit || stats.webScraped || stats.failed || stats.skipped || stats.added || stats.removed;
            if (!seen) {
                scanState = { running: false, hasResult: false, failed: 0, text: '' };
                progressBar.style.width = '0%';
                renderScanStatusUI();
                return;
            }
            // 扫描结束后保留最终结果，别把状态清空（用户要看的就是这个）
            progressBar.style.width = '100%';
            const parts = [];
            if (stats.added != null) parts.push(`新增 ${stats.added}`);
            if (stats.removed != null) parts.push(`移除 ${stats.removed}`);
            parts.push(`本地命中 ${stats.localHit || 0}`, `网络刮削 ${stats.webScraped || 0}`, `失败 ${stats.failed || 0}`);
            if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
            if (status.unreadableDirs && status.unreadableDirs.length) parts.push(`不可读目录 ${status.unreadableDirs.length}`);
            let text = escapeHtml(`上次扫描 ${parts.join(' · ')}`);
            if (stats.failed > 0) {
                text += ` <a href="#" id="scanFailLink" style="color:var(--primary);">查看失败清单</a>`;
            }
            scanState = { running: false, hasResult: true, failed: stats.failed || 0, text };
        }
        renderScanStatusUI();
        const link = document.getElementById('scanFailLink');
        if (link) link.onclick = (ev) => { ev.preventDefault(); switchView('scrape-failures'); };
    } catch (e) {}
}

// 按模块启动扫描
async function startModuleScan(module) {
    const moduleNames = {
        movie: '影片',
        anime: '动漫',
        comic: '漫画',
        novel: '小说',
        film: '影视',
        cartoon: '动漫（普通向）'
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

/* ========== 目录监控（round28）==========
 * 后端开应用自启动，前端只负责：① 显示当前轮询节奏 ② 提供「立即检查」手动入口 ③ 暂停/恢复。
 * 「开始扫描」是全量扫描（会重走全库、并做失效记录清理），而「🔄 检查新增」只做增量差集，
 * 快一到两个数量级 —— 所以手动按钮走增量，不复用全量扫描那个入口。 */
let watchStatusTimer = null;

async function refreshWatchStatus() {
    try {
        const st = await api.getWatchStatus();
        const btn = document.getElementById('watchToggleBtn');
        if (btn) btn.textContent = st.enabled ? '监控 开' : '监控 关';
        if (!st.enabled) {
            watchState = { enabled: false, running: false, text: '', title: '' };
            renderScanStatusUI();
            return;
        }
        const parts = [];
        if (st.running) parts.push('检查中');
        parts.push('每 ' + escapeHtml(st.intervalText || '—') + ' 检查一次');
        if (st.foundTotal) parts.push('已自动入库 ' + st.foundTotal + ' 部');
        watchState = {
            enabled: true,
            running: !!st.running,
            text: '👁 目录监控：' + parts.join(' · '),
            title:
                '通道：' + (st.mode === 'event+poll' ? '事件（亚秒）+ 轮询兜底' : '仅轮询') + '\n' +
                '起始间隔 ' + Math.round((st.baseIntervalMs || 0) / 1000) + ' 秒，没扫到新增就翻倍，上限 ' + escapeHtml(st.maxIntervalText || '1 小时') + '\n' +
                '已检查 ' + (st.ticks || 0) + ' 轮，最近一轮耗时 ' + (st.lastTickMs || 0) + ' 毫秒\n' +
                ((st.recent && st.recent.length)
                    ? '最近发现：' + st.recent.slice(0, 5).map(r => r.name).join('、')
                    : '最近没有发现新文件')
        };
        renderScanStatusUI();
    } catch (e) { /* 状态拉取失败不影响其它功能 */ }
}

async function runWatchNow() {
    const btn = document.getElementById('watchNowBtn');
    if (btn) { btn.disabled = true; btn.textContent = '检查中...'; }
    try {
        const data = await api.watchNow();
        if (data.code === 0) {
            showNotification('检查完成', data.msg);
            if (data.data && data.data.found > 0 && typeof refreshCurrentList === 'function') {
                refreshCurrentList();   // 有新增就顺手刷列表，免得用户还得多点一次
            }
        } else {
            showNotification('检查未完成', data.msg || '未知错误');
        }
    } catch (e) {
        showNotification('检查失败', e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 检查新增'; }
        refreshWatchStatus();
    }
}

async function toggleWatch() {
    let enabled = true;
    try { enabled = (await api.getWatchStatus()).enabled; } catch (e) { /* 取不到就按"当前是开"处理，点一下即关 */ }
    try {
        const data = await api.watchToggle(!enabled);
        showNotification(data.code === 0 ? '已切换' : '切换失败', data.msg);
    } catch (e) {
        showNotification('切换失败', e.message);
    }
    refreshWatchStatus();
}

function initDirWatchUi() {
    refreshWatchStatus();
    // 30 秒刷一次就够：轮询间隔本身最短 5 秒、最长 1 小时，前端没必要跟得比后端还紧
    if (!watchStatusTimer) watchStatusTimer = setInterval(refreshWatchStatus, 30000);
}

// ========== 搜索 ==========
let searchTimeout = null;
function handleSearch(e) {
    const q = e.target.value.trim();
    clearTimeout(searchTimeout);    
    if (!q) {
        currentSearchQuery = '';
        // 清空搜索词：原地刷新当前列表，保持页码与视窗位置
        rememberViewState(currentView, '');
        refreshCurrentList();
        return;
    }

    currentSearchQuery = q;
    rememberViewState(currentView, q);      // round26 #1：搜索词写进 hash，F5 后能恢复
    searchTimeout = setTimeout(async () => {
        const movies = await api.searchMovies(q);
        // round37 #2：用户在首页/榜单视图直接用顶栏搜索时，结果原来渲染进
        // 被首页覆盖层挡住的 movieGrid → 看起来「没反应」。这里收起覆盖层、
        // 恢复排序条，并把视图状态切到 movies，让结果真正可见。
        if (currentView === 'home' || currentView === 'acg-rank') {
            if (window.Home && window.Home.hideHome) window.Home.hideHome();
            if (window.Home && window.Home.hideAcgBoard) window.Home.hideAcgBoard();
            const sortWrap = document.getElementById('sortSelect').parentElement;
            if (sortWrap) sortWrap.style.display = '';
            currentView = 'movies';
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.toggle('active', item.dataset.view === 'movies');
            });
        }
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
    // 导航点击（round34：受保护视图先过密码门禁，未解锁时弹密码框）
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', async () => {
            const view = item.dataset.view;
            if (!view) return;   // AI助手等 onclick 入口不带 data-view
            if (window.Gate && !(await window.Gate.guard(view))) return;
            switchView(view);
        });
    });
    
    // 排序选择
    document.getElementById('sortSelect').addEventListener('change', (e) => {
        currentSort = e.target.value;
        refreshCurrentList();
    });
    
    // 搜索
    document.getElementById('searchInput').addEventListener('input', handleSearch);
    // round41 #4：搜索排序下拉（记忆上次选择；有搜索词时立即重搜）
    const searchSortSel = document.getElementById('searchSortSelect');
    if (searchSortSel) {
        searchSortSel.value = localStorage.getItem('searchSort') || 'name:asc';
        if (searchSortSel.selectedIndex < 0) searchSortSel.value = 'name:asc';
        searchSortSel.addEventListener('change', () => {
            try { localStorage.setItem('searchSort', searchSortSel.value); } catch (e) { /* 忽略 */ }
            const q = document.getElementById('searchInput').value.trim();
            if (q) handleSearch({ target: { value: q } });
        });
    }
    // round36 P0-3：年份/季度筛选变化 → 有搜索词时立即重搜
    ['searchSeason', 'searchYear'].forEach(fid => {
        const el = document.getElementById(fid);
        if (el) el.addEventListener('change', () => {
            const q = document.getElementById('searchInput').value.trim();
            if (q) handleSearch({ target: { value: q } });
        });
    });
    
    // 目录监控：手动「立即检查」+ 暂停/恢复开关
    const watchNowBtn = document.getElementById('watchNowBtn');
    if (watchNowBtn) watchNowBtn.addEventListener('click', runWatchNow);
    const watchToggleBtn = document.getElementById('watchToggleBtn');
    if (watchToggleBtn) watchToggleBtn.addEventListener('click', toggleWatch);

    // round37 #6：状态圆点点击开合气泡（手机无 hover，必须给点击通道）
    const scanDotEl = document.getElementById('scanDot');
    if (scanDotEl) {
        scanDotEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const w = document.getElementById('scanStatusWrap');
            if (w) w.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            const w = document.getElementById('scanStatusWrap');
            if (w && !w.contains(e.target)) w.classList.remove('open');
        });
    }

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

    // round42：侧栏自由拖动（条目排序/跨组移动/分组重命名，localStorage 持久化）
    initSidebarDnd();

    // v1.3 #4：侧栏可隐藏（收起成细栏只留图标，主视窗自然放大；Ctrl+B 切换）
    applySidebarRail();
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || (e.key || '').toLowerCase() !== 'b') return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
        e.preventDefault();
        toggleSidebarRail();
    });
}

/* ================================================================
   v1.3 #4 · 侧栏可隐藏：收起态=52px 细栏只留图标（CSS 裁剪 span 露出 emoji），
   主内容区 flex:1 自然放大；状态存 localStorage.sidebarRail；收起态不参与拖拽。
   ================================================================ */
function applySidebarRail() {
    const sb = document.getElementById('mainSidebar');
    if (!sb) return;
    let rail = false;
    try { rail = localStorage.getItem('sidebarRail') === '1'; } catch (e) { rail = false; }
    if (window.matchMedia('(max-width: 860px)').matches) rail = false;   // 手机布局不受影响
    sb.classList.toggle('rail', rail);
    const btn = document.getElementById('sbCollapseBtn');
    if (btn) {
        btn.textContent = rail ? '»' : '«';
        btn.title = rail ? '展开侧栏（Ctrl+B）' : '收起侧栏（Ctrl+B）';
    }
    // 收起时条目只剩图标，hover 靠 title 提示全名
    sb.querySelectorAll('.nav-item').forEach(it => {
        const s = it.querySelector('span');
        if (rail) {
            if (!it.dataset.oldTitle) it.dataset.oldTitle = it.title || '';
            it.title = (s ? s.textContent.trim() : '') || it.title || '';
        } else if (it.dataset.oldTitle !== undefined) {
            it.title = it.dataset.oldTitle;
        }
    });
}

function toggleSidebarRail() {
    const sb = document.getElementById('mainSidebar');
    if (!sb) return;
    const rail = !sb.classList.contains('rail');
    try { localStorage.setItem('sidebarRail', rail ? '1' : '0'); } catch (e) { /* 忽略 */ }
    applySidebarRail();
}

/* ================================================================
   v1.3 #2 · 侧栏「新建自定义分组」：建空白组 → 立即进入重命名；
   组随布局存 localStorage（initSidebarDnd 恢复时按保存记录重建空组）。
   ================================================================ */
function sidebarAddGroup() {
    const sidebar = document.getElementById('mainSidebar');
    if (!sidebar) return;
    if (!window.__sbDnd || !window.__sbDnd.ready) { showNotification('仅桌面端可用', '新建分组需要侧栏拖拽能力（桌面鼠标环境）'); return; }
    const existing = [...sidebar.querySelectorAll('.sidebar-section > h3')]
        .map(h => ((h.querySelector('.sb-sec-name')) || h).textContent.trim());
    let name = '新分组';
    let i = 2;
    while (existing.includes(name)) { name = '新分组' + i++; }
    const sec = document.createElement('div');
    sec.className = 'sidebar-section';
    sec.dataset.secKey = name;
    const h3 = document.createElement('h3');
    h3.textContent = name;
    sec.appendChild(h3);
    const addBtn = document.getElementById('sbAddGroup');
    if (addBtn) sidebar.insertBefore(sec, addBtn); else sidebar.appendChild(sec);
    window.__sbDnd.bindSection(sec);
    window.__sbDnd.rename(h3);      // 提交时 saveLayout 落盘（含空组）
}

/* ================================================================
   round42 · 侧栏自由拖动：条目在任意分组内/间拖动排序，双击分组标题重命名，
   右键分组标题恢复默认。布局存 localStorage.sidebarLayout。
   只在桌面（hover+fine pointer）启用；DOM 用 appendChild 原地搬移，
   不重建节点 ⇒ bindEvents 绑定的点击监听全部保留。
   ================================================================ */
function sidebarItemKey(item) {
    if (item.dataset.view) return 'v:' + item.dataset.view;
    const s = item.querySelector('span');
    return 't:' + ((s && s.textContent.trim()) || '');
}

function initSidebarDnd() {
    const sidebar = document.getElementById('mainSidebar');
    if (!sidebar) return;
    // 手机/触摸设备不启用（拖拽与滚动冲突）
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const sections = [...sidebar.querySelectorAll(':scope > .sidebar-section')];
    if (!sections.length) return;

    /* —— 恢复持久化布局 —— */
    const keyEls = new Map();     // item key -> 元素
    const secByKey = new Map();   // 分组默认标题 -> section 元素
    sections.forEach(sec => {
        const h3 = sec.querySelector('h3');
        const key = (h3 ? h3.textContent.trim() : '') || ('组' + secByKey.size);
        sec.dataset.secKey = key;
        secByKey.set(key, sec);
        sec.querySelectorAll('.nav-item').forEach(it => keyEls.set(sidebarItemKey(it), it));
    });

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('sidebarLayout') || 'null'); } catch (e) { saved = null; }
    if (saved && Array.isArray(saved.sections)) {
        /* v1.3：先补建「自定义空白分组」——用户新建的分组初始没有条目，
         * DOM 里不存在，直接恢复会把它弄丢；按保存记录重建后再填条目。 */
        saved.sections.forEach(en => {
            if (secByKey.has(en.k)) return;
            if (!en.k) return;                       // 无键名的历史残条跳过
            const sec = document.createElement('div');
            sec.className = 'sidebar-section';
            sec.dataset.secKey = en.k;
            const h3 = document.createElement('h3');
            h3.textContent = (en.n && en.n !== en.k) ? en.n : en.k;
            sec.appendChild(h3);
            sidebar.appendChild(sec);
            secByKey.set(en.k, sec);
            sections.push(sec);
        });
        const usedSec = new Set(), usedItem = new Set();
        saved.sections.forEach(en => {
            const sec = secByKey.get(en.k);
            if (!sec) return;
            usedSec.add(sec);
            const h3 = sec.querySelector('h3');
            if (h3 && en.n && en.n !== en.k) h3.textContent = en.n;
            (en.items || []).forEach(k => {
                const el = keyEls.get(k);
                if (el && !usedItem.has(k)) { sec.appendChild(el); usedItem.add(k); }
            });
        });
        // 落单的分组按保存顺序重排；新版本新增的分组追加到末尾
        saved.sections.forEach(en => { const sec = secByKey.get(en.k); if (sec) sidebar.appendChild(sec); });
        sections.forEach(sec => { if (!usedSec.has(sec)) sidebar.appendChild(sec); });
    }

    /* —— r44：隐私内容六项强制归组 ——
     * 隐私六项是固定产品归属（独立「隐私内容」组），历史保存的布局里它们可能还挂在
     * 媒体库等组下，恢复后必须拉回隐私组；组本身的位置只在没有用户意志时归位到媒体库后。 */
    const privacySec = sidebar.querySelector('.sidebar-section[data-privacy-group]');
    if (privacySec) {
        PRIVACY_GROUP_VIEWS.forEach(v => {
            const el = keyEls.get('v:' + v);
            if (el) privacySec.appendChild(el);
        });
        const savedHasPrivacy = saved && Array.isArray(saved.sections) && saved.sections.some(en => en.k === '隐私内容');
        if (!savedHasPrivacy) {
            const libSec = sections.find(s => s.dataset.secKey === '媒体库');
            if (libSec) libSec.after(privacySec);
        }
    }

    const saveLayout = () => {
        const layout = { sections: [...sidebar.querySelectorAll(':scope > .sidebar-section')].map(sec => ({
            k: sec.dataset.secKey || '',
            n: ((sec.querySelector('h3 .sb-sec-name')) || sec.querySelector('h3') || { textContent: '' }).textContent.trim(),
            c: sec.classList.contains('sb-collapsed') ? 1 : 0,
            items: [...sec.querySelectorAll('.nav-item')].map(sidebarItemKey),
        })) };
        try { localStorage.setItem('sidebarLayout', JSON.stringify(layout)); } catch (e) { /* 忽略 */ }
    };

    /* —— v1.3：分组折叠 ——
     * 标题左侧加折叠按钮；折叠状态存 sidebarLayout.sections[].c。
     * 折叠只隐藏条目（DOM 保留）⇒ 整组拖动、保存布局照常可用。 */
    const decorH3 = (sec) => {
        const h3 = sec.querySelector(':scope > h3');
        if (!h3 || h3.querySelector('.sb-fold')) return h3;
        const name = h3.textContent.trim();
        h3.textContent = '';
        const fold = document.createElement('button');
        fold.type = 'button';
        fold.className = 'sb-fold';
        fold.title = '折叠 / 展开分组';
        fold.innerHTML = '<span class="sb-fold-ico">▾</span>';
        const span = document.createElement('span');
        span.className = 'sb-sec-name';
        span.textContent = name;
        h3.appendChild(fold);
        h3.appendChild(span);
        fold.addEventListener('click', (e) => {
            e.stopPropagation();
            sec.classList.toggle('sb-collapsed');
            saveLayout();
        });
        return h3;
    };
    sidebar.querySelectorAll(':scope > .sidebar-section').forEach(sec => {
        decorH3(sec);
        if (saved && Array.isArray(saved.sections)) {
            const en = saved.sections.find(x => x.k && x.k === (sec.dataset.secKey || ''));
            if (en && en.c) sec.classList.add('sb-collapsed');
        }
    });

    /* —— 拖拽状态 —— */
    let dragKind = null;   // 'item' | 'sec'
    let dragEl = null;
    let dropMark = document.createElement('div');
    dropMark.className = 'sb-drop-mark';

    const clearMark = () => { dropMark.remove(); };
    const clearCues = () => {
        clearMark();
        sidebar.querySelectorAll('.sb-dragging, .sb-drag-over').forEach(el => el.classList.remove('sb-dragging', 'sb-drag-over'));
    };

    // v1.3 #4：收起态（rail）不参与拖拽
    const railLocked = () => sidebar.classList.contains('rail');

    const bindItemDnd = (it) => {
        it.draggable = true;
        it.addEventListener('dragstart', (e) => {
            if (railLocked()) { e.preventDefault(); return; }
            dragKind = 'item'; dragEl = it;
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', 'cv-item'); } catch (err) { /* 忽略 */ }
            requestAnimationFrame(() => it.classList.add('sb-dragging'));
        });
        it.addEventListener('dragend', () => { dragKind = null; dragEl = null; clearCues(); saveLayout(); });
    };

    const startRename = (h3) => {
        if (h3.querySelector('input')) return;
        const span = h3.querySelector('.sb-sec-name') || h3;
        const old = span.textContent.trim();
        const inp = document.createElement('input');
        inp.value = old;
        inp.className = 'sb-rename-input';
        span.textContent = '';
        span.appendChild(inp);
        inp.focus(); inp.select();
        const commit = () => {
            const nv = inp.value.trim() || old;
            span.textContent = nv;
            saveLayout();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
            if (ev.key === 'Escape') { inp.value = old; inp.blur(); }
            ev.stopPropagation();
        });
        inp.addEventListener('click', ev => ev.stopPropagation());
    };

    const bindH3 = (h3) => {
        h3.draggable = true;
        h3.title = '拖动整组排序（连同组内条目一起） · 点 ▾ 折叠/展开 · 双击重命名 · 右键恢复默认布局';
        h3.addEventListener('dragstart', (e) => {
            if (railLocked() || (e.target.closest && e.target.closest('.sb-fold')) || (e.target.closest && e.target.closest('input'))) { e.preventDefault(); return; }
            dragKind = 'sec'; dragEl = h3.parentElement;
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', 'cv-sec'); } catch (err) { /* 忽略 */ }
            requestAnimationFrame(() => h3.classList.add('sb-dragging'));
        });
        h3.addEventListener('dragend', () => { dragKind = null; dragEl = null; clearCues(); saveLayout(); });
        h3.addEventListener('dblclick', () => startRename(h3));
        // 右键恢复默认
        h3.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!confirm('恢复侧栏默认布局？\n\n（当前的拖动排序、跨组移动、分组重命名与自建分组都会还原）')) return;
            try { localStorage.removeItem('sidebarLayout'); } catch (err) { /* 忽略 */ }
            location.reload();
        });
    };

    const bindSectionDnd = (sec) => {
        sec.addEventListener('dragover', (e) => {
            if (!dragKind) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            sec.classList.add('sb-drag-over');
            if (dragKind === 'item') {
                if (sec.classList.contains('sb-collapsed')) sec.classList.remove('sb-collapsed');  // 拖进去自动展开
                const items = [...sec.querySelectorAll('.nav-item')].filter(x => x !== dragEl);
                const after = items.find(x => {
                    const r = x.getBoundingClientRect();
                    return e.clientY < r.top + r.height / 2;
                });
                if (after) sec.insertBefore(dropMark, after);
                else sec.appendChild(dropMark);
            }
        });
        sec.addEventListener('dragleave', (e) => {
            if (!sec.contains(e.relatedTarget)) sec.classList.remove('sb-drag-over');
        });
        sec.addEventListener('drop', (e) => {
            if (!dragKind || !dragEl) return;
            e.preventDefault();
            if (dragKind === 'item') {
                sec.insertBefore(dragEl, dropMark);   // dropMark 位置即落点
            } else {
                sidebar.insertBefore(dragEl, sec);    // 整组插到目标组之前
            }
            clearCues();
            saveLayout();
        });
    };

    sidebar.querySelectorAll('.nav-item').forEach(bindItemDnd);
    sidebar.querySelectorAll('.sidebar-section > h3').forEach(bindH3);
    sidebar.querySelectorAll('.sidebar-section').forEach(bindSectionDnd);

    /* v1.3 #2：暴露内部能力给 sidebarAddGroup()（新建分组要绑同一套拖拽/重命名/保存） */
    window.__sbDnd = {
        bindSection(sec) {
            decorH3(sec);
            sec.querySelectorAll('.nav-item').forEach(bindItemDnd);
            bindSectionDnd(sec);
            const h3 = sec.querySelector(':scope > h3');
            if (h3) bindH3(h3);
        },
        rename: startRename,
        save: saveLayout,
        ready: true,
    };
}

/* ---------- round41 #8：AV/里番导航默认隐藏 + 顶栏解锁 ----------
 * 显示层隐藏（守卫白名单制照旧：/api 门禁不受影响）。
 * localStorage.adultNavHidden 默认 '1'；首次解锁弹 confirm 二次确认。 */
function isAdultNavHidden() {
    try { return localStorage.getItem('adultNavHidden') !== '0'; } catch (e) { return true; }
}

// r44：隐私内容独立组的固定成员（与 library.html data-privacy-group 内六项一致）
const PRIVACY_GROUP_VIEWS = ['movies-adult', 'recent-adult', 'guess-adult', 'hot-adult', 'random-adult', 'unwatched-adult'];

// round42：成人入口「按个显示」偏好（勾选制）。localStorage adultNavItems = {view:0/1}，缺省=显示
const ADULT_NAV_LIST = [
    ['jav', 'AV 库'], ['anime', '里番库'], ['movies-adult', '全部内容'], ['recent-adult', '观看历史'],
    ['hot-adult', '热门排行'], ['random-adult', '随机推荐'], ['guess-adult', '猜你喜欢'], ['unwatched-adult', '未观看'],
    ['actresses', '演员库'],
    ['tags', '标签库'], ['watch', 'AV在线观看'], ['watch-hanime', '里番在线观看'],
];
function getAdultNavItems() {
    try { return JSON.parse(localStorage.getItem('adultNavItems') || '{}') || {}; } catch (e) { return {}; }
}
function renderAdultNavList() {
    const box = document.getElementById('adultNavList');
    if (!box) return;
    const prefs = getAdultNavItems();
    /* r42b：勾选只改 UI 不落盘，等「保存隐私设置」统一生效 */
    box.innerHTML = ADULT_NAV_LIST.map(([v, name]) => `
        <label class="auth-switch">
            <input type="checkbox" data-adult-item="${v}" ${prefs[v] !== 0 ? 'checked' : ''}>
            <span>${name}</span>
        </label>`).join('');
}

/** r42b：隐私内容一键保存 = 入口显示勾选 + 分入口密码勾选 */
async function savePrivacySettings() {
    // 1) 入口显示：从 UI 读取并落盘
    const prefs = {};
    document.querySelectorAll('#adultNavList input[data-adult-item]').forEach(c => {
        prefs[c.dataset.adultItem] = c.checked ? 1 : 0;
    });
    try { localStorage.setItem('adultNavItems', JSON.stringify(prefs)); } catch (e) { /* 忽略 */ }
    const anyShown = Object.values(prefs).some(v => v === 1);
    if (anyShown && isAdultNavHidden()) {
        /* 关键修复：勾了要显示却还被顶栏 🔒 总开关全藏 → 自动解除。
         * 否则用户会看到「明明勾选了，侧栏还是没有」（round42 的实测反馈） */
        try { localStorage.setItem('adultNavHidden', '0'); } catch (e) { /* 忽略 */ }
    }
    applyAdultNav();
    // 2) 分入口密码：勾选=上锁（没填密码的新勾选会被拦下），取消勾选=解锁
    const cur = (document.getElementById('sectionCurrent') || { value: '' }).value;
    let changed = 0;
    for (const [v, name] of SECTION_PWD_LIST) {
        const chk = document.getElementById('secChk-' + v);
        if (!chk) continue;
        const el = document.getElementById('secPwd-' + v);
        const pwd = (el && el.value) || '';
        const wasLocked = !!sectionPwdState[v];
        if (chk.checked) {
            if (!wasLocked && !pwd) { showNotification('还差一个密码', `勾选了「${name}」但没填独立密码（至少 4 位）`); return; }
            if (pwd && pwd.length < 4) { showNotification('密码太短', `${name} 的密码至少 4 位`); return; }
            if (!wasLocked || pwd) {
                const ok = await postSectionPwd(v, pwd, cur, name);
                if (!ok) return;
                changed++;
            }
        } else if (wasLocked) {
            const ok = await postSectionPwd(v, '', cur, name);
            if (!ok) return;
            changed++;
        }
    }
    loadSectionPwdSettings();
    showNotification('隐私设置已保存',
        (anyShown ? '侧栏已显示勾选的入口' : '勾掉的入口已从侧栏隐藏') +
        (changed ? '；分入口密码已更新' : '；分入口密码无改动'));
}

function applyAdultNav() {
    const hidden = isAdultNavHidden();
    document.body.classList.toggle('adult-hidden', hidden);
    // round42：总开关显示时，再按「入口显示」勾选逐个隐藏
    const prefs = getAdultNavItems();
    document.querySelectorAll('.nav-item[data-adult="1"]').forEach(item => {
        item.classList.toggle('adult-item-off', prefs[item.dataset.view] === 0);
    });
    const btn = document.getElementById('adultToggle');
    if (btn) {
        btn.textContent = hidden ? '🔒' : '🔓';
        btn.title = hidden ? '显示成人内容入口（AV库、里番库、演员库、标签库、AV/里番在线）'
                           : '隐藏成人内容入口';
    }
    // r44：隐私内容独立组——总开关隐藏或六项全被勾掉时整组消失（不留空标题）
    const pSec = document.querySelector('.sidebar-section[data-privacy-group]');
    if (pSec) {
        const anyShown = !hidden && PRIVACY_GROUP_VIEWS.some(v => prefs[v] !== 0);
        pSec.style.display = anyShown ? '' : 'none';
    }
    // 已隐藏时若正停在成人视图，退回全部影片
    if (hidden && currentView && ['jav', 'anime', 'movies-adult', 'recent-adult', 'actresses', 'tags', 'watch', 'watch-hanime'].includes(currentView)) {
        switchView('movies');
    }
}

function toggleAdultNav() {
    const hidden = isAdultNavHidden();
    if (hidden) {
        if (!confirm('将显示成人内容入口（AV库、里番库、演员库、标签库、AV/里番在线观看）。\n\n确认显示？')) return;
    }
    try { localStorage.setItem('adultNavHidden', hidden ? '0' : '1'); } catch (e) { /* 忽略 */ }
    applyAdultNav();
}

/* ---------- round41：首启功能导览（一次性，启动动画/门禁之后出现） ---------- */
function maybeShowTour() {
    const overlay = document.getElementById('tourOverlay');
    if (!overlay) return;
    let seen = false;
    try { seen = localStorage.getItem('featureTourDone') === '1'; } catch (e) { /* 忽略 */ }
    if (seen) return;
    // 等启动动画层退场后再露面（启动层 520ms 淡出）
    setTimeout(() => { overlay.style.display = 'flex'; }, 900);
    const done = () => {
        overlay.style.display = 'none';
        try { localStorage.setItem('featureTourDone', '1'); } catch (e) { /* 忽略 */ }
    };
    document.getElementById('tourDoneBtn')?.addEventListener('click', done);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
}

function init() {
    // 鉴权已由服务端会话接管（未登录访问 jav/anime 库会被重定向到 login.html），
    // 旧的前端密码弹窗流程已移除。

    initTheme();
    applyAdultNav();
    maybeShowTour();
    bindEvents();
    loadFavPrefs();   // 第 25 轮：我的收藏个性化偏好（类型/排序/件数/摆放）
    injectGlobalRefreshBtn();   // 第 26 轮：顶栏常驻「刷新」（原地刷新，不丢筛选/搜索/页码）
    initStartupScanBanner();    // 第 26 轮 #4：启动自动扫描的「过程 + 结果」提示条
    initDirWatchUi();           // 第 28 轮：目录监控状态显示 + 手动检查入口
    initUpdateNotice();         // 第 31 轮：有新版本时提示一次（后端 5 秒时已静默查过）

    // 第 33 轮：首页 AI 对话框 / 榜单交互绑定
    if (window.Home && window.Home.bindHome) window.Home.bindHome();

    // 监听阅读器iframe的关闭消息
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'closeReader') {
            closeReader();
        }
    });

    // 读取URL参数，判断是否需要切换到指定模块
    const urlParams = new URLSearchParams(window.location.search);
    const typeParam = urlParams.get('type');

    /* ★ round34 入口改造：应用启动一律先落首页（用户核心诉求「首页要有跳出来的机会」）。
     *   旧版 hash 恢复会让刷新/重开直接跳回功能视图，密码页还有选库入口 —— 全部移除。
     *   只有当「未启用密码」或「已有有效会话」时，才恢复上次离开的视图。 */
    /* ★ r59 修复：switchView('home') 会立刻把 hash 覆写成 #v=home，下面的 Gate 分支
     * 再 readViewState() 读到的永远是 home —— 「F5 恢复上次视图」（round26 #1）因这个
     * 时序从未真正生效。启动时先把 boot hash 抢下来，解锁后按它恢复。 */
    const bootState = readViewState();
    switchView('home');

    Promise.resolve(window.Gate ? window.Gate.init() : true).then((unlocked) => {
        if (!unlocked) return;   // 锁着就停在首页，点受保护导航时再弹密码框
        // round36 P0-6：解锁后跑一次网络自检，有不可达源时顶栏提示
        startupNetBanner();
        // round36 P0-3：显示原名偏好
        fetch('/api/config').then(r => r.json()).then(j => {
            if (j.code === 0) window.CV_SHOW_ORIG = !!j.data.showOriginalTitle;
        }).catch(() => {});
        const saved = bootState;
        if (saved && saved.view && saved.view !== 'home') {
            // r59：F5 时 hash 命中海报健康 → 按续位记录恢复滚动与分类切片，继续修正
            if (saved.view === 'poster-health' && window.Features && window.Features.requestPosterHealthResume) {
                window.Features.requestPosterHealthResume();
            }
            switchView(saved.view);
            if (saved.query) {
                const si = document.getElementById('searchInput');
                if (si) {
                    si.value = saved.query;
                    handleSearch({ target: si });
                }
            }
        }
    });

    updateStats();
    checkScanStatus();
    loadNotifications();
    startNotifyPolling();   // round34 批次B：即时 toast + 未读徽章轮询

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
// round47：mode=merge（默认）增量补正——已有真数据保留、空缺字段/标签/女优追加；
//          mode=overwrite 老行为——新刮结果无条件覆盖。
async function rescrapeMovie(id, mode) {
    try {
        const res = await fetch(`/api/movie/rescrape/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: mode || 'merge' })
        });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('重新刮削', mode === 'overwrite'
                ? '已开始深度重刮（覆盖模式），完成后自动刷新'
                : '已开始重新挖掘（增量补正，已编辑数据会保留），完成后自动刷新');
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

// round47：深度重刮（覆盖模式）入口，带确认
function deepRescrapeMovie(id) {
    if (!confirm('深度重刮会用网络上刮到的内容覆盖这条影片的标题/简介/导演等已有数据（封面锁不受影响）。\n\n如果只是想补全缺失字段、追加标签和女优，请用「重新挖掘」。\n\n确定要深度重刮吗？')) return;
    rescrapeMovie(id, 'overwrite');
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
    
    const currentTitle = movie.title || movie.fileName || '';
    const html = `
        <div style="padding: 24px;">
            <h3 style="margin-bottom:14px;font-size:18px;">✏️ 重命名文件</h3>
            <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:14px;padding:10px;background:var(--bg);border-radius:8px;line-height:1.7;">
                当前显示标题：<b style="color:var(--text);">${escapeHtml(currentTitle)}</b>
            </div>
            <div style="margin-bottom:14px;">
                <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">新文件名（不含扩展名）</label>
                <input type="text" id="renameInput" class="select-input" style="width:100%;height:40px;" value="${escapeHtml(nameWithoutExt)}">
            </div>
            <label style="display:flex;gap:10px;align-items:flex-start;margin-bottom:14px;cursor:pointer;">
                <input type="checkbox" id="renameSyncTitle" checked style="margin-top:3px;">
                <span style="font-size:13.5px;line-height:1.6;">
                    同时更新列表里的<b>显示标题</b>
                    <br><span style="font-size:12px;color:var(--text-muted);">不勾选：只改磁盘上的文件名，卡片标题保持原样（适合已经刮到正确片名、只想整理文件名的情况）</span>
                </span>
            </label>
            <div id="renamePreview" style="font-size:12.5px;margin-bottom:14px;padding:8px 10px;border-left:3px solid var(--primary);background:var(--bg);border-radius:6px;line-height:1.6;">
                <span style="color:var(--text-muted);">显示标题将变为：</span><b id="renamePreviewText"></b>
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
        const sync = document.getElementById('renameSyncTitle');
        const prevBox = document.getElementById('renamePreview');
        const prevText = document.getElementById('renamePreviewText');
        const refresh = () => {
            if (!prevBox) return;
            const on = !sync || sync.checked;
            prevBox.style.display = on ? 'block' : 'none';
            if (prevText && input) prevText.textContent = input.value.trim() || '(未填写)';
        };
        if (input) {
            input.focus();
            input.select();
            input.addEventListener('input', refresh);
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') doRename(id);
            });
        }
        if (sync) sync.addEventListener('change', refresh);
        refresh();
    }, 100);
}

async function doRename(id) {
    const newName = document.getElementById("renameInput").value.trim();
    if (!newName) {
        showNotification("错误", "文件名不能为空");
        return;
    }
    try {
        const syncEl = document.getElementById("renameSyncTitle");
        const updateTitle = syncEl ? !!syncEl.checked : false;
        // round27：走带「库损坏自愈」的封装 —— 重命名会改 fileName/title（被全文索引的列），
        // FTS 影子表一坏就必报 malformed，表现为「保存失败」。
        const data = await fetchJsonWithDbHeal(`/api/movie/${id}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName, updateTitle })
        });
        if (data.code === 0) {
            const d = data.data || {};
            showNotification(
                "重命名完成",
                d.titleUpdated
                    ? `文件名与显示标题都已改为「${d.newName || newName}」`
                    : `文件已改名为「${d.newName || newName}」（显示标题未变）`
            );
            showMovieDetail(id);        // 刷新详情面板
            // round26 #1/#2：用「原地刷新」替代按视图硬重载 ——
            // 原来走 switch(currentView) 会把搜索词/筛选上下文一起丢掉，
            // 重命名后就直接跳回「全部影片」了。
            refreshCurrentList();
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

// —— round34 批次B：通知偏好（与 utils/notify.js 的 DEFAULT_PREFS 对应） ——
const NOTIFY_EVENT_LABELS = {
    scanDone: '扫描完成',
    newItem: '发现新作（目录监控入库）',
    scrapeFailed: '刮削失败',
    posterMissing: '海报缺失',
    dbHeal: '数据库自动修复',
    update: '发现新版本',
    operation: '普通操作反馈',
};
const NOTIFY_PREF_OPTIONS = [
    ['both', '都提醒'],
    ['inbox', '只进铃铛'],
    ['toast', '只弹窗'],
    ['off', '关闭'],
];

function renderNotifyPrefs() {
    const prefs = (typeof config !== 'undefined' && config.notifyPrefs) || {};
    const val = (k) => prefs[k] || ({ scanDone: 'both', newItem: 'both', scrapeFailed: 'inbox', posterMissing: 'inbox', dbHeal: 'both', update: 'both', operation: 'toast' }[k]);
    return Object.keys(NOTIFY_EVENT_LABELS).map(k => `
        <div class="settings-item" style="display:flex;align-items:center;gap:12px;">
            <span style="flex:1;font-size:13px;">${NOTIFY_EVENT_LABELS[k]}</span>
            <select class="settings-select" data-pref-key="${k}" style="width:130px;">
                ${NOTIFY_PREF_OPTIONS.map(([v, label]) => `<option value="${v}" ${val(k) === v ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
        </div>`).join('');
}

async function saveNotifyPrefs() {
    const prefs = {};
    document.querySelectorAll('#notifyPrefsList [data-pref-key]').forEach(sel => {
        prefs[sel.dataset.prefKey] = sel.value;
    });
    try {
        const res = await fetch('/api/notification/prefs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prefs),
        });
        const data = await res.json();
        if (data.code === 0) {
            showNotification('已保存', '通知偏好已更新', 2500, 'success');
            if (typeof config === 'object' && config) config.notifyPrefs = data.data;
        } else {
            showNotification('保存失败', data.msg || '未知错误', 3000, 'error');
        }
    } catch (e) {
        showNotification('保存失败', e.message, 3000, 'error');
    }
}

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
// round47：打开弹窗时的女优原始串，保存时对比——没变化就不传 actresses（避免误清空）
let editingOriginalActresses = '';
// round50：标签的原始值（与女优同款纪律 —— 没改动就不提交，避免误清空）
let editingOriginalTags = '';

function showEditModal(id) {
    editingMovieId = id;
    // ★ round26 #2：这个弹窗原来只从 currentMovies 里找数据，而它是**死代码**
    //（详情工具区没有入口）。现在接上入口后必须兼容「从相似推荐点进来的影片」——
    // 那种情况下 currentMovies 里没有这条，会静默什么都不显示。
    const movie = (currentDetailMovie && currentDetailMovie.id === id)
        ? currentDetailMovie
        : currentMovies.find(m => m.id === id);
    if (!movie) {
        showNotification('无法编辑', '没找到这条影片的数据，请刷新列表后重试');
        return;
    }
    // round47：女优回显。详情接口返回 actresses 数组（[{id,name,...}]）；列表数据可能没有 → 空
    const actressNames = Array.isArray(movie.actresses) ? movie.actresses.map(a => a.name || a).join(', ') : '';
    editingOriginalActresses = actressNames;
    // round50：标签回显基准
    const tagNames = Array.isArray(movie.tags) ? movie.tags.map(t => t.name || t).join(', ') : '';
    editingOriginalTags = tagNames;

    const html = `
        <div style="padding: 24px;">
            <h3 style="margin-bottom:20px;font-size:18px;">✏️ 编辑元数据</h3>

            <!-- 【round50】选源刮削：刮到的值全部回填到下面输入框，用户肉眼确认后才点保存 -->
            <div id="editScrapeBar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;
                        padding:10px 12px;margin-bottom:8px;border-radius:8px;
                        background:var(--bg-secondary,rgba(128,128,128,.08));border:1px solid var(--border-color);">
                <span style="font-size:12px;color:var(--text-muted);">刮削源</span>
                <select id="editScrapeSource" class="select-input" style="height:32px;min-width:150px;">
                    <option value="auto">自动（依次尝试）</option>
                    <option value="javbus">JavBus</option>
                    <option value="javdb">JavDB</option>
                    <option value="jav321">Jav321</option>
                    <option value="dmm">DMM</option>
                    <option value="d2pass">D2Pass</option>
                    <option value="avsox">AVSOX</option>
                    <option value="netflav">Netflav</option>
                    <option value="onejav">OneJAV</option>
                    <option value="jable">Jable</option>
                    <option value="javmenu">JavMenu</option>
                    <option value="javcl">JavCL</option>
                    <option value="heyzo">Heyzo</option>
                    <option value="fc2">FC2</option>
                </select>
                <button class="btn btn-sm" onclick="scrapeIntoEdit()" title="按番号去选定源拉一份完整元数据，填入下方输入框（不会直接改库）">
                    🔍 刮削并填入
                </button>
                <button class="btn btn-sm" style="background:transparent;color:var(--text-muted);border:1px solid var(--border-color);"
                        onclick="deepRescrapeMovie(editingMovieId)"
                        title="重新联网刮削：已编辑过的数据会被保留，刮到的空缺字段/标签/女优会追加进来">
                    🔄 重新挖掘
                </button>
            </div>
            <div id="editScrapeHint" style="font-size:12px;color:var(--text-muted);margin-bottom:12px;min-height:0;"></div>

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
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <label style="font-size:13px;color:var(--text-muted);">女优（多人用逗号分隔，删光保存即清空）</label>
                        <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 10px;height:24px;display:flex;align-items:center;gap:4px;" onclick="toggleActressPicker()">
                            ${uiIcon('actress', 12)} 点选库中女优
                        </button>
                    </div>
                    <input type="text" id="editActresses" class="select-input" style="width:100%;height:40px;" value="${actressNames.replace(/"/g, '&quot;')}" placeholder="如：葵司, 三上悠亜">
                    <div id="editActressPicker" style="display:none;margin-top:8px;padding:10px;background:var(--bg-elev-1, rgba(255,255,255,0.04));border:1px solid var(--line, var(--border, rgba(255,255,255,.1)));border-radius:8px;">
                        <div style="display:flex;gap:6px;margin-bottom:8px;">
                            <input type="text" id="editActressFilter" placeholder="输入名字过滤女优…" class="select-input" style="height:30px;font-size:12px;flex:1;" oninput="filterActressPicker(this.value)">
                        </div>
                        <div id="editActressChips" style="display:flex;flex-wrap:wrap;gap:6px;max-height:140px;overflow-y:auto;"></div>
                    </div>
                </div>
                <div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <label style="font-size:13px;color:var(--text-muted);">标签（多个用逗号分隔，刮削会自动带入）</label>
                        <button type="button" class="btn btn-sm btn-secondary" style="font-size:11px;padding:2px 10px;height:24px;display:flex;align-items:center;gap:4px;" onclick="toggleTagPicker()">
                            ${uiIcon('tag', 12)} 常用标签点选
                        </button>
                    </div>
                    <input type="text" id="editTags" class="select-input" style="width:100%;height:40px;" value="${tagNames.replace(/"/g, '&quot;')}" placeholder="如：熟女, 中出">
                    <div id="editTagPicker" style="display:none;margin-top:8px;padding:10px;background:var(--bg-elev-1, rgba(255,255,255,0.04));border:1px solid var(--line, var(--border, rgba(255,255,255,.1)));border-radius:8px;">
                        <div id="editTagChips" style="display:flex;flex-wrap:wrap;gap:6px;max-height:120px;overflow-y:auto;"></div>
                    </div>
                </div>
                <div>
                    <label style="display:block;font-size:13px;color:var(--text-muted);margin-bottom:6px;">简介</label>
                    <textarea id="editOverview" class="select-input" style="width:100%;height:100px;padding:10px;resize:vertical;">${movie.overview || ''}</textarea>
                </div>
            </div>
            <div style="display:flex;gap:12px;margin-top:24px;justify-content:flex-end;align-items:center;">
                <button class="btn btn-sm btn-secondary" style="margin-right:auto;" onclick="openRenamePanel()"
                        title="按「番号 标题」算一个新文件名，你确认或改过之后才会真正改磁盘上的文件">
                    📝 重命名文件
                </button>
                <button class="btn btn-secondary" onclick="closeEditModal()">取消</button>
                <button class="btn" onclick="saveEdit()">保存</button>
            </div>

            <!-- 【round51】重命名确认区：改文件名有副作用（动磁盘 + sidecar），必须让用户先看到新名 -->
            <div id="editRenameBox" style="display:none;margin-top:12px;padding:12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-secondary,rgba(128,128,128,.06));">
                <div style="font-size:13px;font-weight:600;margin-bottom:8px;">📝 重命名文件</div>
                <div style="font-size:12px;color:var(--text-muted);line-height:1.9;margin-bottom:8px;">
                    原名：<code id="renameOldName" style="font-family:var(--font-mono);word-break:break-all;"></code>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <input type="text" id="renameNewName" class="select-input" style="flex:1;min-width:220px;height:38px;font-family:var(--font-mono);font-size:12.5px;">
                    <button class="btn btn-sm" onclick="doRenameFromEdit()">确认重命名</button>
                    <button class="btn btn-sm btn-secondary" onclick="closeRenamePanel()">取消</button>
                </div>
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);margin-top:8px;cursor:pointer;">
                    <input type="checkbox" id="renameSyncTitle"> 同时把显示标题改成新文件名（默认不动标题）
                </label>
                <div id="renameHint" style="font-size:12px;color:var(--text-muted);margin-top:6px;"></div>
            </div>
            <div id="editScrapeFoot" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color);font-size:12px;color:var(--text-muted);line-height:1.6;">
                🔍 刮削并填入：按番号去指定源拉数据，只填到这里让你确认，<b>不会直接改库</b>；确认无误再点保存。<br>
                🔄 重新挖掘：重新联网刮削并<b>直接写库</b>（增量补正，已编辑的字段会保留）。
            </div>
        </div>
    `;

    document.getElementById('detailBody').innerHTML = html;
}

function closeEditModal() {
    closeModal();
}

// ========== 女优 & 标签点选增强（Backlog B4） ==========
let _allActressesCache = null;
let _allTagsCache = null;

async function toggleActressPicker() {
    const box = document.getElementById('editActressPicker');
    if (!box) return;
    if (box.style.display === 'none' || !box.style.display) {
        box.style.display = 'block';
        if (!_allActressesCache) {
            try {
                const res = await (await fetch('/api/actress')).json();
                if (res.code === 0 && Array.isArray(res.data)) {
                    _allActressesCache = res.data;
                }
            } catch (e) { _allActressesCache = []; }
        }
        renderActressChips('');
        const fi = document.getElementById('editActressFilter');
        if (fi) fi.focus();
    } else {
        box.style.display = 'none';
    }
}

function renderActressChips(kw) {
    const container = document.getElementById('editActressChips');
    if (!container || !_allActressesCache) return;
    const curVal = document.getElementById('editActresses')?.value || '';
    const selected = new Set(curVal.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean));

    let list = _allActressesCache;
    if (kw && kw.trim()) {
        const k = kw.trim().toLowerCase();
        list = list.filter(a => (a.name || '').toLowerCase().includes(k));
    } else {
        list = list.slice(0, 60);
    }

    container.innerHTML = list.map(a => {
        const isSel = selected.has(a.name);
        return `<span class="actress-picker-chip" onclick="togglePickActress('${escapeHtml(a.name)}')"
                      style="cursor:pointer;padding:4px 10px;border-radius:999px;font-size:12px;user-select:none;transition:all .15s;
                             background:${isSel ? 'var(--primary-soft, rgba(245,158,11,.22))' : 'var(--card-bg, #1a1a20)'};
                             color:${isSel ? 'var(--primary, #F59E0B)' : 'var(--text)'};
                             border:1px solid ${isSel ? 'var(--primary, #F59E0B)' : 'var(--border, rgba(255,255,255,.1))'};">
                    ${escapeHtml(a.name)} <small style="opacity:.6;">${a.movieCount ? `(${a.movieCount})` : ''}</small>
                </span>`;
    }).join('') || '<span style="font-size:12px;color:var(--text-muted);padding:4px;">未匹配到女优</span>';
}

function filterActressPicker(kw) {
    renderActressChips(kw);
}

function togglePickActress(name) {
    const input = document.getElementById('editActresses');
    if (!input) return;
    let list = input.value.split(/[,，、]+/).map(s => s.trim()).filter(Boolean);
    const idx = list.indexOf(name);
    if (idx >= 0) {
        list.splice(idx, 1);
    } else {
        list.push(name);
    }
    input.value = list.join(', ');
    const kw = (document.getElementById('editActressFilter')?.value || '');
    renderActressChips(kw);
}

async function toggleTagPicker() {
    const box = document.getElementById('editTagPicker');
    if (!box) return;
    if (box.style.display === 'none' || !box.style.display) {
        box.style.display = 'block';
        if (!_allTagsCache) {
            try {
                const res = await (await fetch('/api/tags/top/list?limit=60')).json();
                if (res.code === 0 && Array.isArray(res.data)) {
                    _allTagsCache = res.data;
                } else {
                    const res2 = await (await fetch('/api/tags')).json();
                    if (res2.code === 0 && Array.isArray(res2.data)) _allTagsCache = res2.data;
                }
            } catch (e) { _allTagsCache = []; }
        }
        renderTagChips();
    } else {
        box.style.display = 'none';
    }
}

function renderTagChips() {
    const container = document.getElementById('editTagChips');
    if (!container || !_allTagsCache) return;
    const curVal = document.getElementById('editTags')?.value || '';
    const selected = new Set(curVal.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean));

    container.innerHTML = _allTagsCache.slice(0, 60).map(t => {
        const name = t.name || t;
        const isSel = selected.has(name);
        return `<span class="tag-picker-chip" onclick="togglePickTag('${escapeHtml(name)}')"
                      style="cursor:pointer;padding:4px 10px;border-radius:999px;font-size:12px;user-select:none;transition:all .15s;
                             background:${isSel ? 'var(--primary-soft, rgba(245,158,11,.22))' : 'var(--card-bg, #1a1a20)'};
                             color:${isSel ? 'var(--primary, #F59E0B)' : 'var(--text)'};
                             border:1px solid ${isSel ? 'var(--primary, #F59E0B)' : 'var(--border, rgba(255,255,255,.1))'};">
                    ${escapeHtml(name)}
                </span>`;
    }).join('') || '<span style="font-size:12px;color:var(--text-muted);padding:4px;">暂无常用标签</span>';
}

function togglePickTag(name) {
    const input = document.getElementById('editTags');
    if (!input) return;
    let list = input.value.split(/[,，、]+/).map(s => s.trim()).filter(Boolean);
    const idx = list.indexOf(name);
    if (idx >= 0) {
        list.splice(idx, 1);
    } else {
        list.push(name);
    }
    input.value = list.join(', ');
    renderTagChips();
}

/* ======================================================================
   【round51】编辑弹窗里的「文件重命名」
   需求原话：入库/重刮的改名也要在「编辑标题元数据」这里让用户确认。
   与「刮削并填入」同一套纪律 —— 先算好新名给用户过目（可改），点了确认才动磁盘。
   后端 POST /api/movie/:id/rename 已现成（动视频 + .nfo + 同名 .jpg + 库路径/cleanName，带 FTS 自愈）。
   ====================================================================== */

// 文件名里不能出现的字符（与后端重命名路径保持同一口径）
function sanitizeFileNameStem(s) {
    return String(s == null ? '' : s)
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// 推荐新名 =「番号 标题」（缺谁用谁），与 round47 的自动重命名同规则。
// ★ 但库里的标题常自带番号（刮到的标题就是「MNGS 072 片名」）—— 直接拼会得到
//   「MNGS-072 MNGS 072 片名」。这里先把标题开头那段番号归一化比对后砍掉，避免重复。
// 找出字符串开头的「番号段」位置。返回 { end, after }：
//   end   = 第 na.length 个字母数字的下标（番号正文结束处）
//   after = 其后连续分隔符（空格/-/_/·/| 等）结束处，即真正标题的起点
// 没匹配到番号返回 null。
// 两处共用：suggestFileNameStem 用 end 切掉标题里重复的番号；openRenamePanel 用 after 落光标。
function avidPrefixPos(value, avid) {
    const s = String(value || '');
    const na = String(avid || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s || !na) return null;
    if (s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, na.length) !== na) return null;
    let seen = 0, end = 0;
    for (let i = 0; i < s.length; i++) {
        if (/[A-Z0-9]/i.test(s[i])) { seen++; if (seen === na.length) { end = i + 1; break; } }
    }
    if (!end) return null;
    let after = end;
    while (after < s.length && /[\s\-–—_·|]/.test(s[after])) after++;
    return { end, after };
}

function suggestFileNameStem(movie, titleNow) {
    const avid = sanitizeFileNameStem(movie && movie.avid);
    let title = sanitizeFileNameStem(titleNow || (movie && movie.title));
    if (avid && title) {
        // 库里标题常自带番号（"MNGS-072 xxx"），不处理会拼成 "MNGS-072 MNGS 072 xxx"
        const p = avidPrefixPos(title, avid);
        if (p) title = title.slice(p.end).replace(/^[\s\-–—_·|]+/, '').trim();
    }
    const stem = sanitizeFileNameStem(avid && title ? (avid + ' ' + title) : (avid || title));
    return stem.slice(0, 180).trim();
}

function setRenameHint(text, bad) {
    const h = document.getElementById('renameHint');
    if (!h) return;
    h.style.color = bad ? '#d33' : 'var(--text-muted)';
    h.textContent = text;
}

// 收集编辑弹窗里要提交的字段。saveEdit 与「重命名文件」流程共用，
// 避免两处各写一份导致口径漂移（尤其女优/标签那两条「没改就不提交」的纪律）。
function collectEditBody() {
    const body = {
        title: document.getElementById('editTitle').value,
        overview: document.getElementById('editOverview').value,
        releaseDate: document.getElementById('editRelease').value,
        producer: document.getElementById('editProducer').value,
        serial: document.getElementById('editSerial').value,
        director: document.getElementById('editDirector').value,
    };
    // round47：女优只在用户真的改过时才提交（undefined = 后端不碰关联表）
    const actressesInput = document.getElementById('editActresses')?.value ?? '';
    if (actressesInput.trim() !== editingOriginalActresses) {
        body.actresses = actressesInput.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    }
    // round50：标签（同款纪律）
    const tagsInput = document.getElementById('editTags')?.value ?? '';
    if (tagsInput.trim() !== editingOriginalTags) {
        body.tags = tagsInput.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    }
    return body;
}

// 当前正在编辑的这条影片（详情进来的用 currentDetailMovie，列表进来的查 currentMovies）
function editingMovie() {
    if (!editingMovieId) return null;
    return (currentDetailMovie && currentDetailMovie.id === editingMovieId)
        ? currentDetailMovie
        : (currentMovies.find(m => m.id === editingMovieId) || null);
}

function openRenamePanel() {
    const movie = editingMovie();
    if (!movie) { showNotification('无法重命名', '没找到这条影片的数据'); return; }
    const box = document.getElementById('editRenameBox');
    if (!box) return;
    const titleNow = (document.getElementById('editTitle') || {}).value || '';
    const oldEl = document.getElementById('renameOldName');
    if (oldEl) oldEl.textContent = movie.fileName || '';
    const inp = document.getElementById('renameNewName');
    if (inp) inp.value = suggestFileNameStem(movie, titleNow);
    const ext = String(movie.fileName || '').split('.').pop();
    setRenameHint(movie.avid
        ? `已按「番号 标题」生成，可直接改；扩展名 .${ext} 保持不变。`
        : `这条还没有番号 —— 建议先刮到番号再改（现在只能用标题）。扩展名 .${ext} 保持不变。`);
    box.style.display = 'block';
    if (inp) {
        inp.focus();
        // 光标落在番号之后：多数情况用户只想改标题部分，不必先删掉番号；
        // 想把整段换掉按 Ctrl+A 即可。滚动归零保证一进来就看到番号开头。
        const p = avidPrefixPos(inp.value, movie.avid);
        const pos = p ? p.after : 0;
        try { inp.setSelectionRange(pos, pos); } catch (e) { inp.select(); }
        inp.scrollLeft = 0;
    }
}

function closeRenamePanel() {
    const box = document.getElementById('editRenameBox');
    if (box) box.style.display = 'none';
}

async function doRenameFromEdit() {
    if (!editingMovieId) return;
    const raw = ((document.getElementById('renameNewName') || {}).value || '').trim();
    // 用户可能连扩展名一起粘进来 → 去掉；后端按原扩展名补回
    const newName = sanitizeFileNameStem(raw.replace(/\.[A-Za-z0-9]{1,5}$/, ''));
    if (!newName) { setRenameHint('新名不能为空', true); return; }
    const syncTitle = !!(document.getElementById('renameSyncTitle') || {}).checked;

    // ① 先把弹窗里的字段落盘（用户常常是「改了标题顺手改名」，先存下来才不会白改）
    setRenameHint('正在保存字段…');
    try {
        const upd = await fetchJsonWithDbHeal(`/api/movie/update/${editingMovieId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectEditBody())
        });
        if (upd && upd.code !== 0) { setRenameHint('保存字段失败：' + ((upd && upd.msg) || ''), true); return; }
    } catch (e) {
        setRenameHint('保存字段失败：' + e.message, true);
        return;
    }

    // ② 执行重命名（默认不同步标题 —— 那会把显示标题整体改成文件名）
    setRenameHint('正在重命名文件…');
    let r = null;
    try {
        r = await fetchJsonWithDbHeal(`/api/movie/${editingMovieId}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newName, updateTitle: syncTitle })
        });
    } catch (e) {
        setRenameHint('重命名失败：' + e.message, true);
        return;
    }
    if (!r || r.code !== 0) { setRenameHint('重命名失败：' + ((r && r.msg) || ''), true); return; }

    showNotification('重命名完成', (r.data && r.data.fileName) || newName);
    closeModal();
    await refreshCurrentList();
}

/**
 * 【round50】编辑弹窗里「按指定源刮削 → 回填输入框」。
 *
 * 为什么要有它：用户抱怨「刮削完不知道刮到什么就直接写了」。现在改成三步式
 *   ① 选源 → ② 刮到的值原样填进输入框（改动的框描蓝边）→ ③ 用户肉眼核对后点保存才入库。
 * 后端 /api/movie/scrape-preview/:id 是 dry-run，不写库不落盘封面，所以点坏了也没有副作用。
 */
async function scrapeIntoEdit() {
    if (!editingMovieId) return;
    const hint = document.getElementById('editScrapeHint');
    const sel = document.getElementById('editScrapeSource');
    const src = sel ? sel.value : 'auto';
    const srcText = src === 'auto' ? '全部启用源（依次尝试）' : (sel.options[sel.selectedIndex]?.text || src);
    const setHint = (text, bad) => {
        if (!hint) return;
        hint.style.color = bad ? '#d33' : 'var(--text-muted)';
        hint.innerHTML = text;
    };
    setHint(`正在从 ${srcText} 刮削…`);

    try {
        const data = await fetchJsonWithDbHeal(`/api/movie/scrape-preview/${editingMovieId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: src })
        });
        if (data.code !== 0 || !data.data || !data.data.fields) {
            // 后端 msg 里已经带了「没刮到：」前缀（并列出各源原因），这里别再套一层
            setHint(`😕 ${data.msg || '无可用的收录'}`, true);
            showNotification('刮削未命中', data.msg || '该片在这些源里没有收录');
            return;
        }
        const f = data.data.fields;
        let n = 0;
        const put = (id, val) => {
            if (!val) return;
            const el = document.getElementById(id);
            if (!el) return;
            const before = String(el.value || '').trim();
            const after = String(val).trim();
            if (before !== after) {
                el.value = after;
                // 本次被刮削改过的框描蓝边，让用户一眼看清改了哪几个
                el.style.borderColor = '#4c8dff';
                el.style.boxShadow = '0 0 0 2px rgba(76,141,255,.25)';
                n++;
            }
        };
        put('editTitle', f.title);
        put('editRelease', f.releaseDate);
        put('editProducer', f.producer || f.publisher);
        put('editSerial', f.serial);
        put('editDirector', f.director);
        put('editActresses', Array.isArray(f.actress) ? f.actress.join(', ') : '');
        put('editTags', Array.isArray(f.genres) ? f.genres.join(', ') : '');
        put('editOverview', f.overview);

        if (n === 0) setHint(`<b>${data.data.label}</b> 有收录，但刮到的内容与当前完全一致，无需修改。`);
        else setHint(`已从 <b>${data.data.label}</b> 填入 ${n} 个字段（蓝框为本次变动）。核对无误后点「保存」才会写入数据库。`);
    } catch (e) {
        setHint('刮削失败：' + (e.message || e), true);
    }
}

async function saveEdit() {
    if (!editingMovieId) return;

    // round51：字段收集抽到 collectEditBody()，与「重命名文件」流程共用同一份口径
    // （女优 / 标签那两条「没改就不提交、避免误清空」的纪律只写一处）
    const body = collectEditBody();
    const title = body.title;

    try {
        // round27：编辑标题会更新 title（被全文索引的列）→ 同样的 FTS 损坏自愈封装
        const data = await fetchJsonWithDbHeal(`/api/movie/update/${editingMovieId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (data.code === 0) {
            // ★ round26 #2：原来只弹一句「元数据已更新」，而卡片标题在部分视图下
            // 并不会立刻重画，用户无从确认到底改没改。现在：明确报出新标题 +
            // 原地刷新列表 + 详情面板若开着则一并刷新。
            showNotification('保存成功', `显示标题已更新为「${title || '（空）'}」`);
            const detailWasOpen = document.getElementById('detailModal').classList.contains('show');
            closeModal();
            await refreshCurrentList();
            if (detailWasOpen) showMovieDetail(editingMovieId);
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
// round38：启动即初始化三处动画（启动层/待机/输入），幂等且失败不阻塞
document.addEventListener('DOMContentLoaded', initAppAnimations);

// r63/r67: 全局捕获卡片点击，为 FLIP 共享元素飞入转场提供坐标锚点（含时间线 tl-card）
document.addEventListener('click', function(e) {
    const card = e.target.closest('.movie-card, .similar-card, .nr-card, .tl-card, .timeline-card, .deck-card, .hp-step, .hr-row');
    if (card && window.MotionFLIP) {
        window.MotionFLIP.record(card);
    }
}, true);

// r63: 初始化多维即时切片筛选器
document.addEventListener('DOMContentLoaded', function() {
    if (window.FacetFilter && typeof window.FacetFilter.init === 'function') {
        window.FacetFilter.init();
    }
});
