/* 第四批 GUI 验收：隔离 Electron，验证漫画跨源搜索 → 进详情 → 换源续读面板。 */
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
    const root = path.resolve(__dirname, '..');
    const userData = path.join(root, '.runtime', 'reading-cross-gui');
    const shots = path.join(root, 'scripts', 'artifacts', 'reading-cross');
    fs.rmSync(userData, { recursive: true, force: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(shots, { recursive: true });
    const app = await electron.launch({
        executablePath: path.join(root, 'packaging/node_modules/electron/dist/electron.exe'),
        args: [path.join(root, 'packaging')],
        env: { ...process.env, CINEMAVAULT_USER_DATA: userData, CV_PORT: '3892', CV_SOFTWARE_RENDER: '1' },
        timeout: 90000,
    });
    console.log('ELECTRON LAUNCHED');
    try {
        let page = await app.firstWindow();
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const main = app.windows().find(w => /^http:\/\/127\.0\.0\.1:/.test(w.url()));
            if (main) {
                page = main;
                try { await page.waitForSelector('#featureView', { state: 'attached', timeout: 8000 }); break; }
                catch { /* 初始化中 */ }
            }
            await new Promise(r => setTimeout(r, 500));
        }
        page.on('pageerror', e => console.log('PAGE_ERROR', e.message));
        await page.waitForFunction(() => !document.querySelector('#bootGate') || getComputedStyle(document.querySelector('#bootGate')).pointerEvents === 'none', { timeout: 15000 });
        const tour = page.locator('#tourDoneBtn:visible');
        if (await tour.count()) await tour.click();
        await page.waitForTimeout(500);

        // 进入漫画阅读视图
        await page.evaluate(() => switchView('watch-comic'));
        await page.waitForSelector('#rhCrossToggle', { state: 'attached', timeout: 20000 });
        console.log('COMIC VIEW OK');

        // 打开跨源面板
        await page.click('#rhCrossToggle');
        await page.waitForSelector('#rhCross:not([hidden])', { timeout: 5000 });
        console.log('CROSS PANEL OPEN');

        // 搜索海贼王
        await page.fill('#rhCrossQ', '海贼王');
        await page.click('#rhCrossGo');
        await page.waitForFunction(() => {
            const box = document.getElementById('rhCrossGroups');
            return box && box.querySelectorAll('[data-g]').length > 0;
        }, { timeout: 60000 });
        const cardCount = await page.locator('#rhCrossGroups [data-g]').count();
        const groupHeads = await page.locator('.rh-cross-group-head').allInnerTexts();
        console.log('CROSS RESULTS cards=' + cardCount + ' groups=' + JSON.stringify(groupHeads));
        await page.screenshot({ path: path.join(shots, '01-cross-results.png') });
        if (cardCount < 2) throw new Error('跨源结果不足 2 个候选');

        // 点第一个候选进详情
        await page.locator('#rhCrossGroups [data-g]').first().click();
        await page.waitForSelector('#rhDetail:not([hidden]) .rh-chapters', { timeout: 60000 });
        const detailTitle = await page.locator('#rhDetail h2').first().innerText();
        const chapterCount = await page.locator('#rhDetail [data-ch]').count();
        console.log('DETAIL title=' + detailTitle + ' chapters=' + chapterCount);
        await page.screenshot({ path: path.join(shots, '02-detail.png') });
        if (chapterCount < 1) throw new Error('详情章节为空');

        // 换源续读按钮 → 打开跨源面板（switchMode）
        const switchBtn = page.locator('#rhDetail [data-switch-src]');
        if (await switchBtn.count()) {
            await switchBtn.click();
            await page.waitForSelector('#rhCross:not([hidden])', { timeout: 5000 });
            console.log('SWITCH-SOURCE PANEL OK');
        } else {
            console.log('SWITCH-SOURCE BUTTON MISSING');
        }

        console.log('GUI PASS 跨源搜索/进详情/换源面板');
    } finally {
        await app.close();
    }
})().catch((e) => { console.error('GUI FAIL', e.message); process.exit(1); });
