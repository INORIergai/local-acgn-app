const express = require('express');
const router = express.Router();
const {
    db,
    TAG_LIB_TYPES,
    getTagsByLib,
    getTopTagsByLib,
    getTagCountInLib,
    getTagPosters,
    seriesKey,
    getTagMovies,
    getTagsFilter,
    getTagYearHistogram,
    getTagCooccurrence,
    getTagById,
    getAliasesOfTag,
    insertTagAlias,
    getMoviesByTag,
    getMoviesByTags,
    getAllTags,
    upsertTag,
    addMovieTag,
    getTagByName
} = require('../utils/db');

/* ============================================================
 * round168 · 标签 API
 *
 * 五库作用域：?lib=film|anime|comic|novel|jav
 *   兼容旧参数 ?type=jav|anime|film|cartoon|comic|novel|all（映射到 lib）
 *   非法 lib 一律 400，不再静默退化成「全部库」——静默兜底会让用户
 *   在「漫画库」里看到 AV 标签，还以为是 bug。
 * ============================================================ */

const LIB_LABEL = { film: '影视库', anime: '动漫库', comic: '漫画库', novel: '小说库', jav: 'AV库' };

function parseLib(req) {
    const raw = req.query.lib != null ? req.query.lib : req.query.type;
    if (raw == null || raw === '' || raw === 'all') return { ok: true, lib: null };
    const v = String(raw);
    if (Object.prototype.hasOwnProperty.call(TAG_LIB_TYPES, v)) return { ok: true, lib: v };
    if (v === 'cartoon') return { ok: true, lib: 'film' }; // 旧口径：cartoon 并入影视
    return { ok: false, msg: `未知库: ${v}（可选 ${Object.keys(TAG_LIB_TYPES).join(' / ')}）` };
}

const badLib = (res, m) => res.status(400).json({ code: -1, msg: m });

/* ★★ dryRun 参数必须吃 boolean：
 *   之前写 String(body.dryRun) !== '0'，传 false 会变成 "false" ≠ "0" ⇒ 永远判成 true，
 *   于是「清理空标签」「把类目写入库」点了什么都不发生（且接口返回 code 0，看不出问题）。
 *   统一走这个函数：undefined/null 用默认值，boolean 原样，字符串认 0/false/no。 */
function isDryRun(v, dflt) {
    if (v === undefined || v === null || v === '') return dflt;
    if (typeof v === 'boolean') return v;
    const s = String(v).toLowerCase();
    return !(s === '0' || s === 'false' || s === 'no');
}

