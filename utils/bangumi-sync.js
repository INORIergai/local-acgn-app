// ================================================================
// utils/bangumi-sync.js —— round173e Bangumi 收藏/进度云同步
//   状态映射（Bangumi collection type）：
//     wish=1 想看 / collect=2 看完 / do=3 在看 / dropped=4 弃
//   同步方向：
//     pull: Bangumi 收藏 → 本地 follows + episode_progress
//     push: 本地 follows + episode_progress → Bangumi 收藏
//     sync: 双向，冲突按「较新者优先」（可配 manual 策略）
//   匹配：series.provider='bangumi' && providerId=subjectId 优先；
//         否则按归一化标题匹配 Bangumi 收藏条目的 name/name_cn。
// ================================================================

const { api, dualFetchJson, API_BASE } = require('./bangumi-oauth');
const sdb = require('./series-db');

// round185 B1：onhold（搁置）Bangumi 没有对应类型，映射到「想看」——语义上最接近
// 「我知道这部，只是暂时不看了」；拉回来时会变成 planned，这是单向信息损失，可接受。
const STATUS_TO_BGM = { planned: 1, onhold: 1, completed: 2, watching: 3, dropped: 4 };
const BGM_TO_STATUS = { 1: 'planned', 2: 'completed', 3: 'watching', 4: 'dropped' };
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').trim();

/** 拉 Bangumi 全部动画收藏（type=2），分页 */
async function fetchCollections() {
    const out = [];
    let offset = 0;
    const limit = 100;
    for (let page = 0; page < 20; page++) {
        const rows = await api(`/v0/users/-/collections?subject_type=2&limit=${limit}&offset=${offset}`);
        if (!Array.isArray(rows) || !rows.length) break;
        out.push(...rows);
        if (rows.length < limit) break;
        offset += limit;
    }
    return out;
}

/** 由 Bangumi subjectId 找本地 series；找不到则按标题匹配 */
function findSeries(subjectId, titleZh, titleJp) {
    let s = sdb.getSeriesByProvider('bangumi', String(subjectId));
    if (s) return s;
    // 标题匹配（遍历本地 series，找归一化标题相同者）
    const all = sdb.listSeries({ limit: 5000 });
    const keys = new Set([norm(titleZh), norm(titleJp)].filter(Boolean));
    for (const x of all) {
        if (keys.has(norm(x.title)) || keys.has(norm(x.originalTitle))) return x;
    }
    return null;
}

/** pull：Bangumi → 本地。返回 {pulled, created, updated, skipped, details} */
async function pull(opts = {}) {
    const cols = await fetchCollections();
    const result = { pulled: 0, created: 0, updated: 0, skipped: 0, details: [] };
    for (const c of cols) {
        const sub = c.subject || {};
        const subjectId = sub.id != null ? sub.id : c.subject_id;
        if (!subjectId) { result.skipped++; continue; }
        const typeNum = Number(c.type || 0);
        const status = BGM_TO_STATUS[typeNum];
        if (!status) { result.skipped++; continue; }
        const epStatus = Number(c.ep_status || 0);

        let s = findSeries(subjectId, sub.name_cn, sub.name);
        if (!s) {
            if (!opts.createMissing) { result.skipped++; continue; }
            // 新建本地 series 并绑定 bangumi subjectId（避免下次再按标题猜）
            s = sdb.upsertSeries({
                title: sub.name_cn || sub.name || `Bangumi-${subjectId}`,
                originalTitle: sub.name || '',
                provider: 'bangumi', providerId: String(subjectId),
                type: 'cartoon',
                posterPath: (sub.images && (sub.images.large || sub.images.common)) || '',
                status: status === 'completed' ? 'finished' : 'ongoing',
                episodeCount: Number(sub.eps || 0),
            });
            result.created++;
        } else {
            // 绑定 bangumi id（若原是 custom/cycanime），方便后续精确同步
            if (s.provider !== 'bangumi') {
                try {
                    require('./db').db.prepare(`UPDATE series SET provider='bangumi', providerId=?, updatedAt=? WHERE id=?`)
                        .run(String(subjectId), Date.now(), s.id);
                    s.provider = 'bangumi'; s.providerId = String(subjectId);
                } catch (e) { /* 绑定失败不致命 */ }
            }
        }

        // 更新追番状态
        const before = sdb.getFollowStatus(s.id);
        sdb.setFollow(s.id, status, s.favorite != null ? s.favorite : -1);
        // 更新进度：Bangumi ep_status=N 表示看完前 N 集
        if (epStatus > 0 && s.provider === 'bangumi') {
            const eps = sdb.getEpisodes(s.id, 1);
            const byNo = new Map(eps.map(e => [Number(e.episodeNo), e]));
            for (let n = 1; n <= epStatus; n++) {
                const e = byNo.get(n);
                if (e) sdb.setEpisodeProgress(e.id, { position: 0, duration: 0, watched: 1 });
            }
        }
        result.pulled++;
        if (before !== status) result.updated++;
        result.details.push({ seriesId: s.id, title: s.title, status, epStatus });
    }
    return result;
}

