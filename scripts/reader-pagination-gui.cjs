/* 阅读器翻页改造 GUI 验收（第一批）：用 Playwright chromium 验证设置项渲染与云端分页函数行为。 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
        // 1) 注入 reader-settings.js，渲染小说设置面板，确认页宽选项出现
        const rsSrc = fs.readFileSync(path.join(root, 'public/js/reader-settings.js'), 'utf8');
        await page.setContent('<div id="panel"></div>');
        await page.addScriptTag({ content: rsSrc });
        const settingInfo = await page.evaluate(() => {
            const state = ReaderSettings.defaults('novel');
            const picked = [];
            ReaderSettings.render(document.getElementById('panel'), 'novel', state, (id, v) => picked.push([id, v]), '⚙️ 阅读设置');
            const panel = document.getElementById('panel');
            return {
                hasPageWidthLabel: /页宽（每行字数）/.test(panel.textContent),
                opts: Array.from(panel.querySelectorAll('[data-rs-id="pageWidth"]')).map(n => n.textContent.trim()),
                defPageWidth: state.pageWidth,
            };
        });
        console.log('设置面板页宽标签:', settingInfo.hasPageWidthLabel ? '✓' : '✗');
        console.log('页宽选项:', settingInfo.opts.join(' / '), '| 默认:', settingInfo.defPageWidth);
        if (!settingInfo.hasPageWidthLabel || settingInfo.opts.length !== 4) throw new Error('页宽设置项渲染异常');

        // 2) 云端分页函数：构造高内容 #body，提取 splitIntoPages 注入，验证切出多页
        const crLines = fs.readFileSync(path.join(root, 'public/cloud-reader.html'), 'utf8').split('\n');
        const start = crLines.findIndex(l => l.includes('function splitIntoPages(rawHtml)'));
        const showLine = crLines.findIndex(l => l.includes('function show(i, dir, keepSub)'));
        if (start < 0 || showLine < 0) throw new Error('未找到函数起点');
        // show 之前的空行到 start 之间就是 splitIntoPages 全文
        const fnSrc = crLines.slice(start, showLine).join('\n').replace(/\n\s*$/, '');
        await page.setContent('<div id="body" style="height:200px;width:400px;font-size:16px;line-height:1.8;overflow:auto;padding:0"></div>');
        const pageCount = await page.evaluate((src) => {
            window.bodyEl = () => document.getElementById('body');
            eval(src);
            const paras = Array.from({ length: 30 }, (_, i) => `<p>这是第 ${i + 1} 段测试正文内容，用来验证按容器高度切分页是否正常工作，每段都有足够的文字让页面产生滚动。</p>`).join('');
            return splitIntoPages(paras).length;
        }, fnSrc);
        console.log('云端分页: 30 段切成', pageCount, '页', pageCount > 1 ? '✓' : '✗');
        if (pageCount <= 1) throw new Error('云端分页未切出多页');

        if (errors.length) { console.log('PAGE_ERRORS:', errors.slice(0, 3)); }
        console.log('GUI PASS');
        await browser.close();
    } catch (e) {
        console.error('GUI FAIL', e.message);
        await browser.close();
        process.exit(1);
    }
})();
