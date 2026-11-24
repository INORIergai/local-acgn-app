/**
 * 2026-11 · 阅读书摘 / 划线（小说 + 漫画通用）
 *
 * 只存用户主动保存的原文选段（quote）+ 可选笔记/解释（note），不存整章正文。
 * 供三处使用：
 *   1) 阅读器里「摘抄 / 划线提问」保存；
 *   2) 阅读记录页的「书摘回顾」；
 *   3) 收藏夹里的「阅读书摘」入口。
 */
const { db } = require('./db');

const KIND_OF = (k) => (k === 'comic' ? 'comic' : (k === 'novel' ? 'novel' : ''));

function normText(s, max) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 4000);
}

function listNotes(opts) {
    const o = opts || {};
    const kind = KIND_OF(o.kind);
    const movieId = Number(o.movieId) || 0;
    const limit = Math.min(200, Math.max(1, Number(o.limit) || 50));
    const offset = Math.max(0, Number(o.offset) || 0);
    return db.prepare(`
        SELECT n.*, m.title AS bookTitle, m.posterPath, m.localPosterPath
        FROM reading_notes n
        LEFT JOIN movies m ON m.id = n.movieId
        WHERE (? = '' OR n.kind = ?) AND (? = 0 OR n.movieId = ?)
        ORDER BY n.createdAt DESC
        LIMIT ? OFFSET ?
    `).all(kind, kind, movieId, movieId, limit, offset);
}

function addNote(payload) {
    const p = payload || {};
    const movieId = Number(p.movieId);
    if (!Number.isFinite(movieId) || movieId <= 0) throw new Error('movieId 非法');
    const quote = normText(p.quote, 4000);
    if (!quote) throw new Error('摘抄内容不能为空');
    const kind = KIND_OF(p.kind) || 'novel';
    const note = normText(p.note, 2000);
    const chapter = Math.max(0, Number(p.chapter) || 0);
    const chapterTitle = normText(p.chapterTitle, 120);
    const source = ['manual', 'ai', 'ask'].includes(p.source) ? p.source : 'manual';
    const now = Date.now();
    const r = db.prepare(`
        INSERT INTO reading_notes (movieId, kind, chapter, chapterTitle, quote, note, source, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(movieId, kind, chapter, chapterTitle, quote, note, source, now);
    return { id: r.lastInsertRowid, movieId, kind, chapter, chapterTitle, quote, note, source, createdAt: now };
}

function deleteNote(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) throw new Error('id 非法');
    const r = db.prepare('DELETE FROM reading_notes WHERE id = ?').run(n);
    return { deleted: r.changes };
}

/** 书摘统计：总数 / 按类型 / 近 7 天新增 / 涉及书目数 */
function notesStats(kind) {
    const k = KIND_OF(kind);
    const where = k ? 'WHERE kind = ?' : '';
    const args = k ? [k] : [];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM reading_notes ${where}`).get(...args).n;
    const books = db.prepare(`SELECT COUNT(DISTINCT movieId) AS n FROM reading_notes ${where}`).get(...args).n;
    const weekAgo = Date.now() - 7 * 86400e3;
    const recent = k
        ? db.prepare('SELECT COUNT(*) AS n FROM reading_notes WHERE kind = ? AND createdAt >= ?').get(k, weekAgo).n
        : db.prepare('SELECT COUNT(*) AS n FROM reading_notes WHERE createdAt >= ?').get(weekAgo).n;
    return { total, books, recent };
}

module.exports = { listNotes, addNote, deleteNote, notesStats };
