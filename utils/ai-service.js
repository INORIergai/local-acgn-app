/**
 * AI 服务
 * 支持 Ollama 本地模型、DeepSeek、OpenAI 兼容 API
 * 支持 Agent 工具调用
 */

const config = require('./config');
const ollamaConfig = config.ollama || {};
const aiConfig = config.ai || {};

// 用于生成标签时读取全量女优候选池（每次调用实时查库，保持数据最新）
const { getAllActresses } = require('./db');

/**
 * 获取当前AI提供商配置
 */
function getAIConfig() {
  const provider = aiConfig.provider || 'ollama';
  const providerConfig = aiConfig[provider] || {};
  return { provider, ...providerConfig };
}

/**
 * opencode.ai/zen 免费网关要求请求携带 x-opencode-session 头做路由，
 * 否则报 MissingSessionID。从 ai.opencode.session（或 ai.openai.session）读取。
 */
function getOpencodeSession() {
  return aiConfig.opencode?.session || aiConfig.openai?.session || '';
}

function isOpencodeHost(baseUrl) {
  return String(baseUrl || '').includes('opencode.ai');
}

/**
 * 构造 OpenAI 兼容请求头，按需附加 x-opencode-session
 */
function buildAIHeaders(baseUrl, apiKey) {
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  if (isOpencodeHost(baseUrl)) {
    const session = getOpencodeSession();
    if (session) headers['x-opencode-session'] = session;
  }
  return headers;
}

/**
 * 统一AI调用入口
 * 根据配置的provider选择调用方式
 * @param {string} prompt 用户提示词
 * @param {string} systemPrompt 系统提示词
 * @param {Array} tools 可用工具列表（用于Agent模式）
 * @returns {Promise<string|object>} 返回文本或工具调用结果
 */
async function callAI(prompt, systemPrompt = '', tools = null) {
  const { provider, baseUrl, apiKey, model } = getAIConfig();
  
  if (provider === 'ollama') {
    return await callOllama(prompt, systemPrompt);
  } else {
    return await callOpenAICompatible(provider, baseUrl, apiKey, model, prompt, systemPrompt, tools);
  }
}

/**
 * 调用 OpenAI 兼容 API（DeepSeek、OpenAI、自定义）
 */
async function callOpenAICompatible(provider, baseUrl, apiKey, model, prompt, systemPrompt = '', tools = null) {
  if (!apiKey) {
    throw new Error(`${provider} API Key 未配置，请在设置中填写`);
  }
  
  if (!baseUrl) {
    throw new Error(`${provider} API Base URL 未配置`);
  }
  
  if (!model) {
    throw new Error(`${provider} 模型未选择`);
  }
  
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    
    const body = {
      model,
      messages,
      stream: false
    };
    
    // 如果有工具，添加工具定义
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 120秒超时
    
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildAIHeaders(baseUrl, apiKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      const errorText = await res.text();
      if (isOpencodeHost(baseUrl) && (errorText.includes('MissingSessionID') || errorText.includes('x-opencode-session'))) {
        throw new Error('opencode.ai 网关需要会话 ID：请在设置页 AI 配置里填写 opencode session（从 opencode.ai 获取），或改用本地 Ollama');
      }
      throw new Error(`HTTP ${res.status}: ${errorText.substring(0, 300)}`);
    }
    
    const data = await res.json();
    const choice = data.choices?.[0];
    
    // 如果有工具调用，返回工具调用结果
    if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
      return {
        type: 'tool_calls',
        toolCalls: choice.message.tool_calls,
        content: choice.message.content || ''
      };
    }
    
    return choice?.message?.content || '';
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('AI响应超时（120秒）');
    }
    throw new Error(`${provider}调用失败: ${e.message}`);
  }
}

/**
 * 调用 Ollama API（使用内置fetch，Node 18+支持）
 */
async function callOllama(prompt, systemPrompt = '') {
  if (!ollamaConfig.enableTranslate && !aiConfig.provider) {
    throw new Error('AI功能未启用，请在设置中开启');
  }
  
  const baseUrl = ollamaConfig.baseUrl || 'http://127.0.0.1:11434';
  const model = ollamaConfig.model || 'qwen2.5:3b';
  
  try {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60秒超时
    
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    
    const data = await res.json();
    return data.message?.content || '';
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('AI响应超时（60秒）');
    }
    throw new Error(`Ollama调用失败: ${e.message}`);
  }
}

