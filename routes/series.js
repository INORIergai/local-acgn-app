// ================================================================
// routes/series.js —— round173 追番接口
//   GET   /api/series/search?kw=&limit=            搜索番剧
//   GET   /api/series/list?type=&limit=&offset=    番剧列表
//   GET   /api/series/follows?status=              追番看板（带总集数/已看/下一集）
//   POST  /api/series/follow                       {seriesId, status, favorite}
//   POST  /api/series/unfollow                     {seriesId}
//   POST  /api/series/upsert                       新增/更新番剧（刮削/导入用）
//   POST  /api/series/:id/episodes                 {seasonNo, episodes:[...]} 批量写分集
//   GET   /api/series/:id/episodes?seasonNo=       分集列表（带进度）
//   GET   /api/series/:id/progress                 全番进度 map
//   GET   /api/series/:id/detail                   番详情（季/集/状态）
//   POST  /api/series/episode/progress             {episodeId, position, duration, watched}
//   POST  /api/series/episode/link                 {episodeId, movieId} 挂本地文件
//
//   ★ 路由顺序：字面路径（search/list/follows/...）在前，裸 /:id 在后，防止吞路径。
// ================================================================

const express = require('express');
const router = express.Router();
const sdb = require('../utils/series-db');

// ---- 字面路径（必须先于 /:id） ----
router.get('/search', (req, res) => {
  try {
    const kw = String(req.query.kw || req.query.q || '').trim();
    if (!kw) return res.json({ code: 0, data: [] });
    res.json({ code: 0, data: sdb.searchSeries(kw, req.query.limit) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 从新番放送表导入番剧到 series（lazy：拉当前周表 → 去重 upsert → 标注追番状态）
// GET /api/series/from-calendar?force=1
router.get('/from-calendar', async (req, res) => {
    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const cal = await require('../utils/acg-calendar').getCalendar(force);
        const result = sdb.importFromCalendar(cal && cal.days ? cal.days : []);
        /* 首页要做「周一~周日」切页，必须保留按天分组（result.items 是拍平后的全周）。
         * 这里把导入结果按 date 回填到 cal.days，前端一次请求就能拿到分组和 seriesId。 */
        const days = ((cal && cal.days) || []).map((d) => ({
            date: d.date || '',
            label: d.label || d.date || '',
            items: result.items.filter((it) => it.date === (d.date || '')),
        }));
        res.json({ code: 0, data: Object.assign({}, result, { days }), source: cal && cal.source });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/* 海报右上角 Bangumi 评分（缓存命中立刻返回；未命中在 budgetMs 内并发补拉）。
 * 放在所有 /:id 之前，避免被裸参数路由吞掉。 */
router.get('/ratings', async (req, res) => {
    try {
        const ids = String(req.query.ids || '')
            .split(',')
            .map((x) => Number(x))
            .filter((n) => n > 0)
            .slice(0, 80);
        if (!ids.length) return res.json({ code: 0, data: { ratings: {}, pending: [] } });
        const { db } = require('../utils/db');
        const rows = db.prepare(
            `SELECT id, title, originalTitle, provider, providerId FROM series
             WHERE id IN (${ids.map(() => '?').join(',')})`
        ).all(...ids);
        const r = await require('../utils/series-rating').getRatings(rows, {
            budgetMs: Number(req.query.budgetMs) || 12000,
            force: req.query.force === '1',
        });
        res.json({ code: 0, data: r });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 检查追番更新（把我追的番里已播新集写成站内通知）
router.post('/check-updates', async (req, res) => {
    try {
        const r = await require('../utils/series-notify').checkAiringUpdates({ force: req.body.force === true });
        res.json({ code: 0, data: r });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/list', (req, res) => {
  try {
    res.json({
      code: 0,
      data: sdb.listSeries({
        type: String(req.query.type || ''),
        limit: req.query.limit,
        offset: req.query.offset
      })
    });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/follows', (req, res) => {
  try {
    res.json({ code: 0, data: sdb.getFollowBoard(String(req.query.status || '')) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/follow', (req, res) => {
  try {
    const seriesId = Number(req.body.seriesId);
    if (!seriesId) return res.json({ code: -1, msg: '缺少 seriesId' });
    sdb.setFollow(seriesId, req.body.status || 'watching', req.body.favorite);
    res.json({ code: 0, data: sdb.getSeriesById(seriesId), status: sdb.getFollowStatus(seriesId) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/unfollow', (req, res) => {
  try {
    const ok = sdb.unfollow(Number(req.body.seriesId));
    res.json({ code: 0, data: { removed: ok } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 删除番剧（级联清 episodes/follows/progress）；验证脚本与用户「移除追番」共用
router.post('/delete', (req, res) => {
  try {
    const seriesId = Number(req.body.seriesId);
    const ok = require('../utils/db').db.prepare('DELETE FROM series WHERE id = ?').run(seriesId).changes > 0;
    res.json({ code: 0, data: { removed: ok } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/upsert', (req, res) => {
  try {
    if (!String(req.body.title || '').trim()) return res.json({ code: -1, msg: '缺少 title' });
    res.json({ code: 0, data: sdb.upsertSeries(req.body) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/episode/progress', (req, res) => {
  try {
    const episodeId = Number(req.body.episodeId);
    if (!episodeId) return res.json({ code: -1, msg: '缺少 episodeId' });
    res.json({
      code: 0,
      data: sdb.setEpisodeProgress(episodeId, {
        position: req.body.position,
        duration: req.body.duration,
        watched: req.body.watched == null ? -1 : req.body.watched
      })
    });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 第一档②：读某集跳过片头片尾区间
router.get('/episode/skip', (req, res) => {
  try {
    const episodeId = Number(req.query.episodeId);
    if (!episodeId) return res.json({ code: -1, msg: '缺少 episodeId' });
    const p = sdb.getEpisodeProgress(episodeId);
    res.json({ code: 0, data: { skipOp: (p && p.skipOp) || 0, skipEd: (p && p.skipEd) || 0 } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 第一档②：设置某集跳过片头片尾区间（存 DB，按 series/episode 而非片名）
router.post('/episode/skip', (req, res) => {
  try {
    const episodeId = Number(req.body.episodeId);
    if (!episodeId) return res.json({ code: -1, msg: '缺少 episodeId' });
    res.json({
      code: 0,
      data: sdb.setEpisodeSkip(episodeId, { skipOp: req.body.skipOp, skipEd: req.body.skipEd })
    });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.post('/episode/link', (req, res) => {
  try {
    const ok = sdb.linkEpisodeMovie(req.body.episodeId, req.body.movieId);
    res.json({ code: 0, data: { linked: ok } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 回填单部番的分集（按标题搜 AniList 拿集数，生成第1..N集占位；幂等）
router.post('/:id/backfill-episodes', async (req, res) => {
    try {
        const seriesId = Number(req.params.id);
        if (!sdb.getSeriesById(seriesId)) return res.json({ code: -1, msg: '番剧不存在' });
        const r = await require('../utils/series-episodes').backfillSeries(seriesId, { force: req.body.force === true });
        res.json({ code: r.ok ? 0 : -1, data: r, msg: r.reason || '' });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// v6.5.0 第三档①：系列关系图数据（节点=series，边=标题相似的续作/同系列）
router.get('/graph', (req, res) => {
  try {
    const { db } = require('../utils/db');
    const list = db.prepare('SELECT id, title, originalTitle, provider, type, episodeCount, airDate, posterPath, status FROM series').all();
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
      .replace(/第?\s*\d+\s*[季话集部篇]/g, ' ')
      .replace(/(second|third|final)\s*season|season\s*\d+/gi, ' ')
      .replace(/[\s\p{P}\p{S}]/gu, '')
      .trim();
    const keys = list.map(s => norm(s.title) || norm(s.originalTitle));
    const nodes = list.map((s, i) => ({
      id: s.id, title: s.title, posterPath: s.posterPath || '',
      eps: Number(s.episodeCount) || 0, type: s.type || '',
      status: s.status || '', airDate: s.airDate || '',
      key: keys[i]
    }));
    const edges = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (!a.key || !b.key || a.key.length < 3 || b.key.length < 3) continue;
        // 严格互含（续作/同名不同季）——避免短标题误连
        const related = (a.key === b.key) || (a.key.length >= 4 && b.key.length >= 4 && (a.key.includes(b.key) || b.key.includes(a.key)));
        if (related) edges.push({ source: a.id, target: b.id, kind: a.key === b.key ? 'same' : 'sequel' });
      }
    }
    // 度数，便于前端定节点大小/过滤孤立点
    const deg = {}; edges.forEach(e => { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1; });
    nodes.forEach(n => { n.degree = deg[n.id] || 0; });
    // 规模控制：关系图只画有关联的节点 + 少量高集数代表；全量番几千个画不动。
    const total = nodes.length, totalLinks = edges.length;
    const withLinks = new Set(edges.flatMap(e => [e.source, e.target]));
    let keep = nodes.filter(n => withLinks.has(n.id));
    const room = Math.max(0, 200 - keep.length);
    if (room > 0) keep = keep.concat(nodes.filter(n => !withLinks.has(n.id)).sort((a, b) => b.eps - a.eps).slice(0, room));
    const keepIds = new Set(keep.map(n => n.id));
    res.json({ code: 0, data: { nodes: keep, edges: edges.filter(e => keepIds.has(e.source) && keepIds.has(e.target)),
      stats: { series: total, shown: keep.length, links: totalLinks } } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// ---- round181：追番在线源闭环（字面路径，必须在 /:id 前） ----
/** 按番名并发搜索所有在线源，返回有结果的源、失败状态分布、以及自动选源建议 */
router.post('/match-online', async (req, res) => {
  try {
    const seriesId = Number(req.body.seriesId || req.params.id);
    const kw = String(req.body.keyword || '').trim();
    const s = sdb.getSeriesById(seriesId);
    const keyword = kw || (s && s.title) || '';
    if (!keyword) return res.json({ code: -1, msg: '缺少搜索关键词' });
    const online = require('../utils/series-online');
    const found = await online.searchAllWeb(keyword, {
      timeout: Number(req.body.timeout) || 12000,
      force: req.body.force === true
    });
    const autoPick = online.pickBest(found.hits, keyword);
    // captcha 源单独拎出来，前端给「去验证」入口（不然用户只看到"没有结果"）
    const needsVerify = found.all.filter(x => x.state === 'captcha')
      .map(x => ({ sourceId: x.sourceId, sourceName: x.sourceName }));
    res.json({ code: 0, data: {
      keyword, hits: found.hits, all: found.all, states: found.states,
      scanned: found.scanned, skipped: found.skipped,
      autoPick, needsVerify
    } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/**
 * Kazumi 式「点某一集 → 并发问所有源要这一集」的候选端点。
 * 与 /match-online 的区别：这里会把每个命中源的剧集列表也取回来，按集号对齐，
 * 直接给出「能播这一集的播放页 URL」。前端点候选 → /api/media-source/resolve 播放，
 * 不需要先把整季挂到 DB（挂载仍保留给「一键追番」用）。
 */
router.post('/episode/sources', async (req, res) => {
  try {
    const kw = String(req.body.keyword || '').trim();
    const epNo = Number(req.body.episodeNo || 0);
    if (!kw) return res.json({ code: -1, msg: '缺少关键词' });
    if (!epNo) return res.json({ code: -1, msg: '缺少集号' });
    const online = require('../utils/series-online');
    const engine = require('../utils/media-sources/engine');
    const found = await online.searchAllWeb(kw, {
      timeout: Number(req.body.timeout) || 10000,
      force: req.body.force === true,
    });
    const maxSources = Math.min(12, Math.max(1, Number(req.body.maxSources) || 8));
    const targets = (found.hits || []).slice(0, maxSources);

    const numOf = (e) => {
      const n = Number(e.episodeNo ?? e.no ?? e.sort);
      if (Number.isFinite(n) && n > 0) return n;
      const name = String(e.name || '');
      const m = /第\s*([\d.]+)\s*[话集]/.exec(name);
      if (m) return parseFloat(m[1]);
      // 很多源的集名就是「01」「1」「12.5」这种纯数字（前导零也要认）
      const m2 = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(name);
      return m2 ? parseFloat(m2[1]) : NaN;
    };

    const out = [];
    let cursor = 0;
    // 小并发（3）取剧集：整季页面通常较重，并发过高容易被 WAF 判爬
    const worker = async () => {
      while (cursor < targets.length) {
        const h = targets[cursor++];
        const src = engine.getSource(h.sourceId);
        const row = {
          sourceId: h.sourceId, sourceName: h.sourceName, tier: h.tier,
          entryName: '', detailUrl: '', episodeName: '', episodeUrl: '',
          totalEps: 0, state: 'error', error: '',
        };
        if (!src) { row.error = '源已失效'; out.push(row); continue; }
        // 选标题最像的一条（原来按名字最短挑，多季合页时会挑到「第1-3季258集」那种合集）
        const { titleScore } = require('../utils/series-online');
        const item = (h.items || []).slice().sort(
          (a, b) => titleScore(b.name, kw) - titleScore(a.name, kw))[0];
        if (!item) { row.state = 'noResult'; row.error = '无匹配条目'; out.push(row); continue; }
        row.entryName = item.name;
        row.detailUrl = item.url;
        try {
          const epRes = await engine.episodesOf(src, item.url, { timeout: 12000 });
          const eps = epRes.episodes || [];
          row.totalEps = eps.length;   // 源侧总集数（多季合页时会很大，仅供参考）
          /* 只认「集号真正等于 epNo」的条目。原来还带 `|| eps[epNo-1]` 的下标兜底，
           * 多季合页时会静默取到别的季的第 N 集（用户点了第1集却播成第2季第1集）。 */
          const exact = eps.filter((e) => numOf(e) === epNo);
          // 同集号有多条时优先第一线路（channelTier 小）
          exact.sort((a, b) => (a.channelTier || 0) - (b.channelTier || 0));
          /* 2026-11：Kazumi 语义 —— 源返回的剧集数组顺序就是集号（episodeIndex+1）。
             很多源的标题是「更新至12集」「01」「HD」这类，numOf 抠不出数字，
             只认 exact 会导致整源判“未定位到第 N 集”。这里加下标兜底：
               · 源集数明显大于目标集数（多季合页，> epNo*3+12）时不兜底，避免串季；
               · 标题能抠出数字且与 epNo 差超过 1 时不兜底（源从第 0 集/预告开始会差 1）。 */
          let hit = exact[0];
          if (!hit && eps.length) {
            const byIndex = eps[epNo - 1];
            const suspicious = eps.length > epNo * 3 + 12;
            const n = byIndex ? numOf(byIndex) : NaN;
            if (byIndex && byIndex.url && !suspicious && (!Number.isFinite(n) || Math.abs(n - epNo) <= 1)) {
              hit = byIndex;
            }
          }
          row.factory = src.factoryId || '';
          if (hit && hit.url) {
            row.state = 'ready';
            row.episodeName = '第' + epNo + '集';
            row.episodeUrl = hit.url;
          } else {
            row.state = 'noEpisode';
            row.error = eps.length
              ? ('未定位到第' + epNo + '集（源共 ' + eps.length + ' 集，可能是多季合页）')
              : (epRes.error || '剧集解析为空');
          }
        } catch (e) {
          row.state = 'error';
          row.error = (e && e.message) || '剧集解析失败';
        }
        out.push(row);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    /* 排序：能播的在前 → 直出 API 源（json-api/next）优先于需要浏览器嗅探的源 →
       源 tier。用户点第一张卡片就能播，不必等 web-selector 的 30 秒嗅探。 */
    const readyRank = (r) => (r.state === 'ready' ? 0 : 1);
    /* 直出 API（json-api）最快；web-selector 要开页面抽 URL；kazumi 规则常要浏览器嗅探，
       放在最后，避免用户点第一张就等 30 秒。 */
    const factoryRank = (r) => (r.factory === 'json-api' ? 0 : (r.factory === 'kazumi' ? 2 : 1));
    out.sort((a, b) => readyRank(a) - readyRank(b) || factoryRank(a) - factoryRank(b) || (a.tier || 0) - (b.tier || 0));
    res.json({ code: 0, data: {
      keyword: kw, episodeNo: epNo, candidates: out,
      states: found.states, scanned: found.scanned,
    } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/**
 * Kazumi 式主流程（第 1 步）：按番名并发搜索所有源，返回「每个源最匹配的一条」。
 * 前端详情页先把这排源摆出来，用户点哪个源，再去取那个源的全集。
 * 与 /match-online 的区别：这里按「源」去重，只回最像的一条条目，且放宽到 0.45
 * （手动选源允许用户自己判断；自动挂载仍用 0.55 阈值）。
 */
router.post('/sources', async (req, res) => {
    try {
        const seriesId = Number(req.body.seriesId) || 0;
        const s = seriesId ? sdb.getSeriesById(seriesId) : null;
        const keyword = String(req.body.keyword || (s && s.title) || '').trim();
        if (!keyword) return res.json({ code: -1, msg: '缺少搜索关键词' });
        const online = require('../utils/series-online');
        const engine = require('../utils/media-sources/engine');
        const found = await online.searchAllWeb(keyword, {
            timeout: Number(req.body.timeout) || 12000,
            force: req.body.force === true,
        });
        const { titleScore } = online;
        const seen = new Set();
        const sources = [];
        (found.hits || []).forEach((h) => {
            if (seen.has(h.sourceId)) return;
            const items = (h.items || []).slice()
                .sort((a, b) => titleScore(b.name, keyword) - titleScore(a.name, keyword));
            const best = items[0];
            if (!best || !best.url) return;
            const score = titleScore(best.name, keyword);
            if (score < 0.45) return;
            seen.add(h.sourceId);
            const src = engine.getSource(h.sourceId);
            sources.push({
                sourceId: h.sourceId,
                sourceName: h.sourceName,
                tier: h.tier,
                factory: (src && src.factoryId) || '',
                entryName: best.name,
                detailUrl: best.url,
                score: Math.round(score * 100) / 100,
            });
        });
        /* 先按标题相似度；同分时直出 API 源排前（不用开浏览器，最快），kazumi 嗅探源排最后 */
        const factoryRank = (r) => (r.factory === 'json-api' ? 0 : (r.factory === 'kazumi' ? 2 : 1));
        sources.sort((a, b) => (b.score - a.score)
            || (factoryRank(a) - factoryRank(b))
            || ((a.tier || 0) - (b.tier || 0)));
        res.json({ code: 0, data: {
            keyword, sources,
            states: found.states, scanned: found.scanned, skipped: found.skipped,
            needsVerify: (found.all || []).filter((x) => x.state === 'captcha')
                .map((x) => ({ sourceId: x.sourceId, sourceName: x.sourceName })),
        } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/**
 * Kazumi 式主流程（第 2 步）：取「这个源下这部番的全集」并挂到分集（可选）。
 * 集号语义对齐 Kazumi：源给的 sort 可信（全有效/唯一/递增）时用它，
 * 否则用数组顺序（多季合页/预告混排时保证「顺序观看」不跳集）。
 * 返回 progress（按集号）与 nextEpisode，前端可以直接「从第 N 集开始」。
 */
router.post('/source-episodes', async (req, res) => {
    try {
        const seriesId = Number(req.body.seriesId) || 0;
        const seasonNo = Number(req.body.seasonNo) || 1;
        const sourceId = String(req.body.sourceId || '');
        const detailUrl = String(req.body.detailUrl || '');
        const entryName = String(req.body.entryName || '');
        if (!sourceId || !detailUrl) return res.json({ code: -1, msg: '缺少 sourceId/detailUrl' });
        const engine = require('../utils/media-sources/engine');
        const src = engine.getSource(sourceId);
        if (!src) return res.json({ code: -1, msg: '源不存在：' + sourceId });

        const epRes = await engine.episodesOf(src, detailUrl, { timeout: Number(req.body.timeout) || 15000 });
        const raw = (epRes.episodes || []).filter((e) => e && e.url);
        if (!raw.length) {
            return res.json({ code: 1, msg: epRes.error || '该源没有解析出剧集', data: {
                sourceId, sourceName: src.name, entryName, detailUrl,
                episodes: [], progress: {}, nextEpisode: 0, attached: 0,
                state: epRes.state || 'noResult', error: epRes.error || '剧集解析为空',
            } });
        }

        const nums = raw.map((e) => { const n = Number(e.sort); return Number.isFinite(n) && n > 0 ? n : NaN; });
        const allValid = nums.every((n) => Number.isFinite(n));
        const unique = new Set(nums).size === nums.length;
        const increasing = nums.every((n, i) => i === 0 || n > nums[i - 1]);
        const trustSort = allValid && unique && increasing;
        const episodes = raw.map((e, i) => ({
            episodeNo: trustSort ? nums[i] : i + 1,
            title: String(e.name || '').trim() || ('第' + (i + 1) + '集'),
            url: e.url,
            channel: e.channel || '',
        }));

        let progress = {};
        let attached = 0;
        if (seriesId) {
            /* 挂到 DB 是为了复用 episode 进度/继续观看；已绑本地影片的集不会被覆盖。
             * 失败（例如季度创建异常）不影响直接播放，只是进度不会记。 */
            const r = sdb.applyOnlineSource(seriesId, seasonNo, sourceId, src.name, episodes);
            attached = r.updated || 0;
            sdb.getEpisodes(seriesId, seasonNo).forEach((le) => {
                progress[le.episodeNo] = {
                    id: le.id,
                    watched: le.watched === 1,
                    position: Number(le.position) || 0,
                    duration: Number(le.progressDuration || le.duration) || 0,
                };
            });
        }
        let nextEpisode = 0;
        for (const ep of episodes) {
            const p = progress[ep.episodeNo];
            if (!p || !p.watched) { nextEpisode = ep.episodeNo; break; }
        }
        res.json({ code: 0, data: {
            sourceId, sourceName: src.name, entryName, detailUrl,
            episodes, progress, nextEpisode, attached,
            state: epRes.state || 'success', error: epRes.error || '', via: epRes.via || '',
        } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/**
 * 一键挂载：搜源 → 按标题相似度 + tier 选最优 → 解析剧集 → 写进 episodes。
 * 前端「+ 追番」成功后直接调它，失败了再降级成手动选源弹窗。
 */
router.post('/auto-attach', async (req, res) => {
  try {
    const seriesId = Number(req.body.seriesId);
    if (!seriesId) return res.json({ code: -1, msg: '缺少 seriesId' });
    const s = sdb.getSeriesById(seriesId);
    if (!s) return res.json({ code: -1, msg: '番剧不存在' });
    const keyword = String(req.body.keyword || s.title || '').trim();
    const seasonNo = Number(req.body.seasonNo || 1);
    const r = await require('../utils/series-online').autoAttach(seriesId, keyword, seasonNo, {
      force: req.body.force === true,
      timeout: Number(req.body.timeout) || 12000
    });
    const ok = r.attached > 0;
    res.json({ code: ok ? 0 : 1, data: r,
      msg: ok ? '' : (r.reason || '没有可用的在线源') });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/** 解除某源的黑名单冷却（用户手动点「重试这个源」时用） */
router.post('/online-retry-source', (req, res) => {
  try {
    const sourceId = String(req.body.sourceId || '');
    if (!sourceId) return res.json({ code: -1, msg: '缺少 sourceId' });
    const engine = require('../utils/media-sources/engine');
    if (sourceId === '*') engine.clearCooldown(); else engine.clearCooldown(sourceId);
    res.json({ code: 0, data: { cleared: sourceId } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/** 选一个源+条目，把它的剧集挂到本季分集 */
router.post('/apply-online', async (req, res) => {
  try {
    const seriesId = Number(req.body.seriesId);
    const sourceId = String(req.body.sourceId || '');
    const detailUrl = String(req.body.detailUrl || '');
    const seasonNo = Number(req.body.seasonNo || 1);
    if (!seriesId || !sourceId || !detailUrl) return res.json({ code: -1, msg: '缺少 seriesId/sourceId/detailUrl' });
    const engine = require('../utils/media-sources/engine');
    const src = engine.getSource(sourceId);
    if (!src) return res.json({ code: -1, msg: '源不存在：' + sourceId });
    const epRes = await engine.episodesOf(src, detailUrl, { timeout: 15000 });
    // episodesOf 返回 {name, sort, url, channel...}：集号在 sort（名字正则提取），不是 episodeNo
    const eps = (epRes.episodes || []).map((e, i) => {
      let no = Number(e.episodeNo ?? e.no ?? e.sort);
      if (!no) {
        const m = /第\s*([\d.]+)\s*[话集]/.exec(String(e.name || ''));
        if (m) no = parseFloat(m[1]);
      }
      if (!no) no = i + 1;   // 实在没集号就按出现顺序，总比丢掉强
      return { episodeNo: no, title: e.name || e.title || '', url: e.url || e.href || '' };
    }).filter(e => e.episodeNo > 0 && e.url);
    if (!eps.length) return res.json({ code: -1,
      msg: `该条目没解析出可用剧集（原始 ${(epRes.episodes || []).length} 条，error=${epRes.error || '无'}，url=${detailUrl.slice(0, 80)}）` });
    const r = sdb.applyOnlineSource(seriesId, seasonNo, sourceId, src.name, eps);
    res.json({ code: r.error ? -1 : 0, data: { updated: r.updated, total: eps.length }, msg: r.error });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

/** 取某集的在线源信息；前端拿 sourceId/url 直接复用现成的 /api/media-source/resolve 播放 */
router.get('/episode/online-url', (req, res) => {
  try {
    const ep = sdb.getEpisodeSource(req.query.episodeId);
    if (!ep || !ep.sourceId || !ep.sourceUrl) return res.json({ code: -1, msg: '该集没有在线源' });
    const src = require('../utils/media-sources/engine').getSource(ep.sourceId);
    if (!src) return res.json({ code: -1, msg: '源已失效：' + ep.sourceId });
    res.json({ code: 0, data: {
      sourceId: ep.sourceId, sourceName: ep.sourceName || src.name,
      url: ep.sourceUrl, episodeNo: ep.episodeNo,
      movieId: ep.movieId || null
    } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// ---- 带 /:id 的路径（字面路径已处理完） ----
router.post('/:id/episodes', (req, res) => {
  try {
    const seriesId = Number(req.params.id);
    if (!sdb.getSeriesById(seriesId)) return res.json({ code: -1, msg: '番剧不存在' });
    const data = sdb.bulkUpsertEpisodes(seriesId, req.body.seasonNo || 1, req.body.episodes || []);
    res.json({ code: 0, data });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/:id/episodes', (req, res) => {
  try {
    res.json({ code: 0, data: sdb.getEpisodes(req.params.id, req.query.seasonNo || 1) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/:id/progress', (req, res) => {
  try {
    res.json({ code: 0, data: sdb.getEpisodeProgressMap(req.params.id) });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/:id/detail', (req, res) => {
  try {
    const detail = sdb.getSeriesDetail(req.params.id);
    if (!detail) return res.json({ code: -1, msg: '番剧不存在' });
    res.json({ code: 0, data: detail });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

// 裸 /:id 放最后
router.get('/:id', (req, res) => {
  try {
    const s = sdb.getSeriesById(req.params.id);
    if (!s) return res.json({ code: -1, msg: '番剧不存在' });
    res.json({ code: 0, data: s });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

module.exports = router;
