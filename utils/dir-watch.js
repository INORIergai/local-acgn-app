/**
 * 目录监控引擎（exe 专属）
 *
 * 需求基线（用户原话）：
 *   1. 无后台常驻  —— 不新增服务/守护进程/计划任务，代码活在 server.js 同一个 Node 进程里
 *   2. 开应用自启动 —— 挂在当前启动流程上，不需要手动点任何东西
 *   3. 秒级出结果  —— Windows 原生 fs.watch（ReadDirectoryChangesW）事件通道，亚秒级
 *   4. 最快逻辑判断 —— 内存 Set 查表判新增，O(1)；不查库比对、不做内容比对
 *   5. 轮询要退避  —— 一次没扫到新增，间隔翻倍，上限 1 小时
 *
 * 为什么「事件 + 轮询」两条都要（这是本模块存在的理由）：
 *   - 只做事件：fs.watch 在「网络盘 / 目录被独占 / 盘符临时掉线」时会**挂载成功却不派发事件**，
 *     这是最难查的失效形态 —— 代码看起来一切正常，实际一条事件都没来。
 *   - 只做轮询：能工作，但把亚秒级白扔了。
 *   ⇒ 事件负责快（能收到就是亚秒级），轮询负责「兜底不漏」（收不到也能发现，只是慢）。
 *
 * ★★ 与方案文档的一处有意偏离（值得记一笔）：
 *   方案里第 2 层写了「一级子目录 mtime 门控」，实施时**去掉了**，改成每轮直接全树 walk + 差集。
 *   依据：实测全树 walk 只要 47 ms（8602 文件 / 471 目录），叠加退避后每轮摊到几乎为零；
 *   而门控要维护「指纹 Map + 变化子树」两份状态，多一处状态就多一处漏判的可能
 *   （例如文件直接落在媒体根、或二级目录改名）。用 47 ms 换掉一整层状态机，是划算且更稳的。
 *
 * ★ 不写任何新的入库/刮削逻辑：命中后走的是现有 processSingleFile / processSingleAnimeFile /
 *   processSingleComic / processSingleNovelFile，与启动扫描、手动扫描完全同一条链。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// ==================== 配置 ====================

function numOr(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
}

const watchCfg = () => (config && config.watch) || {};

function typeEnabled(t) {
    const m = watchCfg().types || {};
    return m[t] !== false;          // 缺省即开
}

const DEFAULTS = {
    baseIntervalMs: 5000,      // 起始轮询间隔
    maxIntervalMs: 3600000,    // 退避上限：1 小时（硬上限，配置再大也压到 1h）
    maxPerTick: 200,           // 单轮最多入队条数（防止一次拷进几百个文件打爆刮削）
    stableGapMs: 1200,         // 稳定判据：两次 stat 的间隔
    eventDebounceMs: 800,      // 事件防抖（下载器会连着吐一串事件）
    unstableGraceTicks: 12     // 连续 N 轮「有候选但都不稳定」后，仍允许间隔继续退避
};

// 视频扩展名：jav / anime 共用 config.allowedVideoExt
const VIDEO_EXT = (config.allowedVideoExt && config.allowedVideoExt.length)
    ? config.allowedVideoExt.map(e => String(e).toLowerCase())
    : ['.mp4', '.mkv', '.avi', '.rmvb', '.wmv', '.mov', '.flv', '.ts', '.m4v', '.webm', '.rm', '.mpg', '.mpeg'];
const COMIC_EXT = ['.epub', '.pdf', '.zip', '.rar', '.cbz', '.cbr', '.mobi', '.azw3'];
const NOVEL_EXT = ['.txt', '.epub', '.pdf', '.mobi', '.azw3', '.docx', '.doc', '.rtf'];

// 下载器 / 编辑器的临时后缀：这些文件一定还在写，绝不能当新增入库
const SKIP_EXT = [
    '.part', '.crdownload', '.tmp', '.temp', '.!ut', '.aria2', '.td', '.td.cfg',
    '.xltd', '.xltd.cfg', '.bt', '.bt!', '.unconfirmed', '.download', '.partial', '.opdownload'
];
const SKIP_PREFIX = ['.', '~$'];

function extMatches(type, name) {
    const ext = path.extname(name).toLowerCase();
    if (type === 'comic') return COMIC_EXT.indexOf(ext) >= 0;
    if (type === 'novel') return NOVEL_EXT.indexOf(ext) >= 0;
    return VIDEO_EXT.indexOf(ext) >= 0;         // jav / anime / film / cartoon（round34）
}

function isTempName(name) {
    const lower = name.toLowerCase();
    for (const p of SKIP_PREFIX) if (name.startsWith(p)) return true;
    for (const e of SKIP_EXT) if (lower.endsWith(e)) return true;
    return false;
}

// ==================== 运行时状态 ====================

const S = {
    started: false,
    stopped: false,
    enabled: watchCfg().enabled !== false,      // 缺省即开

    baseIntervalMs: numOr(watchCfg().intervalMs, DEFAULTS.baseIntervalMs),
    intervalMs: numOr(watchCfg().intervalMs, DEFAULTS.baseIntervalMs),
    maxIntervalMs: Math.min(numOr(watchCfg().maxIntervalMs, DEFAULTS.maxIntervalMs), 3600000),
    maxPerTick: numOr(watchCfg().maxPerTick, DEFAULTS.maxPerTick),
    stableGapMs: numOr(watchCfg().stableGapMs, DEFAULTS.stableGapMs),

    mode: 'poll',           // 'event+poll' | 'poll'
    ticking: false,
    draining: false,
    queueLength: 0,

    ticks: 0,
    lastTickMs: 0,
    lastTickAt: null,
    lastReason: '',
    lastFound: 0,
    nextTickAt: null,

    foundTotal: 0,
    done: 0,
    failed: 0,
    unstableStreak: 0,
    recent: [],             // 最近 20 条发现

    eventAttached: 0,
    eventHits: 0,
    eventErrors: [],
    lastError: '',
    lastFile: ''
};

const MAX_ATTEMPTS = 3;     // 同一个文件最多重试几次；超过就本会话不再碰它

let timer = null;
let eventTimer = null;
const watchers = [];
const queue = [];
let known = new Set();
const attempts = new Map();  // path → 已尝试次数（仅记失败）

// ==================== 工具 ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _mods = {};
function lazy(name) {
    if (!_mods[name]) _mods[name] = require('./' + name);
    return _mods[name];
}

function humanMs(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.round(s / 60) + ' 分钟';
    const h = s / 3600;
    return (Math.abs(h - Math.round(h)) < 0.05 ? Math.round(h) : h.toFixed(1)) + ' 小时';
}

/**
 * 媒体根列表：由四个库的目录配置拼出来，带类型。
 * 类型的判定与 utils/poster-fetcher.js#detectTypeByPath 的优先级一致（按目录归属，不猜扩展名）。
 */
