/**
 * round72 · 全局任务状态聚合
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 之前每个后台任务各自维护一个模块级变量 + 一个 /status 路由 + 前端各自 setInterval：
 *   · 11 组任务散在 5 个文件里
 *   · 字段命名有 3 套口径（current/total、done/total、success/failed）
 *   · 前端进度条大多渲染在**设置弹窗的 div** 里，弹窗一关就再也看不见，
 *     轮询器还是「点按钮才启动」的，关掉弹窗再打开轮询已停、进度定格。
 *
 * 本模块把所有任务归一成同一个 shape：
 *   { key, name, icon, running, current, total, percent, detail, ok, fail, startedAt, finishedAt }
 * 两处消费：
 *   1) 右上角全局进度胶囊（前端 /api/tasks）
 *   2) AI 的 get_task_status 工具（routes/ai.js）
 *
 * ── 两类状态源，怎么统一 ──────────────────────────────────────
 *   A. utils 层：本身就有 getXxxStatus()，本模块直接 require 聚合（无侵入）。
 *   B. routes 层：状态是路由文件里的模块级 let，外部读不到，
 *      所以提供 registerRouteTask()，由路由文件在模块加载时注册一次。
 */

const _registry = new Map();

/** 归一化：把各家千奇百怪的状态形状压成统一字段 */
function normalize(key, meta, raw) {
    const s = raw || {};
    const running = !!s.running;
    // 三套字段口径：current / done / success+failed 统统归到 current & total
    const total = Number(s.total != null ? s.total : (s.done + (s.fail || 0))) || 0;
    const current = Number(s.current != null ? s.current : (s.done != null ? s.done : 0)) || 0;
    const ok = Number(s.ok != null ? s.ok : (s.success != null ? s.success : 0)) || 0;
    const fail = Number(s.fail != null ? s.fail : (s.failed != null ? s.failed : 0)) || 0;

    let detail = s.currentFile || s.lastTitle || '';
    if (!detail && s.fileName) detail = s.fileName;
    if (s.running && !detail && s.watchLabel) detail = s.watchLabel;

    return {
        key,
        name: meta.name || key,
        icon: meta.icon || '',
        running,
        current,
        total,
        percent: total > 0 ? Math.min(100, Math.round((current / total) * 100)) : (running ? 0 : 100),
        detail: String(detail).slice(0, 60),
        ok, fail,
        startedAt: s.startedAt || 0,
        finishedAt: s.finishedAt || 0,
        note: meta.note || '',
    };
}

/* ---------------- A. utils 层：直接聚合 ---------------- */

function collectUtils() {
    const out = [];
    const push = (key, meta, fn) => {
        try {
            const s = fn();
            if (s) out.push(normalize(key, meta, s));
        } catch (e) { /* 模块没加载 / 出错就跳过，绝不能因为一个任务查不到而 500 */ }
    };

    push('scan-movie', { name: '影片扫描', icon: '🎬' },
        () => require('./scanner').getScanStatus());
    push('scan-anime', { name: '动漫扫描', icon: '📺' },
        () => require('./scanner').getAnimeScanStatus());
    push('scan-film', { name: '影视扫描', icon: '🎞️' },
        () => require('./scanner').getFilmScanStatus());
    push('scan-cartoon', { name: '番剧扫描', icon: '🌸' },
        () => require('./scanner').getCartoonScanStatus());
    push('scan-comic', { name: '漫画扫描', icon: '📕' },
        () => require('./comic-scanner').getComicScanStatus());
    push('scan-novel', { name: '小说扫描', icon: '📖' },
        () => require('./novel-scanner').getNovelScanStatus());
    push('rescrape', { name: '失败重刮', icon: '♻️' },
        () => require('./scanner').getRescrapeStatus());
    push('rename', { name: '批量重命名', icon: '🏷️' },
        () => require('./rename-service').getRenameStatus());
    push('dir-watch', { name: '目录监控', icon: '👁️' },
        () => require('./dir-watch').getStatus());
    push('startup-scan', { name: '启动扫描', icon: '🚀' },
        () => require('./startup-scan-report').get());

    return out;
}

/* ---------------- B. routes 层：显式注册 ---------------- */

/**
 * 注册一个「状态变量住在路由文件里」的任务。
 * @param {string} key
 * @param {{name:string, icon?:string, note?:string}} meta
 * @param {() => object} get 返回该任务的状态对象
 */
function registerRouteTask(key, meta, get) {
    if (!key || typeof get !== 'function') return;
    _registry.set(key, { meta: meta || {}, get });
}

/** 注销（路由热重载时用，避免重复注册） */
function unregisterRouteTask(key) { _registry.delete(key); }

/* ---------------- 对外 ---------------- */

/**
 * 全部任务状态。
 * @param {{onlyActive?:boolean, includeIdle?:boolean}} opt
 *        onlyActive=true 时只返回「正在跑」+「刚完成 15 秒内」的任务（AI 查询用这个更清爽）
 * @returns {Array<object>}
 */
function allTasks(opt) {
    const o = opt || {};
    let list = [];
    try { list = collectUtils(); } catch (e) { /* 忽略 */ }

    for (const [key, entry] of _registry) {
        try {
            const s = entry.get();
            if (s) list.push(normalize(key, entry.meta, s));
        } catch (e) { /* 单个任务查不到不影响整体 */ }
    }

    // running 的排前面，其次按开始时间倒序；都不跑的按 key 稳定排序
    list.sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        const at = b.startedAt || b.finishedAt || 0;
        const bt = a.startedAt || a.finishedAt || 0;
        if (at !== bt) return at - bt;
        return a.key < b.key ? -1 : 1;
    });

    if (o.onlyActive) {
        const now = Date.now();
        list = list.filter(t => t.running || (t.finishedAt && now - t.finishedAt < 15000));
    }
    return list;
}

/** 给 AI 用的一段文字摘要（工具返回 text 时最自然） */
function describeTasks() {
    const list = allTasks({ onlyActive: true });
    if (!list.length) return '当前没有任何正在运行或刚完成的后台任务。';
    const lines = list.map(t => {
        const pct = t.total ? `（${t.current}/${t.total}，${t.percent}%）` : '';
        const tail = t.detail ? ` · 正在处理：${t.detail}` : '';
        const res = (!t.running && (t.ok || t.fail)) ? ` · 成功 ${t.ok} 失败 ${t.fail}` : '';
        return `- ${t.icon} ${t.name}：${t.running ? '进行中' : '已完成'}${pct}${res}${tail}`;
    });
    return `共 ${list.length} 个任务：\n${lines.join('\n')}`;
}

module.exports = {
    registerRouteTask, unregisterRouteTask,
    allTasks, describeTasks, normalize,
};
