/* ============================================================
   round127 · radial.js —— 详情弹窗「长按环形工具箱」
   ------------------------------------------------------------
   需求（m00003 · bug4）：
     · 在详情弹窗上长按 → 弹出环形工具箱
     · 鼠标微微移动，指向方向对应的工具就突出（放大 + 高亮）
     · 松手即执行该工具

   为什么做成独立文件而不是改 app.js 的模板：
     · 详情面板有多套渲染路径（影片 / 漫画 / 小说 / 云端 / AV 详情），
       逐个改模板必然漏一套；这里在 DOM 层直接读 `.detail-actions .dbtn`，
       一套逻辑覆盖全部；
     · 环形菜单复用的是**同一批真实按钮**（取它们的图标 + 文案 + data-act），
       激活时直接调用 `btn.click()` ⇒ 所有 onclick / addEventListener 原样生效，
       不需要复制任何业务逻辑，也不会出现「环形菜单里的按钮没反应」；
     · 特别是 `.dbtn.is-extra`（round116 折进「更多」里的 10 个低频工具），
       平时要展开才能点到，环形菜单里全部直接可选 —— 这才是它的价值。
     · 回滚只需删掉 library.html 里这一行 <script>，DOM 立刻恢复原状。

   与既有交互的边界（很重要，否则会打架）：
     · 点海报 = 灯箱放大、点按钮 = 直接执行、拖动 = 选择文本。
       所以长按判定必须 **>420ms 且位移 <8px**，且触发后吞掉紧随的 click；
     · 表单控件 / 按钮 / 链接 上不长按（那是原生交互，尤其 .dbtn 自己有按压动画）；
     · 环形菜单内位移 <10px 视为「没选」，松手只关闭不执行 —— 避免误触发删除类工具。
   ============================================================ */
