/**
 * 影视库（type='film'）刮削源 · round34
 * ============================================================
 * 主源：TMDB 官方 API（电影 + 电视剧）
 *   - 用户在设置页填入 API Key（v3 auth key，themoviedb.org 免费注册申请）
 *   - /search/multi 一次搜电影+剧集，/movie/{id} 或 /tv/{id} 取详情
 *   - language=zh-CN 拿中文标题/简介，中文类型名走本地映射表
 * 备用源：豆瓣（无官方 API，走 j/search_suggest 公开建议接口 + 可选 cookie，
 *   参考 MoviePilot/MDCx 等开源项目的豆瓣刮取思路，能力有限标记为尽力而为）
 *
 * 返回结构与 poster-fetcher 的 normalizeResult 对齐：
 *   { title, original_title, overview, release_date, poster_path(完整URL),
 *     origin_country[], genres[{name}], id, _extra{ source, score, director,
 *     producer, publisher, duration, ... } }
 */
const config = require('./config');
const { simScore, norm } = require('./crawler/title-match');

const TMDB_BASES = [
    'https://api.tmdb.org',           // 主域名：大陆网络实测可达（api.themoviedb.org 被 DNS 污染）
    'https://api.themoviedb.org',     // 官方主域名：海外/代理环境用
];
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const TIMEOUT = 12000;

/** TMDB genre id → 中文名（movie / tv 共用一张表，冲突的以 tv 为准补第二个名字） */
const GENRE_ZH = {
    28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录片',
    18: '剧情', 10751: '家庭', 14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐',
    9648: '悬疑', 10749: '爱情', 878: '科幻', 10770: '电视电影', 53: '惊悚',
    10752: '战争', 37: '西部', 10759: '动作冒险', 10762: '儿童', 10763: '新闻',
    10764: '真人秀', 10765: '科幻奇幻', 10766: '肥皂剧', 10767: '脱口秀',
    10768: '战争政治', 10769: '海外剧'
};

function tmdbKey() {
    return (config.sources?.tmdb?.apiKey) || config.tmdbApiKey || '';
}

/** TMDB 请求封装（双域名回退 + 超时与有限重试） */
async function tmdbGet(pathname, params = {}) {
    const key = tmdbKey();
    if (!key) throw new Error('未配置 TMDB API Key');
    const qs = new URLSearchParams();
    qs.set('api_key', key);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const tries = config.network?.retryCount || 2;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 600 * i));
        for (const base of TMDB_BASES) {
            try {
                const res = await fetch(base + '/3' + pathname + '?' + qs.toString(), {
                    headers: { 'Accept': 'application/json', 'User-Agent': 'CinemaVault/1.0' },
                    signal: AbortSignal.timeout(TIMEOUT),
                });
                if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
                return await res.json();
            } catch (e) {
                lastErr = e;
                console.log(`[TMDB] ${base} 请求失败: ${e.message}`);
                // 4xx（key 错误/参数错误）换域名也没用，直接抛
                if (e.message && /HTTP 4/.test(e.message)) throw e;
            }
        }
    }
    throw lastErr;
}

/**
 * 影视文件名清洗：去扩展名/字幕组/站点水印/画质标签/季集标记/年份噪音，
 * 保留主干标题。比 cleanMovieName 更激进（影视文件名噪音普遍更多）。
 */
function cleanFilmName(fileName) {
    let name = String(fileName || '').replace(/\.[^.]+$/, '');
    name = name.replace(/\[[^\]]*\]/g, ' ');           // [XX组] [1080P]
    name = name.replace(/【[^】]*】/g, ' ');
    // 站点/编码器噪音
    name = name.replace(/\b(1080p|2160p|720p|4k|x264|x265|h\.?26[45]|hevc|hdr10?|dv|bluray|blu-ray|web[-_ ]?dl|webrip|hdtv|remux|aac|flac|dts[-_ ]?hd|atmos|10bit|60fps|dual|mandarin|cantonese|chinese|chs|cht|gb|big5)\b/gi, ' ');
    // 季集标记（先记下是否剧集，再剔除）
    name = name.replace(/\bS\d{1,2}\s*[-.]?\s*E\d{1,3}\b/gi, ' ');
    name = name.replace(/\b(season|series)\s*\d{1,2}\b/gi, ' ');
    name = name.replace(/第\s*[一二三四五六七八九十\d]+\s*[季部]/g, ' ');
    name = name.replace(/第\s*[一二三四五六七八九十\d百]+\s*[话話集]/g, ' ');
    name = name.replace(/\b[EP]?\d{1,3}\b(?=[\s.-]|$)/gi, ' ');
    name = name.replace(/\((19|20)\d{2}\)/g, ' ');      // (2023) 年份
    name = name.replace(/(19|20)\d{2}/g, ' ');          // 裸年份
    name = name.replace(/[-_.]+/g, ' ');
    return name.replace(/\s+/g, ' ').trim();
}

