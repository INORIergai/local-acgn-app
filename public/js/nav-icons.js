/* ============================================================
   午夜场 · nav-icons.js —— 导航 SVG 接线层
   ------------------------------------------------------------
   同一套 MidnightIcons / currentColor，继承五皮肤；不再为每条导航
   预载 png + webm。节点原地修改，保留既有事件、拖拽与隐私显隐契约。
   ============================================================ */
(function () {
  'use strict';

  var MAP = {
    home: 'home', guess: 'spark', 'guess-adult': 'spark', hot: 'flame',
    random: 'shuffle', unwatched: 'eye', 'unwatched-adult': 'eye',
    movies: 'reel', 'movies-adult': 'reel', jav: 'frame', 'watch-hanime': 'frame',
    anime: 'anime', 'watch-anime': 'anime', film: 'film', cartoon: 'cartoon',
    comic: 'comic', 'watch-comic': 'comic', novel: 'book', 'watch-novel': 'book',
    favorites: 'bookmark', favhub: 'bookmark', recent: 'clock', 'recent-adult': 'clock',
    actresses: 'actress', tags: 'tag', series: 'play', 'novel-records': 'history',
    'comic-records': 'history', wiki: 'book', gamekee: 'grid', galgame: 'spark',
    'new-releases': 'bell', annual: 'chart', 'acg-rank': 'chart',
    settings: 'settings', ms: 'search', watch: 'watch', 'watch-hub': 'globe',
    'hot-adult': 'flame', 'random-adult': 'shuffle',
    'scrape-failures': 'alert', 'poster-health': 'image'
  };
  var EMOJI_RE = /^(?:[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{2BFF}]|[\u{1F1E6}-\u{1F1FF}]|[\u{FE0F}\u{200D}\u{20E3}])+(?:\s*)/u;

  function decorate(item) {
    if (item.dataset.nvic) return;
    var view = item.getAttribute('data-view');
    var id = MAP[view];
    var label = item.querySelector('span');
    if (!label) return;
    if (!id && /AI助手/.test(label.textContent)) id = 'ai';
    if (!id || !window.MidnightIcons) { item.dataset.nvic = 'unmapped'; return; }
    var text = label.textContent.replace(EMOJI_RE, '').trim();
    label.textContent = text;
    var icon = document.createElement('span');
    icon.className = 'nv-ic nv-ic-svg';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = window.MidnightIcons.icon(id, 18);
    label.insertBefore(icon, label.firstChild);
    item.dataset.nvic = id;
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', text);
    if (!item.dataset.shellKeys) {
      item.dataset.shellKeys = '1';
      item.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        item.click();
      });
    }
    var tip = document.createElement('span');
    tip.className = 'nvx-tip';
    tip.setAttribute('aria-hidden', 'true');
    tip.textContent = text;
    item.appendChild(tip);
  }

  function init() {
    var sidebar = document.getElementById('mainSidebar');
    if (!sidebar || !window.MidnightIcons) return;
    sidebar.querySelectorAll('.nav-item').forEach(decorate);
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches('.nav-item')) decorate(node);
          if (node.querySelectorAll) node.querySelectorAll('.nav-item').forEach(decorate);
        });
      });
    }).observe(sidebar, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
