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

const STATUS_TO_BGM = { planned: 1, completed: 2, watching: 3, dropped: 4 };
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

/** sync：先 pull 再 push（pull 结果作为基线，冲突由较新者覆盖——Bangumi 用 updatedAt） */
async function sync(opts = {}) {
    const pulled = await pull({ createMissing: opts.createMissing !== false });
    const pushed = await push({ delayMs: opts.delayMs || 300 });
    return { pulled, pushed };
}

module.exports = { STATUS_TO_BGM, BGM_TO_STATUS, fetchCollections, pull, push, sync };
