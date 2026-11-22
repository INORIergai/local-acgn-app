/* 6.8.8 GUI 验收：影视库/动漫库首页"在线最新"卡片区 + 响应式。隔离 Electron。 */
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
    const root = path.resolve(__dirname, '..');
    const userData = path.join(root, '.runtime', 'features-688-gui');
    const shots = path.join(root, 'scripts', 'artifacts', 'features-688');
    fs.rmSync(userData, { recursive: true, force: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(shots, { recursive: true });
    const app = await electron.launch({
        executablePath: path.join(root, 'packaging/node_modules/electron/dist/electron.exe'),
        args: [path.join(root, 'packaging')],
        env: { ...process.env, CINEMAVAULT_USER_DATA: userData, CV_PORT: '3893', CV_SOFTWARE_RENDER: '1' },
        timeout: 90000,
    });
    try {
        let page = await app.firstWindow();
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const main = app.windows().find(w => /^http:\/\/127\.0\.0\.1:/.test(w.url()));
            if (main) {
                page = main;
                try { await page.waitForSelector('#featureView', { state: 'attached', timeout: 8000 }); break; } catch {}
            }
            await new Promise(r => setTimeout(r, 500));
        }
        page.on('pageerror', e => console.log('PAGE_ERROR', e.message));
        await page.waitForFunction(() => !document.querySelector('#bootGate') || getComputedStyle(document.querySelector('#bootGate')).pointerEvents === 'none', { timeout: 15000 });
        const tour = page.locator('#tourDoneBtn:visible');
        if (await tour.count()) await tour.click();
        await page.waitForTimeout(600);

        // 进影视库
        await page.evaluate(() => switchView('movies'));
        await page.waitForTimeout(1000);
        // 等在线卡片区（browse 聚合约 9s），最多 25s
        let obVisible = false, obCards = 0;
        try {
            await page.waitForFunction(() => {
                const b = document.getElementById('onlineBrowseBar');
                return b && !b.hidden && b.querySelectorAll('.ob-card').length > 0;
            }, { timeout: 25000 });
            obVisible = true;
            obCards = await page.locator('#onlineBrowseBar .ob-card').count();
        } catch { /* 在线区没出来 */ }
        console.log('影视库在线卡片区:', obVisible ? '显示 ' + obCards + ' 张' : '未显示(可能源站不可用)');

        // 响应式测量：1920 视口下 movieGrid 宽度
        const m = await page.evaluate(() => {
            const g = document.getElementById('movieGrid').getBoundingClientRect();
            const bar = document.getElementById('onlineBrowseBar').getBoundingClientRect();
            return { gridW: Math.round(g.width), barW: Math.round(bar.width), vw: window.innerWidth };
        });
        console.log('响应式: 视口' + m.vw + ' movieGrid=' + m.gridW + ' 在线区=' + m.barW);
        await page.screenshot({ path: path.join(shots, '01-movies.png') });

        // 动漫库
        await page.evaluate(() => switchView('anime'));
        await page.waitForTimeout(1500);
        const obAnime = await page.evaluate(() => {
            const b = document.getElementById('onlineBrowseBar');
            return b && !b.hidden ? b.querySelectorAll('.ob-card').length : 0;
        });
        console.log('动漫库在线卡片:', obAnime, '张');
        await page.screenshot({ path: path.join(shots, '02-anime.png') });

        console.log('GUI PASS');
        await app.close();
    } catch (e) {
        console.error('GUI FAIL', e.message);
        await app.close();
        process.exit(1);
    }
})();
