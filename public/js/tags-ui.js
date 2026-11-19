/**
 * public/js/tags-ui.js —— round168 · 标签库视图（五库 / 大卡 / 思维空间 / 合并）
 *
 * 设计要点（每条都对应 round168 调研里的一条问题）：
 *  1. 五库各自一套：所有请求都带 lib，AV 库受右上角锁控制（未解锁只显示🔒占位）
 *  2. 悬停预览走 GET /:id/posters（只回 id+一张路径，904KB → 约 0.4KB），LRU 60 上限
 *  3. 卡片是 <button> ⇒ 原生可聚焦，241 张卡 = 241 个 Tab 停留点（不是 482 个）
 *  4. 点卡片进「标签详情」（海报墙 + 年份分布 + 相关标签），再从详情进影片结果
 *  5. 多选模式（工具条开关）→ Ctrl 点击亦可 → AND / OR 组合筛选（接后端现成能力）
 *  6. 思维空间：力导向图，节点=标签、边=共现/名称联想；点节点弹出联想与合并建议
 */
(function () {
    'use strict';

    const LIBS = [
        { key: 'film', label: '影视', icon: '🎬', adult: false },
        { key: 'anime', label: '动漫', icon: '🌸', adult: false },
        { key: 'comic', label: '漫画', icon: '📚', adult: false },
        { key: 'novel', label: '小说', icon: '📖', adult: false },
        { key: 'jav', label: 'AV', icon: '🔞', adult: true }
    ];
    const CANDY = ['#ffdbfd', '#FAED8F', '#DDFCFC', '#CAF7C8', '#fbb663', '#f49978', '#feb6fa', '#c2b4eb', '#997ade', '#00ecef'];
    const TOP_N = 24;
    const LSK = 'cvTags168';

    const state = {
        lib: null,
        tags: [],
        loading: false,
        q: '',
        sort: 'count',
        view: 'cards',
        selectMode: false,
        sel: new Set(),
        selMode: 'and',
        merge: null,
        space: null,
        taxonomy: null
    };

    let root = null;
    let lru = [];                      // 海报 LRU（条目：tagId）
    const posterStore = new Map();     // tagId -> [{id, poster}]

    // ---------- 小工具 ----------
    const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s))
        : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

    function toast(t, m) { if (typeof showNotification === 'function') showNotification(t, m); else console.log(t, m); }

    function posterUrl(p) {
        if (!p) return '';
        const s = String(p);
        if (/^https?:\/\//i.test(s)) return `/api/movie/poster/proxy?url=${encodeURIComponent(s)}`;
        /* ★★ 磁盘绝对路径（漫画/小说的 -poster.jpg 就在作品目录里）必须走专用接口。
         *   旧逻辑一律取 basename 打 /api/movie/poster/:hash，那个接口只查 cache/posters，
         *   于是「阿南小姐…第10话-poster.jpg」必然 400 —— 漫画库 90 张墙图里 50 张是碎图。 */
        if (/^[A-Za-z]:[\\/]/.test(s)) return `/api/movie/poster-file?path=${encodeURIComponent(s)}`;
        const f = s.split(/[\\/]/).pop();
        return f ? `/api/movie/poster/${encodeURIComponent(f)}` : '';
    }

    const saves = () => { try { return JSON.parse(localStorage.getItem(LSK) || '{}') || {}; } catch (e) { return {}; } };
    const save = (patch) => { try { localStorage.setItem(LSK, JSON.stringify({ ...saves(), ...patch })); } catch (e) { } };

    /** 成人锁：以顶栏 🔒 总开关为准，其次看「入口显示」勾选 */
    function adultLocked() {
        try {
            if (typeof isAdultNavHidden === 'function' && isAdultNavHidden()) return true;
            if (typeof getAdultNavItems === 'function' && getAdultNavItems().jav === 0) return true;
        } catch (e) { }
        return false;
    }

    function firstLibWithData() {
        for (const l of LIBS) {
            if (l.adult && adultLocked()) continue;
            if (state.tags && state.lib === l.key) return l.key;
        }
        return 'jav';
    }

    async function jget(url) {
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const j = await r.json();
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '请求失败');
        return j;
    }
    async function jpostRaw(url, body) {
        const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        return r.json();
    }
    async function jpost(url, body) {
        const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        const j = await r.json();
        if (!j || j.code !== 0) throw new Error((j && j.msg) || '请求失败');
        return j;
    }

    // ---------- 海报 LRU ----------
    function lruTouch(id) {
        const i = lru.indexOf(id);
        if (i >= 0) lru.splice(i, 1);
        lru.unshift(id);
        while (lru.length > 60) {
            const drop = lru.pop();
            posterStore.delete(drop);
        }
    }
    async function postersOf(id, limit) {
        const lim = limit || 6;
        /* ★★ 缓存键必须同时带 limit 与 lib：
         *   - 只按 id：详情页永远拿到列表页那份 6 张；
         *   - 不带 lib：标签 id 在不同库里指向不同标签，切库后会把上个库的海报墙搬过来
         *     （实测小说库里出现「阿南小姐…第10话」= 漫画的图，跨库串图）。 */
        const key = `${state.lib || ''}|${id}@${lim}`;
        if (posterStore.has(key)) { lruTouch(key); return posterStore.get(key); }
        const j = await jget(`/api/tags/${id}/posters?lib=${encodeURIComponent(state.lib || '')}&limit=${lim}`);
        posterStore.set(key, j.data || []);
        lruTouch(key);
        return j.data || [];
    }
    async function fillWall(el, id, limit) {
        if (!el || el.dataset.filled === '1') return;
        el.dataset.filled = '1';
        try {
            const list = await postersOf(id, limit || 6);
            if (!el.isConnected) return;
            /* ★ onerror 兜底：图片挂了就整张藏掉，别让浏览器碎图图标占着位置
             *   （封面文件被删/盘离线时仍会出现，藏掉比显示「破图」干净）。 */
            el.innerHTML = list.map(p =>
                `<img src="${posterUrl(p.poster)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`).join('');
            el.classList.toggle('is-empty', !list.length);
        } catch (e) {
            el.dataset.filled = '';
        }
    }

    // ---------- 骨架 ----------
    function skeleton() {
        root.innerHTML = `
            <div class="tg-wrap">
                <div class="tg-tabs" role="tablist" aria-label="标签库分库">
                    ${LIBS.map(l => `
                        <button type="button" class="tg-tab" role="tab" data-lib="${l.key}"
                                aria-selected="false" aria-controls="tgBody">
                            <span class="tg-tab-ic">${l.icon}</span><span>${l.label}</span>
                        </button>`).join('')}
                </div>
                <div class="tg-tool">
                    <div class="tg-search-wrap">
                        <input id="tgSearch" class="tg-search" type="search" autocomplete="off"
                               placeholder="筛选标签…（支持繁简 / 全半角）" aria-label="筛选标签">
                        <button type="button" class="tg-clear" id="tgClear" aria-label="清空筛选" hidden>×</button>
                    </div>
                    <select id="tgSort" class="tg-sort" aria-label="标签排序">
                        <option value="count">作品数 多→少</option>
                        <option value="name">名称 A→Z</option>
                        <option value="latest">最近入库</option>
                    </select>
                    <div class="tg-seg" role="group" aria-label="视图">
                        <button type="button" class="tg-seg-btn is-on" data-view="cards" aria-pressed="true">卡片</button>
                        <button type="button" class="tg-seg-btn" data-view="taxonomy" aria-pressed="false">类目</button>
                        <button type="button" class="tg-seg-btn" data-view="space" aria-pressed="false">思维空间</button>
                    </div>
                    <button type="button" class="tg-btn" id="tgSelectMode" aria-pressed="false">多选</button>
                    <button type="button" class="tg-btn" id="tgEnrichBtn" title="从已启用的数据源（Bangumi）补全作品元数据，再据此生成标签">补全元数据</button>
                    <button type="button" class="tg-btn" id="tgMergeBtn">合并建议</button>
                </div>
                <div id="tgBody" class="tg-body" role="tabpanel"></div>
                <div id="tgSelBar" class="tg-selbar" hidden></div>
            </div>`;
        bindSkeleton();
    }

    function bindSkeleton() {
        root.querySelectorAll('.tg-tab').forEach(btn => btn.addEventListener('click', () => {
            const k = btn.dataset.lib;
            const l = LIBS.find(x => x.key === k);
            if (l && l.adult && adultLocked()) { toast('AV 标签库已隐藏', '先点右上角的 🔒 解锁，或在隐私设置里勾选 AV 库'); return; }
            state.lib = k;
            save({ lib: k });
            state.sel.clear();
            renderTabs();
            setTitle();
            loadTags();
        }));

        const search = root.querySelector('#tgSearch');
        const clear = root.querySelector('#tgClear');
        let timer = null;
        search.addEventListener('input', () => {
            clear.hidden = !search.value;
            clearTimeout(timer);
            // ★ 防抖后走服务端：只有服务端能做繁简/日文新字体/量词归一
            timer = setTimeout(() => { state.q = search.value.trim(); searchTags(); }, 180);
        });
        search.addEventListener('keydown', e => {
            if (e.key === 'Escape') { search.value = ''; clear.hidden = true; state.q = ''; searchTags(); }
        });
        clear.addEventListener('click', () => { search.value = ''; clear.hidden = true; state.q = ''; search.focus(); searchTags(); });

        root.querySelector('#tgSort').addEventListener('change', e => {
            state.sort = e.target.value; save({ sort: state.sort }); renderBody();
        });
        root.querySelectorAll('.tg-seg-btn').forEach(b => b.addEventListener('click', () => {
            state.view = b.dataset.view;
            root.querySelectorAll('.tg-seg-btn').forEach(x => {
                x.classList.toggle('is-on', x === b);
                x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
            });
            if (state.view === 'space') loadSpace();
            else if (state.view === 'taxonomy') loadTaxonomy();
            else renderBody();
        }));
        root.querySelector('#tgSelectMode').addEventListener('click', (e) => {
            state.selectMode = !state.selectMode;
            e.currentTarget.setAttribute('aria-pressed', state.selectMode ? 'true' : 'false');
            e.currentTarget.classList.toggle('is-on', state.selectMode);
            if (!state.selectMode) state.sel.clear();
            renderBody();
            renderSelBar();
        });
        root.querySelector('#tgMergeBtn').addEventListener('click', openMergePanel);
        root.querySelector('#tgEnrichBtn').addEventListener('click', runEnrich);
    }

    function renderTabs() {
        const locked = adultLocked();
        root.querySelectorAll('.tg-tab').forEach(b => {
            const l = LIBS.find(x => x.key === b.dataset.lib);
            const isLocked = l && l.adult && locked;
            b.classList.toggle('is-on', b.dataset.lib === state.lib);
            b.classList.toggle('is-locked', !!isLocked);
            b.setAttribute('aria-selected', b.dataset.lib === state.lib ? 'true' : 'false');
            b.title = isLocked ? '成人库标签受右上角锁控制，解锁后可见' : '';
            b.disabled = false; // 允许点击以给出解释性提示，而不是静默失效
            const ic = b.querySelector('.tg-tab-ic');
            if (ic) ic.textContent = isLocked ? '🔒' : l.icon;
        });
    }

    // ---------- 数据 ----------
    async function loadTags() {
        state.loading = true;
        const body = root.querySelector('#tgBody');
        body.innerHTML = `<div class="tg-empty"><span class="tg-spin"></span> 正在读取 ${labelOf(state.lib)} 的标签…</div>`;
        try {
            const j = await jget(`/api/tags?lib=${encodeURIComponent(state.lib || '')}`);
            state.tags = j.data || [];
            state.serverFiltered = false;
            state.loading = false;
            body.dataset.renderKey = '';
            /* ★ 切库后必须让「类目」「思维空间」的旧数据作废并重拉：
             *   否则在类目视图下切到小说库，看到的还是 AV 的 10 组 233 个标签（实测踩过）。 */
            state.taxonomy = null;
            if (state.view === 'space') loadSpace();
            else if (state.view === 'taxonomy') loadTaxonomy();
            else renderBody();
        } catch (e) {
            state.loading = false;
            body.innerHTML = `<div class="tg-empty is-err">读取失败：${esc(e.message)}<br><button class="tg-btn" onclick="TagsUI.retry()">重试</button></div>`;
        }
    }

    /** 服务端筛选（繁简/全半角/量词归一） */
    async function searchTags() {
        const body = root.querySelector('#tgBody');
        const q = state.q;
        try {
            const url = `/api/tags?lib=${encodeURIComponent(state.lib || '')}` + (q ? `&q=${encodeURIComponent(q)}` : '');
            const j = await jget(url);
            state.tags = j.data || [];
            state.serverFiltered = !!q;
            renderBody();
        } catch (e) {
            if (body) body.innerHTML = `<div class="tg-empty is-err">筛选失败：${esc(e.message)}</div>`;
        }
    }

    const labelOf = (k) => (LIBS.find(l => l.key === k) || { label: '全部' }).label;

    function setTitle(extra) {
        if (typeof updateToolbarTitle !== 'function') return;
        updateToolbarTitle(`🏷️ 标签库 · ${labelOf(state.lib)}${extra ? ' · ' + extra : ''}`);
    }

    function sortTags(list) {
        const arr = list.slice();
        if (state.sort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        else if (state.sort === 'latest') arr.sort((a, b) => String(b.latestDate || '').localeCompare(String(a.latestDate || '')));
        else arr.sort((a, b) => b.movieCount - a.movieCount || a.name.localeCompare(b.name, 'zh'));
        return arr;
    }

    function matchTag(t, q) {
        if (!q) return true;
        const needle = q.toLowerCase();
        if (String(t.name).toLowerCase().includes(needle)) return true;
        return (t.aliases || []).some(a => String(a).toLowerCase().includes(needle));
    }


    // ---------- 补全元数据 → 生成标签 ----------
    async function runEnrich() {
        if (state.lib === 'jav') return toast('AV 库不需要', 'AV 标签来自刮削，不适用这套流程');
        const limit = 20;
        const ok = confirm(`从 Bangumi 补全「${labelOf(state.lib)}」前 ${limit} 部缺元数据的作品，然后据此生成标签？\n\n约需 20~45 秒（每条限流 0.6s），期间别关页面。`);
        if (!ok) return;
        const btn = root.querySelector('#tgEnrichBtn');
        const emptyBtn = root.querySelector('#tgEmptyEnrich');
        const old = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = '补全中…'; }
        if (emptyBtn) { emptyBtn.disabled = true; emptyBtn.textContent = '补全中…'; }
        try {
            const j = await jpost('/api/enrich/library', { lib: state.lib, limit, dryRun: false });
            const d = j.data || {};
            toast('元数据补全完成', `扫描 ${d.scanned} 部 · 命中 ${d.matched} · 写入 ${d.written}${d.skipped ? ` · 跳过 ${d.skipped}` : ''}`);
            const dd = await jpost('/api/tags/derive', { lib: state.lib, dryRun: false });
            toast('标签已生成', `新增 ${dd.data.newTags} 个标签 / ${dd.data.relationsAdded} 条关系`);
            await loadTags();
        } catch (e) {
            toast('补全失败', e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = old; }
        }
    }

    // ---------- 类目视图 ----------
    async function loadTaxonomy() {
        const body = root.querySelector('#tgBody');
        body.innerHTML = `<div class="tg-empty"><span class="tg-spin"></span> 正在归类「${labelOf(state.lib)}」的标签…</div>`;
        try {
            const j = await jget(`/api/tags/taxonomy?lib=${encodeURIComponent(state.lib || '')}`);
            state.taxonomy = j.data;
            renderTaxonomy();
        } catch (e) {
            body.innerHTML = `<div class="tg-empty is-err">归类失败：${esc(e.message)}</div>`;
        }
    }

    function renderTaxonomy() {
        const body = root.querySelector('#tgBody');
        const d = state.taxonomy;
        if (!d) { loadTaxonomy(); return; }
        if (!d.items.length) {
            body.innerHTML = `<div class="tg-empty"><div class="tg-empty-ic">🏷️</div>
                <div class="tg-empty-t">${labelOf(state.lib)} 还没有标签可归类</div></div>`;
            return;
        }
        setTitle('类目');
        const byCat = new Map();
        for (const it of d.items) {
            if (!byCat.has(it.category)) byCat.set(it.category, []);
            byCat.get(it.category).push(it);
        }
        const blocks = d.taxonomy.filter(t => byCat.has(t.key)).map(meta => {
            const rows = byCat.get(meta.key).sort((a, b) => b.n - a.n);
            const items = rows.map((t, i) => cardHtml(
                { id: t.id, name: t.name, movieCount: t.n, aliases: [] }, i, meta.key === 'body' || meta.key === 'act'));
            return `<section class="tg-cat">
                <div class="tg-cat-h">
                    <span class="tg-cat-ic">${meta.icon}</span><b>${meta.label}</b>
                    <span class="tg-dim">${rows.length} 个 · 合计 ${rows.reduce((a, b) => a + b.n, 0)} 部次</span>
                </div>
                <ul class="tg-grid" role="list">${items.join('')}</ul>
            </section>`;
        });
        body.innerHTML = `
            <div class="tg-tax-head">
                <span class="tg-dim">规则归类覆盖率 <b>${d.coverage}%</b> · 未归类 ${d.counts.other || 0} 个${d.pending ? ` · 待更新 <b>${d.pending}</b> 条` : ' · 类目已是最新'}</span>
                <button type="button" class="tg-btn" id="tgTaxApply" ${d.pending ? '' : 'disabled'}>${d.pending ? '把类目写入库' : '已是最新'}</button>
            </div>
            ${blocks.join('')}`;
        bindBody();
        body.querySelector('#tgTaxApply').addEventListener('click', applyReclassify);
    }

    async function applyReclassify() {
        try {
            const pre = await jpost('/api/tags/reclassify', { dryRun: true });
            if (!pre.data.count) return toast('无需更新', '所有标签的类目都已是最新');
            const preview = pre.data.plan.slice(0, 12)
                .map(p => `${p.name}：${p.from} → ${p.label}`).join('\n');
            const ok = confirm(`将把 ${pre.data.count} 个标签的类目写入库（只改 category 列，不动任何影片关系）：\n\n` +
                preview + (pre.data.count > 12 ? `\n… 还有 ${pre.data.count - 12} 个` : ''));
            if (!ok) return;
            const done = await jpost('/api/tags/reclassify', { dryRun: false });
            toast('类目已写入', `更新 ${done.data.count} 个标签`);
            loadTaxonomy();
        } catch (e) {
            toast('写入失败', e.message);
        }
    }

    // ---------- 重命名 ----------
    function openRenameDialog(id, currentName) {
        document.querySelectorAll('.tg-dlg-mask').forEach(m => m.remove());
        const mask = document.createElement('div');
        mask.className = 'tg-dlg-mask';
        mask.innerHTML = `<div class="tg-dlg" role="dialog" aria-modal="true" aria-label="重命名标签">
            <div class="tg-dlg-t">重命名「${esc(currentName)}」</div>
            <input class="tg-dlg-in" id="tgRenameIn" value="${esc(currentName)}" maxlength="32" aria-label="新标签名">
            <div class="tg-dlg-hint tg-dim">旧名会自动存为别名，之后搜旧名仍能命中；若与已有标签等价会被拒绝（那种情况应该用合并）。</div>
            <div class="tg-dlg-msg" id="tgRenameMsg" hidden></div>
            <div class="tg-dlg-acts">
                <button type="button" class="tg-btn" id="tgRenameCancel">取消</button>
                <button type="button" class="tg-btn is-primary" id="tgRenameOk">保存</button>
            </div>
        </div>`;
        document.body.appendChild(mask);
        const input = mask.querySelector('#tgRenameIn');
        const msgEl = mask.querySelector('#tgRenameMsg');
        const close = () => mask.remove();
        input.focus(); input.select();

        mask.querySelector('#tgRenameCancel').addEventListener('click', close);
        mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'Enter') doSave();
        });
        mask.querySelector('#tgRenameOk').addEventListener('click', doSave);

        async function doSave() {
            const name = input.value.trim();
            if (!name) { msgEl.hidden = false; msgEl.className = 'tg-dlg-msg is-err'; msgEl.textContent = '名称不能为空'; return; }
            if (name === currentName) return close();
            const j = await jpostRaw(`/api/tags/${encodeURIComponent(id)}/rename`, { name, dryRun: false });
            if (j.code !== 0) {
                msgEl.hidden = false;
                msgEl.className = 'tg-dlg-msg is-err';
                msgEl.textContent = j.msg || '重命名失败';
                if (j.conflict) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'tg-btn';
                    b.textContent = `去合并「${j.conflict.name}」`;
                    b.addEventListener('click', () => { close(); openMergePanel(j.conflict.id); });
                    msgEl.appendChild(document.createElement('br'));
                    msgEl.appendChild(b);
                }
                return;
            }
            close();
            toast('已重命名', `${j.data.from} → ${j.data.to}（旧名已存为别名）`);
            await loadTags();
            openDetail(id);
        }
    }

    // ---------- 主体 ----------
    function renderBody() {
        const body = root.querySelector('#tgBody');
        if (!body) return;
        if (state.view === 'space') { renderSpace(); return; }
        if (state.view === 'taxonomy') { renderTaxonomy(); return; }

        const all = sortTags(state.tags);
        // 服务端已按归一化筛过 ⇒ 不再用 toLowerCase 二次过滤（否则会把「高画质」命中「高畫質」的结果又筛掉）
        const list = state.serverFiltered ? all : all.filter(t => matchTag(t, state.q));
        if (!all.length) {
            body.innerHTML = `<div class="tg-empty">
                <div class="tg-empty-ic">${LIBS.find(l => l.key === state.lib)?.icon || '🏷️'}</div>
                <div class="tg-empty-t">${labelOf(state.lib)} 还没有任何标签</div>
                <div class="tg-empty-s">标签来自作品本身。可以点下面的「补全元数据」，从已启用的数据源抓取作者/题材后再自动生成标签。</div>
                <button type="button" class="tg-btn is-primary" id="tgEmptyEnrich">补全元数据并生成标签</button>
            </div>`;
            const eb = body.querySelector('#tgEmptyEnrich');
            if (eb) eb.addEventListener('click', runEnrich);
            return;
        }
        if (!list.length) {
            body.innerHTML = `<div class="tg-empty">没有匹配「${esc(state.q)}」的标签 · <button class="tg-btn" id="tgEmptyClear">清空筛选</button></div>`;
            const b = body.querySelector('#tgEmptyClear');
            if (b) b.addEventListener('click', () => {
                state.q = ''; const s = root.querySelector('#tgSearch'); if (s) s.value = '';
                const c = root.querySelector('#tgClear'); if (c) c.hidden = true;
                renderBody();
            });
            return;
        }

        const html = [];
        if (state.q) {
            // 搜索态：平铺全部命中，不做折叠
            html.push(`<div class="tg-section-h">命中 ${list.length} 个标签</div>`,
                `<ul class="tg-grid" role="list">${list.map((t, i) => cardHtml(t, i, true)).join('')}</ul>`);
        } else {
            const top = list.slice(0, TOP_N);
            const rest = list.slice(TOP_N);
            html.push(`<div class="tg-section-h">常用标签 <span class="tg-dim">Top ${top.length}（按作品数）</span></div>`,
                `<ul class="tg-grid" role="list">${top.map((t, i) => cardHtml(t, i, true)).join('')}</ul>`);
            if (rest.length) {
                const groups = new Map();
                for (const t of rest) {
                    const ch = firstChar(t.name);
                    if (!groups.has(ch)) groups.set(ch, []);
                    groups.get(ch).push(t);
                }
                const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
                html.push(`<div class="tg-section-h">其余 ${rest.length} 个标签 <span class="tg-dim">按首字折叠</span></div>`,
                    `<div class="tg-groups">${keys.map(k => `
                        <section class="tg-group">
                            <button type="button" class="tg-group-h" aria-expanded="false">
                                <span class="tg-group-k">${esc(k)}</span>
                                <span class="tg-group-n">${groups.get(k).length}</span>
                                <span class="tg-caret" aria-hidden="true">▾</span>
                            </button>
                            <ul class="tg-grid tg-group-list" role="list" hidden>
                                ${groups.get(k).map((t, i) => cardHtml(t, i, false)).join('')}
                            </ul>
                        </section>`).join('')}</div>`);
            }
        }
        body.innerHTML = html.join('');
        bindBody();
    }

    function firstChar(name) {
        const s = String(name || '').trim();
        if (!s) return '#';
        const c = s[0];
        if (/[0-9]/.test(c)) return '#';
        if (/[a-zA-Z]/.test(c)) return c.toUpperCase();
        return c;
    }

    function cardHtml(t, i, withWall) {
        const picked = state.sel.has(t.id);
        const aliases = (t.aliases && t.aliases.length) ? `<span class="tg-alias" title="${esc(t.aliases.join(' / '))}">别名 ${esc(t.aliases[0])}</span>` : '';
        return `<li class="tg-card${withWall ? ' is-top' : ''}${picked ? ' is-picked' : ''}" data-id="${t.id}">
            <button type="button" class="tg-card-btn" data-id="${t.id}"
                aria-label="标签 ${esc(t.name)}，${t.movieCount} 部作品${state.selectMode ? '，回车选择' : '，回车查看详情'}"
                aria-pressed="${picked ? 'true' : 'false'}"
                style="--tb:${CANDY[i % CANDY.length]}">
                <span class="tg-bar" aria-hidden="true"></span>
                <span class="tg-name">${esc(t.name)}</span>
                <span class="tg-count" aria-hidden="true">${t.movieCount}</span>
                ${aliases}
                <span class="tg-wall" aria-hidden="true"></span>
            </button>
        </li>`;
    }

    function bindBody() {
        const body = root.querySelector('#tgBody');
        body.querySelectorAll('.tg-card-btn').forEach(btn => {
            const id = parseInt(btn.dataset.id, 10);
            const card = btn.closest('.tg-card');
            btn.addEventListener('click', (e) => {
                if (state.selectMode || e.ctrlKey || e.metaKey || e.shiftKey) { togglePick(id, card, btn); return; }
                openDetail(id);
            });
            btn.addEventListener('mouseenter', () => {
                const wall = btn.querySelector('.tg-wall');
                if (wall) fillWall(wall, id, 6);
            });
            btn.addEventListener('focus', () => {
                const wall = btn.querySelector('.tg-wall');
                if (wall) fillWall(wall, id, 6);
            });
            // ★ 只给 Top 24 预取：241 张全预取 = 241 个请求同时打出去（得不偿失）
            if (card && card.classList.contains('is-top')) fillWall(btn.querySelector('.tg-wall'), id, 6);
        });
        body.querySelectorAll('.tg-group-h').forEach(h => h.addEventListener('click', () => {
            const open = h.getAttribute('aria-expanded') === 'true';
            h.setAttribute('aria-expanded', open ? 'false' : 'true');
            const list = h.parentElement.querySelector('.tg-group-list');
            if (list) list.hidden = open;
        }));
    }

    function togglePick(id, card, btn) {
        if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
        const on = state.sel.has(id);
        if (card) card.classList.toggle('is-picked', on);
        if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        renderSelBar();
    }

    function renderSelBar() {
        const bar = root.querySelector('#tgSelBar');
        if (!bar) return;
        const n = state.sel.size;
        if (!state.selectMode && !n) { bar.hidden = true; bar.innerHTML = ''; return; }
        bar.hidden = false;
        bar.innerHTML = `
            <span class="tg-sel-n">已选 <b>${n}</b> 个标签</span>
            <span class="tg-seg" role="group" aria-label="组合方式">
                <button type="button" class="tg-seg-btn ${state.selMode === 'and' ? 'is-on' : ''}" data-mode="and" aria-pressed="${state.selMode === 'and'}">同时包含 (AND)</button>
                <button type="button" class="tg-seg-btn ${state.selMode === 'or' ? 'is-on' : ''}" data-mode="or" aria-pressed="${state.selMode === 'or'}">任一 (OR)</button>
            </span>
            <button type="button" class="tg-btn is-primary" id="tgSelGo" ${n ? '' : 'disabled'}>筛选 ${n} 个标签</button>
            <button type="button" class="tg-btn" id="tgSelClear" ${n ? '' : 'disabled'}>清空</button>`;
        bar.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
            state.selMode = b.dataset.mode;
            renderSelBar();
        }));
        bar.querySelector('#tgSelClear').addEventListener('click', () => {
            state.sel.clear(); renderBody(); renderSelBar();
        });
        bar.querySelector('#tgSelGo').addEventListener('click', runMultiFilter);
    }

    async function runMultiFilter() {
        const ids = [...state.sel];
        if (!ids.length) return;
        const names = state.tags.filter(t => ids.includes(t.id)).map(t => t.name);
        try {
            const j = await jpost('/api/tags/filter/movies', { tagIds: ids, lib: state.lib, mode: state.selMode });
            showMovies(j.data || [], `${names.join(state.selMode === 'and' ? ' + ' : ' / ')}`,
                { kind: 'tagMulti', ids, mode: state.selMode, name: names.join(state.selMode === 'and' ? ' + ' : ' / ') });
        } catch (e) { toast('筛选失败', e.message); }
    }

    // ---------- 详情 ----------
    async function openDetail(id) {
        const body = root.querySelector('#tgBody');
        const t = state.tags.find(x => x.id === id) || { id, name: '', movieCount: 0 };
        body.innerHTML = `<div class="tg-empty"><span class="tg-spin"></span> 正在打开「${esc(t.name)}」…</div>`;
        let prof;
        try {
            prof = (await jget(`/api/tags/${id}/profile?lib=${encodeURIComponent(state.lib || '')}`)).data;
        } catch (e) {
            body.innerHTML = `<div class="tg-empty is-err">打开失败：${esc(e.message)}</div>`;
            return;
        }
        const years = prof.years || [];
        const maxY = Math.max(1, ...years.map(y => y.n));
        const alias = (prof.aliases && prof.aliases.length)
            ? `<div class="tg-d-alias">合并前的旧名：${prof.aliases.map(a => `<code>${esc(a)}</code>`).join(' ')}</div>` : '';

        body.innerHTML = `
            <div class="tg-detail">
                <div class="tg-d-head">
                    <button type="button" class="tg-btn tg-back" id="tgBack">← 标签库</button>
                    <div class="tg-d-title">
                        <span class="tg-d-name">${esc(prof.tag.name)}</span>
                        <span class="tg-d-count">${prof.count} 部 · ${labelOf(state.lib)}</span>
                    </div>
                    <button type="button" class="tg-btn" id="tgRename">重命名</button>
                    <button type="button" class="tg-btn is-primary" id="tgAll">查看全部 ${prof.count} 部</button>
                </div>
                ${alias}
                <div class="tg-d-wall" id="tgDWall" aria-label="代表作海报"></div>
                ${years.length ? `<div class="tg-d-sec-h">年份分布</div>
                <div class="tg-d-years" role="img" aria-label="按年份的作品数量分布">
                    ${years.map(y => `<span class="tg-d-year" style="--h:${Math.max(6, Math.round(y.n / maxY * 100))}%" title="${y.year} 年 ${y.n} 部"><i></i><b>${String(y.year).slice(2)}</b></span>`).join('')}
                </div>` : ''}
                ${(prof.related && prof.related.length) ? `<div class="tg-d-sec-h">相关标签 <span class="tg-dim">共现 / 名称联想</span></div>
                <div class="tg-d-rel">${prof.related.map(r =>
                    `<button type="button" class="tg-rel" data-id="${r.id}" title="${esc(r.reason)}">${esc(r.name)}<i>${r.n}</i></button>`).join('')}</div>` : ''}
            </div>`;

        // 海报墙（12 张，走轻量接口）
        try {
            const ps = await postersOf(id, 12);
            const wall = body.querySelector('#tgDWall');
            wall.innerHTML = ps.map(p => `<img src="${posterUrl(p.poster)}" alt="" loading="lazy" decoding="async">`).join('')
                || '<span class="tg-dim">暂无海报</span>';
        } catch (e) { }

        body.querySelector('#tgBack').addEventListener('click', () => renderBody());
        body.querySelector('#tgRename').addEventListener('click', () => openRenameDialog(id, prof.tag.name));
        body.querySelector('#tgAll').addEventListener('click', () => {
            showMovies(null, prof.tag.name, { kind: 'tag', id, name: prof.tag.name });
        });
        body.querySelectorAll('.tg-rel').forEach(b => b.addEventListener('click', () => openDetail(parseInt(b.dataset.id, 10))));
        setTitle(prof.tag.name);
        body.querySelector('#tgBack').focus();
    }

    /** 进入影片结果页（复用 app.js 的网格与分块渲染），并补上返回入口与侧栏高亮 */
    async function showMovies(movies, label, filter) {
        try {
            if (!movies) {
                const url = filter.kind === 'tag'
                    ? `/api/tags/${filter.id}/movies?lib=${encodeURIComponent(state.lib || '')}`
                    : '/api/tags/0/movies';
                movies = (await jget(url)).data || [];
            }
            if (typeof closeTagSlicerPreview === 'function') closeTagSlicerPreview();
        } catch (e) { toast('加载失败', e.message); return; }

        try { currentView = 'movies'; } catch (e) { }
        try { currentFilter = filter; } catch (e) { }
        if (typeof selectedMovies !== 'undefined' && selectedMovies.clear) selectedMovies.clear();
        if (typeof updateBatchToolbar === 'function') updateBatchToolbar();

        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navTags = document.querySelector('.nav-item[data-view="tags"]');
        if (navTags) navTags.classList.add('active'); // 修「进得去出不来」：此时标签库仍是归属视图

        const grid = document.getElementById('movieGrid');
        if (grid) grid.style.display = 'grid';
        ['actressGrid', 'tagCloud', 'statsPanel'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        const emptyTip = document.getElementById('emptyTip');
        if (emptyTip) emptyTip.style.display = 'none';
        const sortWrap = document.getElementById('sortSelect');
        if (sortWrap && sortWrap.parentElement) sortWrap.parentElement.style.display = 'block';
        if (typeof hideGallery === 'function') hideGallery();

        if (!movies.length) {
            if (emptyTip) { emptyTip.style.display = 'block'; emptyTip.textContent = `「${label}」没有符合条件的作品`; }
            if (typeof updateToolbarTitle === 'function') updateToolbarTitle(`${label} · 0 部`);
            return;
        }
        if (typeof renderMoviesChunked === 'function') renderMoviesChunked(movies, label);
        else if (grid) grid.innerHTML = '';

        // 返回条：插在影片网格上方，点击回标签库
        showBackBar(label, movies.length);
    }

    /** 结果页返回条（标签库 → 影片结果的唯一回退路径），幂等：重复调用只留一条 */
    function showBackBar(label, count) {
        const grid = document.getElementById('movieGrid');
        if (!grid || !grid.parentElement) return;
        document.querySelectorAll('.tg-backbar').forEach(b => b.remove());
        const bar = document.createElement('div');
        bar.className = 'tg-backbar';
        bar.innerHTML = `<button type="button" class="tg-btn">← 返回标签库</button>
            <span class="tg-backbar-t">${esc(label)}${count != null ? ` · ${count} 部` : ''}</span>`;
        bar.querySelector('button').addEventListener('click', () => {
            bar.remove();
            if (typeof switchView === 'function') switchView('tags');
            else if (window.TagsUI) window.TagsUI.enter();
        });
        grid.parentElement.insertBefore(bar, grid);
    }

    // ---------- 思维空间 ----------
    async function loadSpace() {
        const body = root.querySelector('#tgBody');
        body.innerHTML = `<div class="tg-empty"><span class="tg-spin"></span> 正在构建「${labelOf(state.lib)}」的标签关系网…</div>`;
        try {
            const j = await jget(`/api/tags/space?lib=${encodeURIComponent(state.lib || '')}&limit=60&minCo=2`);
            state.space = j.data;
            renderSpace();
        } catch (e) {
            body.innerHTML = `<div class="tg-empty is-err">构建失败：${esc(e.message)}</div>`;
        }
    }

    function renderSpace() {
            const body = root.querySelector('#tgBody');
            const data = state.space;
            if (!data) { loadSpace(); return; }
            if (!data.nodes.length) {
                body.innerHTML = `<div class="tg-empty">${labelOf(state.lib)} 还没有标签，无法构建关系网。</div>`;
                return;
            }
            /* ★ 画布加大到 1100×760（round172）：60 个节点在 900×560 里平均间距只有 91px，
             *   而一个 6 字标签就要 66px 宽 —— 必然互相压盖。 */
            const W = 1100, H = 760;
            const cx = W / 2, cy = H / 2;
            const N = data.nodes.length;
            /* ★ 初始布点改「黄金角螺旋」：旧代码 r = 90 + (i%7)*30 只铺到 90~270 的窄环，
             *   15 个节点被挤成 242px 宽的一条竖线（实测 spanX=242 / 画布 900）。
             *   黄金角 137.5° + sqrt 半径分布能把点均匀铺满整块画布，力导向才有腾挪空间。 */
            const rX = W * 0.44, rY = H * 0.42;   // 椭圆分布：横向铺得比纵向更开
            const nodes = data.nodes.map((n, i) => {
                const a = i * 2.399963229728653;
                const k = Math.sqrt((i + 0.6) / N);
                return {
                    ...n, x: cx + Math.cos(a) * rX * k, y: cy + Math.sin(a) * rY * k, vx: 0, vy: 0,
                    r: 6 + Math.sqrt(n.n || 1) * 0.9
                };
            });
            const byId = new Map(nodes.map(n => [n.id, n]));
            const edges = data.edges.filter(e => byId.has(e.a) && byId.has(e.b));
            const maxN = Math.max(...nodes.map(n => n.n || 1), 1);

            // 简易力导向：斥力 + 边弹簧 + 碰撞分离，跑 200 步再画（不逐帧动画，避免大量重绘）
            /* ★ 斥力按「理想平均间距」反推：节点少时用固定基数就撑不开
             *   （实测 15 节点 + 37 条边被弹簧拉成 190px 宽的竖条，画布宽 900）。
             *   目标间距 = sqrt(画布面积 / 节点数)，在 targetSpacing 处让斥力≈1，弹簧才压不塌。 */
            const targetSpacing = Math.sqrt((W * H) / N) * 1.05;
            const REP = targetSpacing * targetSpacing;
            const GRAV = 0.0007;             // 向心力，比旧值(0.0012)弱，否则又被吸成一团
            for (let step = 0; step < 200; step++) {
                const cool = 1 - step / 200;   // 步长随迭代衰减，先粗后细
                for (let i = 0; i < nodes.length; i++) {
                    for (let k = i + 1; k < nodes.length; k++) {
                        const A = nodes[i], B = nodes[k];
                        let dx = A.x - B.x, dy = A.y - B.y;
                        const d2 = dx * dx + dy * dy || 1;
                        const f = REP / d2;
                        const d = Math.sqrt(d2);
                        dx /= d; dy /= d;
                        A.vx += dx * f; A.vy += dy * f;
                        B.vx -= dx * f; B.vy -= dy * f;
                        // 硬碰撞：两圆（含文字留白）重叠就沿连线推开
                        const minD = A.r + B.r + 14;
                        if (d < minD) {
                            const push = (minD - d) * 0.5;
                            A.vx += dx * push; A.vy += dy * push;
                            B.vx -= dx * push; B.vy -= dy * push;
                        }
                    }
                }
                for (const e of edges) {
                    const A = byId.get(e.a), B = byId.get(e.b);
                    const dx = B.x - A.x, dy = B.y - A.y;
                    const d = Math.sqrt(dx * dx + dy * dy) || 1;
                    const target = 150 - e.w * 90;
                    const f = (d - target) * 0.004 * (0.4 + e.w);
                    A.vx += (dx / d) * f; A.vy += (dy / d) * f;
                    B.vx -= (dx / d) * f; B.vy -= (dy / d) * f;
                }
                for (const n of nodes) {
                    n.vx += (cx - n.x) * GRAV;
                    n.vy += (cy - n.y) * GRAV;
                    const cap = 10 * cool + 1;
                    n.x += Math.max(-cap, Math.min(cap, n.vx));
                    n.y += Math.max(-cap, Math.min(cap, n.vy));
                    n.vx *= 0.72; n.vy *= 0.72;
                    n.x = Math.max(46, Math.min(W - 46, n.x));
                    n.y = Math.max(30, Math.min(H - 30, n.y));
                }
            }

            /* ★★ 文字布局（round172）：AV 库 60 个节点挤在中心，字号 11 的 6 字标签
             *   宽约 66px，直接居中画必然互相压盖 —— 实测「高畫質 / 單體作品 / 中出」
             *   这些最大的节点名字反而被别的圆点糊住。
             *   做法：按权重降序放置 → 依次试 8 个方位 → 与已放置的文字框冲突就换位；
             *   全都不行就截断到 4 字。这样重名节点优先占好位置，小节点自动让路。 */
            const labelPlan = new Map();
            {
                const taken = [];
                const order = [...nodes].sort((a, b) => (b.n || 0) - (a.n || 0));
                const fsOf = (n) => (n.n >= maxN * 0.5 ? 12.5 : (n.n >= maxN * 0.18 ? 11 : 10));
                // 所有节点圆的外接框：文字还要避开它们，否则会压在小圆点上（实测 AV 漏了 1 处）
                const circles = nodes.map(n => ({ id: n.id, x1: n.x - n.r - 1, x2: n.x + n.r + 1, y1: n.y - n.r - 1, y2: n.y + n.r + 1 }));
                const hits = (box, list) => list.some(b => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2));
                const tryPlace = (n, txt, fs, avoidCircles) => {
                    const w = Math.max(14, txt.length * fs * 0.62);
                    const h = fs * 1.05;
                    const slots = [[0, -1], [0, 1], [0, -2], [0, 2], [1, -1.2], [-1, -1.2], [1, 1.2], [-1, 1.2], [0, -3], [0, 3]];
                    for (const [mx, my] of slots) {
                        const lx = n.x + mx * (w * 0.5 + n.r * 0.4);
                        const ly = n.y + my * (n.r + h * 0.8);
                        const box = { x1: lx - w / 2, x2: lx + w / 2, y1: ly - h * 0.82, y2: ly + h * 0.18 };
                        if (box.x1 < 6 || box.x2 > W - 6 || box.y1 < 6 || box.y2 > H - 6) continue;
                        if (hits(box, taken)) continue;
                        if (avoidCircles && hits(box, circles.filter(c => c.id !== n.id))) continue;
                        return { lx, ly, box, txt, fs };
                    }
                    return null;
                };
                for (const n of order) {
                    const fs = fsOf(n);
                    const cap = Math.max(4, Math.min(12, Math.floor((n.r * 2 + 56) / (fs * 0.62))));
                    // 三轮放宽：① 避文字+避圆点 ② 只避文字 ③ 截断到 4 字再试
                    let pick = tryPlace(n, String(n.name).slice(0, cap), fs, true);
                    if (!pick) pick = tryPlace(n, String(n.name).slice(0, cap), fs, false);
                    if (!pick) pick = tryPlace(n, String(n.name).slice(0, 4), fs, false);
                    if (!pick) {
                        const lx = Math.max(20, Math.min(W - 20, n.x));
                        const ly = Math.max(16, n.y - n.r - fs);
                        pick = { lx, ly, box: { x1: lx - 20, x2: lx + 20, y1: ly - fs, y2: ly }, txt: String(n.name).slice(0, 4), fs };
                    }
                    taken.push(pick.box);
                    labelPlan.set(n.id, pick);
                }
            }

            setTitle('思维空间');
            body.innerHTML = `
                <div class="tg-space">
                    <div class="tg-space-head">
                        <div>
                            <b>思维空间</b>
                            <span class="tg-dim">${data.stats.shown} 个标签 · ${edges.length} 条关系 · 可拖节点 / 滚轮或双指缩放 / 点节点看联想</span>
                        </div>
                        <div class="tg-dim tg-space-legend">
                            <i class="lg lg-co"></i>共同出现
                            <i class="lg lg-name"></i>名称联想
                            <button type="button" class="tg-btn tg-space-reset" id="tgSpaceZoomOut" aria-label="缩小">－</button>
                            <button type="button" class="tg-btn tg-space-reset" id="tgSpaceZoomIn" aria-label="放大">＋</button>
                            <button type="button" class="tg-btn tg-space-reset" id="tgSpaceReset">复位视图</button>
                        </div>
                    </div>
                    <div class="tg-space-main">
                        <svg class="tg-space-svg" id="tgSpaceSvg" viewBox="0 0 ${W} ${H}" role="img"
                             aria-label="标签关系力导向图，共 ${data.stats.shown} 个节点">
                            <g id="tgStage">
                                <g class="tg-edges">
                                    ${edges.map(e => {
                                        const A = byId.get(e.a), B = byId.get(e.b);
                                        return `<line x1="${A.x.toFixed(1)}" y1="${A.y.toFixed(1)}" x2="${B.x.toFixed(1)}" y2="${B.y.toFixed(1)}"
                                            data-a="${e.a}" data-b="${e.b}"
                                            class="tg-edge ${e.kind === 'name' ? 'is-name' : ''}" style="--w:${e.w.toFixed(2)}">
                                            <title>${e.kind === 'name' ? '名称联想' : '共同出现'} · 强度 ${e.w.toFixed(2)}</title>
                                        </line>`;
                                    }).join('')}
                                </g>
                                <g class="tg-nodes">
                                    ${nodes.map(n => {
                                        /* ★ 名字必须全都显示（round172 用户反馈）：
                                         *   旧规则 `n >= 25` 写死了绝对门槛，小说库最大标签才 25 部
                                         *   ⇒ 48 个节点只有 1 个有名字，看上去就是「一堆没有神经元的散点」。
                                         *   改成相对分级：大标签字号大、小标签字号小，但**人人有名字**。 */
                                        const L = labelPlan.get(n.id) || { lx: n.x, ly: n.y - n.r - 6, txt: String(n.name).slice(0, 6), fs: 10.5 };
                                        return `
                                        <g class="tg-node" data-id="${n.id}" data-cat="${esc(n.cat || 'other')}" tabindex="0" role="button"
                                           aria-label="标签 ${esc(n.name)}，${n.n} 部作品">
                                            <title>${esc(n.name)} · ${n.n} 部</title>
                                            <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}"
                                                    style="fill-opacity:${(0.32 + 0.62 * Math.min(1, n.n / maxN)).toFixed(2)}"></circle>
                                            <text x="${L.lx.toFixed(1)}" y="${L.ly.toFixed(1)}" style="font-size:${L.fs}px">${esc(L.txt)}</text>
                                        </g>`;
                                    }).join('')}
                                </g>
                            </g>
                        </svg>
                        <aside class="tg-space-side" id="tgSpaceSide">
                            <div class="tg-side-hint">点左边的节点，看它和谁有关、以及可以合并谁。</div>
                        </aside>
                    </div>
                </div>`;
            bindSpace(nodes, edges);
        }

        /** 思维空间交互：拖节点 / 拖空白平移 / 滚轮缩放 / 点节点高亮邻居 */
        function bindSpace(nodes, edges) {
            const svg = root.querySelector('#tgSpaceSvg');
            const stage = root.querySelector('#tgStage');
            if (!svg || !stage) return;
            const byId = new Map(nodes.map(n => [n.id, n]));
            const nodeEls = new Map();
            root.querySelectorAll('.tg-node').forEach(g => {
                nodeEls.set(parseInt(g.dataset.id, 10), {
                    g,
                    circle: g.querySelector('circle'),
                    text: g.querySelector('text')
                });
            });
            const edgeEls = [...root.querySelectorAll('.tg-edge')].map(el => ({
                el, a: parseInt(el.dataset.a, 10), b: parseInt(el.dataset.b, 10)
            }));

            let scale = 1, tx = 0, ty = 0;
            const applyT = () => stage.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
            applyT();

            /* round173：以画布中心为锚点缩放（触屏没有滚轮，必须给 ＋/－ 按钮与捏合）
               画布尺寸从 svg 的 viewBox 读，不能依赖外层渲染函数里的局部常量。 */
            const vbSize = () => {
                const vb = svg.viewBox && svg.viewBox.baseVal;
                return { w: (vb && vb.width) || 1100, h: (vb && vb.height) || 760 };
            };
            const zoomStep = (factor) => {
                const prev = scale;
                const next = Math.max(0.5, Math.min(2.5, prev * factor));
                if (Math.abs(next - prev) < 1e-4) return;
                const ratio = next / prev;
                const vb = vbSize();
                const cx = vb.w / 2, cy = vb.h / 2;
                tx = cx - (cx - tx) * ratio;
                ty = cy - (cy - ty) * ratio;
                scale = next;
                applyT();
            };
            const resetView = () => {
                scale = 1; tx = 0; ty = 0; applyT();
            };
            const reset = root.querySelector('#tgSpaceReset');
            if (reset) reset.addEventListener('click', resetView);
            const zIn = root.querySelector('#tgSpaceZoomIn');
            if (zIn) zIn.addEventListener('click', () => zoomStep(1.18));
            const zOut = root.querySelector('#tgSpaceZoomOut');
            if (zOut) zOut.addEventListener('click', () => zoomStep(1 / 1.18));

            const syncNode = (n) => {
                const e = nodeEls.get(n.id);
                if (e) {
                    e.circle.setAttribute('cx', n.x.toFixed(1));
                    e.circle.setAttribute('cy', n.y.toFixed(1));
                    if (e.text) {
                        e.text.setAttribute('x', n.x.toFixed(1));
                        e.text.setAttribute('y', (n.y - n.r - 5).toFixed(1));
                    }
                }
                for (const edge of edgeEls) {
                    if (edge.a !== n.id && edge.b !== n.id) continue;
                    const A = byId.get(edge.a), B = byId.get(edge.b);
                    edge.el.setAttribute('x1', A.x.toFixed(1));
                    edge.el.setAttribute('y1', A.y.toFixed(1));
                    edge.el.setAttribute('x2', B.x.toFixed(1));
                    edge.el.setAttribute('y2', B.y.toFixed(1));
                }
            };

            const toLocal = (ev) => {
                const pt = svg.createSVGPoint();
                pt.x = ev.clientX; pt.y = ev.clientY;
                const ctm = stage.getScreenCTM();
                return ctm ? pt.matrixTransform(ctm.inverse()) : { x: 0, y: 0 };
            };

            svg.addEventListener('wheel', (e) => {
                e.preventDefault();
                zoomStep(e.deltaY > 0 ? 1 / 1.12 : 1.12);
            }, { passive: false });

            /* round173：双指捏合缩放（触屏） */
            let pinch = null;
            const touchDist = (t) => {
                const dx = t[0].clientX - t[1].clientX;
                const dy = t[0].clientY - t[1].clientY;
                return Math.sqrt(dx * dx + dy * dy) || 1;
            };
            svg.addEventListener('touchstart', (e) => {
                if (e.touches.length === 2) {
                    pinch = { d: touchDist(e.touches), s: scale };
                    mode = null;
                    dragNode = null;
                }
            }, { passive: true });
            svg.addEventListener('touchmove', (e) => {
                if (e.touches.length !== 2 || !pinch) return;
                if (e.cancelable) e.preventDefault();
                const next = Math.max(0.5, Math.min(2.5, pinch.s * (touchDist(e.touches) / pinch.d)));
                const prev = scale;
                if (Math.abs(next - prev) < 1e-4) return;
                const ratio = next / prev;
                const vb = vbSize();
                const cx = vb.w / 2, cy = vb.h / 2;
                tx = cx - (cx - tx) * ratio;
                ty = cy - (cy - ty) * ratio;
                scale = next;
                applyT();
            }, { passive: false });
            svg.addEventListener('touchend', (e) => {
                if (e.touches.length < 2) pinch = null;
            }, { passive: true });

            let mode = null, start = null, dragNode = null, movedPx = 0;
            svg.addEventListener('pointerdown', (e) => {
                const g = e.target.closest ? e.target.closest('.tg-node') : null;
                movedPx = 0;
                if (g) {
                    dragNode = byId.get(parseInt(g.dataset.id, 10));
                    const p = toLocal(e);
                    mode = 'node';
                    start = { x: p.x, y: p.y };
                } else {
                    mode = 'pan';
                    start = { x: e.clientX, y: e.clientY, tx, ty };
                }
                try { svg.setPointerCapture(e.pointerId); } catch (err) { }
            });
            svg.addEventListener('pointermove', (e) => {
                if (!mode) return;
                if (mode === 'pan') {
                    tx = start.tx + (e.clientX - start.x);
                    ty = start.ty + (e.clientY - start.y);
                    applyT();
                    movedPx += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
                } else if (mode === 'node' && dragNode) {
                    const p = toLocal(e);
                    movedPx += Math.abs(p.x - start.x) + Math.abs(p.y - start.y);
                    dragNode.x = p.x;
                    dragNode.y = p.y;
                    syncNode(dragNode);
                }
            });
            svg.addEventListener('pointerup', () => {
                // 位移小于 10px 视为「点击」而不是拖拽（触屏手指抖动量比鼠标大）
                if (mode === 'node' && dragNode && movedPx < 10) {
                    spacePick(dragNode.id, nodeEls.get(dragNode.id)?.g);
                }
                mode = null; dragNode = null;
            });
            svg.addEventListener('pointercancel', () => { mode = null; dragNode = null; });

            // 键盘：Tab 到节点后 Enter 打开联想
            root.querySelectorAll('.tg-node').forEach(g => {
                g.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        spacePick(parseInt(g.dataset.id, 10), g);
                    }
                });
            });

            // 把高亮函数挂到闭包外（spacePick 里调用）
            spaceHighlight = (id) => {
                const near = new Set([id]);
                for (const edge of edgeEls) {
                    if (edge.a === id) near.add(edge.b);
                    if (edge.b === id) near.add(edge.a);
                }
                root.querySelectorAll('.tg-node').forEach(g => {
                    const nid = parseInt(g.dataset.id, 10);
                    g.classList.toggle('is-on', nid === id);
                    g.classList.toggle('is-near', nid !== id && near.has(nid));
                    g.classList.toggle('is-dim', !near.has(nid));
                });
                for (const edge of edgeEls) {
                    const on = edge.a === id || edge.b === id;
                    edge.el.classList.toggle('is-hot', on);
                    edge.el.classList.toggle('is-fade', !on);
                }
            };
        }
        let spaceHighlight = null;

        async function spacePick(id, g) {
            root.querySelectorAll('.tg-node.is-on').forEach(x => x.classList.remove('is-on'));
            if (g) g.classList.add('is-on');
            if (typeof spaceHighlight === 'function') spaceHighlight(id);
            const side = root.querySelector('#tgSpaceSide');
            const node = (state.space.nodes || []).find(n => n.id === id);
            side.innerHTML = `<div class="tg-empty"><span class="tg-spin"></span> 正在联想「${esc(node ? node.name : '')}」…</div>`;
            try {
                const prof = (await jget(`/api/tags/${id}/profile?lib=${encodeURIComponent(state.lib || '')}`)).data;
                const neigh = (state.space.edges || []).filter(e => e.a === id || e.b === id);
                side.innerHTML = `
                    <div class="tg-side-name">${esc(prof.tag.name)}<span class="tg-d-count">${prof.count} 部</span></div>
                    <div class="tg-side-sec">关系 ${neigh.length} 条</div>
                    <div class="tg-d-rel">${(prof.related || []).map(r =>
                        `<button type="button" class="tg-rel" data-id="${r.id}" title="${esc(r.reason)}">${esc(r.name)}<i>${r.n}</i></button>`).join('') || '<span class="tg-dim">暂无联想</span>'}</div>
                    <div class="tg-side-sec">操作</div>
                    <div class="tg-side-acts">
                        <button type="button" class="tg-btn is-primary" id="tgSGo">查看 ${prof.count} 部作品</button>
                        <button type="button" class="tg-btn" id="tgSMerge">以此为主合并…</button>
                    </div>`;
                side.querySelectorAll('.tg-rel').forEach(b => b.addEventListener('click', () => spacePick(parseInt(b.dataset.id, 10), null)));
                side.querySelector('#tgSGo').addEventListener('click', () => {
                    showMovies(null, prof.tag.name, { kind: 'tag', id, name: prof.tag.name });
                });
                side.querySelector('#tgSMerge').addEventListener('click', () => openMergePanel(id));
            } catch (e) {
                side.innerHTML = `<div class="tg-empty is-err">${esc(e.message)}</div>`;
            }
        }

    // ---------- 合并面板 ----------
    async function openMergePanel(preferKeepId) {
        const body = root.querySelector('#tgBody');
        body.innerHTML = `<div class="tg-empty"><span class="tg-spin"></span> 正在自动联想可能重复的标签…</div>`;
        let cand;
        try {
            cand = (await jget(`/api/tags/merge/candidates?lib=${encodeURIComponent(state.lib || '')}`)).data || [];
        } catch (e) {
            body.innerHTML = `<div class="tg-empty is-err">加载失败：${esc(e.message)}</div>`;
            return;
        }
        if (!cand.length) {
            body.innerHTML = `<div class="tg-empty">没有发现疑似重复的标签。 <button class="tg-btn" id="tgMBack">← 返回</button></div>`;
            body.querySelector('#tgMBack').addEventListener('click', () => renderBody());
            return;
        }
        const conf = { high: '高置信', mid: '需确认', low: '弱关联' };
        body.innerHTML = `
            <div class="tg-merge">
                <div class="tg-d-head">
                    <button type="button" class="tg-btn" id="tgMBack">← 标签库</button>
                    <div class="tg-d-title"><span class="tg-d-name">标签合并建议</span>
                        <span class="tg-d-count">${cand.length} 组 · 自动勾选高置信</span></div>
                    <button type="button" class="tg-btn" id="tgMPrune">清理空标签</button>
                </div>
                <div class="tg-merge-hint tg-dim">合并只重指「影片↔标签」关系并把旧名写进别名表，不会删除任何影片；预演通过才会真写。</div>
                <ul class="tg-merge-list" role="list">
                    ${cand.map((c, i) => {
                        const keepA = c.suggestedKeep === c.a.id;
                        const keepId = preferKeepId && (c.a.id === preferKeepId || c.b.id === preferKeepId) ? preferKeepId : c.suggestedKeep;
                        return `<li class="tg-merge-row" data-i="${i}">
                            <label class="tg-mr-pick">
                                <input type="checkbox" ${c.confidence === 'high' ? 'checked' : ''}>
                            </label>
                            <span class="tg-badge ${c.confidence}">${conf[c.confidence]}</span>
                            <span class="tg-mr-pair">
                                <b class="${keepId === c.a.id ? 'keep' : ''}">${esc(c.a.name)}<i>${c.a.n}</i></b>
                                <span class="tg-mr-arrow">${c.confidence === 'mid' ? '≈' : '↔'}</span>
                                <b class="${keepId === c.b.id ? 'keep' : ''}">${esc(c.b.name)}<i>${c.b.n}</i></b>
                            </span>
                            <span class="tg-mr-why tg-dim">${esc(c.reasons.join('；'))}</span>
                            <button type="button" class="tg-btn tg-mr-flip" data-keep="${keepId}"
                                    title="切换保留哪一个">⇄ 保留${keepId === c.a.id ? esc(c.a.name) : esc(c.b.name)}</button>
                        </li>`;
                    }).join('')}
                </ul>
                <div class="tg-merge-foot">
                    <span class="tg-dim" id="tgMSel">已选 0 组</span>
                    <button type="button" class="tg-btn is-primary" id="tgMRun" disabled>预演并合并</button>
                </div>
            </div>`;

        const rows = [...body.querySelectorAll('.tg-merge-row')];
        const refresh = () => {
            const n = rows.filter(r => r.querySelector('input').checked).length;
            body.querySelector('#tgMSel').textContent = `已选 ${n} 组`;
            body.querySelector('#tgMRun').disabled = n === 0;
        };
        rows.forEach(r => r.querySelector('input').addEventListener('change', refresh));
        rows.forEach(r => r.querySelector('.tg-mr-flip').addEventListener('click', (e) => {
            const btn = e.currentTarget;
            const row = btn.closest('.tg-merge-row');
            const c = cand[parseInt(row.dataset.i, 10)];
            const curKeep = parseInt(btn.dataset.keep, 10);
            const nextKeep = curKeep === c.a.id ? c.b.id : c.a.id;
            btn.dataset.keep = String(nextKeep);
            const pair = row.querySelector('.tg-mr-pair');
            pair.querySelectorAll('b').forEach(b => b.classList.remove('keep'));
            if (nextKeep === c.a.id) pair.querySelectorAll('b')[0].classList.add('keep');
            else pair.querySelectorAll('b')[1].classList.add('keep');
            btn.textContent = `⇄ 保留${nextKeep === c.a.id ? c.a.name : c.b.name}`;
        }));
        refresh();

        body.querySelector('#tgMBack').addEventListener('click', () => renderBody());
        body.querySelector('#tgMPrune').addEventListener('click', pruneEmpty);
        body.querySelector('#tgMRun').addEventListener('click', () => runMerge(body, cand, rows));
    }

    async function pruneEmpty() {
        try {
            const pre = await jpost('/api/tags/prune-empty', { dryRun: true });
            if (!pre.data.count) return toast('没有空标签', '当前库的标签都挂着作品');
            const ok = confirm(`发现 ${pre.data.count} 个 0 作品的空标签：\n${pre.data.tags.map(t => t.name).join('、')}\n\n删除它们？（不碰任何影片）`);
            if (!ok) return;
            const done = await jpost('/api/tags/prune-empty', { dryRun: false });
            toast('已清理空标签', `删除 ${done.data.count} 个`);
            loadTags();
        } catch (e) { toast('清理失败', e.message); }
    }

    async function runMerge(body, cand, rows) {
        const picks = rows.filter(r => r.querySelector('input').checked).map(r => {
            const c = cand[parseInt(r.dataset.i, 10)];
            const keepId = parseInt(r.querySelector('.tg-mr-flip').dataset.keep, 10);
            const other = keepId === c.a.id ? c.b.id : c.a.id;
            return { intoId: keepId, fromId: other, pair: `${c.a.name} / ${c.b.name}` };
        });
        if (!picks.length) return;

        // 逐组预演 → 汇总确认 → 真跑（单组失败不影响其它组）
        let planText = [];
        for (const p of picks) {
            try {
                const j = await jpost('/api/tags/merge', { intoId: p.intoId, fromIds: [p.fromId], dryRun: true });
                planText.push(`${p.pair} → 迁移 ${j.data.totalMove} 条关系`);
            } catch (e) {
                planText.push(`${p.pair} → 预演失败：${e.message}`);
            }
        }
        if (!confirm(`预演结果：\n${planText.join('\n')}\n\n确认执行合并？`)) return;

        let moved = 0, failed = 0;
        for (const p of picks) {
            try {
                const j = await jpost('/api/tags/merge', { intoId: p.intoId, fromIds: [p.fromId], dryRun: false });
                moved += j.data.totalMoved || 0;
            } catch (e) { failed++; }
        }
        toast('合并完成', `迁移 ${moved} 条关系${failed ? `，${failed} 组失败` : ''}`);
        loadTags();
    }

    // ---------- 对外 ----------
    async function enter(typeOrLib) {
        root = document.getElementById('tagCloud');
        if (!root) return;
        const oldSlicer = document.getElementById('tagSlicer');
        if (oldSlicer) oldSlicer.style.display = 'none';

        const map = { all: null, jav: 'jav', anime: 'anime', film: 'film', cartoon: 'film', comic: 'comic', novel: 'novel' };
        let lib = map[typeOrLib] || null;
        if (!lib) lib = saves().lib || null;
        if (!lib) lib = 'jav'; // 默认落到唯一有数据的库，避免一进来就是四个空库
        if (lib === 'jav' && adultLocked()) lib = 'film';
        state.lib = lib;
        state.view = 'cards';
        state.q = '';
        state.sel.clear();
        state.merge = null;
        state.space = null;
        save({ lib });

        if (!root.dataset.mounted) {
            root.dataset.mounted = '1';
            skeleton();
        } else {
            // 重进时对齐骨架状态
            const s = root.querySelector('#tgSearch'); if (s) s.value = '';
            const c = root.querySelector('#tgClear'); if (c) c.hidden = true;
            const so = root.querySelector('#tgSort'); if (so) so.value = state.sort;
            root.querySelectorAll('.tg-seg-btn[data-view]').forEach(x => {
                x.classList.toggle('is-on', x.dataset.view === state.view);
                x.setAttribute('aria-pressed', x.dataset.view === state.view ? 'true' : 'false');
            });
            const sm = root.querySelector('#tgSelectMode');
            if (sm) { state.selectMode = false; sm.classList.remove('is-on'); sm.setAttribute('aria-pressed', 'false'); }
        }
        renderTabs();
        setTitle();
        renderSelBar();
        await loadTags();
        // 锁状态变化（用户点顶栏 🔒）时，重新对齐 tab 与视图
        if (!enter._locked) {
            enter._locked = true;
            const obs = new MutationObserver(() => {
                renderTabs();
                if (state.lib === 'jav' && adultLocked() && root.dataset.mounted) {
                    state.lib = 'film';
                    renderTabs();
                    loadTags();
                }
            });
            obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
    }

    window.TagsUI = {
        enter,
        retry: () => loadTags(),
        state,
        openDetail: (id) => openDetail(id),
        showBackBar,
        reload: () => loadTags()
    };
})();