(function () {
    'use strict';

    if (window.__r127Radial) return;   // 防重复注入
    window.__r127Radial = true;

    var HOLD_MS = 420;      // 长按阈值
    var MOVE_TOL = 8;       // 长按期间允许的抖动位移（超过即判定为拖动/滚动）
    var DEADZONE = 10;      // 环形菜单内「算选中」的最小位移
    var RING_MIN = 108;     // 扇区中心到环心的最小距离
    var RING_MAX = 210;     // 再大就会顶到弹窗边缘/屏幕外

    /* 工具多达 14 个（round116 把低频工具折进了「更多」，但 DOM 里全在）。
       固定半径会让相邻扇区挤在一起、文案互相压字，所以按数量放大半径：
       相邻扇区的弦长 ≈ 2R·sin(π/n)，让弦长至少 78px（图标 46px + 呼吸间隙）。
       同时受视口约束 —— 手机上 14 个扇区摊开能超过 350px，必须收着点，
       否则扇区会被裁到屏幕外，用户根本指不到。 */
    function ringRadius(n) {
        if (!n || n < 2) return RING_MIN;
        var need = 39 / Math.sin(Math.PI / n);   // 2R·sin(π/n) ≥ 78  ⇒  R ≥ 39/sin(π/n)
        /* 44 = 图标半宽 + 文案余量；留出 8px 屏幕边距 */
        var vw = (window.innerWidth || 1024);
        var vh = (window.innerHeight || 768);
        var fit = Math.min(vw, vh) / 2 - 52;
        var hi = Math.max(RING_MIN, Math.min(RING_MAX, fit));
        return Math.max(RING_MIN, Math.min(hi, Math.round(need)));
    }

    var st = {
        timer: 0,
        open: false,
        cx: 0, cy: 0,
        sx: 0, sy: 0,
        lx: 0, ly: 0,       // 指针最近位置
        pointerId: null,
        layer: null,
        items: [],
        hot: -1,
        /* 长按成立后必须吞掉紧随其后的那次 click，否则会顺带触发
           「点海报 → 灯箱放大」或「点按钮 → 直接执行」。
           用布尔标记而不是时间窗：用户可能按住不放好几秒，
           时间窗要么太短漏吞、要么太长误吞后续正常点击。 */
        suppress: false,
        /* 我们自己用 btn.click() 触发的那一次点击必须放行，
           否则会被下面的 suppress 吞掉 —— 环形菜单就会「点了没反应」。 */
        selfClick: false,
        fuse: 0,            // suppress 的保险丝定时器
        radius: 0           // 本次环形菜单的实际半径
    };

    /* ── 样式（自包含，删掉 script 即彻底回滚） ───────────────── */
    function injectStyle() {
        if (document.getElementById('r127RadialStyle')) return;
        var css = [
            '#r127Radial{position:fixed;inset:0;z-index:900;display:none;}',
            '#r127Radial.is-on{display:block;}',
            '#r127Radial .r127-veil{position:absolute;inset:0;background:radial-gradient(circle at var(--r127-cx,50%) var(--r127-cy,50%),',
            '  rgba(10,10,14,.28) 0%,rgba(10,10,14,.52) 45%,rgba(10,10,14,.68) 100%);',
            '  backdrop-filter:blur(2.5px);-webkit-backdrop-filter:blur(2.5px);',
            '  opacity:0;transition:opacity .18s ease;}',
            '#r127Radial.is-on .r127-veil{opacity:1;}',
            '#r127Radial .r127-hub{position:absolute;width:14px;height:14px;border-radius:50%;',
            '  transform:translate(-50%,-50%) scale(.4);opacity:0;',
            '  background:radial-gradient(circle,#fff 0%,rgba(255,255,255,.5) 55%,transparent 70%);',
            '  box-shadow:0 0 0 1px rgba(255,255,255,.35),0 0 24px 6px rgba(120,180,255,.28);',
            '  transition:transform .22s cubic-bezier(.22,.61,.36,1),opacity .18s ease;}',
            '#r127Radial.is-on .r127-hub{transform:translate(-50%,-50%) scale(1);opacity:1;}',

            '#r127Radial .r127-item{position:absolute;display:flex;flex-direction:column;align-items:center;gap:5px;',
            '  width:72px;transform:translate(-50%,-50%) scale(.62);opacity:0;pointer-events:none;',
            '  transition:transform .26s cubic-bezier(.22,.61,.36,1),opacity .2s ease,filter .16s ease;',
            '  will-change:transform,opacity;}',
            '#r127Radial.is-on .r127-item{transform:translate(-50%,-50%) scale(1);opacity:.72;}',

            '#r127Radial .r127-chip{width:46px;height:46px;border-radius:15px;display:flex;align-items:center;justify-content:center;',
            '  background:rgba(28,29,36,.86);border:1px solid rgba(255,255,255,.16);',
            '  box-shadow:0 10px 22px -12px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.10);',
            '  color:#e9ecf5;transition:background .16s ease,border-color .16s ease,box-shadow .16s ease;}',
            '#r127Radial .r127-chip .nv-ic{width:24px !important;height:24px !important;}',
            '#r127Radial .r127-label{font-size:11px;line-height:1.15;white-space:nowrap;color:rgba(233,236,245,.78);',
            '  text-shadow:0 1px 3px rgba(0,0,0,.75);transition:color .16s ease;max-width:84px;',
            '  overflow:hidden;text-overflow:ellipsis;}',

            /* 选中的扇区：放大 + 提亮 + 描边 */
            '#r127Radial .r127-item.is-hot{transform:translate(-50%,-50%) scale(1.22);opacity:1;z-index:3;}',
            '#r127Radial .r127-item.is-hot .r127-chip{background:rgba(248,250,255,.96);border-color:rgba(255,255,255,.95);',
            '  color:#12131a;box-shadow:0 0 0 2px rgba(120,180,255,.55),0 14px 30px -10px rgba(120,180,255,.55);}',
            '#r127Radial .r127-item.is-hot .r127-label{color:#fff;font-weight:600;}',
            '#r127Radial .r127-item.is-danger.is-hot .r127-chip{background:rgba(255,235,238,.97);border-color:rgba(255,120,140,.95);',
            '  box-shadow:0 0 0 2px rgba(239,68,68,.55),0 14px 30px -10px rgba(239,68,68,.6);}',

            '#r127Radial .r127-hint{position:absolute;transform:translate(-50%,-50%);font-size:11px;letter-spacing:.06em;',
            '  color:rgba(233,236,245,.55);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .18s ease;}',
            '#r127Radial.is-on .r127-hint{opacity:1;}',

            '@media (prefers-reduced-motion: reduce){',
            '  #r127Radial .r127-item,#r127Radial .r127-hub,#r127Radial .r127-veil{transition:none !important;}',
            '}',

            /* 长按海报时浏览器会把 <img> 拖起来（原生 drag），环形菜单就被顶掉了。
               只禁掉详情弹窗里的图片拖动，不影响页面其它地方。 */
            '#detailModal img{-webkit-user-drag:none;}',
            '#detailModal{-webkit-touch-callout:none;}'
        ].join('\n');

        var el = document.createElement('style');
        el.id = 'r127RadialStyle';
        el.textContent = css;
        document.head.appendChild(el);
    }

    /* ── 收集当前详情面板里可用的工具 ─────────────────────────── */
    function collectTools() {
        /* 详情有多套渲染路径，个别路径（云端 / AV 详情）把 .detail-actions
           挂在 #detailBody 之外，所以按优先级依次找，别只认一个。 */
        var box = document.querySelector('#detailBody .detail-actions')
            || document.querySelector('#detailModal .detail-actions');
        if (!box) return [];
        var out = [];
        var nodes = box.querySelectorAll('.dbtn');
        for (var i = 0; i < nodes.length; i++) {
            var b = nodes[i];
            var act = b.getAttribute('data-act') || '';
            if (act === 'more') continue;             // 「更多」本身没有意义
            var labelNode = b.querySelector('.dbtn-label');
            var label = (labelNode ? labelNode.textContent : b.getAttribute('title') || act).trim();
            if (!label) continue;
            out.push({
                btn: b,
                label: label,
                danger: b.classList.contains('danger'),
                icon: b.querySelector('.nv-ic')
            });
        }
        return out;
    }

    function buildLayer(tools) {
        var layer = document.createElement('div');
        layer.id = 'r127Radial';
        layer.setAttribute('role', 'menu');
        layer.setAttribute('aria-label', '工具环形菜单');

        var veil = document.createElement('div');
        veil.className = 'r127-veil';
        layer.appendChild(veil);

        var hub = document.createElement('div');
        hub.className = 'r127-hub';
        layer.appendChild(hub);

        var n = tools.length;
        var step = 360 / n;
        var R = ringRadius(n);
        st.radius = R;
        var frag = document.createDocumentFragment();

        tools.forEach(function (t, i) {
            var ang = (-90 + i * step) * Math.PI / 180;
            var item = document.createElement('div');
            item.className = 'r127-item' + (t.danger ? ' is-danger' : '');
            item.setAttribute('role', 'menuitem');
            item.setAttribute('aria-label', t.label);
            item.dataset.idx = String(i);
            item.style.left = (Math.cos(ang) * R).toFixed(1) + 'px';
            item.style.top = (Math.sin(ang) * R).toFixed(1) + 'px';

            var chip = document.createElement('div');
            chip.className = 'r127-chip';
            if (t.icon) {
                var ic = t.icon.cloneNode(true);
                /* 克隆出来的 <video> 不会自动播，去掉它只留 PNG/SVG，避免空白块 */
                var vids = ic.querySelectorAll('video');
                for (var k = 0; k < vids.length; k++) vids[k].remove();
                var img = ic.querySelector('.nv-ic-img');
                var svg = ic.querySelector('.nv-ic-svg');
                var emo = ic.querySelector('.nv-ic-emo');
                if (img) {
                    img.hidden = false;
                    img.style.display = 'block';
                    /* 原按钮里的兜底是靠内联 onerror 改写兄弟节点；
                       克隆体上重新挂一份，保证 PNG 缺失时不会留个破图标 */
                    img.onerror = function () {
                        this.hidden = true;
                        this.style.display = 'none';
                        if (svg && svg.innerHTML.trim()) { svg.hidden = false; svg.style.display = 'inline-flex'; }
                        else if (emo) { emo.hidden = false; emo.style.display = 'inline-flex'; }
                    };
                } else if (svg && svg.innerHTML.trim()) {
                    svg.hidden = false;
                    svg.style.display = 'inline-flex';
                } else if (emo) {
                    emo.hidden = false;
                    emo.style.display = 'inline-flex';
                }
                chip.appendChild(ic);
            } else {
                chip.textContent = t.label.slice(0, 1);
            }

            var lab = document.createElement('div');
            lab.className = 'r127-label';
            lab.textContent = t.label;

            item.appendChild(chip);
            item.appendChild(lab);
            frag.appendChild(item);
            t.el = item;
            t.angle = -90 + i * step;
        });

        layer.appendChild(frag);

        var hint = document.createElement('div');
        hint.className = 'r127-hint';
        hint.textContent = '松手执行 · 移出环心取消';
        layer.appendChild(hint);

        st.items = tools;
        st.layer = layer;
        st.hint = hint;
        return layer;
    }

    /* ── 开 / 关 ─────────────────────────────────────────────── */
    function open(x, y) {
        var tools = collectTools();
        if (!tools.length) return false;

        injectStyle();
        close(true);

        var layer = buildLayer(tools);
        var R = st.radius || RING_MIN;

        /* 环心夹回视口内：海报常常贴在窗口边缘，按原样摊开会有一半扇区飞出屏幕。 */
        var padX = R + 44;      // 44 ≈ 图标半宽 + 文案余量
        var padY = R + 34;
        var cx = Math.min(Math.max(x, padX), Math.max(padX, window.innerWidth - padX));
        var cy = Math.min(Math.max(y, padY), Math.max(padY, window.innerHeight - padY));

        layer.style.setProperty('--r127-cx', cx + 'px');
        layer.style.setProperty('--r127-cy', cy + 'px');

        /* 所有 item 的 left/top 是相对环心的偏移，用一个零尺寸 wrap 承载即可 */
        var wrap = document.createElement('div');
        wrap.style.position = 'absolute';
        wrap.style.left = cx + 'px';
        wrap.style.top = cy + 'px';
        wrap.style.width = '0';
        wrap.style.height = '0';

        var items = layer.querySelectorAll('.r127-item');
        for (var i = 0; i < items.length; i++) wrap.appendChild(items[i]);

        var hub = layer.querySelector('.r127-hub');
        if (hub) { hub.style.left = cx + 'px'; hub.style.top = cy + 'px'; }
        var hint = layer.querySelector('.r127-hint');
        if (hint) {
            hint.style.left = cx + 'px';
            /* 提示条放环下方；环大时可能压到屏幕底，必要时翻到环上方 */
            var below = cy + R + 46;
            hint.style.top = (below > window.innerHeight - 16 ? cy - R - 34 : below) + 'px';
        }

        layer.appendChild(wrap);

        document.body.appendChild(layer);
        st.cx = cx; st.cy = cy;
        st.hot = -1;
        st.open = true;

        /* 下一帧再挂 is-on，让 transition 真正跑起来 */
        requestAnimationFrame(function () { layer.classList.add('is-on'); });
        return true;
    }

    function close(silent) {
        var layer = st.layer;
        st.open = false;
        st.hot = -1;
        st.items = [];
        st.layer = null;
        st.hint = null;
        if (!layer) return;
        layer.classList.remove('is-on');
        if (silent) {
            if (layer.parentNode) layer.parentNode.removeChild(layer);
            return;
        }
        setTimeout(function () {
            if (layer.parentNode) layer.parentNode.removeChild(layer);
        }, 190);
    }

    /* ── 方向 → 扇区 ─────────────────────────────────────────── */
    function updateHot(x, y) {
        if (!st.open || !st.items.length) return;
        var dx = x - st.cx;
        var dy = y - st.cy;
        var dist = Math.sqrt(dx * dx + dy * dy);

        var idx = -1;
        if (dist >= DEADZONE) {
            var n = st.items.length;
            var step = 360 / n;
            var deg = Math.atan2(dy, dx) * 180 / Math.PI;   // -180..180，0 = 正右
            var norm = ((deg + 90) % 360 + 360) % 360;      // 0 = 正上（第 0 项在正上方）
            idx = Math.round(norm / step) % n;
            /* 注意：这里刻意**不**按距离取消 —— 用户常常会甩出去很远再松手，
               只要方向对就该选中。取消只能靠「回到环心死区」或按 Esc。 */
        }

        if (idx === st.hot) return;
        st.items.forEach(function (t, i) {
            if (!t.el) return;
            t.el.classList.toggle('is-hot', i === idx);
        });
        st.hot = idx;
    }

    /* ── 长按判定 ───────────────────────────────────────────── */
    function isExcluded(target) {
        if (!target || !target.closest) return true;
        /* 原生交互元素上不长按：按钮自己有按压动画，输入框要能选文本 */
        if (target.closest('.dbtn, button, a, input, textarea, select, label, [contenteditable="true"]')) return true;
        if (target.closest('#r127Radial')) return true;

        /* 详情之上还压着别的弹窗（更换海报 / 编辑 / 播放列表 / 灯箱）⇒ 不抢 */
        var overlays = document.querySelectorAll('.modal.in, .modal.show, #posterLightbox.show');
        for (var i = 0; i < overlays.length; i++) {
            var m = overlays[i];
            if (m.id === 'detailModal') continue;
            if (m.contains(target)) return true;      // 点在那个弹窗自己身上
            /* 那个弹窗开着且盖在详情之上 ⇒ 详情里的长按一律让位 */
            if (m.id === 'posterLightbox' || m.querySelector('.modal-content')) {
                var dmz = document.getElementById('detailModal');
                if (dmz && dmz.classList.contains('in')) return true;
            }
        }
        return false;
    }

    function cancelHold() {
        if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
        st.pointerId = null;
    }

    function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;   // 只响应左键
        if (st.open) return;
        /* 新手势开始 ⇒ 上一轮残留的 suppress 一律作废，
           否则这次正常的按下-抬起会被上一条保险丝吞掉一次点击 */
        clearSuppress();

        var dm = document.getElementById('detailModal');
        if (!dm || !dm.contains(e.target)) return;
        if (!dm.classList.contains('in')) return;
        if (isExcluded(e.target)) return;

        st.pointerId = e.pointerId;
        st.sx = e.clientX;
        st.sy = e.clientY;
        st.lx = e.clientX;
        st.ly = e.clientY;

        cancelHold();
        st.timer = setTimeout(function () {
            st.timer = 0;
            /* 长按成立：标记「接下来的 click 要吞掉」，避免同时触发灯箱/按钮 */
            st.suppress = true;
            var ok = open(st.sx, st.sy);
            if (!ok) { st.suppress = false; return; }
            /* 环心可能因为贴边被夹回视口内，此时**不能**再用按下点算方向
               （会立刻误选中某个扇区）。用环心自身初始化 ⇒ 落在死区 ⇒ 不选中。 */
            updateHot(st.cx, st.cy);
            if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { } }
        }, HOLD_MS);
    }

    function onPointerMove(e) {
        st.lx = e.clientX;
        st.ly = e.clientY;
        /* 长按等待期：位移过大 ⇒ 判定为拖动/滚动，取消 */
        if (st.timer) {
            var dx = e.clientX - st.sx;
            var dy = e.clientY - st.sy;
            if (dx * dx + dy * dy > MOVE_TOL * MOVE_TOL) cancelHold();
            return;
        }
        if (!st.open) return;
        updateHot(e.clientX, e.clientY);
    }

    function onPointerUp(e) {
        if (st.timer) { cancelHold(); return; }
        if (!st.open) return;

        var idx = st.hot;
        var item = idx >= 0 ? st.items[idx] : null;
        /* suppress 保持 true：紧随的这次 click 必须被吞掉（它属于长按手势，
           不是一次新的点击）。程序化执行的 item.btn.click() 在下面 setTimeout 里，
           先清标记再点，才不会把自己吞掉。 */
        close();

        /* 兜底：有些区域（纯文本、海报容器）松手后浏览器并不补发 click，
           此时 suppress 会一直挂着，把用户**下一次**正常点击也吞掉。
           给一个 400ms 的保险丝，超时就复位。 */
        armSuppressFuse();

        if (item && item.btn && item.btn.isConnected) {
            /* 先关菜单再执行：换海报/编辑会开新弹窗，不能让环挡在上面 */
            setTimeout(function () {
                st.suppress = false;
                /* 这是程序化点击，不是长按手势的残余 ⇒ 打标放行 */
                st.selfClick = true;
                try { item.btn.click(); } catch (err) { }
                /* 保险丝：某些按钮点击后并不冒泡（或被 stopPropagation），
                   标记必须自己清掉，否则下一次真实点击会被误放行。 */
                setTimeout(function () { st.selfClick = false; }, 0);
            }, 0);
        } else {
            setTimeout(function () { st.suppress = false; }, 0);
        }
    }

    /* ── suppress 保险丝 ─────────────────────────────────────── */
    function armSuppressFuse() {
        if (st.fuse) clearTimeout(st.fuse);
        st.fuse = setTimeout(function () {
            st.fuse = 0;
            st.suppress = false;
        }, 400);
    }

    function clearSuppress() {
        if (st.fuse) { clearTimeout(st.fuse); st.fuse = 0; }
        st.suppress = false;
    }

    function onPointerCancel() {
        cancelHold();
        if (st.open) close();
        clearSuppress();
    }

    /* 长按触发后，浏览器仍会补发一次 click（可能点到海报开灯箱）⇒ 吞掉 */
    function onClickCapture(e) {
        /* 环形菜单自己点出来的那一次：必须放行 */
        if (st.selfClick) return;
        if (st.suppress) {
            clearSuppress();
            e.stopPropagation();
            e.preventDefault();
        }
    }

    function onKeyDown(e) {
        if (e.key === 'Escape' && st.open) {
            e.stopPropagation();
            e.preventDefault();
            close();
            clearSuppress();
        }
    }

    /* 拖动选择文本会触发 selectstart：长按期间禁掉，避免环上出现蓝色选区 */
    function onSelectStart(e) {
        if (st.open) e.preventDefault();
    }

    /* 海报是 <img>，长按时浏览器会启动原生拖拽（dragstart），
       拖影会盖住环形菜单，松手还会触发 drop。长按手势期间直接掐掉。 */
    function onDragStart(e) {
        if (st.open || st.timer) { e.preventDefault(); e.stopPropagation(); }
    }

    function boot() {
        injectStyle();
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointermove', onPointerMove, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerCancel, true);
        document.addEventListener('click', onClickCapture, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('selectstart', onSelectStart, true);
        document.addEventListener('dragstart', onDragStart, true);
        document.addEventListener('contextmenu', function (e) {
            /* 触屏长按会弹系统菜单，盖住环形工具箱 */
            if (st.open) { e.preventDefault(); e.stopPropagation(); }
        }, true);
        window.addEventListener('blur', function () { cancelHold(); if (st.open) close(); });
        window.addEventListener('wheel', function () { if (st.open) close(); }, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
