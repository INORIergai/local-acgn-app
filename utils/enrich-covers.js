/**
 * 后台补封面任务（round112 新增）
 *
 * 定位：扫描的「第二阶段」。第一阶段（comic-scanner / novel-scanner 的 Phase A）
 *   只做本地入库，几秒钟就能让几千个文件在库里可见；封面这种「慢且可后补」的活
 *   放到这里在后台慢慢补，不阻塞扫描状态、不阻塞目录监控、不阻塞用户浏览。
 *
 * 特征：
 *   · 只做内容页取图（EPUB 内封面 / PDF 首页 / CBZ-ZIP 首图），**不联网**
 *     —— 扫描慢的病根就是「入库同步等网络」，这里绝不再犯
 *   · 并发可控（config.scan.coverConcurrency，默认 3；PDF 渲染走同一个 Chromium，
 *     并发太高会抢内存，3 路实测最稳）
 *   · 可中断可续跑：每次任务都从数据库「缺封面的记录」里查，中断后下次接着补
 *   · 本会话内同一个文件只试一次（attempted 集合），避免反复失败的文件占着队列空转
 *   · 幂等 + 单例：正在跑时再调用只记一个 pending 批次，跑完自动补跑（类型取并集）
 *
 * 网络元数据（标题/简介）不在这里做，见各扫描器的 enrichXxx({network:true})：
 * 那条路只在「单文件」路径上走，并且过 utils/scrape-guard.js 的熔断。
 */

const fs = require('fs');
const db = require('./db').db;
const { poolMap } = require('./pool');
const config = require('./config');

function coverConcurrency() {
    const n = Number(config.scan && config.scan.coverConcurrency);
    // 保留给外部读取/未来扩展；PDF 道固定串行（见 runBatch 注释：并发 2 会 OOM）
    return Number.isFinite(n) && n > 0 ? Math.min(n, 6) : 2;
}

/** 轻量道并发（EPUB/CBZ 只需同步解压，不吃外部内存） */
function LIGHT_CONC() {
    const n = Number(config.scan && config.scan.coverConcurrencyLight);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 8) : 4;
}

/** PDF 单本上限：超过就不自动补（**round112 起几乎用不到**：PDF 已改为分段喂给 pdf.js，
 *  单本内存从「整本」降到几 MB，实机 561MB 的扫描件也能 0.8s 出图。留着只挡 >2GB 的合订本） */
function PDF_MAX_MB() {
    const n = Number(config.scan && config.scan.coverPdfMaxMB);
    return Number.isFinite(n) && n > 0 ? n : 2048;
}

const VALID_TYPES = ['comic', 'novel'];

const S = {
    running: false,
    types: [],
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    current: '',
    startedAt: 0,
    endedAt: 0,
    elapsedMs: 0,
    lastReason: '',
    lastRound: null,
    pending: null       // { types:Set<string>, reason:string }
};

const attempted = new Set();   // 本会话已经试过的 filePath

function snapshot() {
    return {
        running: S.running,
        types: S.types.slice(),
        total: S.total,
        done: S.done,
        ok: S.ok,
        failed: S.failed,
        skipped: S.skipped,
        current: S.current,
        startedAt: S.startedAt,
        endedAt: S.endedAt,
        elapsedMs: S.elapsedMs,
        lastReason: S.lastReason,
        lastRound: S.lastRound,
        lightConcurrency: LIGHT_CONC(),
        pdfConcurrency: 1,
        pdfMaxMB: PDF_MAX_MB(),
        pending: S.pending ? Array.from(S.pending.types) : null
    };
}

/** 内容页取图只支持这几种容器（mobi/azw3/doc 等走不了，直接记跳过，不浪费尝试） */
/** 能出内容页封面的容器：EPUB/CBZ/ZIP/MOBI/AZW3 走轻量道，PDF 走重量道（渲染） */
const LIGHT_EXT = ['.epub', '.cbz', '.zip', '.mobi', '.azw3'];
const COVERABLE_EXT = ['.epub', '.pdf', '.cbz', '.zip', '.mobi', '.azw3'];

