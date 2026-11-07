const express = require('express');
const router = express.Router();
const {
  db,
  getSimilarMovies,
  getRandomMovies,
  getRandomMoviesTyped,
  getMoviesByHot,
  getUnwatchedMovies,
  getFavoriteMovies,
  getMovieById,
  getMovieTags,
  getMovieActresses,
  getMoviesByActress
} = require('../utils/db');

// ---------- round43 隐私分割器 ----------
// privacy=exclude → 排除 AV/里番（公开视图干净）；type=adult → 只看 AV/里番（隐私组同款功能块）
// NULL type 按 jav 归类（与 movie.js 口径一致）
const isAdultItem = (m) => ['jav', 'anime'].includes(String(m.type || 'jav').toLowerCase());
function privacyFilter(req) {
    const privacy = String(req.query.privacy || '').toLowerCase();
    const type = String(req.query.type || 'all').toLowerCase();
    if (type === 'adult' || privacy === 'adult') return isAdultItem;          // 隐私版：只要 AV/里番
    if (privacy === 'exclude') return (m) => !isAdultItem(m);                 // 公开版：排除 AV/里番
    return null;                                                              // 不过滤
}

// 相似影片推荐（多梯队：同女优 -> 共同标签 -> 同系列/片商/导演 -> 同类型热门补齐）
// round43：privacy=exclude 时排除 AV/里番——公开片详情页的「相似推荐」不带出隐私内容
router.get('/similar/:movieId', (req, res) => {
    try {
        const movieId = parseInt(req.params.movieId);
        const limit = Math.max(parseInt(req.query.limit) || 12, 12);
        const target = getMovieById.get(movieId);
        if (!target) return res.json({ code: 0, data: [] });

        const pf = privacyFilter(req);
        const picked = [];
        const seen = new Set([movieId]);

        const take = (m) => {
            if (!m || picked.length >= limit) return;
            if (seen.has(m.id)) return;
            if (pf && !pf(m)) return;
            seen.add(m.id);
            picked.push(m);
        };

        // 梯队 1：同女优作品（AV / 影视用户首选关联网）
        try {
            const actresses = getMovieActresses.all(movieId) || [];
            for (const a of actresses) {
                if (!a || !a.id) continue;
                // 排除自动匹配出的长短脏名（如“彼女のお姉さん”）若 movieCount 过少
                const mList = getMoviesByActress.all(a.id) || [];
                for (const m of mList) {
                    take(m);
                    if (picked.length >= limit) break;
                }
                if (picked.length >= limit) break;
            }
        } catch (e1) {
            console.warn('[相似推荐] 梯队1女优召回异常:', e1.message);
        }

        // 梯队 2：共同标签最多的作品
        if (picked.length < limit) {
            try {
                const tagSimilar = getSimilarMovies.all({
                    movieId: movieId,
                    limit: limit * 3
                }) || [];
                for (const m of tagSimilar) {
                    take(m);
                    if (picked.length >= limit) break;
                }
            } catch (e2) {
                console.warn('[相似推荐] 梯队2标签召回异常:', e2.message);
            }
        }

        // 梯队 3：同系列 / 同制作商 / 同导演
        if (picked.length < limit) {
            try {
                if (target.serial) {
                    const serialList = db.prepare('SELECT * FROM movies WHERE serial = ? AND id != ? ORDER BY releaseDate DESC, id DESC LIMIT ?').all(target.serial, movieId, limit);
                    for (const m of serialList) {
                        take(m);
                        if (picked.length >= limit) break;
                    }
                }
                if (picked.length < limit && target.producer) {
                    const prodList = db.prepare('SELECT * FROM movies WHERE producer = ? AND id != ? ORDER BY releaseDate DESC, id DESC LIMIT ?').all(target.producer, movieId, limit);
                    for (const m of prodList) {
                        take(m);
                        if (picked.length >= limit) break;
                    }
                }
            } catch (e3) {
                console.warn('[相似推荐] 梯队3系列片商召回异常:', e3.message);
            }
        }

        // 梯队 4：同类型（jav / anime / film / cartoon 等）热门或随机补齐，确保永不只显示一两个海报
        if (picked.length < limit) {
            try {
                const typeLower = String(target.type || 'jav').toLowerCase();
                const randomList = (typeLower !== 'all' && typeLower !== 'adult')
                    ? getRandomMoviesTyped.all(typeLower, limit * 4)
                    : getRandomMovies.all(limit * 4);
                for (const m of randomList) {
                    take(m);
                    if (picked.length >= limit) break;
                }
            } catch (e4) {
                console.warn('[相似推荐] 梯队4兜底补齐异常:', e4.message);
            }
        }

        // 排序微调：优先把有海报（localPosterPath 或 posterPath 非空）的排在前列
        picked.sort((a, b) => {
            const hasPosterA = (a.localPosterPath || a.posterPath) ? 1 : 0;
            const hasPosterB = (b.localPosterPath || b.posterPath) ? 1 : 0;
            return hasPosterB - hasPosterA;
        });

        res.json({ code: 0, data: picked.slice(0, limit) });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 随机推荐
router.get('/random', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 12;
        const type = req.query.type || 'all';

        /* ★ round81：类型条件下推到 SQL。
           原来是全表 RANDOM() 取 limit*4 条再按 type 过滤 —— 小说只有 9/3987，
           随机 160 条命中的概率约 30%，实测 6 次里 5 次是 0 条，
           小说视图的「精选推荐」几乎永远是空的。 */
        const typeLower0 = String(type || 'all').toLowerCase();
        let movies = (typeLower0 !== 'all' && typeLower0 !== 'adult')
          ? getRandomMoviesTyped.all(typeLower0, limit * 4)
          : getRandomMovies.all(limit * 4);

        // round43 隐私分割器：adult=只要 AV/里番；exclude=排除 AV/里番
        const pf = privacyFilter(req);
        if (pf) movies = movies.filter(pf);

        // 兜底：类型已在 SQL 里过滤过（NULL type 按 jav 归类，与 movie.js 口径一致）
        if (typeLower0 !== 'all' && typeLower0 !== 'adult') {
            movies = movies.filter(m => {
                const mType = (m.type || 'jav').toLowerCase();
                return mType === typeLower0;
            });
        }
        
        // 随机打乱并取limit个
        const shuffled = movies.sort(() => 0.5 - Math.random());
        const result = shuffled.slice(0, limit);
        
        res.json({ code: 0, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 热门排行
router.get('/hot', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const pf = privacyFilter(req);
        if (!pf) {
            return res.json({ code: 0, data: getMoviesByHot.all(limit, 0) });
        }
        // 多取 3 倍过滤后再截断，保证过滤后仍够 limit 条
        const movies = getMoviesByHot.all(limit * 3, 0).filter(pf).slice(0, limit);
        res.json({ code: 0, data: movies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 猜你喜欢（AI推荐，基于观看历史和搜索历史）
//
// 支持 `exclude`：逗号分隔的影片 id，「换一批」用它排除已经展示过的片子。
// 关键：AI 结果不足时用 **随机池** 补齐，而不是原来的「固定热门榜」——
// 热门榜每次都是同一批，换了等于没换，魔术卡片的「换一批」会立刻失去意义。
const _aiGuessCache = { ids: [], ts: 0, warming: false };

function warmAiGuessPoolAsync(historyMovies, allMovies) {
    if (_aiGuessCache.warming) return;
    if (Date.now() - _aiGuessCache.ts < 5 * 60 * 1000 && _aiGuessCache.ids.length > 0) return;
    _aiGuessCache.warming = true;
    setImmediate(async () => {
        try {
            const { getSearchHistory, getMovieTags, getMovieActresses } = require('../utils/db');
            const { recommendMovies } = require('../utils/ai-service');
            const searchKeywords = getSearchHistory.all(20).map(s => s.keyword);
            // 只抽样 80 条候选查标签/女优，避免对全库 9000+ 条目跑 1.8 万次同步 SQL
            const sample = allMovies
                .filter(m => m && (m.localPosterPath || m.posterPath))
                .sort(() => 0.5 - Math.random())
                .slice(0, 80)
                .map(m => ({
                    ...m,
                    tags: getMovieTags.all(m.id),
                    actresses: getMovieActresses.all(m.id)
                }));
            const ids = await Promise.race([
                recommendMovies(historyMovies, sample, 48, searchKeywords),
                new Promise((_, reject) => setTimeout(() => reject(new Error('AI 后台预热超时')), 6000))
            ]);
            if (Array.isArray(ids) && ids.length) {
                _aiGuessCache.ids = ids;
                _aiGuessCache.ts = Date.now();
            }
        } catch (e) {
            // 后台预热静默降级
        } finally {
            _aiGuessCache.warming = false;
        }
    });
}

router.get('/guess', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 12, 60);
        const excludeSet = new Set(
            String(req.query.exclude || '')
                .split(',')
                .map(s => parseInt(s, 10))
                .filter(n => Number.isFinite(n) && n > 0)
        );

        const { getAllMovies, getWatchHistory, getSearchHistory, getMovieTags, getMovieActresses } = require('../utils/db');

        const allMovies = getAllMovies.all();
        const byId = new Map(allMovies.map(m => [m.id, m]));

        const picked = [];
        const seen = new Set();
        const pf = privacyFilter(req);           // round43 隐私分割器
        const take = (movie) => {
            if (!movie || picked.length >= limit) return;
            if (pf && !pf(movie)) return;        // AI 结果与随机池补齐都要过隐私闸
            if (seen.has(movie.id) || excludeSet.has(movie.id)) return;
            seen.add(movie.id);
            picked.push(movie);
        };

        // 1) 优先消费后台已预热的 AI 推荐池 + 历史同系列/同作者亲和召回（毫秒级响应，不阻塞首屏）
        const history = getWatchHistory.all(20, 0);
        const historyMovies = history.map(h => {
            const movie = byId.get(h.movieId);
            if (movie) {
                movie.tags = getMovieTags.all(movie.id);
                movie.actresses = getMovieActresses.all(movie.id);
            }
            return movie || null;
        }).filter(Boolean);

        if (historyMovies.length > 0 && picked.length < limit) {
            for (const id of _aiGuessCache.ids || []) take(byId.get(id));
            // 基于最近观看的同系列 / 相似作品即时召回
            for (const hm of historyMovies.slice(0, 4)) {
                try {
                    const sim = getSimilarMovies.all({ movieId: hm.id, limit: 6 }) || [];
                    for (const sm of sim) take(sm);
                } catch (e) {}
            }
            warmAiGuessPoolAsync(historyMovies, allMovies);
        }

        // 2) 不足的部分用带封面的随机池优先补齐（保证展台视觉完整且每次「换一批」都新鲜）
        if (picked.length < limit) {
            const randPool = getRandomMovies.all(limit * 6);
            const withArt = randPool.filter(m => m && (m.localPosterPath || m.posterPath));
            const noArt = randPool.filter(m => m && !(m.localPosterPath || m.posterPath));
            for (const m of withArt) take(m);
            for (const m of noArt) take(m);
        }

        // 3) 极端情况：全库 id 都被 exclude 掉了，退化为热门，保证卡片位不空
        if (picked.length === 0) {
            for (const m of getMoviesByHot.all(limit * 3, 0)) {
                if (pf && !pf(m)) continue;
                if (!seen.has(m.id)) { seen.add(m.id); picked.push(m); }
            }
        }

        res.json({ code: 0, data: picked });
    } catch (e) {
        console.log('[猜你喜欢] 错误:', e.message);
        try {
            const pf2 = privacyFilter(req);
            const fb = pf2 ? getMoviesByHot.all(60, 0).filter(pf2).slice(0, 12) : getMoviesByHot.all(12, 0);
            res.json({ code: 0, data: fb });
        } catch (e2) {
            res.json({ code: -1, msg: e.message });
        }
    }
});

// 未观看推荐
router.get('/unwatched', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const privacy = String(req.query.privacy || '').toLowerCase();
        const type = String(req.query.type || 'all').toLowerCase();
        const db = require('../utils/db').db || require('../db');

        let sql = `SELECT * FROM movies WHERE watched = 0`;
        const params = [];

        // r65: SQL 级严格类型过滤，避免内存 filter 导致公开库数据被耗尽变成空列表
        if (type === 'adult' || privacy === 'adult') {
            sql += ` AND (LOWER(type) = 'jav' OR LOWER(type) = 'anime' OR type IS NULL)`;
        } else if (privacy === 'exclude') {
            sql += ` AND (LOWER(type) NOT IN ('jav', 'anime') AND type IS NOT NULL)`;
        }

        sql += ` ORDER BY addedTime DESC, id DESC LIMIT ?`;
        params.push(limit);

        const movies = db.prepare(sql).all(...params);
        res.json({ code: 0, data: movies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 影片详情（带标签和女优）
router.get('/movie/:id', (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '不存在' });
        
        const tags = getMovieTags.all(req.params.id);
        const actresses = getMovieActresses.all(req.params.id);
        
        res.json({ 
            code: 0, 
            data: {
                ...movie,
                tags,
                actresses
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
