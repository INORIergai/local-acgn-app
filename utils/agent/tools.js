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
      // ★ round132：这里原来只写了一句「用户已批准：文件已被重命名为 xxx」就返回 ok:true，
      //   代码里根本没有任何 fs.rename —— 典型的「嘴上做了」。现在真的调落盘改名，
      //   与详情弹窗的「重命名文件」共用同一套口径（磁盘视频 + NFO/同名封面 + 库内路径）。
      const mid = Number(args.movie_id);
      const movie = db.getMovieById.get(mid);
      if (!movie) return { error: `影片 ${mid} 不存在` };
      // targetName 带扩展名，renameOneMovie 只吃主干（扩展名沿用原文件）
      const stem = String(args.targetName || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
      if (!stem) return { error: '新文件名不能为空' };
      try {
        const { renameOneMovie } = require('../rename-service');
        const r = await renameOneMovie(mid, stem, false);
        if (!r || r.code !== 0) return { ok: false, movieId: mid, error: (r && r.msg) || '改名失败' };
        return {
          ok: true,
          movieId: mid,
          verified: true,
          oldFileName: movie.fileName,
          newFileName: r.data && r.data.fileName,
          message: r.msg === '名称未改变'
            ? '文件名本来就一致，未作改动'
            : `文件已真实改名为 ${r.data && r.data.fileName}（磁盘 + NFO/同名封面 + 库内路径均已同步）`
        };
      } catch (e) {
        return { ok: false, movieId: mid, error: e.message };
      }
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
  },

  /* ========================================================================
   * round135 新增：海报闭环（这三个能力原来只活在「LangGraph 抛异常」的降级链里，
   * 主链根本看不见 —— 用户问「库里缺多少海报」，AI 只能说不知道）
   * ====================================================================== */

  // 14. 海报体检 (只读)
  {
    name: 'find_missing_posters',
    label: '检查缺失/低质海报',
    privilege: PRIVILEGE.READ_ONLY,
    timeoutMs: 30000,
    description: '扫描海报健康度，返回「缺失 / 待换（视频截图、低清、损坏）」的数量与样本。不修改任何文件',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          description: '只看哪一类：missing(缺失)、bad(需替换)、suspect(可疑)、all(全部问题)',
          enum: ['missing', 'bad', 'suspect', 'all']
        },
        limit: { type: 'number', description: '样本条数，默认 10，最多 30' }
      }
    },
    handler: async (args) => {
      const { auditAll } = require('../poster-health');
      const level = args.level || 'all';
      const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
      const r = await auditAll(db.db, { log: () => { } });
      const items = (r.items || []).filter(it => {
        if (level === 'all') return it.level !== 'ok';
        return it.level === level;
      });
      return {
        total: r.total,
        ok: r.ok,
        missing: r.missing,
        bad: r.bad,
        suspect: r.suspect,
        needFix: (r.missing || 0) + (r.bad || 0),
        samples: items.slice(0, limit).map(it => ({
          movieId: it.id, title: it.title || '', avid: it.avid || '', level: it.level, reason: it.reason || ''
        })),
        notice: '这是只读体检。要真的替换某一条，请调用 repair_poster 并传 movieId'
      };
    }
  },

  // 15. 修复单部海报 (可逆：旧图会归档而不是删除)
  {
    name: 'repair_poster',
    label: '替换单片海报',
    privilege: PRIVILEGE.MUTATING,
    timeoutMs: 90000,
    description: '为指定影片重新搜索并替换海报。只接受通过尺寸/比例校验的候选，宁缺勿错；旧海报归档不删除',
    parameters: {
      type: 'object',
      properties: {
        movieId: { type: 'number', description: '影片 ID（先用 find_missing_posters 或 search_movies 拿）' },
        force: { type: 'boolean', description: '即使当前海报判定健康也强制重找，默认 false' }
      },
      required: ['movieId']
    },
    handler: async (args) => {
      const id = Number(args.movieId);
      const movie = db.getMovieById.get(id);
      if (!movie) return { error: `影片 ${id} 不存在` };
      const { judgeMovie, repairOne } = require('../poster-health');
      const before = judgeMovie(movie);
      if (movie.posterLocked && !args.force) {
        return { skipped: true, reason: '这部影片的封面被用户锁定过（posterLocked=1），按纪律不动', level: before.level };
      }
      const r = await repairOne(db.db, movie, { force: !!args.force, maxCands: 3 });
      const after = db.getMovieById.get(id) ? judgeMovie(db.getMovieById.get(id)) : before;
      return {
        movieId: id,
        title: movie.title || movie.fileName,
        before: { level: before.level, reason: before.reason },
        after: { level: after.level, reason: after.reason },
        changed: before.level !== after.level || (r && r.strategy === 'replace'),
        detail: r || {}
      };
    }
  },

  // 16. 重新刮削单部 (可逆：merge 模式不覆盖手改值)
  {
    name: 'rescrape_movie',
    label: '重新刮削单片',
    privilege: PRIVILEGE.MUTATING,
    timeoutMs: 90000,
    description: '重新联网刮削一部作品的元数据（标题/简介/片商/日期/女优/标签）。默认 merge 只补空，不覆盖用户手改值',
    parameters: {
      type: 'object',
      properties: {
        movieId: { type: 'number', description: '影片 ID' },
        mode: {
          type: 'string',
          description: 'merge(默认，只补空) / overwrite(强制覆盖，会覆盖手改值)',
          enum: ['merge', 'overwrite']
        }
      },
      required: ['movieId']
    },
    handler: async (args) => {
      const id = Number(args.movieId);
      const movie = db.getMovieById.get(id);
      if (!movie) return { error: `影片 ${id} 不存在` };
      if (!movie.filePath || !require('fs').existsSync(movie.filePath)) {
        return { error: '源文件不在磁盘上（可能 NAS 掉线），已跳过', fileName: movie.fileName };
      }
      const { processSingleFile } = require('../scanner');
      const mode = args.mode === 'overwrite' ? 'overwrite' : 'merge';
      const t0 = Date.now();
      await processSingleFile(movie.filePath, movie.type || 'jav', {
        forceWeb: true, mergeMode: mode, ignoreManual: mode === 'overwrite'
      });
      const after = db.getMovieById.get(id) || {};
      return {
        movieId: id,
        mode,
        costMs: Date.now() - t0,
        before: { title: movie.title, overview: (movie.overview || '').slice(0, 40) },
        after: { title: after.title, overview: (after.overview || '').slice(0, 40) },
        titleChanged: movie.title !== after.title
      };
    }
  },

  // 17. 任务/队列状态 (只读)
  {
    name: 'get_library_jobs',
    label: '查询扫描与任务状态',
    privilege: PRIVILEGE.READ_ONLY,
    description: '查看当前扫描进度、海报/补全/打标自愈队列的状态，判断现在能不能跑批量任务',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const scanner = require('../scanner');
      const ensure = require('../ingest-ensure');
      let scan = null, ingest = null;
      try { scan = scanner.getScanStatus(); } catch (e) { }
      try { ingest = ensure.getStatus(); } catch (e) { }
      return {
        scan: scan ? {
          running: !!scan.running, current: scan.current, total: scan.total,
          currentFile: scan.currentFile || '', stats: scan.stats || {}
        } : null,
        ingest: ingest ? {
          pending: ingest.pending || 0, done: ingest.done || 0,
          failed: ingest.failed || 0, filled: ingest.filled || 0,
          postersFixed: ingest.postersFixed || 0, running: !!ingest.running
        } : null
      };
    }
  },

  /* ========================================================================
   * round135 新增：目录读写（全部走沙箱路径牢笼，只允许媒体库目录内）
   * ====================================================================== */

  // 18. 列目录 (只读)
  {
    name: 'list_files',
    label: '浏览目录',
    privilege: PRIVILEGE.READ_ONLY,
    description: '列出一个媒体库目录下的文件/子目录（只允许已配置的媒体库路径内）。用于排查文件是否真的改名/存在',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '绝对路径目录（必须在已配置的媒体库目录内）' },
        limit: { type: 'number', description: '最多返回条数，默认 60' }
      },
      required: ['dir']
    },
    handler: async (args) => {
      const { verifyPathJail } = require('./sandbox');
      const jail = verifyPathJail(args.dir);
      if (!jail.safe) return { error: jail.reason };
      const fs = require('fs');
      const path = require('path');
      const dir = jail.resolvedPath;
      if (!fs.existsSync(dir)) return { error: '目录不存在或当前不可访问（NAS 可能掉线）' };
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return { error: '目标不是目录' };
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 60));
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, limit).map(e => {
        let size = 0;
        try { if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size; } catch (err) { }
        return { name: e.name, isDir: e.isDirectory(), size };
      });
      return { dir, count: fs.readdirSync(dir).length, shown: entries.length, entries };
    }
  },

  // 19. 读文本文件 (只读)
  {
    name: 'read_text_file',
    label: '读取文本文件',
    privilege: PRIVILEGE.READ_ONLY,
    description: '读取媒体库目录内的文本类文件内容（.nfo/.txt/.json/.md/.log/.srt 等，最大 200KB），用于核对 NFO 是否被正确改写',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '绝对路径（必须指向媒体库目录内的文本文件）' },
        maxKB: { type: 'number', description: '最多读取多少 KB，默认 64，上限 200' }
      },
      required: ['filePath']
    },
    handler: async (args) => {
      const { verifyPathJail } = require('./sandbox');
      const jail = verifyPathJail(args.filePath);
      if (!jail.safe) return { error: jail.reason };
      const fs = require('fs');
      const path = require('path');
      const p = jail.resolvedPath;
      const OK = ['.nfo', '.txt', '.json', '.md', '.log', '.srt', '.ass', '.csv', '.ini', '.conf', '.yml', '.yaml'];
      const ext = path.extname(p).toLowerCase();
      if (!OK.includes(ext)) return { error: `只允许读取文本类文件（${OK.join(' ')}），当前是 ${ext || '(无扩展名)'}` };
      if (!fs.existsSync(p)) return { error: '文件不存在或不可访问' };
      const maxBytes = Math.min(200, Math.max(1, Number(args.maxKB) || 64)) * 1024;
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(maxBytes, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return {
        filePath: p, size: st.size,
        truncated: st.size > maxBytes,
        content: buf.toString('utf8')
      };
    }
  },

  // 20. 移动文件 (变更，同盘内)
  {
    name: 'move_file',
    label: '移动/整理文件',
    privilege: PRIVILEGE.MUTATING,
    description: '把媒体库目录内的一个文件移动到同盘另一个目录（不覆盖已有文件）。用于按类型整理目录',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: '源文件绝对路径' },
        dstDir: { type: 'string', description: '目标目录绝对路径（必须已存在，且在媒体库目录内）' }
      },
      required: ['src', 'dstDir']
    },
    handler: async (args) => {
      const { verifyPathJail } = require('./sandbox');
      const fs = require('fs');
      const path = require('path');
      const a = verifyPathJail(args.src);
      const b = verifyPathJail(args.dstDir);
      if (!a.safe) return { error: '源路径被拦截：' + a.reason };
      if (!b.safe) return { error: '目标路径被拦截：' + b.reason };
      if (!fs.existsSync(a.resolvedPath)) return { error: '源文件不存在' };
      if (!fs.statSync(a.resolvedPath).isFile()) return { error: '源路径不是文件' };
      if (!fs.existsSync(b.resolvedPath) || !fs.statSync(b.resolvedPath).isDirectory()) return { error: '目标目录不存在' };
      if (path.parse(a.resolvedPath).root.toLowerCase() !== path.parse(b.resolvedPath).root.toLowerCase()) {
        return { error: '只允许同盘移动（跨盘请用复制+校验的方案，避免半途失败丢文件）' };
      }
      const target = path.join(b.resolvedPath, path.basename(a.resolvedPath));
      if (fs.existsSync(target)) return { error: '目标目录已有同名文件，未覆盖' };
      fs.renameSync(a.resolvedPath, target);
      // 同名 sidecar 一起走，避免 NFO/封面成孤儿
      const ext = path.extname(a.resolvedPath);
      const stem = path.basename(a.resolvedPath, ext);
      const movedSides = [];
      for (const suffix of ['.nfo', '.jpg', '-poster.jpg']) {
        const s = path.join(path.dirname(a.resolvedPath), stem + suffix);
        if (!fs.existsSync(s)) continue;
        const t = path.join(b.resolvedPath, stem + suffix);
        try { if (!fs.existsSync(t)) { fs.renameSync(s, t); movedSides.push(suffix); } } catch (e) { }
      }
      return { ok: true, from: a.resolvedPath, to: target, sidecars: movedSides, notice: '文件已移动，但库内路径未自动更新；请提示用户执行一次扫描' };
    }
  },

  // 21. 移入回收站 (破坏性)
  {
    name: 'trash_file',
    label: '移入回收站',
    privilege: PRIVILEGE.DESTRUCTIVE,
    timeoutMs: 20000,
    warningMessage: '此操作会把文件移出媒体库（移到同盘 .cinemavault-trash 目录），需要你确认',
    description: '把媒体库目录内的文件移入同盘 .cinemavault-trash/日期 目录（可手动找回），不做永久删除',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '要移出的文件绝对路径（必须在媒体库目录内）' }
      },
      required: ['filePath']
    },
    handler: async (args) => {
      const { verifyPathJail } = require('./sandbox');
      const fs = require('fs');
      const path = require('path');
      const jail = verifyPathJail(args.filePath);
      if (!jail.safe) return { error: jail.reason };
      const src = jail.resolvedPath;
      if (!fs.existsSync(src)) return { error: '文件不存在' };
      const st = fs.statSync(src);
      if (!st.isFile()) return { error: '只支持移出单个文件，目录请勿用此工具' };
      const root = path.parse(src).root;
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const trashDir = path.join(root, '.cinemavault-trash', stamp);
      fs.mkdirSync(trashDir, { recursive: true });
      let target = path.join(trashDir, path.basename(src));
      if (fs.existsSync(target)) {
        const ext = path.extname(src);
        target = path.join(trashDir, path.basename(src, ext) + '_' + Date.now() + ext);
      }
      fs.renameSync(src, target);
      return {
        ok: true, from: src, to: target,
        recoverHint: `如需找回，把文件从 ${trashDir} 移回原目录并重新扫描即可`,
        notice: '只是移出媒体库，没有永久删除'
      };
    }
  },

  /* ========================================================================
   * round136：批量作业化
   * 单工具沙箱 90 秒装不下 1477 张海报（3~20 秒/张），所以批量必须变成
   * 「先起作业 → 立刻返回 jobId → 用户用 get_job_status 看进度」。
   * dryRun 默认 true：不显式要求真跑，就只出清单不动任何封面。
   * ====================================================================== */

  // 22. 批量替换海报 (破坏性：会覆盖封面)
  {
    name: 'batch_repair_posters',
    label: '批量替换海报',
    privilege: PRIVILEGE.DESTRUCTIVE,
    timeoutMs: 20000,
    warningMessage: '这会启动一个后台作业，按清单逐张替换封面（旧图归档，可找回）。默认先试跑，不写盘',
    description: '批量替换缺失/低质海报。默认 dryRun=true 只生成清单不动封面；dryRun=false 才会真跑。返回 jobId，用 get_job_status 查进度',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          description: '处理哪一类：missing(只补缺失) / bad(只换低质截图) / all(两者都做)',
          enum: ['missing', 'bad', 'all']
        },
        limit: { type: 'number', description: '本次最多处理多少张，默认 20，上限 500' },
        dryRun: { type: 'boolean', description: 'true=只出清单不写盘（默认）；false=真的替换' },
        force: { type: 'boolean', description: '连 posterLocked（用户锁定过的封面）也换，默认 false' }
      }
    },
    handler: async (args) => {
      const dryRun = args.dryRun !== false;   // 不显式给 false 就按试跑处理
      const job = require('./jobs').startPosterRepair({
        level: args.level || 'bad',
        limit: args.limit || 20,
        dryRun,
        force: !!args.force
      });
      return {
        jobId: job.id,
        dryRun,
        level: args.level || 'bad',
        limit: job.meta.limit,
        message: dryRun
          ? '已启动「试跑」作业：只统计不动封面。用 get_job_status 看清单，确认后再用 dryRun=false 真跑'
          : '已启动后台替换作业。用 get_job_status 查进度，cancel_job 可以随时停',
        notice: '作业在后台串行执行（每条间隔 400ms，避免打爆刮削源）'
      };
    }
  },

  // 23. 查询作业进度 (只读)
  {
    name: 'get_job_status',
    label: '查询作业进度',
    privilege: PRIVILEGE.READ_ONLY,
    description: '查询后台作业进度（批量换海报等）。不传 jobId 就返回最近的作业列表',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '作业 ID；不传则列出最近作业' }
      }
    },
    handler: async (args) => {
      const jobs = require('./jobs');
      if (!args.jobId) {
        const list = jobs.list(10).map(j => {
          const p = jobs.progressOf(j);
          return { id: p.id, type: p.type, status: p.status, percent: p.percent, ok: p.ok, failed: p.failed, total: p.total };
        });
        return { count: list.length, jobs: list };
      }
      const j = jobs.get(args.jobId);
      if (!j) return { error: '没有这个作业（可能应用重启过，内存里的作业已清空；日志仍在 logs/agent-jobs）' };
      return jobs.progressOf(j);
    }
  },

  // 24. 取消作业 (变更)
  {
    name: 'cancel_job',
    label: '取消后台作业',
    privilege: PRIVILEGE.MUTATING,
    description: '请求取消一个正在跑的后台作业（当前那一条跑完就停，不会留下半个文件）',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '作业 ID' }
      },
      required: ['jobId']
    },
    handler: async (args) => {
      const r = require('./jobs').cancel(args.jobId);
      return r;
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