function extOf(p) {
    const m = /\.[^.\\/]+$/.exec(String(p || ''));
    return m ? m[0].toLowerCase() : '';
}

/** 查一批「缺封面」的记录 */
function pickRows(types, limit) {
    const list = (types && types.length ? types : VALID_TYPES).filter(t => VALID_TYPES.indexOf(t) >= 0);
    if (!list.length) return [];
    const ph = list.map(() => '?').join(',');
    let sql = `SELECT id, filePath, fileName, type FROM movies
                WHERE type IN (${ph})
                  AND (posterPath IS NULL OR TRIM(posterPath) = '')
                  AND COALESCE(posterLocked, 0) = 0
                ORDER BY id`;
    const rows = db.prepare(sql).all(...list);
    const lim = Number(limit) > 0 ? Number(limit) : 0;
    const out = [];
    for (const r of rows) {
        if (attempted.has(r.filePath)) continue;
        out.push(r);
        if (lim && out.length >= lim) break;
    }
    return out;
}

async function runBatch(types, reason) {
    S.running = true;
    S.types = types.slice();
    S.lastReason = reason || '';
    S.startedAt = Date.now();
    S.endedAt = 0;
    S.elapsedMs = 0;
    S.done = S.ok = S.failed = S.skipped = 0;
    S.current = '';

    const { autoCover } = require('./cover-fallback');
    let rows = [];
    try {
        rows = pickRows(types);
    } catch (e) {
        console.log('[补封面] 查询待补记录失败:', e.message);
    }
    S.total = rows.length;
    if (!rows.length) {
        S.running = false;
        S.endedAt = Date.now();
        S.elapsedMs = S.endedAt - S.startedAt;
        S.lastRound = { types: S.types.slice(), total: 0, ok: 0, failed: 0, skipped: 0, elapsedMs: S.elapsedMs };
        return snapshot();
    }

    /* ★★ 分两条道跑（round112 实机血案）：
     *   第一次上线时是「统一并发 2」，跑到第 150 张 PDF 封面时后端 **OOM 崩了**
     *   （server.log: FATAL ERROR: Zone Allocation failed，GC 日志显示 external memory pressure）。
     *   原因：PDF 封面渲染要把整本 PDF 读成 Buffer 喂给 Chromium，单本 100~200MB 很常见，
     *   两路并发 = 几百 MB 外部内存来回分配，V8 的 zone 分配器直接爆。
     *   ⇒ EPUB / CBZ / MOBI 走轻量道（同步解压或记录切片，<10ms）；
     *     PDF 走重量道（渲染，**并发 1**）。
     *   round112 二次修复：PDF 改为 **HTTP Range 分段**喂给 pdf.js（cover-fallback
     *   renderPdfFirstPage），单本峰值内存从「整本」降到几 MB —— 实测 561MB 扫描件 0.8s 出图、
     *   整批峰值 RSS 420MB（旧方案 802MB 且中途崩）。并发仍保持 1：瓶颈已变成 Chromium
     *   渲染 CPU，加并发只扩大崩溃面。 */
    const light = [];   // .epub / .cbz / .zip / .mobi / .azw3
    const heavy = [];   // .pdf（<= 上限，现在等于「除 2GB 以上合订本全都要」）
    const tooBig = [];
    for (const r of rows) {
        const ext = extOf(r.filePath);
        if (LIGHT_EXT.indexOf(ext) >= 0) { light.push(r); continue; }
        if (ext === '.pdf') {
            let mb = 0;
            try { mb = fs.statSync(r.filePath).size / 1048576; } catch (e) { mb = 0; }
            if (mb > PDF_MAX_MB()) tooBig.push({ row: r, mb });
            else heavy.push(r);
            continue;
        }
        tooBig.push({ row: r, mb: 0 });
    }

    console.log(`[补封面] 开始：${rows.length} 条缺封面（${types.join('/')}）`
        + `｜电子书 ${light.length} 条（EPUB/CBZ/MOBI，并发 ${LIGHT_CONC()}）`
        + `｜PDF ${heavy.length} 条（并发 1，分段读取）`
        + `｜跳过 ${tooBig.length} 条（${tooBig.filter(x => x.mb > 0).length} 本是超过 ${PDF_MAX_MB()}MB 的巨型 PDF，其余为 txt 等无内嵌封面格式）`);

    const onDone = (row, i, r) => {
        S.done++;
        if (r && r.skipped) S.skipped++;
        else if (r && r.ok) S.ok++;
        else S.failed++;
        if (S.done % 50 === 0 || S.done === S.total) {
            const sec = Math.max(0.001, (Date.now() - S.startedAt) / 1000);
            console.log(`[补封面] 进度 ${S.done}/${S.total}（成功 ${S.ok} 失败 ${S.failed} 跳过 ${S.skipped}，${(S.done / sec).toFixed(1)} 个/秒）`);
        }
    };

    const work = async (row) => {
        attempted.add(row.filePath);
        S.current = row.fileName || row.filePath;
        try {
            return await autoCover(db, row.id, { searchFirst: false });
        } catch (e) {
            return { ok: false, error: e.message };
        }
    };

    for (const x of tooBig) {
        attempted.add(x.row.filePath);
        S.done++;
        S.skipped++;
    }

    // 轻量道
    if (light.length) {
        let tick = 0;
        await poolMap(light, LIGHT_CONC(), async (row) => {
            const r = await work(row);
            /* ★ 必须主动让出事件循环：EPUB/MOBI 取图是「同步解压 + 同步写盘」，
             *   整条 await 链全是已 resolve 的 promise（微任务），不会回到 IO 阶段。
             *   2000+ 本连着跑就会把主线程按住十几秒 ⇒ 表现是「后端接口不可用」。
             *   每 32 条 setImmediate 一拍，HTTP 请求就能插进来。 */
            if ((++tick & 31) === 0) await new Promise(res => setImmediate(res));
            return r;
        }, onDone);
    }
    // 重量道（串行，中间让出一拍给 GC / Chromium 回收上下文）
    if (heavy.length) {
        await poolMap(heavy, 1, async (row) => {
            const r = await work(row);
            await new Promise(res => setTimeout(res, 60));
            return r;
        }, onDone);
    }

    S.running = false;
    S.endedAt = Date.now();
    S.elapsedMs = S.endedAt - S.startedAt;
    S.lastRound = {
        types: S.types.slice(), total: S.total, ok: S.ok, failed: S.failed, skipped: S.skipped,
        elapsedMs: S.elapsedMs
    };
    console.log(`[补封面] 完成：${S.total} 条，成功 ${S.ok} 失败 ${S.failed} 跳过 ${S.skipped}，耗时 ${(S.elapsedMs / 1000).toFixed(1)}s`);
    return snapshot();
}