/** push：本地 watching/planned/completed → Bangumi。返回 {pushed, skipped, details, errors} */
async function push(opts = {}) {
    const board = sdb.getFollowBoard(); // 全部追番状态
    const result = { pushed: 0, skipped: 0, details: [], errors: [] };
    for (const b of board) {
        // 只推能定位到 bangumi subject 的番（provider=bangumi 或标题在主播列表里匹配过）
        let subjectId = (b.provider === 'bangumi') ? b.providerId : null;
        if (!subjectId) {
            // 尝试按标题搜 Bangumi subject
            try {
                const found = await dualFetchJson(
                    `${API_BASE}/v0/search/subjects?keyword=${encodeURIComponent(b.title)}&filter.type=2&limit=5`
                );
                const hit = (found && found.data || []).find(x => norm(x.name_cn || x.name) === norm(b.title))
                    || (found && found.data || [])[0];
                if (hit && hit.id) {
                    subjectId = String(hit.id);
                    require('./db').db.prepare(`UPDATE series SET provider='bangumi', providerId=? WHERE id=?`).run(subjectId, b.id);
                }
            } catch (e) { /* 搜不到就跳过 */ }
        }
        if (!subjectId) { result.skipped++; continue; }

        const typeNum = STATUS_TO_BGM[b.followStatus] || 3;
        const epStatus = Number(b.watchedCount || 0);
        try {
            await api(`/v0/users/-/collections/${subjectId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: typeNum, ep_status: epStatus }),
            });
            result.pushed++;
            result.details.push({ seriesId: b.id, subjectId, status: b.followStatus, epStatus });
        } catch (e) {
            result.errors.push({ seriesId: b.id, subjectId, error: e.message });
        }
        if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    }
    return result;
}

/**
 * sync：按冲突策略双向同步。
 *   strategy='newer'(默认) —— 先 pull 建基线再 push（较新者覆盖，等价原行为）
 *   strategy='local'       —— 本地优先：只 push，不 pull（本地是权威）
 *   strategy='remote'      —— Bangumi 优先：只 pull，不 push（云端是权威）
 * ★ 要逐条选择请用 diff() + applyConflicts()。
 */
async function sync(opts = {}) {
    const strategy = ['newer', 'local', 'remote'].includes(opts.strategy) ? opts.strategy : 'newer';
    let pulled = { pulled: 0, created: 0, updated: 0, skipped: 0, details: [] };
    let pushed = { pushed: 0, skipped: 0, details: [], errors: [] };
    if (strategy !== 'local') pulled = await pull({ createMissing: opts.createMissing !== false });
    if (strategy !== 'remote') pushed = await push({ delayMs: opts.delayMs || 300 });
    return { pulled, pushed, strategy };
}

// ==================================================================
// round185 B2：冲突逐条选择
// ==================================================================
const STATUS_LABELS = { watching: '在看', planned: '想看', completed: '看过', dropped: '抛弃', onhold: '搁置' };

/** 单条推送（逐条冲突处理用） */
async function pushOne(seriesId, subjectId, status, epStatus) {
    const typeNum = STATUS_TO_BGM[status] || 3;
    await api(`/v0/users/-/collections/${subjectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: typeNum, ep_status: Number(epStatus) || 0 }),
    });
}

/** 单条拉取（逐条冲突处理用）：状态 + 看完前 N 集 */
function pullOneInto(seriesId, status, epStatus) {
    sdb.setFollow(seriesId, status, -1);
    const n = Number(epStatus) || 0;
    if (n <= 0) return;
    const eps = sdb.getEpisodes(seriesId, 1);
    const byNo = new Map(eps.map(e => [Number(e.episodeNo), e]));
    for (let i = 1; i <= n; i++) {
        const e = byNo.get(i);
        if (e) sdb.setEpisodeProgress(e.id, { position: 0, duration: 0, watched: 1 });
    }
}

/**
 * 算差异，**只读**，不改任何东西。
 * rows 三种：
 *   conflict   —— 两边都有但状态/进度不同（带 suggested: local|remote）
 *   remoteOnly —— Bangumi 有、本地没有（可选择导入）
 *   localOnly  —— 本地有、Bangumi 没有（可选择推送）
 */
async function diff() {
    return diffFrom(await fetchCollections());
}

/**
 * 纯比对逻辑（不联网），便于在没有 Bangumi token 时单测。
 * @param {Array} cols fetchCollections() 的返回结构
 */
