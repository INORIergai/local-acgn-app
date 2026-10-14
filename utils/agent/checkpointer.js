/**
 * utils/agent/checkpointer.js —— 基于 better-sqlite3 的 LangGraph 检查点持久化存储
 * ============================================================================
 * 继承 LangGraph 官方 MemorySaver，并镜像写入本地 SQLite 表 ai_agent_checkpoints，
 * 兼具极速内存缓存与重启后状态持久化恢复。
 * ============================================================================
 */
'use strict';

const { MemorySaver } = require('@langchain/langgraph');
const db = require('../db').db;

// 1. 初始化检查点持久化表
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_agent_checkpoints (
      threadId TEXT NOT NULL,
      checkpointId TEXT NOT NULL,
      parentCheckpointId TEXT,
      checkpointData TEXT NOT NULL,
      metadata TEXT,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (threadId, checkpointId)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_checkpoints_created
      ON ai_agent_checkpoints(threadId, createdAt DESC);
  `);
} catch (e) {
  console.error('[Checkpointer] 初始化表失败:', e.message);
}

class SqliteAgentCheckpointer extends MemorySaver {
  async put(config, checkpoint, metadata, newVersions) {
    const res = await super.put(config, checkpoint, metadata, newVersions);
    const threadId = config?.configurable?.thread_id || 'default';
    const checkpointId = checkpoint?.id || `cp_${Date.now()}`;
    const parentId = config?.configurable?.checkpoint_id || null;

    try {
      db.prepare(`
        INSERT OR REPLACE INTO ai_agent_checkpoints
        (threadId, checkpointId, parentCheckpointId, checkpointData, metadata, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        threadId,
        checkpointId,
        parentId,
        JSON.stringify(checkpoint || {}),
        JSON.stringify(metadata || {}),
        Date.now()
      );
    } catch (err) {
      console.warn('[Checkpointer] SQLite 镜像落库异常:', err.message);
    }

    return res;
  }
}

const defaultCheckpointer = new SqliteAgentCheckpointer();

module.exports = {
  SqliteAgentCheckpointer,
  defaultCheckpointer
};
