const fs = require('fs');
const path = require('path');

const _mobiCache = new Map();
const MAX_CACHE_BOOKS = 6;
const _mobiFileCache = new Map();
const MAX_FILE_CACHE = 2;

function decompressPalmDOC(buf) {
    const out = [];
    let i = 0;
    const len = buf.length;
    while (i < len) {
        const b = buf[i++];
        if (b === 0x00 || (b >= 0x09 && b <= 0x7f)) {
            out.push(b);
        } else if (b >= 0x01 && b <= 0x08) {
            for (let j = 0; j < b && i < len; j++) out.push(buf[i++]);
        } else if (b >= 0xc0) {
            out.push(0x20, b ^ 0x80);
        } else {
            if (i >= len) break;
            const b2 = buf[i++];
            const pair = (b << 8) | b2;
            const dist = (pair >> 3) & 0x07ff;
            const copyLen = (pair & 0x07) + 3;
            const start = out.length - dist;
            for (let j = 0; j < copyLen; j++) {
                const idx = start + j;
                out.push(idx >= 0 && idx < out.length ? out[idx] : 0x20);
            }
        }
    }
    return Buffer.from(out);
}

function buildHuffDecoder(getRec, huffRecOff, huffRecCnt) {
    if (!huffRecOff || !huffRecCnt || huffRecCnt < 2) return null;
    const huff = getRec(huffRecOff);
    if (!huff || huff.length < 24 || huff.subarray(0, 4).toString('latin1') !== 'HUFF') return null;
    const off1 = huff.readUInt32BE(16);
    const off2 = huff.readUInt32BE(20);
    const dict1 = new Array(256);
    for (let i = 0; i < 256; i++) {
        const v = huff.readUInt32LE(off1 + i * 4);
        const clen = v & 0x1f;
        const term = !!(v & 0x80);
        const maxc = clen ? (((v >>> 8) + 1) * Math.pow(2, 32 - clen) - 1) >>> 0 : 0;
        dict1[i] = { codelen: clen, term, maxcode: maxc };
    }
    const mincode = [0];
    const maxcode = [0];
    for (let i = 1; i <= 32; i++) {
        const vMin = huff.readUInt32LE(off2 + (i - 1) * 8);
        const vMax = huff.readUInt32LE(off2 + (i - 1) * 8 + 4);
        mincode.push((vMin * Math.pow(2, 32 - i)) >>> 0);
        maxcode.push((((vMax + 1) * Math.pow(2, 32 - i)) - 1) >>> 0);
    }
    const dictionary = [];
    for (let i = 1; i < huffRecCnt; i++) {
        const cdic = getRec(huffRecOff + i);
        if (!cdic || cdic.length < 16 || cdic.subarray(0, 4).toString('latin1') !== 'CDIC') continue;
        const hdrLen = cdic.readUInt32BE(4);
        const numEntries = cdic.readUInt32BE(8);
        const codeLen = cdic.readUInt32BE(12);
        const n = Math.min(numEntries - dictionary.length, 1 << codeLen);
        for (let j = 0; j < n; j++) {
            const off = cdic.readUInt16BE(hdrLen + j * 2);
            const blen = cdic.readUInt16BE(hdrLen + (off & 0x7fff));
            const start = hdrLen + (off & 0x7fff) + 2;
            const slice = cdic.subarray(start, start + (blen & 0x7fff));
            dictionary.push({ slice, flag: !!(blen & 0x8000) });
        }
    }

    function unpack(data, depth = 0) {
        if (depth > 16 || !data || !data.length) return Buffer.alloc(0);
        let bitsLeft = data.length * 8;
        const padded = Buffer.alloc(data.length + 8);
        data.copy(padded);
        let pos = 0;
        let x = padded.readBigUInt64BE(pos);
        let n = 32;
        const out = [];
        while (true) {
            if (n <= 0) {
                pos += 4;
                if (pos + 8 > padded.length) break;
                x = padded.readBigUInt64BE(pos);
                n += 32;
            }
            const code = Number((x >> BigInt(n)) & 0xffffffffn) >>> 0;
            const d1 = dict1[code >>> 24];
            let clen = d1.codelen;
            let maxc = d1.maxcode;
            if (!d1.term) {
                while ((code >>> 0) < (mincode[clen] >>> 0) && clen < 32) clen++;
                maxc = maxcode[clen];
            }
            if (!clen) break;
            n -= clen;
            bitsLeft -= clen;
            if (bitsLeft < 0) break;
            const rIdx = Math.floor(((maxc >>> 0) - (code >>> 0)) / Math.pow(2, 32 - clen));
            const entry = dictionary[rIdx];
            if (!entry) break;
            if (!entry.flag) {
                entry.slice = Buffer.from(unpack(entry.slice, depth + 1));
                entry.flag = true;
            }
            out.push(entry.slice);
        }
        return Buffer.concat(out);
    }
    return unpack;
}

