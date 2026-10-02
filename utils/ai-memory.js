/**
 * ai-memory.js —— CinemaVault 记忆引擎（Alife 式分层记忆，v3.0-c/d）
 * --------------------------------------------------------------------------
 * 对齐 docs/roadmap-v3.0-AI.md 里 Alife（github.com/Waylen360/Alife）的四条做法：
 *  ① 永久唯一会话：对话历史落库（ai_messages），跨重启保留，伪常驻上下文——
 *     不靠 LLM 自主记忆，每次请求由本模块把「分层摘要 + 长期记忆 + 活动窗口」注进去。
 *  ② 多级 cache 式记忆压缩：活动窗口超限 → 最旧一段折叠成 L1 摘要（带 fromMsgId/
 *     toMsgId 区间可溯源）→ L1 攒够 4 层折叠成 L2 → L2 超 5 层再深折叠。逐级有损，
 *     但越旧的越浓缩，永不静默丢失。
 *  ③ 长期记忆（ai_memories）：对话后自动提取偏好/雷点/习惯/事实，与既有记忆做
 *     相似度去重合并（防止同一条记忆无限膨胀），按重要度+新近度注入，命中计数。
 *     条目超上限时淘汰低分旧条目，并定期做一次全库合并压缩（压缩长存）。
 *  ④ 白盒化：getStatus() 把窗口/摘要/记忆全部状态吐给前端，用户可在设置页查看、
 *     编辑、删除、手动补充记忆条目。
 *
 * 纪律：所有 AI 辅助动作（压缩/提取）都是后台单飞（single-flight），失败只打日志
 * 绝不影响对话主链路；配置每次现读磁盘（与人格/模型路由同一纪律，保存即生效）。
 */
const fs = require('fs');
const { db } = require('./db');
const config = require('./config');

// ========== 表结构（幂等：新库旧库启动即建，schema.sql 里另有同款供白纸建库） ==========
db.exec("CREATE TABLE IF NOT EXISTS ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL DEFAULT 'main', role TEXT NOT NULL, content TEXT NOT NULL, summarized INTEGER DEFAULT 0, createdAt INTEGER DEFAULT (strftime('%s','now')))");
db.exec('CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(sessionId, id)');
db.exec("CREATE TABLE IF NOT EXISTS ai_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL DEFAULT 'main', level INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL, fromMsgId INTEGER, toMsgId INTEGER, createdAt INTEGER DEFAULT (strftime('%s','now')))");
db.exec('CREATE INDEX IF NOT EXISTS idx_ai_summaries_session ON ai_summaries(sessionId, level)');
db.exec("CREATE TABLE IF NOT EXISTS ai_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT DEFAULT 'preference', content TEXT NOT NULL, importance REAL DEFAULT 0.5, hitCount INTEGER DEFAULT 0, source TEXT, createdAt INTEGER DEFAULT (strftime('%s','now')), updatedAt INTEGER DEFAULT (strftime('%s','now')))");

