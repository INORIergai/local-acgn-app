const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../db/movie.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('wal_autocheckpoint = 1000');
db.pragma('CHECKPOINT');

// 增加连接状态标记，解决重复关闭报错
let _dbIsOpen = true;

// 进程正常退出执行checkpoint，把wal合并入主库，防止数据残留在wal文件
function safeDbClose() {
  if (!_dbIsOpen) return;
  try {
    db.pragma('CHECKPOINT');
    db.close();
    _dbIsOpen = false;
    console.log('[db关闭] 数据库已正常关闭');
  } catch (e) {
    _dbIsOpen = false;
    console.log('[db关闭]', e.message);
  }
}
process.on('SIGINT', safeDbClose);
process.on('SIGTERM', safeDbClose);

// ========== 空库引导：无 movies 表时执行完整建库脚本 ==========
function bootstrapSchema() {
  const hasMovies = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='movies'"
  ).get();
  if (hasMovies) return;
  const schemaPath = path.join(__dirname, '../db/schema.sql');
  if (fs.existsSync(schemaPath)) {
    console.log('[数据库] 检测到空库，正在执行 db/schema.sql 建库...');
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
    console.log('[数据库] 建库完成');
  } else {
    console.error('[数据库] 警告：movies 表不存在且 db/schema.sql 缺失，无法建库');
  }
}
bootstrapSchema();

// ========== FTS5 全文索引（标题/番号/文件名/简介），供 Ctrl+K 快速搜索 ==========
function ensureFts() {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS movies_fts USING fts5(
        title, cleanName, avid, fileName, overview,
        content='movies', content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS movies_fts_insert AFTER INSERT ON movies BEGIN
        INSERT INTO movies_fts(rowid, title, cleanName, avid, fileName, overview)
        VALUES (new.id, new.title, new.cleanName, new.avid, new.fileName, new.overview);
      END;

      CREATE TRIGGER IF NOT EXISTS movies_fts_delete AFTER DELETE ON movies BEGIN
        INSERT INTO movies_fts(movies_fts, rowid, title, cleanName, avid, fileName, overview)
        VALUES ('delete', old.id, old.title, old.cleanName, old.avid, old.fileName, old.overview);
      END;
    `);

    // ⚠️ movies_fts_update 必须**先 DROP 再建**，不能用 IF NOT EXISTS。
    // 历史版本的这个触发器是无条件触发（AFTER UPDATE 无 WHEN），而 movies_fts 是
    // content='movies' 的外部内容表：更新任何一列（哪怕只改 producer）都会让
    // 「FTS5 delete + insert」这套手写语句的 delete 失效，紧接着的 insert 撞上
    // 已存在的 rowid → SQLITE_CONSTRAINT_PRIMARYKEY。
    // 结果就是**整张 movies 表任何 UPDATE 都失败**（收藏/评分/播放次数/重新刮削全挂）。
    // 正确做法：只在「被索引的那几列真的变了」时才重建该行，其余更新完全不碰索引。
    db.exec(`DROP TRIGGER IF EXISTS movies_fts_update`);
    db.exec(`
      CREATE TRIGGER movies_fts_update AFTER UPDATE ON movies
      WHEN old.title IS NOT new.title
        OR old.cleanName IS NOT new.cleanName
        OR old.avid IS NOT new.avid
        OR old.fileName IS NOT new.fileName
        OR old.overview IS NOT new.overview
      BEGIN
        INSERT INTO movies_fts(movies_fts, rowid, title, cleanName, avid, fileName, overview)
        VALUES ('delete', old.id, old.title, old.cleanName, old.avid, old.fileName, old.overview);
        INSERT INTO movies_fts(rowid, title, cleanName, avid, fileName, overview)
        VALUES (new.id, new.title, new.cleanName, new.avid, new.fileName, new.overview);
      END;
    `);
    // 已有数据回填：rebuild 会从 content 表（movies）重建整个索引。
    // 注意不能用 COUNT(*) FROM movies_fts 判断（外部内容表它读的是 movies 本身，
    // 索引为空时也非零），要看索引影子表 movies_fts_data。
    const movieCount = db.prepare('SELECT COUNT(*) as c FROM movies').get().c;
    const idxCount = db.prepare('SELECT COUNT(*) as c FROM movies_fts_data').get().c;
    if (movieCount > 0 && idxCount === 0) {
      db.prepare(`INSERT INTO movies_fts(movies_fts) VALUES('rebuild')`).run();
      console.log('[FTS] 已回填全文索引');
    }
  } catch (e) {
    console.log('[FTS] 全文索引初始化失败（不影响其他功能）:', e.message);
  }
}

/* ★ 2026-09-25 round27：FTS 影子表损坏自愈
 *
 * 症状（实测踩到）：`PRAGMA integrity_check` 返回 ok、所有表都能 COUNT(*)，
 *   但**任何会触发 movies_fts_update 的 UPDATE 都报 `database disk image is malformed`**。
 *   于是「编辑标题 / 重命名 / 重新刮削写片名」全部失败，前端只显示「保存失败」，
 *   看起来像前端 bug，实际是 SQLite B-tree（FTS 影子表 movies_fts_data/_idx/_docsize）
 *   里指向的页坏了。
 * 判据：真正去 FTS 里写一次（delete+insert 同一行），在事务里做完再强制回滚 ——
 *   能写通就是好的，抛 malformed 就是坏的。比 integrity-check 命令准（后者对
 *   外部内容表不检查影子表的一致性）。
 * 修法：`INSERT INTO movies_fts(movies_fts) VALUES('rebuild')`，从 movies 重建整索引。
 */
function ftsIsWritable() {
  let row;
  try {
    row = db.prepare('SELECT id, title, cleanName, avid, fileName, overview FROM movies LIMIT 1').get();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!row) return { ok: true };   // 空库无从判断，当作可写

  const ROLLBACK = '__fts_probe_rollback__';
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO movies_fts(movies_fts, rowid, title, cleanName, avid, fileName, overview)
                  VALUES ('delete', ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.title, row.cleanName, row.avid, row.fileName, row.overview);
      db.prepare(`INSERT INTO movies_fts(rowid, title, cleanName, avid, fileName, overview)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.title, row.cleanName, row.avid, row.fileName, row.overview);
      throw new Error(ROLLBACK);   // 探测完立刻回滚，不留任何改动
    })();
    return { ok: true };
  } catch (e) {
    if (e.message === ROLLBACK) return { ok: true };
    return { ok: false, error: e.message };
  }
}

