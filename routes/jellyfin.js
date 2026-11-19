// ================================================================
// routes/jellyfin.js —— v6.5.0 第三档② Jellyfin 只读接入评估
//   GET  /api/jellyfin/status  配置状态 + 可选连接测试
//   POST /api/jellyfin/config  保存 serverUrl / apiKey
//   GET  /api/jellyfin/items   拉取媒体列表（只读、限量）
//   ★ 只读评估：不写入本地库、不下载、不做双向同步（那是后续大工程）。
//     配置存 config.jellyfin，复用现有 config 保存机制。
// ================================================================
const express = require('express');
const router = express.Router();
const config = require('../utils/config');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

function cfg() {
  return (config.jellyfin = config.jellyfin || { serverUrl: '', apiKey: '' });
}

async function jfGet(pathname, params = {}) {
  const c = cfg();
  if (!c.serverUrl || !c.apiKey) throw new Error('未配置 Jellyfin 服务器或 API Key');
  const url = new URL(c.serverUrl.replace(/\/$/, '') + pathname);
  url.searchParams.set('api_key', c.apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const opts = { timeout: config.network?.timeout || 15000, headers: { 'X-Emby-Token': c.apiKey } };
  const proxy = config.network?.proxyServer;
  if (proxy && /^https:/i.test(c.serverUrl)) opts.agent = new HttpsProxyAgent(proxy);
  const r = await fetch(url.href, opts);
  const text = await r.text();
  if (!r.ok) throw new Error(`Jellyfin HTTP ${r.status}: ${text.slice(0, 100)}`);
  return JSON.parse(text);
}

router.get('/status', async (req, res) => {
  const c = cfg();
  const out = { configured: !!(c.serverUrl && c.apiKey), serverUrl: c.serverUrl || '', hasKey: !!c.apiKey, connected: false, error: '' };
  if (out.configured && String(req.query.test || '') === '1') {
    try { const sys = await jfGet('/System/Info'); out.connected = true; out.serverName = sys.ServerName || ''; out.version = sys.Version || ''; }
    catch (e) { out.error = e.message; }
  }
  res.json({ code: 0, data: out });
});

router.post('/config', (req, res) => {
  try {
    const c = cfg();
    c.serverUrl = String(req.body.serverUrl || '').trim().replace(/\/$/, '');
    c.apiKey = String(req.body.apiKey || '').trim();
    // 通过 utils/config 的 save 持久化（若提供）；失败不阻断内存态
    try { require('../utils/config').save && require('../utils/config').save(); } catch (e) {}
    res.json({ code: 0, data: { configured: !!(c.serverUrl && c.apiKey), serverUrl: c.serverUrl } });
  } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/items', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60));
    const r = await jfGet('/Items', {
      Recursive: true, Limit: limit, Fields: 'Path,Size,RunTimeTicks,ProviderIds',
      IncludeItemTypes: 'Movie,Episode', SortBy: 'DateCreated', SortOrder: 'Descending'
    });
    const items = (r.Items || []).map(it => ({
      id: it.Id, name: it.Name, type: it.Type, path: it.Path || '',
      size: it.Size || 0, runtimeMin: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 600000000) : 0,
      year: it.ProductionYear || 0, series: it.SeriesName || ''
    }));
    res.json({ code: 0, data: items, total: r.TotalRecordCount || items.length });
  } catch (e) { res.json({ code: -1, msg: e.message, data: [] }); }
});

module.exports = router;
