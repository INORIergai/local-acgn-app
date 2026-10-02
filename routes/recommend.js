const express = require('express');
const router = express.Router();
const {
  getSimilarMovies,
  getRandomMovies,
  getMoviesByHot,
  getUnwatchedMovies,
  getFavoriteMovies,
  getMovieById,
  getMovieTags,
  getMovieActresses
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

// 相似影片推荐（基于标签）
// round43：privacy=exclude 时排除 AV/里番——公开片详情页的「相似推荐」不带出隐私内容
router.get('/similar/:movieId', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 12;
        let movies = getSimilarMovies.all({
            movieId: parseInt(req.params.movieId),
            limit: limit * 2
        });
        const pf = privacyFilter(req);
        if (pf) movies = movies.filter(pf).slice(0, limit);
        res.json({ code: 0, data: movies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 随机推荐
router.get('/random', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 12;
        const type = req.query.type || 'all';

        let movies = getRandomMovies.all(limit * 4); // 多取一些，筛选后再随机

        // round43 隐私分割器：adult=只要 AV/里番；exclude=排除 AV/里番
        const pf = privacyFilter(req);
        if (pf) movies = movies.filter(pf);

        // 按类型筛选（adult 已在上面处理，跳过）
        if (type && type !== 'all' && type !== 'adult') {
            const typeLower = String(type).toLowerCase();
            movies = movies.filter(m => {
                const mType = (m.type || 'jav').toLowerCase();
                return mType === typeLower;
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
        const { recommendMovies } = require('../utils/ai-service');

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

        // 1) 有观看历史时优先用 AI 推荐（加 9 秒超时，避免本地模型卡住导致卡片迟迟不出）
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
            try {
                const searchKeywords = getSearchHistory.all(20).map(s => s.keyword);
                const candidates = allMovies.map(m => {
                    m.tags = getMovieTags.all(m.id);
                    m.actresses = getMovieActresses.all(m.id);
                    return m;
                });
                const recommendedIds = await Promise.race([
                    recommendMovies(historyMovies, candidates, limit * 2, searchKeywords),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('AI 推荐超时')), 9000))
                ]);
                for (const id of recommendedIds || []) take(byId.get(id));
            } catch (e) {
                console.log('[AI推荐] 失败，降级为随机推荐:', e.message);
            }
        }

        // 2) 不足的部分用随机池补齐（保证「换一批」每次都新鲜）
        if (picked.length < limit) {
            for (const m of getRandomMovies.all(limit * 6)) take(m);
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
