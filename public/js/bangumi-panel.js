// ================================================================
// bangumi-panel.js —— round173e Bangumi 同步设置面板
//   挂 window.BangumiPanel，由 app.js 的 switchSettingsGroup('bangumi') 触发 render()。
//   两种接入：①OAuth（填 client id/secret → 授权）；②手动 token（零门槛降级）。
// ================================================================
(function () {
    'use strict';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const api = async (url, opts) => { const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {})); return r.json(); };
    const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let state = null;

    function panel() { return document.getElementById('bangumiPanel'); }

    async function render() {
        const p = panel(); if (!p) return;
        p.innerHTML = '<div style="padding:24px;color:var(--text-muted);">加载中…</div>';
        const r = await api('/api/bangumi/status');
        state = (r && r.code === 0) ? r.data : {};
        p.innerHTML = html();
    }

    function html() {
        const connected = !!state.connected;
        const oauthCfg = !!state.oauthConfigured;
        return '<div class="bmp">'
            + '<div class="bmp-head"><div><h3>☁️ Bangumi 云同步</h3>'
            + '<p>把追番清单与观看进度同步到 Bangumi，看完自动上报，多设备不丢进度。</p></div>'
            + '<span class="bmp-badge ' + (connected ? 'on' : '') + '">' + (connected ? '● 已连接' : '○ 未连接') + '</span></div>'

            + '<div class="bmp-card">'
            + '<div class="bmp-card-title">1. 连接方式</div>'
            + '<div class="bmp-hint">方式 A（推荐）：在 <a href="https://bgm.tv/dev/app" target="_blank" rel="noopener">Bangumi 开发者后台</a> 创建应用，回调地址填 <code>' + esc(location.origin) + '/api/bangumi/callback</code>，把 Client ID / Secret 填在下面，点「去授权」。<br>'
            + '方式 B（零门槛）：直接在下方粘贴你的 Bangumi Access Token，保存即可同步（token 可在开发者后台生成）。</div>'
            + '<div class="bmp-row"><label>Client ID</label><input id="bmpClientId" class="settings-input" placeholder=" OAuth 应用的 Client ID " value="' + esc(state.clientId && !state.clientId.includes('*') ? state.clientId : '') + '"></div>'
            + '<div class="bmp-row"><label>Client Secret</label><input id="bmpSecret" class="settings-input" type="password" placeholder=" OAuth 应用的 Client Secret "></div>'
            + '<div class="bmp-actions">'
            + '<button class="btn btn-sm btn-secondary" data-act="save-creds">保存凭证</button>'
            + '<button class="btn btn-sm" data-act="authorize"' + (oauthCfg ? '' : ' disabled title="先保存 Client ID/Secret"') + '>去授权 ↗</button>'
            + '</div>'
            + '<div class="bmp-row" style="margin-top:12px;"><label>Access Token</label><input id="bmpToken" class="settings-input" type="password" placeholder=" 手动粘贴 access token（方式 B） "></div>'
            + '<div class="bmp-actions">'
            + '<button class="btn btn-sm btn-secondary" data-act="save-token">保存 Token</button>'
            + '<button class="btn btn-sm btn-secondary" data-act="verify"' + (connected ? '' : ' disabled') + '>验证连接</button>'
            + '<button class="btn btn-sm btn-secondary" data-act="disconnect"' + (connected ? '' : ' disabled') + '>断开</button>'
            + '</div>'
            + '<div class="bmp-msg" id="bmpMsg"></div>'
            + '</div>'

            + '<div class="bmp-card">'
            + '<div class="bmp-card-title">2. 同步进度</div>'
            + '<div class="bmp-hint">pull = 拉 Bangumi 收藏/进度到本地；push = 推本地进度到 Bangumi；同步 = 双向（冲突取较新）。'
            + ' 首次使用建议先 pull 建立基线。</div>'
            + '<div class="bmp-actions">'
            + '<button class="btn btn-sm btn-secondary" data-act="pull"' + (connected ? '' : ' disabled') + '>⇩ 从 Bangumi 拉取</button>'
            + '<button class="btn btn-sm btn-secondary" data-act="push"' + (connected ? '' : ' disabled') + '>⇧ 推送到 Bangumi</button>'
            + '<button class="btn btn-sm" data-act="sync"' + (connected ? '' : ' disabled') + '>⇄ 双向同步</button>'
            + '</div>'
            + '<div class="bmp-msg" id="bmpSyncMsg"></div>'
            + '</div>'
            + '</div>';
    }

    function msg(text, ok) {
        const el = document.getElementById('bmpMsg'); if (!el) return;
        el.textContent = text; el.className = 'bmp-msg ' + (ok ? 'ok' : 'err');
    }
    function syncMsg(text, ok) {
        const el = document.getElementById('bmpSyncMsg'); if (!el) return;
        el.textContent = text; el.className = 'bmp-msg ' + (ok ? 'ok' : 'err');
    }

    async function onClick(e) {
        const b = e.target.closest('[data-act]'); if (!b || !b.closest('.bmp')) return;
        const act = b.dataset.act;
        const busy = () => { b.disabled = true; };
        const free = () => { b.disabled = false; };
        try {
            if (act === 'save-creds') {
                busy();
                const r = await post('/api/bangumi/credentials', {
                    clientId: (document.getElementById('bmpClientId') || {}).value,
                    clientSecret: (document.getElementById('bmpSecret') || {}).value,
                });
                msg(r && r.code === 0 ? '凭证已保存，现在可以点「去授权」' : (r && r.msg || '保存失败'), r && r.code === 0);
                if (r && r.code === 0) render();
                free(); return;
            }
            if (act === 'save-token') {
                busy();
                const token = ((document.getElementById('bmpToken') || {}).value || '').trim();
                const r = await post('/api/bangumi/token', { token });
                msg(r && r.code === 0 ? 'Token 已保存，可以同步了' : (r && r.msg || '保存失败'), r && r.code === 0);
                if (r && r.code === 0) render();
                free(); return;
            }
            if (act === 'authorize') {
                busy();
                const r = await api('/api/bangumi/authorize');
                if (r && r.code === 0 && r.data && r.data.url) {
                    window.open(r.data.url, '_blank', 'noopener');
                    msg('已打开授权页，完成授权后回到这里点「验证连接」', true);
                } else msg(r && r.msg || '生成授权链接失败', false);
                free(); return;
            }
            if (act === 'verify') {
                busy();
                const r = await api('/api/bangumi/me');
                msg(r && r.code === 0 ? ('已连接：' + (r.data.nickname || r.data.username)) : (r && r.msg || '验证失败'), r && r.code === 0);
                free(); return;
            }
            if (act === 'disconnect') {
                busy();
                const r = await post('/api/bangumi/disconnect', {});
                msg(r && r.code === 0 ? '已断开 Bangumi' : '断开失败', r && r.code === 0);
                if (r && r.code === 0) render();
                free(); return;
            }
            if (['pull', 'push', 'sync'].includes(act)) {
                busy(); syncMsg('同步中，请稍候…', true);
                const r = await post('/api/bangumi/' + act, {});
                if (r && r.code === 0) {
                    const d = r.data || {};
                    const parts = [];
                    if (d.pulled) parts.push('拉取 ' + d.pulled.pulled + ' 部（新建 ' + d.pulled.created + '）');
                    if (d.pushed) parts.push('推送 ' + d.pushed.pushed + ' 部' + (d.pushed.errors && d.pushed.errors.length ? '，失败 ' + d.pushed.errors.length : ''));
                    if (!parts.length && d.pulled == null && d.pushed == null) parts.push('完成：' + (d.pulled || 0) + ' 拉 / ' + (d.pushed || 0) + ' 推');
                    syncMsg(parts.join('；') || '同步完成', true);
                } else syncMsg(r && r.msg || '同步失败', false);
                free(); return;
            }
        } catch (err) {
            msg('请求异常：' + err.message, false); free();
        }
    }

    document.addEventListener('click', onClick);
    window.BangumiPanel = { render };
})();
