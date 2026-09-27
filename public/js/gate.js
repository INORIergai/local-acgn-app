/**
 * round34 · 访问门禁（Gate）
 * ============================================================
 * 「应用开启后先落首页，点受保护导航时再要密码」：
 *   - Gate.init()      探测 /api/auth/status，返回 Promise<boolean>（是否已解锁）
 *   - Gate.guard(view) 切视图前调用；受保护视图未解锁时弹密码框，返回 Promise<boolean>
 *   - Gate.onUnauthorized()  任何 API 返回 401 时由统一 fetch 包装调起（会话过期）
 *   - Gate.isUnlocked()
 *
 * 受保护视图 = AV / 里番 / 漫画 / 小说及其在线观看、聚合视图（会带出成人内容）
 *              与设置页（含密码/密钥）；影视库 / 动漫库 / 首页 / ACG榜单免密。
 */
window.Gate = (function () {
    let authEnabled = false;
    let unlocked = false;
    let ready = false;          // init() 是否已完成（状态探明）
    let modalReady = false;
    let pendingResolve = null;  // 密码框正在等人解锁：resolve(视图是否放行)

    // 免密视图：home / acg-rank / film / cartoon（及它们的衍生视图）
    const FREE_VIEWS = ['home', 'acg-rank', 'film', 'cartoon'];
    // 其余全部受保护（movies/hot/guess 等聚合视图会带出 AV 内容，一并保护）
    function isProtected(view) {
        if (FREE_VIEWS.includes(view)) return false;
        return true;
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
                    <h2 class="r34-gate-title">午夜场</h2>
                    <div class="r34-gate-sub">CINEMA VAULT · ADMIT ONE</div>
                    <label class="r34-gate-label" for="gatePwd">Access Password · 访问口令</label>
                    <input type="password" id="gatePwd" placeholder="••••••" autocomplete="current-password">
                    <div class="r34-gate-err" id="gateErr"></div>
                    <button class="r34-gate-btn" id="gateBtn">检票入场</button>
                    <div class="r34-gate-hint">该区域包含成人内容，验证后可访问全部影库</div>
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
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                const data = await res.json();
                if (data.code === 0) {
                    unlocked = true;
                    hide();
                    err.textContent = '';
                    input.value = '';
                    btn.textContent = '检票入场';
                    btn.disabled = false;
                    if (pendingResolve) { pendingResolve(true); pendingResolve = null; }
                    // 解锁后把侧栏计数补齐（之前 401 静默失败的那批）
                    if (window.fillLibraryCounts) window.fillLibraryCounts();
                    return;
                }
                err.textContent = data.msg || '口令错误，请重试';
            } catch (e) {
                err.textContent = '网络异常：' + e.message;
            }
            btn.disabled = false;
            btn.textContent = '检票入场';
            input.value = '';
            input.focus();
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
        const wrap = document.getElementById('gateModal');
        wrap.classList.add('show');
        const input = wrap.querySelector('#gatePwd');
        setTimeout(() => input && input.focus(), 80);
    }

    function hide() {
        const wrap = document.getElementById('gateModal');
        if (wrap) wrap.classList.remove('show');
    }

    /** 探测鉴权状态；resolve(true) = 已解锁（含未启用密码的情况） */
    function init() {
        return fetch('/api/auth/status').then(r => r.json()).then(d => {
            authEnabled = !!(d && d.data && d.data.authEnabled);
            unlocked = !authEnabled || !!(d && d.data && d.data.loggedIn);
            ready = true;
            return unlocked;
        }).catch(() => {
            // 探不到状态：按未启用密码处理（服务不可达时弹密码框也没意义）
            authEnabled = false;
            unlocked = true;
            ready = true;
            return true;
        });
    }

    /** 切视图前调用。返回 Promise<boolean>：true = 放行 */
    function guard(view) {
        if (!ready) {
            // init 未完成（极端时序）：探一把再判
            return init().then(() => guard(view));
        }
        if (unlocked || !isProtected(view)) return Promise.resolve(true);
        if (pendingResolve) return Promise.resolve(false);   // 已在问密码，不重复弹
        show();
        return new Promise((resolve) => { pendingResolve = resolve; });
    }

    /** 会话过期 / 401 时由 fetch 包装调起 */
    function onUnauthorized() {
        if (!authEnabled) return;
        if (unlocked) unlocked = false;   // 会话已失效，重新进入锁定态
        if (!document.getElementById('gateModal') || !document.getElementById('gateModal').classList.contains('show')) {
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
