/* 阅读体验二轮验收：留白迁移 / 标题实体 / 滚轮翻页 / 库页续读横幅 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
        // 模拟老用户：先写入 pageWidth=medium 的旧设置（无 __rsVer），验证迁移到 full
        await page.goto('http://127.0.0.1:3517/library.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.evaluate(() => {
            const k = Object.keys(localStorage).find(x => /:novel$/.test(x)) || 'cvReaderSettings:novel';
            localStorage.setItem(k, JSON.stringify({ pageWidth: 'medium', padding: 20, fontSize: 18, lineHeight: 1.8, turnStyle: 'slide' }));
        });

        const r = await fetch('http://127.0.0.1:3517/api/movie?type=novel&limit=5').then(x => x.json());
        const items = Array.isArray(r) ? r : ((r.data && (r.data.items || r.data)) || []);
        const novel = Array.isArray(items) ? items.find(x => x.id) : null;
        console.log('小说样本:', novel ? novel.title : '无');

        // 1) 旧值迁移 + 留白
        await page.goto('http://127.0.0.1:3517/novel-reader.html?id=' + novel.id, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        const t = page.locator('#tourDoneBtn:visible'); if (await t.count()) await t.click().catch(() => {});
        await page.waitForTimeout(500);
        const lay = await page.evaluate(() => {
            const k = Object.keys(localStorage).find(x => /:novel$/.test(x));
            const s = k ? JSON.parse(localStorage.getItem(k)) : {};
            const inner = document.querySelector('.paged-inner');
            return {
                pageWidth: s.pageWidth, rsVer: s.__rsVer,
                innerMax: inner ? getComputedStyle(inner).maxWidth : '',
                innerW: inner ? Math.round(inner.getBoundingClientRect().width) : 0,
                vw: window.innerWidth,
            };
        });
        console.log('迁移+留白:', JSON.stringify(lay));

        // 2) 标题实体
        const title = await page.evaluate(() => {
            const el = document.getElementById('pagedTitle') || document.querySelector('.chapter-title');
            return (el && el.textContent || '').trim();
        });
        const hasEntity = /&#\d+;|&nbsp;|&amp;/.test(title);
        console.log('标题:', JSON.stringify(title.slice(0, 40)), '| 残留实体:', hasEntity);

        // 3) 滚轮翻页（用 #pagedInfo 的页码文本判定）
        const wheel = await page.evaluate(async () => {
            const info = document.getElementById('pagedInfo');
            const p0 = info ? info.textContent.trim() : '';
            const area = document.getElementById('readerArea');
            area.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 900));
            const p1 = info ? info.textContent.trim() : '';
            return { p0, p1, changed: p0 !== p1 };
        });
        console.log('滚轮翻页:', JSON.stringify(wheel));

        // 4) 库页续读横幅
        await page.goto('http://127.0.0.1:3517/library.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => typeof window.switchView === 'function', { timeout: 40000 });
        const t2 = page.locator('#tourDoneBtn:visible'); if (await t2.count()) await t2.click().catch(() => {});
        await page.waitForTimeout(400);
        await page.evaluate(() => window.switchView('novel'));
        await page.waitForTimeout(2500);
        const bar = await page.evaluate(() => {
            const b = document.getElementById('readResumeBar');
            return {
                exists: !!b, visible: b ? getComputedStyle(b).display !== 'none' : false,
                hasContinue: !!(b && b.querySelector('.rrb-continue')),
                hasRandom: !!(b && b.querySelector('.rrb-random')),
                text: b ? (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '',
            };
        });
        console.log('续读横幅:', JSON.stringify(bar));

        const pass = lay.pageWidth === 'full' && lay.innerMax === 'none' && !hasEntity && bar.exists && bar.visible && bar.hasRandom;
        console.log('GUI', pass ? 'PASS' : 'PARTIAL');
        if (errors.length) console.log('PAGE_ERRORS:', errors.slice(0, 3));
        await browser.close();
        process.exit(pass ? 0 : 2);
    } catch (e) {
        console.error('GUI FAIL', e.message);
        if (errors.length) console.error('PAGE_ERRORS:', errors.slice(0, 3));
        await browser.close();
        process.exit(1);
    }
})();
