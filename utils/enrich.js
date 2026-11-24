/**
 * utils/enrich.js —— 漫画 / 小说元数据补齐（round169）
 *
 * 目标：这两类作品入库时只有标题和文件名，tags/genres/作者全空，
 *       导致「标签库」永远是空的、也没法精准打标。
 *       本模块从「设置 → 数据源」里已启用的 Bangumi 书籍条目补齐：
 *         简介 / 作者 / 出版社 / 题材标签 / 发售日（封面可选）
 *
 * 三条纪律：
 *   1. **只填空字段**：已有值不动；`manualFields` 里标记过的手改字段一律让路
 *      （round132 的手改锁，不能被刮削覆盖）。
 *   2. **标题闸门**：清洗后去搜，取相似度最高且 ≥ minScore 的条目；不达标宁可不写，
 *      也不把「妹妹的美少女朋友…」这种结果写进《不良JK华子酱》。
 *   3. **可预演**：默认 dryRun，返回逐条「会写什么」，确认后才落库。
 */

const { BangumiBookCrawler, cleanBookTitle } = require('./crawler/bangumi-book');
const { pickBest } = require('./crawler/title-match');
const db = require('./db');

const LIB_TYPE = { novel: 'novel', comic: 'comic', anime: 'anime', film: 'film' };

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ★★ 非书名关键词拦截（真实事故）：
 *   漫画目录里混着大量「第12话」「2019年」「番外6」「人气投票」「休刊图」这类文件，
 *   它们不是作品，拿去搜索必然命中随机条目 —— 上一批就这样把《101匹わんちゃん》
 *   的作者写进了《全知读者视角》的元数据里。
 *   ⇒ 这类关键词一律跳过，宁可不补，也不写错。 */
const GENERIC_KEYWORD = /^(第?\d{1,4}[话話章回节節]?|第?\d{1,4}\s*[-~]\s*\d{1,4}[话話章回]?|\d{4}\s*年.*|番外.*|.*番外.*|.*人气投票.*|.*贺图.*|.*休刊.*|.*宣传.*|.*动画化.*|.*设定集.*|.*画集.*|.*cos.*|.*封面.*|.*特典.*|.*扫图.*|.*汉化.*)$/i;

/* ★★ 章节文件识别（真实事故的根治）：
 *   `12.主角-6_全知读者视角漫画_20241020160757` 是**同一部漫画的第 12 话**，
 *   当成独立作品去搜，必然命中随机条目。判定条件取最保守的两条：
 *     ① 文件名里带 8 位以上数字串（导出时间戳）；
 *     ② `数字.` 开头且下划线分段 ≥2（章节_系列_时间戳这种命名）。
 *   注意不能只写 /^\d+\./ —— `2.5次元的诱惑_01卷` 会被误杀（那是合法分卷）。
 */
function isChapterFile(title) {
    const t = String(title || '');
    if (/_\d{8,}/.test(t)) return true;
    return /^\d{1,4}\s*\./.test(t) && (t.match(/_/g) || []).length >= 2;
}

function isSearchableKeyword(kw) {
    const t = String(kw || '').trim();
    if (t.length < 3) return false;
    return !GENERIC_KEYWORD.test(t);
}

/**
 * 该库缺元数据的条目（缺简介或缺题材）
 * ★ sinceId 游标：批量跑时必须能「接着上次的 id 往下走」，
 *   否则没命中的条目会一直排在最前面，每批都重复撞一遍（单批 30 条永远刷不到第 31 条）。
 */
function listMissing(lib, limit = 10, sinceId = 0) {
    const type = LIB_TYPE[lib];
    if (!type) throw new Error('不支持的库: ' + lib);
    return db.db.prepare(`
        SELECT id, title, fileName, overview, genres, producer, publisher, releaseDate, manualFields
        FROM movies
        WHERE type = ?
          AND id > ?
          AND (overview IS NULL OR TRIM(overview) = '' OR genres IS NULL OR TRIM(genres) = '')
        ORDER BY id
        LIMIT ?
    `).all(type, sinceId, limit);
}

function lockedFields(row) {
    return new Set(String(row.manualFields || '').split(',').map(s => s.trim()).filter(Boolean));
}

function buildPatch(row, book) {
    const locked = lockedFields(row);
    const patch = {};
    if (!row.overview && book.summary && !locked.has('overview')) patch.overview = book.summary.slice(0, 2000);
    if (!row.producer && book.author && !locked.has('producer')) patch.producer = book.author;
    if (!row.publisher && book.publisher && !locked.has('publisher')) patch.publisher = book.publisher;
    if (!row.genres && book.tags && book.tags.length && !locked.has('genres')) patch.genres = book.tags.slice(0, 10).join(',');
    if (!row.releaseDate && book.date && !locked.has('releaseDate')) patch.releaseDate = book.date;
    return patch;
}

