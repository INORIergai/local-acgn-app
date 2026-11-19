// ================================================================
// utils/ass-style.js —— v6.4.0 第二档① ASS 特效字幕解析
//   不引 libass.js（镜像没包 + wasm 重），改为解析 ASS 覆盖标签成结构化样式，
//   前端用 HTML 字幕层渲染（比浏览器 <track> 的 ::cue 表现力强）。
//
//   支持：\pos(x,y) \move(x1,y1,x2,y2) \c&HxxYYZZ& \fs字号 \b粗体
//         \an对齐号 \bord描边 \3c描边色 \fad淡入淡出 \N/\n换行
//   ASS 颜色是 &HAABBGGRR&（BGR 顺序 + alpha），转 CSS #RRGGBB。
// ================================================================

function assColorToCss(s) {
  if (!s) return null;
  const m = /&H([0-9a-fA-F]{6,8})/.exec(String(s));
  if (!m) return null;
  // ASS 颜色 &HAABBGGRR&：8 位时前 2 位是 alpha，取后 6 位；6 位时直接取。
  let h = m[1];
  let hex = (h.length >= 8 ? h.slice(2) : h).toUpperCase();
  const rr = hex.slice(4, 6), gg = hex.slice(2, 4), bb = hex.slice(0, 2);
  return '#' + rr + gg + bb;
}

/** ASS 时间 → 秒（浮点） */
function assTimeSec(t) {
  const p = String(t || '').trim().split(':');
  if (p.length < 2) return 0;
  return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (parseFloat(p[2] || '0') || 0);
}

/** 解析单个 {\...} 覆盖标签块 → 样式对象 */
function parseOverride(tag) {
  const st = {};
  let m;
  if ((m = /\\pos\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i.exec(tag))) st.pos = [+m[1], +m[2]];
  if ((m = /\\move\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(tag))) st.move = [+m[1], +m[2], +m[3], +m[4]];
  if ((m = /\\c\s*&H[0-9a-fA-F]{6,8}/i.exec(tag))) st.color = assColorToCss(m[0]);
  if ((m = /\\3c\s*&H[0-9a-fA-F]{6,8}/i.exec(tag))) st.borderColor = assColorToCss(m[0]);
  if ((m = /\\fs\s*(\d+)/i.exec(tag))) st.fontSize = +m[1];
  if ((m = /\\b\s*(\d)/i.exec(tag))) st.bold = m[1] === '1';
  if ((m = /\\i\s*(\d)/i.exec(tag))) st.italic = m[1] === '1';
  if ((m = /\\bord\s*([\d.]+)/i.exec(tag))) st.border = +m[1];
  if ((m = /\\an\s*(\d)/i.exec(tag))) st.align = +m[1];
  if ((m = /\\fad\(\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(tag))) st.fade = [+m[1], +m[2]];
  return st;
}

/** 解析 Dialogue 文本里的 {\...} 标签 + 纯文本，返回 {text, style} */
function parseDialogueText(raw) {
  let text = '';
  const style = {};
  const re = /\{([^}]*)\}/g;
  let last = 0, m;
  while ((m = re.exec(raw))) {
    text += raw.slice(last, m.index);
    Object.assign(style, parseOverride(m[1]));
    last = m.index + m[0].length;
  }
  text += raw.slice(last);
  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, '\u00a0');
  return { text: text.trim(), style };
}

/** 完整 ASS → 结构化 cues（供前端 HTML 字幕层渲染） */
function parseAssStyles(text, opts = {}) {
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false, fields = [];
  const styles = {};          // [V4+ Styles] 里的命名样式（基础）
  const cues = [];
  let maxLines = 0;
  for (const line of lines) {
    const t = line.trim();
    if (/^\[V4\+\s*Styles\]/i.test(t)) { inEvents = false; continue; }
    if (t === '[Events]') { inEvents = true; continue; }
    if (inEvents && t.startsWith('[')) { inEvents = false; continue; }
    if (/^Style:/i.test(t) && !inEvents) {
      // Style 行字段都是简单值（无逗号），直接 split；不能用 splitAss（它会把第10字段后合并，那是给 Dialogue 的）
      const vals = t.replace(/^Style:\s*/i, '').split(',').map(x => x.trim());
      // 标准 Style 字段序: Name,Fontname,Fontsize,PrimaryColour,...,Bold,Italic,...,Alignment,...
      if (vals.length > 20) {
        styles[vals[0].trim()] = {
          fontSize: +vals[2] || 20,
          color: assColorToCss(vals[3]),
          // 标准字段序：0Name 1Font 2Size 3Primary 4Secondary 5Outline 6Back 7Bold 8Italic ... 18Alignment
          bold: vals[7] === '-1' || vals[7] === '1',
          italic: vals[8] === '-1' || vals[8] === '1',
          align: +vals[18] || 2,
        };
      }
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(t)) { fields = t.replace(/^Format:\s*/i, '').split(',').map(x => x.trim().toLowerCase()); continue; }
    if (/^Dialogue:/i.test(t)) {
      const vals = splitAss(t.replace(/^Dialogue:\s*/i, ''));
      const obj = {};
      fields.forEach((f, i) => { obj[f] = vals[i] != null ? vals[i].trim() : ''; });
      const start = assTimeSec(obj.start), end = assTimeSec(obj.end);
      if (!(end > start)) continue;
      const parsed = parseDialogueText(obj.text || '');
      if (!parsed.text) continue;
      const base = styles[obj.style] || {};
      cues.push({
        start: +start.toFixed(3), end: +end.toFixed(3),
        text: parsed.text,
        style: Object.assign({ fontSize: 20, color: '#ffffff', border: 1, align: 2 }, base, parsed.style),
        layer: +obj.layer || 0,
      });
      maxLines = Math.max(maxLines, parsed.text.split('\n').length);
    }
  }
  cues.sort((a, b) => a.start - b.start || a.layer - b.layer);
  return { cues, maxLines, namedStyles: Object.keys(styles).length };
}

/** ASS Dialogue 行按逗号切，text 里逗号归最后一个字段 */
function splitAss(s) {
  const out = []; let cur = '', depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  if (out.length > 10) out.splice(9, out.length - 9, out.slice(9).join(','));
  return out;
}

module.exports = { parseAssStyles, parseDialogueText, assColorToCss, assTimeSec };
