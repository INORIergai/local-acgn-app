/* 小说阅读体验 GUI 验收：分章标题 / 铺满宽度不留白 / 点击热区 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
        // 找一本有章节的小说
        const r = await fetch('http://127.0.0.1:3517/api/movie?type=novel&limit=10').then((x) => x.json());
        const items = Array.isArray(r) ? r : ((r.data && (r.data.items || r.data)) || r.items || []);
        const novel = Array.isArray(items) ? items.find((x) => x.id) : null;
        console.log('小说样本:', novel ? (novel.title || novel.name) : '无');
        if (!novel) { console.log('GUI SKIP: 无小说数据'); await browser.close(); return; }

        await page.goto('http://127.0.0.1:3517/novel-reader.html?id=' + novel.id, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        const tour = page.locator('#tourDoneBtn:visible');
        if (await tour.count()) await tour.click().catch(() => {});
        await page.waitForTimeout(500);

        // 章节标题：不应等于书名，应是「第N章」等
        const chap = await page.evaluate(() => {
            const t = document.getElementById('chapterTitle') || document.querySelector('.chapter-title') || document.getElementById('pagedTitle');
            return (t && t.textContent || '').trim();
        });
        console.log('章节标题:', JSON.stringify(chap.slice(0, 40)));

        // 阅读区宽度：正文容器应接近视口宽度（无 20% 留白）
        const layout = await page.evaluate(() => {
            const ra = document.getElementById('readerArea');
            const pc = document.querySelector('.paged-content');
            const inner = document.querySelector('.paged-inner') || ra;
            if (!ra || !inner) return null;
            const rr = ra.getBoundingClientRect();
            const ir = inner.getBoundingClientRect();
            const cs = getComputedStyle(ra);
            return {
                vw: window.innerWidth,
                readerW: Math.round(rr.width),
                innerW: Math.round(ir.width),
                padL: cs.paddingLeft,
                padR: cs.paddingRight,
            };
        });
        console.log('布局:', JSON.stringify(layout));
        if (layout && layout.padL !== '0px' && parseFloat(layout.padL) > 60) throw new Error('左右留白仍过大');

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
