/* 追番体验改造 GUI 验收：海报墙 / 播放来源面板新UI / 点播放出播放器 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
        await page.goto('http://127.0.0.1:3517/library.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => typeof window.switchView === 'function' && window.SeriesView, { timeout: 40000 });
        const tour = page.locator('#tourDoneBtn:visible');
        if (await tour.count()) await tour.click().catch(() => {});
        await page.waitForTimeout(400);

        await page.evaluate(() => window.switchView('series'));
        await page.waitForTimeout(2500);

        // 1) 海报墙：sv-calendar 应为网格且多行（不是横向单行）
        const wall = await page.evaluate(() => {
            const el = document.querySelector('#svCalendar');
            if (!el) return null;
            const cs = getComputedStyle(el);
            const cards = el.querySelectorAll('.sv-cal-card');
            const rows = new Set(Array.from(cards).map((c) => Math.round(c.getBoundingClientRect().top)));
            return { display: cs.display, cols: cs.gridTemplateColumns.split(' ').length, cards: cards.length, rows: rows.size, overflowX: cs.overflowX };
        });
        console.log('海报墙:', JSON.stringify(wall));
        if (!wall || wall.display !== 'grid' || wall.rows < 2) throw new Error('海报墙未成网格多行');

        // 2) 打开第一张卡片详情 → 点某集「播放/换源」
        await page.evaluate(() => {
            const hit = document.querySelector('#svCalendar .sv-cal-card');
            if (hit) hit.click();
        });
        await page.waitForTimeout(1800);
        const detailOpen = await page.evaluate(() => {
            const h = document.getElementById('svDetailHost');
            return !!(h && h.innerHTML.trim());
        });
        console.log('详情打开:', detailOpen);
        if (!detailOpen) throw new Error('详情未打开');

        await page.evaluate(() => {
            const b = document.querySelector('#svDetailHost [data-act="ep-sources"]');
            if (b) b.click();
        });
        await page.waitForTimeout(700);

        // 3) 新面板样式生效（宽度 > 500，有背景色，卡片存在）
        await page.waitForFunction(() => {
            const b = document.getElementById('svEpSrcBody');
            return b && (b.querySelector('.epsrc-card') || /没有源能定位/.test(b.textContent || ''));
        }, { timeout: 100000 });
        const panel = await page.evaluate(() => {
            const p = document.querySelector('#svEpSrcHost .epsrc-panel');
            if (!p) return null;
            const cs = getComputedStyle(p);
            const cards = document.querySelectorAll('#svEpSrcHost .epsrc-card').length;
            const btns = document.querySelectorAll('#svEpSrcHost .epsrc-play:not(.disabled)').length;
            const stat = (document.querySelector('#svEpSrcHost .epsrc-stat') || {}).textContent || '';
            const firstBadge = (document.querySelector('#svEpSrcHost .epsrc-badge') || {}).textContent || '';
            return { width: Math.round(p.getBoundingClientRect().width), bg: cs.backgroundColor, cards, btns, stat, firstBadge };
        });
        console.log('来源面板:', JSON.stringify(panel));
        if (!panel || panel.width < 500 || panel.btns < 1) throw new Error('面板样式/按钮异常');

        // 4) 点播放 → playerModal 应显示（且不再被抽屉盖住）
        const played = await page.evaluate(async () => {
            const btn = document.querySelector('#svEpSrcHost .epsrc-play:not(.disabled)');
            if (!btn) return { ok: false, reason: 'no play btn' };
            btn.click();
            // 等最多 90s 看播放器是否出现
            for (let i = 0; i < 180; i++) {
                await new Promise((r) => setTimeout(r, 500));
                const pm = document.getElementById('playerModal');
                if (pm && pm.classList.contains('show')) {
                    const cs = getComputedStyle(pm);
                    const detail = document.getElementById('svDetailHost');
                    return { ok: true, z: cs.zIndex, display: cs.display, detailCleared: !detail || !detail.innerHTML.trim() };
                }
            }
            return { ok: false, reason: 'playerModal 未出现' };
        });
        console.log('播放结果:', JSON.stringify(played));
        console.log('GUI', played.ok ? 'PASS' : 'PARTIAL');
        if (errors.length) console.log('PAGE_ERRORS:', errors.slice(0, 3));
        await browser.close();
        process.exit(played.ok ? 0 : 2);
    } catch (e) {
        console.error('GUI FAIL', e.message);
        if (errors.length) console.error('PAGE_ERRORS:', errors.slice(0, 3));
        await browser.close();
        process.exit(1);
    }
})();