function getRoots() {
    const pairs = [
        ['jav', config.scanFolders],
        ['anime', config.animeFolders],
        ['comic', config.comicFolders],
        ['novel', config.novelFolders],
        ['film', config.filmFolders],       // round34 新四库
        ['cartoon', config.cartoonFolders]
    ];
    const out = [];
    for (const [type, folders] of pairs) {
        if (!typeEnabled(type)) continue;
        for (const dir of folders || []) {
            if (!dir) continue;
            out.push({ type, dir });
        }
    }
    return out;
}

/** 递归收集某根下的候选文件（EIO/EPERM 就地吞掉，绝不让一次坏目录杀掉整轮） */
function walk(dir, type, out, depth) {
    if (depth > 12) return;
    let items;
    try {
        items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return;
    }
    for (const it of items) {
        let full;
        try { full = path.join(dir, it.name); } catch (e) { continue; }
        if (it.isDirectory()) {
            walk(full, type, out, depth + 1);
            continue;
        }
        if (isTempName(it.name)) continue;
        if (!extMatches(type, it.name)) continue;
        out.push(full);
    }
}

/** 从库里重建「已知路径」集合。每轮开头刷一次，好跟手动扫描 / 启动扫描保持一致。 */
function refreshKnown() {
    try {
        const rows = lazy('db').db.prepare('SELECT filePath FROM movies').all();
        const set = new Set();
        for (const r of rows) if (r.filePath) set.add(r.filePath);
        known = set;
    } catch (e) {
        // 库读不动就保持上一轮的集合，下一轮再试；不因此清空（清空会导致全库重入队）
    }
}

