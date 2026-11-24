// ================================================================
// utils/subtitle-convert.js —— round173g 字幕转 VTT
//   浏览器 <track> 只认 WebVTT；本地常见 srt/ass 需转换。
//   ASS 的完整特效（drawing/位置/opacity）无法在原生 <track> 复现，
//   这里做「基础字幕」转换：保留时间轴 + 纯文本，丢弃样式/特效标签。
//   —— 要完整 ASS 特效得引 libass.js，属后续增强（见验收报告诚实说明）。
// ================================================================

const fs = require('fs');
const path = require('path');

function srtToVtt(text) {
  let s = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  s = s.replace(/\{\\[^}]*\}/g, ''); // 去 srt 内联样式
  // SRT 序号行可留（VTT 允许数字 cue id），时间轴逗号 → 点
  s = s.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + s + '\n';
}

/** ASS 时间轴 0:00:01.23 → VTT 00:00:01.230 */
function assTimeToVtt(t) {
  const parts = String(t).trim().split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const sec = parseFloat(parts[2] || '0') || 0;
  const total = h * 3600 + m * 60 + sec;
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = (total % 60).toFixed(3).padStart(6, '0');
  return `${hh}:${mm}:${ss}`;
}

function assToVtt(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let fields = [];
  const cues = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '[Events]') { inEvents = true; continue; }
    if (inEvents && t.startsWith('[') && t !== '[Events]') { inEvents = false; continue; }
    if (!inEvents) continue;
    if (/^Format:/i.test(t)) {
      fields = t.replace(/^Format:\s*/i, '').split(',').map(x => x.trim().toLowerCase());
      continue;
    }
    if (/^Dialogue:/i.test(t)) {
      const vals = splitAss(t.replace(/^Dialogue:\s*/i, ''));
      const obj = {};
      fields.forEach((f, i) => { obj[f] = vals[i] != null ? vals[i].trim() : ''; });
      const start = assTimeToVtt(obj.start);
      const end = assTimeToVtt(obj.end);
      if (!start || !end) continue;
      // 去 ASS 覆盖标签 {\...}，把 \N 换行
      let body = String(obj.text || '')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N/g, '\n').replace(/\\n/g, '\n')
        .replace(/<[^>]+>/g, '');
      if (!body.trim()) continue;
      cues.push(`${start} --> ${end}\n${body}`);
    }
  }
  return 'WEBVTT\n\n' + (cues.join('\n\n') || '(此 ASS 无可转换的对白)') + '\n';
}

/** ASS Dialogue 行按逗号切，但 text 字段里可能含逗号 → 前 N-1 个逗号切，剩余归 text */
function splitAss(s) {
  const out = [];
  let cur = '', depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  // 标准 ASS 有 10 个字段，text 是第 10 个（index 9），多余逗号并回 text
  if (out.length > 10) out.splice(9, out.length - 9, out.slice(9).join(','));
  return out;
}

function toVtt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');
  if (ext === '.vtt') return raw.replace(/^\uFEFF/, '');
  if (ext === '.ass' || ext === '.ssa') return assToVtt(raw);
  return srtToVtt(raw);
}

module.exports = { srtToVtt, assToVtt, toVtt };