/** 重建全文索引。可被路由 / 扫描器在撞到 malformed 时调用。 */
function rebuildFts(reason) {
  try {
    const t0 = Date.now();
    db.prepare(`INSERT INTO movies_fts(movies_fts) VALUES('rebuild')`).run();
    console.log(`[FTS] 已重建全文索引${reason ? '（' + reason + '）' : ''}，用时 ${Date.now() - t0}ms`);
    // round34 批次B：数据库自愈 → 站内通知（函数内延迟 require，避免与 notify.js 循环依赖）
    if (reason) {
      try {
        require('./notify').notify('dbHeal', '🛠️ 数据库已自动修复',
          `检测到全文索引损坏并已自动重建（${reason}），数据未丢失。`, { level: 'warn' });
      } catch (e) { /* 通知失败不影响自愈 */ }
    }
    return { ok: true };
  } catch (e) {
    console.log('[FTS] 重建失败:', e.message);
    return { ok: false, error: e.message };
  }
}

/** 启动自检：索引坏了就重建，避免「所有标题类写入全失败」这种隐性全站故障。 */
function healFtsAtStartup() {
  const probe = ftsIsWritable();
  if (probe.ok) return probe;
  console.log('[FTS] ⚠️ 检测到全文索引损坏（写入探测失败）:', probe.error);
  return rebuildFts('启动自愈');
}

/** 「malformed」类错误 = 库/索引物理损坏，值得先自愈再重试一次 */
function isMalformedError(e) {
  const m = (e && e.message) || '';
  return /malformed|database disk image/i.test(m);
}

/**
 * 包一层：写入时若撞到 malformed，先重建 FTS 再重试一次。
 * 用于「标题 / 文件名 / 番号 / 简介」这类会触发 FTS 的写操作。
 */
function withFtsHeal(fn, label) {
  try {
    return fn();
  } catch (e) {
    if (!isMalformedError(e)) throw e;
    console.log(`[FTS] ${label || '写入'} 撞到损坏，自动重建后重试:`, e.message);
    rebuildFts(label || '写入自愈');
    return fn();   // 重建后再试一次；仍失败就把错误抛给上层
  }
}

ensureFts();
healFtsAtStartup();

