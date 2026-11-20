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
            + '<div class="bmp-hint">pull = 拉 Bangumi 收藏/进度到本地；push = 推本地进度到 Bangumi；同步 = 双向。'
            + ' 首次使用建议先 pull 建立基线。</div>'
            + '<div class="bmp-strategy"><label>双向同步冲突策略</label>'
            + '<select id="bmpStrategy"><option value="newer">合并 · 较新者优先（推荐）</option>'
            + '<option value="local">保留本地 · 只推不拉</option>'
            + '<option value="remote">用云端 · 只拉不推</option></select></div>'
            + '<div class="bmp-actions">'
            + '<button class="btn btn-sm btn-secondary" data-act="pull"' + (connected ? '' : ' disabled') + '>⇩ 从 Bangumi 拉取</button>'
            + '<button class="btn btn-sm btn-secondary" data-act="push"' + (connected ? '' : ' disabled') + '>⇧ 推送到 Bangumi</button>'
            + '<button class="btn btn-sm" data-act="sync"' + (connected ? '' : ' disabled') + '>⇄ 双向同步</button>'
            + '<button class="btn btn-sm btn-secondary" data-act="diff"' + (connected ? '' : ' disabled') + '>🔀 逐条对比</button>'
            + '</div>'
            + '<div class="bmp-diff" id="bmpDiff"></div>'
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

    // ---------- round185 B2：逐条对比 ----------
    let diffRows = [];
    let diffChoice = new Map();   // idx -> 'local' | 'remote'

    function renderDiff(res) {
        const box = document.getElementById('bmpDiff');
        if (!box) return;
        if (!res || res.code !== 0 || !res.data) {
            box.innerHTML = '<div class="bmp-diff-empty">对比失败：' + esc((res && res.msg) || '未知错误') + '</div>';
            return;
        }
        const d = res.data;
        diffRows = d.rows || [];
        diffChoice = new Map();
        if (!diffRows.length) {
            box.innerHTML = '<div class="bmp-diff-empty">本地与 Bangumi 完全一致（远端 ' + (d.remoteCount || 0) +
                ' 部 / 本地 ' + (d.localCount || 0) + ' 部），没有需要处理的冲突。</div>';
            return;
        }
        diffRows.forEach((r, i) => { diffChoice.set(i, r.suggested || 'local'); });

        const kindLabel = { conflict: '冲突', remoteOnly: '云端独有', localOnly: '本地独有' };
        box.innerHTML = '<div class="bmp-diff-head">发现 ' + diffRows.length + ' 条差异（冲突 ' +
            ((d.counts && d.counts.conflict) || 0) + ' · 云端独有 ' + ((d.counts && d.counts.remoteOnly) || 0) +
            ' · 本地独有 ' + ((d.counts && d.counts.localOnly) || 0) + '）——逐条选保留哪边：</div>'
            + diffRows.map((r, i) => {
                const localTxt = r.localStatus
                    ? ('本地：' + (r.localStatusLabel || r.localStatus) + ' · 看到第 ' + (r.localEp || 0) + ' 集')
                    : '本地：无';
                const remoteTxt = r.remoteStatus
                    ? ('云端：' + (r.remoteStatusLabel || r.remoteStatus) + ' · 看到第 ' + (r.remoteEp || 0) + ' 集')
                    : '云端：无';
                return '<div class="bmp-diff-row" data-idx="' + i + '">'
                    + '<div class="bmp-diff-title"><span class="bmp-diff-kind">' + (kindLabel[r.kind] || r.kind) + '</span>'
                    + esc(r.title || '') + '</div>'
                    + '<div class="bmp-diff-meta">' + esc(localTxt) + '<i>·</i>' + esc(remoteTxt) + '</div>'
                    + '<div class="bmp-diff-btns">'
                    + '<button class="bmp-pick" data-act="pick" data-idx="' + i + '" data-side="local">保留本地</button>'
                    + '<button class="bmp-pick" data-act="pick" data-idx="' + i + '" data-side="remote">用云端</button>'
                    + '</div></div>';
            }).join('')
            + '<div class="bmp-diff-foot"><button class="btn btn-sm" data-act="apply-diff">应用全部选择</button>'
            + '<span class="bmp-diff-count" id="bmpDiffCount"></span></div>';
        paintChoice();
    }

    function paintChoice() {
        document.querySelectorAll('#bmpDiff .bmp-diff-row').forEach((row) => {
            const i = Number(row.dataset.idx);
            const side = diffChoice.get(i);
            row.querySelectorAll('.bmp-pick').forEach((b) => {
                b.classList.toggle('active', b.dataset.side === side);
            });
            row.dataset.side = side || '';
        });
        const c = document.getElementById('bmpDiffCount');
        if (c) c.textContent = '已选 ' + diffRows.length + ' 条（本地 ' +
            Array.from(diffChoice.values()).filter((v) => v === 'local').length + ' / 云端 ' +
            Array.from(diffChoice.values()).filter((v) => v === 'remote').length + '）';
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
            if (act === 'diff') {
                busy(); syncMsg('正在比对 Bangumi 与本地…', true);
                const r = await api('/api/bangumi/diff');
                renderDiff(r);
                syncMsg(r && r.code === 0 ? '对比完成，请逐条选择' : ((r && r.msg) || '对比失败'), !!(r && r.code === 0));
                free(); return;
            }
            if (act === 'pick') {
                const i = Number(b.dataset.idx);
                diffChoice.set(i, b.dataset.side);
                paintChoice();
                return;
            }
            if (act === 'apply-diff') {
                if (!diffRows.length) return;
                busy();
                const items = diffRows.map((r, i) => Object.assign({}, r, { choice: diffChoice.get(i) || 'local' }));
                syncMsg('正在应用 ' + items.length + ' 条选择…', true);
                const r = await post('/api/bangumi/apply', { items });
                if (r && r.code === 0) {
                    const d = r.data || {};
                    syncMsg('已应用 ' + (d.applied || 0) + ' 条' +
                        (d.failed ? ('，失败 ' + d.failed + ' 条：' + (d.details || []).filter(x => !x.ok).map(x => x.title).slice(0, 3).join('、')) : ''),
                        !d.failed);
                    const box = document.getElementById('bmpDiff');
                    if (box) box.innerHTML = '<div class="bmp-diff-empty">已应用。可再点「逐条对比」复查是否还有差异。</div>';
                } else syncMsg((r && r.msg) || '应用失败', false);
                free(); return;
            }
            if (['pull', 'push', 'sync'].includes(act)) {
                busy(); syncMsg('同步中，请稍候…', true);
                const strategyEl = document.getElementById('bmpStrategy');
                const body = (act === 'sync' && strategyEl) ? { strategy: strategyEl.value } : {};
                const r = await post('/api/bangumi/' + act, body);
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
