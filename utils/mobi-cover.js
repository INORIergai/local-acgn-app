/**
 * mobi-cover.js —— 从 MOBI / AZW3 里取内嵌封面（round112 新增）
 *
 * 背景：库里 mobi 419 本 + azw3 149 本，`buildContentCover` 对它们只会抛
 *      「不支持的文件类型: .mobi」→ 一键补封面跑完这批永远白框。
 *      而 MOBI/AZW3 的封面**根本没有压缩**：它就是 PDB 记录里的一段原始 JPEG/PNG，
 *      只要按 PDB 头 → 记录表 → EXTH(201/202) 定位到那条记录，直接切片即可。
 *      （text 记录才有 PalmDOC 压缩，图片记录没有。）
 *
 * 结构速查（全部小端）：
 *   PDB 头 78B：name[32] attributes(2) version(2) ... numRecords(2) @76
 *   记录表：78 起，每条 8B → offset(4) attributes+uid(4)
 *   record 0 = PalmDOC 头(16B) + MOBI 头：
 *       +0  "MOBI"        +4  headerLength
 *       +0x5C firstImageIndex      （为 0 时用 1+PalmDOC.recordCount 推算）
 *       +0x70 EXTH flags（bit 0x40 表示存在 EXTH）
 *   EXTH（紧接 MOBI 头）："EXTH" len(4) count(4)，随后每条 type(4) len(4) data
 *       type 201 = cover offset（相对 firstImageIndex）
 *       type 202 = thumbnail offset（封面缺失时的备用）
 *       type 203 = 1 表示「封面是假的/占位图」
 */

const fs = require('fs');

const SIGNATURES = [
    { magic: [0xff, 0xd8, 0xff], ext: 'jpg' },
    { magic: [0x89, 0x50, 0x4e, 0x47], ext: 'png' },
    { magic: [0x47, 0x49, 0x46, 0x38], ext: 'gif' },
    { magic: [0x42, 0x4d], ext: 'bmp' }
];

function sniffImage(buf) {
    if (!buf || buf.length < 16) return null;
    for (const s of SIGNATURES) {
        let hit = true;
        for (let i = 0; i < s.magic.length; i++) if (buf[i] !== s.magic[i]) { hit = false; break; }
        if (hit) return s.ext;
    }
    return null;
}

/**
 * 取 MOBI / AZW3 的内嵌封面。
 * @param {string} bookPath
 * @returns {Buffer} 图片原始字节
 */