/**
 * 获取可用模型列表
 * @param {string} provider 提供商，不传则使用当前配置
 * @param {string} apiKey API Key
 * @param {string} baseUrl API基础URL
 */
async function getAvailableModels(provider = null, apiKey = null, baseUrl = null) {
  const targetProvider = provider || aiConfig.provider || 'ollama';
  const providerConfig = aiConfig[targetProvider] || {};
  
  const targetApiKey = apiKey || providerConfig.apiKey || '';
  const targetBaseUrl = baseUrl || providerConfig.baseUrl || '';
  
  if (targetProvider === 'ollama') {
    try {
      const ollamaBaseUrl = ollamaConfig.baseUrl || 'http://127.0.0.1:11434';
      const res = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return {
        success: true,
        models: (data.models || []).map(m => ({
          id: m.name,
          name: m.name,
          size: m.size
        }))
      };
    } catch (e) {
      return { success: false, error: e.message, models: [] };
    }
  } else {
    // OpenAI兼容API获取模型列表
    if (!targetApiKey) {
      return { success: false, error: 'API Key 未配置', models: [] };
    }
    if (!targetBaseUrl) {
      return { success: false, error: 'API Base URL 未配置', models: [] };
    }
    
    try {
      const res = await fetch(`${targetBaseUrl}/models`, {
        method: 'GET',
        headers: buildAIHeaders(targetBaseUrl, targetApiKey),
        signal: AbortSignal.timeout(15000)
      });
      
      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}: ${await res.text()}`, models: [] };
      }
      
      const data = await res.json();
      return {
        success: true,
        models: (data.data || []).map(m => ({
          id: m.id,
          name: m.id
        }))
      };
    } catch (e) {
      return { success: false, error: e.message, models: [] };
    }
  }
}

/**
 * 测试API Key是否有效
 */
async function testApiKey(provider, apiKey, baseUrl, model = null) {
  try {
    if (provider === 'ollama') {
      const result = await getAvailableModels('ollama');
      return {
        success: result.success,
        message: result.success ? 'Ollama 连接成功' : '连接失败: ' + result.error,
        models: result.models
      };
    }
    
    if (!apiKey) return { success: false, message: 'API Key 不能为空' };
    if (!baseUrl) return { success: false, message: 'API Base URL 不能为空' };

    // 先尝试获取模型列表（仅供参考）
    const modelsResult = await getAvailableModels(provider, apiKey, baseUrl);
    const models = modelsResult.models || [];

    // 【修复】连接测试必须真正发一次聊天请求，否则像 opencode.ai/zen 这种
    // “模型列表可访问、但聊天需要 x-opencode-session”的网关会假通过，
    // 实际提问才报 MissingSessionID。始终以聊天结果为准。
    try {
      const testModel = model || models[0]?.id || 'gpt-4o-mini';
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildAIHeaders(baseUrl, apiKey),
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
          stream: false
        }),
        signal: AbortSignal.timeout(20000)
      });

      if (res.ok) {
        return { success: true, message: 'API Key 验证成功', models };
      } else {
        const body = await res.text();
        // opencode.ai 缺 session 时给出明确提示
        if (body.includes('MissingSessionID') || body.includes('x-opencode-session')) {
          return {
            success: false,
            message: 'opencode.ai 网关需要会话 ID：请在 AI 设置里填 ai.opencode.session（从 opencode.ai 获取），或改用本地 Ollama'
          };
        }
        return { success: false, message: `验证失败: HTTP ${res.status} - ${body.substring(0, 300)}` };
      }
    } catch (e) {
      return { success: false, message: '验证失败: ' + e.message };
    }
  } catch (e) {
    return { success: false, message: '测试失败: ' + e.message };
  }
}

/**
 * AI 翻译
 */
async function translateText(text, targetLang = 'zh') {
  const systemPrompt = '你是一个专业的翻译官，擅长将日文翻译为中文。请直接输出翻译结果，不要添加任何解释。';
  const prompt = `请将以下日文翻译为中文：\n\n${text}`;
  return await callAI(prompt, systemPrompt);
}

/**
 * AI 翻译影片信息
 */
async function translateMovie(movie) {
  const result = {
    title: movie.title,
    overview: movie.overview
  };
  
  if (movie.title && /[\u3040-\u309f\u30a0-\u30ff]/.test(movie.title)) {
    try {
      result.title = await translateText(movie.title);
    } catch (e) {
      console.log(`翻译标题失败: ${e.message}`);
    }
  }
  
  if (movie.overview && /[\u3040-\u309f\u30a0-\u30ff]/.test(movie.overview)) {
    try {
      result.overview = await translateText(movie.overview);
    } catch (e) {
      console.log(`翻译简介失败: ${e.message}`);
    }
  }
  
  return result;
}

/**
 * AI 生成智能标签
 * 返回 { tags: [], actresses: [] }
 */
/**
 * 从文件名/标题中提取女优名
 * 支持格式：【番号】片名 - 女优名、番号 片名 - 女优名、片名 - 女优名
 */
function extractActressFromFilename(movie) {
  const actresses = [];
  const candidates = [movie.title, movie.fileName].filter(Boolean);
  
  for (const text of candidates) {
    if (!text || !text.includes(' - ')) continue;
    
    const parts = text.split(' - ');
    let name = parts[parts.length - 1].trim();
    
    // 去掉扩展名
    name = name.replace(/\.(mp4|mkv|avi|wmv|mov|flv|rmvb|ts|m4v)$/i, '').trim();
    // 去掉括号内容
    name = name.replace(/[（(].*?[)）]/g, '').trim();
    // 去掉特殊字符，只保留中日英文和数字
    name = name.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').trim();
    
    // 过滤条件：2-20个字符，不是纯数字
    if (name.length >= 2 && name.length <= 20 && !/^\d+$/.test(name)) {
      // 支持多个女优（用逗号、顿号、&分隔）
      const names = name.split(/[,，、&＆]/).map(n => n.trim()).filter(n => n.length >= 2);
      for (const n of names) {
        if (!actresses.includes(n)) actresses.push(n);
      }
      if (actresses.length > 0) break;
    }
  }
  
  return actresses;
}

/**
 * 只生成题材标签（不识别女优，女优已从文件名提取）
 */
async function generateGenreTagsOnly(movie) {
  const systemPrompt = '你是一个影片标签专家，只负责生成精准的题材索引标签。请严格按格式输出，不要任何解释。';
  
  const prompt = `
请根据以下影片信息生成2-3个精准的题材索引标签。

影片信息：
- 片名：${movie.title || ''}
- 番号：${movie.avid || ''}
- 片商：${movie.producer || ''}
- 系列：${movie.serial || ''}
- 简介：${(movie.overview || '').substring(0, 200)}

什么是"精准索引标签"：用户可以在标签库里点击这个标签，就能筛选出同类型影片。因此标签必须是【有区分度的题材/属性词】。

✅ 好标签例子：巨乳、人妻、OL、学生、制服、痴汉、催眠、NTR、姐妹、教师、护士、女仆、黑丝、眼镜、短发、混血、萝莉、熟女、处男、逆搭讪、中出、潮吹、口交、足交、SM、捆绑、凌辱、剧情、单体、企划、VR、4K

❌ 坏标签例子（禁止输出）：美女、性感、好看、精彩、刺激、诱惑、迷人、漂亮、可爱、身材好、皮肤白、声音好听、演技好、高质量、推荐、必看、经典、神作、佳作、上品、淫乱、放荡、激情

规则：
1. 只输出 2-3 个标签，宁缺毋滥。
2. 严格只输出下面一行，不要任何解释：

标签：标签1, 标签2, 标签3
  `.trim();

  try {
    const result = await callAI(prompt, systemPrompt);
    const match = result.match(/标签[：:]\s*(.+)/);
    if (match) {
      return match[1].split(/[,，、;；]/)
        .map(t => t.trim())
        .filter(t => t.length > 1 && t.length < 20)
        .slice(0, 3);
    }
  } catch (e) {
    console.warn('[AI标签] 生成题材标签失败:', e.message);
  }
  return [];
}

async function generateTags(movie) {
  // ========== 女优名优先从文件名提取 ==========
  const extractedActresses = extractActressFromFilename(movie);
  
  // 如果从文件名提取到了女优名，直接使用（不依赖AI识别女优）
  if (extractedActresses.length > 0) {
    console.log(`[AI标签] 从文件名提取女优: ${extractedActresses.join(', ')}`);
    // 只让AI生成题材标签
    const genreTags = await generateGenreTagsOnly(movie);
    return {
      tags: genreTags,
      actresses: extractedActresses
    };
  }

  const systemPrompt = '你是一个专业的成人影片分类专家，核心任务是【准确识别女优姓名】和【生成高区分度的精准索引标签】。女优识别优先级最高，标签宁缺毋滥。请严格按格式输出，不要任何解释。';

  // 每次调用实时查库，获取全量女优候选池（保持数据最新，不写死）
  let candidateNames = [];
  try {
    candidateNames = getAllActresses.all().map(a => a.name).filter(Boolean);
  } catch (e) {
    console.warn('[AI标签] 获取女优候选池失败:', e.message);
  }

  // 从片名/简介中提取可能的女优名（辅助AI匹配）
  const textForMatch = `${movie.title || ''} ${movie.overview || ''}`;
  const matchedCandidates = candidateNames.filter(name => textForMatch.includes(name));

  const candidateList = candidateNames.length > 0
    ? candidateNames.join('、')
    : '（候选池为空）';

  const prompt = `
请分析以下影片信息，完成两个任务：【任务1：识别女优】【任务2：生成精准标签】

影片信息：
- 片名：${movie.title || ''}
- 番号：${movie.avid || ''}
- 片商：${movie.producer || ''}
- 系列：${movie.serial || ''}
- 简介：${(movie.overview || '').substring(0, 300)}
- 已有标签：${movie.tags ? movie.tags.map(t => t.name).join(', ') : '无'}

===== 任务1：识别女优（最高优先级，必须全部列出）=====
规则：
1. 从片名、番号、简介中识别所有出演的女优，一个都不能遗漏。
2. 优先从下方候选名单中匹配；如果片名/简介里明确出现了候选名单外的真实女优名，也请如实输出（不要吞掉）。
3. 如果是动漫/漫画/小说/无码素人等无法识别具体女优的情况，演员行输出"演员：未知"。
4. 女优名必须是真实姓名，不要输出"女主"、"女演员"、"美女"这种通用词。

【已从文本中匹配到的候选女优】（请确认并补充遗漏）：${matchedCandidates.length > 0 ? matchedCandidates.join('、') : '无'}

===== 任务2：生成精准索引标签（2-3个，宁缺毋滥）=====
什么是"精准索引标签"：用户可以在标签库里点击这个标签，就能筛选出同类型影片。因此标签必须是【有区分度的题材/属性词】，而不是泛泛的形容词。

✅ 好标签例子（可索引、有区分度）：
   巨乳、人妻、OL、学生、制服、痴汉、催眠、NTR、姐妹、母女、教师、护士、女仆、黑丝、眼镜、短发、混血、萝莉、熟女、处男、逆搭讪、中出、潮吹、口交、足交、SM、捆绑、凌辱、剧情、单体、企划、VR、4K

❌ 坏标签例子（太泛、无区分度、禁止输出）：
   美女、性感、好看、精彩、刺激、诱惑、迷人、漂亮、可爱、身材好、皮肤白、声音好听、演技好、高质量、推荐、必看、经典、神作、佳作、上品、淫乱、放荡、激情

规则：
1. 只输出 2-3 个标签，全部从上面"好标签例子"的维度出发（题材、身份、体型、服装、性癖、场景）。
2. 优先选择题材/身份类标签（如人妻、OL、学生），其次是体型/服装类（如巨乳、制服、黑丝）。
3. 不要输出形容词、评价词、情绪词。
4. 如果信息太少无法判断，宁可少输出（最少1个），也不要瞎编。

===== 输出格式（严格只输出下面两行，不要任何其他内容）=====
标签：标签1, 标签2, 标签3
演员：女优1, 女优2, 女优3

候选女优名单（共 ${candidateNames.length} 人）：
${candidateList}
  `.trim();

  const result = await callAI(prompt, systemPrompt);

  return parseTagsOutput(result);
}

/**
 * 严格解析 AI 标签/女优输出（纯函数，便于单测）
 * 规则：以"标签："/"演员："/"女优："开头的行才解析，禁止行内包含关键词的宽松匹配；
 *       标签强制 ≤3、女优去重；解析不到标签行返回空数组。
 * @param {string} result AI 原始输出
 * @returns {{ tags: string[], actresses: string[] }}
 */
function parseTagsOutput(result) {
  const tags = [];
  const actresses = [];

  // 无女优占位词，避免污染 actresses 表
  const NO_ACTRESS_WORDS = new Set(['无', '暂无', '无演员', '没有', '未知', '未知女优', '不适用', 'None', 'none', 'N/A', 'null']);

  if (typeof result === 'string') {
    // 先剥离可能的 markdown 代码块围栏，增强鲁棒性
    const cleaned = result.replace(/```[a-zA-Z]*/g, '');

    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
      // 去掉行首可能的 markdown 列表符号（- * • 等），避免误伤
      const stripped = line.replace(/^[-*•·\s]+/, '').trim();

      let m;
      if ((m = stripped.match(/^(?:标签|tags?)\s*[：:]\s*(.+)$/i))) {
        const items = m[1].split(/[,，、;；]/)
          .map(t => t.trim())
          .filter(t => t.length > 1 && t.length < 20);
        for (const item of items) {
          if (tags.length >= 3) break;
          tags.push(item);
        }
      } else if ((m = stripped.match(/^(?:演员|女优|女優|出演者|actresses?|actors?)\s*[：:]\s*(.+)$/i))) {
        const items = m[1].split(/[,，、;；]/)
          .map(t => t.trim())
          .filter(t => t && t.length > 1 && t.length < 20 && !NO_ACTRESS_WORDS.has(t));
        actresses.push(...items);
      }
    }
  }

  // 解析不到标签行时返回空数组并告警（已删除"把全部内容当标签"的兜底逻辑）
  if (tags.length === 0) {
    console.warn('[AI标签] 未解析到标签行，原始输出:', result);
  }

  return {
    tags: [...new Set(tags)].slice(0, 3),
    actresses: [...new Set(actresses)]
  };
}

