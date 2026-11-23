/* 阅读器进阶排版 GUI：双页 / 页眉页脚 / 新动画 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
        const r = await fetch('http://127.0.0.1:3517/api/movie?type=novel&limit=5').then((x) => x.json());
        const items = Array.isArray(r) ? r : ((r.data && (r.data.items || r.data)) || []);
        const novel = Array.isArray(items) ? items.find((x) => x.id) : null;
        if (!novel) { console.log('SKIP 无小说'); await browser.close(); return; }

        await page.goto('http://127.0.0.1:3517/novel-reader.html?id=' + novel.id, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        const tour = page.locator('#tourDoneBtn:visible');
        if (await tour.count()) await tour.click().catch(() => {});
        await page.waitForTimeout(400);

        // 通过 setting 面板启用双页 + 页眉全部 + 页脚全部 + cover 动画
        const cfg = await page.evaluate(() => {
            const s = ReaderSettings.load('novel');
            s.dualPage = 'on'; s.showHeader = 'all'; s.showFooter = 'all'; s.turnStyle = 'cover';
            localStorage.setItem(Object.keys(localStorage).find(k => /:novel$/.test(k)) || '__cv_reader_settings:novel', JSON.stringify(s));
            return s;
        });
        console.log('设置:', JSON.stringify({ dual: cfg.dualPage, h: cfg.showHeader, f: cfg.showFooter, turn: cfg.turnStyle }));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        const t2 = page.locator('#tourDoneBtn:visible');
        if (await t2.count()) await t2.click().catch(() => {});

        const state = await page.evaluate(() => {
            const inner = document.querySelector('.paged-inner');
            const h = document.getElementById('pageHeader');
            const f = document.getElementById('pageFooter');
            const r2 = document.getElementById('pagedText2');
            const cs = inner ? getComputedStyle(inner) : null;
            return {
                dual: document.body.classList.contains('dual-page'),
                showH: document.body.classList.contains('show-header'),
                showF: document.body.classList.contains('show-footer'),
                gridCols: cs ? cs.gridTemplateColumns.split(' ').length : 0,
                rightVisible: r2 ? getComputedStyle(r2).display !== 'none' : false,
                hText: h ? (h.textContent || '').trim().slice(0, 30) : '',
                fText: f ? (f.textContent || '').trim().slice(0, 30) : '',
                turn: document.body.getAttribute('data-turn-style'),
            };
        });
        console.log('排版状态:', JSON.stringify(state));

        if (!state.dual) throw new Error('双页未启用');
        if (state.gridCols !== 2) throw new Error('双页未成两栏');
        if (!state.rightVisible) throw new Error('右栏未显示');
        if (!state.showH || !state.showF) throw new Error('页眉页脚未显示');
        if (!state.hText || !state.fText) throw new Error('页眉页脚无内容');
        if (state.turn !== 'cover') throw new Error('翻页动画未生效');

        if (errors.length) console.log('PAGE_ERRORS:', errors.slice(0, 3));
        console.log('GUI PASS');
        await browser.close();
    } catch (e) {
        console.error('GUI FAIL', e.message);
        if (errors.length) console.error('PAGE_ERRORS:', errors.slice(0, 3));
        await browser.close();
        process.exit(1);
    }
})();
