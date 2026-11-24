/* ============================================================
   round113-P3b · 详情弹窗「墨色跟随封面」 ink-follow.js
   ------------------------------------------------------------
   打开详情时抽取封面主色，写成 --ink-rgb / --ink-a 两个变量，
   由 round113.css 在弹窗顶部渲一层同色柔光。

   为什么放在详情而不是卡片列表：
     · 只在打开一部片子时算一次（一张 28×36 的 canvas 抽样，<2ms）
     · 列表页几百张卡若逐张取色会按住主线程 —— 这是本项目栽过的坑
       （见 enrich-covers 那 32 条 setImmediate 的教训）
     · 详情是最该「属于这一部片子」的地方

   取值策略（不是简单平均色）：
     逐像素过滤近黑/近白/灰调，按色相 12 桶聚合，
     权重 = 饱和度 × 亮度居中程度 —— 取「最有彩度又不太亮」的那一簇，
     避免整张图平均成一片脏灰。
   ============================================================ */
(function () {
    'use strict';
    if (window.__inkFollow) return;
    window.__inkFollow = true;

    var cache = new Map();   // src -> [r,g,b]
    var lastSrc = '';
    var loading = null;      // 正在解码的 src

    /* ---- 主色抽样 ---- */
    function dominant(img) {
        var W = 28, H = 36;
        var cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        var cx = cv.getContext('2d', { willReadFrequently: true });
        if (!cx) return null;
        try { cx.drawImage(img, 0, 0, W, H); } catch (e) { return null; }
        var data;
        try { data = cx.getImageData(0, 0, W, H).data; } catch (e) { return null; }

        var buckets = new Array(12);
        for (var i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 200) continue;
            var r = data[i], g = data[i + 1], b = data[i + 2];
            var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            if (lum < 0.10 || lum > 0.95) continue;        // 近黑 / 近白
            var d = mx - mn;
            var sat = mx === 0 ? 0 : d / mx;
            if (sat < 0.16) continue;                      // 灰调

            var hue;
            if (mx === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
            else if (mx === g) hue = ((b - r) / d + 2) * 60;
            else hue = ((r - g) / d + 4) * 60;
            var k = Math.floor(hue / 30) % 12;

            var w = sat * (1 - Math.abs(lum - 0.5) * 0.9);
            var bk = buckets[k];
            if (!bk) bk = buckets[k] = { w: 0, r: 0, g: 0, b: 0 };
            bk.w += w; bk.r += r * w; bk.g += g * w; bk.b += b * w;
        }
        var best = null;
        for (var j = 0; j < 12; j++) {
            if (buckets[j] && buckets[j].w > 0 && (!best || buckets[j].w > best.w)) best = buckets[j];
        }
        if (!best || best.w < 0.8) return null;            // 整张图没彩度 ⇒ 不染色
        return [Math.round(best.r / best.w), Math.round(best.g / best.w), Math.round(best.b / best.w)];
    }

    /* ---- 强度：跟底色拉开，但不喧宾夺主 ---- */
    function alphaFor(rgb) {
        var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
        var skin = document.documentElement.getAttribute('data-v4skin') || 'aurora';
        var light = skin === 'classic';                    // 白底经典（Aardvark）
        var a = light ? 0.11 : 0.34;
        /* 与底色太接近的要退让：白底遇浅色封面、暗底遇深色封面 */
        if (light && lum > 0.62) a *= 0.70;
        if (!light && lum < 0.28) a *= 0.55;
        return Math.round(a * 1000) / 1000;
    }

    function apply(box, rgb) {
        if (!rgb) return;
        box.style.setProperty('--ink-rgb', rgb.join(' '));
        box.style.setProperty('--ink-a', String(alphaFor(rgb)));
        box.setAttribute('data-ink', '1');
    }

    function box() {
        return document.querySelector('#detailModal .modal-content.detail-modal');
    }

    function run() {
        var modal = document.getElementById('detailModal');
        if (!modal || !modal.classList.contains('show')) return;
        var b = box();
        if (!b) return;
        var img = b.querySelector('.detail-poster');
        if (!img) return;
        var src = img.getAttribute('src') || '';
        if (!src || src === lastSrc) return;

        if (cache.has(src)) { lastSrc = src; apply(b, cache.get(src)); return; }
        if (loading === src) return;

        var grab = function () {
            loading = null;
            var rgb = dominant(img);
            if (rgb) { cache.set(src, rgb); lastSrc = src; apply(b, rgb); }
        };
        if (img.complete && img.naturalWidth) { grab(); return; }
        loading = src;
        img.addEventListener('load', grab, { once: true });
        img.addEventListener('error', function () { loading = null; }, { once: true });
    }

    /* 皮肤切换要重算强度（白底/暗底阈值不同） */
    function reskin() {
        var b = box();
        if (!b || !b.hasAttribute('data-ink')) return;
        var v = b.style.getPropertyValue('--ink-rgb');
        if (!v) return;
        apply(b, v.trim().split(/\s+/).map(Number));
    }

    function watch() {
        var modal = document.getElementById('detailModal');
        if (!modal) { setTimeout(watch, 400); return; }
        new MutationObserver(run).observe(modal, { attributes: true, attributeFilter: ['class'] });
        var body = document.getElementById('detailBody');
        if (body) new MutationObserver(function () { setTimeout(run, 40); }).observe(body, { childList: true });
        var html = document.documentElement;
        new MutationObserver(reskin).observe(html, { attributes: true, attributeFilter: ['data-v4skin'] });
        run();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
})();