/**
 * AI 推荐影片
 * @param {Array} userHistory 用户观看历史
 * @param {Array} allMovies 所有候选影片
 * @param {Number} count 推荐数量
 * @param {Array} searchKeywords 搜索历史关键词
 */
async function recommendMovies(userHistory, allMovies, count = 10, searchKeywords = []) {
  const systemPrompt = '你是一个影片推荐专家，擅长根据用户观看历史和搜索历史推荐相似的影片。请直接输出推荐的影片ID，用逗号分隔，不要添加任何解释。';
  
  const recentMovies = userHistory.slice(0, 5).map(m => ({
    id: m.id,
    title: m.title,
    tags: m.tags ? m.tags.map(t => t.name).join(', ') : '',
    actresses: m.actresses ? m.actresses.map(a => a.name).join(', ') : ''
  }));
  
  const watchedIds = new Set(userHistory.map(m => m.id));
  const candidates = allMovies.filter(m => !watchedIds.has(m.id)).slice(0, 50);
  
  let prompt = `
用户最近观看的影片：
${recentMovies.map(m => `- ${m.title} (标签: ${m.tags}, 演员: ${m.actresses})`).join('\n')}
`;
  
  // 如果有搜索历史，也加进去
  if (searchKeywords && searchKeywords.length > 0) {
    prompt += `
用户最近搜索的关键词：${searchKeywords.join(', ')}
`;
  }
  
  prompt += `
候选影片列表：
${candidates.map(m => `- ID:${m.id}, 标题:${m.title}, 标签:${m.tags ? m.tags.map(t => t.name).slice(0, 5).join(', ') : '无'}, 演员:${m.actresses ? m.actresses.map(a => a.name).slice(0, 3).join(', ') : '无'}`).join('\n')}

请根据用户的观看历史和搜索历史，从候选影片中推荐 ${count} 部最符合用户喜好的影片。
只输出影片ID，用逗号分隔，例如：1, 5, 12, 23
  `.trim();
  
  try {
    const result = await callAI(prompt, systemPrompt);
    const ids = result.split(/[,，、]/).map(id => {
      const match = id.match(/\d+/);
      return match ? parseInt(match[0]) : null;
    }).filter(id => id && candidates.some(c => c.id === id));
    
    return ids.slice(0, count);
  } catch (e) {
    console.log('AI推荐失败，使用热门推荐:', e.message);
    return [];
  }
}

