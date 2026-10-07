/**
 * motion-v2.js —— r82 动效行为层（与 motion-v2.css 配套）
 * 职责只有两件：
 *   1. 图片淡入：封面 onload 后 360ms 浮现，杜绝白闪（含缓存图补标）
 *   2. 「立即检查 / 检查漫画」busy 态：点击转细环，app.js 在检查结束时调 mvSetNrBusy(false)
 * 其余全部交给 CSS（通知弹层进出场 / 侧栏微移），此处不碰。
 */
(function () {
    'use strict';
    document.documentElement.classList.add('mv-on');

    /* ---------- 1. 图片淡入 ---------- */
    function markLoaded(img) {
        if (img && img.tagName === 'IMG' && !img.classList.contains('mv-loaded')) {
            img.classList.add('mv-loaded');
        }
    }
    // capture 捕获所有 IMG 的 load（包括 lazy / 动态插入的）
    document.addEventListener('load', function (e) {
        if (e.target && e.target.tagName === 'IMG') markLoaded(e.target);
    }, true);
    document.addEventListener('error', function (e) {
        // 加载失败的图直接视为已就位，保持可见（占位符兜底逻辑照旧）
        if (e.target && e.target.tagName === 'IMG') markLoaded(e.target);
    }, true);
    // 缓存图可能在监听器挂上前就已 complete，扫一遍补标
    function sweep() {
        document.querySelectorAll('html.mv-on .movie-card img, html.mv-on .nr-card img, html.mv-on .series-stack img')
            .forEach(function (img) {
                if (img.complete && img.naturalWidth > 0) markLoaded(img);
            });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', sweep);
    } else {
        sweep();
    }
    // 视图切换会批量插入缓存图，两次兜底扫描
    setTimeout(sweep, 1500);
    setTimeout(sweep, 4000);

    /* ---------- 2. 检查按钮 busy 态（供 app.js 调用） ---------- */
    // app.js：点击成功启动检查后保持 busy，直到 stopNewReleasePolling()
    //（检查结束 / 离开视图 / 轮询超时）调用解除 —— busy 与真实后台状态同寿命。
    window.mvSetNrBusy = function (on) {
        ['nrCheckAllBtn', 'nrCheckComicBtn'].forEach(function (id) {
            const b = document.getElementById(id);
            if (b) b.classList.toggle('is-busy', !!on);
        });
    };

    /* ---------- 3. 切片器滑动指示背板 ----------
     * 用法：容器内是若干 .f-pill / .nr-tab 按钮，active 类标记当前项。
     *   mvInitSlidePill(bar)  —— 渲染后调用：生成背板并瞬时对位到 active（无动画）
     *   mvSlidePillTo(btn)    —— 点击时先调：背板 180ms 滑到目标，随后业务重渲染
     *                            会重建背板并瞬时对位，视觉上无缝衔接 */
    window.mvInitSlidePill = function (bar) {
        if (!bar) return;
        const active = bar.querySelector('.f-pill.active, .nr-tab.active');
        if (!active) return;
        let pill = bar.querySelector('.mv-slide-pill');
        if (!pill) {
            pill = document.createElement('span');
            pill.className = 'mv-slide-pill';
            bar.insertBefore(pill, bar.firstChild);
        }
        // 瞬时对位（无过渡）
        pill.style.transition = 'none';
        pill.style.width = active.offsetWidth + 'px';
        pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
        void pill.offsetWidth; // 强制 reflow，之后的滑动才有过渡
        pill.style.transition = '';
    };

    window.mvSlidePillTo = function (btn) {
        if (!btn) return;
        const bar = btn.parentElement;
        if (!bar) return;
        let pill = bar.querySelector('.mv-slide-pill');
        if (!pill) { window.mvInitSlidePill(bar); pill = bar.querySelector('.mv-slide-pill'); }
        if (!pill) return;
        pill.style.width = btn.offsetWidth + 'px';
        pill.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
    };

    /* ---------- 4. 热门排行入场（stagger + 数字滚动 + 热度条） ----------
     * renderHotRanking 渲染完调用：领奖台与榜单行错峰浮现，
     * 播放次数 0→N 滚动，热度条以 scaleX 从 0 展开（只动 transform/opacity）。 */
    window.mvHotReveal = function (root) {
        if (!root) return;
        const steps = root.querySelectorAll('.hp-step');
        const rows = root.querySelectorAll('.hr-row');
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const reveal = (els) => els.forEach((el, i) => {
            if (reduce) return;
            el.style.opacity = '0';
            el.style.transform = 'translateY(12px)';
            el.style.transition = 'opacity 360ms cubic-bezier(0.16,1,0.3,1), transform 360ms cubic-bezier(0.16,1,0.3,1)';
            setTimeout(() => {
                el.style.opacity = '1';
                el.style.transform = 'none';
            }, 60 + i * 60);
        });
        reveal(steps);
        reveal(rows);

        // 数字滚动（播放次数）：▶ N 次
        const countUp = (el) => {
            const target = parseInt(el.dataset.count, 10) || 0;
            if (reduce || target <= 0) { el.textContent = '▶ ' + target + ' 次'; return; }
            const dur = 700, t0 = performance.now();
            const tick = (now) => {
                const t = Math.min(1, (now - t0) / dur);
                const eased = 1 - Math.pow(1 - t, 3);
                el.textContent = '▶ ' + Math.round(target * eased) + ' 次';
                if (t < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        };
        root.querySelectorAll('[data-count]').forEach(countUp);

        // 热度条：width 目标存 data-w，实际用 scaleX 从 0 展开
        root.querySelectorAll('.hr-hotbar i').forEach((bar) => {
            const w = bar.style.width;
            bar.dataset.w = w;
            bar.style.width = '100%';
            bar.style.transform = 'scaleX(0)';
            bar.style.transformOrigin = 'left center';
            setTimeout(() => {
                bar.style.transition = 'transform 600ms cubic-bezier(0.16,1,0.3,1)';
                bar.style.transform = 'scaleX(' + (parseFloat(w) / 100 || 0.04) + ')';
            }, 150);
        });
    };

    /* ---------- 5. 年度报告动效（核心数字平滑滚动 + 错峰浮现） ---------- */
    window.mvAnnualReveal = function (root) {
        if (!root) return;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Bento 卡片错峰浮现
        const cards = root.querySelectorAll('.bento-card, .annual-card');
        cards.forEach((card, idx) => {
            card.style.setProperty('--bi', idx);
            card.style.setProperty('--i', idx);
            card.classList.add('mv-in');
        });

        // 数字从 0 平滑滚动（支持解析 "12h"、"45m" 等复合数字）
        root.querySelectorAll('.bento-num, .annual-card .num').forEach((numEl) => {
            const raw = numEl.dataset.val !== undefined ? numEl.dataset.val : numEl.textContent.trim();
            const unit = numEl.dataset.unit || (numEl.textContent.trim().match(/[a-zA-Z%]+$/)?.[0] || '');
            const target = parseFloat(raw);
            if (reduce || isNaN(target) || target <= 0) return;

            numEl.textContent = '0' + unit;
            const dur = 950;
            const t0 = performance.now();
            const tick = (now) => {
                const t = Math.min(1, (now - t0) / dur);
                const eased = 1 - Math.pow(1 - t, 3);
                const cur = target % 1 === 0 ? Math.round(target * eased) : (target * eased).toFixed(1);
                numEl.textContent = cur + unit;
                if (t < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    };

    /* ---------- 6. 新作监视流式入场（日期组层叠） ---------- */
    window.mvNrReveal = function (root) {
        if (!root) return;
        root.querySelectorAll('.nr-day').forEach((day, idx) => {
            day.style.setProperty('--di', Math.min(idx, 10));
        });
    };

    /* ---------- 7. 我的收藏：展品优雅挂墙 ---------- */
    window.mvExhibitsReveal = function (root) {
        if (!root) return;
        root.querySelectorAll('.exhibit').forEach((ex, idx) => {
            ex.style.setProperty('--ei', Math.min(idx, 24));
            ex.classList.add('mv-hang');
        });
    };

    /* ---------- 8. 收藏爱心物理微弹跳 ---------- */
    window.mvHeartPop = function (el) {
        if (!el) return;
        el.classList.remove('mv-heart-pop');
        void el.offsetWidth; // 触发 reflow
        el.classList.add('mv-heart-pop');
        setTimeout(() => el.classList.remove('mv-heart-pop'), 450);
    };
})();
