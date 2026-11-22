/* 阅读器翻页改造回归（第一批）：PC 默认翻页+页宽、Android EPUB 分页+页宽、云端在线分页。静态检查，不触网。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// --- PC: reader-settings.js 新增 pageWidth ---
const rs = rd('public/js/reader-settings.js');
assert.ok(/id: 'pageWidth'/.test(rs), 'reader-settings 应有 pageWidth 设置项');
assert.ok(rs.includes("v: 'full'"), 'pageWidth 应有全宽选项');

// --- PC: novel-reader.html 默认翻页 + 页宽落地 ---
const nr = rd('public/novel-reader.html');
assert.ok(/let readMode = 'page'/.test(nr), 'PC 小说阅读默认应为翻页模式');
assert.ok(nr.includes("PW[s.pageWidth] || PW.medium"), 'applyNovelSettings 应把页宽落到 .paged-inner');
assert.ok(nr.includes("data-rs-pagewidth"), '滚动模式也应响应 pageWidth');

// --- Android: 页宽设置持久化 ---
const store = rd('android/app/src/main/java/cn/cinemavault/app/reading/ReaderSettingsStore.kt');
assert.ok(store.includes('enum class NovelPageWidth'), '应有 NovelPageWidth 枚举');
assert.ok(store.includes('novel_page_width'), '页宽应持久化到 SharedPreferences');
assert.ok(/val pageWidth: NovelPageWidth/.test(store), 'NovelSettings 应含 pageWidth');

const sheet = rd('android/app/src/main/java/cn/cinemavault/app/reading/ReaderSettingsSheet.kt');
assert.ok(sheet.includes('页宽（每行字数）'), '设置面板应有页宽项');

// --- Android: 富文本 EPUB 翻页优先（仅 SCROLL 才 WebView） ---
const screen = rd('android/app/src/main/java/cn/cinemavault/app/ui/screen/NovelReaderScreen.kt');
assert.ok(screen.includes('val wantsScroll = settings.turnStyle == TurnStyle.SCROLL'),
    '仅滚动模式才保留 WebView 富文本');
assert.ok(screen.includes('stripHtmlForPaging'), '应有 HTML 剥离兜底供分页');
assert.ok(screen.includes('NovelPageWidth.NARROW'), '页宽应影响分页宽度');

// --- 云端在线阅读：文字小说章内分页 ---
const cr = rd('public/cloud-reader.html');
assert.ok(cr.includes('function splitIntoPages'), '云端阅读器应有章内分页函数');
assert.ok(cr.includes('subPages.length > 1'), '应支持章内多页翻页');
assert.ok(cr.includes('keepSub'), '章内翻页应保持子页');
assert.ok(cr.includes('pagedNovel'), '应区分文字小说分页与漫画整图');
assert.ok(cr.includes('RS.pageWidth'), '云端阅读器应响应页宽');

console.log('PASS 阅读器翻页改造：PC默认翻页+页宽 / Android EPUB分页+页宽 / 云端在线分页');