// ========== 预编译语句（所有用户数据一律走 ? 参数绑定） ==========
const stmt = {
  insertMsg: db.prepare('INSERT INTO ai_messages (sessionId, role, content) VALUES (?, ?, ?)'),
  unsummarized: db.prepare('SELECT id, role, content FROM ai_messages WHERE sessionId = ? AND summarized = 0 ORDER BY id ASC'),
  liveWindowDesc: db.prepare('SELECT id, role, content FROM ai_messages WHERE sessionId = ? AND summarized = 0 ORDER BY id DESC LIMIT ?'),
  markSummarized: db.prepare('UPDATE ai_messages SET summarized = 1 WHERE id = ?'),
  countMsgs: db.prepare('SELECT SUM(CASE WHEN summarized = 0 THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN summarized = 1 THEN 1 ELSE 0 END) AS folded FROM ai_messages WHERE sessionId = ?'),
  historyDesc: db.prepare('SELECT id, role, content, createdAt FROM ai_messages WHERE sessionId = ? ORDER BY id DESC LIMIT ?'),
  insSummary: db.prepare('INSERT INTO ai_summaries (sessionId, level, content, fromMsgId, toMsgId) VALUES (?, ?, ?, ?, ?)'),
  summariesAsc: db.prepare('SELECT * FROM ai_summaries WHERE sessionId = ? AND level = ? ORDER BY id ASC'),
  latestSummary: db.prepare('SELECT * FROM ai_summaries WHERE sessionId = ? AND level = ? ORDER BY id DESC LIMIT 1'),
  delSummary: db.prepare('DELETE FROM ai_summaries WHERE id = ?'),
  countSummaries: db.prepare('SELECT COUNT(*) AS n FROM ai_summaries WHERE sessionId = ? AND level = ?'),
  allMemories: db.prepare('SELECT * FROM ai_memories ORDER BY importance DESC, updatedAt DESC'),
  topMemories: db.prepare('SELECT * FROM ai_memories ORDER BY importance DESC, updatedAt DESC LIMIT ?'),
  insMemory: db.prepare("INSERT INTO ai_memories (kind, content, importance, source) VALUES (?, ?, ?, 'chat')"),
  insMemoryUser: db.prepare("INSERT INTO ai_memories (kind, content, importance, source) VALUES (?, ?, ?, 'user')"),
  updMemoryHit: db.prepare('UPDATE ai_memories SET hitCount = hitCount + 1 WHERE id = ?'),
  reinforceMemory: db.prepare("UPDATE ai_memories SET importance = ?, updatedAt = strftime('%s','now'), hitCount = hitCount + 1 WHERE id = ?"),
  mergeMemory: db.prepare("UPDATE ai_memories SET content = ?, importance = ?, updatedAt = strftime('%s','now') WHERE id = ?"),
  editMemory: db.prepare("UPDATE ai_memories SET content = ?, kind = ?, importance = ?, updatedAt = strftime('%s','now') WHERE id = ?"),
  getMemory: db.prepare('SELECT * FROM ai_memories WHERE id = ?'),
  delMemory: db.prepare('DELETE FROM ai_memories WHERE id = ?'),
  countMemories: db.prepare('SELECT COUNT(*) AS n FROM ai_memories'),
  worstMemories: db.prepare('SELECT id FROM ai_memories ORDER BY importance ASC, updatedAt ASC LIMIT ?')
};

