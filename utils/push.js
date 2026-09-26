/**
 * 消息推送（Bark / Telegram）
 *
 * 新作监控落库通知的同时，把消息推到手机。
 * 配置读取 config.json 的 push 节点（设置页可改）：
 *   "push": {
 *     "barkUrl":   "https://api.day.app/你的Key",   // 可选
 *     "tgBotToken": "123:abc",                     // 可选
 *     "tgChatId":  "123456789"                     // 可选
 *   }
 * 两者都未配置时静默跳过。代理沿用 network.proxyServer。
 */
const config = require('./config');

const TIMEOUT = 10000;

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function pushBark(title, body, url) {
    const base = (config.push && config.push.barkUrl || '').replace(/\/+$/, '');
    if (!base) return;
    const params = new URLSearchParams();
    if (url) params.set('url', url);
    const target = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(body || '')}` +
        (params.toString() ? `?${params}` : '');
    await fetchWithTimeout(target);
}

async function pushTelegram(title, body, url) {
    const token = config.push && config.push.tgBotToken;
    const chatId = config.push && config.push.tgChatId;
    if (!token || !chatId) return;
    const text = `<b>${escapeHtml(title)}</b>\n${escapeHtml(body || '')}` +
        (url ? `\n${url}` : '');
    const agent = config.network?.proxyServer
        ? new (require('https-proxy-agent').HttpsProxyAgent)(config.network.proxyServer)
        : undefined;
    await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: !url
        }),
        ...(agent ? { agent } : {})
    });
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 推送一条通知（不抛异常，推送失败只打日志）
 */
async function push(title, body, url) {
    const targets = [];
    if (config.push?.barkUrl) targets.push('bark');
    if (config.push?.tgBotToken && config.push?.tgChatId) targets.push('telegram');
    if (!targets.length) return;

    for (const t of targets) {
        try {
            if (t === 'bark') await pushBark(title, body, url);
            else await pushTelegram(title, body, url);
        } catch (e) {
            console.log(`[推送] ${t} 失败:`, e.message);
        }
    }
}

module.exports = { push };
