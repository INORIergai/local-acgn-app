/**
 * 动漫库（type='cartoon'，普通向）刮削源 · round34
 * ============================================================
 * 主源：Bangumi (bgm.tv) 官方 HTTP API v0
 *   - 免 key 可用（限流友好），条目类型 2 = 动画
 *   - 中文条目名（name_cn）对中文用户标题契合度高
 *   - 政策要求带可识别 User-Agent，这里按规范声明
 * 备源：AniList（isAdult:false，普通向过滤，由 poster-fetcher 的分流顺序控制）
 *
 * 返回结构与 poster-fetcher 的 normalizeResult 对齐（同 film-scraper）。
 */
const config = require('./config');
const { simScore, norm } = require('./crawler/title-match');

// API 域名可配置：bgm.tv 在部分大陆网络不可达，用户可填镜像/反代地址
const API = (config.sources?.bangumi?.apiBase || 'https://api.bgm.tv') + '/v0';
const UA = 'CinemaVault/1.0 (local media library; https://github.com/) ';
const TIMEOUT = 12000;

async function bgmRequest(pathname, options = {}) {
    const tries = config.network?.retryCount || 2;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 600 * i));
        try {
            const res = await fetch(API + pathname, {
                method: options.method || 'GET',
                headers: {
                    'User-Agent': UA,
                    'Accept': 'application/json',
                    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                    // 用户在设置里填了 access token 时带上（私有条目/更高限额）
                    ...(config.sources?.bangumi?.accessToken
                        ? { 'Authorization': 'Bearer ' + config.sources.bangumi.accessToken } : {}),
                },
                ...(options.body ? { body: JSON.stringify(options.body) } : {}),
                signal: AbortSignal.timeout(TIMEOUT),
            });
            if (!res.ok) throw new Error(`Bangumi HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            lastErr = e;
            console.log(`[Bangumi] 请求失败 第${i + 1}/${tries}次: ${e.message}`);
        }
    }
    throw lastErr;
}

/** 文件名清洗：去字幕组/画质/集数噪音。
 * 兜底：像 `[组名][标题][01][1080p]` 这种「内容全在括号里」的文件名，
 * 全剥括号会剩空串 —— 此时保留括号内容（只剥画质/集数标记）再当关键词。 */
function cleanCartoonName(fileName) {
    const raw = String(fileName || '').replace(/\.[^.]+$/, '');
    let name = raw
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/【[^】]*】/g, ' ')
        .replace(/\b(1080p|2160p|720p|4k|hevc|x264|x265|60fps|120fps|hdr)\b/gi, ' ')
        .replace(/[\s　]*(第\s*\d*\s*[話话集巻卷]|OVA|OAD|ONA|END|完)\b.*$/i, ' ')
        .replace(/[-_.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (name.length >= 2) return name;
    // 括号保留兜底：`[组名][标题][01]` 这种内容全在括号里的文件名。
    // 有 ≥2 个括号组时，第一个组通常是字幕组名，会污染全文检索 → 去掉它。
    const groups = raw.match(/\[[^\]]*\]/g) || [];
    let keep = raw;
    if (groups.length >= 2) keep = keep.replace(groups[0], ' ');
    keep = keep
        .replace(/\[[^\]]*\b(1080p|2160p|720p|4k|hevc|x264|x265|jp?sc|jp|gb|big5|cht|chs)\b[^\]]*\]/gi, ' ')
        .replace(/\[\s*\d{1,4}\s*\]/g, ' ')
        .replace(/\((?:19|20)\d{2}\)/g, ' ')
        .replace(/[\[\]【】]/g, ' ')          // 剩余括号字符本身也会污染全文检索
        .replace(/[-_.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return keep;
}

/**
 * 动漫库统一入口（poster-fetcher 的 type='cartoon' 分流到这里）
 * @returns 归一化结果或 null
 */
async function searchCartoonByName(cleanName, fileName) {
    const keyword = cleanCartoonName(fileName) || cleanName;
    if (!keyword || keyword.length < 2) {
        console.log('[动漫] 清洗后关键词为空，放弃');
        return null;
    }
    console.log(`[Bangumi搜索] 文件名: ${fileName}`);
    console.log(`[Bangumi搜索] 清洗后关键词: ${keyword}`);

    try {
        // v0 搜索：POST /search/subjects，filter.type 2 = 动画
        const data = await bgmRequest('/search/subjects', {
            method: 'POST',
            body: {
                keyword,
                filter: { type: [2] },
                limit: 10,
            },
        });
        const list = data.data || [];
        if (!list.length) {
            console.log('[Bangumi] 未检索到结果');
            return null;
        }

        const qn = norm(keyword);
        let best = null, bestScore = 0;
        for (const s of list) {
            if (!s.images || !(s.images.common || s.images.large || s.images.medium)) continue; // 宁缺勿错
            const titleCn = s.name_cn || '';
            const titleJp = s.name || '';
            const score = Math.max(simScore(titleCn, qn), simScore(titleJp, qn));
            if (score > bestScore) { bestScore = score; best = s; }
        }
        if (!best || bestScore < 0.5) {
            console.log(`[Bangumi] 最高相关度 ${bestScore.toFixed(2)} < 0.5，拒绝（避免配错封面）`);
            return null;
        }
        console.log(`[Bangumi] 命中: ${best.name_cn || best.name}（${best.date || '?'}）相关度 ${bestScore.toFixed(2)}`);

        // 详情补全（tags/infobox 里有制作公司与评分）
        let detail = best;
        try {
            detail = await bgmRequest(`/subjects/${best.id}`);
        } catch (e) { /* 搜索结果本身字段够用，详情失败不致命 */ }

        const tags = (detail.tags || [])
            .slice(0, 10)
            .map(t => ({ name: t.name }));
        const info = {};
        for (const item of (detail.infobox || [])) {
            if (item && item.key) info[item.key] = Array.isArray(item.value)
                ? item.value.map(v => v.v || '').filter(Boolean).join(' / ')
                : String(item.value || '');
        }
        const cover = detail.images?.large || detail.images?.common || detail.images?.medium
            || best.images?.large || best.images?.common || best.images?.medium || '';

        return {
            title: detail.name_cn || best.name_cn || detail.name || best.name,
            original_title: detail.name || best.name || '',
            overview: String(detail.summary || '').replace(/<[^>]+>/g, '').trim(),
            release_date: detail.date || best.date || '',
            poster_path: cover,
            origin_country: ['JP'],
            genres: tags,
            id: best.id ? `bgm-${best.id}` : null,
            _extra: {
                avid: null,
                source: 'bangumi',
                actress: [],
                genres: tags.map(t => t.name),
                duration: detail.eps ? 0 : 0,
                director: info['导演'] || '',
                producer: info['动画制作'] || info['制作'] || '',
                publisher: '',
                serial: '',
                score: detail.rating?.score || 0,
                detailUrl: `https://bgm.tv/subject/${best.id}`,
            },
        };
    } catch (e) {
        console.log(`[Bangumi] 搜索异常: ${e.message}`);
        return null;
    }
}

module.exports = { searchCartoonByName, cleanCartoonName };
