// ================================================================
// utils/series-notify.js —— round173c 追番更新站内提醒
//   拉新番放送表 → 与追番清单(follows)匹配 → 有新集则发通知。
//
//   匹配：优先 providerId 相等；否则归一化标题相等（导入用 cycanime，
//   回填后可能变 anilist，标题最稳）。
//   去重：通知 url = cv://series/{sid}/ep/{n} → addNotification 的
//   urlKey 唯一索引 (type,urlKey,actress) 保证同番同集只落一条。
//   偏好：走 notify('animeUpdate')，用户可在设置里关。
// ================================================================

const sdb = require('./series-db');
// ★ utils/notify 导出的是模块对象 { notify, ... }，必须解构（同 db 模块对象坑）
const { notify } = require('./notify');

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').trim();

/**
 * 扫描放送表，给我追的番里有新集的发提醒。
 * @param {object} [opts] { force: 是否强制刷新放送表 }
 * @returns {Promise<{scanned:number, matched:number, notified:number, details:Array}>}
 */
async function checkAiringUpdates(opts = {}) {
  const cal = await require('./acg-calendar').getCalendar(!!opts.force);
  const board = sdb.getFollowBoard('watching'); // 只提醒"追番中"的
  const result = { scanned: 0, matched: 0, notified: 0, details: [] };
  console.log(`[追番提醒] 放送表 days=${cal && cal.days ? cal.days.length : 'NULL'} source=${cal && cal.source} 追番中=${board.length}`);

  if (!board.length) return result;

  // 建索引：providerId → seriesId，norm(title) → seriesId
  const byProviderId = new Map();
  const byTitle = new Map();
  const seriesById = new Map();
  for (const b of board) {
    seriesById.set(b.id, b);
    if (b.providerId) byProviderId.set(`${b.provider}|${b.providerId}`, b.id);
    byTitle.set(norm(b.title), b.id);
    byTitle.set(norm(b.originalTitle), b.id);
  }

  const seenPairs = new Set(); // 同一 (seriesId, 去重键) 本次扫描只处理一次
  for (const day of (cal && cal.days) || []) {
    const isToday = !!(day.label && String(day.label).indexOf('今天') >= 0);
    for (const item of (day.items || [])) {
      result.scanned++;
      const ep = Number(item.episode);
      const hasEp = ep >= 1;

      let sid = item.anilistId != null ? byProviderId.get(`anilist|${item.anilistId}`)
              : item.bangumiId != null ? byProviderId.get(`bangumi|${item.bangumiId}`)
              : null;
      if (!sid && item.providerId) sid = byProviderId.get(`${item.provider}|${item.providerId}`);
      if (!sid) sid = byTitle.get(norm(item.title));
      if (!sid) continue;

      const s = seriesById.get(sid);
      const watched = Number(s && s.watchedCount || 0);

      // ★ 双模式（round173c 实测修正）：主源 cycanime 的 episode 恒为 null，
      //   若只认集数，93 部番全部漏报。无集数时按「今日有放送」提醒，用 date 去重。
      let dedupKey, title, content, url, extra;
      if (hasEp) {
        if (ep <= watched) continue; // 已看完的集不打扰
        dedupKey = `ep${ep}`;
        title = `《${s.title}》更新到第 ${ep} 集`;
        content = (item.title && item.title !== s.title ? `放送表：${item.title}　` : '') + (day.label ? day.label + ' 播出' : '已播出');
        url = `cv://series/${sid}/ep/${ep}`;
        extra = { kind: 'anime', seriesId: sid, episode: ep };
      } else {
        // 无集数信息：只在「今天」的放送条目提醒一次（避免未来 6 天条目全发）
        if (!isToday) continue;
        dedupKey = `air${day.date || ''}`;
        title = `《${s.title}》今日有放送`;
        content = '本周放送表显示今天有播出，去追番页看看';
        url = `cv://series/${sid}/air/${day.date || ''}`;
        extra = { kind: 'anime', seriesId: sid, airDate: day.date || '' };
      }

      const pairKey = `${sid}|${dedupKey}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      result.matched++;

      const ok = notify('animeUpdate', title, content, {
        url, cover: item.cover || s.posterPath || '', level: 'info', extra
      });
      if (ok) {
        result.notified++;
        result.details.push({ seriesId: sid, title: s.title, episode: hasEp ? ep : null, mode: hasEp ? 'episode' : 'airing' });
      }
    }
  }
  return result;
}

module.exports = { checkAiringUpdates };