function extractMobiCover(bookPath) {
    const st = fs.statSync(bookPath);
    if (st.size < 128) throw new Error('文件过小，不是有效的 MOBI');
    const fd = fs.openSync(bookPath, 'r');
    try {
        const readAt = (pos, len) => {
            if (!(len > 0) || !(pos >= 0)) return Buffer.alloc(0);   // 越界/空区间直接给空，别让 readSync 抛
            const b = Buffer.allocUnsafe(len);
            const n = fs.readSync(fd, b, 0, len, pos);
            return n === len ? b : b.subarray(0, n);
        };

        const header = readAt(0, 78);
        if (header.length < 78) throw new Error('PDB 头不完整');
        const type = header.toString('latin1', 60, 64);
        const creator = header.toString('latin1', 64, 68);
        if (creator !== 'MOBI' && type !== 'BOOK') throw new Error('不是 MOBI/AZW3（' + type + '/' + creator + '）');

        const numRecords = header.readUInt16BE(76);   // ⚠️ PDB 头是大端
        if (!numRecords || numRecords > 65535) throw new Error('记录数异常: ' + numRecords);

        const tableLen = numRecords * 8;
        const table = readAt(78, tableLen);
        if (table.length < tableLen) throw new Error('记录表被截断');
        const recOffsets = [];
        for (let i = 0; i < numRecords; i++) recOffsets.push(table.readUInt32BE(i * 8));
        const recEnd = i => (i + 1 < numRecords ? recOffsets[i + 1] : st.size);
        // 记录表里偶尔有越界偏移（下载不完整/第三方工具产物）→ 当作文件末尾，别让 readSync 抛 RangeError
        for (let i = 0; i < recOffsets.length; i++) {
            if (recOffsets[i] > st.size) recOffsets[i] = st.size;
        }

        // record 0：PalmDOC 头 + MOBI 头
        const r0len = Math.min(recEnd(0) - recOffsets[0], 1024);
        const r0 = readAt(recOffsets[0], r0len);
        if (r0.length < 24) throw new Error('record0 过短');

        const encryption = r0.readUInt16BE(12);
        if (encryption !== 0) throw new Error('DRM 加密（encryption=' + encryption + '），无法取封面');
        const textRecordCount = r0.readUInt16BE(8);

        const mOff = 16;
        if (r0.toString('latin1', mOff, mOff + 4) !== 'MOBI') throw new Error('缺少 MOBI 头（可能是纯 PalmDOC）');
        const mobiHeaderLen = r0.readUInt32BE(mOff + 4);
        if (mobiHeaderLen < 0x18 || mOff + mobiHeaderLen > r0.length) throw new Error('MOBI 头长度异常');

        // ⚠️ 每个定点读取都要先确认 record0 实际长度够，否则 Buffer.readUInt32BE 会抛 offset 越界
        //    （实测有 1 本文件 record0 比它自己声明的 MOBI 头还短）
        const canRead = (pos, len) => pos >= 0 && pos + len <= r0.length;
        const firstImageIndexRaw = (mobiHeaderLen >= 0x60 && canRead(mOff + 0x5C, 4)) ? r0.readUInt32BE(mOff + 0x5C) : 0;
        const exthFlags = (mobiHeaderLen >= 0x74 && canRead(mOff + 0x70, 4)) ? r0.readUInt32BE(mOff + 0x70) : 0;

        const firstImageIndex = firstImageIndexRaw > 0 ? firstImageIndexRaw : 1 + textRecordCount;

        let coverOffset = -1, thumbOffset = -1, fakeCover = false;
        if (exthFlags & 0x40) {
            const exthPos = mOff + mobiHeaderLen;
            if (exthPos + 12 <= r0.length && r0.toString('latin1', exthPos, exthPos + 4) === 'EXTH') {
                const exthLen = r0.readUInt32BE(exthPos + 4);
                const exthCount = r0.readUInt32BE(exthPos + 8);
                let p = exthPos + 12;
                const limit = Math.min(exthPos + exthLen, r0.length);
                for (let i = 0; i < exthCount && p + 8 <= limit; i++) {
                    const t = r0.readUInt32BE(p);
                    const len = r0.readUInt32BE(p + 4);
                    if (len < 8) break;
                    // 值本身要 4 字节 → 记录尾部被截断时只跳过不读（否则 Buffer 越界抛错）
                    const hasVal = p + 12 <= limit;
                    if (hasVal && t === 201) coverOffset = r0.readUInt32BE(p + 8);
                    else if (hasVal && t === 202) thumbOffset = r0.readUInt32BE(p + 8);
                    else if (hasVal && t === 203) fakeCover = r0.readUInt32BE(p + 8) !== 0;
                    p += len;
                }
            }
        }

        // 依次尝试：封面记录 → 缩略图记录（203 标记「封面是占位图」时优先缩略图）
        const tries = [];
        if (fakeCover && thumbOffset >= 0) tries.push(firstImageIndex + thumbOffset);
        if (coverOffset >= 0) tries.push(firstImageIndex + coverOffset);
        if (thumbOffset >= 0) tries.push(firstImageIndex + thumbOffset);

        for (const idx of tries) {
            if (!(idx >= 1 && idx < numRecords)) continue;
            const start = recOffsets[idx];
            const size = recEnd(idx) - start;
            if (!(size > 8192)) continue;                     // 太小的多半不是封面
            if (size > 12 * 1024 * 1024) continue;            // 单条 12MB 以上的不是封面
            const buf = readAt(start, size);
            if (sniffImage(buf)) return buf;
        }

        // 兜底（实测 46 本命中）：EXTH 里压根没有 201/202 的老式 MOBI，
        // 封面通常就是 firstImageIndex 处（或紧随其后）的第一张图。
        // 只看前 4 条、且必须是合法图片，避免把插图当封面乱贴。
        for (let idx = Math.max(1, firstImageIndex); idx < Math.min(numRecords, firstImageIndex + 4); idx++) {
            const start = recOffsets[idx];
            const size = recEnd(idx) - start;
            if (!(size > 8192) || size > 12 * 1024 * 1024) continue;
            const buf = readAt(start, size);
            if (sniffImage(buf)) return buf;
        }
        throw new Error(fakeCover ? 'EXTH 标记封面为占位图且无可用缩略图' : '未找到可用的封面记录（EXTH 无 201/202）');
    } finally {
        try { fs.closeSync(fd); } catch (e) { /* 忽略 */ }
    }
}

module.exports = { extractMobiCover, sniffImage };