function trimTrailingEntries(data, extraFlags) {
    if (!extraFlags || !data || !data.length) return data;
    let end = data.length;
    for (let f = 15; f >= 1; f--) {
        if (extraFlags & (1 << f)) {
            let sz = 0;
            let shift = 0;
            while (end > 0) {
                const b = data[--end];
                sz |= (b & 0x7f) << shift;
                shift += 7;
                if (b & 0x80) break;
            }
            end -= (sz - (shift / 7));
        }
    }
    if ((extraFlags & 1) && end > 0) {
        end -= (data[end - 1] & 3) + 1;
    }
    return data.subarray(0, Math.max(0, end));
}

function decodeBufferText(buf, encoding) {
    if (encoding === 65001) return buf.toString('utf8');
    try {
        const iconv = require('iconv-lite');
        if (encoding === 1252) return iconv.decode(buf, 'win1252');
        if (encoding === 936) return iconv.decode(buf, 'gbk');
    } catch (_) { }
    return buf.toString('utf8');
}

function stripHtmlToPlain(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function cleanMobiChapterHtml(rawHtml, novelId) {
    if (!rawHtml) return '';
    let html = String(rawHtml);
    html = html
        .replace(/<\?xml[^>]*\?>/gi, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<(script|style|title)[\s\S]*?<\/\1>/gi, '')
        .replace(/<(script|style|link|meta|mbp:frameset)[^>]*\/?>/gi, '')
        .replace(/<\/?(html|body|mbp:frameset|mbp:slave-frame)[^>]*>/gi, '');

    // 将 SVG <image xlink:href="kindle:embed:0001..."> 转为标准 <img>
    html = html.replace(/<svg[^>]*>[\s\S]*?<image[^>]+(?:xlink:href|href)\s*=\s*["']([^"']+)["'][^>]*\/?>[\s\S]*?<\/svg>/gi, (_, href) => {
        return `<img src="${href}" class="epub-illust" loading="lazy">`;
    });

    // 改写 MOBI recindex="00001" 与 KF8 kindle:embed:0001 图片引用
    html = html.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
        let idx = null;
        const recMatch = attrs.match(/\brecindex\s*=\s*["']?0*(\d+)["']?/i);
        if (recMatch) {
            idx = parseInt(recMatch[1], 10);
        } else {
            const embedMatch = attrs.match(/\bsrc\s*=\s*["']kindle:embed:([0-9a-zA-Z]+)(?:\?[^"']*)?["']/i);
            if (embedMatch) {
                idx = parseInt(embedMatch[1], 10) || parseInt(embedMatch[1], 32);
            }
        }
        if (idx && idx > 0 && novelId != null) {
            return `<img src="/api/novel/${encodeURIComponent(novelId)}/mobi-image/${idx}" class="epub-illust" loading="lazy">`;
        }
        return full;
    });

    // 清除 kindle:pos / kindle:flow 内部伪链接，保留可读文字
    html = html.replace(/<a\b[^>]*href\s*=\s*["'](?:kindle:|filepos)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, '$1');
    return html.trim();
}

function extractTitleFromChunk(html, plain, fallbackIdx) {
    const hMatch = html.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
    if (hMatch) {
        const t = stripHtmlToPlain(hMatch[1]).replace(/\s+/g, ' ').trim();
        if (t && t.length <= 60 && !/^(unknown|未知|未命名|untitled)$/i.test(t)) return t;
    }
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
        const t = stripHtmlToPlain(titleMatch[1]).replace(/\s+/g, ' ').trim();
        if (t && t.length <= 60 && !/^(unknown|未知|未命名|untitled)$/i.test(t)) return t;
    }
    const lines = plain.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length > 0 && lines[0].length <= 48) {
        return lines[0];
    }
    return `第 ${fallbackIdx} 节`;
}

function splitHtmlIntoChapters(fullHtml, novelId) {
    // 1. 先按 KF8 多文档边界 <!DOCTYPE / <html 或 MOBI <mbp:pagebreak/> 切分
    const rawParts = fullHtml
        .replace(/<mbp:pagebreak\s*\/?>/gi, '\n<!--CV_SPLIT-->\n')
        .replace(/<(?:div|hr|p)[^>]*page-break-(?:before|after)\s*:\s*always[^>]*\/?>/gi, '\n<!--CV_SPLIT-->\n')
        .replace(/<!DOCTYPE\s+html/gi, '\n<!--CV_SPLIT--><!DOCTYPE html')
        .split('<!--CV_SPLIT-->');

    const chapters = [];
    for (const raw of rawParts) {
        const cleaned = cleanMobiChapterHtml(raw, novelId);
        if (!cleaned) continue;
        const plain = stripHtmlToPlain(cleaned);
        const hasImg = /<img\b/i.test(cleaned);
        if (!plain && !hasImg) continue;

        // 若单段超长（>24000字）且内部含有多个 <h1>/<h2> 或「第X章」，继续按标题细分
        if (plain.length > 24000) {
            const subParts = cleaned
                .replace(/(<h[1-4]\b[^>]*>)/gi, '<!--CV_SUB-->$1')
                .replace(/(<p[^>]*>\s*(?:第[一二三四五六七八九十百千万零〇0-9]+[章回节卷集部篇]|Chapter\s+\d+|[一二三四五六七八九十]{1,3}、|[0-9]{1,2}\s*[\.、])[^\n<]{0,35}<\/p>)/gi, '<!--CV_SUB-->$1')
                .split('<!--CV_SUB-->');
            if (subParts.length > 1) {
                for (const sp of subParts) {
                    const spPlain = stripHtmlToPlain(sp);
                    const spImg = /<img\b/i.test(sp);
                    if (!spPlain && !spImg) continue;
                    chapters.push({
                        title: extractTitleFromChunk(sp, spPlain, chapters.length + 1),
                        content: sp.trim(),
                        text: spPlain,
                        html: true
                    });
                }
                continue;
            }
            // 若无显式标题但单章超过 24000 字，按段落边界每 ~8000 字切分为阅读小节
            const paras = cleaned.split(/(?=<p\b)/i);
            if (paras.length > 10) {
                let bufHtml = '';
                let bufPlain = '';
                for (const p of paras) {
                    const pPlain = stripHtmlToPlain(p);
                    bufHtml += p;
                    bufPlain += (bufPlain ? '\n' : '') + pPlain;
                    if (bufPlain.length >= 8000) {
                        chapters.push({
                            title: extractTitleFromChunk(bufHtml, bufPlain, chapters.length + 1),
                            content: bufHtml.trim(),
                            text: bufPlain,
                            html: true
                        });
                        bufHtml = '';
                        bufPlain = '';
                    }
                }
                if (bufPlain || /<img\b/i.test(bufHtml)) {
                    chapters.push({
                        title: extractTitleFromChunk(bufHtml, bufPlain, chapters.length + 1),
                        content: bufHtml.trim(),
                        text: bufPlain,
                        html: true
                    });
                }
                continue;
            }
        }

        chapters.push({
            title: extractTitleFromChunk(raw, plain, chapters.length + 1),
            content: cleaned,
            text: plain,
            html: true
        });
    }

    // 合并过短碎片段（例如纯标题页后紧跟正文），但保留独立封面页
    if (chapters.length === 0) {
        const fallbackPlain = stripHtmlToPlain(fullHtml);
        if (fallbackPlain) {
            chapters.push({
                title: '正文',
                content: cleanMobiChapterHtml(fullHtml, novelId) || `<p>${fallbackPlain}</p>`,
                text: fallbackPlain,
                html: true
            });
        }
    }
    return chapters;
}

function parseMobiOrAzw3(filePath, novelId) {
    const stat = fs.statSync(filePath);
    const cacheKey = `${filePath}::${stat.mtimeMs}::${novelId || ''}`;
    if (_mobiCache.has(cacheKey)) {
        return _mobiCache.get(cacheKey);
    }

    const buf = fs.readFileSync(filePath);
    const numRecords = buf.readUInt16BE(76);
    const offsets = new Array(numRecords);
    for (let i = 0; i < numRecords; i++) {
        offsets[i] = buf.readUInt32BE(78 + i * 8);
    }
    const getRec = (idx) => {
        if (idx < 0 || idx >= numRecords) return null;
        const start = offsets[idx];
        const end = idx + 1 < numRecords ? offsets[idx + 1] : buf.length;
        return start < end ? buf.subarray(start, end) : Buffer.alloc(0);
    };

    let baseRec = 0;
    let r0 = getRec(0);
    let recCount = r0.readUInt16BE(8);
    // 兼容 Combo MOBI6+KF8 头部存根
    if (recCount <= 2) {
        for (let i = 1; i < numRecords - 1; i++) {
            const r = getRec(i);
            if (r && r.length === 8 && r.toString('latin1') === 'BOUNDARY') {
                const cand = getRec(i + 1);
                if (cand && cand.length >= 132 && cand.subarray(16, 20).toString('latin1') === 'MOBI') {
                    baseRec = i + 1;
                    r0 = cand;
                    recCount = r0.readUInt16BE(8);
                    break;
                }
            }
        }
    }

    const compression = r0.readUInt16BE(0);
    const encryption = r0.readUInt16BE(12);
    if (encryption !== 0) {
        return {
            title: path.basename(filePath, path.extname(filePath)),
            isEpub: true,
            chapters: [{
                title: 'DRM 加密保护提示',
                content: '<p>该电子书带有 DRM 加密保护，暂无法直接解码正文。</p>',
                text: '该电子书带有 DRM 加密保护，暂无法直接解码正文。',
                html: true
            }]
        };
    }

    const encoding = r0.length >= 32 ? r0.readUInt32BE(28) : 65001;
    const fullNameOff = r0.length >= 92 ? r0.readUInt32BE(84) : 0;
    const fullNameLen = r0.length >= 92 ? r0.readUInt32BE(88) : 0;
    const firstImageIdx = r0.length >= 112 ? r0.readUInt32BE(108) : 0;
    const huffRecOff = r0.length >= 120 ? r0.readUInt32BE(112) : 0;
    const huffRecCnt = r0.length >= 120 ? r0.readUInt32BE(116) : 0;
    const extraFlags = r0.length >= 244 ? r0.readUInt16BE(242) : 0;

    let bookTitle = path.basename(filePath, path.extname(filePath));
    if (fullNameOff > 0 && fullNameLen > 0 && fullNameOff + fullNameLen <= r0.length) {
        const t = decodeBufferText(r0.subarray(fullNameOff, fullNameOff + fullNameLen), encoding).trim();
        if (t) bookTitle = t;
    }

    let huffUnpack = null;
    if (compression === 17480) {
        huffUnpack = buildHuffDecoder((idx) => getRec(baseRec + idx), huffRecOff, huffRecCnt);
    }

    const textChunks = [];
    for (let i = 1; i <= recCount; i++) {
        const rawRec = getRec(baseRec + i);
        if (!rawRec || !rawRec.length) continue;
        const trimmed = trimTrailingEntries(rawRec, extraFlags);
        if (compression === 1) {
            textChunks.push(trimmed);
        } else if (compression === 2) {
            textChunks.push(decompressPalmDOC(trimmed));
        } else if (compression === 17480 && huffUnpack) {
            textChunks.push(huffUnpack(trimmed));
        }
    }

    const fullTextBuf = Buffer.concat(textChunks);
    const fullHtml = decodeBufferText(fullTextBuf, encoding);
    const chapters = splitHtmlIntoChapters(fullHtml, novelId);

    const result = {
        title: bookTitle,
        isEpub: true,
        firstImageIdx: baseRec + firstImageIdx,
        chapters
    };

    if (_mobiCache.size >= MAX_CACHE_BOOKS) {
        const oldestKey = _mobiCache.keys().next().value;
        _mobiCache.delete(oldestKey);
    }
    _mobiCache.set(cacheKey, result);
    return result;
}

function readMobiImage(filePath, imageIndex1Based) {
    try {
        const stat = fs.statSync(filePath);
        const key = `${filePath}::${stat.mtimeMs}`;
        let cached = stat.size <= 60 * 1024 * 1024 ? _mobiFileCache.get(key) : null;
        if (!cached) {
            const buf = fs.readFileSync(filePath);
            const numRecords = buf.readUInt16BE(76);
            const offsets = new Array(numRecords);
            for (let i = 0; i < numRecords; i++) {
                offsets[i] = buf.readUInt32BE(78 + i * 8);
            }
            cached = { buf, offsets };
            if (stat.size <= 60 * 1024 * 1024) {
                if (_mobiFileCache.size >= MAX_FILE_CACHE) {
                    _mobiFileCache.delete(_mobiFileCache.keys().next().value);
                }
                _mobiFileCache.set(key, cached);
            }
        }
        const buf = cached.buf;
        const offsets = cached.offsets;
        const numRecords = offsets.length;
        const getRec = (idx) => {
            if (idx < 0 || idx >= numRecords) return null;
            const start = offsets[idx];
            const end = idx + 1 < numRecords ? offsets[idx + 1] : buf.length;
            return start < end ? buf.subarray(start, end) : null;
        };
        const r0 = getRec(0);
        const firstImageIdx = r0 && r0.length >= 112 ? r0.readUInt32BE(108) : 0;
        if (!firstImageIdx) return null;

        // imageIndex1Based 在 KF8 kindle:embed:0001 中从 1 开始计数，跳过非图像记录（如 FONT/RESC/FDST）
        let targetIdx = firstImageIdx + (imageIndex1Based - 1);
        let rec = getRec(targetIdx);
        const detectMime = (b) => {
            if (!b || b.length < 4) return null;
            if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
            if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
            if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
            if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
            return null;
        };
        let mime = detectMime(rec);
        if (mime) return { buffer: rec, mime };

        // 若 firstImageIdx 附近混有非图片记录，按第 N 张真实图片顺序查找
        let seen = 0;
        for (let i = firstImageIdx; i < numRecords; i++) {
            const cand = getRec(i);
            const m = detectMime(cand);
            if (m) {
                seen++;
                if (seen === imageIndex1Based) return { buffer: cand, mime: m };
            }
        }
        return null;
    } catch (_) {
        return null;
    }
}

module.exports = {
    parseMobiOrAzw3,
    readMobiImage
};
