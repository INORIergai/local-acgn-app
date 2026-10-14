/**
 * utils/agent/index.js —— CinemaVault AI Agent 核心入口
 * ============================================================================
 * 整合 LangGraph 状态图执行器、安全沙箱与角色记忆
 * ============================================================================
 */
'use strict';

const { createCinemaAgentGraph } = require('./graph');
const { PRIVILEGE, getTrustedRoots } = require('./sandbox');
const { TOOL_DEFINITIONS, TOOL_MAP, getOpenAIToolsSchema } = require('./tools');

// 单例已编译图
let _compiledGraph = null;
function getGraph() {
  if (!_compiledGraph) {
    _compiledGraph = createCinemaAgentGraph();
  }
  return _compiledGraph;
}

/**
 * 运行 CinemaVault LangGraph 自治 Agent
 * @param {string} userMessage 用户提问
 * @param {object} allMovies 影片列表
 * @param {object} context 包含 history, sessionId, personaId, userApproved 等
 * @returns {Promise<{
 *   content: string,
 *   steps: Array,
 *   movieRefs: Array,
 *   uiActions: Array,
 *   pendingApproval: object|null
 * }>}
 */
async function runCinemaAgent(userMessage, allMovies = [], context = {}) {
  const { buildChatPrompts, historyMessages } = require('../ai-service');
  const prompts = buildChatPrompts(userMessage, allMovies, context);
  const history = Array.isArray(context.history) ? context.history : [];

  // 强化 Agent 工具调用指示
  const agentInstruction = `
【Agent 工具调用与自主执行原则】
你拥有全套受沙箱保护的原生工具。当用户意图涉及以下动作时，请果断调用对应工具，不要仅作口头推脱：
1. 要求播放某影片时 -> 必须调用 play_movie(movie_id)
2. 要求查看或跳转界面（如年度报告、新作监视、收藏夹、猜你喜欢、设置等）-> 必须调用 switch_ui_module(module)
3. 询问近一月最新影片/漫画更新 -> 必须调用 get_new_releases(kind, days)
4. 询问年度观影报告、总时长、统计概况 -> 调用 get_annual_report(year) 或 query_library_stats()
5. 询问看了一半/未看完的影片进度 -> 调用 get_unwatched_progress()
6. 检索影片 -> 调用 search_movies(keyword, type)
7. 创建智能主题片单 -> 调用 create_smart_playlist(name, keyword)
工具返回结果后，请结合你的角色人设自然、温暖、有趣地向用户汇报！
`;

  const systemPrompt = (prompts.systemPrompt || '') + '\n' + agentInstruction;
  const userPrompt = prompts.userPrompt || userMessage;

  // 1. 组装图的初始消息流
  const initialMessages = [];
  for (const h of historyMessages(history)) {
    initialMessages.push(h);
  }
  initialMessages.push({ role: 'user', content: userPrompt });

  const initialState = {
    messages: initialMessages,
    sessionId: context.sessionId || 'default',
    personaId: context.personaId || 'butler',
    systemPrompt,
    iterationCount: 0,
    reflectionCount: 0,
    steps: [],
    uiActions: [],
    pendingApproval: null,
    userApproved: !!context.userApproved,
    finalReply: '',
    movieRefs: []
  };

  try {
    const graph = getGraph();
    const threadId = context.sessionId || 'main';
    // 执行 LangGraph 状态机，带持久化检查点与最大递归 14 步守卫
    const finalState = await graph.invoke(initialState, {
      recursionLimit: 14,
      configurable: { thread_id: threadId }
    });

    return {
      content: finalState.finalReply || '',
      steps: finalState.steps || [],
      movieRefs: finalState.movieRefs || [],
      uiActions: finalState.uiActions || [],
      pendingApproval: finalState.pendingApproval || null
    };
  } catch (err) {
    console.error('[CinemaAgent Error] LangGraph 执行异常:', err);
    // 降级保护：若图执行遇到不可预期错误，回退到基础单轮生成
    const { callAI } = require('../ai-service');
    const fallback = await callAI(userPrompt, systemPrompt, null, history);
    const content = typeof fallback === 'string' ? fallback : (fallback.content || '');
    return {
      content,
      steps: [{ tool: 'fallback_error', label: '降级模式', ok: false, summary: err.message }],
      movieRefs: [],
      uiActions: [],
      pendingApproval: null
    };
  }
}

/**
 * 流式执行入口 (SSE Stream)
 * 平滑支持 Token 逐字推送、步骤实时点亮与高危审批拦截
 */
async function streamCinemaAgent(userMessage, allMovies = [], context = {}, onEvent = () => {}) {
  // 1. 先触发一个起始通知
  onEvent({ type: 'start', message: '正在思考并规划...' });

  // 2. 跑图拿到结果（内部有沙箱与超时熔断保护）
  const result = await runCinemaAgent(userMessage, allMovies, context);

  // 3. 逐个推送步骤（模拟真实执行流水线）
  if (result.steps && result.steps.length) {
    for (const step of result.steps) {
      onEvent({ type: 'step', step });
    }
  }

  // 4. 若命中高危待审批，推送审批事件
  if (result.pendingApproval) {
    onEvent({ type: 'approval', approval: result.pendingApproval });
  }

  // 5. 若有 UI 动作（播放、切板块），推送动作事件
  if (result.uiActions && result.uiActions.length) {
    for (const act of result.uiActions) {
      onEvent({ type: 'action', action: act });
    }
  }

  // 6. 将最终回答以 20ms 为节拍平滑流式推送（平滑打字机）
  const text = result.content || '';
  const chunkSize = Math.max(1, Math.floor(text.length / 30));
  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize);
    onEvent({ type: 'token', token: chunk });
    if (text.length > 50) {
      await new Promise(r => setTimeout(r, 16));
    }
  }

  // 7. 最终完成事件
  onEvent({
    type: 'done',
    content: text,
    movieRefs: result.movieRefs || [],
    steps: result.steps || [],
    uiActions: result.uiActions || [],
    pendingApproval: result.pendingApproval || null
  });

  return result;
}

module.exports = {
  runCinemaAgent,
  streamCinemaAgent,
  getGraph,
  PRIVILEGE,
  getTrustedRoots,
  TOOL_DEFINITIONS,
  TOOL_MAP,
  getOpenAIToolsSchema
};
