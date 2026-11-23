/* 批量实测 subs/kazumi 下每个规则：搜索 "葬送的芙莉莲" → 有结果则取第一条剧集数 */
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../utils/media-sources/engine');

(async () => {
    const dir = path.join(__dirname, '..', 'utils', 'media-sources', 'subs', 'kazumi');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const kw = process.argv[2] || '葬送的芙莉莲';
    console.log('rules:', files.length, '| keyword:', kw);
    const rows = [];
    for (const f of files) {
        const name = f.replace(/\.json$/, '');
        const src = engine.getSource('kazumi/' + name);
        if (!src) { rows.push([name, 'NO-SOURCE', 0, 0, '']); continue; }
        try {
            const r = await engine.searchOn(src, kw, { timeout: 15000 });
            const n = (r.items || []).length;
            let eps = 0;
            if (n > 0) {
                try {
                    const e = await engine.episodesOf(src, r.items[0].url, { timeout: 15000 });
                    eps = (e.episodes || []).length;
                } catch (e2) { eps = -1; }
            }
            rows.push([name, r.state, n, eps, (r.error || '').slice(0, 46)]);
        } catch (e) {
            rows.push([name, 'THROW', 0, 0, String(e.message || e).slice(0, 46)]);
        }
    }
    console.log('\nname | state | hits | eps | error');
    for (const r of rows) console.log(' ', r.join(' | '));
    const good = rows.filter((r) => r[2] > 0);
    console.log('\n有结果的源:', good.length, '/', rows.length);
    const playable = rows.filter((r) => r[3] > 0);
    console.log('能解析剧集的源:', playable.length);
})();
