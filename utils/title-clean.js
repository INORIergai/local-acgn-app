/**
 * 标题美化（round112）
 *
 * 起因：库内漫画/小说的文件名普遍是下载站的原始形态，例如
 *   `[Kmoe][監禁王]卷02.epub`
 *   `博兹特写集 (【英】狄更斯) (Z-Library).epub`
 *   `芭芭雅嘎下了个蛋 (… ) (z-library.sk, 1lib.sk, z-lib.sk).mobi`
 * 旧扫描器直接把「去扩展名的文件名」当标题 → 用户看到一屏 `[Kmoe][…]`。
 * 而网络刮削恰恰是这个库最不可靠的一环（源常年要登录），指望它改标题等于不改。
 *
 * 规则（刻意保守，宁可少改也不改错）：
 *   1. 头部连续的「站点/格式标签」方括号剥掉：[Kmoe] [kzo.moe] [汉化组] [epub] …
 *   2. 剥掉过站点标签后，紧跟的第一个方括号是真正的标题 → 去括号化（[監禁王]卷02 → 監禁王 卷02）
 *   3. 尾部的站点标签圆括号剥掉：(Z-Library) (z-library.sk, 1lib.sk, z-lib.sk)
 *   4. 任何一步如果会把名字剥空，就停手（整名都是标签时保持原样）
 *
 * 纯函数、零 IO、零网络。
 */

const SITE_TAG_RE = /^(kmoe|kzo|kxx|kzz|koz|kox|moe|moex|mox|kzo\.moe|kxx\.moe|kzz\.moe|koz\.moe|mox\.moe|zh\.moe|zlibrary|z-lib|zlib|1lib|libgen|lib\.io|z-library|漫画|漫畫|漢化|汉化|汉化组|漢化組|中漫|中文|简体|繁體|繁体|全彩|完结|完結|连载|連載|raw|scan|电子书|電子書|精校|精校版|全本|完整版|epub|mobi|azw3|txt|pdf)$/i;

/** 尾部站点标签（圆/方/六角括号整段） */
const TRAIL_TAG_RE = /\s*[（(\[【]\s*(?:z-?library[^)\]】）]*|z-?lib[^)\]】）]*|1lib[^)\]】）]*|libgen[^)\]】）]*|lib\.io[^)\]】）]*)\s*[)\]】）]\s*$/i;

function prettyTitle(name) {
    let s = String(name || '').trim();
    if (!s) return '';

    // 尾部站点标签（最多剥两层）
    for (let i = 0; i < 2; i++) {
        const next = s.replace(TRAIL_TAG_RE, '').trim();
        if (next === s || !next) break;
        s = next;
    }

    // 头部站点标签
    let strippedTag = 0;
    for (let i = 0; i < 4; i++) {
        const m = /^[[【(（]\s*([^\]】)）]{1,24})\s*[\]】)）]\s*/.exec(s);
        if (!m) break;
        if (!SITE_TAG_RE.test(m[1].trim())) break;
        const rest = s.slice(m[0].length).trim();
        if (!rest) break;
        s = rest;
        strippedTag++;
    }

    // 剥过站点标签 → 紧跟的方括号是标题本体，去括号
    // ★ 编号部分用空格隔开（「監禁王 卷02」而不是「監禁王卷02」）：
    //   extractSeriesKey 的卷号剥离规则依赖「卷号前有空格或行首」，
    //   直接黏成「監禁王卷02」会剥出一半（剩「監禁王卷」），系列名跟着变脏。
    if (strippedTag > 0) {
        const m = /^[[【]\s*([^\]】]{2,})\s*[\]】]\s*([\s\S]*)$/.exec(s);
        if (m && m[2] && m[2].trim()) s = (m[1].trim() + ' ' + m[2].trim()).replace(/\s+/g, ' ').trim();
    }

    return s || String(name || '').trim();
}

module.exports = { prettyTitle, SITE_TAG_RE, cleanStoredTitles };

/**
 * 存量标题清理：把库里「已经是脏名字」的记录就地修一遍。
 *
 * 为什么需要单独一步：扫描只处理「磁盘上新增的文件」，本轮之前入库的 1223 条漫画
 * 用的是旧逻辑（标题 = 去扩展名的文件名），它们不会因为改了扫描器就自动变好。
 * 这一步在每次扫描收尾时跑一遍，幂等、只改真正需要改的行（改标题会触发 FTS 重建，
 * 所以必须「变了才写」）。实测 2351 + 4095 行全扫一遍约 60ms。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} types
 * @param {(s:string)=>void} [log]
 * @returns {{scanned:number, changed:number}}
 */
function cleanStoredTitles(db, types, log) {
    const list = Array.isArray(types) && types.length ? types : ['comic', 'novel'];
    const ph = list.map(() => '?').join(',');
    let rows = [];
    try {
        rows = db.prepare(`SELECT id, title FROM movies WHERE type IN (${ph}) AND title IS NOT NULL AND TRIM(title) <> ''`).all(...list);
    } catch (e) {
        return { scanned: 0, changed: 0 };
    }
    const upd = db.prepare('UPDATE movies SET title = ? WHERE id = ?');
    let changed = 0;
    const tx = db.transaction(() => {
        for (const r of rows) {
            const t = String(r.title);
            // 只有可能变脏的名字才跑正则（含括号），纯名字直接跳过
            if (t.indexOf('[') < 0 && t.indexOf('【') < 0 && t.indexOf('(Z-') < 0 && t.indexOf('(z-') < 0) continue;
            const clean = prettyTitle(t);
            if (clean && clean !== t) { upd.run(clean, r.id); changed++; }
        }
    });
    try { tx(); } catch (e) {
        if (typeof log === 'function') log('存量标题清理失败：' + e.message);
        return { scanned: rows.length, changed: 0 };
    }
    if (changed && typeof log === 'function') log(`存量标题清理：${changed}/${rows.length} 条已美化`);
    return { scanned: rows.length, changed };
}
