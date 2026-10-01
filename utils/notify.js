// ================================================================
// utils/notify.js —— 站内通知事件总线（round34 批次B ⑩）
//
// 职责：把「应用里发生的事」统一变成用户可感知的通知：
//   1) 落库（notifications 表，铃铛面板可见）；
//   2) 前端 toast（轮询 /api/notification/unread-count 变化后由前端弹）。
//
// 事件类型（type 字段）与用户偏好键一一对应：
//   scanDone     扫描完成          默认 toast+站内信
//   newItem      发现新作          默认 toast+站内信
//   scrapeFailed 刮削失败          默认 仅站内信（高频，别打扰）
//   posterMissing 海报缺失         默认 仅站内信
//   dbHeal       数据库自愈/异常    默认 toast+站内信
//   update       应用更新           默认 toast+站内信
//   operation    普通操作成功/失败  默认 仅toast（短时反馈，不必留档）
//
// 偏好存 config.notifyPrefs = { scanDone: 'both'|'inbox'|'toast'|'off', ... }
// 未配置的类型用上面默认值；'off' = 完全静默（连站内信都不落）。
// ================================================================

const db = require('./db');
const config = require('./config');
const fs = require('fs');

const DEFAULT_PREFS = {
    scanDone: 'both',
    newItem: 'both',
    scrapeFailed: 'inbox',
    posterMissing: 'inbox',
    dbHeal: 'both',
    update: 'both',
    operation: 'toast',
};

const LEVEL_OF = {
    scanDone: 'success',
    newItem: 'info',
    scrapeFailed: 'warn',
    posterMissing: 'warn',
    dbHeal: 'error',
    update: 'info',
    operation: 'success',
};

function getPrefs() {
    return { ...DEFAULT_PREFS, ...(config.notifyPrefs || {}) };
}

function setPrefs(prefs) {
    config.notifyPrefs = { ...DEFAULT_PREFS, ...(config.notifyPrefs || {}), ...(prefs || {}) };
    try { fs.writeFileSync(config.configPath, JSON.stringify(config, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
    return config.notifyPrefs;
}

/**
 * 发一条通知。
 * @param {string} type  事件类型（见顶部表）
 * @param {string} title 标题（一句话）
 * @param {string} content 详情（可空）
 * @param {object} opts  { url: 跳转路径(应用内), cover: 封面, extra: object }
 * @returns {boolean} 是否真正落库/可见（被偏好关掉时返回 false）
 */
function notify(type, title, content, opts = {}) {
    const prefs = getPrefs();
    const pref = prefs[type] || DEFAULT_PREFS[type] || 'both';
    if (pref === 'off') return false;

    const level = opts.level || LEVEL_OF[type] || 'info';
    // 站内信（operation 类默认不留档，除非显式 inbox/both）
    if (pref === 'inbox' || pref === 'both') {
        try {
            db.addNotification.run(
                type,
                String(title || '').slice(0, 200),
                String(content || '').slice(0, 2000),
                opts.url || '',
                opts.cover || '',
                opts.extra ? JSON.stringify({ level, ...(opts.extra || {}) }) : JSON.stringify({ level }),
                Date.now()
            );
            db.pruneNotifications && db.pruneNotifications();
        } catch (e) {
            console.log('[notify] 落库失败:', e.message);
        }
    }
    // toast 由前端轮询新通知后按 level 弹 —— 这里无需做事；
    // 但 operation 类（默认不落库）要走即时通道：写进内存RecentBuffer供轮询读取
    if (pref === 'toast' || pref === 'both') {
        pushLive({ type, level, title: String(title || '').slice(0, 200), content: String(content || '').slice(0, 500), at: Date.now() });
    }
    return true;
}

// —— 即时 toast 通道（不落库的通知在这里中转，前端轮询拉走） ——
const liveBuffer = [];
function pushLive(item) {
    liveBuffer.push(item);
    if (liveBuffer.length > 50) liveBuffer.splice(0, liveBuffer.length - 50);
}
function pollLive(since) {
    const t = Number(since) || 0;
    const out = liveBuffer.filter(i => i.at > t);
    return { items: out, now: Date.now() };
}

module.exports = { notify, getPrefs, setPrefs, DEFAULT_PREFS, LEVEL_OF, pollLive };
