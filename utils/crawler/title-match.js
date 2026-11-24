/**
 * 标题匹配工具（动漫库封面刮削共用）
 *
 * 为什么需要它：
 *   本地动漫文件名与站点标题常常「同义不同形」——
 *   繁体 vs 简体（讓妻子參加同學會後 / 让妻子参加同学会后）、
 *   日文新字体 vs 简体（優等生 / 优等生）、带/不带副标题、带/不带字幕组标记。
 *   直接用 `String.includes` 判定，命中率几乎为 0（这正是动漫库长期搜不到封面的原因之一）。
 *
 * 做法：先把两边都归一化（小写 + 繁简统一 + 去标点/装饰符），再算「完整包含」或「字符 Dice 相似度」。
 */

// 繁体 / 日文新字体 → 简体 的完整映射
// 手写表（下面 T2S_MANUAL）只覆盖实际撞上的字，缺字会导致「媽媽喝罵」这种标题
// 归一化失败、相似度被压低。完整表由 OpenCC 的 T2S 字典生成（t2s-dict.js，3221 个单字）。
// 手写表放后面覆盖，保留我们对「日文新字体」的特意处理。
const { T2S_FULL } = require('./t2s-dict');

const T2S_MANUAL = {
  讓: '让', 參: '参', 會: '会', 後: '后', 們: '们', 個: '个', 為: '为', 與: '与', 這: '这', 麼: '么',
  樣: '样', 對: '对', 開: '开', 關: '关', 見: '见', 現: '现', 實: '实', 說: '说', 學: '学', 師: '师',
  長: '长', 門: '门', 問: '问', 間: '间', 時: '时', 話: '话', 語: '语', 車: '车', 東: '东', 馬: '马',
  鳥: '鸟', 魚: '鱼', 龍: '龙', 愛: '爱', 親: '亲', 覺: '觉', 讀: '读', 書: '书', 響: '响', 羅: '罗',
  樹: '树', 種: '种', 積: '积', 稱: '称', 節: '节', 範: '范', 續: '续', 繼: '继', 級: '级', 紀: '纪',
  約: '约', 純: '纯', 紙: '纸', 細: '细', 終: '终', 組: '组', 統: '统', 絲: '丝', 綠: '绿', 網: '网',
  緊: '紧', 練: '练', 線: '线', 編: '编', 緩: '缓', 總: '总', 織: '织', 職: '职', 聯: '联', 腦: '脑',
  臉: '脸', 臨: '临', 舉: '举', 舊: '旧', 蓋: '盖', 藝: '艺', 處: '处', 號: '号', 蟲: '虫', 補: '补',
  裝: '装', 觀: '观', 規: '规', 視: '视', 覽: '览', 計: '计', 訂: '订', 討: '讨', 訓: '训', 記: '记',
  講: '讲', 許: '许', 論: '论', 設: '设', 訪: '访', 証: '证', 評: '评', 詞: '词', 試: '试', 詩: '诗',
  誠: '诚', 誤: '误', 課: '课', 調: '调', 談: '谈', 請: '请', 諸: '诸', 買: '买', 賣: '卖', 費: '费',
  資: '资', 賓: '宾', 賞: '赏', 質: '质', 軍: '军', 較: '较', 載: '载', 輕: '轻', 輛: '辆', 輪: '轮',
  輝: '辉', 輸: '输', 轉: '转', 農: '农', 邊: '边', 過: '过', 達: '达', 遲: '迟', 選: '选', 遺: '遗',
  鄉: '乡', 醫: '医', 釋: '释', 風: '风', 飛: '飞', 齊: '齐', 歲: '岁', 萬: '万', 億: '亿', 條: '条',
  樂: '乐', 藥: '药', 團: '团', 圖: '图', 圍: '围', 園: '园', 圓: '圆', 願: '愿', 惡: '恶', 優: '优',
  殺: '杀', 無: '无', 捲: '卷', 發: '发', 禦: '御', 蘭: '兰', 戀: '恋', 類: '类', 點: '点', 燈: '灯',
  熱: '热', 營: '营', 犧: '牺', 狀: '状', 獨: '独', 獄: '狱', 產: '产', 畢: '毕', 異: '异', 畫: '画',
  當: '当', 疇: '畴', 療: '疗', 監: '监', 盤: '盘', 眾: '众', 礙: '碍', 禮: '礼', 穩: '稳', 窮: '穷',
  竊: '窃', 競: '竞', 筆: '笔', 簡: '简', 籤: '签', 廚: '厨', 廣: '广', 廢: '废', 彈: '弹', 強: '强',
  歸: '归', 殘: '残', 殼: '壳', 決: '决', 沒: '没', 潔: '洁', 澀: '涩', 濕: '湿', 災: '灾', 烏: '乌',
  煩: '烦', 煙: '烟', 猶: '犹', 獻: '献', 獸: '兽', 疊: '叠', 瘋: '疯', 皺: '皱', 盡: '尽', 睏: '困',
  瞞: '瞒', 矯: '矫', 硯: '砚', 確: '确', 禱: '祷', 竄: '窜', 粧: '妆', 糞: '粪', 糾: '纠', 納: '纳',
  紮: '扎', 結: '结', 絕: '绝', 經: '经', 緣: '缘', 縮: '缩', 繞: '绕', 纏: '缠', 驕: '骄', 體: '体',
  髮: '发', 鬥: '斗', 魯: '鲁', 鮮: '鲜', 鳴: '鸣', 鴉: '鸦', 鶴: '鹤', 麗: '丽', 黃: '黄', 黨: '党',
  齊: '齐', 齋: '斋', 齒: '齿', 齡: '龄', 龐: '庞', 龜: '龟',
};