// ========== 配置（每次现读磁盘：设置页保存后立即生效，与人格/模型路由同一纪律） ==========
const DEFAULTS = { enabled: true, liveTurns: 10, autoCompress: true, autoMemory: true, memoryCap: 100 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function getMemorySettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8'));
    const m = (raw.ai && raw.ai.memory) || {};
    return {
      enabled: m.enabled !== false,
      liveTurns: clamp(parseInt(m.liveTurns) || DEFAULTS.liveTurns, 2, 50),
      autoCompress: m.autoCompress !== false,
      autoMemory: m.autoMemory !== false,
      memoryCap: clamp(parseInt(m.memoryCap) || DEFAULTS.memoryCap, 10, 500)
    };
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function normalizeSessionId(x) {
  const s = String(x || 'main').trim();
  return (/^[a-zA-Z0-9_-]{1,64}$/.test(s) ? s : 'main');
}

// ========== 会话消息持久化 ==========
function appendMessage(sessionId, role, content) {
  const text = String(content || '').slice(0, 8000);
  if (!text) return 0;
  return stmt.insertMsg.run(normalizeSessionId(sessionId), role === 'assistant' ? 'assistant' : 'user', text).lastInsertRowid;
}

/** 前端恢复历史（最后 limit 条，升序返回） */
function getHistory(sessionId, limit) {
  const n = clamp(parseInt(limit) || 60, 1, 200);
  return stmt.historyDesc.all(normalizeSessionId(sessionId), n).reverse();
}

/** 注入用的长期记忆文本块（按重要度+新近度取 top N） */
const KIND_LABEL = { preference: '偏好', dislike: '雷点', habit: '习惯', fact: '事实' };
function buildMemoryText(topN) {
  const rows = stmt.topMemories.all(clamp(topN || 8, 1, 20));
  return rows.map(r => '- [' + (KIND_LABEL[r.kind] || r.kind) + '] ' + r.content).join('\n');
}

// ========== 上下文装配（伪常驻上下文的核心：每次请求由这里拼注入） ==========
function buildChatContext(sessionId) {
  const sid = normalizeSessionId(sessionId);
  const s = getMemorySettings();
  const stats = getStatus(sid);
  const empty = { history: [], summaryText: '', memoryText: '', injectedMemoryIds: [], stats };
  if (!s.enabled) return empty;
  try {
    // ① 活动窗口：最近 liveTurns 轮（1 轮 = user + assistant 两条）
    const liveDesc = stmt.liveWindowDesc.all(sid, clamp(s.liveTurns, 2, 50) * 2);
    const history = liveDesc.reverse().map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 2000)
    })).filter(m => m.content);

    // ② 分层摘要：L2 浓缩记忆（旧）+ 最新 L1 近期摘要
    const l2s = stmt.summariesAsc.all(sid, 2).slice(-4);
    const l1 = stmt.latestSummary.get(sid, 1);
    let summaryText = '';
    if (l2s.length) {
      summaryText += '【更早对话 · 浓缩记忆】\n' + l2s.map(x => '· ' + x.content).join('\n') + '\n';
    }
    if (l1) {
      summaryText += '【近期对话 · 摘要】\n' + l1.content;
    }

    // ③ 长期记忆 top8，注入即计一次命中
    const memoryText = buildMemoryText(8);
    const injectedMemoryIds = stmt.topMemories.all(8).map(r => r.id);

    return { history, summaryText: summaryText.trim(), memoryText, injectedMemoryIds, stats };
  } catch (e) {
    console.log('[记忆引擎] 上下文装配失败（不影响本轮对话）:', e.message);
    return empty;
  }
}

function recordMemoryHits(ids) {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    try { stmt.updMemoryHit.run(id); } catch (e) { /* 计数失败无所谓 */ }
  }
}

// ========== 多级 cache 式上下文压缩 ==========
let compressing = false;

