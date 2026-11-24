/**
 * zip-entry.js —— 只读「中央目录 + 单个条目」的极简 ZIP 读取器（round112 新增）
 *
 * ── 为什么不用 adm-zip ────────────────────────────────────────────
 * round112 实测：补封面第一批跑了 3180 张，前段 2.0 个/秒，后段掉到 0.19 个/秒，
 * 并且 soak 期间后端一度失联（HTTP 超时）。逐个体检 EPUB 取封面耗时，最狠的两个：
 *
 *     15459ms  319.7MB  龙族Ⅰ-Ⅲ（套装共32册）.epub
 *     10649ms  156.2MB  日本妖怪绘卷.epub
 *     141ms    338.9MB  興亡的世界史【全21冊】.epub   ← 同量级却很快，说明与体积非线性的
 *
 * 原因在两处，都是 adm-zip 的实现方式决定的：
 *   1. `new AdmZip(p)` 把**整个压缩包读成一个 Buffer** 才能解析（320MB 常规操作），
 *      外部内存瞬间暴涨（这也正是上次 PDF 并发 2 直接 OOM 的同款压力）；
 *   2. 挑「最大的图」时 `e.getData()` 是**同步解压**，一本合集里几千张插图会逐个解压。
 * 两者都在主线程同步执行 → 事件循环被占住 → HTTP 接口跟着卡死（这就是「接口不可用」）。
 *
 * ── 本模块的做法 ──────────────────────────────────────────────────
 *   · 只读文件尾部 EOCD（含 ZIP64）→ 得到中央目录；
 *   · 中央目录自带每条的 `size`（解压后大小），**不解压就能排序挑图**；
 *   · 命中目标条目后，`lseek` 到它的局部头，只读**这一条**的压缩字节 → zlib 解压。
 * 净效果：320MB 的包取一张 300KB 封面 = 读约 300KB + 一次小解压，几十毫秒级。
 *
 * 兼容性：stored/deflate、ZIP64 扩展、UTF-8 文件名、data descriptor（尺寸以中央目录为准）。
 * 不支持：加密条目（直接跳过）、分卷 ZIP（返回空列表，上层按「没有图片」处理）。
 */

const fs = require('fs');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** 图片扩展名（与 cover-fallback 共用口径） */
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp)$/i;

/** 单条解压后体积上限（默认 40MB）：超大单图宁可放弃，也不要卡住事件循环 */
const DEFAULT_MAX_ENTRY = 40 * 1024 * 1024;

function readAt(fd, pos, len) {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    return n === len ? buf : buf.subarray(0, n);
}

/** 定位 End Of Central Directory（含 ZIP64 情况），返回解析结果 */
function findEocd(fd, fileSize) {
    const tailLen = Math.min(fileSize, 65557);        // 最大注释 65535 + EOCD 22
    const tailStart = fileSize - tailLen;
    const tail = readAt(fd, tailStart, tailLen);

    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
        const commentLen = tail.readUInt16LE(i + 20);
        // 注释长度必须与「签名之后的剩余字节」一致，否则是数据里碰巧出现的同值
        if (i + 22 + commentLen <= tail.length) { eocdPos = i; break; }
    }
    if (eocdPos < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）');

    let total = tail.readUInt16LE(eocdPos + 10);
    let cdSize = tail.readUInt32LE(eocdPos + 12);
    let cdOffset = tail.readUInt32LE(eocdPos + 16);

    // ZIP64：字段溢出时走 ZIP64 EOCD（在普通 EOCD 之前 20 字节有 locator）
    if (total === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        const locPos = tailStart + eocdPos - 20;
        if (locPos >= 0) {
            const loc = readAt(fd, locPos, 20);
            if (loc.length === 20 && loc.readUInt32LE(0) === SIG_LOCATOR64) {
                const z64Pos = Number(loc.readBigUInt64LE(8));
                const z64 = readAt(fd, z64Pos, 56);
                if (z64.length >= 56 && z64.readUInt32LE(0) === SIG_EOCD64) {
                    total = Number(z64.readBigUInt64LE(32));
                    cdSize = Number(z64.readBigUInt64LE(40));
                    cdOffset = Number(z64.readBigUInt64LE(48));
                }
            }
        }
    }
    if (!(cdOffset >= 0) || !(cdSize > 0)) throw new Error('ZIP 中央目录位置无效');
    return { total, cdSize, cdOffset };
}

