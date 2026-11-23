/* 追番 Kazumi 式交互 GUI 验收：点某一集 → 播放来源面板 → 候选列表 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
        await page.goto('http://127.0.0.1:3517/library.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        // 等 app 起来
        await page.waitForFunction(() => typeof window.switchView === 'function' && typeof window.SeriesView === 'object', { timeout: 40000 });
        // 跳导览
        const tour = page.locator('#tourDoneBtn:visible');
        if (await tour.count()) await tour.click().catch(() => {});
        await page.waitForTimeout(500);

        await page.evaluate(() => window.switchView('series'));
        await page.waitForTimeout(2500);

        // 找第一张追番卡片并打开详情
        const opened = await page.evaluate(() => {
            const hit = document.querySelector('.sv-card .sv-poster[data-act="detail"], .sv-card [data-act="detail"]');
            if (!hit) return { ok: false, reason: 'no detail trigger' };
            hit.click();
            return { ok: true, id: hit.getAttribute('data-sid') };
        });
        await page.waitForTimeout(2000);
        const detail = await page.evaluate(() => {
            const host = document.getElementById('svDetailHost');
            return { hasDetail: !!host && !!host.innerHTML.trim(), html: (host && host.innerHTML) || '' };
        });
        console.log('卡片点击:', JSON.stringify(opened));
        console.log('详情面板:', detail.hasDetail ? '已打开' : '未打开');
        if (!detail.hasDetail) throw new Error('详情面板未打开');

        // 检查第一集行的按钮
        const epBtns = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#svDetailHost .sv-ep'));
            if (!rows.length) return { rows: 0 };
            const first = rows[0];
            const btns = Array.from(first.querySelectorAll('button')).map(b => ({
                act: b.getAttribute('data-act'), text: (b.textContent || '').trim()
            }));
            return { rows: rows.length, firstBtns: btns };
        });
        console.log('分集行数:', epBtns.rows, '| 第一集按钮:', JSON.stringify(epBtns.firstBtns));
        const ds = await page.evaluate(() => {
            const row = document.querySelector('#svDetailHost .sv-ep');
            const b = row && row.querySelector('[data-act="ep-sources"]');
            return b ? { title: b.getAttribute('data-title'), epno: b.getAttribute('data-epno'), sid: b.getAttribute('data-sid') } : null;
        });
        console.log('第一集按钮 dataset:', JSON.stringify(ds));
        if (!epBtns.firstBtns.some(b => b.act === 'ep-sources')) throw new Error('第一集缺少 ep-sources 入口');

        // 点「播放/换源」→ 来源面板
        await page.evaluate(() => {
            const row = document.querySelector('#svDetailHost .sv-ep');
            const btn = row && row.querySelector('[data-act="ep-sources"]');
            if (btn) btn.click();
        });
        await page.waitForTimeout(800);
        const panel = await page.evaluate(() => {
            const host = document.getElementById('svEpSrcHost');
            const body = document.getElementById('svEpSrcBody');
            return {
                opened: !!host && !!host.innerHTML.trim(),
                loading: body ? (body.textContent || '').slice(0, 60) : '',
            };
        });
        console.log('来源面板:', panel.opened ? '已打开' : '未打开', '| 状态:', JSON.stringify(panel.loading));
        if (!panel.opened) throw new Error('播放来源面板未打开');

        // 等真实搜索结果（最多 90s）
        let readyRows = { items: 0, playable: 0, stat: '' };
        try {
            await page.waitForFunction(() => {
                const body = document.getElementById('svEpSrcBody');
                if (!body) return false;
                const items = body.querySelectorAll('.sv-online-item');
                const playBtns = body.querySelectorAll('[data-act="ep-play"]');
                return items.length > 0 || playBtns.length > 0 || /没有源能定位/.test(body.textContent || '');
            }, { timeout: 90000 });
            readyRows = await page.evaluate(() => {
                const body = document.getElementById('svEpSrcBody');
                return {
                    items: body.querySelectorAll('.sv-online-item').length,
                    playable: body.querySelectorAll('[data-act="ep-play"]').length,
                    stat: (body.querySelector('.sv-online-stat') || {}).textContent || '',
                };
            });
        } catch (e) { /* 超时也继续报告 */ }
        console.log('候选结果:', JSON.stringify(readyRows));

        if (errors.length) console.log('PAGE_ERRORS:', errors.slice(0, 3));
        console.log('GUI', (readyRows.playable > 0) ? 'PASS' : 'PARTIAL');
        await browser.close();
    } catch (e) {
        console.error('GUI FAIL', e.message);
        if (errors.length) console.error('PAGE_ERRORS:', errors.slice(0, 3));
        await browser.close();
        process.exit(1);
    }
})();