/**
 * 启动补封面任务（单例）。
 * 正在跑的时候再调用不会排队重复跑，只把类型并进 pending，当前批结束后补跑一次。
 * @param {{types?:string[], reason?:string}} opts
 */
function startEnrich(opts) {
    const o = opts || {};
    const types = (o.types && o.types.length ? o.types : VALID_TYPES).filter(t => VALID_TYPES.indexOf(t) >= 0);
    if (!types.length) return Promise.resolve(snapshot());

    if (S.running) {
        const cur = S.pending || { types: new Set(), reason: o.reason || '' };
        for (const t of types) cur.types.add(t);
        S.pending = cur;
        return Promise.resolve(snapshot());
    }

    return runBatch(types, o.reason).catch(e => {
        S.running = false;
        console.log('[补封面] 任务异常:', e.message);
        return snapshot();
    }).then(res => {
        // 跑完看有没有攒下的批次
        if (S.pending) {
            const p = S.pending;
            S.pending = null;
            const merged = Array.from(p.types);
            setImmediate(() => { startEnrich({ types: merged, reason: p.reason || '补跑' }); });
        }
        return res;
    });
}

function getEnrichStatus() {
    return snapshot();
}

/** 仅供测试 / 维护脚本：清空「本会话已尝试」集合，让失败项可以再试一次 */
function resetAttempted() {
    attempted.clear();
}

module.exports = { startEnrich, getEnrichStatus, resetAttempted, _state: S };
