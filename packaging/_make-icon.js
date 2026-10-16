/**
 * _make-icon.js —— 生成桌面版图标
 * --------------------------------------------------------------------------
 * 用 Playwright 把一段内联 SVG 渲成多尺寸透明 PNG，输出到 packaging/build/。
 * 再交给 _make-ico.py 合成打包用的 icon.ico（PNG 压缩格式，Vista+ 支持）。
 * 用法：node packaging/_make-icon.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'build');
fs.mkdirSync(OUT, { recursive: true });

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:100vw;height:100vh}
</style></head><body>
<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#2c2319"/>
      <stop offset="0.55" stop-color="#16120e"/>
      <stop offset="1" stop-color="#0b0907"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffdf9c"/>
      <stop offset="0.45" stop-color="#e9b757"/>
      <stop offset="1" stop-color="#b07d1c"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.4" r="0.66">
      <stop offset="0" stop-color="#e9b757" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#e9b757" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="118" fill="url(#bg)"/>
  <rect x="0" y="0" width="512" height="512" rx="118" fill="url(#glow)"/>
  <rect x="9" y="9" width="494" height="494" rx="111" fill="none"
        stroke="#e9b757" stroke-opacity="0.20" stroke-width="7"/>
  <circle cx="256" cy="256" r="163" fill="none" stroke="url(#gold)" stroke-width="21"/>
  <circle cx="256" cy="256" r="130" fill="none"
          stroke="#e9b757" stroke-opacity="0.22" stroke-width="4"/>
  <circle cx="256" cy="148" r="26" fill="url(#gold)"/>
  <circle cx="359" cy="222" r="26" fill="url(#gold)"/>
  <circle cx="320" cy="344" r="26" fill="url(#gold)"/>
  <circle cx="192" cy="344" r="26" fill="url(#gold)"/>
  <circle cx="153" cy="222" r="26" fill="url(#gold)"/>
  <path d="M229 197 L337 256 L229 315 Z" fill="url(#gold)"/>
</svg>
</body></html>`;

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const size of SIZES) {
    const ctx = await browser.newContext({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
      // 透明背景，圆角外留空 → Windows 图标才有圆角
    });
    const page = await ctx.newPage();
    await page.setContent(HTML, { waitUntil: 'load' });
    await page.waitForTimeout(120);
    const out = path.join(OUT, size === 512 ? 'icon.png' : `icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true });
    console.log('  生成', path.basename(out), size + 'x' + size);
    await ctx.close();
  }
  await browser.close();
  console.log('✅ 图标 PNG 输出到', OUT);
})().catch((e) => { console.error('生成图标失败:', e); process.exit(1); });