/**
 * Agent 工具定义
 * 定义AI可以调用的所有工具
 */
function getAgentTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'search_movies',
        description: '搜索影片库中的影片，支持按标题、番号、标签、女优等关键词搜索',
        parameters: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词，可以是标题、番号、标签、女优名等'
            },
            type: {
              type: 'string',
              description: '影片类型：jav(影片)、anime(动漫)、comic(漫画)、novel(小说)、all(全部)',
              enum: ['jav', 'anime', 'comic', 'novel', 'all']
            },
            limit: {
              type: 'number',
              description: '返回结果数量，默认10'
            }
          },
          required: ['keyword']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_movie_detail',
        description: '获取影片的详细信息，包括标题、番号、女优、标签、简介等',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '影片ID'
            }
          },
          required: ['movie_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'play_movie',
        description: '播放指定影片（使用PotPlayer或在线播放器）',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '要播放的影片ID'
            }
          },
          required: ['movie_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'switch_module',
        description: '切换到指定模块页面',
        parameters: {
          type: 'object',
          properties: {
            module: {
              type: 'string',
              description: '模块名称：movies(全部影片)、jav(影片库)、anime(动漫库)、comic(漫画库)、novel(小说库)、favorites(收藏)、settings(设置)',
              enum: ['movies', 'jav', 'anime', 'comic', 'novel', 'favorites', 'settings']
            }
          },
          required: ['module']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_random_movies',
        description: '随机推荐影片，可指定类型和数量',
        parameters: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: '影片类型：jav、anime、comic、novel、all',
              enum: ['jav', 'anime', 'comic', 'novel', 'all']
            },
            limit: {
              type: 'number',
              description: '推荐数量，默认6'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_statistics',
        description: '获取影库统计信息，包括影片总数、女优数、标签数、观看时长等'
      }
    },
    {
      type: 'function',
      function: {
        name: 'add_tags',
        description: '为指定影片添加AI生成的标签和女优信息',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '影片ID'
            }
          },
          required: ['movie_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'translate_movie',
        description: '翻译指定影片的标题和简介为中文',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '影片ID'
            }
          },
          required: ['movie_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'rename_movie',
        description: '重命名指定影片文件（高危操作，需要用户确认）',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '影片ID'
            }
          },
          required: ['movie_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'scrape_poster',
        description: '重新刮削指定影片的海报',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '影片ID'
            }
          },
          required: ['movie_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fix_movie_cover',
        description: '给漫画 / 小说补齐封面。漫画和小说常常刮不到封面，这个工具会先联网搜（漫画走 kmoe、' +
          '小说走 zlibrary），搜不到就用内容截图兜底：漫画取 PDF 第 1 页、小说取 EPUB 里自带的封面图。' +
          '只补「本来没有封面」的条目，不会覆盖已有封面。可以传 movie_id 补单部，也可以不传参数批量补。',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '要补封面的影片ID；不传则批量补所有缺封面的漫画/小说'
            },
            keyword: {
              type: 'string',
              description: '批量补时可按标题 / 文件名关键字过滤，例如「日月同错」'
            },
            limit: {
              type: 'number',
              description: '批量补时单次最多处理几部，默认 10，上限 20'
            }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_folder',
        description: '打开指定影片所在的文件夹',
        parameters: {
          type: 'object',
          properties: {
            movie_id: {
              type: 'number',
              description: '影片ID'
            }
          },
          required: ['movie_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_actress_list',
        description: '获取女优列表，支持按名称搜索',
        parameters: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词（女优名），可选'
            },
            limit: {
              type: 'number',
              description: '返回数量，默认20'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_tag_list',
        description: '获取标签列表，支持按名称搜索',
        parameters: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词，可选'
            },
            limit: {
              type: 'number',
              description: '返回数量，默认20'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_recommendations',
        description: '基于观看历史和搜索历史的AI推荐影片',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: '推荐数量，默认6'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_project_file',
        description: '读取项目文件内容（用于代码审查和修改建议）',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '相对于项目根目录的文件路径，如 routes/movie.js'
            }
          },
          required: ['file_path']
        }
      }
    }
  ];
}