// ---------- 标签列表 ----------
// round168：只返回本库至少挂 1 部作品的标签（幽灵标签走 /prune-empty）
router.get('/', (req, res) => {
    try {
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        let list = getTagsByLib(p.lib);
        // 附带别名：合并后旧名仍能搜索命中
        const aliasRows = db.prepare(`SELECT tagId, aliasName FROM tag_alias`).all();
        const aliasMap = new Map();
        for (const a of aliasRows) {
            if (!aliasMap.has(a.tagId)) aliasMap.set(a.tagId, []);
            aliasMap.get(a.tagId).push(a.aliasName);
        }
        for (const t of list) t.aliases = aliasMap.get(t.id) || [];

        /* ★ 筛选在服务端做：复用 tag-space 的归一化（NFKC + OpenCC 繁转简 + 日文新字体 + 量词）
         *   前端 toLowerCase().includes() 做不到「高画质」命中「高畫質」，
         *   而 placeholder 已经承诺了「支持繁简」，不能口嗨。 */
        const rawQ = String(req.query.q || '').trim();
        if (rawQ) {
            const tagSpace = require('../utils/tag-space');
            const nq = tagSpace.normalizeTagName(rawQ);
            list = list.filter(t => {
                if (tagSpace.normalizeTagName(t.name).includes(nq)) return true;
                return (t.aliases || []).some(a => tagSpace.normalizeTagName(a).includes(nq));
            });
        }

        res.json({
            code: 0,
            data: list,
            meta: { lib: p.lib, label: p.lib ? LIB_LABEL[p.lib] : '全部', count: list.length, q: rawQ || null }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- Top 标签 ----------
// round168：修掉 getTopTags 内部写死 LIMIT 30 导致 ?limit=60 永远只有 30 的问题
function topHandler(req, res) {
    try {
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 30));
        res.json({ code: 0, data: getTopTagsByLib(p.lib, limit) });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
}
router.get('/top', topHandler);
router.get('/top/list', topHandler); // 旧路径兼容

// ---------- 思维空间：节点 + 联想边 ----------
router.get('/space', (req, res) => {
    try {
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        const lib = p.lib;
        const limit = Math.min(400, Math.max(10, parseInt(req.query.limit, 10) || 120));
        const minCo = Math.max(1, parseInt(req.query.minCo, 10) || 2);

        const tags = getTagsByLib(lib, {});
        const byId = new Map(tags.map(t => [t.id, t]));
        const nodeIds = new Set(tags.slice(0, limit).map(t => t.id));

        // 结构边（共现）：两端都必须落在节点集内
        const co = getTagCooccurrence(lib, minCo).filter(e => nodeIds.has(e.a) && nodeIds.has(e.b));
        // 语义边（名称/别名相似）交给 tag-space，路由里不堆算法
        const tagSpace = require('../utils/tag-space');
        const nameEdges = tagSpace.nameEdges(tags.filter(t => nodeIds.has(t.id)));

        const edges = [];
        const index = new Map();
        const push = (a, b, w, kind) => {
            const k = a < b ? `${a}-${b}` : `${b}-${a}`;
            if (index.has(k)) {
                const cur = edges[index.get(k)];
                cur.w = Math.min(1, +(cur.w + w * 0.5).toFixed(3));
                cur.kind = 'both';
                return;
            }
            index.set(k, edges.length);
            edges.push({ a, b, w: +w.toFixed(3), kind });
        };
        for (const e of co) {
            const ca = byId.get(e.a).movieCount, cb = byId.get(e.b).movieCount;
            const jac = e.co / (ca + cb - e.co); // Jaccard
            push(e.a, e.b, Math.min(1, 0.35 + jac * 0.65), 'co');
        }
        for (const e of nameEdges) push(e.a, e.b, e.w, 'name');

        /* ★ 边剪枝（round168 实测）：821 条边画在 60 个节点上就是一坨糊，
         *   任何节点都看不出跟谁更近。按「每个节点只保留最强的 4 条边」取并集，
         *   相当于一张 kNN 图：结构关系保留，视觉密度下降一个量级。 */
        const TOPK = Math.min(8, Math.max(2, parseInt(req.query.topk, 10) || 4));
        const perNode = new Map();
        for (const e of edges) {
            if (!perNode.has(e.a)) perNode.set(e.a, []);
            if (!perNode.has(e.b)) perNode.set(e.b, []);
            perNode.get(e.a).push(e);
            perNode.get(e.b).push(e);
        }
        const keep = new Set();
        for (const [nid, list] of perNode) {
            list.sort((x, y) => y.w - x.w);
            for (const e of list.slice(0, TOPK)) keep.add(e);
        }
        // 强名称关系（真重复）无条件保留，避免被 kNN 挤掉
        for (const e of edges) if (e.kind === 'name' && e.w >= 0.9) keep.add(e);
        const pruned = edges.filter(e => keep.has(e));

        res.json({
            code: 0,
            data: {
                lib,
                nodes: tags.slice(0, limit).map(t => ({ id: t.id, name: t.name, n: t.movieCount, cat: t.category })),
                edges: pruned,
                stats: {
                    tags: tags.length,
                    shown: Math.min(limit, tags.length),
                    edges: pruned.length,
                    rawEdges: edges.length,
                    topk: TOPK
                }
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 合并候选（自动联想出来的「疑似同一个标签」） ----------
router.get('/merge/candidates', (req, res) => {
    try {
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        const minScore = Math.min(1, Math.max(0.3, parseFloat(req.query.minScore) || 0.62));
        const tagSpace = require('../utils/tag-space');
        const tags = getTagsByLib(p.lib, {});
        const pairs = tagSpace.mergeCandidates(tags, minScore);
        res.json({ code: 0, data: pairs, meta: { lib: p.lib, count: pairs.length, minScore } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 执行合并（幂等 / 单事务 / 默认 dryRun） ----------
router.post('/merge', (req, res) => {
    try {
        const body = req.body || {};
        const intoId = parseInt(body.intoId, 10);
        const fromIds = Array.isArray(body.fromIds)
            ? body.fromIds.map(v => parseInt(v, 10)).filter(n => Number.isInteger(n))
            : [];
        const dryRun = isDryRun(body.dryRun, true); // 默认预演，必须显式 dryRun:false 才真跑

        if (!Number.isInteger(intoId)) return res.json({ code: -1, msg: 'intoId 无效' });
        const target = getTagById.get(intoId);
        if (!target) return res.json({ code: -1, msg: '目标标签不存在' });
        const sources = fromIds.filter(id => id !== intoId).map(id => getTagById.get(id)).filter(Boolean);
        if (!sources.length) return res.json({ code: -1, msg: '没有可合并的来源标签' });

        const plan = sources.map(s => {
            const rels = db.prepare(`SELECT movieId FROM movie_tag WHERE tagId = ?`).all(s.id);
            const hasOnInto = db.prepare(`SELECT 1 FROM movie_tag WHERE movieId = ? AND tagId = ?`);
            let alreadyHad = 0;
            for (const r of rels) if (hasOnInto.get(r.movieId, intoId)) alreadyHad++;
            return { id: s.id, name: s.name, relations: rels.length, alreadyHad, toMove: rels.length - alreadyHad };
        });

        if (dryRun) {
            return res.json({
                code: 0,
                data: {
                    dryRun: true,
                    into: { id: target.id, name: target.name },
                    plan,
                    totalMove: plan.reduce((a, b) => a + b.toMove, 0)
                }
            });
        }

        const run = db.transaction(() => {
            const moved = [];
            for (const s of sources) {
                insertTagAlias.run(intoId, s.name); // 旧名进别名表（aliasName UNIQUE ⇒ 幂等）
                db.prepare(`INSERT OR IGNORE INTO movie_tag (movieId, tagId) SELECT movieId, ? FROM movie_tag WHERE tagId = ?`)
                    .run(intoId, s.id);
                const del = db.prepare(`DELETE FROM movie_tag WHERE tagId = ?`).run(s.id);
                db.prepare(`DELETE FROM tags WHERE id = ?`).run(s.id);
                moved.push({ id: s.id, name: s.name, relations: del.changes });
            }
            return moved;
        });
        const moved = run();
        res.json({
            code: 0,
            data: {
                dryRun: false,
                into: { id: target.id, name: target.name },
                moved,
                totalMoved: moved.reduce((a, b) => a + b.relations, 0)
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 清理幽灵标签（0 作品） ----------
// 默认 dryRun；?dryRun=0 才真删。只删 tags 行，不碰任何 movie_tag（本该就没有）
router.post('/prune-empty', (req, res) => {
    try {
        const dryRun = isDryRun((req.body || {}).dryRun ?? req.query.dryRun, true);
        const rows = db.prepare(`
            SELECT t.id, t.name FROM tags t
            WHERE NOT EXISTS (SELECT 1 FROM movie_tag mt WHERE mt.tagId = t.id)
            ORDER BY t.name
        `).all();
        if (dryRun) return res.json({ code: 0, data: { dryRun: true, count: rows.length, tags: rows } });
        const del = db.prepare(`DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM movie_tag mt WHERE mt.tagId = tags.id)`);
        const run = db.transaction(() => rows.map(r => ({ id: r.id, name: r.name, deleted: del.run(r.id).changes })));
        const done = run();
        res.json({ code: 0, data: { dryRun: false, count: done.filter(d => d.deleted).length, tags: done } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 语义类目：查询（推断结果，不写库也能用） ----------
router.get('/taxonomy', (req, res) => {
    try {
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        const taxonomy = require('../utils/tag-taxonomy');
        const tags = getTagsByLib(p.lib);
        const r = taxonomy.classifyAll(tags);
        // 已写库类目与推断结果不一致的条数：决定「把类目写入库」按钮是否还可点
        const storedCat = new Map(tags.map(t => [t.id, t.category || '']));
        const pending = r.items.reduce((n, it) => n + ((storedCat.get(it.id) || '') !== it.category ? 1 : 0), 0);
        res.json({
            code: 0,
            data: {
                lib: p.lib,
                taxonomy: r.taxonomy,
                counts: r.counts,
                coverage: r.coverage,
                pending,
                items: r.items.map(t => ({
                    id: t.id, name: t.name, n: t.movieCount,
                    category: t.category, categoryLabel: t.label, reason: t.reason
                }))
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 语义类目：写回 tags.category（默认 dryRun） ----------
router.post('/reclassify', (req, res) => {
    try {
        const taxonomy = require('../utils/tag-taxonomy');
        const dryRun = isDryRun((req.body || {}).dryRun ?? req.query.dryRun, true);
        const all = getAllTags.all();
        const plan = [];
        for (const t of all) {
            const c = taxonomy.classify(t.name);
            if ((t.category || '') !== c.category) {
                plan.push({ id: t.id, name: t.name, from: t.category || '(空)', to: c.category, label: c.label, reason: c.reason });
            }
        }
        if (dryRun) return res.json({ code: 0, data: { dryRun: true, count: plan.length, plan } });

        const upd = db.prepare(`UPDATE tags SET category = ? WHERE id = ?`);
        const run = db.transaction(() => plan.map(p => ({ ...p, changed: upd.run(p.to, p.id).changes })));
        const done = run();
        res.json({ code: 0, data: { dryRun: false, count: done.filter(d => d.changed).length, plan: done } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 标签重命名（旧名进别名表，冲突不自动合并） ----------
router.post('/:id/rename', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.json({ code: -1, msg: 'id 无效' });
        const tag = getTagById.get(id);
        if (!tag) return res.json({ code: -1, msg: '标签不存在' });

        const raw = String((req.body && req.body.name) || '').trim();
        const dryRun = isDryRun((req.body || {}).dryRun, false);
        if (!raw) return res.json({ code: -1, msg: '新名称不能为空' });
        if (raw.length > 32) return res.json({ code: -1, msg: '新名称不超过 32 个字符' });
        if (raw === tag.name) return res.json({ code: 0, data: { unchanged: true, name: tag.name } });

        const tagSpace = require('../utils/tag-space');
        const norm = tagSpace.normalizeTagName(raw);
        if (!norm) return res.json({ code: -1, msg: '新名称只包含标点/空白，无效' });

        // 冲突检查：同名标签（不自动合并，交回前端让用户决定）
        const conflict = getAllTags.all().find(t => t.id !== id && tagSpace.normalizeTagName(t.name) === norm);
        if (conflict) {
            return res.json({
                code: -1,
                msg: `「${raw}」与已有标签「${conflict.name}」等价，建议改用合并而不是重命名`,
                conflict: { id: conflict.id, name: conflict.name, movieCount: conflict.movieCount }
            });
        }
        // 别名冲突：别人已经占用了这个别名
        const aliasOwner = db.prepare(`SELECT tagId FROM tag_alias WHERE aliasName = ?`).get(raw);
        if (aliasOwner && aliasOwner.tagId !== id) {
            return res.json({
                code: -1,
                msg: `「${raw}」已是标签 #${aliasOwner.tagId} 的别名`,
                conflict: { id: aliasOwner.tagId, name: raw }
            });
        }

        if (dryRun) {
            return res.json({ code: 0, data: { dryRun: true, from: tag.name, to: raw, willAlias: tag.name } });
        }

        const run = db.transaction(() => {
            db.prepare(`UPDATE tags SET name = ? WHERE id = ?`).run(raw, id);
            /* 新名一旦成为正式标签名，它作为「本标签别名」就不再有意义 ⇒ 先删掉，
             * 否则「改名→改回」会留下一条自我别名（实测踩过）。 */
            db.prepare(`DELETE FROM tag_alias WHERE tagId = ? AND aliasName = ?`).run(id, raw);
            // 旧名进别名表：搜索「旧名」仍能命中（aliasName UNIQUE ⇒ OR IGNORE）
            insertTagAlias.run(id, tag.name);
        });
        run();
        res.json({ code: 0, data: { dryRun: false, id, from: tag.name, to: raw, alias: tag.name } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 别名管理（合并/改名后清理用） ----------
router.get('/:id/aliases', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.json({ code: -1, msg: 'id 无效' });
        res.json({ code: 0, data: getAliasesOfTag.all(id).map(a => a.aliasName) });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/:id/alias/remove', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const name = String((req.body && req.body.name) || '').trim();
        if (!Number.isInteger(id) || !name) return res.json({ code: -1, msg: '参数无效' });
        const r = db.prepare(`DELETE FROM tag_alias WHERE tagId = ? AND aliasName = ?`).run(id, name);
        res.json({ code: 0, data: { removed: r.changes, name } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});


// ---------- 从作品的 genres 派生标签（元数据补齐之后才有意义） ----------
// 默认 dryRun；写库时按类目引擎给 category，并跳过已存在的同名标签
router.post('/derive', (req, res) => {
    try {
        const body = req.body || {};
        const lib = String(body.lib || '');
        if (!lib || !TAG_LIB_TYPES[lib]) {
            return res.status(400).json({ code: -1, msg: `不支持的库：${lib}（可选 ${Object.keys(TAG_LIB_TYPES).join(' / ')}）` });
        }
        const dryRun = isDryRun(body.dryRun, true);
        const types = TAG_LIB_TYPES[lib];
        const ph = types.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT id, genres, producer, publisher FROM movies
            WHERE type IN (${ph}) AND genres IS NOT NULL AND TRIM(genres) <> ''
        `).all(...types);

        const taxonomy = require('../utils/tag-taxonomy');
        /* ★ 噪声词表：作者/出版社/连载状态在 Bangumi 标签里很常见，
         *   但它们已经存在 producer / publisher 字段里，再进标签库只是重复污染。
         *   逐条按「该作品的作者/出版社」过滤 + 一个状态词黑名单。 */
        const NOISE = new Set(['连载中', '連載中', '已完结', '已完結', '完結', '连载', '連載', '一般向', '全年齢', 'R18', '成人向']);
        /* ★ 全局黑名单：库内出现过的作者名 / 出版社名 / 作品名。
         *   Bangumi 社区标签会把作者（松本大洋）、杂志（週刊ビッグコミックスピリッツ）、
         *   甚至作品名本身（看见幽灵）当标签，这些进标签库纯属污染。 */
        const ownNames = new Set();
        for (const r of rows) {
            for (const v of [r.producer, r.publisher]) {
                const t = String(v || '').trim();
                if (!t) continue;
                if (t.length <= 24) ownNames.add(t);
                // ★ `远瞳（高俊夫）` 这类带括号的作者名，去掉括号部分也要进黑名单，
                //   否则 Bangumi 标签里的 `远瞳` 会漏网（实测漏了 4 个）
                const base = t.split(/[（(]/)[0].trim();
                if (base && base.length >= 2) ownNames.add(base);
            }
        }
        const titleSet = new Set(db.prepare(`SELECT title FROM movies WHERE type IN (${ph}) AND TRIM(title) <> ''`).all(...types).map(r => String(r.title).trim()));
        const before = getAllTags.all();
        const existing = new Set(before.map(t => t.name));
        const newNames = new Set();
        const plan = [];
        let pairs = 0;

        for (const r of rows) {
            const own = new Set([String(r.producer || '').trim(), String(r.publisher || '').trim()].filter(Boolean));
            const names = String(r.genres)
                .split(/[,，、\/|;；]+/)
                .map(s => s.trim())
                .filter(s => !NOISE.has(s) && !own.has(s))
                /* ★ 过滤噪声：Bangumi 社区标签里混着年份（2019）和纯数字，
                 *   当标签写进去只会污染标签库，没有任何检索价值。 */
                /* 噪声过滤四类：
                 *   ① 纯数字（000 / 2 / 7）与日期（2026-01）—— AV 里的 `69` 例外见下；
                 *   ② 杂志名（週刊/月刊/隔週…）；
                 *   ③ 库内出现过的作者/出版社名；
                 *   ④ 库内出现过的作品名（Bangumi 有人把作品名当标签打）。
                 * ★ 漫画/小说里不会出现 `69` 这种纯体位标签，所以这里的纯数字一律可排。 */
                .filter(s => s
                    && s.length <= 24
                    && !/^\d+$/.test(s)
                    && !/^\d{4}-\d{1,2}(-\d{1,2})?$/.test(s)
                    && !/^(週刊|月刊|隔週|双週刊|半月刊|季刊)/.test(s)
                    && !ownNames.has(s)
                    && !titleSet.has(s));
            if (!names.length) continue;
            for (const n of names) {
                if (!existing.has(n)) newNames.add(n);
                pairs++;
            }
            plan.push({ id: r.id, names });
        }

        if (dryRun) {
            const byCat = {};
            for (const n of newNames) {
                const c = taxonomy.classify(n).label;
                byCat[c] = (byCat[c] || 0) + 1;
            }
            return res.json({
                code: 0,
                data: {
                    dryRun: true, lib, works: rows.length, pairs,
                    newTags: newNames.size, newByCategory: byCat,
                    sample: plan.slice(0, 5)
                }
            });
        }

        const run = db.transaction(() => {
            let added = 0;
            for (const p of plan) {
                for (const name of p.names) {
                    const cat = taxonomy.classify(name).category;
                    /* ★★ 归不进任何类目的标签一律不收（round172）：
                     *   `other` 的语义就是「说不清是什么」——实测里面全是作者昵称
                     *   （大眼珠子）、作品旧名（这才是神族）、无关漫画家（野澤ゆき子）。
                     *   这类词做标签没有检索价值，只会让标签库变脏。 */
                    if (cat === 'other' || cat === 'region' && name.length > 8) continue;
                    upsertTag.run({ name, category: cat });
                    const t = getTagByName.get(name);
                    if (t) added += addMovieTag.run(p.id, t.id).changes;
                }
            }
            return added;
        });
        const added = run();
        const after = getAllTags.all().length;
        res.json({
            code: 0,
            data: { dryRun: false, lib, works: rows.length, pairs, relationsAdded: added, tagsBefore: before.length, tagsAfter: after, newTags: after - before.length }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ---------- 标签详情 ----------
router.get('/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.json({ code: -1, msg: 'id 无效' });
        const item = getTagById.get(id);
        if (!item) return res.json({ code: -1, msg: '不存在' });
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        res.json({
            code: 0,
            data: {
                ...item,
                countInLib: getTagCountInLib(id, p.lib),
                aliases: getAliasesOfTag.all(id).map(a => a.aliasName),
                lib: p.lib
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 轻量海报（悬停/详情墙）—— 只回 id + 一张路径，904KB → ~1KB
router.get('/:id/posters', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.json({ code: -1, msg: 'id 无效' });
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        const limit = Math.min(24, Math.max(1, parseInt(req.query.limit, 10) || 6));
        /* ★★ 同系列去重（round172）：漫画/小说的 6 张墙图经常是同一部作品的
         *   「_第01话 / _第02话 …」，看上去就是**同一张封面重复 6 次**，比空白更糟。
         *   多取 6 倍，按系列键去重后再凑满 limit。 */
        const raw = getTagPosters(id, p.lib, Math.min(60, limit * 6));
        const seen = new Set();
        const out = [];
        for (const it of raw) {
            const k = seriesKey(it.title);
            if (k && seen.has(k)) continue;
            if (k) seen.add(k);
            out.push({ id: it.id, poster: it.poster, kind: it.kind });
            if (out.length >= limit) break;
        }
        res.json({ code: 0, data: out });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 标签详情页聚合：年份分布 + 代表作品 + 相关标签
router.get('/:id/profile', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.json({ code: -1, msg: 'id 无效' });
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        const item = getTagById.get(id);
        if (!item) return res.json({ code: -1, msg: '不存在' });

        const years = getTagYearHistogram(id, p.lib);
        const top = getTagMovies(id, p.lib, 8, 0).map(m => ({
            id: m.id,
            title: m.title || m.cleanName || m.fileName,
            year: m.releaseDate,
            poster: m.localPosterPath || m.posterPath || '',
            score: m.score
        }));
        const tagSpace = require('../utils/tag-space');

        res.json({
            code: 0,
            data: {
                tag: { id: item.id, name: item.name, category: item.category },
                lib: p.lib,
                count: getTagCountInLib(id, p.lib),
                years,
                top,
                related: tagSpace.relatedTags(id, p.lib, 10),
                aliases: getAliasesOfTag.all(id).map(a => a.aliasName)
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 单个标签的影片列表
router.get('/:id/movies', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.json({ code: -1, msg: 'id 无效' });
        const p = parseLib(req);
        if (!p.ok) return badLib(res, p.msg);
        const limit = Math.min(5000, Math.max(0, parseInt(req.query.limit, 10) || 0));
        const movies = limit
            ? getTagMovies(id, p.lib, limit, 0)
            : (p.lib ? getTagMovies(id, p.lib) : getMoviesByTag.all(id));
        res.json({ code: 0, data: movies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 多标签组合筛选：{ tagIds, lib, mode: 'and'|'or' }
router.post('/filter/movies', (req, res) => {
    try {
        const { tagIds, lib, mode } = req.body || {};
        if (!Array.isArray(tagIds) || !tagIds.length) return res.json({ code: 0, data: [] });
        const ids = tagIds.map(v => parseInt(v, 10)).filter(Number.isInteger);
        if (!ids.length) return res.json({ code: 0, data: [] });
        const cleanLib = lib && Object.prototype.hasOwnProperty.call(TAG_LIB_TYPES, lib) ? lib : null;
        const m = mode === 'or' ? 'or' : 'and';
        const movies = cleanLib
            ? getTagsFilter(ids, cleanLib, m)
            : (m === 'and' ? getMoviesByTags(ids) : getTagsFilter(ids, null, 'or'));
        res.json({ code: 0, data: movies, meta: { lib: cleanLib, mode: m, count: movies.length } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;