// ========== 自动迁移：补全缺失字段 ==========
function migrate() {
  const movieColumns = db.prepare('PRAGMA table_info(movies)').all();
  const movieFields = movieColumns.map(c => c.name);

  const addMovieFields = [
    ['type', 'TEXT DEFAULT "jav"'],
    ['rating', 'REAL DEFAULT 0'],
    ['note', 'TEXT DEFAULT ""'],
    ['hotScore', 'REAL DEFAULT 0'],
    ['watched', 'INTEGER DEFAULT 0'],
    ['addedTime', 'INTEGER DEFAULT 0']
  ];

  for (const [name, def] of addMovieFields) {
    if (!movieFields.includes(name)) {
      db.exec(`ALTER TABLE movies ADD COLUMN ${name} ${def}`);
      console.log(`[数据库迁移] movies 表新增字段: ${name}`);
    }
  }

  const actressColumns = db.prepare('PRAGMA table_info(actresses)').all();
  const actressFields = actressColumns.map(c => c.name);

  const addActressFields = [
    ['followed', 'INTEGER DEFAULT 0'],
    ['debutDate', 'TEXT DEFAULT ""'],
    ['bloodType', 'TEXT DEFAULT ""'],
    ['hobby', 'TEXT DEFAULT ""']
  ];

  for (const [name, def] of addActressFields) {
    if (!actressFields.includes(name)) {
      db.exec(`ALTER TABLE actresses ADD COLUMN ${name} ${def}`);
      console.log(`[数据库迁移] actresses 表新增字段: ${name}`);
    }
  }

  const tagColumns = db.prepare('PRAGMA table_info(tags)').all();
  const tagFields = tagColumns.map(c => c.name);

  const addTagFields = [
    ['movieCount', 'INTEGER DEFAULT 0'],
    ['hotScore', 'REAL DEFAULT 0']
  ];

  for (const [name, def] of addTagFields) {
    if (!tagFields.includes(name)) {
      db.exec(`ALTER TABLE tags ADD COLUMN ${name} ${def}`);
      console.log(`[数据库迁移] tags 表新增字段: ${name}`);
    }
  }

  // notifications 表字段迁移
  const notifColumns = db.prepare('PRAGMA table_info(notifications)').all();
  const notifFields = notifColumns.map(c => c.name);

  const addNotifFields = [
    ['cover', 'TEXT DEFAULT ""'],
    ['extra', 'TEXT DEFAULT ""']
  ];

  for (const [name, def] of addNotifFields) {
    if (!notifFields.includes(name)) {
      db.exec(`ALTER TABLE notifications ADD COLUMN ${name} ${def}`);
      console.log(`[数据库迁移] notifications 表新增字段: ${name}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS watch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movieId INTEGER NOT NULL,
      playTime INTEGER NOT NULL,
      duration REAL DEFAULT 0,
      FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE
    )
  `);

  // 阅读时长统计表（漫画/小说）
  db.exec(`
    CREATE TABLE IF NOT EXISTS reading_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      movieId INTEGER NOT NULL,
      type TEXT DEFAULT 'comic',
      duration INTEGER DEFAULT 0,
      readDate INTEGER DEFAULT 0,
      FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reading_history_movie ON reading_history(movieId);
    CREATE INDEX IF NOT EXISTS idx_reading_history_date ON reading_history(readDate);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      searchTime INTEGER NOT NULL,
      resultCount INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      createdAt INTEGER DEFAULT 0,
      movieCount INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS playlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlistId INTEGER NOT NULL,
      movieId INTEGER NOT NULL,
      sortOrder INTEGER DEFAULT 0,
      addedAt INTEGER DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT DEFAULT 'info',
      title TEXT NOT NULL,
      content TEXT,
      url TEXT,
      read INTEGER DEFAULT 0,
      createdAt INTEGER DEFAULT 0
    );
  `);

  // 播放进度（续播）
  db.exec(`
    CREATE TABLE IF NOT EXISTS playback_progress (
      movieId INTEGER PRIMARY KEY,
      position REAL DEFAULT 0,
      duration REAL DEFAULT 0,
      updatedAt INTEGER DEFAULT 0,
      FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE
    );
  `);

  // 刮削失败记录（供一键重刮）
  db.exec(`
    CREATE TABLE IF NOT EXISTS scrape_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filePath TEXT UNIQUE NOT NULL,
      movieId INTEGER,
      type TEXT DEFAULT 'jav',
      reason TEXT DEFAULT '',
      failedAt INTEGER DEFAULT 0,
      retryCount INTEGER DEFAULT 0
    );
  `);

  // 网盘条目（星标 + 打开历史），一张表服务两个需求
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_items (
      fid TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      is_dir INTEGER DEFAULT 0,
      pdir_fid TEXT DEFAULT '0',
      size INTEGER DEFAULT 0,
      kind TEXT DEFAULT '',
      starred INTEGER DEFAULT 0,
      starred_at INTEGER DEFAULT 0,
      last_opened INTEGER DEFAULT 0,
      open_count INTEGER DEFAULT 0
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_movie_hotscore ON movies(hotScore DESC);
    CREATE INDEX IF NOT EXISTS idx_movie_playcount ON movies(playCount DESC);
    CREATE INDEX IF NOT EXISTS idx_movie_lastplay ON movies(lastPlayTime DESC);
    CREATE INDEX IF NOT EXISTS idx_movie_watched ON movies(watched);
    CREATE INDEX IF NOT EXISTS idx_movie_added ON movies(addedTime DESC);
    CREATE INDEX IF NOT EXISTS idx_movie_release ON movies(releaseDate DESC);
    CREATE INDEX IF NOT EXISTS idx_watch_history_movie ON watch_history(movieId);
    CREATE INDEX IF NOT EXISTS idx_watch_history_time ON watch_history(playTime DESC);
    CREATE INDEX IF NOT EXISTS idx_playlist_items_pl ON playlist_items(playlistId);
    CREATE INDEX IF NOT EXISTS idx_playlist_items_movie ON playlist_items(movieId);
  `);
}

migrate();

// ========== 预编译语句 ==========

const upsertMovie = db.prepare(`
  INSERT INTO movies (
    filePath, fileName, type, avid, cleanName, fileSize, duration, width, height,
    tmdbId, title, originalTitle, overview, releaseDate, posterPath, localPosterPath,
    country, genres, producer, publisher, serial, director, score, source, lastScanTime,
    addedTime
  ) VALUES (
    @filePath, @fileName, COALESCE(@type, 'jav'), @avid, @cleanName, @fileSize, @duration, @width, @height,
    @tmdbId, @title, @originalTitle, @overview, @releaseDate, @posterPath, @localPosterPath,
    @country, @genres, @producer, @publisher, @serial, @director, @score, @source, @lastScanTime,
    COALESCE(@addedTime, strftime('%s', 'now') * 1000)
  ) ON CONFLICT(filePath) DO UPDATE SET
    type=COALESCE(@type, 'jav'),
    avid=@avid,
    cleanName=@cleanName,
    duration=@duration,
    width=@width,
    height=@height,
    tmdbId=@tmdbId,
    title=@title,
    originalTitle=@originalTitle,
    overview=@overview,
    releaseDate=@releaseDate,
    posterPath=COALESCE(@posterPath, posterPath),
    localPosterPath=COALESCE(@localPosterPath, localPosterPath),
    country=@country,
    genres=@genres,
    producer=@producer,
    publisher=@publisher,
    serial=@serial,
    director=@director,
    score=@score,
    source=@source,
    lastScanTime=@lastScanTime
`);

// 【新增】仅更新本地海报，单字段更新，不会触碰其他字段，海报下载接口优先调用
const updateLocalPoster = db.prepare(`
  UPDATE movies SET localPosterPath = @localPosterPath WHERE id = @id
`);

/**
 * 从 cleanName / title 里补匹配已存在女优（2026-09-21）
 * 刮削返回的 actresses 经常是空的或连体名，单靠它会导致大量影片无人可关联。
 * 规则：只关联「已存在」的女优，不新建条目 —— 不会引入新垃圾；
 *       长名(>=4)允许子串命中，短名要求独立 token，避免 '雫' 这类误伤。
 */
const getAllActressNames = db.prepare(`SELECT id, name FROM actresses WHERE length(name) >= 2`);
let _actressNameCache = null;
function linkActressesFromText(movieId, text) {
  if (!text) return 0;
  if (!_actressNameCache) _actressNameCache = getAllActressNames.all();
  const tokens = new Set(String(text).split(/[\s　]+/));
  let added = 0;
  for (const row of _actressNameCache) {
    const name = row.name;
    const hit = name.length >= 4 ? text.includes(name) : tokens.has(name);
    if (hit) {
      const r = addMovieActress.run(movieId, row.id);
      if (r.changes > 0) added++;
    }
  }
  return added;
}
// 女优表被外部修正后调一次，让缓存重新加载
function invalidateActressNameCache() { _actressNameCache = null; }

/**
 * 原子事务：写入影片+标签女优，要么全部成功，要么全部回滚
 * scanner扫描文件请调用这个函数，不要再分开 upsertMovie + updateMovieRelations
 */
const upsertMovieAndRelations = db.transaction((movieObj, { tags = [], actresses = [] }) => {
  upsertMovie.run(movieObj);
  const row = getMovieByPath.get(movieObj.filePath);
  if (!row) throw new Error('写入movie后无法读取记录');
  const movieId = row.id;

  removeMovieTags.run(movieId);

  // 【2026-09-21 修复】刮削没给到女优时，不再清空已有关联 ——
  // 此前每次增量扫描都会把人工/文本匹配补出的关联一并抹掉（1687→1016 的教训）。
  if (actresses.length > 0) {
    removeMovieActresses.run(movieId);
    for (const actressName of actresses) {
      if (!actressName || !actressName.trim()) continue;
      const name = actressName.trim();
      upsertActress.run({ name, originalName: name });
      const actress = getActressByName.get(name);
      if (actress) addMovieActress.run(movieId, actress.id);
    }
  }

  for (const tagName of tags) {
    if (!tagName || !tagName.trim()) continue;
    const name = tagName.trim();
    upsertTag.run({ name, category: 'genre' });
    const tag = getTagByName.get(name);
    if (tag) addMovieTag.run(movieId, tag.id);
  }

  // 无论刮削给没给，都用片名文本兜底补关联（只加不删）
  linkActressesFromText(movieId, movieObj.cleanName || movieObj.title || '');
  return movieId;
});

// ========== 影片查询 ==========
const getAllMovies = db.prepare(`SELECT * FROM movies ORDER BY hotScore DESC, lastScanTime DESC`);

const getMoviesByHot = db.prepare(`SELECT * FROM movies ORDER BY hotScore DESC, lastScanTime DESC LIMIT ? OFFSET ?`);

const getMoviesByRecent = db.prepare(`SELECT * FROM movies ORDER BY addedTime DESC, id DESC LIMIT ? OFFSET ?`);

const getMoviesByPlayCount = db.prepare(`SELECT * FROM movies ORDER BY playCount DESC, lastPlayTime DESC LIMIT ? OFFSET ?`);

const getMoviesByRelease = db.prepare(`SELECT * FROM movies ORDER BY releaseDate DESC, id DESC LIMIT ? OFFSET ?`);

const getUnwatchedMovies = db.prepare(`SELECT * FROM movies WHERE watched = 0 ORDER BY addedTime DESC LIMIT ? OFFSET ?`);

const getFavoriteMovies = db.prepare(`SELECT * FROM movies WHERE favorite = 1 ORDER BY hotScore DESC, lastScanTime DESC`);

const searchMovies = db.prepare(`
  SELECT * FROM movies
  WHERE title LIKE @kw OR fileName LIKE @kw OR originalTitle LIKE @kw OR avid LIKE @kw
  ORDER BY hotScore DESC, lastScanTime DESC
`);

const getMovieById = db.prepare(`SELECT * FROM movies WHERE id = ?`);
const getMovieByPath = db.prepare(`SELECT * FROM movies WHERE filePath = ?`);

const getMoviesByActress = db.prepare(`
  SELECT m.* FROM movies m
  JOIN movie_actress ma ON ma.movieId = m.id
  WHERE ma.actressId = ?
  ORDER BY m.releaseDate DESC, m.id DESC
`);

const getMoviesByTag = db.prepare(`
  SELECT m.* FROM movies m
  JOIN movie_tag mt ON mt.movieId = m.id
  WHERE mt.tagId = ?
  ORDER BY m.hotScore DESC, m.lastScanTime DESC
`);

function getMoviesByTags(tagIds) {
  if (!tagIds || !tagIds.length) return [];
  const placeholders = tagIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT m.* FROM movies m
    JOIN movie_tag mt ON mt.movieId = m.id
    WHERE mt.tagId IN (${placeholders})
    GROUP BY m.id
    HAVING COUNT(DISTINCT mt.tagId) = ?
    ORDER BY m.hotScore DESC, m.lastScanTime DESC
  `);
  return stmt.all(...tagIds, tagIds.length);
}

const getSimilarMovies = db.prepare(`
  SELECT m.*, COUNT(mt2.tagId) as commonTags
  FROM movies m
  JOIN movie_tag mt2 ON mt2.movieId = m.id
  WHERE m.id != @movieId AND mt2.tagId IN (
    SELECT tagId FROM movie_tag WHERE movieId = @movieId
  )
  GROUP BY m.id
  ORDER BY commonTags DESC, m.hotScore DESC
  LIMIT @limit
`);

const getRandomMovies = db.prepare(`
  SELECT * FROM movies
  ORDER BY RANDOM()
  LIMIT ?
`);

// ========== 播放记录 ==========
const updatePlayRecord = db.prepare(`
  UPDATE movies SET 
    playCount = playCount + 1, 
    lastPlayTime = @time, 
    watched = 1,
    hotScore = hotScore + 1
  WHERE id = @id
`);

const addWatchHistory = db.prepare(`
  INSERT INTO watch_history (movieId, playTime, duration) VALUES (?, ?, ?)
`);

const getWatchHistory = db.prepare(`
  SELECT wh.*, m.title, m.localPosterPath, m.avid, m.duration
  FROM watch_history wh
  JOIN movies m ON m.id = wh.movieId
  ORDER BY wh.playTime DESC
  LIMIT ? OFFSET ?
`);

// ========== 搜索历史 ==========
const addSearchHistory = db.prepare(`
  INSERT INTO search_history (keyword, searchTime, resultCount) VALUES (?, ?, ?)
`);

const getSearchHistory = db.prepare(`
  SELECT * FROM search_history
  ORDER BY searchTime DESC
  LIMIT ?
`);

const clearSearchHistory = db.prepare(`
  DELETE FROM search_history
`);

const toggleWatched = db.prepare(`
  UPDATE movies SET watched = 1 - watched WHERE id = ?
`);

// ========== 评分 & 备注 ==========
const updateRating = db.prepare(`
  UPDATE movies SET rating = @rating WHERE id = @id
`);

const updateNote = db.prepare(`
  UPDATE movies SET note = @note WHERE id = @id
`);

// ========== 收藏 ==========
const toggleFavorite = db.prepare(`
  UPDATE movies SET favorite = 1 - favorite WHERE id = ?
`);

// ========== 删除 ==========
const deleteMovieByPath = db.prepare(`DELETE FROM movies WHERE filePath = ?`);

// ========== 女优相关 ==========
const getAllActresses = db.prepare(`
  SELECT a.*, COUNT(ma.movieId) as movieCount
  FROM actresses a
  LEFT JOIN movie_actress ma ON ma.actressId = a.id
  GROUP BY a.id
  /* 不能写 ORDER BY movieCount：表里本身有同名列（旧缓存值），
     SQLite 会解析到表列而不是聚合别名，排序就废了（2026-09-22） */
  ORDER BY COUNT(ma.movieId) DESC, a.name
`);

const getFollowedActresses = db.prepare(`
  SELECT a.*, COUNT(ma.movieId) as movieCount 
  FROM actresses a
  LEFT JOIN movie_actress ma ON ma.actressId = a.id
  WHERE a.followed = 1
  GROUP BY a.id
  ORDER BY movieCount DESC, a.name
`);

const getActressById = db.prepare(`SELECT * FROM actresses WHERE id = ?`);
const getActressByName = db.prepare(`SELECT * FROM actresses WHERE name = ?`);

/**
 * 全库女优（供「所有女优新作监视」遍历用）
 * 按作品数降序 —— 先扫活跃女优，用户最先看到有价值的结果。
 * @param {number} limit 取多少位（0 = 全部）
 * @param {number} offset 跳过多少位（用于分片轮转，避免每次都从头部开始）
 */
const getActressesForMonitor = db.prepare(`
  SELECT a.id, a.name, a.avatar, a.followed, COUNT(ma.movieId) as movieCount
  FROM actresses a
  LEFT JOIN movie_actress ma ON ma.actressId = a.id
  WHERE length(a.name) >= 2
  GROUP BY a.id
  ORDER BY COUNT(ma.movieId) DESC, a.id ASC
  LIMIT @limit OFFSET @offset
`);

/** 有作品的漫画（供漫画新作监视遍历用） */
const getComicsForMonitor = db.prepare(`
  SELECT id, title, cleanName, fileName, avid, overview, type, addedTime
  FROM movies
  WHERE type = 'comic'
  ORDER BY (addedTime IS NULL OR addedTime = 0) ASC, addedTime DESC, id ASC
  LIMIT @limit OFFSET @offset
`);

const toggleActressFollow = db.prepare(`
  UPDATE actresses SET followed = 1 - followed WHERE id = ?
`);

const upsertActress = db.prepare(`
  INSERT INTO actresses (name, originalName)
  VALUES (@name, @originalName)
  ON CONFLICT(name) DO UPDATE SET originalName=COALESCE(@originalName, originalName)
`);

/**
 * 写入女优头像与档案（刮削结果）
 * 只覆盖「本次刮到的、非空」字段，绝不把已有值清空 ——
 * 某次刮削只拿到头像没拿到三围时，不能把上次刮到的三围抹掉。
 *
 * 注意 NULL 语义：SQLite 里 `NULL <> ''` 结果是 NULL（假），
 * 所以传 null/undefined 会自然落到 ELSE 分支保留旧值，这正是我们要的。
 * 但 better-sqlite3 不允许绑定 undefined，因此调用方统一用 '' 兜底。
 * 这里再包一层 JS 函数做归一化，避免任何 undefined 漏进来。
 */
const _updateActressProfileStmt = db.prepare(`
  UPDATE actresses SET
    avatar    = CASE WHEN @avatar   <> '' THEN @avatar   ELSE avatar   END,
    birthday  = CASE WHEN @birthday <> '' THEN @birthday ELSE birthday END,
    height    = CASE WHEN @height    > 0 THEN @height    ELSE height   END,
    bust      = CASE WHEN @bust     <> '' THEN @bust     ELSE bust     END,
    waist     = CASE WHEN @waist    <> '' THEN @waist    ELSE waist    END,
    hip       = CASE WHEN @hip      <> '' THEN @hip      ELSE hip      END,
    cup       = CASE WHEN @cup      <> '' THEN @cup      ELSE cup      END,
    hobby     = CASE WHEN @hobby    <> '' THEN @hobby    ELSE hobby    END
  WHERE name = @name
`);

function updateActressProfileRun(row) {
  return _updateActressProfileStmt.run({
    name: row.name,
    avatar: row.avatar || '',
    birthday: row.birthday || '',
    height: Number(row.height) || 0,
    bust: row.bust || '',
    waist: row.waist || '',
    hip: row.hip || '',
    cup: row.cup || '',
    hobby: row.hobby || '',
  });
}
// 暴露成与 prepare 结果同样的 .run() 形态，调用方无需改动
const updateActressProfile = { run: updateActressProfileRun };

const getActressesWithoutAvatar = db.prepare(`
  SELECT a.*, COUNT(ma.movieId) as movieCount
  FROM actresses a
  LEFT JOIN movie_actress ma ON ma.actressId = a.id
  WHERE (a.avatar IS NULL OR a.avatar = '')
    AND (@onlyWithMovies = 0 OR ma.movieId IS NOT NULL)
  GROUP BY a.id
  ORDER BY COUNT(ma.movieId) DESC, a.name
  LIMIT @limit
`);

/** 批量取一批女优档案（供前端演员库展示） */
function getActressProfilesByIds(ids) {
  if (!ids || !ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM actresses WHERE id IN (${ph})`).all(...ids);
}

/** 女优头像覆盖率统计 */
function getActressAvatarStats() {
  const r = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN avatar IS NOT NULL AND avatar <> '' THEN 1 ELSE 0 END) AS withAvatar,
      SUM(CASE WHEN birthday IS NOT NULL AND birthday <> '' THEN 1 ELSE 0 END) AS withBirthday
    FROM actresses
  `).get();
  return {
    total: r.total || 0,
    withAvatar: r.withAvatar || 0,
    withBirthday: r.withBirthday || 0,
  };
}

// ========== 标签相关 ==========
const getAllTags = db.prepare(`
  SELECT t.*, COUNT(mt.movieId) as movieCount
  FROM tags t
  LEFT JOIN movie_tag mt ON mt.tagId = t.id
  GROUP BY t.id
  /* 同上：用聚合表达式而不是歧义别名 */
  ORDER BY COUNT(mt.movieId) DESC, t.name
`);

const getTagById = db.prepare(`SELECT * FROM tags WHERE id = ?`);
const getTagByName = db.prepare(`SELECT * FROM tags WHERE name = ?`);

const getMovieTags = db.prepare(`
  SELECT t.id, t.name, t.category FROM tags t
  JOIN movie_tag mt ON mt.tagId = t.id
  WHERE mt.movieId = ?
  ORDER BY t.name
`);

const getMovieActresses = db.prepare(`
  SELECT a.id, a.name, a.avatar, a.followed FROM actresses a
  JOIN movie_actress ma ON ma.actressId = a.id
  WHERE ma.movieId = ?
  ORDER BY a.name
`);

const upsertTag = db.prepare(`
  INSERT INTO tags (name, category)
  VALUES (@name, @category)
  ON CONFLICT(name) DO UPDATE SET category=COALESCE(@category, category)
`);

// ========== 统计相关 ==========
const getStats = db.prepare(`
  SELECT 
    COUNT(*) as totalMovies,
    COALESCE(SUM(fileSize), 0) as totalSize,
    COALESCE(SUM(duration), 0) as totalDuration,
    COALESCE(SUM(CASE WHEN watched = 1 THEN 1 ELSE 0 END), 0) as watchedCount,
    COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) as favoriteCount,
    COALESCE(SUM(playCount), 0) as totalPlays,
    (SELECT COUNT(*) FROM actresses) as actressCount,
    (SELECT COUNT(*) FROM tags) as tagCount
  FROM movies
`);

// 按库类型统计（jav/anime/comic/novel）
const getStatsByType = db.prepare(`
  SELECT 
    COUNT(*) as totalMovies,
    COALESCE(SUM(fileSize), 0) as totalSize,
    COALESCE(SUM(duration), 0) as totalDuration,
    COALESCE(SUM(CASE WHEN watched = 1 THEN 1 ELSE 0 END), 0) as watchedCount,
    COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) as favoriteCount,
    COALESCE(SUM(playCount), 0) as totalPlays,
    (SELECT COUNT(*) FROM actresses) as actressCount,
    (SELECT COUNT(*) FROM tags) as tagCount
  FROM movies WHERE type = ?
`);

const getStatsByProducer = db.prepare(`
  SELECT producer as name, COUNT(*) as count, COALESCE(SUM(fileSize), 0) as totalSize
  FROM movies 
  WHERE producer != '' AND producer IS NOT NULL
  GROUP BY producer
  ORDER BY count DESC
  LIMIT 20
`);

const getStatsByYear = db.prepare(`
  SELECT substr(releaseDate, 1, 4) as year, COUNT(*) as count
  FROM movies 
  WHERE releaseDate != '' AND releaseDate IS NOT NULL
  GROUP BY year
  ORDER BY year DESC
  LIMIT 20
`);

const getTopActresses = db.prepare(`
  SELECT a.id, a.name, a.avatar, COUNT(ma.movieId) as movieCount
  FROM actresses a
  JOIN movie_actress ma ON ma.actressId = a.id
  GROUP BY a.id
  ORDER BY movieCount DESC
  LIMIT 20
`);

const getTopTags = db.prepare(`
  SELECT t.id, t.name, COUNT(mt.movieId) as movieCount
  FROM tags t
  JOIN movie_tag mt ON mt.tagId = t.id
  GROUP BY t.id
  ORDER BY movieCount DESC
  LIMIT 30
`);

const getStatsByResolution = db.prepare(`
  SELECT 
    CASE 
      WHEN height >= 2160 THEN '4K (2160p)'
      WHEN height >= 1080 THEN '1080p (FHD)'
      WHEN height >= 720 THEN '720p (HD)'
      WHEN height >= 480 THEN '480p (SD)'
      ELSE '其他'
    END as resolution,
    COUNT(*) as count,
    SUM(fileSize) as totalSize
  FROM movies
  WHERE height > 0
  GROUP BY resolution
  ORDER BY count DESC
`);

const getStatsByDuration = db.prepare(`
  SELECT 
    CASE 
      WHEN duration >= 10800 THEN '3小时以上'
      WHEN duration >= 7200 THEN '2-3小时'
      WHEN duration >= 3600 THEN '1-2小时'
      WHEN duration >= 1800 THEN '30-60分钟'
      ELSE '30分钟以下'
    END as durationRange,
    COUNT(*) as count
  FROM movies
  WHERE duration > 0
  GROUP BY durationRange
  ORDER BY count DESC
`);

const getStatsByFormat = db.prepare(`
  SELECT 
    LOWER(SUBSTR(fileName, INSTR(fileName, '.') + 1)) as format,
    COUNT(*) as count,
    SUM(fileSize) as totalSize
  FROM movies
  WHERE fileName LIKE '%.%'
  GROUP BY format
  ORDER BY count DESC
`);

// ========== 通知 ==========
const getAllNotifications = db.prepare(`
  SELECT * FROM notifications ORDER BY createdAt DESC LIMIT 100
`);

const getUnreadNotificationCount = db.prepare(`
  SELECT COUNT(*) as count FROM notifications WHERE read = 0
`);

const addNotification = db.prepare(`
  INSERT INTO notifications (type, title, content, url, cover, extra, createdAt)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const markNotificationRead = db.prepare(`
  UPDATE notifications SET read = 1 WHERE id = ?
`);

const markAllNotificationsRead = db.prepare(`
  UPDATE notifications SET read = 1
`);

const deleteNotification = db.prepare(`
  DELETE FROM notifications WHERE id = ?
`);

/**
 * 按类型取通知（新作页用）。
 * 时间过滤走 extra.releaseDate 不可靠，这里统一按 createdAt 过滤 + 分页。
 */
function getNotificationsByTypes(types, { since = 0, limit = 2000 } = {}) {
  const list = (types && types.length) ? types : null;
  const ph = list ? list.map(() => '?').join(',') : '';
  const sql = `
    SELECT * FROM notifications
    WHERE createdAt >= ?
      ${list ? `AND type IN (${ph})` : ''}
    ORDER BY createdAt DESC
    LIMIT ?
  `;
  const params = list ? [since, ...list, limit] : [since, limit];
  return db.prepare(sql).all(...params);
}

/**
 * 取某类通知里出现过的所有女优名（extra.actress），按最近出现时间排序。
 * 用于「顶部可点击女优名」。
 */
function getNotificationActresses(types, { since = 0, limit = 400 } = {}) {
  const list = (types && types.length) ? types : ['new_release'];
  const ph = list.map(() => '?').join(',');
  return db.prepare(`
    SELECT
      json_extract(extra, '$.actress') AS actress,
      json_extract(extra, '$.actressId') AS actressId,
      COUNT(*) AS count,
      MAX(createdAt) AS lastAt
    FROM notifications
    WHERE createdAt >= ?
      AND type IN (${ph})
      AND json_extract(extra, '$.actress') IS NOT NULL
      AND json_extract(extra, '$.actress') <> ''
    GROUP BY actress
    ORDER BY lastAt DESC
    LIMIT ?
  `).all(since, ...list, limit);
}

/** 清理某类型超过 N 天的旧通知，防止表无限膨胀 */
function pruneNotifications(types, beforeTs) {
  const list = (types && types.length) ? types : ['new_release'];
  const ph = list.map(() => '?').join(',');
  return db.prepare(`DELETE FROM notifications WHERE type IN (${ph}) AND createdAt < ?`).run(...list, beforeTs);
}

/** 按 id 取单条通知（封面自愈用） */
const getNotificationById = db.prepare(`SELECT * FROM notifications WHERE id = ?`);

/** 回写通知封面（封面自愈成功后调用，下次直接命中本地文件） */
const updateNotificationCover = db.prepare(`UPDATE notifications SET cover = ? WHERE id = ?`);

// ========== 标签 & 女优关联 ==========
const addMovieTag = db.prepare(`
  INSERT OR IGNORE INTO movie_tag (movieId, tagId) VALUES (?, ?)
`);

const addMovieActress = db.prepare(`
  INSERT OR IGNORE INTO movie_actress (movieId, actressId) VALUES (?, ?)
`);

const removeMovieTags = db.prepare(`DELETE FROM movie_tag WHERE movieId = ?`);
const removeMovieActresses = db.prepare(`DELETE FROM movie_actress WHERE movieId = ?`);

// ========== 播放进度（续播） ==========
const getPlaybackProgress = db.prepare(`SELECT * FROM playback_progress WHERE movieId = ?`);

const setPlaybackProgress = db.prepare(`
  INSERT INTO playback_progress (movieId, position, duration, updatedAt)
  VALUES (@movieId, @position, @duration, @updatedAt)
  ON CONFLICT(movieId) DO UPDATE SET
    position = @position,
    duration = @duration,
    updatedAt = @updatedAt
`);

const clearPlaybackProgress = db.prepare(`DELETE FROM playback_progress WHERE movieId = ?`);

const getAllPlaybackProgress = db.prepare(`SELECT movieId, position, duration FROM playback_progress`);

// ========== 刮削失败记录 ==========
const recordScrapeFailure = db.prepare(`
  INSERT INTO scrape_failures (filePath, movieId, type, reason, failedAt, retryCount)
  VALUES (@filePath, @movieId, @type, @reason, @failedAt, 0)
  ON CONFLICT(filePath) DO UPDATE SET
    movieId = @movieId,
    type = @type,
    reason = @reason,
    failedAt = @failedAt
`);

const clearScrapeFailure = db.prepare(`DELETE FROM scrape_failures WHERE filePath = ?`);

const getScrapeFailureByPath = db.prepare(`SELECT * FROM scrape_failures WHERE filePath = ?`);

const getAllScrapeFailures = db.prepare(`
  SELECT sf.*, m.title, m.fileName, m.avid, m.localPosterPath, m.posterPath, m.type as movieType,
         COALESCE(m.id, sf.movieId) AS movieId
  FROM scrape_failures sf
  LEFT JOIN movies m ON m.filePath = sf.filePath
  ORDER BY sf.failedAt DESC
`);

// ========== 工具函数 ==========
function updateMovieRelations(movieId, { tags = [], actresses = [] }) {
  const tx = db.transaction(() => {
    removeMovieTags.run(movieId);

    // 同上：刮削结果为空时保留已有关联，不做无谓的清空
    if (actresses.length > 0) {
      removeMovieActresses.run(movieId);
      for (const actressName of actresses) {
        if (!actressName || !actressName.trim()) continue;
        const name = actressName.trim();
        upsertActress.run({ name, originalName: name });
        const actress = getActressByName.get(name);
        if (actress) addMovieActress.run(movieId, actress.id);
      }
    }

    for (const tagName of tags) {
      if (!tagName || !tagName.trim()) continue;
      const name = tagName.trim();
      upsertTag.run({ name, category: 'genre' });
      const tag = getTagByName.get(name);
      if (tag) addMovieTag.run(movieId, tag.id);
    }

    // 片名文本兜底补关联（只加不删）
    const mv = getMovieById.get(movieId);
    if (mv) linkActressesFromText(movieId, mv.cleanName || mv.title || '');
  });
  tx();
}

function recalcHotScore(movieId) {
  const movie = getMovieById.get(movieId);
  if (!movie) return;

  const now = Date.now();
  const daysSinceLastPlay = movie.lastPlayTime
    ? (now - movie.lastPlayTime) / (1000 * 60 * 60 * 24)
    : 999;

  let score = 0;
  score += movie.playCount || 0;
  if (daysSinceLastPlay <= 7) score += 5;
  else if (daysSinceLastPlay <= 30) score += 2;
  if (movie.favorite) score += 3;
  score += (movie.rating || 0) * 2;
  score += (movie.score || 0) * 1;

  db.prepare('UPDATE movies SET hotScore = ? WHERE id = ?').run(score, movieId);
  return score;
}

function recalcAllHotScores() {
  const movies = getAllMovies.all();
  let count = 0;
  for (const m of movies) {
    recalcHotScore(m.id);
    count++;
  }
  console.log(`[热度计算] 已更新 ${count} 部影片热度`);
  return count;
}


// ========== 网盘星标 / 打开历史 ==========
const starCloudStmt = db.prepare(`
  INSERT INTO cloud_items (fid, name, is_dir, pdir_fid, size, kind, starred, starred_at)
  VALUES (@fid, @name, @is_dir, @pdir_fid, @size, @kind, 1, @now)
  ON CONFLICT(fid) DO UPDATE SET
    name=@name, is_dir=@is_dir, pdir_fid=@pdir_fid, size=@size, kind=@kind,
    starred=1, starred_at=@now
`);
const touchCloudStmt = db.prepare(`
  INSERT INTO cloud_items (fid, name, is_dir, pdir_fid, size, kind, last_opened, open_count)
  VALUES (@fid, @name, @is_dir, @pdir_fid, @size, @kind, @now, 1)
  ON CONFLICT(fid) DO UPDATE SET
    name=@name, is_dir=@is_dir, pdir_fid=@pdir_fid, size=@size, kind=@kind,
    last_opened=@now, open_count=open_count+1
`);

function starCloudItem(item) {
  starCloudStmt.run({
    fid: String(item.fid), name: item.name || '', is_dir: item.is_dir ? 1 : 0,
    pdir_fid: String(item.pdir_fid || '0'), size: Number(item.size) || 0,
    kind: item.kind || '', now: Date.now()
  });
}
function unstarCloudItem(fid) {
  db.prepare('UPDATE cloud_items SET starred=0 WHERE fid=?').run(String(fid));
}
function isCloudItemStarred(fid) {
  const r = db.prepare('SELECT starred FROM cloud_items WHERE fid=?').get(String(fid));
  return !!(r && r.starred);
}
function getStarredCloudItems(kind) {
  return db.prepare(`
    SELECT * FROM cloud_items WHERE starred=1 AND (@kind='' OR kind=@kind)
    ORDER BY starred_at DESC LIMIT 200
  `).all({ kind: kind || '' });
}
function touchCloudItem(item) {
  touchCloudStmt.run({
    fid: String(item.fid), name: item.name || '', is_dir: item.is_dir ? 1 : 0,
    pdir_fid: String(item.pdir_fid || '0'), size: Number(item.size) || 0,
    kind: item.kind || '', now: Date.now()
  });
}
function getRecentCloudItems(kind, limit = 30) {
  return db.prepare(`
    SELECT * FROM cloud_items WHERE last_opened>0 AND (@kind='' OR kind=@kind)
    ORDER BY last_opened DESC LIMIT @limit
  `).all({ kind: kind || '', limit: Number(limit) || 30 });
}

/* ★ round27：对外暴露「带 FTS 自愈」的写入。
 * 扫描 / 重新刮削都走这个入口 —— 库的 FTS 影子表一坏，原来会让**所有新片写不进去**
 * （片名永远停在番号、新片永远补不上标题），现在会自动重建索引再重试一次。 */
function upsertMovieAndRelationsHealed(movieObj, relations) {
  return withFtsHeal(() => upsertMovieAndRelations(movieObj, relations), '扫描写入');
}

module.exports = {
  db,
  // FTS 自愈（2026-09-25 round27）
  rebuildFts,
  ftsIsWritable,
  withFtsHeal,
  isMalformedError,
  upsertMovieAndRelations: upsertMovieAndRelationsHealed,
  _rawUpsertMovieAndRelations: upsertMovieAndRelations,
  _linkActressesFromText: linkActressesFromText,
  _invalidateActressNameCache: invalidateActressNameCache,
  updateLocalPoster,
  // 影片相关
  upsertMovie,
  getAllMovies,
  getMoviesByHot,
  getMoviesByRecent,
  getMoviesByPlayCount,
  getMoviesByRelease,
  getUnwatchedMovies,
  getFavoriteMovies,
  searchMovies,
  getMovieById,
  getMovieByPath,
  getMoviesByActress,
  getMoviesByTag,
  getMoviesByTags,
  getSimilarMovies,
  getRandomMovies,
  updatePlayRecord,
  addWatchHistory,
  getWatchHistory,
  toggleWatched,
  updateRating,
  updateNote,
  toggleFavorite,
  deleteMovieByPath,
  // 搜索历史
  addSearchHistory,
  getSearchHistory,
  clearSearchHistory,
  // 女优相关
  getAllActresses,
  getFollowedActresses,
  getActressById,
  getActressByName,
  toggleActressFollow,
  upsertActress,
  updateActressProfile,
  getActressesWithoutAvatar,
  getActressProfilesByIds,
  getActressAvatarStats,
  getActressesForMonitor,
  getComicsForMonitor,
  // 标签相关
  getAllTags,
  getTagById,
  getTagByName,
  getMovieTags,
  getMovieActresses,
  upsertTag,
  addMovieTag,
  addMovieActress,
  removeMovieTags,
  removeMovieActresses,
  // 统计相关
  getStats,
  getStatsByType,
  getStatsByProducer,
  getStatsByYear,
  getTopActresses,
  getTopTags,
  getStatsByResolution,
  getStatsByDuration,
  getStatsByFormat,
  // 通知
  getAllNotifications,
  getUnreadNotificationCount,
  addNotification,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getNotificationsByTypes,
  getNotificationActresses,
  pruneNotifications,
  getNotificationById,
  updateNotificationCover,
  // 播放进度
  getPlaybackProgress,
  setPlaybackProgress,
  clearPlaybackProgress,
  getAllPlaybackProgress,
  // 刮削失败
  recordScrapeFailure,
  clearScrapeFailure,
  getScrapeFailureByPath,
  getAllScrapeFailures,
  // 网盘星标 / 历史
  starCloudItem,
  unstarCloudItem,
  isCloudItemStarred,
  getStarredCloudItems,
  touchCloudItem,
  getRecentCloudItems,
  // 工具函数
  updateMovieRelations,
  recalcHotScore,
  recalcAllHotScores
};