/**
 * 批量补齐
 * @returns { items: [...], stats: { scanned, matched, toWrite, written, skipped } }
 */
async function enrichLibrary(lib, opts = {}) {
    const limit = Math.min(60, Math.max(1, parseInt(opts.limit, 10) || 10));
    const dryRun = opts.dryRun !== false;
    const minScore = Math.min(0.95, Math.max(0.3, parseFloat(opts.minScore) || 0.6));
    const sinceId = Math.max(0, parseInt(opts.sinceId, 10) || 0);
    const rows = listMissing(lib, limit, sinceId);
    const crawler = new BangumiBookCrawler({ timeout: 15000 });

    /* ★ 预检：代理没起 / 网络断了就立刻失败。
     *   上一轮 200 部就是这么空跑的 —— 每条只记一句 fetch failed，
     *   跑完 2 分半才看出来「整个网络路径都没了」。 */
    try {
        await crawler.checkReachable();
    } catch (e) {
        throw new Error(`数据源不可达（${e.message}）—— 先确认「设置 → 数据源」里的代理是否在运行（当前 ${require('./config').network?.proxyServer || '直连'}）`);
    }

    const items = [];
    const stats = { scanned: rows.length, matched: 0, toWrite: 0, written: 0, skipped: 0 };
    let consecutiveFail = 0;

    for (const row of rows) {
        const keyword = cleanBookTitle(row.title) || cleanBookTitle(row.fileName);
        const item = { id: row.id, fileName: row.fileName, title: row.title, keyword, match: null, patch: {}, written: false, error: null };
        try {
            if (!keyword || keyword.length < 2) {
                item.error = '清洗后关键词为空';
                stats.skipped++;
                items.push(item);
                continue;
            }
            if (isChapterFile(row.title) || isChapterFile(row.fileName)) {
                item.error = '章节/单话文件，不单独补元数据';
                stats.skipped++;
                items.push(item);
                continue;
            }
            if (!isSearchableKeyword(keyword)) {
                item.error = '关键词不是书名（章节/番外/杂图），跳过';
                stats.skipped++;
                items.push(item);
                continue;
            }
            const hits = await crawler.search(keyword, 8);
            const best = pickBest(hits, keyword, minScore);
            if (!best) {
                item.error = `无足够相似的条目（${hits.length} 条候选）`;
                stats.skipped++;
                items.push(item);
                await _sleep(500);
                continue;
            }
            const book = await crawler.detail(best.id);
            item.match = { id: book.id, title: book.title, author: book.author, score: best.score ?? null, url: book.url };
            item.bookTags = book.tags || [];
            item.patch = buildPatch(row, book);
            stats.matched++;

            if (Object.keys(item.patch).length) {
                stats.toWrite++;
                if (!dryRun) {
                    const keys = Object.keys(item.patch);
                    const sets = keys.map(k => `${k} = ?`).join(', ');
                    db.db.prepare(`UPDATE movies SET ${sets} WHERE id = ?`)
                        .run(...keys.map(k => item.patch[k]), row.id);
                    item.written = true;
                    stats.written++;
                }
            }
            consecutiveFail = 0;
        } catch (e) {
            item.error = e.message.slice(0, 160);
            stats.skipped++;
            // 连续 3 次网络失败 ⇒ 直接中止，别把 200 条都撞一遍
            if (/fetch failed|ECONNREFUSED|timeout|network/i.test(e.message) && ++consecutiveFail >= 3) {
                throw new Error(`连续 ${consecutiveFail} 次网络失败，已中止（网络/代理可能中断）`);
            }
        }
        items.push(item);
        await _sleep(600); // Bangumi 限流友好
    }
    return { items, stats };
}

/** 两库元数据覆盖现状（给前端显示「还差多少」） */
function coverage() {
    const out = {};
    for (const [lib, type] of Object.entries(LIB_TYPE)) {
        const r = db.db.prepare(`
            SELECT COUNT(*) total,
                   SUM(CASE WHEN overview IS NOT NULL AND TRIM(overview) <> '' THEN 1 ELSE 0 END) withOverview,
                   SUM(CASE WHEN genres IS NOT NULL AND TRIM(genres) <> '' THEN 1 ELSE 0 END) withGenres,
                   SUM(CASE WHEN producer IS NOT NULL AND TRIM(producer) <> '' THEN 1 ELSE 0 END) withAuthor
            FROM movies WHERE type = ?
        `).get(type) || {};
        out[lib] = {
            total: r.total || 0,
            withOverview: r.withOverview || 0,
            withGenres: r.withGenres || 0,
            withAuthor: r.withAuthor || 0,
            missing: (r.total || 0) - Math.max(r.withOverview || 0, 0)
        };
    }
    return out;
}

module.exports = { enrichLibrary, coverage, listMissing, buildPatch, LIB_TYPE, isSearchableKeyword, isChapterFile, GENERIC_KEYWORD };