-- ============================================================
-- local-movie-library 完整建库脚本
-- db.js 启动时检测到空库（无 movies 表）会自动执行本文件，
-- 新环境 / 换机部署不再依赖手工拷贝 db/movie.db。
-- 表结构以现有线上库为准，新增表一并放在这里。
-- ============================================================

CREATE TABLE IF NOT EXISTS movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filePath TEXT UNIQUE NOT NULL,
  fileName TEXT NOT NULL,
  avid TEXT,
  cleanName TEXT,
  fileSize INTEGER,
  duration REAL,
  width INTEGER,
  height INTEGER,
  tmdbId INTEGER,
  title TEXT,
  originalTitle TEXT,
  overview TEXT,
  releaseDate TEXT,
  posterPath TEXT,
  localPosterPath TEXT,
  country TEXT,
  genres TEXT,
  producer TEXT,
  publisher TEXT,
  serial TEXT,
  director TEXT,
  score REAL,
  source TEXT,
  lastScanTime INTEGER,
  playCount INTEGER DEFAULT 0,
  lastPlayTime INTEGER DEFAULT 0,
  favorite INTEGER DEFAULT 0,
  rating REAL DEFAULT 0,
  note TEXT DEFAULT "",
  hotScore REAL DEFAULT 0,
  watched INTEGER DEFAULT 0,
  addedTime INTEGER DEFAULT 0,
  type TEXT DEFAULT "jav"
);

CREATE TABLE IF NOT EXISTS actresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  originalName TEXT,
  avatar TEXT,
  gender TEXT DEFAULT 'female',
  birthday TEXT,
  height INTEGER,
  bust TEXT,
  waist TEXT,
  hip TEXT,
  cup TEXT,
  favorite INTEGER DEFAULT 0,
  movieCount INTEGER DEFAULT 0,
  followed INTEGER DEFAULT 0,
  debutDate TEXT DEFAULT "",
  bloodType TEXT DEFAULT "",
  hobby TEXT DEFAULT ""
);

CREATE TABLE IF NOT EXISTS actress_alias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actressId INTEGER NOT NULL,
  aliasName TEXT UNIQUE NOT NULL,
  FOREIGN KEY(actressId) REFERENCES actresses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS movie_actress (
  movieId INTEGER NOT NULL,
  actressId INTEGER NOT NULL,
  PRIMARY KEY(movieId, actressId),
  FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE,
  FOREIGN KEY(actressId) REFERENCES actresses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  category TEXT DEFAULT 'genre',
  movieCount INTEGER DEFAULT 0,
  hotScore REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tag_alias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tagId INTEGER NOT NULL,
  aliasName TEXT UNIQUE NOT NULL,
  FOREIGN KEY(tagId) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS movie_tag (
  movieId INTEGER NOT NULL,
  tagId INTEGER NOT NULL,
  PRIMARY KEY(movieId, tagId),
  FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE,
  FOREIGN KEY(tagId) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS watch_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movieId INTEGER NOT NULL,
  playTime INTEGER NOT NULL,
  duration REAL DEFAULT 0,
  FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reading_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movieId INTEGER NOT NULL,
  type TEXT DEFAULT 'comic',
  duration INTEGER DEFAULT 0,
  readDate INTEGER DEFAULT 0,
  FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  searchTime INTEGER NOT NULL,
  resultCount INTEGER DEFAULT 0
);

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

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT DEFAULT 'info',
  title TEXT NOT NULL,
  content TEXT,
  url TEXT,
  read INTEGER DEFAULT 0,
  createdAt INTEGER DEFAULT 0,
  cover TEXT DEFAULT "",
  extra TEXT DEFAULT ""
);

-- ============ 新增：播放进度（续播） ============
CREATE TABLE IF NOT EXISTS playback_progress (
  movieId INTEGER PRIMARY KEY,
  position REAL DEFAULT 0,
  duration REAL DEFAULT 0,
  updatedAt INTEGER DEFAULT 0,
  FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE
);

-- ============ 新增：刮削失败记录（供一键重刮） ============
CREATE TABLE IF NOT EXISTS scrape_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filePath TEXT UNIQUE NOT NULL,
  movieId INTEGER,
  type TEXT DEFAULT 'jav',
  reason TEXT DEFAULT '',
  failedAt INTEGER DEFAULT 0,
  retryCount INTEGER DEFAULT 0
);

-- ============ 索引 ============
CREATE INDEX IF NOT EXISTS idx_movie_filepath ON movies(filePath);
CREATE INDEX IF NOT EXISTS idx_movie_favorite ON movies(favorite);
CREATE INDEX IF NOT EXISTS idx_movie_avid ON movies(avid);
CREATE INDEX IF NOT EXISTS idx_actress_name ON actresses(name);
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
CREATE INDEX IF NOT EXISTS idx_reading_history_movie ON reading_history(movieId);
CREATE INDEX IF NOT EXISTS idx_reading_history_date ON reading_history(readDate);
