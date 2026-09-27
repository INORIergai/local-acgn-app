/**
 * utils/acg-calendar.js — 新番放送时间表（round36 P0-2）
 *
 * 主源：AniList airingSchedules（本机实测可达；放送时间精确到「集」）
 * 备源：Bangumi /calendar（bgm.tv 本机常超时，apiBase 支持镜像配置，失败静默降级）
 *
 * 输出统一形态：
 * { source, weekStart, days: [ { date:'09-27 周六', items:[{title, episode, airingAt(ms), cover, source}] } ] }
 * 服务端缓存 6h（AniList 限流敏感，round34 有前科）。
 */
const config = require('./config');

const ANILIST = 'https://graphql.anilist.co';
const CACHE = { at: 0, data: null };
const TTL = 6 * 60 * 60 * 1000;

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n) { return n < 10 ? '0' + n : '' + n; }

async function fetchAniListWeek() {
    // 取「今天 0 点往前 12 小时 ~ 7 天后 18 点」的放送表，覆盖跨午夜播出
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 18, 0, 0);
    const query = `
    query ($from:Int,$to:Int){
      Page(page:1,perPage:80){
        airingSchedules(airingAt_greater:$from, airingAt_lesser:$to, sort:TIME){
          episode airingAt
          media{ id coverImage{large} title{ native romaji userPreferred } format isAdult }
        }
      }
    }`;
    const r = await fetch(ANILIST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { from: Math.floor(start.getTime() / 1000), to: Math.floor(end.getTime() / 1000) } }),
        signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`AniList HTTP ${r.status}`);
    const body = await r.json();
    const rows = body?.data?.Page?.airingSchedules || [];
    // 组装 8 天（昨天中午起的语义上仍是「今天~未来7天」为主），按自然日分组
    const byDay = new Map();
    for (const s of rows) {
        const media = s.media || {};
        if (media.isAdult) continue; // 时间表只放全龄段（里番库有自己的入口）
        const d = new Date(s.airingAt * 1000);
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (!byDay.has(key)) byDay.set(key, []);
        const title = media.title?.userPreferred || media.title?.native || media.title?.romaji || '(未命名)';
        byDay.get(key).push({
            title,
            episode: s.episode,
            airingAt: s.airingAt * 1000,
            cover: media.coverImage?.large || '',
            source: 'anilist',
            anilistId: media.id,
        });
    }
    // 输出今天起的 7 天
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const items = (byDay.get(key) || []).sort((a, b) => a.airingAt - b.airingAt);
        days.push({
            date: key,
            label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEK_CN[d.getDay()]}${i === 0 ? ' · 今天' : ''}`,
            items,
        });
    }
    return { source: 'anilist', days };
}

/** Bangumi 备源（apiBase 可配镜像；失败静默返回 null） */
async function fetchBangumiWeek() {
    const apiBase = (config.sources?.bangumi?.apiBase || 'https://api.bgm.tv').replace(/\/$/, '');
    try {
        const r = await fetch(apiBase + '/calendar', {
            headers: { 'User-Agent': 'CinemaVault/1.0 (local app)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const week = await r.json();
        if (!Array.isArray(week) || !week.length) return null;
        // Bangumi calendar 是「周几」数组，映射到未来 7 天
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() + i);
            const wd = d.getDay() === 0 ? 6 : d.getDay() - 1; // bangumi 周一=0
            const day = week[wd] || { items: [] };
            days.push({
                date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
                label: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEK_CN[d.getDay()]}${i === 0 ? ' · 今天' : ''}`,
                items: (day.items || []).slice(0, 30).map((s) => ({
                    title: s.name_cn || s.name,
                    episode: null,
                    airingAt: null,
                    cover: (s.images && (s.images.large || s.images.common)) || '',
                    source: 'bangumi',
                    bangumiId: s.id,
                })),
            });
        }
        return { source: 'bangumi', days };
    } catch (e) {
        return null;
    }
}

async function getCalendar(force = false) {
    if (!force && CACHE.data && Date.now() - CACHE.at < TTL) return CACHE.data;
    let data = null;
    try {
        data = await fetchAniListWeek();
    } catch (e) {
        data = null;
    }
    if (!data) data = await fetchBangumiWeek(); // 备源
    if (!data) throw new Error('放送时间表两个数据源均不可达（AniList / Bangumi）');
    CACHE.at = Date.now();
    CACHE.data = data;
    return data;
}

module.exports = { getCalendar };