/** 稳定判据：stat 两次，size + mtime 都没变才算「下载完成」 */
async function stableFilter(paths) {
    const sig = (st) => st.size + ':' + Math.round(st.mtimeMs);
    const first = new Map();
    for (const p of paths) {
        try { first.set(p, sig(fs.statSync(p))); } catch (e) { /* 读不到就本轮跳过 */ }
    }
    await sleep(S.stableGapMs);
    const ready = [];
    for (const [p, s0] of first) {
        try {
            if (sig(fs.statSync(p)) === s0) ready.push(p);
        } catch (e) { /* 期间被移走 */ }
    }
    return ready;
}

/**
 * 只做「发现」：walk 全树 → 与已知集合求差集 → 稳定判据过滤。
 * 不做任何入库 / 刮削，供外部（验收脚本、手动检查）单独调用。
 * @returns {Array<{path:string,type:string}>}
 */
async function collectCandidates(opts) {
    const o = opts || {};
    refreshKnown();
    const roots = o.roots || getRoots();
    const cands = [];
    const seen = new Set();
    for (const r of roots) {
        let exists = true;
        try { exists = fs.existsSync(r.dir); } catch (e) { exists = false; }
        if (!exists) continue;                       // 掉盘：跳过这个根，不动该根下的记录
        const files = [];
        walk(r.dir, r.type, files, 0);
        for (const f of files) {
            if (known.has(f)) continue;
            if (seen.has(f)) continue;               // 多个根重叠时去重
            seen.add(f);
            cands.push({ path: f, type: r.type });
        }
    }
    const capped = cands.slice(0, S.maxPerTick);
    if (!capped.length) return [];
    const ready = new Set(await stableFilter(capped.map(c => c.path)));
    return capped.filter(c => ready.has(c.path));
}

/** 别的扫描（启动扫描 / 手动全量 / 分库扫描）正在跑时不插一脚 */
function otherScanBusy() {
    try {
        const s = lazy('scanner');
        if (s.getScanStatus && s.getScanStatus().running) return true;
        if (s.getAnimeScanStatus && s.getAnimeScanStatus().running) return true;
        if (s.getRescrapeStatus && s.getRescrapeStatus().running) return true;
        if (s.getFilmScanStatus && s.getFilmScanStatus().running) return true;
        if (s.getCartoonScanStatus && s.getCartoonScanStatus().running) return true;
        const c = lazy('comic-scanner');
        if (c.getComicScanStatus && c.getComicScanStatus().running) return true;
        const n = lazy('novel-scanner');
        if (n.getNovelScanStatus && n.getNovelScanStatus().running) return true;
    } catch (e) { /* 状态读不动就当作不忙 */ }
    return false;
}

function pushRecent(c) {
    S.recent.unshift({
        path: c.path,
        name: path.basename(c.path),
        type: c.type,
        at: Date.now()
    });
    if (S.recent.length > 20) S.recent.pop();
}

// ==================== 入队与串行处理 ====================

async function runOne(job) {
    const p = job.path;
    S.lastFile = path.basename(p);
    if (job.type === 'anime') {
        await lazy('scanner').processSingleAnimeFile(p);
    } else if (job.type === 'comic') {
        await lazy('comic-scanner').processSingleComic(p);
    } else if (job.type === 'novel') {
        await lazy('novel-scanner').processSingleNovelFile(p);
    } else if (job.type === 'film' || job.type === 'cartoon') {
        // round34 新四库：影视/动漫走通用视频处理，searchMovie 按 type 分流刮削
        await lazy('scanner').processSingleFile(p, job.type);
    } else {
        await lazy('scanner').processSingleFile(p, 'jav');
    }
}