/**
 * AI 对话助手（支持Agent工具调用）
 * @param {string} message 用户消息
 * @param {Array} movies 影片列表
 * @param {Object} context 上下文（包含数据库操作函数等）
 * @returns {Promise<{content: string, toolCalls: Array, movieRefs: Array}>}
 */
async function chatWithAI(message, movies, context = {}) {
  const systemPrompt = `你是一个本地媒体库管理助手，可以帮助用户搜索、播放、管理影片、动漫、漫画和小说。
用户的影库中有 ${movies.length} 部影片。
你可以调用工具来完成各种操作，如搜索、播放、切换模块等。
回答要简洁明了，重点突出。

【重要格式要求】
当你提到或推荐某部影片时，必须使用以下格式标记：
[[影片ID|影片标题]]
例如：[[123|ABC-123 某部影片]]

这样用户可以直接点击跳转到影片详情页。
每部影片只标记一次，不要重复标记。

【工具使用】
当用户需要执行操作时（如搜索、播放、切换模块等），请调用相应的工具，不要只在文字中描述。
如果工具调用需要用户确认（如播放、删除等敏感操作），请先询问用户。`;
  
  const movieSamples = movies.slice(0, 50).map(m => 
    `- ID:${m.id}, 标题:${m.title}, 番号:${m.avid || '未知'}, 标签:${m.tags ? m.tags.map(t => t.name).slice(0, 5).join(', ') : '无'}, 女优:${m.actresses ? m.actresses.map(a => a.name).slice(0, 3).join(', ') : '无'}`
  ).join('\n');
  
  const prompt = `
影库中的部分影片（ID用于标记引用）：
${movieSamples}

用户问题：${message}

请回答用户的问题。如果需要执行操作，请调用相应的工具。如果需要推荐影片，从影库中选择合适的推荐，并用 [[ID|标题]] 格式标记每部影片。
  `.trim();
  
  // 根据当前provider决定是否使用工具
  const { provider } = getAIConfig();
  const useTools = provider !== 'ollama' && aiConfig.enableAgent !== false;
  
  try {
    const result = await callAI(prompt, systemPrompt, useTools ? getAgentTools() : null);
    
    // 如果是工具调用结果
    if (typeof result === 'object' && result.type === 'tool_calls') {
      return {
        content: result.content || '好的，我来帮你处理。',
        toolCalls: result.toolCalls,
        movieRefs: []
      };
    }
    
    // 普通文本结果，解析影片引用
    const content = result;
    const movieRefs = [];
    const refRegex = /\[\[(\d+)\|([^\]]+)\]\]/g;
    let match;
    while ((match = refRegex.exec(content)) !== null) {
      const id = parseInt(match[1]);
      const movie = movies.find(m => m.id === id);
      if (movie) {
        movieRefs.push({
          id: movie.id,
          title: match[2],
          poster: movie.posterPath,
          avid: movie.avid,
          tags: movie.tags ? movie.tags.map(t => t.name) : [],
          actresses: movie.actresses ? movie.actresses.map(a => a.name) : []
        });
      }
    }
    
    return {
      content,
      toolCalls: [],
      movieRefs
    };
  } catch (e) {
    throw new Error(`AI对话失败: ${e.message}`);
  }
}

