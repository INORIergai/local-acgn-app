/* ================================================================
 * companion.js —— CVCompanion 全局单例（v4.0 Phase 2：Live2D 陪伴角色）
 * ----------------------------------------------------------------
 * 对齐 Alife 技术栈（docs/整理记录/r62 蓝图）：pixi 6.5.10 + live2dcubismcore
 * + pixi-live2d-display，四态状态机 IDLE / WATCHING / THINKING / TALKING。
 * 定位：页面右下角独立浮层角色（与首页看板娘并存，不替换、不接管），
 * 全视图常驻，z-index 低于所有模态弹窗。
 *
 * 设计纪律：
 *  - 懒加载：启用且进应用才注入 Live2D 三件套（不拖累首屏）
 *  - 任何失败静默隐藏浮层，绝不影响主界面
 *  - 模型双源：public/live2d/models（内置，dafeng_2 默认）+ 设置页自定义
 *    模型目录（config.ai.companion.modelsDir，经 /companion/external 防穿越服务）
 *  - 实测四坑见 memory：originalHeight 是逻辑高、canvas.width 禁外改、
 *    首个 Cubism 模型渲染空白需可见路径预热、readPixels 需 preserveDrawingBuffer
 * ================================================================ */
(function () {
    'use strict';

    /* Alife 实测可用的加载顺序：pixi → live2d(C2运行时) → cubismcore → display */
    const LIBS = [
        '/live2d/lib/pixi.min.js',
        '/live2d/lib/live2d.min.js',
        '/live2d/lib/live2dcubismcore.min.js',
        '/live2d/lib/pixi-live2d-display.min.js'
    ];

    const POKE_LINES = [
        '呀！别、别突然戳啦~',
        '嘿嘿，被发现了☆',
        '唔……头发会乱的！',
        '在看什么呀，工作啦工作！',
        '再戳的话……就罚你陪我看一整晚电影哦？',
        '好啦好啦，想我了就直说嘛~'
    ];

    const S = {
        booted: false,          // 只 boot 一次
        libsReady: false,
        app: null, model: null,
        stageEl: null, canvas: null, bubbleEl: null, closeBtn: null,
        enabled: false, modelId: '', modelFile: '', modelUrlBase: '', scale: 1,
        fsm: 'idle',            // idle | watching | thinking | talking
        bubbleTimer: 0, talkTimer: 0,
        pointer: null,          // 拖拽/点按判定
        focusBound: false, globalBound: false
    };

    /* ---------- 工具 ---------- */
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Live2D 组件加载失败: ' + src));
            document.head.appendChild(s);
        });
    }

    async function ensureLibs() {
        if (S.libsReady) return;
        for (const src of LIBS) await loadScript(src);
        if (!window.PIXI || !window.PIXI.live2d) throw new Error('Live2D 运行时初始化失败');
        S.libsReady = true;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    /* ---------- DOM：右下角独立浮层（挂在 body，全视图常驻） ---------- */
    function ensureDom() {
        if (S.stageEl && document.body.contains(S.stageEl)) { S.stageEl.style.display = ''; return true; }
        const stage = document.createElement('div');
        stage.id = 'companionStage';
        stage.innerHTML =
            '<div id="companionBubble" class="companion-bubble"></div>' +
            '<canvas id="companionCanvas"></canvas>' +
            '<button id="companionClose" class="companion-close" title="隐藏角色（设置 → AI 可重新开启）">×</button>';
        document.body.appendChild(stage);
        S.stageEl = stage;
        S.canvas = stage.querySelector('#companionCanvas');
        S.bubbleEl = stage.querySelector('#companionBubble');
        S.closeBtn = stage.querySelector('#companionClose');
        S.closeBtn.addEventListener('click', () => {
            stage.style.display = 'none';
            showNotification('Live2D 角色已隐藏', '设置 → AI 设置 → 伴侣看板可重新开启');
        });
        return true;
    }

    function hideDom() {
        if (S.stageEl) S.stageEl.style.display = 'none';
        if (S.bubbleEl) S.bubbleEl.classList.remove('show');
    }

    /* ---------- 舞台布局 ---------- */
    /* 纪律：canvas.width/height 只允许 PIXI 自己动 —— 外部直接赋值会让
     * WebGL 绘制缓冲失效（画进丢弃的 buffer，画面全空）。尺寸变化一律走 renderer.resize。 */
    function ensureApp() {
        if (S.app) return S.app;
        const w = S.canvas.clientWidth || 240, h = S.canvas.clientHeight || 320;
        S.app = new window.PIXI.Application({
            view: S.canvas, autoStart: true, backgroundAlpha: 0, width: w, height: h,
            preserveDrawingBuffer: true, antialias: true
        });
        return S.app;
    }

    function fitModel() {
        if (!S.model) return;
        const w = S.stageEl.clientWidth || 240, h = S.stageEl.clientHeight || 320;
        if (S.app && (S.app.renderer.width !== w || S.app.renderer.height !== h)) {
            S.app.renderer.resize(w, h);
        }
        // 真实像素高 = 当前高/当前缩放（originalHeight 是 moc 逻辑画布高，不是像素高，
        // 拿它当基准会把模型放大 ~3 倍只剩一张脸——实测踩过）
        const baseHeight = S.model.height / (S.model.scale.y || 1);
        const scale = (h * 0.9 * (S.scale || 1)) / baseHeight;
        S.model.scale.set(scale);
        S.model.position.set(w / 2, h * 0.96);
    }

    /* ---------- 动作与状态机 ---------- */
    function play(group, index, priority) {
        if (!S.model) return;
        try {
            S.model.motion(group, index, priority != null ? priority : window.PIXI.live2d.MotionPriority.NORMAL);
        } catch (e) { /* 动作缺失不影响 */ }
    }

    function showBubble(text, ms) {
        if (!S.bubbleEl) return;
        S.bubbleEl.innerHTML = text;
        S.bubbleEl.classList.add('show');
        clearTimeout(S.bubbleTimer);
        S.bubbleTimer = setTimeout(() => S.bubbleEl && S.bubbleEl.classList.remove('show'), ms || 6000);
    }

    function setState(next) {
        if (S.fsm !== next) console.log('[CVCompanion] 状态:', S.fsm, '→', next);
        S.fsm = next;
        if (!S.model) return;
        clearTimeout(S.talkTimer);
        switch (next) {
            case 'idle':
                break; // Idle 组由 motion manager 自动循环
            case 'watching':
                play('Main', Math.floor(Math.random() * 3), window.PIXI.live2d.MotionPriority.NORMAL);
                break;
            case 'thinking':
                showBubble('<span class="cb-think">…</span>', 20000);
                play('Main', 2, window.PIXI.live2d.MotionPriority.FORCE); // main_3
                break;
            case 'talking':
                // say() 已设置气泡；这里只负责动作，播完自动回落 Idle
                play('Main', Math.floor(Math.random() * 2), window.PIXI.live2d.MotionPriority.FORCE);
                break;
        }
    }

    /* ---------- 对外：AI 事件接线（app.js / home.js 调用） ---------- */
    function aiEvent(type, text) {
        if (!S.enabled || !S.model) return;
        if (type === 'thinking') {
            setState('thinking');
        } else if (type === 'reply') {
            const clean = String(text || '')
                .replace(/\[\[\d+\|([^\]]+)\]\]/g, '$1')
                .replace(/\s+/g, ' ')
                .trim();
            const brief = clean.length > 140 ? clean.slice(0, 140) + '…' : clean;
            if (brief) showBubble(esc(brief), Math.min(16000, 5000 + brief.length * 90));
            setState('talking');
            clearTimeout(S.talkTimer);
            S.talkTimer = setTimeout(() => setState('idle'), Math.min(16000, 6000 + brief.length * 100));
        } else if (type === 'error' || type === 'idle') {
            if (S.bubbleEl) S.bubbleEl.classList.remove('show');
            setState('idle');
        }
    }

    /* ---------- 交互：视线追踪 / 点按戳一戳 / 拖拽 ---------- */
    function bindInteractions() {
        // 视线追踪：全文档鼠标移动 → model.focus（节流 ~50ms，Alife 同款 focusController 调参）
        if (!S.focusBound) {
            S.focusBound = true;
            let last = 0;
            document.addEventListener('mousemove', (e) => {
                if (!S.model || !S.canvas || !S.enabled) return;
                const now = Date.now();
                if (now - last < 50) return;
                last = now;
                const r = S.canvas.getBoundingClientRect();
                S.model.focus(e.clientX - r.left, e.clientY - r.top);
            }, { passive: true });
        }

        // WATCHING：悬停/聚焦聊天输入框 → 看着你；离开 → 回 idle
        if (!S.globalBound) {
            S.globalBound = true;
            const bindTa = (id) => {
                const ta = document.getElementById(id);
                if (!ta || ta.__cvBound) return;
                ta.__cvBound = true;
                ta.addEventListener('mouseenter', () => { if (S.fsm === 'idle') setState('watching'); });
                ta.addEventListener('focus', () => { if (S.fsm === 'idle') setState('watching'); });
                ta.addEventListener('blur', () => setTimeout(() => { if (S.fsm === 'watching') setState('idle'); }, 150));
                ta.addEventListener('mouseleave', () => setTimeout(() => { if (S.fsm === 'watching') setState('idle'); }, 400));
            };
            bindTa('homeChatInput');
            bindTa('aiInput');
            window.addEventListener('resize', fitModel);
        }

        // 点按（戳）与拖拽：canvas 上的指针手势
        if (!S.canvas || S.canvas.__bound) return;
        S.canvas.__bound = true;
        S.canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !S.model) return;
            S.canvas.setPointerCapture(e.pointerId);
            S.pointer = { x: e.clientX, y: e.clientY, mx: S.model.x, my: S.model.y, moved: false };
        });
        S.canvas.addEventListener('pointermove', (e) => {
            const p = S.pointer;
            if (!p || !S.model) return;
            const dx = e.clientX - p.x, dy = e.clientY - p.y;
            if (Math.abs(dx) + Math.abs(dy) > 6) p.moved = true;
            if (p.moved) S.model.position.set(p.mx + dx, p.my + dy);
        });
        S.canvas.addEventListener('pointerup', (e) => {
            const p = S.pointer;
            S.pointer = null;
            if (!p || p.moved || !S.model) return;
            // 点按 = 戳一戳：TapBody 组随机（摸头/摸身体/特殊），加一句台词
            play('TapBody', Math.floor(Math.random() * 3), window.PIXI.live2d.MotionPriority.FORCE);
            showBubble(esc(rand(POKE_LINES)), 4200);
        });
    }

    /* ---------- 模型解析与加载 ---------- */
    async function resolveModelFile(modelId) {
        try {
            const r = await (await fetch('/api/ai/companion/models')).json();
            if (r.code === 0) {
                const m = (r.data.models || []).find(x => x.id === modelId);
                if (m) { S.modelFile = m.file; S.modelUrlBase = m.urlBase || ''; }
            }
        } catch (e) { /* 列表失败时沿用上次 */ }
        return { file: S.modelFile || 'dafeng_2.model3.json', urlBase: S.modelUrlBase || ('/live2d/models/' + encodeURIComponent(modelId)) };
    }

    function modelUrl(modelId, file, urlBase) {
        return (urlBase || ('/live2d/models/' + encodeURIComponent(modelId))) + '/' + file.split('/').map(encodeURIComponent).join('/');
    }

    async function loadModel(modelId) {
        const { file, urlBase } = await resolveModelFile(modelId);
        const url = modelUrl(modelId, file, urlBase);

        try {
            const model = await window.PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
            if (S.model && S.app) S.app.stage.removeChild(S.model);
            S.model = model;
            ensureApp();
            S.app.stage.addChild(model);
            model.anchor.set(0.5, 0.5);
            // Alife 同款：视线追踪手感（加速慢、回落慢 => 目光柔）
            const ctrl = model.internalModel && model.internalModel.focusController;
            if (ctrl) { ctrl.acceleration = 0.04; ctrl.deceleration = 0.08; }
            fitModel();
            return true;
        } catch (e) {
            console.log('[CVCompanion] 模型加载失败:', e.message);
            // 保留旧角色继续演出（若有），仅提示；首次加载失败才隐藏浮层
            if (S.model) {
                showBubble(esc('这个模型好像加载不动，换一个试试？'), 5000);
                return false;
            }
            hideDom();
            return false;
        }
    }

    /**
     * Core 预热：实测本组合（pixi 6.5.10 + cubism core 5.1 + pixi-live2d-display）
     * 页面上加载的第一个 Cubism 模型有概率渲染空白，第二个起稳定（多次二分实验证实）。
     * 预热必须走"真实可见的 draw 路径"——屏幕外/零尺寸会被剔除而不生效——
     * 因此按正式布局绘制但 alpha 压到 0.01（肉眼不可见），绘完即销毁。
     */
    async function warmupCore(url) {
        try {
            ensureApp();
            const warm = await window.PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
            warm.anchor.set(0.5, 0.5);
            warm.alpha = 0.01;
            const w = S.canvas.clientWidth || 240, h = S.canvas.clientHeight || 320;
            const base = warm.height / (warm.scale.y || 1);
            warm.scale.set((h * 0.9) / base);
            warm.position.set(w / 2, h * 0.96);
            S.app.stage.addChild(warm);
            await new Promise(r => setTimeout(r, 900));
            S.app.stage.removeChild(warm);
            try { warm.destroy(); } catch (e) { /* 忽略 */ }
            return true;
        } catch (e) {
            console.log('[CVCompanion] core 预热失败（继续正式加载）:', e.message);
            return false;
        }
    }

    /** 自检：采样画布多点像素，全透明视为渲染失败（preserveDrawingBuffer 已开，读数可信） */
    function canvasHasPixels() {
        try {
            const gl = S.canvas.getContext('webgl2') || S.canvas.getContext('webgl');
            if (!gl) return true; // 拿不到上下文就不妄下结论
            const pts = [[0.5, 0.35], [0.5, 0.5], [0.5, 0.65], [0.42, 0.55], [0.58, 0.55]];
            const buf = new Uint8Array(4);
            for (const [fx, fy] of pts) {
                gl.readPixels(Math.floor(S.canvas.width * fx), Math.floor(S.canvas.height * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                if (buf[3] > 0) return true;
            }
            return false;
        } catch (e) { return true; }
    }

    /* ---------- 启动 / 应用配置 / 关闭 ---------- */
    async function start(cfg) {
        S.enabled = true;
        S.modelId = cfg.model || 'dafeng_2';
        S.scale = cfg.scale || 1;
        ensureDom();
        if (S.libsReady !== true) {
            try { await ensureLibs(); } catch (e) { console.log('[CVCompanion]', e.message); hideDom(); return; }
        }
        // 先解析模型文件名并做 core 预热，正式加载后自检自愈（空白则重载一次）
        const { file, urlBase } = await resolveModelFile(S.modelId);
        await warmupCore(modelUrl(S.modelId, file, urlBase));
        let ok = await loadModel(S.modelId);
        if (ok) {
            await new Promise(r => setTimeout(r, 700));
            if (!canvasHasPixels()) {
                console.log('[CVCompanion] 首次渲染空白，重载一次模型');
                ok = await loadModel(S.modelId);
                await new Promise(r => setTimeout(r, 700));
                if (!canvasHasPixels()) {
                    console.log('[CVCompanion] 二次渲染仍空白，隐藏浮层');
                    hideDom();
                    return;
                }
            }
        }
        if (!ok) return;
        bindInteractions();
        // fsm 初始即 idle，不在这里重置——避免覆盖 boot 尾声期间外部已注入的状态
        console.log('[CVCompanion] Live2D 伴侣已就位：', S.modelId);
    }

    function shutdown() {
        S.enabled = false;
        hideDom();
    }

    /** 设置页保存后调用：启停 / 换模 / 缩放 / 换目录 */
    async function applyConfig(cfg) {
        if (!cfg.enabled) { shutdown(); return { ok: true, off: true }; }
        const modelChanged = cfg.model !== S.modelId;
        const wasHidden = !S.stageEl || S.stageEl.style.display === 'none';
        S.enabled = true;
        S.scale = cfg.scale || 1;
        if (modelChanged || !S.model || wasHidden) {
            S.modelId = cfg.model || 'dafeng_2';
            await start(cfg);
            return { ok: true, reloaded: true };
        }
        fitModel();
        return { ok: true };
    }

    async function boot() {
        if (S.booted) return;
        S.booted = true;
        let cfg;
        try {
            const r = await (await fetch('/api/ai/companion/config')).json();
            if (r.code !== 0 || !r.data.enabled) return;
            cfg = r.data;
        } catch (e) { return; }
        start(cfg);
    }

    /* 暴露 API（与蓝图约定的 window.CVCompanion 单例一致） */
    window.CVCompanion = {
        boot, applyConfig, aiEvent, shutdown,
        get state() { return S.fsm; },
        get loaded() { return !!(S.model && S.app); },
        get debug() {
            if (!S.model || !S.app) return { hasModel: false };
            const m = S.model;
            return {
                hasModel: true,
                natural: [Math.round(m.width), Math.round(m.height)],
                scale: [Number(m.scale.x.toFixed(4)), Number(m.scale.y.toFixed(4))],
                pos: [Math.round(m.x), Math.round(m.y)],
                visible: m.visible, alpha: m.alpha, worldAlpha: m.worldAlpha,
                rendererSize: [S.app.renderer.width, S.app.renderer.height],
                children: S.app.stage.children.length,
                motion: m.internalModel && m.internalModel.motionManager && m.internalModel.motionManager.state ? m.internalModel.motionManager.state.currentGroup : 'n/a'
            };
        }
    };
})();