function diffFrom(cols) {
    const board = sdb.getFollowBoard();
    // 一次性建索引，别在循环里反复扫 5000 条 series
    const all = sdb.listSeries({ limit: 5000 });
    const byProviderId = new Map();
    const byTitle = new Map();
    board.forEach((b) => { if (b.provider === 'bangumi' && b.providerId) byProviderId.set(String(b.providerId), b); });
    all.forEach((s) => {
        const k1 = norm(s.title), k2 = norm(s.originalTitle);
        if (k1) byTitle.set(k1, s);
        if (k2) byTitle.set(k2, s);
    });
    const boardById = new Map(board.map((b) => [b.id, b]));

    const remoteIds = new Set();
    const matchedLocalIds = new Set();   // 已与远端配对的本地 series，别再被算成「本地独有」
    const rows = [];
    for (const c of cols) {
        const sub = c.subject || {};
        const rawId = sub.id != null ? sub.id : c.subject_id;
        if (rawId == null) continue;
        const subjectId = String(rawId);
        remoteIds.add(subjectId);
        const status = BGM_TO_STATUS[Number(c.type || 0)];
        if (!status) continue;
        const epStatus = Number(c.ep_status || 0);
        const title = sub.name_cn || sub.name || `Bangumi-${subjectId}`;

        let local = byProviderId.get(subjectId);
        const localId = local ? local.id : null;
        if (!local) {
            const cand = byTitle.get(norm(sub.name_cn)) || byTitle.get(norm(sub.name));
            if (cand) local = boardById.get(cand.id) || cand;
        }
        if (!local) {
            rows.push({ kind: 'remoteOnly', subjectId, title,
                        remoteStatus: status, remoteStatusLabel: STATUS_LABELS[status] || status,
                        remoteEp: epStatus });
            continue;
        }

        const localStatus = local.followStatus || sdb.getFollowStatus(local.id);
        const localEp = Number(local.watchedCount || 0);
        matchedLocalIds.add(local.id);
        if (localStatus === status && localEp === epStatus) continue;   // 一致的不列，别让用户看一屏噪音

        const remoteAt = Date.parse(c.updated_at || c.updated || c.updatedAt || 0) || 0;
        const localAt = Number(local.followUpdatedAt || 0);
        rows.push({
            kind: 'conflict', seriesId: local.id, subjectId, title,
            remoteStatus: status, remoteStatusLabel: STATUS_LABELS[status] || status, remoteEp: epStatus, remoteAt,
            localStatus, localStatusLabel: STATUS_LABELS[localStatus] || localStatus, localEp, localAt,
            suggested: remoteAt > localAt ? 'remote' : 'local'
        });
    }

    board.forEach((b) => {
        if (matchedLocalIds.has(b.id)) return;                  // 已在上面配对过，不算「本地独有」
        if (b.provider === 'bangumi' && b.providerId && remoteIds.has(String(b.providerId))) return;
        rows.push({ kind: 'localOnly', seriesId: b.id, title: b.title,
                    localStatus: b.followStatus, localStatusLabel: STATUS_LABELS[b.followStatus] || b.followStatus,
                    localEp: Number(b.watchedCount || 0) });
    });

    const counts = { conflict: 0, remoteOnly: 0, localOnly: 0 };
    rows.forEach((r) => { counts[r.kind]++; });
    return { rows, counts, remoteCount: cols.length, localCount: board.length };
}

/**
 * 按用户逐条选择执行。items: [{kind, seriesId, subjectId, choice:'local'|'remote', localStatus, localEp, remoteStatus, remoteEp, title}]
 * choice 语义：local=保留本地（推到远端），remote=用云端（拉回本地）。
 */
async function applyConflicts(items) {
    const out = { applied: 0, failed: 0, details: [] };
    for (const it of (Array.isArray(items) ? items : [])) {
        const choice = it.choice === 'remote' ? 'remote' : 'local';
        try {
            if (choice === 'remote') {
                if (it.kind === 'remoteOnly') {
                    // 云端独有的条目：导入成本地 series（绑定 subjectId，下次不再靠标题猜）
                    const created = sdb.upsertSeries({
                        title: it.title, provider: 'bangumi', providerId: String(it.subjectId),
                        type: 'cartoon', status: it.remoteStatus === 'completed' ? 'finished' : 'ongoing'
                    });
                    if (created && created.id) {
                        pullOneInto(created.id, it.remoteStatus, it.remoteEp);
                    }
                } else {
                    pullOneInto(Number(it.seriesId), it.remoteStatus, it.remoteEp);
                }
            } else {
                if (!it.subjectId) throw new Error('该条没有绑定 Bangumi 条目，无法推送');
                await pushOne(Number(it.seriesId), String(it.subjectId), it.localStatus, it.localEp);
            }
            out.applied++;
            out.details.push({ title: it.title, choice, ok: true });
        } catch (e) {
            out.failed++;
            out.details.push({ title: it.title, choice, ok: false, error: e.message });
        }
        // Bangumi 对写操作限流，逐条之间留口气
        await new Promise((r) => setTimeout(r, 260));
    }
    return out;
}

module.exports = { STATUS_TO_BGM, BGM_TO_STATUS, fetchCollections, pull, push, sync, diff, diffFrom, applyConflicts };
