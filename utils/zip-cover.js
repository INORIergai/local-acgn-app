'use strict';
/**
 * round100：网盘压缩包封面抽取（Range 版，不下载整包）
 * 适用 epub / cbz / zip —— 它们都是 zip 容器：
 *   1. Range 读文件尾部 64KB → 定位 EOCD → 拿中央目录偏移/大小
 *   2. Range 读中央目录 → 枚举图片条目（跳过加密条目）
 *   3. Range 读首个图片条目的本地头 + 压缩数据 → store/deflate 解压 → 图片 Buffer
 * epub 优先取名字带 cover 的条目（封面规范），否则取首个图片；
 * 漫画包（cbz/zip）取偏移最靠前的条目（= 打包时的第一页）。
 * Zip64（>4GB / >65535 条目）不支持 → 返回 null 由调用方兜底。
 */

const zlib = require('zlib');

const MAX_CD_BYTES = 12 * 1024 * 1024;    // 中央目录大小上限
const MAX_IMG_BYTES = 40 * 1024 * 1024;   // 单图条目解压前上限（防异常数据）
const IMG_RE = /\.(jpe?g|png|webp|gif|avif)$/i;

/**
 * @param {object} opts
 * @param {number} opts.size        文件总字节数（file/list 里就有，不用再探测）
 * @param {(start:number,end:number)=>Promise<Buffer>} opts.fetchRange  Range 拉取（闭区间）
 * @param {boolean} [opts.epub]     epub 模式（封面命名优先）
 * @returns {Promise<Buffer|null>}  图片字节；失败/不支持返回 null
 */
async function extractZipCover(opts) {
    const size = Number(opts.size) || 0;
    const fetchRange = opts.fetchRange;
    if (!size || size < 200 || typeof fetchRange !== 'function') return null;

    try {
        // 1. 尾部 64KB+22 找 EOCD
        const tailLen = Math.min(size, 64 * 1024 + 22);
        const tail = await fetchRange(size - tailLen, size - 1);
        if (!tail || tail.length < 22) return null;
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) return null;
        const entries = tail.readUInt16LE(eocd + 10);
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        if (entries === 0xFFFF || cdOffset === 0xFFFFFFFF || cdSize <= 0 || cdSize > MAX_CD_BYTES) return null;
        if (cdOffset + cdSize > size) return null;

        // 2. 中央目录（若已整体落在 tail 内就不重复拉）
        const tailStart = size - tailLen;
        let cd;
        if (cdOffset >= tailStart) {
            cd = tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
        } else {
            cd = await fetchRange(cdOffset, cdOffset + cdSize - 1);
        }
        if (!cd || cd.length < 46) return null;

        // 3. 枚举图片条目
        const imgs = [];
        let p = 0;
        while (p + 46 <= cd.length) {
            if (cd.readUInt32LE(p) !== 0x02014b50) break;
            const flags = cd.readUInt16LE(p + 8);
            const method = cd.readUInt16LE(p + 10);
            const compSize = cd.readUInt32LE(p + 20);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            const lhOffset = cd.readUInt32LE(p + 42);
            const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
            p += 46 + nameLen + extraLen + commentLen;
            if (flags & 0x1) continue;                                  // 加密条目
            if (!IMG_RE.test(name)) continue;
            if (compSize <= 0 || compSize > MAX_IMG_BYTES) continue;
            imgs.push({ name, method, compSize, lhOffset });
        }
        if (!imgs.length) return null;

        // 4. 选条目：epub 封面命名优先；漫画取偏移最靠前（第一页）
        imgs.sort((a, b) => a.lhOffset - b.lhOffset);
        const pick = opts.epub ? (imgs.find(x => /cover/i.test(x.name)) || imgs[0]) : imgs[0];

        // 5. 本地头 → 数据起点 → 拉压缩数据 → 解压
        const lh = await fetchRange(pick.lhOffset, pick.lhOffset + 29);
        if (!lh || lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) return null;
        const nLen = lh.readUInt16LE(26);
        const eLen = lh.readUInt16LE(28);
        const dataStart = pick.lhOffset + 30 + nLen + eLen;
        if (dataStart + pick.compSize > size) return null;
        let data = await fetchRange(dataStart, dataStart + pick.compSize - 1);
        if (!data || data.length === 0) return null;
        if (pick.method === 8) data = zlib.inflateRawSync(data);
        else if (pick.method !== 0) return null;
        if (!data || data.length < 32) return null;
        return data;
    } catch (e) {
        return null;
    }
}

/**
 * 按路径抽取 zip 内单个条目（round101：EPUB 漫画页图片/资源）。
 * @param {object} opts 同 extractZipCover + { path: 'Images/001.jpg' }
 * @returns {Promise<Buffer|null>}
 */
async function extractZipEntryByPath(opts) {
    const size = Number(opts.size) || 0;
    const fetchRange = opts.fetchRange;
    const wanted = String(opts.path || '').replace(/^\/+/, '');
    if (!size || size < 200 || typeof fetchRange !== 'function' || !wanted) return null;
    const wantedLower = wanted.toLowerCase();

    try {
        const tailLen = Math.min(size, 64 * 1024 + 22);
        const tail = await fetchRange(size - tailLen, size - 1);
        if (!tail || tail.length < 22) return null;
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) return null;
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        if (cdOffset === 0xFFFFFFFF || cdSize <= 0 || cdSize > MAX_CD_BYTES) return null;
        if (cdOffset + cdSize > size) return null;

        const tailStart = size - tailLen;
        let cd;
        if (cdOffset >= tailStart) cd = tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
        else cd = await fetchRange(cdOffset, cdOffset + cdSize - 1);
        if (!cd || cd.length < 46) return null;

        // 中央目录找目标路径（大小写不敏感 + 尝试 URL 解码 + 后缀兜底：
        // 章节 HTML 里的相对路径解析出的绝对路径可能与 zip 内实际前缀不同层）
        let target = null;
        const wantSuffix = '/' + wantedLower;
        let p = 0;
        while (p + 46 <= cd.length) {
            if (cd.readUInt32LE(p) !== 0x02014b50) break;
            const flags = cd.readUInt16LE(p + 8);
            const method = cd.readUInt16LE(p + 10);
            const compSize = cd.readUInt32LE(p + 20);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            const lhOffset = cd.readUInt32LE(p + 42);
            const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
            p += 46 + nameLen + extraLen + commentLen;
            if (flags & 0x1) continue;
            const nameLower = name.toLowerCase().replace(/\\/g, '/');
            if (nameLower === wantedLower || nameLower === decodeURIComponent(wantedLower) || nameLower.endsWith(wantSuffix)) {
                target = { name, method, compSize, lhOffset };
                break;
            }
        }
        if (!target || target.compSize <= 0 || target.compSize > MAX_IMG_BYTES) return null;

        const lh = await fetchRange(target.lhOffset, target.lhOffset + 29);
        if (!lh || lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) return null;
        const nLen = lh.readUInt16LE(26);
        const eLen = lh.readUInt16LE(28);
        const dataStart = target.lhOffset + 30 + nLen + eLen;
        if (dataStart + target.compSize > size) return null;
        let data = await fetchRange(dataStart, dataStart + target.compSize - 1);
        if (!data || data.length === 0) return null;
        if (target.method === 8) data = zlib.inflateRawSync(data);
        else if (target.method !== 0) return null;
        return data;
    } catch (e) {
        return null;
    }
}

module.exports = { extractZipCover, extractZipEntryByPath };