/** 完整表 + 手写覆盖（手写表优先，保留日文新字体的特意处理） */
const T2S = Object.assign({}, T2S_FULL, T2S_MANUAL);

function toSimp(s) {
  let out = '';
  for (const ch of String(s || '')) out += (T2S[ch] || ch);
  return out;
}

/**
 * 归一化：小写 + 繁转简 + 去掉标点/空白/括号/装饰符
 * 保留：CJK 汉字、假名、拉丁字母、数字
 */
function norm(s) {
  return toSimp(String(s || '').toLowerCase())
    .replace(/[\s\-_·:：,，。.、!！?？~〜～"'“”‘’「」『』【】\[\]（）()〈〉《》#*+&/\\|;；]/g, '')
    .replace(/[☆★◆■●○〇♥♡♪①-⑳]/g, '');
}

// 通用噪声词：两边都剥掉再比，否则「THE ANIMATION」「中文字幕」这类词会让
// 毫不相干的两部片（ランス01 … THE ANIMATION vs 聖ヤリマンシスターズ… THE ANIMATION）
// 也凑出 0.4+ 的假相似度，把候选面板塞满噪声。
const NOISE = [
  'theanimation', 'animation', 'ova', 'oad', 'ona', '中文字幕', '繁中字幕', '简中字幕', '中字',
  '無修正', '无修正', '完全版', '完整版', '全集', '完結', '完结', '第1話', '第2話', '第3話', '第4話',
];

/** 归一化 + 剥离通用噪声词（用于相似度计算，避免「THE ANIMATION」刷分） */
function normForMatch(s) {
  let t = norm(s);
  for (const n of NOISE) t = t.split(n).join('');
  return t;
}

/** 字符集合的 Dice 系数（对繁简差异不敏感，正是我们要的） */
function dice(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 公共前缀长度 */
function commonPrefixLen(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * 候选标题与查询词的相似度
 * 两个入参都可以是「原始串」或「已归一化的串」——内部统一再做一次归一化，幂等。
 *
 * 逐级判定：
 *   1. 完整包含           → 1.00（最可靠）
 *   2. 去掉数字后包含     → 0.95（「妹ぱらだいす! 2」 vs 「妹ぱらだいす！2 下巻…」，数字位置不同会打断包含）
 *   3. 公共前缀够长       → 0.85（候选是系列名，查询后面带副标题/卷号）
 *   4. 字符 Dice 系数     → 兜底（对繁简差异不敏感）
 */
function simScore(candTitle, query) {
  const t = normForMatch(candTitle);
  const q = normForMatch(query);
  if (!t || !q) return 0;

  if (q.includes(t) || t.includes(q)) return 1;

  const tNoNum = t.replace(/\d+/g, '');
  const qNoNum = q.replace(/\d+/g, '');
  if (tNoNum.length >= 3 && qNoNum.length >= 2 && (qNoNum.includes(tNoNum) || tNoNum.includes(qNoNum))) return 0.95;

  const lcp = commonPrefixLen(t, q);
  if (lcp >= 4 && lcp / Math.min(t.length, q.length) >= 0.5) return 0.85;

  return dice(t, q);
}

/**
 * round142：里番标题清洗 —— 生成多个「渐进放宽」的查询词
 * ----------------------------------------------------------------------------
 * 为什么需要：库里大量标题带着字幕组/汉化组前缀与卷号，AniList 搜不到。
 *   实测这些形态（12 条抽样只命中 5 条主因就是它们）：
 *     [脸肿字幕组][720P][ばにぃうぉ～か～]JKビッチに搾られたい ＃1 ヤリマンJK
 *     [FoxSub] 15美少女漂流記 OVA3 ～南の島でウハ2 どんぶりエッチ編
 *     [なめらか動画部] 【4K神画質】聖職者 失格！祈りを捨てた背徳悦びSEX153
 *   而 AniList 的条目名是干净的「JKビッチに搾られたい」「15美少女漂流記」。
 *
 * 策略：**不猜**，给出一串由严到宽的候选词，交给调用方逐个试，
 *   每个都仍走 pickBest 的相似度门禁（宁可不出图，也不要配错封面）。
 */
const SUB_GROUP_RE = /\[[^\]]*(字幕|汉化|漢化|翻译|翻譯|sub|Sub|SUB|raws?|压制|壓制|组|組|社|部|アニメ|工房|動画|Team|team)[^\]]*\]/g;
const BRACKET_ANY_RE = /\[[^\]]*\]|【[^】]*】/g;
const RES_RE = /\b(2160p|1080p|720p|480p|4k|8k|uhd|fhd|hd|hevc|x26[45]|h\.?26[45]|av1|aac|flac|10bit|8bit)\b/gi;
const NOISE_TAIL_RE = /(上巻|下巻|前編|後編|前篇|後篇|完成版|修正版|完全版|无修正|無修正|中文字幕|中字|字幕|全集|完結|完结)/g;

/** 去掉字幕组/画质标记/方括号噪声 */
function stripDecorations(s) {
  let t = String(s || '');
  t = t.replace(SUB_GROUP_RE, ' ');
  t = t.replace(BRACKET_ANY_RE, ' ');       // 兜底：任何方括号/【】内容
  t = t.replace(RES_RE, ' ');
  t = t.replace(NOISE_TAIL_RE, ' ');
  t = t.replace(/[＃♯#]\s*\d+/g, ' ');        // 「＃1」这类卷号
  t = t.replace(/(\s*\d{1,3})\s*$/, ' ');     // 结尾裸数字（「… 2」）
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * 生成候选查询词：由严到宽，最多 5 个，去重
 * @param {string} title 原始标题
 * @returns {string[]}
 */
function buildQueries(title) {
  const src = String(title || '').trim();
  if (!src) return [];
  const out = [];
  const push = (q) => {
    const v = String(q || '').replace(/\s+/g, ' ').trim();
    if (v.length < 2) return;
    if (out.some(x => x.toLowerCase() === v.toLowerCase())) return;
    out.push(v);
  };

  push(src);                                  // ① 原样
  push(stripDecorations(src));                // ② 去装饰
  const cleaned = stripDecorations(src);

  // ③ 再去卷号/话数（「… 第2話」「… 2」「… #1」）
  push(cleaned.replace(/(第\s*\d+\s*[話话巻卷集])|(\d+\s*[話话巻卷集])/g, ' ')
    .replace(/[＃♯#]\s*\d+/g, ' ')
    .replace(/\s+\d{1,3}\s*\Z/, ' ')
    .replace(/\s+\d{1,3}\s/g, ' '));

  // ④ 只取第一个显著片段（长标题取前 12 字，日文常用做法）
  const firstSeg = cleaned.split(/[~〜～、,，:：|\s]\s*/).filter(Boolean)[0] || '';
  if (firstSeg && firstSeg !== cleaned) push(firstSeg);

  // ⑤ 截断到前 12 个字符（AniList 对超长查询容易零结果）
  if (cleaned.length > 12) push(cleaned.slice(0, 12));

  return out.slice(0, 5);
}

/**
 * round142：跨语种标题匹配。
 * AniList 的条目同时有 native（日文）/ romaji（罗马音）/ english 三个名字，
 * 而本地库标题常常是英文或中文。原来 pickBest 只拿 c.title（native）比对，
 * 于是「Dearest Blue 2」 vs 「ディアレストブルー」相似度 = 0 → 明明是同一部却被丢弃。
 * 这里对候选的所有名字取最高分。
 */
function titleVariantsOf(c) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(c.title);
  push(c.romaji);
  push(c.english);
  push(c.originalTitle);
  return out;
}

/**
 * 从候选里挑最佳匹配
 * @param {Array<{title:string, romaji?:string, english?:string}>} cands
 * @param {string} query 原始查询词（内部会归一化）
 * @param {number} threshold 低于该相似度视为未命中（宁可不出图，也不要配错图）
 */
function pickBest(cands, query, threshold = 0.6) {
  let best = null, bestScore = 0;
  for (const c of cands) {
    const names = titleVariantsOf(c);
    let s = 0;
    for (const n of names) {
      const v = simScore(n, query);
      if (v > s) s = v;
    }
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (!best || bestScore < threshold) return null;
  best._score = bestScore;
  return best;
}

module.exports = { T2S, toSimp, norm, normForMatch, dice, simScore, pickBest, commonPrefixLen,
  stripDecorations, buildQueries };
