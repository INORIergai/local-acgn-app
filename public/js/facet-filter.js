/* ============================================================
   CinemaVault v4.0 · facet-filter.js —— 多维即时聚合切片筛选器 (Facet 2.0)
   - 解决作用域断层，基于全局 _rawViewMovies / currentMovies 过滤；
   - 严格遵循隐私隔离：公开库自动隐藏成人切片，隐私组自动匹配成人维度；
   - 非网格视图（设置/年报/演员）自动隐蔽；
   - 支持 [库类型] + [评分] + [观看状态] 自由组合，带一键重置与匹配数反馈。
   ============================================================ */
(function (global) {
  'use strict';

  var state = {
    type: 'all',
    minScore: 0,
    watchStatus: 'all', // all | unwatched | watched | favorite
    currentView: 'movies',
    activeCount: 0
  };

  function initFacetFilter() {
    var host = document.getElementById('facetFilterBar');
    if (!host) {
      var toolbar = document.querySelector('.toolbar');
      if (toolbar && toolbar.parentNode) {
        host = document.createElement('div');
        host.id = 'facetFilterBar';
        host.className = 'facet-filter-bar';
        toolbar.parentNode.insertBefore(host, toolbar.nextSibling);
      }
    }
    if (!host) return;

    render(host);
  }

  function onViewChanged(view) {
    state.currentView = view || 'movies';
    // 切换视图时清空切片，避免旧条件污染新视图
    state.type = 'all';
    state.minScore = 0;
    state.watchStatus = 'all';
    var host = document.getElementById('facetFilterBar');
    if (host) render(host);
  }

  function render(host) {
    if (!host) host = document.getElementById('facetFilterBar');
    if (!host) return;

    // 隐私与成人视图判断
    var isAdultView = ['movies-adult', 'jav', 'anime'].includes(state.currentView);
    var isAdultHidden = typeof window.isAdultNavHidden === 'function' ? window.isAdultNavHidden() : false;

    var isFiltered = state.type !== 'all' || state.minScore > 0 || state.watchStatus !== 'all';

    // 根据公开/隐私环境渲染合法的库类型胶囊
    var typePillsHtml = '';
    if (isAdultView) {
      // 隐私组：只展示全部 / AV / 里番
      typePillsHtml = `
        <button class="f-pill ${state.type === 'all' ? 'active' : ''}" data-val="all">全部</button>
        <button class="f-pill ${state.type === 'jav' ? 'active' : ''}" data-val="jav">AV</button>
        <button class="f-pill ${state.type === 'anime' ? 'active' : ''}" data-val="anime">里番</button>
      `;
    } else {
      // 公开组：严密隐藏成人内容，只展示普通向库
      typePillsHtml = `
        <button class="f-pill ${state.type === 'all' ? 'active' : ''}" data-val="all">全部</button>
        <button class="f-pill ${state.type === 'film' ? 'active' : ''}" data-val="film">影视</button>
        <button class="f-pill ${state.type === 'cartoon' ? 'active' : ''}" data-val="cartoon">动漫</button>
        <button class="f-pill ${state.type === 'comic' ? 'active' : ''}" data-val="comic">漫画</button>
        <button class="f-pill ${state.type === 'novel' ? 'active' : ''}" data-val="novel">小说</button>
      `;
    }

    var html = `
      <div class="facet-wrap">
        <div class="facet-group" data-dim="type" title="按库类型切片">
          <span class="facet-label">库</span>
          ${typePillsHtml}
        </div>

        <div class="facet-group" data-dim="score" title="按评分切片">
          <span class="facet-label">评分</span>
          <button class="f-pill ${state.minScore === 0 ? 'active' : ''}" data-val="0">全部</button>
          <button class="f-pill ${state.minScore === 4.5 ? 'active' : ''}" data-val="4.5">★ 4.5+</button>
          <button class="f-pill ${state.minScore === 4.0 ? 'active' : ''}" data-val="4.0">★ 4.0+</button>
          <button class="f-pill ${state.minScore === 3.0 ? 'active' : ''}" data-val="3.0">★ 3.0+</button>
        </div>

        <div class="facet-group" data-dim="watch" title="按观看/收藏状态切片">
          <span class="facet-label">状态</span>
          <button class="f-pill ${state.watchStatus === 'all' ? 'active' : ''}" data-val="all">全部</button>
          <button class="f-pill ${state.watchStatus === 'unwatched' ? 'active' : ''}" data-val="unwatched">未看</button>
          <button class="f-pill ${state.watchStatus === 'watched' ? 'active' : ''}" data-val="watched">已看</button>
          <button class="f-pill ${state.watchStatus === 'favorite' ? 'active' : ''}" data-val="favorite">⭐ 收藏</button>
        </div>

        ${isFiltered ? `
          <button type="button" class="facet-reset-btn" id="facetResetBtn" title="清空全部筛选条件">
            ✕ 清除切片
          </button>
        ` : ''}
      </div>
    `;

    host.innerHTML = html;
    bindEvents(host);
  }

  function bindEvents(host) {
    host.querySelectorAll('.facet-group').forEach(function (grp) {
      var dim = grp.dataset.dim;
      grp.querySelectorAll('.f-pill').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var val = btn.dataset.val;
          if (dim === 'type') state.type = val;
          if (dim === 'score') state.minScore = parseFloat(val);
          if (dim === 'watch') state.watchStatus = val;

          render(host);
          applyFilter();
        });
      });
    });

    var resetBtn = host.querySelector('#facetResetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        state.type = 'all';
        state.minScore = 0;
        state.watchStatus = 'all';
        render(host);
        applyFilter();
      });
    }
  }

  function applyFilter() {
    var rawList = window._rawViewMovies || window.currentMovies;
    if (!rawList || !Array.isArray(rawList)) return;

    var isFiltered = state.type !== 'all' || state.minScore > 0 || state.watchStatus !== 'all';

    if (!isFiltered) {
      // 还原全量列表
      if (typeof window.renderMovies === 'function') {
        window.renderMovies(rawList, true);
      }
      var countEl = document.getElementById('movieCount');
      if (countEl) {
        countEl.textContent = '共 ' + rawList.length + ' 部';
      }
      return;
    }

    var filtered = rawList.filter(function (m) {
      // 1. 类型切片
      if (state.type !== 'all') {
        var t = String(m.type || 'jav').toLowerCase();
        if (t !== state.type) return false;
      }
      // 2. 评分切片
      if (state.minScore > 0) {
        var score = m.score || m.rating || 0;
        if (score < state.minScore) return false;
      }
      // 3. 状态切片
      if (state.watchStatus === 'unwatched' && m.watched === 1) return false;
      if (state.watchStatus === 'watched' && m.watched !== 1) return false;
      if (state.watchStatus === 'favorite' && m.favorite !== 1) return false;

      return true;
    });

    state.activeCount = filtered.length;

    // 触发网格更新（传入 fromFilter=true 防止破坏 _rawViewMovies 快照）
    if (typeof window.renderMovies === 'function') {
      window.renderMovies(filtered, true);
    }
    var countEl = document.getElementById('movieCount');
    if (countEl) {
      countEl.textContent = '切片匹配 ' + filtered.length + ' 部';
    }
  }

  global.FacetFilter = {
    init: initFacetFilter,
    apply: applyFilter,
    onViewChanged: onViewChanged,
    getState: function () { return { ...state }; }
  };
})(window);
