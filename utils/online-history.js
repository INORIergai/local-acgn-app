/* 在线观看历史：站点解析播放的跨设备记录。
 * 只依赖 utils/db；不读 config.json、不接触本地媒体库。
 */
const db = require('./db').db;

const MAX_ROWS = 200;
const MAX_EPISODES = 200;
let lastClearAt = 0;
try {
    const row = db.prepare("SELECT value FROM online_history_meta WHERE key = 'lastClearAt'").get();
    lastClearAt = Number(row && row.value) || 0;
} catch (e) { /* 首次建表前不存在，按未清空处理 */ }

function text(v, max) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}
function httpUrl(v) {
    const s = String(v == null ? '' : v).trim();
    return /^https?:\/\//i.test(s) ? s.slice(0, 4000) : '';
}
function finite(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0;
}
function stamp(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Date.now() + 300000, Math.floor(n));
}
function normalize(raw) {
    const now = Date.now();
    const sourceId = text(raw && raw.sourceId, 200);
    const url = httpUrl(raw && raw.url);
    if (!sourceId || !url) throw new Error('缺少 sourceId 或播放地址不合法');
    const episodes = Array.isArray(raw.episodes) ? raw.episodes.slice(0, MAX_EPISODES).map((e) => {
        const name = text(e && e.name, 200);
        const u = httpUrl(e && e.url);
        return name && u ? { name, url: u } : null;
    }).filter(Boolean) : [];
    const updatedAt = stamp(raw.updatedAt || raw.at || raw.watchedAt, now);
    const watchedAt = stamp(raw.watchedAt || raw.at, updatedAt);
    const rawIndex = Number.isInteger(raw.index) ? raw.index : raw.episodeIndex;
    return {
        sourceId,
        url,
        title: text(raw.title, 300) || '未命名作品',
        episode: text(raw.episode, 200),
        sourceName: text(raw.sourceName, 120),
        workUrl: httpUrl(raw.workUrl),
        episodes: JSON.stringify(episodes),
        episodeIndex: Number.isInteger(rawIndex) && rawIndex >= 0 ? Math.min(rawIndex, MAX_EPISODES) : 0,
        kind: text(raw.kind, 40),
        position: finite(raw.position),
        duration: finite(raw.duration),
        completed: raw.completed ? 1 : 0,
        watchedAt,
        updatedAt
    };
}

const UPSERT = db.prepare(`
    INSERT INTO online_history
        (sourceId, url, title, episode, sourceName, workUrl, episodes, episodeIndex, kind,
         position, duration, completed, watchedAt, updatedAt)
    VALUES
        (@sourceId, @url, @title, @episode, @sourceName, @workUrl, @episodes, @episodeIndex, @kind,
         @position, @duration, @completed, @watchedAt, @updatedAt)
    ON CONFLICT(sourceId, url) DO UPDATE SET
        title = excluded.title,
        episode = excluded.episode,
        sourceName = excluded.sourceName,
        workUrl = excluded.workUrl,
        episodes = excluded.episodes,
        episodeIndex = excluded.episodeIndex,
        kind = excluded.kind,
        position = excluded.position,
        duration = excluded.duration,
        completed = excluded.completed,
        watchedAt = excluded.watchedAt,
        updatedAt = excluded.updatedAt
    WHERE excluded.updatedAt >= online_history.updatedAt
`);
const PRUNE = db.prepare(`
    DELETE FROM online_history
    WHERE id NOT IN (
        SELECT id FROM online_history ORDER BY updatedAt DESC, id DESC LIMIT ${MAX_ROWS}
    )
`);

function save(record) {
    if (record.updatedAt <= lastClearAt) return { changed: false, record };
    const info = UPSERT.run(record);
    return { changed: info.changes > 0, record };
}
function prune() {
    PRUNE.run();
}
function upsert(raw) {
    const result = save(normalize(raw));
    prune();
    return result;
}
function merge(items) {
    let merged = 0;
    let skipped = 0;
    const work = db.transaction((list) => {
        for (const item of list) {
            try {
                const r = save(normalize(item));
                if (r.changed) merged++;
            } catch (e) {
                skipped++;
            }
        }
    });
    work(Array.isArray(items) ? items.slice(0, 1000) : []);
    prune();
    return { merged, skipped };
}
function parseEpisodes(raw) {
    try {
        const list = JSON.parse(raw || '[]');
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}
function rowToClient(row) {
    return {
        id: row.id,
        title: row.title,
        episode: row.episode,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        url: row.url,
        workUrl: row.workUrl,
        episodes: parseEpisodes(row.episodes),
        index: row.episodeIndex,
        kind: row.kind,
        position: row.position,
        duration: row.duration,
        completed: !!row.completed,
        at: row.watchedAt,
        updatedAt: row.updatedAt
    };
}
function list(limit) {
    const n = Math.max(1, Math.min(MAX_ROWS, Number(limit) || 60));
    return db.prepare('SELECT * FROM online_history ORDER BY updatedAt DESC, id DESC LIMIT ?')
        .all(n)
        .map(rowToClient);
}
function clear() {
    const changed = db.prepare('DELETE FROM online_history').run().changes;
    lastClearAt = Date.now();
    db.prepare(`INSERT INTO online_history_meta (key, value) VALUES ('lastClearAt', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(lastClearAt));
    return changed;
}
function remove(sourceId, url) {
    const s = text(sourceId, 200);
    const u = httpUrl(url);
    if (!s || !u) return 0;
    return db.prepare('DELETE FROM online_history WHERE sourceId = ? AND url = ?').run(s, u).changes;
}

module.exports = { normalize, upsert, merge, list, clear, remove, MAX_ROWS };
