// ================================================================
// jellyfin-panel.js —— v6.5.0 第三档② Jellyfin 只读接入面板
//   挂 window.JellyfinPanel.open()；独立弹窗，不依赖设置页结构。
//   只读评估：配置 URL/Key → 测试连接 → 拉取片单预览，不写入本地库。
// ================================================================
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (u, o) => { const r = await fetch(u, Object.assign({ credentials: 'same-origin' }, o || {})); return r.json(); };
  const post = (u, b) => api(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

  function close() { const h = document.getElementById('jfHost'); if (h) h.innerHTML = ''; }

  async function open() {
    let host = document.getElementById('jfHost');
    if (!host) { host = document.createElement('div'); host.id = 'jfHost'; document.body.appendChild(host); }
    let st = await api('/api/jellyfin/status');
    st = (st && st.data) || {};
    host.innerHTML = '<div class="sv-modal-mask" data-close="1"><div class="sv-modal jf-modal" role="dialog" aria-modal="true">'
      + '<div class="sv-modal-head"><h3>📡 Jellyfin 接入（只读评估）</h3><button class="sv-modal-close" data-close="1">✕</button></div>'
      + '<div class="jf-body">'
      + '<div class="jf-hint">填写 Jellyfin 服务器地址与 API Key（设置 → 用户 → API Key），可测试连接并预览片单。<b>只读</b>：不会写入本地库、不下载、不双向同步。</div>'
      + '<div class="jf-row"><label>服务器地址</label><input id="jfUrl" type="text" placeholder="http://127.0.0.1:8096" value="' + esc(st.serverUrl || '') + '"></div>'
      + '<div class="jf-row"><label>API Key</label><input id="jfKey" type="password" placeholder="' + (st.hasKey ? '已保存，留空则不改' : '粘贴 API Key') + '" value=""></div>'
      + '<div class="jf-actions"><button class="btn btn-sm btn-secondary" data-act="jf-save">保存配置</button>'
      + '<button class="btn btn-sm btn-secondary" data-act="jf-test"' + (st.configured ? '' : ' disabled') + '>测试连接</button>'
      + '<button class="btn btn-sm" data-act="jf-items"' + (st.configured ? '' : ' disabled') + '>📋 预览片单</button></div>'
      + '<div class="jf-msg" id="jfMsg">' + (st.configured ? ('已配置：' + esc(st.serverUrl) + (st.connected ? ' · 连接正常' : '')) : '尚未配置') + '</div>'
      + '<div class="jf-items" id="jfItems"></div>'
      + '</div></div></div>';
    host.querySelectorAll('[data-close="1"]').forEach(el => el.addEventListener('click', e => {
      if (e.target === el || el.classList.contains('sv-modal-close')) close();
    }));
    host.querySelectorAll('[data-act^="jf-"]').forEach(btn => btn.addEventListener('click', () => onAct(btn.dataset.act)));
  }

  function msg(t, ok) { const m = document.getElementById('jfMsg'); if (m) { m.textContent = t; m.style.color = ok ? 'var(--primary)' : 'var(--danger, #e55)'; } }

  async function onAct(act) {
    const url = (document.getElementById('jfUrl') || {}).value || '';
    const key = (document.getElementById('jfKey') || {}).value || '';
    try {
      if (act === 'jf-save') {
        const r = await post('/api/jellyfin/config', { serverUrl: url, apiKey: key });
        msg(r && r.code === 0 ? '配置已保存' : (r && r.msg || '保存失败'), r && r.code === 0);
        return;
      }
      if (act === 'jf-test') {
        msg('测试中…', true);
        const r = await api('/api/jellyfin/status?test=1');
        const d = (r && r.data) || {};
        msg(d.connected ? ('连接成功：' + (d.serverName || '') + ' ' + (d.version || '')) : ('连接失败：' + (d.error || '')), d.connected);
        return;
      }
      if (act === 'jf-items') {
        msg('拉取片单中…', true);
        const r = await api('/api/jellyfin/items?limit=60');
        const list = (r && r.data) || [];
        const box = document.getElementById('jfItems');
        if (!box) return;
        if (!(r && r.code === 0)) { msg('拉取失败：' + (r && r.msg || ''), false); box.innerHTML = ''; return; }
        msg('共 ' + (r.total || list.length) + ' 项，预览前 ' + list.length + ' 项', true);
        box.innerHTML = list.map(it => '<div class="jf-item"><span class="jf-item-name">' + esc(it.name || '(无标题)') + '</span>'
          + '<span class="jf-item-meta">' + esc(it.type || '') + ' · ' + esc(it.series || '') + ' · ' + (it.runtimeMin || 0) + 'min</span></div>').join('')
          || '<div class="sv-empty">片单为空</div>';
      }
    } catch (e) { msg('请求异常：' + e.message, false); }
  }

  /** 注入入口按钮（幂等） */
  function injectButton() {
    if (document.getElementById('jfEntry')) return;
    const view = document.querySelector('[data-view="series"]') || document.getElementById('seriesView');
    if (!view) return;
    const btn = document.createElement('button');
    btn.id = 'jfEntry'; btn.className = 'sg-entry'; btn.type = 'button';
    btn.innerHTML = '📡 Jellyfin';
    btn.addEventListener('click', open);
    const bar = view.querySelector('.sv-head-actions');
    (bar || view).appendChild(btn);
  }

  window.JellyfinPanel = { open, close, injectButton };
})();
