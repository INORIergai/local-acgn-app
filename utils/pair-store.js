/**
 * utils/pair-store.js — 手机扫码配对码仓库（进程内、不落盘）
 *
 * 电脑端签发 → 二维码带码 → 手机兑换会话。
 * 安全约束：32 字节随机、120 秒过期、单次使用。
 * 这里只有数据操作，不接触 req/res，便于复用与测试。
 */
const crypto = require('crypto');

const PAIR_CODE_TTL_MS = 120 * 1000;
const codes = new Map();   // pairCode -> expiresAt

setInterval(() => {
    const now = Date.now();
    for (const [c, exp] of codes) {
        if (now > exp) codes.delete(c);
    }
}, 60 * 1000).unref();

function issuePairCode() {
    const pairCode = crypto.randomBytes(32).toString('hex');
    codes.set(pairCode, Date.now() + PAIR_CODE_TTL_MS);
    return { pairCode, expiresIn: Math.round(PAIR_CODE_TTL_MS / 1000) };
}

/** 兑换即作废；过期/不存在都返回 false。 */
function consumePairCode(pairCode) {
    const code = String(pairCode || '').trim();
    if (!/^[a-f0-9]{64}$/.test(code)) return false;
    const exp = codes.get(code);
    if (!exp || Date.now() > exp) {
        codes.delete(code);
        return false;
    }
    codes.delete(code);
    return true;
}

module.exports = { issuePairCode, consumePairCode, PAIR_CODE_TTL_MS };
