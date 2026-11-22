/* 真实站点搜索探针：验证漫画跨源搜索在当前网络下至少 2 个源有结果，
 * 且首个候选能取到章节。不读写用户数据、不打印任何凭据。 */
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const reading = require(path.join(root, 'utils', 'media-sources', 'reading.js'));

const QUERIES = ['海贼王', '葬送的芙莉莲'];

(async () => {
    let okSourcesTotal = 0;
    for (const q of QUERIES) {
        console.log('\n=== 搜索：' + q + ' ===');
        const groups = await reading.searchAll(q, { kind: 'manga' });
        let okCount = 0;
        let firstCandidate = null;
        for (const g of groups) {
            if (g.ok && g.items.length) {
                okCount++;
                if (!firstCandidate) firstCandidate = { adapter: g.adapter, item: g.items[0] };
                console.log(`  [OK] ${g.name}(${g.adapter}): ${g.items.length} 条 · 首条「${g.items[0].name}」`);
            } else {
                console.log(`  [--] ${g.name}(${g.adapter}): ${g.ok ? '0 条' : '失败 ' + g.error}`);
            }
        }
        okSourcesTotal = Math.max(okSourcesTotal, okCount);
        if (firstCandidate) {
            const ad = reading.getAdapter(firstCandidate.adapter);
            try {
                const d = await ad.chapters(firstCandidate.item.url);
                console.log(`  → 首候选取章节成功：${firstCandidate.adapter} 「${d.title}」共 ${(d.chapters || []).length} 章`);
            } catch (e) {
                console.log(`  → 首候选取章节失败：${firstCandidate.adapter} ${e.message}`);
            }
        }
    }
    console.log('\nRESULT 至少 2 个源有结果：' + (okSourcesTotal >= 2 ? 'PASS' : 'FAIL') + `（最多 ${okSourcesTotal} 源）`);
    process.exit(okSourcesTotal >= 2 ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
