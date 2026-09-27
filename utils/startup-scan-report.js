/**
 * ★ round26 #4：启动自动增量扫描的「可见报告」
 * ---------------------------------------------------------------------------
 * 用户原话：「没有打开程序之后自动扫描本地库增删的一个过程」。
 * 之前的实情是：`server.js` 启动后确实串行跑了四个库的快速增量扫描，
 * 顶栏也有一行「扫描中… n/N」，但**扫描结果没有任何呈现** ——
 * 用户不知道本次到底扫到了什么、新增了几部。
 *
 * 本模块只做一件事：把「本次启动扫描」的过程与结果记下来，供前端读取。
 *   · begin()/setCurrent()/endJob()/end()  —— 由 server.js 的启动任务调用
 *   · get()                                —— 由 GET /api/scanner/startup-report 返回
 * 不写库、不落盘，进程重启即重置（也正是「本次启动」的语义）。
 */

const MAX_ADDED = 500;

const state = {
    running: false,
    startedAt: 0,
    finishedAt: 0,
    current: '',          // 正在扫的库名（影片/动漫/漫画/小说）
    jobs: [],             // [{ name, added, total, error }]
    added: [],            // 本次新增的条目 [{id,title,fileName,type,addedTime}]
    addedTotal: 0
};

function begin() {
    state.running = true;
    state.startedAt = Date.now();
    state.finishedAt = 0;
    state.current = '';
    state.jobs = [];
    state.added = [];
    state.addedTotal = 0;
}

function setCurrent(name) {
    state.current = name || '';
}

/**
 * @param {string} name  库名
 * @param {{added?:number, addedRows?:Array, elapsedMs?:number, error?:string}} payload
 */
function endJob(name, payload) {
    const p = payload || {};
    const rows = Array.isArray(p.addedRows) ? p.addedRows : [];
    state.jobs.push({
        name: name,
        added: p.added || rows.length || 0,
        elapsedMs: p.elapsedMs || 0,
        error: p.error || ''
    });
    for (const r of rows) {
        if (state.added.length < MAX_ADDED) state.added.push(r);
    }
    state.addedTotal += (p.added || rows.length || 0);
}

function end() {
    state.running = false;
    state.current = '';
    state.finishedAt = Date.now();
}

function get() {
    return {
        running: state.running,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        elapsedMs: (state.finishedAt || Date.now()) - (state.startedAt || Date.now()),
        current: state.current,
        jobs: state.jobs,
        added: state.added,
        addedTruncated: state.addedTotal > state.added.length,
        addedTotal: state.addedTotal,
        ran: state.startedAt > 0
    };
}

module.exports = { begin, setCurrent, endJob, end, get };
