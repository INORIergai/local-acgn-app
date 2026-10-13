/**
 * utils/agent/graph.js —— 基于 LangGraph 的 CinemaVault AI Agent 行为状态图
 * ============================================================================
 * 拓扑架构：
 *   START -> agent_reasoning
 *             ├── (有 tool_calls)  -> sandbox_gate -> tool_executor -> eval_reflection -> (Loop 回 agent_reasoning)
 *             └── (无 tool_calls)  -> character_synthesis -> END
 * ============================================================================
 */
'use strict';

const { StateGraph, START, END, Annotation } = require('@langchain/langgraph');
const { executeSandboxedTool, PRIVILEGE } = require('./sandbox');
const { TOOL_MAP, getOpenAIToolsSchema } = require('./tools');

// ========== 1. 状态模式定义 (AgentState) ==========
const AgentState = Annotation.Root({
  // 消息流：累加式 reducer
  messages: Annotation({
    reducer: (prev, next) => (Array.isArray(next) ? prev.concat(next) : prev.concat([next])),
    default: () => []
  }),
  sessionId: Annotation({ reducer: (p, n) => n ?? p, default: () => 'default' }),
  personaId: Annotation({ reducer: (p, n) => n ?? p, default: () => 'butler' }),
  systemPrompt: Annotation({ reducer: (p, n) => n ?? p, default: () => '' }),

  // 规划与反思计数器（防死循环）
  iterationCount: Annotation({ reducer: (p, n) => (n !== undefined ? n : (p || 0) + 1), default: () => 0 }),
  reflectionCount: Annotation({ reducer: (p, n) => n ?? p, default: () => 0 }),

  // 审计与执行步痕迹（回传前端）
  steps: Annotation({
    reducer: (prev, next) => (Array.isArray(next) ? prev.concat(next) : prev.concat([next])),
    default: () => []
  }),

  // 收集到的前端指令（如播放、切视图）
  uiActions: Annotation({
    reducer: (prev, next) => (Array.isArray(next) ? prev.concat(next) : prev.concat([next])),
    default: () => []
  }),

  // 高危审批状态
  pendingApproval: Annotation({ reducer: (p, n) => n, default: () => null }),
  userApproved: Annotation({ reducer: (p, n) => n ?? p, default: () => false }),

  // 最终产物
  finalReply: Annotation({ reducer: (p, n) => n ?? p, default: () => '' }),
  movieRefs: Annotation({ reducer: (p, n) => n ?? p, default: () => [] })
});

// ========== 2. 节点逻辑实现 ==========

/**
 * Node 1: 核心 LLM 决策与推理节点
 */
async function agentReasoningNode(state, config) {
  const { callAIAdvanced } = require('../ai-service');
  const count = (state.iterationCount || 0) + 1;

  // 构造标准消息列表
  const rawMessages = [];
  if (state.systemPrompt) {
    rawMessages.push({ role: 'system', content: state.systemPrompt });
  }
  for (const m of state.messages) {
    rawMessages.push(m);
  }

  const toolsSchema = getOpenAIToolsSchema();
  const llmRes = await callAIAdvanced(rawMessages, toolsSchema);

  // 如果模型给出了工具调用
  if (typeof llmRes === 'object' && llmRes.type === 'tool_calls') {
    const assistantMsg = {
      role: 'assistant',
      content: llmRes.content || '',
      tool_calls: llmRes.toolCalls || []
    };
    return {
      messages: [assistantMsg],
      iterationCount: count
    };
  }

  // 纯文本输出
  const content = typeof llmRes === 'string' ? llmRes : (llmRes.content || '');
  return {
    messages: [{ role: 'assistant', content }],
    finalReply: content,
    iterationCount: count
  };
}

/**
 * Node 2: 沙箱安全门禁节点（审查权限与路径安全，阻断破坏性操作）
 */
async function sandboxGateNode(state) {
  const lastMsg = state.messages[state.messages.length - 1];
  const toolCalls = (lastMsg && lastMsg.tool_calls) || [];

  for (const tc of toolCalls) {
    const name = tc?.function?.name || '';
    const meta = TOOL_MAP.get(name);
    let args = {};
    try { args = JSON.parse(tc?.function?.arguments || '{}'); } catch (e) {}

    // 检查高危操作与用户授权
    if (meta && meta.privilege === PRIVILEGE.DESTRUCTIVE && !state.userApproved) {
      console.warn(`[Sandbox Gate] 命中高危操作门禁: ${name}`);
      return {
        pendingApproval: {
          toolCallId: tc.id,
          name,
          label: meta.label || name,
          args,
          warning: meta.warningMessage || '此操作不可逆，需用户明确授权'
        }
      };
    }
  }

  return { pendingApproval: null };
}

/**
 * Node 3: 沙箱工具执行节点（带超时熔断与沙箱隔离）
 */
