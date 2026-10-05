/**
 * round72 · 全局任务胶囊（右上角）
 *
 * ── 要解决的问题 ──────────────────────────────────────────────
 * 用户反馈：「离开更新海报的页面后我就看不到更新进度了」。
 * 根因：11 组后台任务里，只有扫描状态的 DOM 在顶栏（全局可见），
 * 其余 5 组（批量重命名 / 导出 NFO / 海报修复 / 批量换海报 / 女优头像）
 * 的进度 div 全都写在**设置弹窗的 HTML 模板**里 —— 弹窗一关，用户就再也看不到；
 * 而且这几个轮询器还是「点按钮才启动」的，关掉弹窗再打开，轮询已停、进度定格。
 *
 * 做法：常驻一个右上角胶囊，轮询 /api/tasks（后端 utils/task-status.js 聚合全部任务）。
 *   · 没有任何任务时完全隐藏，不打扰
 *   · 有任务跑时显示进度条 + 百分比，可点开看每个任务的明细
 *   · 任务完成后保留 15 秒显示结果，然后自动淡出
 *
 * 独立成文件而不是塞进 app.js：app.js 已 14630 行，且它承载着已验证的
 * 扫描状态小圆点（renderScanStatusUI），不去动它可以避免回归。
 */
(function () {
    'use strict';

    let timer = null;
    let open = false;
    let lastSig = '';          // 任务签名：没变化就不重绘，避免 1.5s 一次的无谓 DOM 操作
    let stickUntil = 0;        // 完成后继续显示到什么时候

    function el(id) { return document.getElementById(id); }

    function ensureDom() {
        if (el('taskCapsule')) return;
        const d = document.createElement('div');
        d.id = 'taskCapsule';
        d.className = 'task-capsule';
        d.innerHTML =
            '<div class="task-cap-head" id="taskCapHead">' +
            '  <span class="task-cap-spin" id="taskCapSpin"></span>' +
            '  <span class="task-cap-title" id="taskCapTitle">后台任务</span>' +
            '  <span class="task-cap-pct" id="taskCapPct"></span>' +
            '  <span class="task-cap-caret">▼</span>' +
            '</div>' +
            '<div class="task-cap-track"><div class="task-cap-fill" id="taskCapFill"></div></div>' +
            '<div class="task-cap-panel" id="taskCapPanel">' +
            '  <div class="task-cap-panel-title"><span>后台任务</span><span id="taskCapHint"></span></div>' +
            '  <div id="taskCapList"></div>' +
            '</div>';
        document.body.appendChild(d);

        el('taskCapHead').addEventListener('click', () => {
            open = !open;
            el('taskCapsule').classList.toggle('open', open);
        });
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 任务签名：内容不变就不重绘 */
    function sigOf(list) {
        return list.map(t => t.key + ':' + (t.running ? 1 : 0) + ':' + t.current + '/' + t.total
            + ':' + t.ok + ':' + t.fail).join('|');
    }

    function render(list) {
        ensureDom();
        const cap = el('taskCapsule');
        const running = list.filter(t => t.running);
        const now = Date.now();
        const showList = running.length ? running : list.filter(t => t.finishedAt && now - t.finishedAt < 15000);

        if (!showList.length) {
            cap.classList.remove('show', 'open');
            open = false;
            lastSig = '';
            stickUntil = 0;
            return;
        }

        cap.classList.add('show');
        const sig = sigOf(showList);
        const allDone = showList.every(t => !t.running);
        if (allDone) stickUntil = now + 15000;

        // 与「本次启动自动扫描」提示条错位（两者都钉在右上角，会叠在一起）
        try {
            const bar = document.getElementById('startupScanBar');
            cap.classList.toggle('shift', !!(bar && bar.offsetParent !== null));
        } catch (e) { /* 忽略 */ }

        // 收起态：一句话概括。多任务并行时优先报「几项在跑」，别让后面那个被挤掉
        const first = showList[0];
        const runningN = showList.filter(t => t.running).length;
        el('taskCapSpin').className = 'task-cap-spin' + (allDone ? (first.fail ? ' fail' : ' done') : '');
        if (runningN > 1) {
            el('taskCapTitle').textContent = runningN + ' 项任务进行中';
            el('taskCapPct').textContent = first.total ? (first.current + '/' + first.total) : '';
        } else {
            el('taskCapTitle').textContent = first.icon + ' ' + first.name + (allDone ? ' 已完成' : '');
            el('taskCapPct').textContent = first.total ? (first.current + '/' + first.total) : '';
        }
        el('taskCapFill').style.width = (allDone ? 100 : first.percent) + '%';

        // 展开态：逐条
        el('taskCapList').innerHTML = showList.map(t => {
            const badge = t.running
                ? '<span class="task-cap-badge">' + (t.total ? t.percent + '%' : '进行中') + '</span>'
                : '<span class="task-cap-badge ' + (t.fail ? 'fail' : 'ok') + '">完成</span>';
            const num = t.total ? t.current + ' / ' + t.total : '';
            const res = (!t.running && (t.ok || t.fail))
                ? ' · 成功 ' + t.ok + (t.fail ? ' · 失败 ' + t.fail : '') : '';
            return '<div class="task-cap-item" data-key="' + esc(t.key) + '">' +
                '<div class="task-cap-item-top">' +
                '  <span>' + esc(t.icon) + '</span>' +
                '  <span class="task-cap-item-name">' + esc(t.name) + '</span>' +
                '  <span class="task-cap-item-num">' + esc(num) + res + '</span>' +
                '  ' + badge +
                '</div>' +
                '<div class="task-cap-item-bar"><div class="task-cap-item-fill" style="width:' +
                (t.running ? t.percent : 100) + '%"></div></div>' +
                (t.detail ? '<div class="task-cap-item-detail">' + esc(t.detail) + '</div>' : '') +
                '</div>';
        }).join('');
        el('taskCapHint').textContent = allDone ? '即将自动收起' : '点击胶囊可展开';
    }

    async function tick() {
        try {
            const res = await fetch('/api/tasks');
            const j = await res.json();
            if (j.code !== 0 || !j.data) return;
            const list = j.data.list || [];
            const sig = sigOf(list) + '|' + (Date.now() < stickUntil ? 'k' : '');
            if (sig === lastSig) return;
            lastSig = sig;
            render(list);
        } catch (e) { /* 任务中心挂了不能影响主界面 */ }
    }

    function start() {
        if (timer) return;
        ensureDom();
        tick();
        timer = setInterval(tick, 1500);
    }

    // 切换视图后立刻刷一次：进度不该因为「切了个页面」就停在原地
    const _switchView = window.switchView;
    if (typeof _switchView === 'function') {
        window.switchView = function () {
            const r = _switchView.apply(this, arguments);
            setTimeout(tick, 200);
            return r;
        };
    }

    window.addEventListener('DOMContentLoaded', start);
    // 脚本在 body 末尾时 DOMContentLoaded 可能已过
    if (document.readyState !== 'loading' && document.body) start();

    window.TaskCapsule = { refresh: tick, start };
})();
