// ================================================================
// utils/series-ingest.js —— round173h 追番自动归集
//   目录监控/扫描器把新文件入库后，自动把 movie 挂到对应 series 的 episode。
//   ——阶段4「内容闭环」的落地点：BT 下载 → 夸克转存 → 目录入库 → 自动挂分集，
//     用户在追番页点「继续看第 N 集」就能直接播刚下好的文件。
//
//   ★ 铁律：
//   1. 只挂不建：找不到明确匹配的 series/episode 就跳过，绝不自动建 series（避免垃圾）；
//   2. 集号必须有：解析不出集号不挂（防止把特典/OP 挂到第 1 集）；
//   3. 全程不影响入库主流程：所有异常在调用方被吞掉。
// ================================================================

const sdb = require('./series-db');

/** 归一化标题：去字幕组/画质/集数噪音，用于匹配 */
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')          // [字幕组] [1080p]
    .replace(/\([^)]*\)/g, ' ')           // (字幕组)
    .replace(/\{\{.*?\}\}/g, ' ')
    .replace(/\b(1080p|720p|2160p|4k|1080|720|hevc|x264|aac|bdrip|web-dl|webdl|bluray|dvdrip|chinese|简繁|繁体|简体|gb|big5)\b/gi, ' ')
    .replace(/\bS\d{1,2}\s*E?\d{0,3}\b/gi, ' ')  // S02E03
    .replace(/第\s*\d+\s*[話话集回卷巻]/g, ' ')
    .replace(/[第]?\s*\d{1,3}\s*[話话集回]\b/g, ' ')
    .replace(/[~〜\-–—_]+/g, ' ')
    .replace(/[·・:：,，.。!！?？''""]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从文件名解析集号；返回 {season, episode} 或 null */
function parseEpisode(fileName) {
  const s = String(fileName || '');
  let m;
  // S02E03 / S02EP03
  if ((m = /\bS(\d{1,2})\s*EP?(\d{1,4})\b/i.exec(s))) return { season: +m[1], episode: +m[2] };
  // E03 / EP03（无 S 前缀）
  if ((m = /\bEP?(\d{1,4})\b/i.exec(s.replace(/\bS\d{1,2}\b/gi, '')))) return { season: 1, episode: +m[1] };
  // 第03话 / 第 3 集
  if ((m = /第\s*(\d{1,4})\s*[話话集回]/.exec(s))) return { season: 1, episode: +m[1] };
  // [03] / 【03】 方括号里的纯数字
  if ((m = /[\[【]\s*(\d{1,4})\s*[\]】]/.exec(s))) return { season: 1, episode: +m[1] };
  // - 03 - / _03_ 分隔的集号
  if ((m = /[\s\-_]\s*(\d{1,3})\s*[\s\-_]/ .exec(s.replace(/\b(1080|720|2160|x264|10bit)\b/gi, ' ')))) {
    const n = +m[1];
    if (n > 0 && n < 1000) return { season: 1, episode: n };
  }
  return null;
}

/**
 * 把刚入库的 movie 挂到追番分集。
 * @param {object} movie - movies 表的一行（至少含 id, filePath, title, fileName）
 * @returns {object} {linked:boolean, seriesId, episodeId, episodeNo, reason}
 */
function linkMovieToSeries(movie) {
  const result = { linked: false, seriesId: 0, episodeId: 0, episodeNo: 0, reason: '' };
  if (!movie || !movie.id) { result.reason = '无 movie'; return result; }

  const fileName = movie.fileName || require('path').basename(movie.filePath || '');
  const ep = parseEpisode(fileName);
  if (!ep) { result.reason = '未解析出集号'; return result; }
  result.episodeNo = ep.episode;

  // 用归一化标题匹配 series（标题优先用 movie.title，其次文件名去掉集号）
  const candidates = [movie.title, fileName].filter(Boolean);
  const all = sdb.listSeries({ limit: 5000 });
  let matched = null;
  for (const c of candidates) {
    const key = normTitle(c);
    if (!key || key.length < 2) continue;
    for (const s of all) {
      const sk = normTitle(s.title);
      const ok = s.originalTitle && normTitle(s.originalTitle);
      if (sk && (key === sk || key.includes(sk) || sk.includes(key))) { matched = s; break; }
      if (ok && (key === ok || key.includes(ok) || ok.includes(key))) { matched = s; break; }
    }
    if (matched) break;
  }
  if (!matched) { result.reason = '未匹配到追番 series'; return result; }
  result.seriesId = matched.id;

  // 找对应季/集
  const eps = sdb.getEpisodes(matched.id, ep.season);
  const target = eps.find(e => Number(e.episodeNo) === ep.episode);
  if (!target) { result.reason = `第${ep.season}季无第${ep.episode}集`; return result; }

  const ok = sdb.linkEpisodeMovie(target.id, movie.id);
  result.linked = !!ok;
  result.episodeId = target.id;
  result.reason = ok ? 'ok' : '挂接失败';
  return result;
}

module.exports = { normTitle, parseEpisode, linkMovieToSeries };