/**
 * 检查 AI 服务状态
 */
async function checkAIStatus() {
  const { provider } = getAIConfig();
  
  if (provider === 'ollama') {
    try {
      const baseUrl = ollamaConfig.baseUrl || 'http://127.0.0.1:11434';
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return {
        available: true,
        models: data.models || [],
        enabled: true,
        currentModel: ollamaConfig.model || '',
        provider: 'ollama'
      };
    } catch (e) {
      return {
        available: false,
        error: e.message,
        enabled: ollamaConfig.enableTranslate || false,
        provider: 'ollama'
      };
    }
  } else {
    const providerConfig = aiConfig[provider] || {};
    return {
      available: !!providerConfig.apiKey,
      enabled: !!providerConfig.apiKey,
      currentModel: providerConfig.model || '',
      provider,
      apiKeyConfigured: !!providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl || ''
    };
  }
}

// 兼容旧接口
const checkOllamaStatus = checkAIStatus;

module.exports = {
  callAI,
  callOllama,
  callOpenAICompatible,
  translateText,
  translateMovie,
  generateTags,
  parseTagsOutput,
  recommendMovies,
  chatWithAI,
  checkAIStatus,
  checkOllamaStatus,
  getAvailableModels,
  testApiKey,
  getAgentTools,
  getAIConfig
};
