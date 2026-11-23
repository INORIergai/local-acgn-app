/* 源选择面板 GUI 验收：追番页「🔌 在线源」→ 面板 → 勾选/取消 → 落盘 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
        await page.goto('http://127.0.0.1:3517/library.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => typeof window.switchView === 'function' && window.SourcePicker, { timeout: 40000 });
        const tour = page.locator('#tourDoneBtn:visible');
        if (await tour.count()) await tour.click().catch(() => {});
        await page.waitForTimeout(400);

        await page.evaluate(() => window.switchView('series'));
        await page.waitForTimeout(1500);
        const hasBtn = await page.evaluate(() => !!document.getElementById('svSources'));
        console.log('追番页「在线源」按钮:', hasBtn ? '存在' : '缺失');
        if (!hasBtn) throw new Error('缺少在线源按钮');

        await page.evaluate(() => document.getElementById('svSources').click());
        await page.waitForFunction(() => {
            const b = document.getElementById('spBody');
            return b && b.querySelectorAll('.sp-row').length > 0;
        }, { timeout: 30000 });

        const info = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#spBody .sp-row'));
            const checked = rows.filter((r) => r.querySelector('.sp-check')?.checked).length;
            const kz = rows.filter((r) => (r.querySelector('.sp-fac')?.textContent || '').includes('Kazumi')).length;
            return { rows: rows.length, checked, kazumi: kz, count: (document.getElementById('spCount') || {}).textContent || '' };
        });
        console.log('面板:', JSON.stringify(info));
        if (info.rows < 30) throw new Error('源数量异常');
        if (info.kazumi < 10) throw new Error('Kazumi 源未出现在面板');

        // 取消第一个源的勾选 → 应落盘
        const changed = await page.evaluate(async () => {
            const cb = document.querySelector('#spBody .sp-check');
            const id = cb.getAttribute('data-id');
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
            await new Promise((r) => setTimeout(r, 800));
            const resp = await fetch('/api/media-source/prefs').then((r) => r.json());
            const item = (resp.data.sources || []).find((s) => s.id === id);
            return { id, enabledNow: item ? item.enabled : null };
        });
        console.log('取消勾选:', JSON.stringify(changed));
        if (changed.enabledNow !== false) throw new Error('取消勾选未落盘');

        // 恢复勾选
        await page.evaluate(async () => {
            const cb = document.querySelector('#spBody .sp-check');
            cb.checked = true;
            cb.dispatchEvent(new Event('change'));
            await new Promise((r) => setTimeout(r, 600));
        });

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
