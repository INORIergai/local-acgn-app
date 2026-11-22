/**
 * 在线 Browse（最新/热门聚合）——用于影视库/动漫库首页"在线优先"卡片区
 * ------------------------------------------------------------------
 * 并发拉多个有目录能力的视频源，按 tier 排序、按作品名去重，
 * 单源失败隔离；短缓存避免首页反复打站。只返回元数据，不做任何写操作。
 */
'use strict';

const engine = require('./engine');

const TTL = 5 * 60 * 1000;
const cache = new Map();

/** 拉合并的最新列表。kind: 'film' | 'anime'（当前视频源以 anime 为主，film 复用同源） */
async function browseLatest(kind, opts = {}) {
    const key = String(kind || 'anime') + '|' + (opts.limit || 30);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.data;

    const sources = engine.loadSources().filter((s) => s.kind === 'web').slice(0, 8); // 只取前 8 个高 tier 源，控制耗时
    const groups = await Promise.all(sources.map(async (s) => {
        try {
            const r = await engine.catalogOf(s, { page: 1, limit: 12 });
            return { sourceId: s.id, sourceName: s.name, tier: s.tier,
                ok: !r.error, error: r.error || '', items: r.items || [] };
        } catch (e) {
            return { sourceId: s.id, sourceName: s.name, tier: s.tier, ok: false, error: e.message, items: [] };
        }
    }));
    const seen = new Set();
    const items = [];
    for (const g of groups.slice().sort((a, b) => (a.tier || 9) - (b.tier || 9))) {
        for (const it of g.items) {
            const k = String(it.name || '').trim().toLowerCase();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            items.push({ name: it.name, url: it.url, cover: it.cover || '',
                sourceId: g.sourceId, sourceName: g.sourceName, tier: g.tier });
        }
    }
    const data = { items: items.slice(0, opts.limit || 30),
        groups: groups.map((g) => ({ sourceId: g.sourceId, sourceName: g.sourceName, ok: g.ok, count: g.items.length })) };
    cache.set(key, { at: Date.now(), data });
    return data;
}

module.exports = { browseLatest };
