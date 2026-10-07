/* ==========================================================================
   AARDVARK 书架层 v1 —— 小说 / 漫画 / 猜你喜欢
   --------------------------------------------------------------------------
   设计来源：aardvarkbookclub.com/books/mazywood（2026-09-21 实测）
   挂载方式：app.js 在两个位置留出钩子（见文件内 AvBoard 注释）：
     1) switchView case 'guess'        → AvBoard.openGuess()
     2) renderTreeLibrary 渲染 items 前 → AvBoard.renderTreeLevel(type, node)
   依赖：app.js 暴露的 showMovieDetail / playMovieInline / getPosterUrl /
        switchView / enterTreeFolder / escapeHtml / formatSize / countItemsInFolder
   后端：只读 /api/recommend/guess（limit 参数后端原本就支持），不改任何写接口。
   回滚：library.html 去掉本文件 <script> 一行即完全失效，app.js 钩子自动兜底旧逻辑。
   ========================================================================== */
(function () {
    'use strict';

    /* ---------- 参考站实测设计常量 ---------- */

    // 糖果粉彩 10 色板
    var CANDY = ['#ffdbfd', '#FAED8F', '#DDFCFC', '#CAF7C8', '#fbb663',
                 '#f49978', '#feb6fa', '#c2b4eb', '#997ade', '#00ecef'];

    // 散落角 / 垂直偏移（解码自参考站 .books-slider__item-cover 的 computed matrix）
    var SCATTER = [
        [1.75, 32.7], [-1.05, -7.2], [-0.26, -3.1], [2.4, 18.0],
        [-1.9, 6.5], [0.85, -14.5], [-2.6, 24.0], [1.2, -2.0],
        [-0.6, 12.0], [2.05, -10.0], [-1.45, 20.5], [0.4, 4.0]
    ];

    var BLOB_PATH = 'M0 214C0 96 152 22 340 40c188 18 302 96 470 88 168-8 292-72 430-40 ' +
        '138 32 200 128 200 236 0 108-92 196-232 212-140 16-318-24-472-30-154-6-306 8-444-22C152 452 0 332 0 214Z';

    // 漫画里的非正片章节（公告/请假条不占封面墙）
    var NOTICE_RE = /(通知|公告|请假|复刊|名单)/;

    /* ---------- 兔耳 / 兔尾（参考站 Aardvark 真实实现） ----------
       2026-09-21 逆向自 aardvarkbookclub.com：
       · 耳朵容器 .books-slider__item-bg-ears 绝对定位在卡片顶部之上
         （bottom: calc(100% - 1px)），里面并排两只耳朵：
           - 左耳 viewBox="0 0 44 45"，4.875em × 5em，margin-right: -1.8em（与右耳重叠形成转折）
           - 右耳 viewBox="0 0 29 80"，3.25em × 9em（更长）
       · 两只耳朵都是 fill="currentColor"，颜色继承自卡片面板 → 看起来就是"卡片长出的耳朵"
       · 触发：默认 transform: scale(0)（实测 computed 为 matrix(0,0,0,0,0,0)，即完全塌缩），
         卡片 hover 时变为 scale(1)，transition 0.25s cubic-bezier(.32,.72,0,1)
       · <991px 隐藏（参考站同款断点）
       下方另有 tail（尾巴）—— 参考站用 .books-slider__item-bg-bottom 同色下摆，
       这里换成真正的圆形短尾巴，视觉更明确。 */
    var EAR_PATHS = {
        left: 'M1.335.198c.671-.316 1.5-.254 2.186.187C27.678 16.847 39.839 36.953 44 45h-6.048' +
              'c-2.382-1.604-6.964-3.674-15.652-4.814C2.999 37.666-.665 14.174.09 2.04.152 1.28.589.515 1.335.198Z',
        right: 'M19.388.879c.667-.771 1.647-1.018 2.559-.807.912.21 1.682.956 1.926 1.861' +
               'C34.595 38.09 25.79 69.237 21.823 80h-4.188c-.17-4.22-2.739-13.318-10.975-22.064' +
               '-8.493-9.099-8.88-21.913-1.063-37.23C11.221 9.603 19.091 1.266 19.388.879Z'
    };

    /* 一只完整的小兔子脸（耳朵 + 尾巴）。color 决定耳朵/尾巴颜色。 */
    function bunnyEars(color) {
        return '<div class="av-ears" style="color:' + color + '" aria-hidden="true">' +
            '<svg class="av-ear av-ear-left" viewBox="0 0 44 45" fill="none" focusable="false">' +
            '<path fill="currentColor" d="' + EAR_PATHS.left + '"/></svg>' +
            '<svg class="av-ear av-ear-right" viewBox="0 0 29 80" fill="none" focusable="false">' +
            '<path fill="currentColor" d="' + EAR_PATHS.right + '"/></svg>' +
            '</div>';
    }

    /* 尾巴：贴在卡片下沿中间偏右，hover 时弹出 */
    function bunnyTail(color) {
        return '<div class="av-tail" style="color:' + color + '" aria-hidden="true">' +
            '<svg viewBox="0 0 48 48" fill="none" focusable="false">' +
            '<circle cx="24" cy="24" r="22" fill="currentColor"/>' +
            '<circle cx="17.5" cy="17.5" r="7" fill="#fff" opacity=".38"/>' +
            '</svg></div>';
    }

    /* ---------- 小工具 ---------- */

    function esc(s) {
        if (typeof escapeHtml === 'function') return escapeHtml(s == null ? '' : String(s));
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
        });
    }

    function scatter(i) { return SCATTER[i % SCATTER.length]; }
    function candy(i) { return CANDY[i % CANDY.length]; }

    function mb(size) {
        var n = (size || 0) / 1048576;
        return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' MB';
    }

    /* 「002：第一回 皓光当空 上-日月同错」→ { no:'002', title:'第一回 皓光当空 上' }
       树 item 没有 displayTitle，真实章节名在 title / cleanName / fileName 里 */
    function itemTitle(it) {
        return it.title || it.cleanName || it.displayTitle || it.fileName || '';
    }

    function splitChapter(name) {
        var m = /^(\d+)[：:](.+?)(?:-[^-]+)?$/.exec(name || '');
        if (m) return { no: m[1], title: m[2].trim() };
        return { no: '', title: name || '未命名' };
    }

    /* 弧线识别：去掉序号/上下中 suffix 后取副标题前 2 字，按出现次数聚合
       （千年之谣→千年 / 三川那日→三川 / 万业新界→万业 / 小事一桩→小事），数据驱动，不写死 */
    function detectArcs(items) {
        var counts = {};
        items.forEach(function (it) {
            var t = splitChapter(itemTitle(it)).title;
            if (NOTICE_RE.test(t)) return;
            t = t.replace(/[上中下]$/, '').replace(/^第[一二三四五六七八九十百零0-9]+[回话]\s*/, '');
            var arc = t.slice(0, 2);
            if (arc.length >= 2) counts[arc] = (counts[arc] || 0) + 1;
        });
        return Object.keys(counts)
            .map(function (k) { return [k, counts[k]]; })
            .filter(function (a) { return a[1] >= 3; })
            .sort(function (a, b) { return b[1] - a[1]; })
            .slice(0, 4);
    }

    function arcOf(item) {
        var t = splitChapter(itemTitle(item)).title;
        if (NOTICE_RE.test(t)) return '';
        t = t.replace(/[上中下]$/, '').replace(/^第[一二三四五六七八九十百零0-9]+[回话]\s*/, '');
        return t.slice(0, 2);
    }

    /* ---------- 粉彩文字卡（漫画章节 / 小说卷，无海报） ---------- */

    function textCard(item, kind, i) {
        var sc = scatter(i);
        var ch = splitChapter(itemTitle(item) || '未命名');
        var isNovel = kind === 'novel';
        var vol = isNovel ? (ch.title.match(/\d+/) || [''])[0] : '';
        var cta = isNovel ? '打开这一卷' : '继续阅读';
        /* ★ round26续：这一层原先一张 <img> 都不产出，所以漫画 / 小说的封面在树视图里
           永远看不见 —— 改没改封面都一样（用户在「换封面」里选了新图，库里也写进去了，
           卡片却还是那块糖果色）。.av-card 本身就是 2:2.9 的竖版比例，正好当书封位：
           有封面就铺满 + 上下加遮罩保证文字可读，没有就保持原来的糖果色卡。 */
        var art = '';
        try { if (typeof getPosterUrl === 'function') art = getPosterUrl(item) || ''; } catch (e) { art = ''; }
        /* ★ round73：阅读状态角标。
           形状 > 颜色 > 文案：未读=空心圈 / 在读=实心胶囊+百分比 / 读完=实心✓ / 搁置=空心胶囊。
           数据来自 media_progress（round73 新落库表）；该表没有记录时回落 item.watched。 */
        var flags = (item.favorite === 1 ? '<span class="av-flag">⭐</span>' : '') + avpBadges(item);
        return '<div class="av-card' + (art ? ' has-art' : '') + '" data-av-id="' + esc(item.id) + '" tabindex="0" role="button" ' +
            'aria-label="' + esc(ch.title) + '" ' +
            'style="--cv:' + candy(i) + ';--rot-base:' + sc[0] + 'deg;--dy-base:' + sc[1] + 'px;' +
            '--rot:' + sc[0] + 'deg;--dy:' + sc[1] + 'px;animation-delay:' + Math.min(i, 11) * 45 + 'ms" ' +
            'title="' + esc(ch.title) + '">' +
            (art ? '<img class="av-art" src="' + esc(art) + '" alt="" loading="lazy" decoding="async">' : '') +
            flags +
            avpBar(item) +
            (vol ? '<span class="av-num">' + esc(vol) + '</span>' : '') +
            /* ★ round73：标题从「压在封面中央的 19px Arial Black」移到封面下方。
               原来的绝对定位(top:58px)会盖住封面主体，破坏「看封面认作品」这个核心动作。
               顺手把 .av-sub 从「写死黑底药丸」改成普通文字行 —— 那个 #000 底在浅色卡上不可读。 */
            '<div class="av-cap">' +
              '<span class="av-title">' + esc(ch.title) + '</span>' +
              '<div class="av-sub"><b>' + esc(isNovel ? ('第 ' + (vol || '?') + ' 卷') : (ch.no ? 'No.' + ch.no : '')) + '</b>' +
              '<span>' + mb(item.fileSize) + '</span></div>' +
            '</div>' +
            '<div class="av-cta" data-av-open="1">' + cta + '<span class="arr">→</span></div>' +
            '</div>';
    }

    /* ---------- 海报卡（猜你喜欢，有海报）----------
       2026-09-21：卡片升级为「小兔子」形态 ——
       · 每张卡自带一个糖果色面板（--bunny），耳朵 / 尾巴与面板同色
       · 悬停时耳朵从卡片顶部"长出来"、尾巴从底部弹出来（参考站同款缓动） */
    function posterCard(m, i) {
        var sc = scatter(i);
        var poster = '';
        try { if (typeof getPosterUrl === 'function') poster = getPosterUrl(m) || ''; } catch (e) { /* 忽略 */ }
        var title = m.title || m.fileName || '未知影片';
        var meta = [m.avid || '', (m.playCount || 0) > 0 ? '▶ ' + m.playCount : '']
            .filter(Boolean).join(' · ');
        var bunny = candy(i);
        return '<article class="av-card wide" data-av-id="' + esc(m.id) + '" tabindex="0" role="button" ' +
            'aria-label="' + esc(title) + '" ' +
            'style="--rot-base:' + sc[0] + 'deg;--dy-base:' + sc[1] + 'px;' +
            '--rot:' + sc[0] + 'deg;--dy:' + sc[1] + 'px;--bunny:' + bunny + ';' +
            'animation-delay:' + Math.min(i, 11) * 45 + 'ms">' +
            bunnyEars(bunny) +
            '<div class="av-cover">' +
            (poster ? '<img src="' + esc(poster) + '" alt="' + esc(title) + '" loading="lazy" draggable="false">' : '') +
            '<div class="av-cta">▶ 播放<span class="arr">→</span></div>' +
            '</div>' +
            bunnyTail(bunny) +
            '<div class="av-cap"><b>' + esc(title) + '</b>' +
            (meta ? '<span>' + esc(meta) + '</span>' : '') +
            '</div>' +
            '</article>';
    }

    /* ---------- 英雄区（2026-09-22 第三版：无背景 + 水波纹） ----------
       用户反馈：棕色大 blob 太难看 → 背景整个去掉，只留文字浮在页面上。
       鼠标划过出现真实水波纹：二维高度场模拟（经典双缓冲波动方程），
       渲染成明暗相间的涟漪叠加在文字底下。
       性能铁律（本项目出过 rAF 正反馈死循环）：
       · 模拟循环只在「有能量」时运行，波纹衰减到阈值以下就停 rAF、清 canvas
       · pointermove 只负责注水 + 唤醒，interval 造的雨滴只在悬停期间存在
       · 模拟分辨率上限 420px 宽，渲染时放大 → 既柔和又省 CPU */
    function hero(opts) {
        return '<div class="av-hero">' +
            '<canvas class="av-ripple" aria-hidden="true"></canvas>' +
            '<div class="av-kicker">' + esc(opts.kicker) + '</div>' +
            '<h2>' + esc(opts.title) + '</h2>' +
            '<p class="av-sub"><span class="av-hand">' + esc(opts.hand) + '</span></p>' +
            (opts.chips && opts.chips.length ?
                '<div class="av-chiprow">' + opts.chips.map(function (c, i) {
                    return '<button class="av-chip' + (c[3] || '') + (i === 0 ? ' on' : '') + '" data-av-filter="' + esc(c[2]) + '">' +
                        esc(c[0]) + '<em>' + c[1] + '</em></button>';
                }).join('') + '</div>' : '') +
            '</div>';
    }

    function bindHeroMotion(root) {
        if (!root) return;
        var staticOK = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
        root.querySelectorAll('.av-hero').forEach(function (el) {
            if (el.__avHeroBound) return;
            el.__avHeroBound = true;
            if (staticOK) return;          // 减少动态：不启动水面
            initRipple(el);
        });
    }

    function initRipple(el) {
        var canvas = el.querySelector('.av-ripple');
        if (!canvas || !canvas.getContext) return;
        var ctx = canvas.getContext('2d');

        var SIM_MAX_W = 420;               // 模拟分辨率上限
        var W = 0, H = 0, buf1 = null, buf2 = null, img = null;
        var raf = 0, idleFrames = 0, running = false;
        var rainTimer = 0;

        /* 明暗两色从 CSS 变量读（theme-v4.css 按皮肤给值），格式 "r,g,b" */
        var cs = getComputedStyle(el);
        function cssRGB(name, fallback) {
            var v = (cs.getPropertyValue(name) || '').trim();
            var p = v.split(',').map(function (n) { return parseFloat(n) || 0; });
            return (p.length >= 3) ? p : fallback.split(',').map(Number);
        }
        var lightRGB = cssRGB('--ripple-light', '255,255,255');
        var darkRGB = cssRGB('--ripple-dark', '96,74,40');

        function size() {
            var r = el.getBoundingClientRect();
            if (!r.width || !r.height) return false;
            var scale = Math.min(1, SIM_MAX_W / r.width);
            W = Math.max(32, Math.round(r.width * scale));
            H = Math.max(24, Math.round(r.height * scale));
            canvas.width = W; canvas.height = H;
            buf1 = new Float32Array(W * H);
            buf2 = new Float32Array(W * H);
            img = ctx.createImageData(W, H);
            return true;
        }

        function drop(x, y, strength, radius) {
            if (!buf1) return;
            var r = radius || 2;
            for (var dy = -r; dy <= r; dy++) {
                for (var dx = -r; dx <= r; dx++) {
                    var xx = x + dx, yy = y + dy;
                    if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) continue;
                    if (dx * dx + dy * dy > r * r) continue;
                    buf1[yy * W + xx] += strength;
                }
            }
        }

        function step() {
            for (var y = 1; y < H - 1; y++) {
                var row = y * W;
                for (var x = 1; x < W - 1; x++) {
                    var i = row + x;
                    var v = (buf1[i - 1] + buf1[i + 1] + buf1[i - W] + buf1[i + W]) * 0.5 - buf2[i];
                    buf2[i] = v * 0.968;        // 阻尼：每帧衰减 ~3%，几秒内必然平息（rAF 能停下来）
                }
            }
            var t = buf1; buf1 = buf2; buf2 = t;
        }

        function render() {
            var d = img.data;
            var peak = 0;
            for (var y = 1; y < H - 1; y++) {
                var row = y * W;
                for (var x = 1; x < W - 1; x++) {
                    var i = row + x;
                    var s = (buf1[i - 1] - buf1[i + 1]) + (buf1[i - W] - buf1[i + W]);
                    var a = s < 0 ? -s : s;
                    if (a > peak) peak = a;
                    var p = i * 4;
                    if (a < 0.35) { d[p + 3] = 0; continue; }
                    if (a > 255) a = 255;
                    d[p + 3] = a;
                    if (s < 0) {        // 波谷 → 暗色；波峰 → 亮色
                        d[p] = darkRGB[0]; d[p + 1] = darkRGB[1]; d[p + 2] = darkRGB[2];
                    } else {
                        d[p] = lightRGB[0]; d[p + 1] = lightRGB[1]; d[p + 2] = lightRGB[2];
                    }
                }
            }
            ctx.putImageData(img, 0, 0);
            return peak;
        }

        function frame() {
            raf = 0;
            step();
            var peak = render();
            if (peak < 1.4) {
                // 能量耗尽 → 停循环清画面（绝不自续）
                idleFrames++;
                if (idleFrames < 3) { raf = requestAnimationFrame(frame); return; }
                ctx.clearRect(0, 0, W, H);
                running = false;
                return;
            }
            idleFrames = 0;
            raf = requestAnimationFrame(frame);
        }

        function wake() {
            if (running) return;
            running = true;
            idleFrames = 0;
            if (!raf) raf = requestAnimationFrame(frame);
        }

        function toSim(e) {
            var r = canvas.getBoundingClientRect();
            return [Math.round((e.clientX - r.left) / r.width * W),
                    Math.round((e.clientY - r.top) / r.height * H)];
        }

        el.addEventListener('pointerenter', function (e) {
            if (!W && !size()) return;
            var p = toSim(e);
            drop(p[0], p[1], 420, 3);
            wake();
            if (!rainTimer) {
                // 悬停期间偶有雨滴，水面才有「活」的感觉；离开即停
                rainTimer = setInterval(function () {
                    drop(2 + Math.floor(Math.random() * (W - 4)),
                         2 + Math.floor(Math.random() * (H - 4)), 380, 2);
                    wake();
                }, 850);
            }
        });
        el.addEventListener('pointermove', function (e) {
            if (!W && !size()) return;
            var p = toSim(e);
            drop(p[0], p[1], 260, 2);
            wake();
        });
        el.addEventListener('pointerleave', function () {
            if (rainTimer) { clearInterval(rainTimer); rainTimer = 0; }
        });

        window.addEventListener('resize', function () {
            // 尺寸变了就重建水面（简单可靠；hero 随视图重渲染本来也会重建）
            if (rainTimer) { clearInterval(rainTimer); rainTimer = 0; }
            running = false;
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            W = 0;
            ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
        });
    }

    /* ============================================================
       漫画 / 小说：树层渲染
       app.js renderTreeLibrary 在有 items 或 children 时调用本函数，
       返回 true 表示已接管渲染；返回 false 由 app.js 走旧网格兜底。
       2026-09-22：布局改为左右分栏 —— 左列常驻「根目录-子文件夹-文件」树，
       右侧是文件清单，右上是阅读统计图表（app.js loadReadingStatsInto 填充）。
       ============================================================ */

    /* —— 左侧树（数据来自 app.js 的 comicTree / novelTree，全量在前端）—— */
    function buildTreePanel(type) {
        var st = (typeof getTreeState === 'function') ? getTreeState(type) : { tree: null, path: '' };
        var html = '<aside class="av-tree"><div class="avt-head">' +
            (type === 'novel' ? '📚 小说库' : '📁 漫画库') + '</div>';
        html += avtNode(type, st.tree, '', st.path || '', true);
        html += '</aside>';
        return html;
    }

    function avtNode(type, node, path, currentPath, isRoot) {
        if (!node) return '';
        var name = isRoot ? '根目录' : (node.name || '未命名');
        var hasKids = node.children && node.children.length;
        var count = (typeof countItemsInFolder === 'function') ? countItemsInFolder(node) : 0;
        var isCurrent = path === currentPath;
        var isAncestor = !isCurrent && path !== '' && currentPath.indexOf(path + '/') === 0;
        var open = isCurrent || isAncestor || isRoot;
        var h = '<div class="avt-node' + (open ? ' open' : '') + '">' +
            '<div class="avt-row' + (isCurrent ? ' cur' : '') + '" data-avt-go="' + esc(path) + '">' +
            (hasKids ? '<span class="avt-arrow" data-avt-toggle="1">▸</span>' : '<span class="avt-leaf"></span>') +
            '<span class="avt-name">' + esc(name) + '</span>' +
            '<span class="avt-n">' + count + '</span></div>';
        if (hasKids) {
            h += '<div class="avt-kids">' + node.children.map(function (c) {
                var cp = c.path || (path ? path + '/' + c.name : c.name);
                return avtNode(type, c, cp, currentPath, false);
            }).join('') + '</div>';
        }
        /* ★ round73：当前层的文件改为**默认折叠**。
           原来无脑铺开 —— 「日月同错」一个分类下 178 个 PDF，实测左栏溢出 4781px
           （视口高度的 6.9 倍），名字还被 ellipsis 截断，是「排版难看」的主要来源。
           现在只给一个「展开本层文件」的入口，点开才铺。 */
        if (isCurrent && node.items && node.items.length) {
            h += '<div class="avt-files-wrap" data-avt-files="1">' +
                '<div class="avt-files-btn" data-avt-files-toggle="1">展开本层文件（' + node.items.length + '）</div>' +
                '<div class="avt-kids avt-files" hidden>' + node.items.map(function (it) {
                var t = itemTitle(it);
                if (type !== 'novel' && NOTICE_RE.test(t)) return '';
                return '<div class="avt-row avt-file" data-avt-id="' + esc(it.id) + '" title="' + esc(t) + '">' +
                    '<span class="avt-leaf"></span><span class="avt-name">' + esc(t) + '</span></div>';
            }).join('') + '</div></div>';
        }
        return h + '</div>';
    }

    function bindTreePanel(grid, type) {
        var panel = grid.querySelector('.av-tree');
        if (!panel) return;
        panel.querySelectorAll('[data-avt-toggle]').forEach(function (arr) {
            arr.addEventListener('click', function (e) {
                e.stopPropagation();          // 只展开/收起，不下钻
                var nd = arr.closest('.avt-node');
                if (nd) nd.classList.toggle('open');
            });
        });
        panel.querySelectorAll('[data-avt-go]').forEach(function (row) {
            row.addEventListener('click', function () {
                if (typeof enterTreeFolder === 'function') enterTreeFolder(type, row.getAttribute('data-avt-go'));
            });
        });
        panel.querySelectorAll('[data-avt-id]').forEach(function (row) {
            row.addEventListener('click', function () {
                var id = parseInt(row.getAttribute('data-avt-id'), 10);
                if (Number.isFinite(id) && typeof showMovieDetail === 'function') showMovieDetail(id);
            });
        });
    }

    function folderCardView(child, i) {
        var count = typeof countItemsInFolder === 'function' ? countItemsInFolder(child) : 0;
        var name = child.name || '未命名文件夹';
        return '<div class="av-folder" data-av-path="' + esc(child.path || child.name || '') + '" tabindex="0" role="button" ' +
            'style="--cv:' + candy(i + 2) + ';animation-delay:' + Math.min(i, 8) * 40 + 'ms">' +
            '<span class="af-glyph">' + esc(name.slice(0, 1)) + '</span>' +
            '<span class="af-name">' + esc(name) + '</span>' +
            '<span class="af-count">' + count + ' 部作品 →</span></div>';
    }

    /**
     * 渲染一层树。folders 用粉彩卡片，items 用散落卡（漫画 slider / 小说展台）。
     * @returns {boolean} 是否接管了渲染
     */
    /* ================= round73 · 阅读进度 ================= */
    /* 批量 map：树卡渲染时一次拉全，卡片本身不再单独请求。
       ★ fetch 必须自带 catch —— app.js:2970-2982 那个 catch 一旦被冒泡触发，
         整个 AvBoard 会被弃用退回旧网格（比不加进度更糟）。 */
    var avProgressMap = null;
    var avProgressBusy = false;
    /* round75b：根级系列胶囊的请求序号 —— 防止快速切目录/切视图时旧响应覆盖新视图 */
    var rootSeriesSeq = 0;
    function ensureAvProgress(type, done) {
        if (avProgressMap) { if (done) done(); return; }
        if (avProgressBusy) return;
        avProgressBusy = true;
        var kind = type === 'novel' ? 'novel' : 'comic';
        try {
            fetch('/api/media/progress-map?type=' + kind)
                .then(function (r) { return r.json(); })
                .then(function (j) { if (j && j.code === 0) avProgressMap = j.data || {}; })
                .catch(function () { /* 进度拿不到就不画角标，绝不冒泡 */ })
                .then(function () { avProgressBusy = false; if (done) done(); });
        } catch (e) {
            avProgressBusy = false;
            if (done) done();
        }
    }

    /* 列数 = min(卡片数, 按「容器宽 / (180 最小卡宽 + 18 gap)」算出的可用轨数)。
       两头都要夹：卡片少了要夹到卡片数（否则右侧空一大片），
       卡片多了不能超过可用轨数（否则卡被压到 29px 宽）。
       ⚠️ 网格是 minmax(180px,1fr)，auto-fill 在宽屏下会算出 7 轨放 5 张卡，
          所以这个夹紧是必需的，不是优化。 */
    function applyAvCols(board) {
        if (!board) return;
        var n = board.querySelectorAll('.av-card').length;
        if (!n) return;
        var gap = 18, minc = 180;
        var w = board.clientWidth || 0;
        var max = w > 0 ? Math.max(1, Math.floor((w + gap) / (minc + gap))) : 6;
        board.style.setProperty('--av-cols', String(Math.max(1, Math.min(n, max))));
    }
    /* 窗口尺寸变化后要**重新算**，不能只是把 --av-cols 清掉 ——
       清掉会回落到 auto-fill，小库（5 张）在宽屏下又变成 7 轨、右侧空一片。 */
    var __avColsResize = null;
    window.addEventListener('resize', function () {
        if (__avColsResize) clearTimeout(__avColsResize);
        __avColsResize = setTimeout(function () {
            document.querySelectorAll('.av-board').forEach(applyAvCols);
        }, 220);
    });

    function avpOf(item) {
        var pr = (avProgressMap && item) ? avProgressMap[item.id] : null;
        if (pr) return pr;
        // 没有进度记录时回落 watched（影视老数据 / 用户手动标过的）
        if (item && item.watched === 1) return { p: 100, s: 'done', c: 0, t: 0 };
        return null;
    }

    /** 右上角状态角标 */
    function avpBadges(item) {
        var pr = avpOf(item);
        if (!pr) return '<span class="avp-flag avp-unread" title="未读"></span>';
        if (pr.s === 'done') return '<span class="avp-flag avp-done" title="已读完">✓</span>';
        if (pr.s === 'shelved') return '<span class="avp-flag avp-shelved" title="已搁置">⏸</span>';
        if (pr.p > 0) {
            return '<span class="avp-flag avp-reading" title="已读 ' + pr.p + '%">'
                + (item.type === 'novel' ? '第' + (pr.c + 1) + '章' : pr.p + '%') + '</span>';
        }
        return '<span class="avp-flag avp-unread" title="未读"></span>';
    }

    /** 底部细进度线（复用影视库 .card-progress，纯 CSS 变量驱动） */
    function avpBar(item) {
        var pr = avpOf(item);
        if (!pr || pr.s !== 'reading' || !(pr.p > 0)) return '';
        return '<div class="card-progress" style="--p:' + pr.p + '%"></div>';
    }
    /* =============== round73 · 阅读进度 =============== */

    function renderTreeLevel(type, node, pathName) {
        /* round73：先把进度 map 拉回来（首次会有一次重渲） */
        if (!avProgressMap) {
            var __n = node, __t = type, __p = pathName;
            ensureAvProgress(type, function () { try { renderTreeLevel(__t, __n, __p); } catch (e) {} });
        }
        var grid = document.getElementById('movieGrid');
        if (!grid || !node) return false;

        var children = node.children || [];
        var items = node.items || [];
        if (!children.length && !items.length) return false;

        var isNovel = type === 'novel';
        var chapters = items.filter(function (it) {
            return isNovel || !NOTICE_RE.test(itemTitle(it));
        });
        var arcs = (!isNovel && chapters.length >= 12) ? detectArcs(chapters) : [];

        /* round75：系列聚类 —— 同名（相似度 ≥80%）作品归到系列名下。
           seriesMap: 系列名 → 成员数组；供系列胶囊 + 摞卡展开。 */
        var seriesMap = (window.SeriesUI ? window.SeriesUI.groupItems(chapters, itemTitle) : new Map());
        var seriesFilter = '';

        // 英雄区：根层显示库名，子层显示所在文件夹
        var placeName = pathName || (isNovel ? '小说库' : '漫画库');
        // 只有当前层有正片时才给筛选芯片；纯文件夹层芯片无意义
        var chips = [];
        if (chapters.length) {
            chips.push(['全部', chapters.length, 'all', ' dark']);
            if (arcs.length) {
                arcs.forEach(function (a) { chips.push([a[0] + '篇', a[1], 'arc:' + a[0], '']); });
            }
            if (!isNovel && chapters.length > 24) {
                chips.splice(1, 0, ['最新', Math.min(24, chapters.length), 'latest', '']);
            }
        }

        var handText;
        if (chapters.length) {
            handText = isNovel
                ? ('共 ' + chapters.length + ' 卷，epub 原档')
                : ('共 ' + chapters.length + ' 回正片' + (items.length - chapters.length ? '（另有 ' + (items.length - chapters.length) + ' 条公告）' : ''));
        } else {
            handText = '共 ' + children.length + ' 个系列，点进去翻';
        }

        var h = '<div class="av-view av-workspace">' + buildTreePanel(type) +
            '<div class="av-main"><div class="av-main-top">' + hero({
                kicker: isNovel ? 'SHELF · NOVEL' : 'SHELF · COMIC',
                title: placeName,
                hand: handText,
                chips: chips
            }) +
            '</div>' +   /* ← hero 行到此结束，统计卡不再挤在 flex 里 */
            /* ★ round73：统计卡升为独立列。原来它和 hero 挤在同一个 flex 行，
               固定 262px 宽 —— 1440px 视口下 hero 只剩约 232px，标题被压到换行错位。 */
            /* round75：系列胶囊行（有系列才显示），点胶囊筛选该系列全部本 */
            '<div class="av-series-row" id="avSeriesRow" style="display:none;"></div>' +
            '<div class="av-stats" id="avStatsSlot"></div>';

        // 文件夹卡片（下钻入口，保持原树逻辑）
        if (children.length) {
            h += '<div class="av-board" style="padding-top:22px">' +
                children.map(function (c, i) { return folderCardView(c, i); }).join('') + '</div>';
        }

        // 作品卡片区
        /* round78：根层可能 chapters 为空（只有文件夹卡），但系列胶囊点击后要把成员
           铺进 shelf —— 所以 #avShelf 一律建出来，转场容器由 ensureSlide() 填充。 */
        h += '<div id="avShelf"></div>';
        h += '</div></div>';

        grid.innerHTML = h;
        bindHeroMotion(grid);
        bindTreePanel(grid, type);
        if (typeof window.loadReadingStatsInto === 'function') {
            window.loadReadingStatsInto(type, document.getElementById('avStatsSlot'));
        }

        var shelf = document.getElementById('avShelf');

        /* round78：Page side-by-side 转场容器 —— 摞卡页(page1) ⇄ 系列展开页(page2) 并存，
           data-page 切换，page1 向左退出 / page2 向右退出。首次调用时建壳。
           注意：根层系列胶囊那条异步链路会在 chapters 为空时**动态创建** #avShelf，
           而上面的 var shelf 是提前捕获的旧引用 —— 所以这里一律走惰性查询。 */
        function ensureSlide() {
            if (!window.SeriesUI) return null;
            var host = document.getElementById('avShelf');
            if (!host) {
                var row = document.getElementById('avSeriesRow');
                if (!row) return null;
                host = document.createElement('div');
                host.id = 'avShelf';
                row.parentNode.insertBefore(host, row.nextSibling);
            }
            var s = host.querySelector('.t-page-slide');
            if (!s) {
                host.innerHTML = window.SeriesUI.slideWrap('board', '', '', '1');
                s = host.querySelector('.t-page-slide');
            }
            return s;
        }

        function renderShelf(filter) {
            var list = chapters;
            var isSeriesView = false;
            if (filter && filter.indexOf('arc:') === 0) {
                var arc = filter.slice(4);
                list = chapters.filter(function (it) { return arcOf(it) === arc; });
            } else if (filter === 'latest') {
                list = chapters.slice(-24);
            } else if (filter && filter.indexOf('series:') === 0) {
                /* round75：系列展开 —— 显示该系列全部本（不摞卡） */
                list = (seriesMap.get(filter.slice(7)) || []).slice();
                isSeriesView = true;
            }
            if (!list.length) {
                /* round78：空态写进 page1 内部，别覆盖掉转场容器 ——
                   否则根层「只有文件夹卡」时容器被抹掉，系列胶囊再点就没地方铺成员了。 */
                var host0 = document.getElementById('avShelf') || shelf;
                if (host0) {
                    var sl0 = ensureSlide();
                    var pg0 = sl0 && sl0.querySelector('.t-page[data-page="1"]');
                    if (pg0) { pg0.innerHTML = '<div class="av-empty"><div class="ico">📂</div>这个筛选下暂时没有内容</div>'; }
                    else host0.innerHTML = '<div class="av-empty"><div class="ico">📂</div>这个筛选下暂时没有内容</div>';
                }
                return;
            }

            /* round75：非系列展开视图里，同系列 ≥2 本的渲染成一张摞卡（点开展开） */
            var cardsHtml;
            if (!isSeriesView && window.SeriesUI && seriesMap.size) {
                var consumed = new Set();
                var parts = [];
                list.forEach(function (it) {
                    if (consumed.has(it)) return;
                    var sname = null;
                    seriesMap.forEach(function (members, name) {
                        if (!sname && members.indexOf(it) >= 0) sname = name;
                    });
                    if (sname) {
                        var members = seriesMap.get(sname);
                        members.forEach(function (m) { consumed.add(m); });
                        parts.push(window.SeriesUI.stackWrap(sname, members.length, textCard(it, type, 0)));
                    } else {
                        consumed.add(it);
                        parts.push(textCard(it, type, parts.length));
                    }
                });
                cardsHtml = parts.join('');
            } else {
                cardsHtml = list.map(function (it, i) { return textCard(it, type, i); }).join('');
            }

            /* round78：内容写进对应的那一页，而不是整块重渲染 */
            var slide = ensureSlide();
            var targetPage = isSeriesView ? '2' : '1';
            var pageEl = slide && slide.querySelector('.t-page[data-page="' + targetPage + '"]');
            if (!pageEl) {                 // 无转场能力（SeriesUI 缺失）→ 原路径
                pageEl = shelf;
            } else {
                pageEl.hidden = false;     // 先显示，否则 applyAvCols 量不到宽度
            }

            /* ★ round73：取消「>10 条走横向 slider」分支，统一网格。
               原因（实测）：slider 分支的 shelf.innerHTML 直接写 .av-slider、
               **不存在 .av-board 这个类** ⇒ round14.css:90 那条
               「auto-fill 网格修留白」的覆盖对 169+ 张的漫画库一直完全无效，
               始终是 196px 固定宽横排（scrollWidth 36860px，可发现性是灾难）。
               .av-slider / bindSlider 的代码全部保留，用户仍可用 data-av-shelf="slider" 切回。 */
            var useSlider = (window.__avShelfMode === 'slider') && !isNovel && list.length > 10;
            if (false) {
                pageEl.innerHTML =
                    '<div class="av-slider-wrap">' +
                    '<button class="av-slide-nav prev" type="button" aria-label="向左翻">‹</button>' +
                    '<div class="av-slider">' + cardsHtml + '</div>' +
                    '<button class="av-slide-nav next" type="button" aria-label="向右翻">›</button>' +
                    '</div>' +
                    '<div class="av-slide-foot">' +
                    '<span class="av-slide-count">共 ' + list.length + ' 回</span>' +
                    '<span class="av-slide-tip">按住拖动 / 滚轮 / 点两侧 ‹ › 都能翻</span>' +
                    '</div>';
            } else if (useSlider) {
                pageEl.innerHTML =
                    '<div class="av-slider-wrap">' +
                    '<button class="av-slide-nav prev" type="button" aria-label="向左翻">‹</button>' +
                    '<div class="av-slider">' + cardsHtml + '</div>' +
                    '<button class="av-slide-nav next" type="button" aria-label="向右翻">›</button>' +
                    '</div>' +
                    '<div class="av-slide-foot">' +
                    '<span class="av-slide-count">共 ' + list.length + ' 回</span>' +
                    '<span class="av-slide-tip">按住拖动 / 滚轮 / 点两侧 ‹ › 都能翻</span>' +
                    '</div>';
            } else {
                pageEl.innerHTML = '<div class="av-board">' + cardsHtml + '</div>';
                /* ★ round73：列数夹到「卡片数」——
                   repeat(auto-fill,·) 生成的轨道数常常多于卡片数（小说 5 本在 1920px 下
                   生成 7 轨、1280px 下 4 轨放 5 张），末行会空出一大片随机空档。
                   先量自适应轨道数，再 min(卡片数, 轨数) 夹住，孤儿行就没了。 */
                try { applyAvCols(pageEl.querySelector('.av-board')); } catch (e) {}
            }
            bindCards(pageEl, type);
            bindSlider(pageEl);
            /* round75：摞卡点击 → 展开该系列（拦截在卡片自身 click 之前）
               round78：不再重渲染，走转场切到 page2 */
            if (window.SeriesUI) window.SeriesUI.bindStacks(pageEl, function (name) {
                seriesFilter = name;
                renderSeriesChips(name);
                grid.querySelectorAll('[data-av-filter]').forEach(function (x) { x.classList.remove('on'); });
                renderShelf('series:' + name);
            });
            if (slide) window.SeriesUI.slideTo(slide, targetPage);
        }

        /* 横向书架的翻页手段（2026-09-22 新增）
           背景：169 回 = scrollWidth 36860px，而视口只有 1316px。
           桌面鼠标原本只能拖底部那条 8px 细滚动条 → 后面章节够不到。
           这里三种手段并存：两侧按钮 / 竖向滚轮转横滚 / 按住拖动。 */
        function bindSlider(root) {
            var wrap = root.querySelector('.av-slider-wrap');
            var slider = root.querySelector('.av-slider');
            if (!wrap || !slider) return;

            var prevBtn = wrap.querySelector('.av-slide-nav.prev');
            var nextBtn = wrap.querySelector('.av-slide-nav.next');

            function pageStep() {
                // 一次翻 85% 可视宽度，留一点重叠便于对位
                return Math.max(240, Math.round(slider.clientWidth * 0.85));
            }

            function sync() {
                var max = slider.scrollWidth - slider.clientWidth;
                var scrollable = max > 1;
                var atStart = slider.scrollLeft <= 1;
                var atEnd = slider.scrollLeft >= max - 1;
                if (prevBtn) prevBtn.disabled = atStart;
                if (nextBtn) nextBtn.disabled = !scrollable || atEnd;
                wrap.classList.toggle('can-prev', scrollable && !atStart);
                wrap.classList.toggle('can-next', scrollable && !atEnd);
            }

            if (prevBtn) prevBtn.addEventListener('click', function () {
                slider.scrollBy({ left: -pageStep(), behavior: 'smooth' });
            });
            if (nextBtn) nextBtn.addEventListener('click', function () {
                slider.scrollBy({ left: pageStep(), behavior: 'smooth' });
            });

            /* 竖向滚轮 → 横向滚动；滚到头就把事件交还页面，避免把用户困在书架里 */
            slider.addEventListener('wheel', function (e) {
                if (e.ctrlKey || e.metaKey || e.shiftKey) return;   // 缩放 / 浏览器原生横滚，不抢
                var d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
                if (!d) return;
                var max = slider.scrollWidth - slider.clientWidth;
                if (max <= 1) return;
                var atStart = slider.scrollLeft <= 0;
                var atEnd = slider.scrollLeft >= max - 1;
                if ((d < 0 && atStart) || (d > 0 && atEnd)) return;  // 到头 → 让页面滚
                e.preventDefault();
                slider.scrollLeft += d;
            }, { passive: false });

            /* 按住拖动（触摸设备交给原生惯性滚动，不拦） */
            var drag = null;
            var moved = 0;
            var suppressClick = false;

            slider.addEventListener('pointerdown', function (e) {
                if (e.pointerType === 'touch' || e.button !== 0) return;
                drag = { x: e.clientX, left: slider.scrollLeft, pid: e.pointerId };
                moved = 0;
            });

            slider.addEventListener('pointermove', function (e) {
                if (!drag) return;
                var dx = e.clientX - drag.x;
                if (Math.abs(dx) > moved) moved = Math.abs(dx);
                if (moved <= 4) return;
                if (!slider.classList.contains('dragging')) {
                    slider.classList.add('dragging');
                    /* ⚠️ 不能在 pointerdown 就 setPointerCapture：
                       一旦捕获，浏览器会把之后的 click 重定向到 slider 本身，
                       卡片上的 click 永远不触发 → 「漫画点了没反应」。
                       只有真正拖起来（位移 > 4px）才捕获。 */
                    try { slider.setPointerCapture(drag.pid); } catch (err) { /* 忽略 */ }
                }
                slider.scrollLeft = drag.left - dx;
                e.preventDefault();
            });

            function endDrag() {
                if (!drag) return;
                if (moved > 4) {
                    // 刚拖完就把这次 click 吞掉，否则松手会误进详情
                    suppressClick = true;
                    setTimeout(function () { suppressClick = false; }, 90);
                }
                drag = null;
                slider.classList.remove('dragging');
            }
            slider.addEventListener('pointerup', endDrag);
            slider.addEventListener('pointercancel', endDrag);

            // 捕获阶段拦掉「拖完松手」那一次 click
            slider.addEventListener('click', function (e) {
                if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
            }, true);

            slider.addEventListener('scroll', sync, { passive: true });
            window.addEventListener('resize', sync);
            sync();
        }

        /* ★ round73：加 type 参数，才能知道 CTA 该开漫画还是小说阅读器 */
        function bindCards(root, type) {
            // 封面加载失败（缓存文件被清 / 远程图 404）→ 退回糖果色卡，别留个破图
            root.querySelectorAll('.av-art').forEach(function (img) {
                img.addEventListener('error', function () {
                    var c = img.closest ? img.closest('.av-card') : null;
                    if (c) c.classList.remove('has-art');
                    img.remove();
                });
            });
            root.querySelectorAll('.av-card').forEach(function (card) {
                var open = function () {
                    var id = parseInt(card.getAttribute('data-av-id'), 10);
                    if (!Number.isFinite(id)) return;
                    /* ★ round73：点 CTA 药丸 = 真的「继续阅读」。
                       原来这里没区分 CTA 与卡片，事件直接冒泡到卡片 → 打开详情，
                       那个「继续阅读 →」其实是个假按钮，点了什么都不会发生。 */
                    if (arguments.length && arguments[0] && arguments[0].target
                        && arguments[0].target.closest && arguments[0].target.closest('[data-av-open]')) {
                        if (type === 'novel') { if (typeof openNovelReader === 'function') return openNovelReader(id); }
                        else { if (typeof openComicReader === 'function') return openComicReader(id); }
                    }
                    if (typeof showMovieDetail === 'function') showMovieDetail(id);
                };
                card.addEventListener('click', open);
                card.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
                });
            });
        }

        // 文件夹下钻（复用 app.js 的树导航）
        grid.querySelectorAll('.av-folder').forEach(function (el) {
            var go = function () {
                if (typeof enterTreeFolder === 'function') enterTreeFolder(type, el.getAttribute('data-av-path'));
            };
            el.addEventListener('click', go);
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
            });
        });

        // 芯片真筛选
        grid.querySelectorAll('[data-av-filter]').forEach(function (chip) {
            chip.addEventListener('click', function () {
                grid.querySelectorAll('[data-av-filter]').forEach(function (x) { x.classList.remove('on'); });
                chip.classList.add('on');
                seriesFilter = '';
                renderSeriesChips('');
                renderShelf(chip.getAttribute('data-av-filter'));
            });
        });

        /* round75：系列胶囊渲染 + 点击筛选（再点同一个 = 取消） */
        function renderSeriesChips(active) {
            var row = document.getElementById('avSeriesRow');
            if (!row) return;
            if (!window.SeriesUI || !seriesMap.size) { row.style.display = 'none'; return; }
            row.style.display = 'flex';
            row.innerHTML = window.SeriesUI.capsuleRow(seriesMap, active || '');
            row.querySelectorAll('.av-scap').forEach(function (b) {
                b.addEventListener('click', function () {
                    var name = b.getAttribute('data-series');
                    seriesFilter = (seriesFilter === name) ? '' : name;
                    renderSeriesChips(seriesFilter);
                    grid.querySelectorAll('[data-av-filter]').forEach(function (x) {
                        x.classList.toggle('on', !seriesFilter && x.getAttribute('data-av-filter') === 'all');
                    });
                    renderShelf(seriesFilter ? 'series:' + name : 'all');
                });
            });
        }
        renderSeriesChips('');

        /* round75b：根级系列胶囊 —— 根层只有文件夹卡（children），本地 groupItems
           聚不出来；改从服务端 serial 聚合拿全库系列（/api/movie/series，跨文件夹），
           点胶囊拉成员明细（/api/movie/series/items）铺成卡片。子文件夹层仍走本地 seriesMap。 */
        if (!pathName && window.SeriesUI) {
            (function () {
                var mySeq = ++rootSeriesSeq;
                fetch('/api/movie/series?types=' + encodeURIComponent(type))
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        var list = (j && j.code === 0 && j.data) || [];
                        if (mySeq !== rootSeriesSeq || !list.length) return;
                        var row = document.getElementById('avSeriesRow');
                        if (!row || !row.isConnected) return;
                        row.style.display = 'flex';
                        row.innerHTML = window.SeriesUI.capsuleRowCounts(list, '');
                        row.querySelectorAll('.av-scap').forEach(function (b) {
                            b.addEventListener('click', function () {
                                var name = b.getAttribute('data-series');
                                var wasActive = b.classList.contains('active');
                                row.querySelectorAll('.av-scap').forEach(function (x) { x.classList.remove('active'); });
                                /* 再点同一个 = 取消，收起展开的系列卡 */
                                if (wasActive) {
                                    /* round78：切回摞卡页（page2 向右退出），而不是删掉整个 shelf */
                                    var slBack = ensureSlide();
                                    if (slBack) window.SeriesUI.slideTo(slBack, '1');
                                    renderSeriesChips('');
                                    return;
                                }
                                b.classList.add('active');
                                fetch('/api/movie/series/items?serial=' + encodeURIComponent(name) +
                                      '&types=' + encodeURIComponent(type))
                                    .then(function (r2) { return r2.json(); })
                                    .then(function (j2) {
                                        var items = (j2 && j2.code === 0 && j2.data) || [];
                                        if (!items.length || mySeq !== rootSeriesSeq) return;
                                        var rowNow = document.getElementById('avSeriesRow');
                                        if (!rowNow || !rowNow.isConnected) return;
                                        /* round78：写进 page2 并走转场，而不是直接重写整个 shelf。
                                           ⚠️ 根层（chapters 为空）时 #avShelf 尚未建 —— 必须先 ensureSlide()
                                           把容器造出来，不能在此之前就要求它存在。 */
                                        var sl = ensureSlide();
                                        var target = sl && sl.querySelector('.t-page[data-page="2"]');
                                        if (!target) return;
                                        target.hidden = false;
                                        target.innerHTML = '<div class="av-board">' +
                                            items.map(function (it, i) { return textCard(it, type, i); }).join('') + '</div>';
                                        try { applyAvCols(target.querySelector('.av-board')); } catch (e) {}
                                        bindCards(target, type);
                                        window.SeriesUI.slideTo(sl, '2');
                                    }).catch(function () {});
                            });
                        });
                    }).catch(function () {});
            })();
        }

        if (shelf) renderShelf('all');   // round78：#avShelf 现在恒存在，根层无章节时内部为空壳
        return true;
    }

    /* ============================================================
       猜你喜欢：散落展台（≥10 部，后端 limit 原本支持到 60）
       ============================================================ */

    var guessState = { movies: [], exclude: [], loading: false, privacy: 'exclude', seq: 0 };

    function fetchGuess(n) {
        var excl = guessState.exclude.slice(-150).join(',');
        // r44：口径参数化——公开展台 exclude（排 AV/里番），隐私内容组猜你喜欢传 adult（只取 AV/里番）
        return fetch('/api/recommend/guess?limit=' + n + (excl ? '&exclude=' + encodeURIComponent(excl) : '') + '&privacy=' + (guessState.privacy || 'exclude'))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var list = (d && d.data) || [];
                list.forEach(function (m) { if (m && guessState.exclude.indexOf(m.id) < 0) guessState.exclude.push(m.id); });
                return list;
            })
            .catch(function () { return []; });
    }

    function guessChips(movies) {
        var high = movies.filter(function (m) { return (m.score || 0) >= 4; }).length;
        var seen = movies.filter(function (m) { return m.watched === 1 || (m.playCount || 0) > 0; }).length;
        return [['全部', movies.length, 'all', ' dark'],
                ['高分', high, 'high', ''],
                ['看过的', seen, 'seen', ''],
                ['还没动', movies.length - seen, 'new', ' ink']];
    }

    function renderGuessBoard(filter) {
        var board = document.getElementById('avGuessBoard');
        if (!board) return;
        var list = guessState.movies;
        if (filter === 'high') list = list.filter(function (m) { return (m.score || 0) >= 4; });
        else if (filter === 'seen') list = list.filter(function (m) { return m.watched === 1 || (m.playCount || 0) > 0; });
        else if (filter === 'new') list = list.filter(function (m) { return !(m.watched === 1 || (m.playCount || 0) > 0); });

        if (!list.length) {
            board.innerHTML = '<div class="av-empty"><div class="ico">🎬</div>这个筛选下暂时没有影片</div>';
            return;
        }
        board.innerHTML = '<div class="av-board has-bunny">' +
            list.map(function (m, i) { return posterCard(m, i); }).join('') + '</div>';

        board.querySelectorAll('.av-card').forEach(function (card) {
            var id = parseInt(card.getAttribute('data-av-id'), 10);
            card.addEventListener('click', function (e) {
                // CTA 药丸 = 直接播放；卡片其他位置 = 详情抽屉
                if (e.target.closest && e.target.closest('.av-cta')) {
                    if (typeof playMovieInline === 'function') playMovieInline(id);
                    return;
                }
                if (typeof showMovieDetail === 'function') showMovieDetail(id);
            });
            card.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (typeof showMovieDetail === 'function') showMovieDetail(id);
                }
            });
        });
    }

    function openGuess(privacy, force) {
        var grid = document.getElementById('movieGrid');
        if (!grid) return;
        grid.classList.remove('tree-mode');

        // r44：口径参数化——换口径时清掉上一口径的排除表与旧数据，防止互串
        privacy = privacy || 'exclude';
        if (guessState.privacy !== privacy) {
            guessState.exclude = [];
            guessState.movies = [];
            force = true;                       // 换口径必须重取
        }
        guessState.privacy = privacy;
        var adult = privacy === 'adult';

        grid.innerHTML = '<div class="av-view">' + hero({
            kicker: '基于你的观看记录',
            title: '猜你喜欢',
            hand: '正在照着你看过的那几部挑……',
            chips: []
        }) + '<div class="av-empty"><div class="ico">✨</div>正在挑片…</div></div>';
        bindHeroMotion(grid);

        if (guessState.loading && !force) return;   // 同口径连点防抖（换口径/换视图由 force 破防）
        guessState.loading = true;
        // r44：序号令牌——openGuess 可被换口径/换视图重入，晚到的旧响应一律丢弃，
        // 防止「隐私口径的取数渲染进公开视图」（口径互串）
        var seq = ++guessState.seq;

        // 至少 10 部：直接向后端要 24（AI 不足时后端用随机池补齐，原本就有的行为）
        fetchGuess(24).then(function (movies) {
            if (seq !== guessState.seq) return;      // 过期响应：期间用户已换口径/换视图
            guessState.loading = false;
            if (!movies.length) {
                grid.innerHTML = '<div class="av-view"><div class="av-empty">' +
                    '<div class="ico">🎬</div>还没有可以推荐的影片，先扫描一些影片进来吧</div></div>';
                return;
            }
            guessState.movies = movies;
            grid.innerHTML = '<div class="av-view">' + hero({
                kicker: '基于你的观看记录',
                title: '猜你喜欢',
                hand: '这 ' + movies.length + ' 部，是照着你最近的口味挑的',
                chips: guessChips(movies)
            }) +
                '<p style="text-align:center;font-size:13px;font-weight:600;color:rgba(0,0,0,.55);margin:6px 0 0">' +
                '每张封面按「从架上随手抽出来」的角度摆放 —— 悬停回正，点桃红药丸直接播放。</p>' +
                '<div id="avGuessBoard"></div>' +
                '<div class="av-tools">' +
                '<button class="av-cta-btn" id="avGuessMore">换一批 ↻</button>' +
                /* r44：牌堆/列表两个模式视图是公开口径的视图名（guess-magic/guess-grid），
                 * 隐私口径下隐藏入口，防止跳过去口径错乱 */
                (adult ? '' :
                '<button class="av-circ gray" id="avGuessMagic" title="切换成牌堆模式">🃏</button>' +
                '<button class="av-circ" id="avGuessGrid" title="切换成列表模式">☰</button>') +
                '</div></div>';
            bindHeroMotion(grid);

            grid.querySelectorAll('[data-av-filter]').forEach(function (chip) {
                chip.addEventListener('click', function () {
                    grid.querySelectorAll('[data-av-filter]').forEach(function (x) { x.classList.remove('on'); });
                    chip.classList.add('on');
                    renderGuessBoard(chip.getAttribute('data-av-filter'));
                });
            });

            var more = document.getElementById('avGuessMore');
            if (more) more.addEventListener('click', function () {
                guessState.movies = [];
                openGuess(guessState.privacy);   // r44：保住当前口径
            });
            var magic = document.getElementById('avGuessMagic');
            if (magic) magic.addEventListener('click', function () {
                if (typeof switchView === 'function') switchView('guess-magic');
            });
            var gridBtn = document.getElementById('avGuessGrid');
            if (gridBtn) gridBtn.addEventListener('click', function () {
                if (typeof switchView === 'function') switchView('guess-grid');
            });

            renderGuessBoard('all');

            /* ★ r84：展台下方追加「更多可能 · 漂移长廊」。
             *   fetchGuess 的 exclude 表已记下展台这批 id，再取一批天然不重复；
             *   双轨对向自动漂移（样式在 motion-v2.css），悬停暂停、点封面开详情。 */
            fetchGuess(24).then(function (more) {
                if (seq !== guessState.seq) return;
                var tools = grid.querySelector('.av-tools');
                if (!tools || !more || !more.length) return;
                var card = function (m) {
                    return '<div class="mv-rail-card" data-mid="' + m.id + '" role="button" tabindex="0" title="' +
                        (window.escapeHtml ? window.escapeHtml(m.title || '') : '') + '">' +
                        '<div class="mrc-poster"><img src="' + window.getPosterUrl(m) + '" alt="" loading="lazy" decoding="async"></div>' +
                        '<div class="mrc-title">' + (window.escapeHtml ? window.escapeHtml(m.title || m.fileName || '') : '') + '</div></div>';
                };
                var track = function (list) {
                    var half = list.map(card).join('');
                    return '<div class="mv-rail-track">' + half + half + '</div>';
                };
                var rail = '<div class="guess-more-title">更多可能 · 继续逛</div>' +
                    '<div class="mv-rail">' + track(more) + '</div>';
                tools.insertAdjacentHTML('afterend', rail);
                grid.querySelectorAll('.mv-rail-card').forEach(function (c) {
                    c.addEventListener('click', function () {
                        var id = parseInt(c.dataset.mid, 10);
                        if (id && typeof showMovieDetail === 'function') showMovieDetail(id);
                    });
                });
            });
        });
    }

    /* ---------- 对外 ---------- */
    window.AvBoard = {
        openGuess: openGuess,
        renderTreeLevel: renderTreeLevel,
        version: '1.0'
    };
})();
