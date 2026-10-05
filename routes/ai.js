const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const {
  translateMovie,
  generateTags,
  recommendMovies,
  chatWithAI,
  checkOllamaStatus
} = require('../utils/ai-service');
const { getMovieById, getAllMovies, getWatchHistory, getMovieTags, updateMovieRelations } = require('../utils/db');

// 检查AI状态
router.get('/status', async (req, res) => {
    try {
        const status = await checkOllamaStatus();
        res.json({ code: 0, data: status });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 翻译影片信息
router.post('/translate/:id', async (req, res) => {
    try {
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });
        
        const result = await translateMovie(movie);
        
        // 更新数据库
        const db = require('../utils/db').db;
        const updateStmt = db.prepare('UPDATE movies SET title = ?, overview = ? WHERE id = ?');
        updateStmt.run(result.title, result.overview, movie.id);
        
        res.json({ code: 0, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 生成智能标签
router.post('/tags/:id', async (req, res) => {
    try {
        const { overwrite = false } = req.body;
        const movie = getMovieById.get(req.params.id);
        if (!movie) return res.json({ code: -1, msg: '影片不存在' });
        
        // 获取影片现有标签和女优
        const existingTags = getMovieTags.all(movie.id);
        const { getMovieActresses } = require('../utils/db');
        const existingActresses = getMovieActresses.all(movie.id);
        movie.tags = existingTags;
        movie.actresses = existingActresses;
        
        const result = await generateTags(movie);
        const newTags = result.tags || [];
        const newActresses = result.actresses || [];
        
        // 保存标签和女优到数据库
        let finalTags = newTags;
        let finalActresses = newActresses;
        
        if (!overwrite) {
            // 合并现有标签和新标签
            const existingNames = existingTags.map(t => t.name);
            finalTags = [...new Set([...existingNames, ...newTags])];
            
            // 合并现有女优和新女优
            const existingActressNames = existingActresses.map(a => a.name);
            finalActresses = [...new Set([...existingActressNames, ...newActresses])];
        }
        
        updateMovieRelations(movie.id, { tags: finalTags, actresses: finalActresses });
        
        res.json({ 
            code: 0, 
            data: {
                tags: newTags,
                actresses: newActresses
            }, 
            saved: true 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// AI推荐
router.get('/recommend', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        
        // 获取所有影片
        const allMovies = getAllMovies.all();
        
        // 获取观看历史（最近20部）
        const history = getWatchHistory.all(20);
        const historyMovies = history.map(h => {
            const movie = allMovies.find(m => m.id === h.movieId);
            return movie || null;
        }).filter(Boolean);
        
        // 如果没有观看历史，推荐热门影片
        if (historyMovies.length === 0) {
            const hotMovies = allMovies
                .sort((a, b) => (b.hotScore || 0) - (a.hotScore || 0))
                .slice(0, limit);
            return res.json({ code: 0, data: hotMovies });
        }
        
        // AI推荐
        const recommendedIds = await recommendMovies(historyMovies, allMovies, limit);
        const recommendedMovies = recommendedIds
            .map(id => allMovies.find(m => m.id === id))
            .filter(Boolean);
        
        // 如果AI推荐失败，返回热门推荐
        if (recommendedMovies.length === 0) {
            const hotMovies = allMovies
                .sort((a, b) => (b.hotScore || 0) - (a.hotScore || 0))
                .slice(0, limit);
            return res.json({ code: 0, data: hotMovies });
        }
        
        res.json({ code: 0, data: recommendedMovies });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// AI对话（v3.0-c/d：永久唯一会话 + Alife 式记忆引擎注入）
router.post('/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.json({ code: -1, msg: '消息不能为空' });

        // 记忆引擎：装配注入上下文（长期记忆 + 分层摘要 + 活动窗口），再落库当前消息
        const aiMemory = require('../utils/ai-memory');
        const sessionId = aiMemory.normalizeSessionId(req.body.sessionId);
        const chatCtx = aiMemory.buildChatContext(sessionId);
        aiMemory.appendMessage(sessionId, 'user', message);

        // 获取所有影片（限制数量，避免上下文过大）
        const allMovies = getAllMovies.all().slice(0, 100);

        // 获取影片标签信息
        const { getMovieTags, getMovieActresses, getMovieById } = require('../utils/db');
        for (const movie of allMovies) {
            movie.tags = getMovieTags.all(movie.id);
            movie.actresses = getMovieActresses.all(movie.id);
        }

        const aiResult = await chatWithAI(message, allMovies, {
            history: chatCtx.history,
            summaryText: chatCtx.summaryText,
            memoryText: chatCtx.memoryText
        }, runAgentTool);

        // 兼容新旧返回格式
        let reply = '';
        let toolCalls = [];
        let movieRefs = [];
        let steps = [];

        if (typeof aiResult === 'string') {
            reply = aiResult;
        } else {
            reply = aiResult.content || '';
            toolCalls = aiResult.toolCalls || [];
            movieRefs = aiResult.movieRefs || [];
            steps = (aiResult.steps || []).map((s, i) => ({
                index: i + 1,
                tool: s.tool,
                label: TOOL_LABELS[s.tool] || s.tool || '执行操作',
                ok: s.ok !== false,
                summary: s.summary || ''
            }));
        }

        // 助手回复落库 + 记忆命中计数；压缩/提取后台单飞，绝不阻塞回复
        aiMemory.appendMessage(sessionId, 'assistant', reply);
        aiMemory.recordMemoryHits(chatCtx.injectedMemoryIds);
        setImmediate(() => {
            aiMemory.maybeCompress(sessionId).catch(() => {});
            aiMemory.maybeExtractMemories(sessionId).catch(() => {});
        });

        // 如果没有从ai-service获取到movieRefs，解析AI回答中的影片引用 [[ID|标题]]
        if (movieRefs.length === 0) {
            const refRegex = /\[\[(\d+)\|([^\]]+)\]\]/g;
            let match;
            const refIds = new Set();
            
            while ((match = refRegex.exec(reply)) !== null) {
                const movieId = parseInt(match[1]);
                if (!refIds.has(movieId)) {
                    refIds.add(movieId);
                    const movie = getMovieById.get(movieId);
                    if (movie) {
                        movie.tags = getMovieTags.all(movieId);
                        movie.actresses = getMovieActresses.all(movieId);
                        movieRefs.push({
                            id: movie.id,
                            title: movie.title || match[2],
                            avid: movie.avid,
                            posterPath: movie.posterPath,
                            tags: movie.tags ? movie.tags.slice(0, 5) : [],
                            actresses: movie.actresses ? movie.actresses.slice(0, 3) : [],
                            type: movie.type || 'jav'
                        });
                    }
                }
            }
        }
        
        res.json({
            code: 0,
            data: {
                reply,
                movieRefs,
                toolCalls,
                steps,
                context: aiMemory.getStatus(sessionId)
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== v3.0-c/d：Alife 式会话持久化与记忆引擎（白盒 API） ==========

// 历史恢复（前端打开 AI 抽屉/首页聊天框时拉取）
router.get('/history', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        const sessionId = aiMemory.normalizeSessionId(req.query.sessionId);
        res.json({
            code: 0,
            data: {
                messages: aiMemory.getHistory(sessionId, req.query.limit),
                stats: aiMemory.getStatus(sessionId),
                settings: aiMemory.getMemorySettings()
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 新对话：当前窗口全部折叠成分层摘要（可溯源不丢失），从零开始
router.post('/history/new-session', async (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        const sessionId = aiMemory.normalizeSessionId(req.body && req.body.sessionId);
        const r = await aiMemory.startNewSession(sessionId);
        if (!r.ok && r.reason === 'busy') return res.json({ code: -1, msg: '上一轮折叠还在进行，稍后再试' });
        res.json({ code: 0, msg: '已开启新对话，之前的内容已折叠进记忆', data: { stats: aiMemory.getStatus(sessionId), ...r } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 白盒状态：活动窗口 / 折叠消息 / L1、L2 摘要 / 记忆条数
router.get('/context-status', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        const sessionId = aiMemory.normalizeSessionId(req.query.sessionId);
        res.json({ code: 0, data: { stats: aiMemory.getStatus(sessionId), settings: aiMemory.getMemorySettings() } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 长期记忆 CRUD（用户自管记忆面板）
router.get('/memories', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        res.json({ code: 0, data: { memories: aiMemory.listMemories(), stats: aiMemory.getStatus(aiMemory.normalizeSessionId(req.query.sessionId)) } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/memories', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        const r = aiMemory.addMemory(req.body || {});
        res.json({ code: 0, msg: r.merged ? '已与相似记忆合并强化' : '记忆已添加', data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/memories/:id', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        aiMemory.updateMemory(req.params.id, req.body || {});
        res.json({ code: 0, msg: '记忆已更新' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.delete('/memories/:id', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        aiMemory.deleteMemory(req.params.id);
        res.json({ code: 0, msg: '记忆已删除' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 手动全库合并压缩（压缩长存）
router.post('/memories/compress', async (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        const r = await aiMemory.deepCompressMemories();
        res.json({ code: 0, msg: `整理完成：合并 ${r.merged} 组相似记忆`, data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 记忆引擎设置（enabled / liveTurns / autoCompress / autoMemory / memoryCap）
router.get('/memory-settings', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        res.json({ code: 0, data: aiMemory.getMemorySettings() });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== v4.0 Phase 2：Live2D 陪伴角色看板（对齐 Alife，dafeng_2 默认） ==========

const COMPANION_DEFAULT = { enabled: true, model: 'dafeng_2', scale: 1.0, modelsDir: '' };
const COMPANION_BUNDLED_DIR = path.join(__dirname, '../public/live2d/models');

function getCompanionConfig() {
    try {
        const cfg = readConfig();
        const c = (cfg.ai && cfg.ai.companion) || {};
        return {
            enabled: c.enabled !== false,
            model: String(c.model || COMPANION_DEFAULT.model).replace(/[^a-zA-Z0-9_-]/g, '') || COMPANION_DEFAULT.model,
            scale: Math.min(1.5, Math.max(0.5, parseFloat(c.scale) || COMPANION_DEFAULT.scale)),
            modelsDir: String(c.modelsDir || '').slice(0, 400)
        };
    } catch (e) {
        return { ...COMPANION_DEFAULT, modelsDir: '' };
    }
}

/** 扫描一个模型目录：一级子目录含 *.model3.json(Cubism4) 或 *.model.json(Cubism2) 即算模型 */
function scanModelsDir(dir, source) {
    const out = [];
    if (!dir || !fs.existsSync(dir)) return out;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    for (const name of names) {
        try {
            const sub = path.join(dir, name);
            if (!fs.statSync(sub).isDirectory()) continue;
            const files = fs.readdirSync(sub);
            const m3 = files.find(f => f.endsWith('.model3.json')) || files.find(f => f.endsWith('.model.json'));
            if (m3) out.push({
                id: name,
                file: m3,
                cubism: m3.endsWith('.model3.json') ? 4 : 2,
                source,
                urlBase: source === 'bundled' ? '/live2d/models/' + encodeURIComponent(name)
                    : '/api/ai/companion/external/' + encodeURIComponent(name)
            });
        } catch (e) { /* 单个目录坏了不拖垮整体 */ }
    }
    return out;
}

// 模型列表：内置目录 + 用户自定义目录（modelsDir）合并；同 ID 内置优先（内置带精修动作分组）
router.get('/companion/models', (req, res) => {
    try {
        const cfg = getCompanionConfig();
        const bundled = scanModelsDir(COMPANION_BUNDLED_DIR, 'bundled');
        const external = scanModelsDir(cfg.modelsDir, 'external')
            .filter(e => !bundled.some(b => b.id === e.id));
        res.json({ code: 0, data: { models: [...external, ...bundled], bundledDir: COMPANION_BUNDLED_DIR, externalDir: cfg.modelsDir, current: cfg } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 外部模型文件服务（模型在 public/ 之外，走带防目录穿越校验的动态静态路由）
router.get('/companion/external/:modelId/*', (req, res) => {
    try {
        const cfg = getCompanionConfig();
        if (!cfg.modelsDir) return res.status(404).json({ code: -1, msg: '未配置模型目录' });
        const modelId = String(req.params.modelId || '');
        if (!/^[^\\/]+$/.test(modelId) || modelId === '.' || modelId === '..') {
            return res.status(403).json({ code: -1, msg: '非法模型ID' });
        }
        const rel = String(req.params[0] || '');
        const base = path.resolve(cfg.modelsDir, modelId);
        const full = path.resolve(base, rel);
        if (!full.startsWith(base + path.sep) && full !== base) {
            return res.status(403).json({ code: -1, msg: '路径越界' });
        }
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
            return res.status(404).json({ code: -1, msg: '文件不存在' });
        }
        res.sendFile(full);
    } catch (e) {
        res.status(500).json({ code: -1, msg: e.message });
    }
});

// 一键打开模型目录（资源管理器）。与 routes/movie.js open-folder 同一纪律：
// 参数以静态前缀 '/e,' 起头（Explorer 打开目录的经典语法），动态部分只可能是
// resolve 后的绝对路径（盘符/UNC 开头，不可能以 - 起头被解析成选项）。
router.post('/companion/open-dir', (req, res) => {
    try {
        const { which } = req.body || {};
        const cfg = getCompanionConfig();
        const raw = which === 'external' && cfg.modelsDir ? cfg.modelsDir : COMPANION_BUNDLED_DIR;
        const abs = path.resolve(raw);
        if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            return res.json({ code: -1, msg: '目录不存在：' + abs });
        }
        spawn('explorer', ['/e,' + abs], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
        res.json({ code: 0, msg: '已打开：' + abs, data: { dir: abs } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.get('/companion/config', (req, res) => {
    try {
        res.json({ code: 0, data: getCompanionConfig() });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/companion/config', (req, res) => {
    try {
        const b = req.body || {};
        const cfg = readConfig();
        cfg.ai = cfg.ai || {};
        const prev = getCompanionConfig();
        let modelsDir = prev.modelsDir;
        if (b.modelsDir !== undefined) {
            modelsDir = String(b.modelsDir || '').trim().slice(0, 400);
        }
        cfg.ai.companion = {
            enabled: b.enabled !== undefined ? b.enabled !== false : prev.enabled,
            model: b.model ? String(b.model).replace(/[^a-zA-Z0-9_-]/g, '') : prev.model,
            scale: b.scale !== undefined ? Math.min(1.5, Math.max(0.5, parseFloat(b.scale) || 1)) : prev.scale,
            modelsDir
        };
        writeConfig(cfg);
        res.json({ code: 0, msg: '伴侣看板设置已保存', data: cfg.ai.companion });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/memory-settings', (req, res) => {
    try {
        const aiMemory = require('../utils/ai-memory');
        const b = req.body || {};
        const cfg = readConfig();
        cfg.ai = cfg.ai || {};
        cfg.ai.memory = {
            enabled: b.enabled !== false,
            liveTurns: parseInt(b.liveTurns) || 10,
            autoCompress: b.autoCompress !== false,
            autoMemory: b.autoMemory !== false,
            memoryCap: parseInt(b.memoryCap) || 100
        };
        writeConfig(cfg);
        res.json({ code: 0, msg: '记忆引擎设置已保存，下一条对话生效', data: cfg.ai.memory });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 批量翻译所有影片
router.post('/translate-all', async (req, res) => {
    try {
        res.json({ code: 0, msg: '批量翻译已启动' });
        
        // 后台执行
        (async () => {
            const movies = getAllMovies.all();
            const db = require('../utils/db').db;
            const updateStmt = db.prepare('UPDATE movies SET title = ?, overview = ? WHERE id = ?');
            
            for (const movie of movies) {
                try {
                    // 只翻译包含日文的
                    const hasJapanese = (movie.title && /[\u3040-\u309f\u30a0-\u30ff]/.test(movie.title)) ||
                                       (movie.overview && /[\u3040-\u309f\u30a0-\u30ff]/.test(movie.overview));
                    
                    if (!hasJapanese) continue;
                    
                    const result = await translateMovie(movie);
                    updateStmt.run(result.title, result.overview, movie.id);
                    console.log(`[AI翻译] ${movie.fileName}: 完成`);
                    
                    // 避免请求太快
                    await new Promise(r => setTimeout(r, 1000));
                } catch (e) {
                    console.log(`[AI翻译] ${movie.fileName}: 失败 - ${e.message}`);
                }
            }
        })();
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== AI 配置管理 ==========
// （fs / path 已在文件顶部引入）

const configPath = path.join(__dirname, '../config.json');

function readConfig() {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function writeConfig(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), 'utf8');
}

// ========== v3.0-a：AI 人格设定（预设 + 自定义 prompt，存 config.ai.persona）==========
const { AI_PERSONA_PRESETS } = require('../utils/ai-service');

router.get('/persona', (req, res) => {
    try {
        const cfg = readConfig();
        const persona = (cfg.ai && cfg.ai.persona) || {};
        res.json({
            code: 0,
            data: {
                presets: AI_PERSONA_PRESETS,
                current: {
                    presetId: persona.presetId || 'butler',
                    customPrompt: persona.customPrompt || ''
                }
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/persona', (req, res) => {
    try {
        const { presetId, customPrompt } = req.body || {};
        if (!AI_PERSONA_PRESETS.some(p => p.id === presetId)) {
            return res.json({ code: -1, msg: '未知的人格预设' });
        }
        const cfg = readConfig();
        if (!cfg.ai) cfg.ai = {};
        cfg.ai.persona = {
            presetId,
            customPrompt: presetId === 'custom'
                ? String(customPrompt || '').trim().slice(0, 2000)
                : ''
        };
        writeConfig(cfg);
        res.json({ code: 0, msg: '人格设定已保存，下一条对话生效', data: cfg.ai.persona });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== r60：AI 模型路由（多路由保存 / 随时切换 / 失败自动容灾）==========
// 存 config.ai.routes（有序）+ config.ai.activeRouteId；调用侧（utils/ai-service.js callAI）
// 当前路由优先，失败按顺序切下一条启用路由。apiKey 用 *** 尾4位掩码传输，保存时回填原值。
function maskRouteKey(k) { return k ? '***' + String(k).slice(-4) : ''; }

router.get('/routes', (req, res) => {
    try {
        const cfg = readConfig();
        const ai = cfg.ai || {};
        let routes = Array.isArray(ai.routes) ? ai.routes : [];
        let derived = false;
        if (!routes.length) {
            // 旧版单配置 → 派生一条展示（保存时才固化成 routes）
            const provider = ai.provider || 'ollama';
            const pc = provider === 'ollama' ? (ai.ollama || {}) : (ai[provider] || {});
            routes = [{
                id: 'legacy', name: provider === 'ollama' ? 'Ollama' : provider, provider,
                baseUrl: pc.baseUrl || '', apiKey: pc.apiKey || '', model: pc.model || '',
                session: pc.session || '', enabled: true
            }];
            derived = true;
        }
        res.json({
            code: 0,
            data: {
                routes: routes.map(r => ({ ...r, apiKey: maskRouteKey(r.apiKey), apiKeySet: !!r.apiKey })),
                activeId: ai.activeRouteId || (routes[0] && routes[0].id) || 'legacy',
                derived
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/routes', (req, res) => {
    try {
        const { routes, activeId } = req.body || {};
        if (!Array.isArray(routes) || !routes.length) return res.json({ code: -1, msg: '路由列表不能为空' });
        if (routes.length > 20) return res.json({ code: -1, msg: '最多 20 条路由' });

        const cfg = readConfig();
        const old = Array.isArray(cfg.ai && cfg.ai.routes) ? cfg.ai.routes : [];
        const oldById = new Map(old.map(r => [r.id, r]));
        const seen = new Set();

        const clean = routes.map((r, i) => {
            let id = String(r.id || '').trim() || ('route-' + Date.now() + '-' + i);
            while (seen.has(id)) id = id + '-' + i;      // 同请求内去重
            seen.add(id);
            const prev = oldById.get(id) || {};
            // 掩码回填：前端传回 "***xxxx" 或空 → 沿用库里原 key；传了明文 → 用新值
            let apiKey = String(r.apiKey || '').trim();
            if (!apiKey || apiKey.startsWith('***')) apiKey = prev.apiKey || '';
            return {
                id,
                name: String(r.name || ('路由' + (i + 1))).trim().slice(0, 40),
                provider: ['ollama', 'openai', 'deepseek', 'custom'].includes(r.provider) ? r.provider : 'custom',
                baseUrl: String(r.baseUrl || '').trim().slice(0, 300),
                apiKey: apiKey.slice(0, 400),
                model: String(r.model || '').trim().slice(0, 120),
                session: String(r.session || '').trim().slice(0, 200),
                enabled: r.enabled !== false
            };
        });

        cfg.ai = cfg.ai || {};
        cfg.ai.routes = clean;
        cfg.ai.activeRouteId = clean.some(r => r.id === activeId) ? activeId : clean[0].id;
        writeConfig(cfg);
        res.json({
            code: 0,
            msg: '路由已保存，立即生效',
            data: {
                routes: clean.map(r => ({ ...r, apiKey: maskRouteKey(r.apiKey), apiKeySet: !!r.apiKey })),
                activeId: cfg.ai.activeRouteId
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取AI配置（隐藏API Key）
router.get('/config', (req, res) => {
    try {
        const cfg = readConfig();
        const aiConfig = cfg.ai || {};
        
        // 隐藏API Key，只显示是否已配置
        const safeConfig = {
            provider: aiConfig.provider || 'ollama',
            enableAgent: aiConfig.enableAgent !== false,
            providers: {}
        };
        
        for (const [key, value] of Object.entries(aiConfig)) {
            if (key === 'provider' || key === 'enableAgent' || key === 'agentSystemPrompt') continue;
            safeConfig.providers[key] = {
                ...value,
                apiKey: value.apiKey ? '***' + value.apiKey.slice(-4) : '',
                apiKeyConfigured: !!value.apiKey
            };
        }
        
        res.json({ code: 0, data: safeConfig });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 保存AI配置
router.post('/config', (req, res) => {
    try {
        const { provider, providerConfig, enableAgent } = req.body;
        const cfg = readConfig();
        
        if (!cfg.ai) cfg.ai = {};
        
        if (provider) {
            cfg.ai.provider = provider;
        }
        
        if (providerConfig && provider) {
            if (!cfg.ai[provider]) cfg.ai[provider] = {};
            // 只更新非空字段，API Key特殊处理
            for (const [key, value] of Object.entries(providerConfig)) {
                if (key === 'apiKey') {
                    // 如果是占位符（***开头），不更新
                    if (value && !value.startsWith('***')) {
                        cfg.ai[provider].apiKey = value;
                    }
                } else if (value !== undefined && value !== null) {
                    cfg.ai[provider][key] = value;
                }
            }
        }
        
        if (enableAgent !== undefined) {
            cfg.ai.enableAgent = enableAgent;
        }
        
        writeConfig(cfg);
        res.json({ code: 0, msg: 'AI配置保存成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 测试API Key
router.post('/test-api-key', async (req, res) => {
    try {
        const { provider, apiKey, baseUrl, model } = req.body;
        const { testApiKey } = require('../utils/ai-service');
        const result = await testApiKey(provider, apiKey, baseUrl, model);
        res.json({ code: result.success ? 0 : -1, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取可用模型列表
router.get('/models', async (req, res) => {
    try {
        const { provider, apiKey, baseUrl } = req.query;
        const { getAvailableModels } = require('../utils/ai-service');
        const result = await getAvailableModels(provider, apiKey, baseUrl);
        res.json({ code: result.success ? 0 : -1, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// ========== Agent 工具执行 ==========

// r61：工具中文名（前端任务分解步骤条展示用）
const TOOL_LABELS = {
    search_movies: '搜索影片',
    get_movie_detail: '查看影片详情',
    play_movie: '准备播放',
    switch_module: '切换模块',
    get_random_movies: '随机抽片',
    get_statistics: '清点库存',
    get_task_status: '查看后台任务',
    add_tags: '智能打标签',
    translate_movie: '翻译影片信息',
    rename_movie: '重命名',
    scrape_poster: '重刮海报',
    fix_movie_cover: '补缺封面',
    smart_rescrape: '智能刮削',
    open_folder: '打开文件夹',
    get_actress_list: '查女优列表',
    get_tag_list: '查标签列表',
    get_recommendations: '生成推荐',
    read_project_file: '读项目文件'
};

// r61：执行单个 Agent 工具（/execute-tool 接口与 /chat 的 agent 循环共用同一实现）
async function runAgentTool(toolName, toolArgs) {
    const { getAllMovies, getMovieById, getMovieTags, getMovieActresses } = require('../utils/db');

    let result = {};

    switch (toolName) {
            case 'search_movies': {
                const { keyword, type = 'all', limit = 10 } = toolArgs;
                let movies = getAllMovies.all();
                if (type !== 'all') {
                    movies = movies.filter(m => (m.type || 'jav') === type);
                }
                if (keyword) {
                    const kw = keyword.toLowerCase();
                    movies = movies.filter(m => 
                        (m.title && m.title.toLowerCase().includes(kw)) ||
                        (m.avid && m.avid.toLowerCase().includes(kw)) ||
                        (m.fileName && m.fileName.toLowerCase().includes(kw))
                    );
                }
                result = movies.slice(0, limit).map(m => ({
                    id: m.id,
                    title: m.title,
                    avid: m.avid,
                    type: m.type || 'jav',
                    poster: m.posterPath
                }));
                break;
            }
            
            case 'get_movie_detail': {
                const { movie_id } = toolArgs;
                const movie = getMovieById.get(movie_id);
                if (movie) {
                    movie.tags = getMovieTags.all(movie_id);
                    movie.actresses = getMovieActresses.all(movie_id);
                    result = movie;
                }
                break;
            }
            
            case 'play_movie': {
                const { movie_id } = toolArgs;
                result = { action: 'play_movie', movie_id, message: '正在准备播放...' };
                break;
            }
            
            case 'switch_module': {
                const { module } = toolArgs;
                result = { action: 'switch_module', module, message: `正在切换到${module}模块...` };
                break;
            }
            
            case 'get_random_movies': {
                const { type = 'all', limit = 6 } = toolArgs;
                let movies = getAllMovies.all();
                if (type !== 'all') {
                    movies = movies.filter(m => (m.type || 'jav') === type);
                }
                for (let i = movies.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [movies[i], movies[j]] = [movies[j], movies[i]];
                }
                result = movies.slice(0, limit).map(m => ({
                    id: m.id,
                    title: m.title,
                    avid: m.avid,
                    type: m.type || 'jav',
                    poster: m.posterPath
                }));
                break;
            }
            
            case 'get_statistics': {
                const movies = getAllMovies.all();
                result = {
                    totalMovies: movies.length,
                    javMovies: movies.filter(m => (m.type || 'jav') === 'jav').length,
                    animeMovies: movies.filter(m => m.type === 'anime').length,
                    comicMovies: movies.filter(m => m.type === 'comic').length,
                    novelMovies: movies.filter(m => m.type === 'novel').length
                };
                break;
            }
            
            case 'get_task_status': {
                const ts = require('../utils/task-status');
                const onlyActive = !!(toolArgs && toolArgs.active_only);
                const list = ts.allTasks({ onlyActive });
                result = {
                    runningCount: list.filter(t => t.running).length,
                    summary: ts.describeTasks(),
                    tasks: list.map(t => ({
                        key: t.key,
                        name: t.name,
                        status: t.running ? '进行中' : '已完成',
                        progress: t.total ? (t.current + '/' + t.total + '（' + t.percent + '%）') : '-',
                        ok: t.ok,
                        fail: t.fail,
                        detail: t.detail || ''
                    }))
                };
                break;
            }
            
            case 'add_tags': {
                const { movie_id } = toolArgs;
                const movie = getMovieById.get(movie_id);
                if (movie) {
                    movie.tags = getMovieTags.all(movie_id);
                    movie.actresses = getMovieActresses.all(movie_id);
                    const { generateTags } = require('../utils/ai-service');
                    const { updateMovieRelations } = require('../utils/db');
                    const tagsResult = await generateTags(movie);
                    updateMovieRelations(movie_id, { tags: tagsResult.tags, actresses: tagsResult.actresses });
                    result = { success: true, tags: tagsResult.tags, actresses: tagsResult.actresses };
                }
                break;
            }
            
            case 'translate_movie': {
                const { movie_id } = toolArgs;
                const movie = getMovieById.get(movie_id);
                if (movie) {
                    const { translateMovie } = require('../utils/ai-service');
                    const transResult = await translateMovie(movie);
                    const db = require('../utils/db').db;
                    const updateStmt = db.prepare('UPDATE movies SET title = ?, overview = ? WHERE id = ?');
                    updateStmt.run(transResult.title, transResult.overview, movie.id);
                    result = { success: true, ...transResult };
                }
                break;
            }
            
            case 'rename_movie': {
                const { movie_id } = toolArgs;
                result = { action: 'rename_movie', movie_id, requireConfirm: true, message: '需要用户确认后执行重命名' };
                break;
            }
            
            case 'scrape_poster': {
                const { movie_id } = toolArgs;
                result = { action: 'scrape_poster', movie_id, requireConfirm: true, message: '需要用户确认后重新刮削海报' };
                break;
            }

            /* 漫画 / 小说封面兜底（2026-09-22）
               链路：在线搜（漫画 kmoe / 小说 zlibrary）→ 内容截图（PDF 第 1 页 / EPUB 内封面图）
               只补「本来没有封面」的条目，不会覆盖已有封面。 */
            case 'fix_movie_cover': {
                const { movie_id, keyword, limit = 10 } = toolArgs;
                const { autoCover } = require('../utils/cover-fallback');
                const db = require('../utils/db').db;

                if (movie_id) {
                    const r = await autoCover(db, movie_id, { searchFirst: true, log: () => { } });
                    result = Object.assign({ action: 'fix_movie_cover', movie_id }, r);
                    break;
                }

                let rows = db.prepare(
                    "SELECT id, title, fileName, type FROM movies " +
                    "WHERE type IN ('comic','novel') AND (posterPath IS NULL OR posterPath = '') ORDER BY id"
                ).all();
                if (keyword) {
                    const kw = String(keyword).toLowerCase();
                    rows = rows.filter(m =>
                        (m.title || '').toLowerCase().includes(kw) ||
                        (m.fileName || '').toLowerCase().includes(kw));
                }
                if (!rows.length) {
                    result = { action: 'fix_movie_cover', fixed: 0, message: '库里没有缺封面的漫画/小说' };
                    break;
                }
                const picked = rows.slice(0, Math.min(limit, 20));
                let ok = 0, fail = 0, lastErr = '';
                for (const m of picked) {
                    const r = await autoCover(db, m.id, { searchFirst: true, log: () => { } })
                        .catch(e => ({ ok: false, error: e.message }));
                    if (r.ok) ok++; else { fail++; lastErr = r.error || lastErr; }
                }
                const rest = rows.length - picked.length;
                result = {
                    action: 'fix_movie_cover', fixed: ok, failed: fail,
                    remaining: rest, lastError: lastErr || undefined,
                    message: `试着给 ${picked.length} 部补封面，成功 ${ok} 部` +
                        (fail ? `，失败 ${fail} 部` : '') +
                        (rest > 0 ? `（库里还有 ${rest} 部，再说一次就继续补）` : ''),
                };
                break;
            }

            case 'smart_rescrape': {
                const { target = 'frame_capture', movie_id, source = 'highest_confidence', limit = 10, mode = 'merge' } = toolArgs;
                const db = require('../utils/db').db;
                const { processSingleFile } = require('../utils/scanner');
                const path = require('path');
                const fs = require('fs');

                let candidates = [];

                if (target === 'single' && movie_id) {
                    const row = db.prepare('SELECT id, title, fileName, avid, filePath, type, posterPath FROM movies WHERE id = ?').get(movie_id);
                    if (row) candidates = [row];
                } else if (target === 'frame_capture') {
                    // 查询使用插帧截图或临时本地封面的影片
                    candidates = db.prepare(
                        "SELECT id, title, fileName, avid, filePath, type, posterPath FROM movies " +
                        "WHERE (source IN ('thumb','local') OR posterPath LIKE '%_thumb%' OR posterPath LIKE 'capture%' OR localPosterPath LIKE '%thumb%') " +
                        "AND type IN ('jav','anime','film','cartoon') ORDER BY id DESC LIMIT ?"
                    ).all(Math.min(limit, 30));
                } else if (target === 'duplicate') {
                    // 查找封面哈希重复/碰撞的影片
                    const config = require('../config');
                    const crypto = require('crypto');
                    const hashGroups = {};
                    const rows = db.prepare("SELECT id, title, fileName, avid, filePath, type, localPosterPath FROM movies WHERE localPosterPath IS NOT NULL").all();
                    for (const r of rows) {
                        try {
                            const full = path.join(config.posterCacheDir, path.basename(r.localPosterPath));
                            if (fs.existsSync(full)) {
                                const buf = fs.readFileSync(full);
                                const h = crypto.createHash('md5').update(buf).digest('hex');
                                if (!hashGroups[h]) hashGroups[h] = [];
                                hashGroups[h].push(r);
                            }
                        } catch (e) {}
                    }
                    for (const h of Object.keys(hashGroups)) {
                        if (hashGroups[h].length > 1) {
                            candidates.push(...hashGroups[h]);
                        }
                    }
                    candidates = candidates.slice(0, Math.min(limit, 30));
                } else if (target === 'missing') {
                    // 查找完全缺失海报的影片
                    candidates = db.prepare(
                        "SELECT id, title, fileName, avid, filePath, type, posterPath FROM movies " +
                        "WHERE (posterPath IS NULL OR posterPath = '' OR localPosterPath IS NULL) " +
                        "ORDER BY id DESC LIMIT ?"
                    ).all(Math.min(limit, 30));
                }

                if (!candidates.length) {
                    result = {
                        action: 'smart_rescrape',
                        target,
                        processed: 0,
                        message: `未找到符合【${target}】条件的待刮削影片，库中该类封面状态健康。`
                    };
                    break;
                }

                let successCount = 0;
                let failCount = 0;
                const updatedList = [];

                for (const m of candidates) {
                    try {
                        await processSingleFile(m.filePath, m.type || 'jav', { forceWeb: true, mergeMode: mode });
                        const updated = db.prepare('SELECT id, title, avid, posterPath, type FROM movies WHERE id = ?').get(m.id);
                        if (updated && updated.posterPath) {
                            successCount++;
                            updatedList.push(updated);
                        } else {
                            failCount++;
                        }
                    } catch (err) {
                        failCount++;
                    }
                }

                const targetDesc = {
                    frame_capture: '插帧截图转正',
                    duplicate: '封面碰撞重优选',
                    missing: '缺失封面补全',
                    single: '单部重新刮削'
                }[target] || target;

                result = {
                    action: 'smart_rescrape',
                    target,
                    processed: candidates.length,
                    successCount,
                    failCount,
                    movies: updatedList,
                    message: `✅ 已执行【${targetDesc}】：共检索到 ${candidates.length} 部影片，成功重新刮削与换源 ${successCount} 部` +
                             (failCount > 0 ? `，失败 ${failCount} 部。` : '，全部完成！')
                };
                break;
            }

            case 'open_folder': {
                const { movie_id } = toolArgs;
                result = { action: 'open_folder', movie_id, message: '正在打开文件夹...' };
                break;
            }
            
            case 'get_actress_list': {
                const { keyword, limit = 20 } = toolArgs;
                const { getAllActresses } = require('../utils/db');
                let actresses = getAllActresses.all();
                if (keyword) {
                    const kw = keyword.toLowerCase();
                    actresses = actresses.filter(a => a.name && a.name.toLowerCase().includes(kw));
                }
                result = actresses.slice(0, limit).map(a => ({
                    id: a.id,
                    name: a.name,
                    movieCount: a.movieCount || 0,
                    followed: a.followed === 1
                }));
                break;
            }
            
            case 'get_tag_list': {
                const { keyword, limit = 20 } = toolArgs;
                const { getAllTags } = require('../utils/db');
                let tags = getAllTags.all();
                if (keyword) {
                    const kw = keyword.toLowerCase();
                    tags = tags.filter(t => t.name && t.name.toLowerCase().includes(kw));
                }
                result = tags.slice(0, limit).map(t => ({
                    id: t.id,
                    name: t.name,
                    movieCount: t.movieCount || 0
                }));
                break;
            }
            
            case 'get_recommendations': {
                const { limit = 6 } = toolArgs;
                try {
                    const { getWatchHistory, getSearchHistory } = require('../utils/db');
                    const watchHistory = getWatchHistory ? getWatchHistory.all(50) : [];
                    const searchHistory = getSearchHistory ? getSearchHistory.all(20) : [];
                    const allMovies = getAllMovies.all();
                    const { recommendMovies } = require('../utils/ai-service');
                    const recommended = await recommendMovies(watchHistory, allMovies, limit, searchHistory.map(s => s.keyword));
                    result = recommended.map(m => ({
                        id: m.id,
                        title: m.title,
                        avid: m.avid,
                        type: m.type || 'jav',
                        poster: m.posterPath
                    }));
                } catch (e) {
                    // 降级：随机推荐
                    let movies = getAllMovies.all();
                    for (let i = movies.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [movies[i], movies[j]] = [movies[j], movies[i]];
                    }
                    result = movies.slice(0, limit).map(m => ({
                        id: m.id,
                        title: m.title,
                        avid: m.avid,
                        type: m.type || 'jav',
                        poster: m.posterPath
                    }));
                }
                break;
            }
            
            case 'read_project_file': {
                const { file_path } = toolArgs;
                const fs = require('fs');
                const path = require('path');
                const projectRoot = path.join(__dirname, '..');
                const fullPath = path.join(projectRoot, file_path);
                // 安全检查：只允许读取项目目录内的文件
                if (!fullPath.startsWith(projectRoot)) {
                    result = { error: '不允许读取项目目录外的文件' };
                    break;
                }
                try {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    result = { 
                        file_path, 
                        content: content.substring(0, 10000), // 限制10000字符
                        truncated: content.length > 10000,
                        totalLength: content.length
                    };
                } catch (e) {
                    result = { error: `读取文件失败: ${e.message}` };
                }
                break;
            }
            
            default:
                result = { error: `未知工具: ${toolName}` };
        }

        return result;
}

// 执行Agent工具调用（HTTP 白盒接口，前端 AI 抽屉旧链路仍可用）
router.post('/execute-tool', async (req, res) => {
    try {
        const { toolName, arguments: toolArgs } = req.body;
        const result = await runAgentTool(toolName, toolArgs || {});
        res.json({ code: 0, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