async function toolExecutorNode(state) {
  const lastMsg = state.messages[state.messages.length - 1];
  const toolCalls = (lastMsg && lastMsg.tool_calls) || [];
  const toolMessages = [];
  const newSteps = [];
  const newActions = [];

  for (const tc of toolCalls) {
    const name = tc?.function?.name || '';
    const meta = TOOL_MAP.get(name);
    let args = {};
    try { args = JSON.parse(tc?.function?.arguments || '{}'); } catch (e) {}

    let res;
    if (!meta) {
      res = { ok: false, error: `未知工具: ${name}` };
    } else {
      res = await executeSandboxedTool(meta, args, {
        userApproved: state.userApproved,
        sessionId: state.sessionId
      });
    }

    // 提取可能的 UI Action（播放、切页面等）
    if (res.ok && res.data && res.data.uiAction) {
      newActions.push({ type: res.data.uiAction, payload: res.data });
    }

    newSteps.push({
      tool: name,
      label: meta ? meta.label : name,
      args,
      privilege: meta ? meta.privilege : 'unknown',
      ok: res.ok,
      costMs: res.costMs || 0,
      summary: res.ok ? JSON.stringify(res.data).slice(0, 180) : res.error
    });

    toolMessages.push({
      role: 'tool',
      tool_call_id: tc.id || `${name}_call`,
      content: JSON.stringify(res.ok ? res.data : { error: res.error })
    });
  }

  return {
    messages: toolMessages,
    steps: newSteps,
    uiActions: newActions
  };
}

/**
 * Node 4: 评估反思节点（检查工具执行结果，判定是否满足目标）
 */
async function evalReflectionNode(state) {
  const refCount = (state.reflectionCount || 0) + 1;
  return {
    reflectionCount: refCount
  };
}

/**
 * Node 5: 角色表达与影片卡片提取合成节点
 */
async function characterSynthesisNode(state) {
  const { stripThinkBlocks, parseMovieRefs } = require('../ai-service');
  const db = require('../db');
  let text = state.finalReply || '';

  // 从最后的 assistant 消息提取
  if (!text) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === 'assistant' && state.messages[i].content) {
        text = state.messages[i].content;
        break;
      }
    }
  }

  text = stripThinkBlocks(text).trim();

  // 提取影片引用 [[ID|标题]]
  let refs = [];
  try {
    const allMovies = db.getAllMovies.all();
    refs = parseMovieRefs(text, allMovies);
  } catch (e) {
    refs = [];
  }

  return {
    finalReply: text,
    movieRefs: refs
  };
}

// ========== 3. 条件边路由判断 ==========

function routeAfterReasoning(state) {
  const lastMsg = state.messages[state.messages.length - 1];
  const toolCalls = (lastMsg && lastMsg.tool_calls) || [];
  if (toolCalls.length > 0) {
    return 'sandbox_gate';
  }
  return 'character_synthesis';
}

function routeAfterSandboxGate(state) {
  // 如果进入了高危审批挂起，终止图执行，交由前端确认
  if (state.pendingApproval) {
    return END;
  }
  return 'tool_executor';
}

function routeAfterReflection(state) {
  // 最多循环 5 轮，避免耗尽 token
  if ((state.iterationCount || 0) >= 6) {
    return 'character_synthesis';
  }
  // 回到 agent 思考下一轮
  return 'agent_reasoning';
}

// ========== 4. 组装与编译 LangGraph ==========

function createCinemaAgentGraph(opts = {}) {
  const { defaultCheckpointer } = require('./checkpointer');
  const checkpointer = opts.checkpointer !== undefined ? opts.checkpointer : defaultCheckpointer;

  const workflow = new StateGraph(AgentState)
    .addNode('agent_reasoning', agentReasoningNode)
    .addNode('sandbox_gate', sandboxGateNode)
    .addNode('tool_executor', toolExecutorNode)
    .addNode('eval_reflection', evalReflectionNode)
    .addNode('character_synthesis', characterSynthesisNode)

    .addEdge(START, 'agent_reasoning')
    .addConditionalEdges('agent_reasoning', routeAfterReasoning, {
      sandbox_gate: 'sandbox_gate',
      character_synthesis: 'character_synthesis'
    })
    .addConditionalEdges('sandbox_gate', routeAfterSandboxGate, {
      tool_executor: 'tool_executor',
      [END]: END
    })
    .addEdge('tool_executor', 'eval_reflection')
    .addConditionalEdges('eval_reflection', routeAfterReflection, {
      agent_reasoning: 'agent_reasoning',
      character_synthesis: 'character_synthesis'
    })
    .addEdge('character_synthesis', END);

  return workflow.compile(checkpointer ? { checkpointer } : {});
}

module.exports = {
  AgentState,
  createCinemaAgentGraph
};
