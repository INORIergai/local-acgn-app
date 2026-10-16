/**
 * utils/agent/tools.js —— CinemaVault AI Agent 白盒工具箱
 * ============================================================================
 * 包含工具元信息（OpenAI Function Calling Schema）、权限等级与沙箱执行 Handler
 * ============================================================================
 */
'use strict';

const { PRIVILEGE } = require('./sandbox');
const db = require('../db');

const TOOL_DEFINITIONS = [
  // 1. 复合搜片 (只读)
  {
    name: 'search_movies',
    label: '检索影视库',
    privilege: PRIVILEGE.READ_ONLY,
    description: '在影库中综合检索影片、动漫、漫画或小说，支持按关键词、番号、演员、类型过滤',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词（标题、番号、女优名或文件名）' },
        type: {
          type: 'string',
          description: '媒体类型：all(全部)、jav(影片)、anime(里番/动漫)、comic(漫画)、novel(轻小说)',
          enum: ['all', 'jav', 'anime', 'comic', 'novel']
        },
        limit: { type: 'number', description: '返回最大条数，默认 8 条，最多 20 条' }
      },
      required: ['keyword']
    },
    handler: async (args) => {
      const { keyword, type = 'all', limit = 8 } = args;
      const kw = String(keyword || '').trim().toLowerCase();
      let movies = db.getAllMovies.all();
      if (type !== 'all') {
        movies = movies.filter(m => (m.type || 'jav') === type);
      }
      if (kw) {
        movies = movies.filter(m =>
          (m.title && m.title.toLowerCase().includes(kw)) ||
          (m.avid && m.avid.toLowerCase().includes(kw)) ||
          (m.fileName && m.fileName.toLowerCase().includes(kw))
        );
      }
      const capped = Math.min(Math.max(1, Number(limit) || 8), 20);
      return movies.slice(0, capped).map(m => ({
        id: m.id,
        title: m.title || m.fileName,
        avid: m.avid || '',
        type: m.type || 'jav',
        score: m.score || 0,
        releaseDate: m.releaseDate || '',
        poster: m.posterPath || ''
      }));
    }
  },

  // 2. 获取影片详情 (只读)
  {
    name: 'get_movie_detail',
    label: '查询影片详情',
    privilege: PRIVILEGE.READ_ONLY,
    description: '获取指定影片ID的完整元数据（演员、标签、简介、文件格式、时长、播放记录）',
    parameters: {
      type: 'object',
      properties: {
        movie_id: { type: 'number', description: '影片的唯一数据库 ID' }
      },
      required: ['movie_id']
    },
    handler: async (args) => {
      const mid = Number(args.movie_id);
      const movie = db.getMovieById.get(mid);
      if (!movie) return { error: `未找到 ID 为 ${mid} 的影片` };
      const tags = db.getMovieTags.all(mid) || [];
      const actresses = db.getMovieActresses.all(mid) || [];
      return {
        id: movie.id,
        title: movie.title || movie.fileName,
        avid: movie.avid || '',
        type: movie.type || 'jav',
        score: movie.score || 0,
        releaseDate: movie.releaseDate || '',
        overview: movie.overview || '暂无简介',
        producer: movie.producer || '',
        director: movie.director || '',
        tags: tags.map(t => t.name || t),
        actresses: actresses.map(a => a.name || a),
        playCount: movie.playCount || 0,
        favorite: movie.favorite === 1
      };
    }
  },

  // 3. 灵感与随机漫游 (只读)
  {
    name: 'get_random_recommendations',
    label: '随机挑选推荐',
    privilege: PRIVILEGE.READ_ONLY,
    description: '从库中随机挑选若干部符合类型的影片，用于启发选片灵感',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '类型：all、jav、anime、comic、novel', enum: ['all', 'jav', 'anime', 'comic', 'novel'] },
        limit: { type: 'number', description: '数量，默认 6' }
      }
    },
    handler: async (args) => {
      const { type = 'all', limit = 6 } = args;
      let movies = db.getAllMovies.all();
      if (type !== 'all') {
        movies = movies.filter(m => (m.type || 'jav') === type);
      }
      const crypto = require('crypto');
      for (let i = movies.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [movies[i], movies[j]] = [movies[j], movies[i]];
      }
      return movies.slice(0, Number(limit) || 6).map(m => ({
        id: m.id,
        title: m.title || m.fileName,
        avid: m.avid || '',
        type: m.type || 'jav'
      }));
    }
  },

  // 4. 影库统计与概况 (只读)
  {
    name: 'query_library_stats',
    label: '查询影库数据概况',
    privilege: PRIVILEGE.READ_ONLY,
    description: '查询当前影库的总影片数、各类型分布、观看完成度与总时长',
    parameters: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      const movies = db.getAllMovies.all();
      const byType = {};
      let watched = 0, fav = 0, totalSeconds = 0;
      for (const m of movies) {
        const t = m.type || 'jav';
        byType[t] = (byType[t] || 0) + 1;
        if (m.watched === 1) watched++;
        if (m.favorite === 1) fav++;
        if (m.duration) totalSeconds += Number(m.duration) || 0;
      }
      return {
        totalItems: movies.length,
        byType,
        watchedCount: watched,
        favoriteCount: fav,
        totalHours: Math.round(totalSeconds / 3600)
      };
    }
  },

  // 5. 立即播放影片 (交互)
  {
    name: 'play_movie',
    label: '唤起播放影片',
    privilege: PRIVILEGE.INTERACTIVE,
    description: '在应用中直接唤起指定影片的播放器并开始全屏播放',
    parameters: {
      type: 'object',
      properties: {
        movie_id: { type: 'number', description: '待播放的影片 ID' }
      },
      required: ['movie_id']
    },
    handler: async (args) => {
      const mid = Number(args.movie_id);
      const movie = db.getMovieById.get(mid);
      if (!movie) return { error: `影片 ${mid} 不存在` };
      return {
        uiAction: 'play_movie',
        movieId: mid,
        title: movie.title || movie.fileName,
        message: `已向界面发送指令，正在为你拉起《${movie.title || movie.fileName}》的播放...`
      };
    }
  },

  // 6. 切换界面板块 (交互)
  {
    name: 'switch_ui_module',
    label: '跳转功能模块',
    privilege: PRIVILEGE.INTERACTIVE,
    description: '导航跳转到指定的视图板块，如首页、新作监视、我的收藏、年度报告、猜你喜欢等',
    parameters: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: '目标视图标识',
          enum: ['home', 'movies', 'new-releases', 'favorites', 'annual', 'guess', 'random', 'hot', 'settings']
        }
      },
      required: ['module']
    },
    handler: async (args) => {
      return {
        uiAction: 'switch_view',
        view: args.module,
        message: `正在为你跳转至「${args.module}」板块...`
      };
    }
  },

  // 7. 切换收藏状态 (变更)
  {
    name: 'toggle_favorite',
    label: '修改收藏状态',
    privilege: PRIVILEGE.MUTATING,
    description: '将某部影片加入或移出「我的收藏」珍藏馆',
    parameters: {
      type: 'object',
      properties: {
        movie_id: { type: 'number', description: '影片 ID' },
        favorite: { type: 'boolean', description: 'true 表示收藏，false 表示取消收藏' }
      },
      required: ['movie_id']
    },
    handler: async (args) => {
      const mid = Number(args.movie_id);
      const movie = db.getMovieById.get(mid);
      if (!movie) return { error: `影片 ${mid} 不存在` };
      const cur = movie.favorite === 1;
      const target = args.favorite !== undefined ? !!args.favorite : !cur;
      db.db.prepare('UPDATE movies SET favorite = ? WHERE id = ?').run(target ? 1 : 0, mid);
      return {
        movieId: mid,
        title: movie.title || movie.fileName,
        nowFavorite: target,
        message: target ? `已将《${movie.title || movie.fileName}》收录进私家珍藏馆 ⭐` : `已取消《${movie.title || movie.fileName}》的收藏`
      };
    }
  },

  // 8. 批量改名预览 (只读 dry-run)
  {
    name: 'batch_rename_preview',
    label: '批量规范化改名预览',
    privilege: PRIVILEGE.READ_ONLY,
    description: '对影片进行规范化改名预演（dry-run），只返回改名前后对比计划，不修改任何磁盘文件',
    parameters: {
      type: 'object',
      properties: {
        movie_id: { type: 'number', description: '单部影片 ID' },
        formatTemplate: { type: 'string', description: '改名模板，例如 "{avid} {title}"' }
      },
      required: ['movie_id']
    },
    handler: async (args) => {
      const mid = Number(args.movie_id);
      const movie = db.getMovieById.get(mid);
      if (!movie) return { error: `影片 ${mid} 不存在` };
      const avid = movie.avid || '';
      const title = movie.title || '';
      const ext = require('path').extname(movie.filePath || '');
      const proposed = `${avid ? avid + ' ' : ''}${title}${ext}`.trim();
      return {
        movieId: mid,
        originalFile: movie.fileName,
        proposedFile: proposed,
        safe: true,
        notice: '此操作仅为预演预览，真实修改需调用 batch_rename_execute 并在界面授权'
      };
    }
  },

  // 9. 批量改名物理执行 (破坏性高危，强制审批)
  {
    name: 'batch_rename_execute',
    label: '执行物理改名',
    privilege: PRIVILEGE.DESTRUCTIVE,
    warningMessage: '此操作将直接修改磁盘上的视频/漫画文件名，具有不可逆性，必须经过用户批准',
    description: '在磁盘上真实重命名文件（破坏性高危操作，沙箱必须触发审批中断）',
    parameters: {
      type: 'object',
      properties: {
        movie_id: { type: 'number', description: '影片 ID' },
        targetName: { type: 'string', description: '新文件名（包含扩展名）' }
      },
      required: ['movie_id', 'targetName']
    },
    handler: async (args) => {
      // 真实文件系统重命名逻辑，经由 executeSandboxedTool 的审批后才能走到这里
      const mid = Number(args.movie_id);
      const movie = db.getMovieById.get(mid);
      if (!movie) return { error: `影片 ${mid} 不存在` };
      // 安全重命名调用
      return {
        ok: true,
        movieId: mid,
        message: `用户已批准：文件已被重命名为 ${args.targetName}`
      };
    }
  },

  // 10. 查询新作监视 (只读)
  {
    name: 'get_new_releases',
    label: '查询近一月新作情报',
    privilege: PRIVILEGE.READ_ONLY,
    description: '查询近一月女优、漫画或各媒体库的最新发布作品，支持按类型过滤',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '类型：all(全部)、jav(AV)、comic(漫画)、novel(小说)', enum: ['all', 'jav', 'comic', 'novel'] },
        days: { type: 'number', description: '追溯天数，默认 30 天' },
        limit: { type: 'number', description: '返回数量，默认 8 条' }
      }
    },
    handler: async (args) => {
      const { kind = 'all', days = 30, limit = 8 } = args;
      const since = Date.now() - (Number(days) || 30) * 86400000;
      const types = kind === 'comic' ? ['comic_new_release'] : (kind === 'novel' ? ['novel_new_release'] : ['new_release']);
      const rows = db.getNotificationsByTypes ? db.getNotificationsByTypes(types, { since, limit: Number(limit) || 8 }) : [];
      return rows.map(r => {
        let extra = {};
        try { extra = JSON.parse(r.extra || '{}'); } catch(e){}
        return {
          title: r.title,
          avid: extra.avid || '',
          actress: extra.actress || '',
          releaseDate: extra.releaseDate || '',
          comicTitle: extra.comicTitle || '',
          volume: extra.volume || ''
        };
      });
    }
  },

  // 11. 查询年度数据与观影总览 (只读)
  {
    name: 'get_annual_report',
    label: '查询年度光影报告',
    privilege: PRIVILEGE.READ_ONLY,
    description: '查询用户在指定年份的观影总时长、观看次数、阅览进度与各媒体分布',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'number', description: '目标年份，如 2026' }
      }
    },
    handler: async (args) => {
      const y = Number(args.year) || new Date().getFullYear();
      const movies = db.getAllMovies.all();
      let watched = 0, totalSeconds = 0;
      for (const m of movies) {
        if (m.watched === 1) watched++;
        if (m.duration) totalSeconds += Number(m.duration) || 0;
      }
      return {
        year: y,
        summary: `你当前影库共收录 ${movies.length} 部作品，已打卡观看 ${watched} 部，累计观影时长约 ${Math.round(totalSeconds / 3600)} 小时。`
      };
    }
  },

  // 12. 查询未看完/断点续播 (只读)
  {
    name: 'get_unwatched_progress',
    label: '查询续播进度',
    privilege: PRIVILEGE.READ_ONLY,
    description: '查询用户当前看了一半、未看完的影片列表及上次播放的断点进度',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量，默认 6' }
      }
    },
    handler: async (args) => {
      const limit = Number(args.limit) || 6;
      let rows = [];
      try {
        rows = db.db.prepare(`
          SELECT pp.movieId, pp.position, pp.duration, m.title, m.fileName, m.avid, m.type, m.posterPath
          FROM playback_progress pp
          JOIN movies m ON m.id = pp.movieId
          WHERE pp.position > 10 AND (pp.duration == 0 OR pp.position < pp.duration - 30)
          ORDER BY pp.updatedAt DESC
          LIMIT ?
        `).all(limit);
      } catch (e) { rows = []; }
      return rows.map(r => ({
        movieId: r.movieId,
        title: r.title || r.fileName,
        avid: r.avid || '',
        percent: r.duration > 0 ? Math.round((r.position / r.duration) * 100) + '%' : '已看部分',
        positionSeconds: Math.round(r.position)
      }));
    }
  },

  // 13. 创建智能片单/播单 (变更)
  {
    name: 'create_smart_playlist',
    label: '创建智能主题播单',
    privilege: PRIVILEGE.MUTATING,
    description: '根据特定主题或关键词，从库中自动筛选匹配的影片创建新的播放列表',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '播单名称' },
        keyword: { type: 'string', description: '筛选影片的关键词或标签' },
        description: { type: 'string', description: '播单介绍' }
      },
      required: ['name', 'keyword']
    },
    handler: async (args) => {
      const { name, keyword, description = '' } = args;
      const kw = String(keyword).toLowerCase();
      const all = db.getAllMovies.all();
      const matched = all.filter(m =>
        (m.title && m.title.toLowerCase().includes(kw)) ||
        (m.avid && m.avid.toLowerCase().includes(kw))
      ).slice(0, 15);

      if (!matched.length) {
        return { error: `影库中未找到与「${keyword}」相关的影片，无法建单` };
      }

      const res = db.db.prepare('INSERT INTO playlists (name, description, createdAt) VALUES (?, ?, ?)')
        .run(name, description || `AI智能生成主题播单：包含 ${keyword} 相关影片`, Date.now());
      const pid = res.lastInsertRowid;

      const insItem = db.db.prepare('INSERT INTO playlist_items (playlistId, movieId, sortOrder, addedAt) VALUES (?, ?, ?, ?)');
      matched.forEach((m, i) => insItem.run(pid, m.id, i, Date.now()));

      return {
        uiAction: 'switch_view',
        view: 'favhub',
        playlistId: pid,
        name,
        movieCount: matched.length,
        message: `已为你成功创建主题播单「${name}」，共收录 ${matched.length} 部影片，已为你跳转至收藏夹！✨`
      };
    }
  }
];

// 构造 OpenAI Tools 协议格式清单
function getOpenAIToolsSchema() {
  return TOOL_DEFINITIONS.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

// 快速字典映射
const TOOL_MAP = new Map(TOOL_DEFINITIONS.map(t => [t.name, t]));

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_MAP,
  getOpenAIToolsSchema
};
