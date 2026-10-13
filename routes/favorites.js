/**
 * 收藏夹（round53）—— 「播放列表」升级而来的统一收藏入口。
 *
 * 板块（fav_links.board）：
 *   video  视频播放列表 —— 不是本表的板块！它继续用 playlists / playlist_items 两张表
 *          （routes/playlist.js），前端收藏夹视图的第一个标签页就是它。这里只管「网页收藏」。
 *   anime  想看的动漫
 *   comic  漫画
 *   novel  小说
 *   game   想玩的游戏
 *   web    其他网页（AV/里番等在线页默认落这里，用户可在保存弹窗里改）
 *
 * 条目从哪来（前端 saveToFav 统一入口）：
 *   - ACG 榜单详情弹窗「⭐ 收藏」（title+cover，url 可空）
 *   - 在线观看窗口工具条「⭐ 收藏本页」（整站反代 iframe 同源，能读到标题/og:image/真实地址）
 *   - 聚合搜索卡片「⭐」（存代理路径，点击回跳应用内）
 *
 * 图文展示：封面一律走 GET /api/acg/cover?u=<远程图>（utils/acg-rank 的缓存代理，
 *   probeFetch 代理优先直连补 —— 本机 DNS 污染的图床也能出图）。空封面给占位块。
 */

const express = require('express');
const router = express.Router();
const { db } = require('../utils/db');
const { probeFetch } = require('./webview');

const BOARDS = ['anime', 'comic', 'novel', 'game', 'web'];
const MAX_TITLE = 200;
const MAX_NOTE = 500;

db.exec(`
  CREATE TABLE IF NOT EXISTS fav_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT DEFAULT '',
    coverUrl TEXT DEFAULT '',
    note TEXT DEFAULT '',
    source TEXT DEFAULT '',
    addedAt INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_fav_links_board ON fav_links(board);
  -- 部分唯一索引：只有带 url 的条目才查重（榜单收藏 url 为空，允许同板块多条）
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fav_links_board_url ON fav_links(board, url) WHERE url != '';
`);

function cleanBoard(b) {
    b = String(b || '').trim();
    return BOARDS.indexOf(b) >= 0 ? b : '';
}

/** 抓页面 <title> 与 og:image —— 有封面/标题就少让用户手填一次。失败静默（收藏本身不依赖它）。 */
async function grabPageMeta(url) {
    const out = { title: '', coverUrl: '' };
    if (!/^https?:\/\//i.test(url || '')) return out;
    try {
        const r = await probeFetch(url, 12000);
        const html = (await r.text()).slice(0, 300000);
        const t = html.match(/<title[^>]*>([^<]{1,200})/i);
        if (t) out.title = t[1].replace(/\s+/g, ' ').trim();
        const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (og) {
            try { out.coverUrl = new URL(og[1], url).href; } catch (e) { /* 忽略坏地址 */ }
        }
    } catch (e) { /* 抓不到就用手填的 */ }
    return out;
}

// 列表：?board= 不传 → 全部（带每板块计数）
router.get('/links', (req, res) => {
    const board = cleanBoard(req.query.board);
    const rows = board
        ? db.prepare('SELECT * FROM fav_links WHERE board = ? ORDER BY addedAt DESC, id DESC').all(board)
        : db.prepare('SELECT * FROM fav_links ORDER BY addedAt DESC, id DESC').all();
    const counts = {};
    for (const r of db.prepare('SELECT board, COUNT(*) AS n FROM fav_links GROUP BY board').all()) counts[r.board] = r.n;
    res.json({ code: 0, data: rows, counts });
});

// 新增：url+board 唯一（重复收藏给明确提示而不是报错炸掉）；url 为空的榜单收藏按 title 去重
router.post('/links', async (req, res) => {
    const board = cleanBoard((req.body || {}).board);
    if (!board) return res.json({ code: -1, msg: '板块无效' });
    const title = String((req.body || {}).title || '').trim().slice(0, MAX_TITLE);
    const url = String((req.body || {}).url || '').trim();
    const note = String((req.body || {}).note || '').trim().slice(0, MAX_NOTE);
    const source = String((req.body || {}).source || '').trim().slice(0, 100);
    let coverUrl = String((req.body || {}).coverUrl || '').trim();
    if (!title && !url) return res.json({ code: -1, msg: '标题与地址至少要有一个' });

    // 补抓：没标题/没封面就去页面上拿一次（拿到哪个补哪个）
    if (url && (!title || !coverUrl)) {
        const meta = await grabPageMeta(url);
        if (!title && meta.title) return final(meta.title);
        if (!coverUrl && meta.coverUrl) coverUrl = meta.coverUrl;
    }
    return final(title);

    function final(t) {
        try {
            const dup = url
                ? db.prepare('SELECT id FROM fav_links WHERE board = ? AND url = ?').get(board, url)
                : db.prepare('SELECT id FROM fav_links WHERE board = ? AND url = \'\' AND title = ?').get(board, t);
            if (dup) return res.json({ code: 2, msg: '已经收藏过了', data: { id: dup.id } });
            const info = db.prepare('INSERT INTO fav_links (board,title,url,coverUrl,note,source,addedAt) VALUES (?,?,?,?,?,?,?)')
                .run(board, t || url, url, coverUrl, note, source, Date.now());
            res.json({ code: 0, data: { id: info.lastInsertRowid } });
        } catch (e) {
            res.json({ code: -1, msg: '保存失败：' + e.message });
        }
    }
});

// 改标题/备注/挪板块
router.put('/links/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM fav_links WHERE id = ?').get(req.params.id);
    if (!row) return res.json({ code: -1, msg: '条目不存在' });
    const b = req.body || {};
    const title = b.title !== undefined ? String(b.title).trim().slice(0, MAX_TITLE) : row.title;
    const note = b.note !== undefined ? String(b.note).trim().slice(0, MAX_NOTE) : row.note;
    const board = b.board !== undefined ? (cleanBoard(b.board) || row.board) : row.board;
    db.prepare('UPDATE fav_links SET title = ?, note = ?, board = ? WHERE id = ?').run(title, note, board, row.id);
    res.json({ code: 0 });
});

router.delete('/links/:id', (req, res) => {
    const info = db.prepare('DELETE FROM fav_links WHERE id = ?').run(req.params.id);
    res.json({ code: info.changes ? 0 : -1, msg: info.changes ? '' : '条目不存在' });
});

module.exports = router;
