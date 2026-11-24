/* ============================================================
   CinemaVault · source-picker.js —— 插件商店（在线源开关）
   ------------------------------------------------------------
   对齐 Kazumi 的「插件商店」：列出全部在线源规则，可搜索、按类型筛选、
   单个启停、全选/全不选、检查 Kazumi 规则更新。
   勾选状态落盘到 data/media-sources/prefs.json。
   入口：
     window.SourcePicker.open()            // 打开面板
     window.SourcePicker.bindButton(el)    // 把某个按钮绑成入口
   ============================================================ */
(function (global) {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const TIER_LABEL = { 0: '主力', 1: '备用', 2: '扩展', 3: '更多', 4: '补充', 9: '其它' };
    const FACTORY_LABEL = {
        'kazumi': 'Kazumi 规则',
        'web-selector': '网页规则',
        'json-api': 'JSON 接口',
        'rss': 'BT/RSS',
    };

    let host = null;
    let cache = null;
    let filterQ = '';
    let filterFac = '';
    let freshness = null;

    function ensureHost() {
        if (host && document.body.contains(host)) return host;
        host = document.createElement('div');
        host.id = 'sourcePickerHost';
        document.body.appendChild(host);
        return host;
    }

    function close() {
        if (host) host.innerHTML = '';
        document.removeEventListener('keydown', onKey, true);
    }

    function onKey(e) {
        if (e.key === 'Escape') close();
    }

    async function api(path, opts) {
        const o = Object.assign({ credentials: 'same-origin' }, opts || {});
        if (o.body && typeof o.body === 'string') {
            o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
        }
        const r = await fetch(path, o);
        return r.json();
    }

    function rowHtml(s) {
        const tier = TIER_LABEL[s.tier] || ('T' + s.tier);
        const fac = FACTORY_LABEL[s.factory] || s.factory || '';
        return '<label class="sp-row" data-id="' + esc(s.id) + '">'
            + '<input type="checkbox" class="sp-check" data-id="' + esc(s.id) + '"' + (s.enabled ? ' checked' : '') + '>'
            + '<span class="sp-name">' + esc(s.name) + '</span>'
            + '<span class="sp-tag">' + esc(tier) + '</span>'
            + (fac ? '<span class="sp-fac">' + esc(fac) + '</span>' : '')
            + '<span class="sp-host">' + esc(s.host || '') + '</span>'
            + '</label>';
    }

    async function render() {
        const h = ensureHost();
        h.innerHTML = '<div class="sp-mask"><div class="sp-panel" role="dialog" aria-modal="true">'
            + '<div class="sp-head"><h3>🧩 插件商店</h3>'
            + '<div class="sp-actions"><button class="sp-btn" data-sp="refresh-rules">↻ 检查规则更新</button>'
            + '<button class="sp-btn" data-sp="all">全选</button>'
            + '<button class="sp-btn" data-sp="none">全不选</button>'
            + '<button class="sp-close" data-sp="close">✕</button></div></div>'
            + '<div class="sp-toolbar"><input id="spSearch" type="search" placeholder="搜索源名称 / 域名 / 类型…" autocomplete="off">'
            + '<div class="sp-chips" id="spChips"></div></div>'
            + '<div class="sp-hint" id="spHint">勾选后，追番搜源 / 点集搜源只问你选中的源。关掉的源随时可再打开。</div>'
            + '<div class="sp-body" id="spBody"><div class="sp-empty">加载中…</div></div>'
            + '<div class="sp-foot"><span id="spCount"></span>'
            + '<button class="sp-btn sp-save" data-sp="reload">↻ 重新读取</button></div>'
            + '</div></div>';

        h.querySelector('[data-sp="close"]').onclick = close;
        h.querySelector('.sp-mask').addEventListener('click', (e) => {
            if (e.target.classList.contains('sp-mask')) close();
        });
        h.querySelector('[data-sp="all"]').onclick = () => toggleAll(true);
        h.querySelector('[data-sp="none"]').onclick = () => toggleAll(false);
        h.querySelector('[data-sp="reload"]').onclick = () => { cache = null; render(); };
        const search = h.querySelector('#spSearch');
        if (search) {
            search.value = filterQ;
            search.addEventListener('input', () => {
                filterQ = search.value.trim().toLowerCase();
                paint();
            });
        }
        h.querySelector('#spChips').addEventListener('click', (e) => {
            const b = e.target.closest('[data-fac]');
            if (!b) return;
            filterFac = b.getAttribute('data-fac') || '';
            paint();
        });
        const ruleBtn = h.querySelector('[data-sp="refresh-rules"]');
        if (ruleBtn) {
            ruleBtn.onclick = async () => {
                const old = ruleBtn.textContent;
                ruleBtn.disabled = true;
                ruleBtn.textContent = '检查中…';
                try {
                    const r = await api('/api/media-source/refresh-kazumi', {
                        method: 'POST', body: JSON.stringify({}),
                    });
                    if (!r || r.code !== 0) throw new Error((r && r.msg) || '更新失败');
                    if (window.showNotification) window.showNotification('规则更新', r.msg || '已检查');
                    cache = null;
                    await render();
                } catch (e) {
                    if (window.showNotification) window.showNotification('规则更新失败', e.message);
                    ruleBtn.disabled = false;
                    ruleBtn.textContent = old;
                }
            };
        }
        document.addEventListener('keydown', onKey, true);

        try {
            const [r, fresh] = await Promise.all([
                api('/api/media-source/prefs'),
                api('/api/media-source/kazumi-freshness').catch(() => null),
            ]);
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '读取失败');
            cache = (r.data && r.data.sources) || [];
            freshness = (fresh && fresh.code === 0 && fresh.data) ? fresh.data : null;
            paint();
        } catch (e) {
            const body = document.getElementById('spBody');
            if (body) body.innerHTML = '<div class="sp-empty">读取失败：' + esc(e.message) + '</div>';
        }
    }

    function webList() {
        return (cache || []).filter((s) => s.kind === 'web');
    }

    function filteredList() {
        const list = webList().filter((s) => {
            if (filterFac && String(s.factory || '') !== filterFac) return false;
            if (!filterQ) return true;
            const hay = (String(s.name || '') + ' ' + String(s.host || '') + ' ' + String(s.factory || '') + ' ' + String(s.id || '')).toLowerCase();
            return hay.includes(filterQ);
        });
        list.sort((a, b) => (a.tier - b.tier) || String(a.name).localeCompare(String(b.name), 'zh'));
        return list;
    }

    function paintChips() {
        const box = document.getElementById('spChips');
        if (!box) return;
        const list = webList();
        const facs = [...new Set(list.map((s) => String(s.factory || '')))];
        const chip = (key, label, n) => '<button class="sp-chip' + (filterFac === key ? ' active' : '') + '" data-fac="' + esc(key) + '">'
            + esc(label) + ' <i>' + n + '</i></button>';
        box.innerHTML = chip('', '全部', list.length)
            + facs.map((f) => chip(f, FACTORY_LABEL[f] || f, list.filter((s) => String(s.factory || '') === f).length)).join('');
    }

    function paint() {
        paintChips();
        const body = document.getElementById('spBody');
        if (!body) return;
        const list = filteredList();
        if (!list.length) {
            body.innerHTML = '<div class="sp-empty">没有匹配的源。换个关键词或切回「全部」。</div>';
            updateCount();
            return;
        }
        body.innerHTML = list.map(rowHtml).join('');
        body.querySelectorAll('.sp-check').forEach((cb) => {
            cb.addEventListener('change', async () => {
                const id = cb.getAttribute('data-id');
                const enabled = cb.checked;
                const item = (cache || []).find((x) => x.id === id);
                if (item) item.enabled = enabled;
                updateCount();
                try {
                    const r = await api('/api/media-source/prefs', {
                        method: 'POST', body: JSON.stringify({ id, enabled }),
                    });
                    if (!r || r.code !== 0) throw new Error((r && r.msg) || '保存失败');
                } catch (e) {
                    cb.checked = !enabled;
                    if (item) item.enabled = !enabled;
                    updateCount();
                    if (window.showNotification) window.showNotification('保存失败', e.message);
                }
            });
        });
        updateCount();
    }

    function updateCount() {
        const el = document.getElementById('spCount');
        if (!el) return;
        const list = webList();
        const on = list.filter((s) => s.enabled).length;
        el.textContent = '已启用 ' + on + ' / ' + list.length + ' 个在线源';
        const hint = document.getElementById('spHint');
        if (hint) {
            const fresh = freshness && freshness.ageDays != null
                ? ' · Kazumi 规则 ' + (freshness.ageDays < 1 ? '今天已更新' : freshness.ageDays + ' 天前更新')
                : '';
            hint.textContent = '勾选后，追番搜源 / 点集搜源只问你选中的源。关掉的源随时可再打开' + fresh + '。';
        }
    }

    async function toggleAll(on) {
        const list = webList();
        list.forEach((s) => { s.enabled = on; });
        paint();
        try {
            const disabled = list.filter((s) => !s.enabled).map((s) => s.id);
            const r = await api('/api/media-source/prefs', {
                method: 'POST', body: JSON.stringify({ disabled }),
            });
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '保存失败');
        } catch (e) {
            if (window.showNotification) window.showNotification('保存失败', e.message);
            cache = null; render();
        }
    }

    function bindButton(el) {
        if (!el) return;
        el.addEventListener('click', (e) => { e.preventDefault(); open(); });
    }

    function open() {
        filterQ = '';
        filterFac = '';
        render();
    }

    global.SourcePicker = { open, close, bindButton };

    /** 设置页按钮复用：手动触发一次 Kazumi 规则更新 */
    global.__cvRefreshKazumiRules = async function (btn) {
        const old = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
        try {
            const r = await api('/api/media-source/refresh-kazumi', {
                method: 'POST', body: JSON.stringify({}),
            });
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '更新失败');
            if (window.showNotification) window.showNotification('规则更新', r.msg || '已检查');
        } catch (e) {
            if (window.showNotification) window.showNotification('规则更新失败', e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = old; }
        }
    };
})(window);