async function drain() {
    if (S.draining) return;
    S.draining = true;
    try {
        // 队列里有漫画/小说时，按配置重置「内容页兜底」预算（与 comic/novel 扫描器一致）
        if (queue.some(j => j.type === 'comic' || j.type === 'novel')) {
            try {
                const lim = config.autoContentCoverLimit;
                lazy('cover-fallback').resetInlineBudget(
                    lim === -1 ? Infinity : (Number(lim) >= 0 ? Number(lim) : 40)
                );
            } catch (e) { /* 预算重置失败不影响入库 */ }
        }
        while (queue.length) {
            const job = queue.shift();
            S.queueLength = queue.length;
            try {
                await runOne(job);
                S.done++;
                console.log(`[目录监控] 已入库: ${path.basename(job.path)}（${job.type}）`);
                // round34 批次B：发现新作 → 站内通知（用户可按偏好关闭）
                try {
                    require('./notify').notify('newItem', '📥 发现新作',
                        `「${path.basename(job.path)}」已自动入库（${job.type}）`,
                        { extra: { type: job.type, file: path.basename(job.path) } });
                } catch (e) { /* 通知失败不影响入库 */ }
            } catch (e) {
                S.failed++;
                const n = (attempts.get(job.path) || 0) + 1;
                attempts.set(job.path, n);
                console.log(`[目录监控] 处理失败(${n}/${MAX_ATTEMPTS}): ${job.path} → ${e && e.message}`);
            }
        }
    } finally {
        S.draining = false;
        S.queueLength = queue.length;
    }
}

// ==================== 一轮检查 ====================

async function runTick(reason) {
    if (!S.enabled || S.stopped) return 0;
    if (S.ticking) return 0;

    // 别的扫描在跑：本轮作废，但**不推进退避**（忙 ≠ 没新增）
    if (otherScanBusy()) {
        if (reason === 'poll') scheduleNext();
        return 0;
    }

    S.ticking = true;
    const t0 = Date.now();
    let found = 0;
    let hadCandidate = false;
    try {
        const cands = await collectCandidates();
        hadCandidate = cands.length > 0;
        for (const c of cands) {
            // 反复失败的文件（比如 0 字节 / 头部损坏的源文件）不再重试 —— 否则「有新增就重置间隔」
            // 会让它每轮都被重新入队，形成 5 秒一次的空转。本会话内放弃，重启应用后重新计数。
            if ((attempts.get(c.path) || 0) >= MAX_ATTEMPTS) continue;
            known.add(c.path);       // 立刻标记，天然幂等：重复事件不会重复入库
            queue.push(c);
            found++;
            S.foundTotal++;
            pushRecent(c);
        }
        S.queueLength = queue.length;
        if (queue.length) drain();   // 不 await：检查线程继续，入库在后台串行跑
    } catch (e) {
        S.lastError = (e && e.message) || String(e);
        console.log('[目录监控] 本轮异常:', S.lastError);
    } finally {
        S.ticking = false;
        S.ticks++;
        S.lastTickMs = Date.now() - t0;
        S.lastTickAt = Date.now();
        S.lastReason = reason;
        S.lastFound = found;

        // ★ 退避：没扫到新增 → 间隔翻倍（封顶 1h）；一有动静 → 立刻回到起始间隔
        if (found > 0) {
            S.intervalMs = S.baseIntervalMs;
            S.unstableStreak = 0;
        } else if (hadCandidate && S.unstableStreak < DEFAULTS.unstableGraceTicks) {
            // 有候选但没过稳定判据 = 正在下载。保持高频复核，别在这时候退避。
            S.unstableStreak++;
            S.intervalMs = S.baseIntervalMs;
        } else {
            S.intervalMs = Math.min(S.intervalMs * 2, S.maxIntervalMs);
        }
        if (reason === 'poll' || reason === 'manual' || found > 0) scheduleNext();
    }
    return found;
}

function scheduleNext() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!S.enabled || S.stopped) { S.nextTickAt = null; return; }
    S.nextTickAt = Date.now() + S.intervalMs;
    timer = setTimeout(() => { timer = null; runTick('poll'); }, S.intervalMs);
    if (timer.unref) timer.unref();     // 不阻止进程退出
}

// ==================== 事件通道 ====================

