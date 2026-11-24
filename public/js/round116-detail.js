/* ============================================================
   round116 · detail.js —— 详情「工具」区折叠（P12）
   ------------------------------------------------------------
   15 个按钮全塞在一屏里，其中 10 个是低频操作（AI 翻译 / 重新刮削 /
   删除海报…）。这里只做一件事：保留 4 个高频的，其余收进「更多」。

   为什么用 JS 逐个打标记，而不是改 app.js 的模板：
     · 详情面板有好几套渲染路径（影片 / 漫画 / 小说 / 云端），
       逐个改模板总会漏一套；这里在 DOM 层统一处理，一套逻辑覆盖全部；
     · 按钮原本全是 `onclick="..."` 内联，打标记不动结构 ⇒ 所有处理函数
       一个都不受影响，展开后仍按原样工作；
     · 回滚只需删掉 library.html 里的这一行 <script>，DOM 立刻恢复原状。

   判据（写在验证脚本里）：
     · 折叠态可见 .dbtn 数量 = 5（4 + 更多）
     · 展开态 15 个全部可见且有非零尺寸（= 一个都没被吞）
   ============================================================ */
(function () {
    'use strict';

    var KEEP = ['fav', 'edit', 'poster', 'folder'];   // 高频：收藏 / 编辑 / 换海报 / 文件夹
    var MAX = 4;

    function buildMore() {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'dbtn dbtn-more';
        b.setAttribute('data-act', 'more');
        b.setAttribute('aria-expanded', 'false');
        b.title = '展开其余工具';
        b.innerHTML = '<span class="more-glyph" aria-hidden="true">···</span>' +
                      '<span class="dbtn-label">更多</span>';
        return b;
    }

    function applyTo(box) {
        if (box.getAttribute('data-r116') === 'done') return;
        var btns = [];
        for (var i = 0; i < box.children.length; i++) {
            var c = box.children[i];
            if (c.classList && c.classList.contains('dbtn') && !c.classList.contains('dbtn-more')) {
                btns.push(c);
            }
        }
        /* 只有「够多」才有折叠的必要；5 个以内原样保留 */
        if (btns.length <= MAX + 1) return;

        var picked = [];
        KEEP.forEach(function (act) {
            for (var i = 0; i < btns.length; i++) {
                if (picked.indexOf(btns[i]) < 0 && btns[i].getAttribute('data-act') === act) {
                    picked.push(btns[i]);
                    return;
                }
            }
        });
        /* 高频项不足 4 个时，按原顺序补齐，避免这一行看起来空一半 */
        for (var i = 0; i < btns.length && picked.length < MAX; i++) {
            if (picked.indexOf(btns[i]) < 0) picked.push(btns[i]);
        }
        btns.forEach(function (b) {
            if (picked.indexOf(b) < 0) b.classList.add('is-extra');
        });

        var more = buildMore();
        more.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var open = box.classList.toggle('is-open');
            more.setAttribute('aria-expanded', open ? 'true' : 'false');
            more.querySelector('.dbtn-label').textContent = open ? '收起' : '更多';
            more.title = open ? '收起工具' : '展开其余工具';
        });
        box.appendChild(more);
        box.setAttribute('data-r116', 'done');
    }

    function scan() {
        var boxes = document.querySelectorAll('.detail-actions');
        for (var i = 0; i < boxes.length; i++) applyTo(boxes[i]);
    }

    function boot() {
        scan();
        var host = document.getElementById('detailBody') || document.body;
        /* 详情是 innerHTML 整体替换的，所以必须盯着它重新扫描 */
        if (window.MutationObserver) {
            var t = null;
            new MutationObserver(function () {
                if (t) clearTimeout(t);
                t = setTimeout(scan, 30);
            }).observe(host, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
