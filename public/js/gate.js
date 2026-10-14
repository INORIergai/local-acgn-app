/**
 * round34 · 访问门禁（Gate）；round39 扩展「分入口密码」
 * ============================================================
 * 两层锁：
 *   1. 主密码（config.auth）—— 进应用：Gate.init() 探测 /api/auth/status，
 *      未解锁切受保护视图时弹「午夜场」检票框
 *   2. 分入口密码（config.auth.sections）—— 进单个库：即使主密码已登录，
 *      打开上锁的入口还要再验一道独立密码（借电脑场景）
 *
 *   - Gate.init()      探测状态，返回 Promise<boolean>（主密码是否已解锁）
 *   - Gate.guard(view) 切视图前调用；先过主密码、再过分入口，返回 Promise<boolean>
 *   - Gate.onUnauthorized()  任何 API 返回 401 时由统一 fetch 包装调起（会话过期）
 *
 * 受保护视图 = AV / 里番 / 漫画 / 小说及其在线观看、聚合视图（会带出成人内容）
 *              与设置页（含密码/密钥）；影视库 / 动漫库 / 首页 / ACG榜单免密
 *              —— 但均可被「分入口密码」单独上锁。
 */
window.Gate = (function () {
    let authEnabled = false;
    let unlocked = false;
    let ready = false;          // init() 是否已完成（状态探明）
    let modalReady = false;
    let pendingResolve = null;  // 密码框正在等人解锁：resolve(视图是否放行)

    /* ---- round39：分入口状态 ---- */
    let sections = {};           // view -> bool（是否单独上锁，来自 /api/auth/sections）
    let secUnlocked = new Set(); // 本会话已解锁的分入口（sessionStorage 记忆，关标签页即失效）
    let mode = 'master';         // 当前密码框模式：'master' | 'section'
    let sectionView = null;

    const SECTION_NAMES = {
        movies: '全部影片', jav: 'AV 库', anime: '里番库', comic: '漫画库',
        novel: '小说库', film: '影视库', cartoon: '动漫库',
        actresses: '演员库', tags: '标签库'
    };

    // 主密码免密视图：home / acg-rank / film / cartoon（及它们的衍生视图）
    const FREE_VIEWS = ['home', 'acg-rank', 'film', 'cartoon'];
    // 其余全部受保护（movies/hot/guess 等聚合视图会带出 AV 内容，一并保护）
    function isProtected(view) {
        if (FREE_VIEWS.includes(view)) return false;
        return true;
    }

    // 分入口是否上锁且本会话未解锁（任何视图都可被单独上锁，包括 film/cartoon）
    function isSectionLocked(view) {
        return !!(sections && sections[view]) && !secUnlocked.has(view);
    }

    function loadSecUnlocked() {
        try {
            const raw = sessionStorage.getItem('gateSecUnlocked');
            if (raw) secUnlocked = new Set(JSON.parse(raw));
        } catch (e) { /* 忽略 */ }
    }
    function saveSecUnlocked() {
        try { sessionStorage.setItem('gateSecUnlocked', JSON.stringify([...secUnlocked])); } catch (e) { /* 忽略 */ }
    }

    function ensureModal() {
        if (modalReady) return;
        modalReady = true;
        const wrap = document.createElement('div');
        wrap.id = 'gateModal';
        wrap.className = 'r34-gate';
        wrap.innerHTML = `
            <div class="r34-gate-card">
                <div class="r34-gate-teeth"></div>
                <div class="r34-gate-body">
                    <div class="r34-gate-bulbs"><i></i><i></i><i></i></div>
                    <h2 class="r34-gate-title" id="gateTitle">午夜场</h2>
                    <div class="r34-gate-sub" id="gateSub">CINEMA VAULT · ADMIT ONE</div>
                    <label class="r34-gate-label" for="gatePwd" id="gateLabel">Access Password · 访问口令</label>
                    <input type="password" id="gatePwd" placeholder="••••••" autocomplete="current-password">
                    <div class="r34-gate-err" id="gateErr"></div>
                    <button class="r34-gate-btn" id="gateBtn">检票入场</button>
                    <div class="r34-gate-hint" id="gateHint">该区域包含成人内容，验证后可访问全部影库</div>
                </div>
            </div>
        `;
        document.body.appendChild(wrap);

        const input = wrap.querySelector('#gatePwd');
        const err = wrap.querySelector('#gateErr');
        const btn = wrap.querySelector('#gateBtn');

        async function submit() {
            const password = input.value;
            if (!password) { err.textContent = '请输入口令'; return; }
            btn.disabled = true;
            btn.textContent = '检票中…';
            try {
                if (mode === 'section') {
                    const res = await fetch('/api/auth/section/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ view: sectionView, password })
                    });
                    const data = await res.json();
                    if (data.code === 0) {
                        secUnlocked.add(sectionView);
                        saveSecUnlocked();
                        hide();
                        resetInput();
                        if (pendingResolve) { pendingResolve(true); pendingResolve = null; }
                        return;
                    }
                    err.textContent = data.msg || '口令错误，请重试';
                } else {
                    const res = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password })
                    });
                    const data = await res.json();
                    if (data.code === 0) {
                        unlocked = true;
                        hide();
                        resetInput();
                        if (pendingResolve) { pendingResolve(true); pendingResolve = null; }
                        // 解锁后把侧栏计数补齐（之前 401 静默失败的那批）
                        if (window.fillLibraryCounts) window.fillLibraryCounts();
                        return;
                    }
                    err.textContent = data.msg || '口令错误，请重试';
                }
            } catch (e) {
                err.textContent = '网络异常：' + e.message;
            }
            resetInput(true);
        }

        function resetInput(refocus) {
            btn.disabled = false;
            btn.textContent = '检票入场';
            input.value = '';
            if (refocus) input.focus();
        }

        btn.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        wrap.addEventListener('click', (e) => {
            if (e.target === wrap) { hide(); if (pendingResolve) { pendingResolve(false); pendingResolve = null; } }
        });
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && wrap.classList.contains('show')) {
                hide();
                if (pendingResolve) { pendingResolve(false); pendingResolve = null; }
            }
        });
    }

    function show() {
        ensureModal();
        setModeText();
        const wrap = document.getElementById('gateModal');
        wrap.classList.add('show');
        const input = wrap.querySelector('#gatePwd');
        setTimeout(() => input && input.focus(), 80);
    }

    // setModeText 由 show() 调用；这里挂一个内部引用避免未定义
    function setModeText() {
        const wrap = document.getElementById('gateModal');
        if (!wrap) return;
        const title = wrap.querySelector('#gateTitle');
        const sub = wrap.querySelector('#gateSub');
        const hint = wrap.querySelector('#gateHint');
        if (!title) return;
        if (mode === 'section') {
            const name = SECTION_NAMES[sectionView] || sectionView;
            title.textContent = '上锁区域';
            sub.textContent = name + ' · LOCKED';
            hint.textContent = '该入口设置了独立密码，与主密码相互独立';
        } else {
            title.textContent = '午夜场';
            sub.textContent = 'CINEMA VAULT · ADMIT ONE';
            hint.textContent = '该区域包含成人内容，验证后可访问全部影库';
        }
    }

    function hide() {
        const wrap = document.getElementById('gateModal');
        if (wrap) wrap.classList.remove('show');
    }

    /** 探测鉴权状态；resolve(true) = 主密码已解锁（含未启用密码的情况） */
    function init() {
        loadSecUnlocked();
        const probe = fetch('/api/auth/status').then(r => r.json()).then(d => {
            authEnabled = !!(d && d.data && d.data.authEnabled);
            unlocked = !authEnabled || !!(d && d.data && d.data.loggedIn);
        }).catch(() => {
            // 探不到状态：按未启用密码处理（服务不可达时弹密码框也没意义）
            authEnabled = false;
            unlocked = true;
        });
        const probeSections = fetch('/api/auth/sections').then(r => r.json()).then(d => {
            if (d && d.code === 0 && d.data) sections = d.data.sections || {};
        }).catch(() => { sections = {}; });
        return Promise.all([probe, probeSections]).then(() => {
            ready = true;
            return unlocked;
        });
    }

    /** 切视图前调用。返回 Promise<boolean>：true = 放行 */
    function guard(view) {
        if (!ready) {
            // init 未完成（极端时序）：探一把再判
            return init().then(() => guard(view));
        }
        if (pendingResolve) return Promise.resolve(false);   // 已在问密码，不重复弹
        // 第 1 道：主密码（沿用 round34 范围）
        if (authEnabled && !unlocked && isProtected(view)) {
            mode = 'master';
            show();
            return new Promise((resolve) => { pendingResolve = resolve; });
        }
        // 第 2 道：分入口密码（round39）
        if (isSectionLocked(view)) {
            mode = 'section';
            sectionView = view;
            show();
            return new Promise((resolve) => { pendingResolve = resolve; });
        }
        return Promise.resolve(true);
    }

    /** 会话过期 / 401 时由 fetch 包装调起（只管主密码层） */
    function onUnauthorized() {
        if (!authEnabled) return;
        if (unlocked) unlocked = false;   // 会话已失效，重新进入锁定态
        if (!document.getElementById('gateModal') || !document.getElementById('gateModal').classList.contains('show')) {
            mode = 'master';
            show();
        }
    }

    return {
        init,
        guard,
        onUnauthorized,
        isUnlocked: () => unlocked,
        isProtected,
        ready: () => ready,
    };
})();