function attachWatchers() {
    detachWatchers();
    for (const r of getRoots()) {
        try {
            const w = fs.watch(r.dir, { recursive: true, persistent: false }, () => {
                S.eventHits++;
                if (!S.enabled || S.stopped) return;
                if (eventTimer) clearTimeout(eventTimer);
                eventTimer = setTimeout(() => { eventTimer = null; runTick('event'); }, DEFAULTS.eventDebounceMs);
                if (eventTimer && eventTimer.unref) eventTimer.unref();
            });
            w.on('error', () => { /* 单个根的 watcher 出错不影响其余；轮询仍在兜底 */ });
            watchers.push(w);
            S.eventAttached++;
        } catch (e) {
            S.eventErrors.push(r.dir + ': ' + ((e && e.message) || e));
        }
    }
    S.mode = S.eventAttached > 0 ? 'event+poll' : 'poll';
}

function detachWatchers() {
    for (const w of watchers) {
        try { w.close(); } catch (e) { /* 忽略 */ }
    }
    watchers.length = 0;
    S.eventAttached = 0;
    S.mode = 'poll';
}

// ==================== 对外接口 ====================

function start() {
    if (S.started) return S;
    S.started = true;
    S.stopped = false;
    refreshKnown();
    attachWatchers();
    console.log(`[目录监控] 已启动：${S.mode} 通道 | 起始间隔 ${humanMs(S.baseIntervalMs)}，无新增时翻倍，上限 ${humanMs(S.maxIntervalMs)}`);
    console.log(`[目录监控] 监控 ${getRoots().length} 个媒体根，库内已知 ${known.size} 条路径`);
    scheduleNext();
    return S;
}

function stop() {
    S.stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (eventTimer) { clearTimeout(eventTimer); eventTimer = null; }
    detachWatchers();
    S.nextTickAt = null;
}

function setEnabled(on) {
    S.enabled = !!on;
    if (S.enabled) {
        S.intervalMs = S.baseIntervalMs;
        scheduleNext();
    } else {
        if (timer) { clearTimeout(timer); timer = null; }
        S.nextTickAt = null;
    }
    return S.enabled;
}

/** 手动立即检查（前端「🔄 检查新增」按钮走这里） */
async function scanNow() {
    const found = await runTick('manual');
    // 手动检查后把节奏拉回起点：用户主动点了，说明他正在等结果
    S.intervalMs = S.baseIntervalMs;
    S.unstableStreak = 0;
    scheduleNext();
    return found;
}

function getStatus() {
    return {
        enabled: S.enabled,
        started: S.started,
        mode: S.mode,
        running: S.ticking || S.draining,
        queueLength: S.queueLength,

        baseIntervalMs: S.baseIntervalMs,
        intervalMs: S.intervalMs,
        maxIntervalMs: S.maxIntervalMs,
        intervalText: humanMs(S.intervalMs),
        maxIntervalText: humanMs(S.maxIntervalMs),
        nextTickAt: S.nextTickAt,
        nextTickInMs: S.nextTickAt ? Math.max(0, S.nextTickAt - Date.now()) : null,

        ticks: S.ticks,
        lastTickMs: S.lastTickMs,
        lastTickAt: S.lastTickAt,
        lastReason: S.lastReason,
        lastFound: S.lastFound,

        foundTotal: S.foundTotal,
        done: S.done,
        failed: S.failed,
        retryBlocked: Array.from(attempts.values()).filter(n => n >= MAX_ATTEMPTS).length,
        recent: S.recent.slice(0, 20),

        eventAttached: S.eventAttached,
        eventHits: S.eventHits,
        eventErrors: S.eventErrors.slice(0, 6),
        roots: getRoots().map(r => {
            let exists = false;
            try { exists = fs.existsSync(r.dir); } catch (e) { /* 视作不存在 */ }
            return { type: r.type, dir: r.dir, exists };
        }),
        lastError: S.lastError,
        lastFile: S.lastFile
    };
}

module.exports = {
    start,
    stop,
    setEnabled,
    scanNow,
    getStatus,
    collectCandidates,   // 只做发现，不入队（验收脚本用）
    getRoots,
    _state: S            // 仅供诊断脚本读取，业务代码不要依赖
};
