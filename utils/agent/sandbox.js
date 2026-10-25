/**
 * utils/agent/sandbox.js —— CinemaVault AI Agent 运行时安全沙箱
 * ============================================================================
 * 职责：
 *   1. 权限分级审计（只读 / 交互 / 变更 / 破坏）
 *   2. 路径牢笼（Path Jail：严格隔离在合法媒体库目录与缓存内，防目录穿越）
 *   3. 工具执行超时熔断器（Timeout Circuit Breaker）
 *   4. 返回值尺寸守卫（防止过大输出打爆上下文窗口）
 *   5. 统一沙箱执行器与审计日志
 * ============================================================================
 */
'use strict';

const path = require('path');
const fs = require('fs');
const config = require('../config');

// 权限等级
const PRIVILEGE = {
  READ_ONLY: 'read_only',       // 纯查询类：检索、详情、统计、推荐
  INTERACTIVE: 'interactive',   // 界面联动：播放、切模块、聚焦元素
  MUTATING: 'mutating',         // 数据修改：收藏、修改标签、建播单（可逆）
  DESTRUCTIVE: 'destructive'    // 破坏性操作：重命名文件、删除文件、清库（需用户双重确认）
};

// 默认超时与尺寸限制
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_OUTPUT_CHARS = 3500;

/**
 * 获取当前受信任的合法路径根列表（Path Jail 白名单）
 */
function getTrustedRoots() {
  const roots = [];
  const add = (dir) => {
    if (!dir) return;
    try {
      const resolved = path.resolve(dir);
      if (!roots.includes(resolved)) roots.push(resolved);
    } catch (e) {}
  };

  // 1. 各媒体库配置目录
  const folderKeys = ['scanFolders', 'animeFolders', 'comicFolders', 'novelFolders', 'filmFolders', 'cartoonFolders'];
  folderKeys.forEach((key) => {
    const list = config[key];
    if (Array.isArray(list)) list.forEach(add);
    else if (typeof list === 'string') add(list);
  });

  // 2. 本地项目 cache 与 posters 目录
  add(path.resolve(__dirname, '../../cache'));
  add(path.resolve(__dirname, '../../posters'));

  return roots;
}

/**
 * 路径牢笼校验：判定指定路径是否在受信任的媒体目录内
 * @param {string} targetPath 待检测路径
 * @returns {{ safe: boolean, reason?: string, resolvedPath?: string }}
 */
function verifyPathJail(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') {
    return { safe: false, reason: '路径参数为空或非法' };
  }

  // 杜绝明显的目录遍历符号
  if (targetPath.includes('..') || /\0/.test(targetPath)) {
    return { safe: false, reason: '检测到非法路径遍历字符 (.. 或 NULL)' };
  }

  const resolved = path.resolve(targetPath);
  const trustedRoots = getTrustedRoots();

  // 若尚未配置任何媒体库，只允许相对本库 cache 目录
  if (trustedRoots.length === 0) {
    return { safe: false, reason: '影库尚未配置扫描目录，沙箱禁止任意文件访问' };
  }

  // 判断 resolved 是否处于任一受信任根目录下
  const inJail = trustedRoots.some((root) => {
    const rel = path.relative(root, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });

  if (!inJail) {
    return {
      safe: false,
      reason: `路径越界拦截：${resolved} 不属于已配置的媒体库目录`,
      resolvedPath: resolved
    };
  }

  return { safe: true, resolvedPath: resolved };
}

/**
 * 递归深度扫描参数对象中的路径字段并进行沙箱校验
 */
function auditToolArgs(args, toolMeta) {
  if (!args || typeof args !== 'object') return { safe: true };

  const pathKeys = ['path', 'filePath', 'targetPath', 'folder', 'file', 'dir'];
  for (const [key, value] of Object.entries(args)) {
    if (pathKeys.includes(key) && typeof value === 'string') {
      const check = verifyPathJail(value);
      if (!check.safe) return check;
    }
    // 递归检查子对象
    if (value && typeof value === 'object') {
      const sub = auditToolArgs(value, toolMeta);
      if (!sub.safe) return sub;
    }
  }

  return { safe: true };
}

/**
 * 带超时熔断的异步执行包装器
 */
async function executeWithTimeout(asyncFn, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[Sandbox] 工具执行超时熔断 (${timeoutMs}ms)`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([asyncFn(), timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 返回值尺寸守卫与安全脱敏
 */
function sanitizeToolOutput(output) {
  if (output === null || output === undefined) return { result: 'null' };
  let str = '';
  try {
    str = typeof output === 'string' ? output : JSON.stringify(output);
  } catch (e) {
    str = String(output);
  }

  if (str.length > MAX_OUTPUT_CHARS) {
    const truncated = str.slice(0, MAX_OUTPUT_CHARS) + `... [沙箱截断: 原始长度 ${str.length} 字符]`;
    try {
      return JSON.parse(truncated);
    } catch (e) {
      return { truncated, originalLength: str.length };
    }
  }

  return output;
}

/**
 * 统一沙箱执行器
 * @param {object} toolDef 工具定义元信息（含 privilege、handler 等）
 * @param {object} args 调用参数
 * @param {object} context 运行时会话上下文
 * @returns {Promise<{ ok: boolean, data?: any, error?: string, privilege: string, requiresApproval?: boolean }>}
 */
async function executeSandboxedTool(toolDef, args, context = {}) {
  const meta = toolDef || {};
  const privilege = meta.privilege || PRIVILEGE.READ_ONLY;
  const toolName = meta.name || 'anonymous_tool';

  // 1. 破坏性操作必须走 Human-In-The-Loop 门禁审核
  if (privilege === PRIVILEGE.DESTRUCTIVE && !context.userApproved) {
    return {
      ok: false,
      requiresApproval: true,
      privilege,
      toolName,
      args,
      error: `该操作涉及数据变更或文件删除，需用户在界面上明确批准`
    };
  }

  // 2. 路径牢笼审计
  const jailCheck = auditToolArgs(args, meta);
  if (!jailCheck.safe) {
    console.warn(`[Sandbox Block] ${toolName} 触发沙箱拦截: ${jailCheck.reason}`);
    return {
      ok: false,
      privilege,
      toolName,
      error: `[沙箱拦截] ${jailCheck.reason}`
    };
  }

  // 3. 执行并在超时与异常下保护主流程
  const timeoutMs = meta.timeoutMs || DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    const rawResult = await executeWithTimeout(async () => {
      return await meta.handler(args, context);
    }, timeoutMs);

    const cost = Date.now() - startedAt;
    const sanitized = sanitizeToolOutput(rawResult);

    return {
      ok: true,
      privilege,
      toolName,
      costMs: cost,
      data: sanitized
    };
  } catch (err) {
    const cost = Date.now() - startedAt;
    console.error(`[Sandbox Error] ${toolName} 执行失败 (${cost}ms):`, err.message);
    return {
      ok: false,
      privilege,
      toolName,
      costMs: cost,
      error: err.message
    };
  }
}

module.exports = {
  PRIVILEGE,
  getTrustedRoots,
  verifyPathJail,
  auditToolArgs,
  executeWithTimeout,
  sanitizeToolOutput,
  executeSandboxedTool
};
