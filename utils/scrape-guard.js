/**
 * 刮削熔断器（round112 新增）
 *
 * 为什么需要：round112 复盘发现漫画扫描「几千个文件永远扫不完」的最大单项原因
 *   不是解析慢，而是**每个文件都串行地等网络刮削失败**。
 *   kmoe / zlibrary 一旦不可用（登录态失效、代理挂了、站点换域名），
 *   单个文件的网络部分要烧掉 30~100 秒（15s 超时 × 重试 × 两种 URL 形态 × 换镜像），
 *   而 2351 个文件全部逐个去撞同一堵墙 —— 结果是一晚上只入库两三个文件。
 *
 * 这里的规则和电路保险丝一样：
 *   · 同一个源连续失败 N 次（默认 3）→ 本会话内**暂停**该源的网络刮削一段时间（默认 5 分钟）
 *   · 冷却期内 canTry() 返回 false，调用方直接走本地入库 / 内容页封面，一个请求都不发
 *   · 冷却结束后只放一发试探：成功就恢复正常，失败立刻重新熔断
 *   · 任何一次成功都会把失败计数清零（偶发抖动不会误伤正常源）
 *
 * 状态只活在内存里（重启归零），不写配置文件 —— 它描述的是「此刻这条网络能不能用」，
 * 不是一个需要用户维护的偏好。
 *
 * ⚠️ 与扫描「诚实性」铁律的关系（round110 的教训）：
 *   熔断只影响「要不要去联网刮元数据」，绝不影响「文件要不要入库」。
 *   扫描结果里必须能看出「因熔断而跳过了网络」，不能把跳过说成「没有新增」。
 */

const config = require('./config');

function scanCfg() { return (config && config.scan) || {}; }

function numOr(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
}

const THRESHOLD = () => Math.max(1, numOr(scanCfg().scrapeFailThreshold, 3));
const COOLDOWN_MS = () => Math.max(10000, numOr(scanCfg().scrapeCooldownMs, 5 * 60 * 1000));

/** 总开关：config.scan.networkEnrich === false 时，批量扫描一律不联网 */
function networkEnrichEnabled() {
    return scanCfg().networkEnrich !== false;
}

const S = new Map();   // source -> state

function entry(src) {
    let x = S.get(src);
    if (!x) {
        x = {
            source: src,
            streak: 0,          // 连续失败
            fails: 0,           // 累计失败
            oks: 0,             // 累计成功
            openUntil: 0,       // 熔断到什么时候
            openedTimes: 0,     // 熔断了几次
            lastError: '',
            lastAt: 0
        };
        S.set(src, x);
    }
    return x;
}

function isOpen(src) {
    const x = entry(src);
    return x.openUntil > Date.now();
}

/**
 * 这个源现在能联网吗？
 * @param {string} src 源名（kmoe / zlibrary / javbus …）
 * @returns {boolean}
 */
function canTry(src) {
    if (!networkEnrichEnabled()) return false;
    return !isOpen(src);
}

/** 记录一次成功：清零连续失败，解除熔断 */
function ok(src) {
    const x = entry(src);
    x.oks++;
    x.streak = 0;
    if (x.openUntil) {
        x.openUntil = 0;
        console.log(`[刮削熔断] ${src} 已恢复，网络刮削继续`);
    }
}

/**
 * 记录一次失败。连续失败到阈值就熔断。
 * @param {string} src
 * @param {Error|string} err
 * @returns {boolean} 本次调用是否触发了熔断
 */
function fail(src, err) {
    const x = entry(src);
    x.fails++;
    x.streak++;
    x.lastAt = Date.now();
    x.lastError = String((err && err.message) || err || '').slice(0, 200);
    if (x.streak >= THRESHOLD()) {
        const cool = COOLDOWN_MS();
        x.openUntil = Date.now() + cool;
        x.openedTimes++;
        x.streak = 0;
        console.log(`[刮削熔断] ${src} 连续失败 ${THRESHOLD()} 次（${x.lastError || '无详情'}），`
            + `暂停网络刮削 ${Math.round(cool / 60000)} 分钟；期间只做本地入库与内容页封面`);
        return true;
    }
    return false;
}

/** 剩余冷却毫秒（未熔断返回 0） */
function openRemaining(src) {
    const x = entry(src);
    return Math.max(0, x.openUntil - Date.now());
}

/** 给状态接口用的快照 */
function state() {
    const out = {
        networkEnrich: networkEnrichEnabled(),
        threshold: THRESHOLD(),
        cooldownMs: COOLDOWN_MS(),
        sources: {}
    };
    for (const [k, x] of S) {
        out.sources[k] = {
            open: x.openUntil > Date.now(),
            remainingMs: Math.max(0, x.openUntil - Date.now()),
            streak: x.streak,
            fails: x.fails,
            oks: x.oks,
            openedTimes: x.openedTimes,
            lastError: x.lastError
        };
    }
    return out;
}

/** 手动解除熔断（设置页「重新尝试网络刮削」用；目前仅内部/诊断脚本调用） */
function reset(src) {
    if (src) {
        const x = entry(src);
        x.streak = 0;
        x.openUntil = 0;
        return;
    }
    for (const x of S.values()) { x.streak = 0; x.openUntil = 0; }
}

/** 把异常翻译成「这个源还活着吗」的判断：网络层错误算源故障，业务层（搜不到）不算 */
function isSourceLevelError(e) {
    const m = String((e && e.message) || e || '');
    return /TLS|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|aborted|HTTP 5\d\d|需要登录|未登录|login|登录/i.test(m);
}

module.exports = {
    canTry,
    ok,
    fail,
    isOpen,
    openRemaining,
    state,
    reset,
    isSourceLevelError,
    networkEnrichEnabled,
    _state: S
};