function cleanSummaryText(t) {
  let s = String(t || '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  return s.slice(0, 1200);
}

/** 把一段消息折叠成摘要（prev = 旧摘要，做增量合并） */
async function aiFoldMessages(prevSummary, transcript) {
  const { callAI } = require('./ai-service');
  const parts = [];
  parts.push(prevSummary ? '现有此前对话的摘要：\n' + prevSummary + '\n' : '目前还没有更早的摘要。');
  parts.push('新增的一段对话：\n' + transcript);
  parts.push('请把新增对话合并进摘要，直接输出合并后的新摘要正文（不要任何解释、前言或代码块标记）：保留关键事实、用户的偏好与决定、正在进行和未完成的事项、提到的影片编号/标题；省略寒暄与重复内容。总长不超过 300 字，用中文。');
  const out = await callAI(parts.join('\n\n'), '你是本地媒体库应用的对话记忆压缩模块，只输出压缩摘要的正文本身。', null, []);
  return cleanSummaryText(out);
}

function transcriptOf(batch) {
  return batch.map(m => (m.role === 'assistant' ? 'AI：' : '用户：') + String(m.content).slice(0, 600)).join('\n');
}

/** 单次折叠：把 batch 消息折成一条 L1 摘要并标记已折叠 */
async function foldBatch(sessionId, batch) {
  const prev = stmt.latestSummary.get(sessionId, 1);
  const merged = await aiFoldMessages(prev ? prev.content : '', transcriptOf(batch));
  if (!merged) throw new Error('压缩结果为空');
  stmt.insSummary.run(sessionId, 1, merged, batch[0].id, batch[batch.length - 1].id);
  for (const m of batch) stmt.markSummarized.run(m.id);
}

/** L1 攒够 4 层 → 折成一条 L2；L2 超 5 层 → 最旧的 3 条深折叠成 1 条 */
async function foldLevels(sessionId) {
  const FOLD_L1_AT = 4, L2_CAP = 5;

  const l1s = stmt.summariesAsc.all(sessionId, 1);
  if (l1s.length >= FOLD_L1_AT) {
    try {
      const merged = await aiFoldMessages('', l1s.map(x => '· ' + x.content).join('\n'));
      if (merged) {
        stmt.insSummary.run(sessionId, 2, merged, l1s[0].fromMsgId, l1s[l1s.length - 1].toMsgId);
        for (const x of l1s) stmt.delSummary.run(x.id);
      }
    } catch (e) { console.log('[记忆引擎] L1→L2 折叠失败:', e.message); }
  }

  const l2s = stmt.summariesAsc.all(sessionId, 2);
  if (l2s.length > L2_CAP) {
    const oldest = l2s.slice(0, 3);
    try {
      const merged = await aiFoldMessages('', oldest.map(x => '· ' + x.content).join('\n'));
      if (merged) {
        stmt.insSummary.run(sessionId, 2, merged, oldest[0].fromMsgId, oldest[oldest.length - 1].toMsgId);
        for (const x of oldest) stmt.delSummary.run(x.id);
      }
    } catch (e) { console.log('[记忆引擎] L2 深折叠失败:', e.message); }
  }
}

/** 活动窗口超限（滞后 4 条防抖）时折叠最旧一段；foldAll=true 折叠全部（新对话用） */
async function compressSession(sessionId, opts) {
  const foldAll = !!(opts && opts.foldAll);
  const sid = normalizeSessionId(sessionId);
  const s = getMemorySettings();
  if (!s.enabled || !s.autoCompress) return { ok: false, reason: 'disabled' };

  const live = stmt.unsummarized.all(sid);
  const windowSize = clamp(s.liveTurns, 2, 50) * 2;
  let batch;
  if (foldAll) {
    batch = live;
  } else {
    const overflow = live.length - windowSize;
    if (overflow < 4) return { ok: false, reason: 'under-threshold' };
    batch = live.slice(0, Math.min(Math.max(overflow, 4), 14));
  }
  if (batch.length < 2) return { ok: false, reason: 'too-few' };

  await foldBatch(sid, batch);
  await foldLevels(sid);
  return { ok: true, folded: batch.length };
}

async function maybeCompress(sessionId) {
  if (compressing) return { ok: false, reason: 'busy' };
  compressing = true;
  try {
    return await compressSession(sessionId);
  } catch (e) {
    console.log('[记忆引擎] 上下文压缩失败（下轮自动重试）:', e.message);
    return { ok: false, reason: e.message };
  } finally {
    compressing = false;
  }
}

/** 「新对话」：把当前窗口全部折叠成摘要（可溯源，不丢内容），窗口清零重新开始 */
async function startNewSession(sessionId) {
  if (compressing) return { ok: false, reason: 'busy' };
  compressing = true;
  try {
    const sid = normalizeSessionId(sessionId);
    const s = getMemorySettings();
    const live = stmt.unsummarized.all(sid);
    if (!s.enabled || !s.autoCompress) {
      // 压缩关闭时也允许清窗口：直接标记折叠（不留摘要，尊重开关语义）
      for (const m of live) stmt.markSummarized.run(m.id);
      return { ok: true, folded: live.length, summarySkipped: true };
    }
    if (live.length >= 2) {
      await foldBatch(sid, live);
      await foldLevels(sid);
    }
    return { ok: true, folded: live.length };
  } catch (e) {
    console.log('[记忆引擎] 新对话折叠失败:', e.message);
    return { ok: false, reason: e.message };
  } finally {
    compressing = false;
  }
}

// ========== 长期记忆：提取 / 去重合并 / 压缩长存 ==========
let extracting = false;
let insertsSinceDeep = 0;

/** 中文友好相似度：字符二元组 Jaccard */
function similarity(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[\s，。,.!！?？、'"]/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  const grams = s => {
    const g = new Set();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    return g;
  };
  const gx = grams(x), gy = grams(y);
  if (!gx.size || !gy.size) return 0;
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return inter / (gx.size + gy.size - inter);
}

async function aiExtractMemories(transcript, existingList) {
  const { callAI } = require('./ai-service');
  const prompt = [
    '以下是一段用户与 AI 助手的对话：\n' + transcript,
    '已有长期记忆条目（已存在的信息不要重复输出）：\n' + (existingList || '（暂无）'),
    '请从对话中提取值得长期记住的用户信息（观影偏好、雷点、观看习惯、用户本人的重要事实）。',
    '只输出 JSON 数组，不要任何解释：[{"kind":"preference|dislike|habit|fact","content":"第三人称、60字以内","importance":0.5}]',
    '临时性、一次性的对话内容（比如「帮我搜下XX」）不要提取；没有值得记的就输出 []'
  ].join('\n\n');
  const out = await callAI(prompt, '你是本地媒体库应用的记忆提取模块，只输出 JSON。', null, []);
  const m = String(out || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => x && typeof x.content === 'string' && x.content.trim())
    .map(x => ({
      kind: ['preference', 'dislike', 'habit', 'fact'].includes(x.kind) ? x.kind : 'preference',
      content: String(x.content).trim().slice(0, 120),
      importance: clamp(parseFloat(x.importance) || 0.5, 0.1, 1)
    }));
}

/**
 * 记忆落库（含去重合并）：
 *  - 与既有条目高相似 → 强化或合并（保留更长的表述，重要度取大）
 *  - 否则新建；总数超 memoryCap 时淘汰最不重要最旧的
 *  - 每累计 30 次净新增触发一次全库合并压缩（压缩长存）
 */
async function saveExtractedMemories(entries) {
  let inserted = 0;
  for (const e of entries) {
    const all = stmt.allMemories.all();
    const hit = all.find(r => similarity(r.content, e.content) >= 0.5);
    if (hit) {
      if (similarity(hit.content, e.content) >= 0.95) {
        stmt.reinforceMemory.run(clamp(Math.max(hit.importance, e.importance) + 0.05, 0, 1), hit.id);
      } else {
        const content = hit.content.length >= e.content.length ? hit.content : e.content;
        stmt.mergeMemory.run(content, Math.max(hit.importance, e.importance), hit.id);
      }
      continue;
    }
    stmt.insMemory.run(e.kind, e.content, e.importance);
    inserted++;
  }

  if (inserted > 0) {
    insertsSinceDeep += inserted;
    // 容量淘汰：超出上限时清掉最弱最旧的
    const cap = getMemorySettings().memoryCap;
    let n = stmt.countMemories.get().n;
    while (n > cap) {
      const worst = stmt.worstMemories.all(n - cap);
      if (!worst.length) break;
      for (const w of worst) stmt.delMemory.run(w.id);
      n = stmt.countMemories.get().n;
    }
    // 每 30 次净新增做一次全库合并（压缩长存）
    if (insertsSinceDeep >= 30) {
      insertsSinceDeep = 0;
      const r = await deepCompressMemories();
      console.log('[记忆引擎] 周期性记忆压缩：合并 ' + r.merged + ' 组');
    }
  }
  return { inserted, total: stmt.countMemories.get().n };
}

/** 全库合并压缩：贪心聚类，相似 ≥0.45 的吸收进重要度最高的一条（表述取更长者） */
async function deepCompressMemories() {
  let merged = 0;
  for (;;) {
    const all = stmt.allMemories.all();
    let changed = false;
    for (let i = 0; i < all.length && !changed; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (similarity(all[i].content, all[j].content) >= 0.45) {
          const keep = all[i], drop = all[j];
          const content = keep.content.length >= drop.content.length ? keep.content : drop.content;
          stmt.mergeMemory.run(content, Math.max(keep.importance, drop.importance), keep.id);
          stmt.updMemoryHit.run(drop.id); // 命中数不丢，并入保留条
          stmt.delMemory.run(drop.id);
          merged++;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  return { merged };
}

async function maybeExtractMemories(sessionId) {
  const s = getMemorySettings();
  if (!s.enabled || !s.autoMemory) return { ok: false, reason: 'disabled' };
  if (extracting) return { ok: false, reason: 'busy' };
  extracting = true;
  try {
    const sid = normalizeSessionId(sessionId);
    const recent = getHistory(sid, 6);
    if (recent.length < 2) return { ok: false, reason: 'too-few' };
    // 只从最新一轮（最后 user→assistant）提取，避免反复咀嚼旧对话
    const lastPair = recent.slice(-2);
    if (lastPair[0].role !== 'user') return { ok: false, reason: 'no-pair' };
    const transcript = transcriptOf(lastPair);
    const existing = stmt.topMemories.all(40).map(r => '- ' + r.content).join('\n');
    const entries = await aiExtractMemories(transcript, existing);
    if (!entries.length) return { ok: true, inserted: 0 };
    const r = await saveExtractedMemories(entries);
    return Object.assign({ ok: true }, r);
  } catch (e) {
    console.log('[记忆引擎] 记忆提取失败（不影响对话）:', e.message);
    return { ok: false, reason: e.message };
  } finally {
    extracting = false;
  }
}

// ========== 白盒：状态与 CRUD ==========
function getStatus(sessionId) {
  const sid = normalizeSessionId(sessionId);
  try {
    const c = stmt.countMsgs.get(sid) || {};
    const l1 = stmt.countSummaries.get(sid, 1).n;
    const l2 = stmt.countSummaries.get(sid, 2).n;
    const mem = stmt.countMemories.get().n;
    return {
      liveMessages: c.live || 0,
      foldedMessages: c.folded || 0,
      l1Summaries: l1,
      l2Summaries: l2,
      memories: mem
    };
  } catch (e) {
    return { liveMessages: 0, foldedMessages: 0, l1Summaries: 0, l2Summaries: 0, memories: 0 };
  }
}

function listMemories() {
  return stmt.allMemories.all();
}

function addMemory(opts) {
  const o = opts || {};
  const text = String(o.content || '').trim().slice(0, 120);
  if (!text) throw new Error('记忆内容不能为空');
  const k = ['preference', 'dislike', 'habit', 'fact'].includes(o.kind) ? o.kind : 'preference';
  const imp = clamp(parseFloat(o.importance) || 0.8, 0.1, 1);
  const all = stmt.allMemories.all();
  const hit = all.find(r => similarity(r.content, text) >= 0.5);
  if (hit) { stmt.reinforceMemory.run(clamp(Math.max(hit.importance, imp), 0, 1), hit.id); return { merged: true, id: hit.id }; }
  const id = stmt.insMemoryUser.run(k, text, imp).lastInsertRowid;
  return { merged: false, id };
}

function updateMemory(id, opts) {
  const o = opts || {};
  const row = stmt.getMemory.get(id);
  if (!row) throw new Error('记忆不存在');
  const text = o.content !== undefined ? String(o.content).trim().slice(0, 120) : row.content;
  if (!text) throw new Error('记忆内容不能为空');
  const k = o.kind !== undefined && ['preference', 'dislike', 'habit', 'fact'].includes(o.kind) ? o.kind : row.kind;
  const imp = o.importance !== undefined ? clamp(parseFloat(o.importance) || row.importance, 0.1, 1) : row.importance;
  stmt.editMemory.run(text, k, imp, id);
}

function deleteMemory(id) {
  stmt.delMemory.run(id);
}

module.exports = {
  getMemorySettings,
  normalizeSessionId,
  appendMessage,
  getHistory,
  buildChatContext,
  recordMemoryHits,
  maybeCompress,
  startNewSession,
  maybeExtractMemories,
  deepCompressMemories,
  getStatus,
  listMemories,
  addMemory,
  updateMemory,
  deleteMemory
};