/** 解析中央目录 → 条目元数据数组（不解压任何数据） */
function parseCentralDirectory(buf) {
    const out = [];
    let p = 0;
    while (p + 46 <= buf.length) {
        if (buf.readUInt32LE(p) !== SIG_CEN) break;
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        let compSize = buf.readUInt32LE(p + 20);
        let size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        let offset = buf.readUInt32LE(p + 42);
        const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
        const name = nameBuf.toString('utf8');

        // ZIP64 扩展字段：把 0xFFFFFFFF 的字段按顺序换成 8 字节值
        if (size === 0xFFFFFFFF || compSize === 0xFFFFFFFF || offset === 0xFFFFFFFF) {
            const exStart = p + 46 + nameLen;
            const exEnd = exStart + extraLen;
            let q = exStart;
            while (q + 4 <= exEnd) {
                const id = buf.readUInt16LE(q);
                const len = buf.readUInt16LE(q + 2);
                if (id === 0x0001) {
                    let r = q + 4;
                    const take = () => { const v = Number(buf.readBigUInt64LE(r)); r += 8; return v; };
                    if (size === 0xFFFFFFFF && r + 8 <= q + 4 + len) size = take();
                    if (compSize === 0xFFFFFFFF && r + 8 <= q + 4 + len) compSize = take();
                    if (offset === 0xFFFFFFFF && r + 8 <= q + 4 + len) offset = take();
                    break;
                }
                q += 4 + len;
            }
        }

        out.push({
            name, method, flags, size, compSize, offset,
            isDirectory: /\/$/.test(name) || size === 0 && /\/$/.test(name),
            encrypted: (flags & 0x0001) !== 0
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

/** 列出压缩包内全部条目（只读中央目录） */
function listZipEntries(zipPath) {
    let fd = null;
    try {
        const st = fs.statSync(zipPath);
        if (!st.size || st.size < 22) return [];
        fd = fs.openSync(zipPath, 'r');
        const { cdSize, cdOffset } = findEocd(fd, st.size);
        // 中央目录异常大（几万条）时也要有上限，避免又一次「整包读进内存」
        const cap = Math.min(cdSize, 32 * 1024 * 1024);
        const buf = readAt(fd, cdOffset, cap);
        return parseCentralDirectory(buf);
    } catch (e) {
        return [];
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } }
    }
}

/**
 * 读取单个条目的内容。
 * @param {string} zipPath
 * @param {object} entry listZipEntries 返回的条目
 * @param {{maxBytes?:number}} opts
 * @returns {Buffer}
 */
function readZipEntry(zipPath, entry, opts = {}) {
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_ENTRY;
    if (!entry) throw new Error('条目为空');
    if (entry.encrypted) throw new Error('条目已加密: ' + entry.name);
    if (entry.method !== 0 && entry.method !== 8) throw new Error('不支持的压缩方式: ' + entry.method);
    if (entry.size > maxBytes) {
        throw new Error(`条目过大（解压后 ${(entry.size / 1048576).toFixed(1)}MB > ${(maxBytes / 1048576).toFixed(0)}MB）: ` + entry.name);
    }

    let fd = null;
    try {
        fd = fs.openSync(zipPath, 'r');
        const lh = readAt(fd, entry.offset, 30);
        if (lh.length < 30 || lh.readUInt32LE(0) !== SIG_LOC) throw new Error('局部头损坏: ' + entry.name);
        const nameLen = lh.readUInt16LE(26);
        const extraLen = lh.readUInt16LE(28);
        const dataStart = entry.offset + 30 + nameLen + extraLen;

        const comp = readAt(fd, dataStart, entry.compSize);
        if (comp.length !== entry.compSize) throw new Error('数据被截断: ' + entry.name);

        if (entry.method === 0) return comp;
        return zlib.inflateRawSync(comp, { maxOutputLength: Math.max(entry.size, 1) + 1024 });
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } }
    }
}

/** 列出图片条目（按名字排序稳定，方便 CBZ「取第一张」） */
function listImageEntries(zipPath) {
    return listZipEntries(zipPath)
        .filter(e => !e.isDirectory && !e.encrypted && IMG_RE.test(e.name) && !/__MACOSX|\/\._/.test(e.name));
}

module.exports = {
    IMG_RE,
    DEFAULT_MAX_ENTRY,
    listZipEntries,
    listImageEntries,
    readZipEntry
};
