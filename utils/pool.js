/**
 * 极简并发池（round112 新增）
 *
 * 为什么需要：漫画/小说扫描此前是「一个 for 循环 + await」的纯串行。
 *   本地入库那一段（stat / 读 nfo / 解 epub 封面 / 写库）每一步都是几毫秒到几十毫秒，
 *   串行跑 6000 个文件要几分钟；并发起来就是几十秒的事。
 *   注意：better-sqlite3 是同步 API，多个 async worker 里的写库调用仍在同一个
 *   线程上顺序执行，天然不会写冲突；这里并发的是「等待 IO」的时间，不是写事务。
 *
 * 语义：
 *   - 结果数组与输入同序（拿得到每条的结果）
 *   - 单条抛错不会中断整批，该位置返回 { __error: Error }
 *   - 绝不无限并发：limit 夹到 [1, n]
 *
 * @param {Array} items
 * @param {number} limit
 * @param {(item:any, index:number)=>Promise<any>} worker
 * @param {(item:any, index:number, result:any)=>void} [onEach] 每完成一条回调（打进度用）
 * @returns {Promise<Array>}
 */
async function poolMap(items, limit, worker, onEach) {
    const list = Array.isArray(items) ? items : [];
    const n = list.length;
    if (!n) return [];

    const conc = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, n));
    const results = new Array(n);
    let cursor = 0;

    async function runner() {
        while (true) {
            const i = cursor++;
            if (i >= n) return;
            let r;
            try {
                r = await worker(list[i], i);
            } catch (e) {
                r = { __error: e };
            }
            results[i] = r;
            if (typeof onEach === 'function') {
                try { onEach(list[i], i, r); } catch (e) { /* 进度回调出错不影响批处理 */ }
            }
        }
    }

    await Promise.all(Array.from({ length: conc }, runner));
    return results;
}

module.exports = { poolMap };