/** 文件名是否像电视剧（决定搜索后优先挑 tv 还是 movie） */
function looksLikeTv(fileName) {
    return /\bS\d{1,2}\s*[-.]?\s*E\d{1,3}\b/i.test(fileName)
        || /\b(season|series)\s*\d{1,2}\b/i.test(fileName)
        || /第\s*[一二三四五六七八九十\d]+\s*[季部]/.test(fileName)
        || /\b[EP]\d{1,3}\b/i.test(String(fileName || '').replace(/\.[^.]+$/, ''));
}

/** TMDB 搜索结果条目 → 候选（带相关度用 title-match 打分） */
function toCandidate(r) {
    const isTv = (r.media_type || 'movie') === 'tv';
    return {
        tmdbType: isTv ? 'tv' : 'movie',
        id: r.id,
        title: (isTv ? r.name : r.title) || '',
        originalTitle: (isTv ? r.original_name : r.original_title) || '',
        overview: r.overview || '',
        releaseDate: (isTv ? r.first_air_date : r.release_date) || '',
        poster: r.poster_path ? (TMDB_IMG + r.poster_path) : '',
        popularity: r.popularity || 0,
        vote: r.vote_average || 0,
    };
}

/** 详情请求，补齐导演/制作方/类型/时长等 */
async function fetchDetail(tmdbType, id) {
    try {
        const d = await tmdbGet(`/${tmdbType}/${id}`, { language: 'zh-CN', append_to_response: 'credits' });
        const genres = (d.genres || []).map(g => ({ name: GENRE_ZH[g.id] || g.name || String(g.id) }));
        let director = '';
        if (tmdbType === 'movie') {
            director = (d.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name).join(' / ');
        } else {
            director = (d.created_by || []).map(c => c.name).join(' / ');
        }
        const companies = (d.production_companies || []).map(c => c.name).filter(Boolean);
        const runtime = tmdbType === 'movie'
            ? (d.runtime || 0)
            : ((d.episode_run_time || [])[0] || 0);
        return {
            genres,
            director,
            producer: companies[0] || '',
            publisher: companies.slice(0, 2).join(' / '),
            duration: runtime,
            country: (d.production_countries || []).map(c => c.iso_3166_1).filter(Boolean),
            vote: d.vote_average || 0,
        };
    } catch (e) {
        console.log(`[TMDB] 详情失败(id=${id}): ${e.message}`);
        return null;
    }
}

/** TMDB 主搜索：multi 搜电影+剧集，相关度闸门防配错封面 */
async function searchTmdbByName(keyword, preferTv) {
    const data = await tmdbGet('/search/multi', { query: keyword, language: 'zh-CN', page: 1, include_adult: 'false' });
    const cands = (data.results || [])
        .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
        .filter(r => r.poster_path)                 // 宁缺勿错：没海报的直接不要
        .map(toCandidate);
    if (!cands.length) {
        console.log('[TMDB] 未检索到结果');
        return null;
    }
    const qn = norm(keyword);
    // 相关度闸门（与动漫库同策略：相关度 < 0.5 拒绝，宁可失败不配错）
    let best = null, bestScore = 0;
    for (const c of cands) {
        const s = Math.max(simScore(c.title || '', qn), simScore(c.originalTitle || '', qn));
        if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best || bestScore < 0.5) {
        console.log(`[TMDB] 最高相关度 ${bestScore.toFixed(2)} < 0.5，拒绝（避免配错封面）`);
        return null;
    }
    // 同分候选里，剧集文件名优先 tv、否则优先 movie
    const tied = cands.filter(c => {
        const s = Math.max(simScore(c.title || '', qn), simScore(c.originalTitle || '', qn));
        return Math.abs(s - bestScore) < 0.05;
    });
    const prefer = tied.find(c => c.tmdbType === (preferTv ? 'tv' : 'movie')) || best;
    console.log(`[TMDB] 命中: ${prefer.title}（${prefer.tmdbType === 'tv' ? '剧集' : '电影'} ${prefer.releaseDate || '?'}）相关度 ${bestScore.toFixed(2)}`);
    return prefer;
}

