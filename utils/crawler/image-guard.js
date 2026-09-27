/**
 * 91动漫（图片走 pic.tuafjz.cn 等图床）封面解密。
 *
 * ★ 背景（2026-09-23 实测）：这些图床返回的**不是图片，是 AES-128-CBC 密文**。
 *   站点在页面里用内联脚本解密后再 createObjectURL 显示：
 *     var KEY = enc.encode('f5d965df75336270');
 *     var IV  = enc.encode('97b60394abc2fbe1');
 *     crypto.subtle.decrypt({ name: 'AES-CBC', iv: IV }, key, buf)
 *   元素上挂的是 `data-enc-src`（有 IntersectionObserver 才 reveal）。
 *   ⇒ 我们直接 HTTP 下载拿到的一定是密文，落盘后前端就是白框/破图。
 *   已实测：全库 19 个坏封面文件全部可由下面的 KEY/IV 还原成正常 JPEG/PNG（19/19）。
 *
 * 站点换密钥时，去详情页内联脚本里搜 `AES-CBC` 更新下面两个常量即可。
 */
const crypto = require('crypto');

const KEY = Buffer.from('f5d965df75336270', 'utf8'); // 16 字节 -> AES-128
const IV = Buffer.from('97b60394abc2fbe1', 'utf8');  // 16 字节

/** 判断一段 buffer 是不是真正的图片（按魔数，不看扩展名、不看 Content-Type） */
function isRealImage(buf) {
    if (!buf || buf.length < 12) return false;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;          // JPEG
    if (buf.slice(0, 4).toString('hex') === '89504e47') return true;                 // PNG
    if (buf.slice(0, 3).toString('ascii') === 'GIF') return true;                    // GIF
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
        buf.slice(8, 12).toString('ascii') === 'WEBP') return true;                  // WEBP
    if (buf.slice(4, 8).toString('ascii') === 'ftyp') return true;                   // HEIF/AVIF
    return false;
}

/** 识别真实格式，用于「扩展名和内容不一致」时改名 */
function imageKind(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.slice(0, 4).toString('hex') === '89504e47') return 'png';
    if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF') return 'webp';
    return null;
}

/** 尝试 AES-128-CBC 解密；不是密文或解出来不是图就返回 null */
function tryDecrypt(buf) {
    try {
        const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
        const plain = Buffer.concat([d.update(buf), d.final()]);
        return isRealImage(plain) ? plain : null;
    } catch (e) {
        return null;
    }
}

/**
 * 统一入口：确保拿到的是真图片。
 * 1) 已经是图片 -> 原样返回
 * 2) 是密文 -> 解密后返回
 * 3) 都不是 -> 返回 null（调用方应视为失败，**不要落盘**）
 */
function ensureRealImage(buf) {
    if (isRealImage(buf)) return buf;
    const plain = tryDecrypt(buf);
    if (plain) return plain;
    return null;
}

module.exports = { isRealImage, imageKind, tryDecrypt, ensureRealImage, KEY, IV };
