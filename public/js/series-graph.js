// ================================================================
// series-graph.js —— v6.5.0 第三档① 系列关系图
//   节点=追番 series，边=标题相似的续作/同系列；Canvas 力导向。
//   ★ 复用记忆坑21教训：斥力按 sqrt(W*H/N)² 反推；每个节点都有名字；
//     文字避让同时避开节点圆点；不写死绝对门槛。
//   挂 window.SeriesGraph.open() / injectButton()
// ================================================================
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let DATA = null, canvas = null, ctx = null, raf = 0, nodes = [], edges = [], W = 900, H = 620;
  let hover = null, dragging = null;

  function ensureHost() {
    let host = document.getElementById('seriesGraphHost');
    if (!host) { host = document.createElement('div'); host.id = 'seriesGraphHost'; document.body.appendChild(host); }
    return host;
  }

  function close() {
    if (raf) cancelAnimationFrame(raf); raf = 0;
    const h = document.getElementById('seriesGraphHost'); if (h) h.innerHTML = '';
  }

  async function open() {
    const host = ensureHost();
    host.innerHTML = '<div class="sv-modal-mask" data-close="1"><div class="sv-modal sg-modal" role="dialog" aria-modal="true">'
      + '<div class="sv-modal-head"><h3>🕸 系列关系图</h3><button class="sv-modal-close" data-close="1">✕</button></div>'
      + '<div class="sg-toolbar"><span id="sgStat">加载中…</span><label><input type="checkbox" id="sgIsolated"> 显示孤立番</label></div>'
      + '<div class="sg-stage"><canvas id="sgCanvas"></canvas><div class="sg-tip" id="sgTip" style="display:none;"></div></div>'
      + '<div class="sg-foot">节点=番剧，连线=续作/同系列；拖动节点可调整布局，点节点打开分集。</div>'
      + '</div></div>';
    host.querySelectorAll('[data-close="1"]').forEach(el => el.addEventListener('click', e => {
      if (e.target === el || el.classList.contains('sv-modal-close')) close();
    }));
    canvas = document.getElementById('sgCanvas');
    ctx = canvas.getContext('2d');
    try {
      const r = await fetch('/api/series/graph').then(x => x.json());
      DATA = (r && r.code === 0 && r.data) || { nodes: [], edges: [], stats: {} };
      const related = DATA.nodes.filter(n => n.degree > 0).length;
      document.getElementById('sgStat').textContent = `共 ${DATA.stats.series || 0} 部番，其中 ${related} 部有关联 · ${DATA.stats.links || 0} 条关系（勾选可看孤立番）`;
      document.getElementById('sgIsolated').addEventListener('change', () => build());
      build();
    } catch (e) {
      document.getElementById('sgStat').textContent = '加载失败：' + e.message;
    }
  }

  function build() {
    if (!DATA || !canvas) return;
    const showIso = document.getElementById('sgIsolated') && document.getElementById('sgIsolated').checked;
    const stage = canvas.parentElement;
    W = Math.max(400, stage.clientWidth || 900); H = Math.max(300, stage.clientHeight || 620);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const src = DATA.nodes.filter(n => showIso || n.degree > 0);
    if (!src.length) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = getComputedStyle(document.body).color || '#888';
      ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('没有可展示的系列关系（试试勾选「显示孤立番」）', W / 2, H / 2);
      return;
    }
    // 黄金角铺点（记忆坑21）
    const cx = W / 2, cy = H / 2, maxR = Math.min(W, H) * 0.42;
    nodes = src.map((n, i) => {
      const t = (i + 0.5) / src.length;
      const rr = maxR * Math.sqrt(t);
      const a = i * Math.PI * (3 - Math.sqrt(5));
      return Object.assign({}, n, {
        x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), vx: 0, vy: 0,
        r: 7 + Math.min(10, (n.eps || 0) / 12) + Math.min(8, (n.degree || 0) * 2)
      });
    });
    const nmap = new Map(nodes.map(n => [n.id, n]));
    edges = DATA.edges.filter(e => nmap.has(e.source) && nmap.has(e.target))
      .map(e => ({ a: nmap.get(e.source), b: nmap.get(e.target), kind: e.kind }));

    // 斥力按面积反推（记忆坑21：写死基数会让节点少的图垮成竖线）
    const repulse = Math.max(1200, (W * H / Math.max(1, nodes.length)) * 0.12);
    const ideal = Math.sqrt(W * H / Math.max(1, nodes.length)) * 0.55;
    for (let step = 0; step < 220; step++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy || 1;
          if (d2 > (W * H)) continue;
          const f = repulse / d2;
          const d = Math.sqrt(d2); dx /= d; dy /= d;
          a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
        }
      }
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1;
        const f = (d - ideal) * 0.008;
        e.a.vx += dx / d * f; e.a.vy += dy / d * f;
        e.b.vx -= dx / d * f; e.b.vy -= dy / d * f;
      }
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.0025; n.vy += (cy - n.y) * 0.0025; // 向心
        n.vx *= 0.84; n.vy *= 0.84;
        n.x = Math.max(n.r + 8, Math.min(W - n.r - 8, n.x + n.vx));
        n.y = Math.max(n.r + 8, Math.min(H - n.r - 8, n.y + n.vy));
      }
    }
    draw();
    bind();
  }

  function colors() {
    const cs = getComputedStyle(document.body);
    const probe = document.createElement('div'); probe.style.color = 'var(--primary)'; document.body.appendChild(probe);
    const primary = getComputedStyle(probe).color || '#f0a43c'; probe.remove();
    return {
      text: cs.color || '#333',
      muted: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#888',
      line: primary, lineSoft: primary.replace('rgb(', 'rgba(').replace(')', ', .35)')
    };
  }

  function draw() {
    if (!ctx) return;
    const c = colors();
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1.2;
    for (const e of edges) {
      ctx.strokeStyle = e.kind === 'same' ? c.line : c.lineSoft;
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    for (const n of nodes) {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = (hover === n || n.degree > 0) ? c.line : c.muted;
      ctx.fill();
      if (hover === n) { ctx.lineWidth = 2; ctx.strokeStyle = c.text; ctx.stroke(); }
    }
    // 文字避让：只标度数>0或悬停的节点，且同时避开其它节点圆点（记忆坑21）
    const labeled = nodes.filter(n => n.degree > 0 || n === hover || nodes.length <= 20);
    for (const n of labeled) {
      const name = n.title.length > 14 ? n.title.slice(0, 13) + '…' : n.title;
      ctx.font = '12px system-ui, sans-serif';
      const tw = ctx.measureText(name).width;
      let ly = n.y - n.r - 7, lx = n.x - tw / 2;
      lx = Math.max(4, Math.min(W - tw - 4, lx)); ly = Math.max(14, ly);
      // 与其它节点圆点冲突则下移
      for (const o of nodes) {
        if (o === n) continue;
        if (Math.abs(o.x - (lx + tw / 2)) < o.r + 10 && Math.abs(o.y - ly) < o.r + 12) { ly = o.y + o.r + 16; }
      }
      ctx.fillStyle = c.text; ctx.textAlign = 'left'; ctx.fillText(name, lx, ly);
    }
  }

  function bind() {
    canvas.onmousemove = ev => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      if (dragging) { dragging.x = x; dragging.y = y; draw(); return; }
      hover = nodes.find(n => Math.hypot(n.x - x, n.y - y) < n.r + 4) || null;
      const tip = document.getElementById('sgTip');
      if (hover && tip) {
        tip.style.display = 'block'; tip.textContent = `${hover.title} · ${hover.eps}集 · ${hover.degree}条关系`;
        tip.style.left = (x + 12) + 'px'; tip.style.top = (y + 12) + 'px';
      } else if (tip) tip.style.display = 'none';
      draw();
    };
    canvas.onmousedown = ev => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
      dragging = nodes.find(n => Math.hypot(n.x - x, n.y - y) < n.r + 4) || null;
    };
    canvas.onmouseup = ev => {
      if (dragging && Math.abs(dragging.vx) < 0.001) {
        // 轻点（非拖动）打开分集
        const n = dragging; dragging = null;
        if (window.SeriesView && window.SeriesView.openDetail) window.SeriesView.openDetail(n.id);
        return;
      }
      dragging = null;
    };
    canvas.onmouseleave = () => { hover = null; dragging = null; const t = document.getElementById('sgTip'); if (t) t.style.display = 'none'; draw(); };
  }

  /** 往追番视图注入入口按钮（幂等），由 series-view.js 的 init 调用 */
  function injectButton() {
    if (document.getElementById('sgEntry')) return;
    const view = document.querySelector('[data-view="series"]') || document.getElementById('seriesView');
    if (!view) return;
    const btn = document.createElement('button');
    btn.id = 'sgEntry'; btn.className = 'sg-entry'; btn.type = 'button';
    btn.innerHTML = '🕸 系列关系图';
    btn.addEventListener('click', open);
    // v4：优先放进首页头部按钮组（底部裸追加会在新布局里显得孤立）
    const bar = view.querySelector('.sv-head-actions');
    (bar || view).appendChild(btn);
  }

  window.SeriesGraph = { open, close, injectButton };
})();