/**
 * 豆瓣备用搜索（尽力而为）：
 * j/search_suggest 是网页搜索框同款公开接口，免 cookie 也有概率可用；
 * 用户在设置里填了 douban.cookie 时，请求会带上以提升成功率。
 * 返回候选列表 [{title, cover, detailUrl}]，拿不到就空数组。
 */
async function searchDoubanCandidates(keyword) {
    try {
        const cookie = config.sources?.douban?.cookie || '';
        const url = `https://www.douban.com/j/search_suggest?q=${encodeURIComponent(keyword)}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                ...(cookie ? { 'Cookie': cookie, 'Referer': 'https://www.douban.com/' } : {}),
            },
            signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return (data.cards || []).filter(c => c.title && c.url).map(c => ({
            title: c.title,
            cover: c.img_url || '',
            detailUrl: c.url,
        }));
    } catch (e) {
        console.log(`[豆瓣] 备用搜索失败: ${e.message}`);
        return [];
    }
}

/**
 * 影视库统一入口（poster-fetcher 的 type='film' 分流到这里）
 * @returns 归一化结果或 null
 */
async function searchFilmByName(cleanName, fileName) {
    const keyword = cleanFilmName(fileName) || cleanName;
    if (!keyword || keyword.length < 2) {
        console.log('[影视] 清洗后关键词为空，放弃');
        return null;
    }
    console.log(`[影视搜索] 文件名: ${fileName}`);
    console.log(`[影视搜索] 清洗后关键词: ${keyword}  (疑似${looksLikeTv(fileName) ? '剧集' : '电影'})`);

    // ===== 主源：TMDB =====
    if (tmdbKey()) {
        try {
            const cand = await searchTmdbByName(keyword, looksLikeTv(fileName));
            if (cand) {
                const detail = await fetchDetail(cand.tmdbType, cand.id);
                return {
                    title: cand.title || cand.originalTitle,
                    original_title: cand.originalTitle || cand.title,
                    overview: cand.overview,
                    release_date: cand.releaseDate,
                    poster_path: cand.poster,          // 完整 URL，downloadPoster 直下
                    origin_country: detail?.country || [],
                    genres: detail?.genres || [],
                    id: `tmdb-${cand.tmdbType}-${cand.id}`,
                    _extra: {
                        avid: null,
                        source: 'tmdb',
                        actress: [],
                        genres: (detail?.genres || []).map(g => g.name),
                        duration: detail?.duration || 0,
                        director: detail?.director || '',
                        producer: detail?.producer || '',
                        publisher: detail?.publisher || '',
                        serial: '',
                        score: detail?.vote || cand.vote || 0,
                        detailUrl: `https://www.themoviedb.org/${cand.tmdbType}/${cand.id}`,
                    },
                };
            }
        } catch (e) {
            console.log(`[TMDB] 搜索异常: ${e.message}`);
        }
    } else {
        console.log('[影视] 未配置 TMDB API Key（设置 → 数据源 填入后生效），尝试豆瓣备用');
    }

    // ===== 备用：豆瓣建议接口 =====
    if (config.sources?.douban?.enabled !== false) {
        const cands = await searchDoubanCandidates(keyword);
        if (cands.length) {
            const qn = norm(keyword);
            let best = null, bestScore = 0;
            for (const c of cands) {
                const s = simScore(c.title || '', qn);
                if (s > bestScore) { bestScore = s; best = c; }
            }
            if (best && bestScore >= 0.5 && best.cover) {
                console.log(`[豆瓣] 命中: ${best.title} 相关度 ${bestScore.toFixed(2)}`);
                return {
                    title: best.title,
                    original_title: best.title,
                    overview: '',
                    release_date: '',
                    poster_path: best.cover,
                    origin_country: ['CN'],
                    genres: [],
                    id: null,
                    _extra: {
                        avid: null, source: 'douban', actress: [], genres: [],
                        duration: 0, director: '', producer: '', publisher: '',
                        serial: '', score: 0, detailUrl: best.detailUrl,
                    },
                };
            }
            if (best) console.log(`[豆瓣] 最高相关度 ${bestScore.toFixed(2)} < 0.5，拒绝`);
        }
    }

    return null;
}

module.exports = { searchFilmByName, cleanFilmName, looksLikeTv };
