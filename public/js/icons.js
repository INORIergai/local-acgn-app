/* ============================================================
   CinemaVault · 图标系统
   24px 网格 / 1.7px 统一描边 / currentColor / 无渐变 / 无发光 / 无断口
   几何严谨、可读性优先；不再刻意制造"AI 味"装饰。
   ============================================================ */
(function () {
  'use strict';

  var ICONS = {
    /* ---------- 导航与推荐 ---------- */
    home: '<path d="M4 10.5 12 3l8 7.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.5 21v-6h5v6"/>',
    spark: '<path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M5.6 5.6l2.4 2.4M16 16l2.4 2.4M18.4 5.6 16 8M8 16l-2.4 2.4"/><circle cx="12" cy="12" r="3"/>',
    flame: '<path d="M12 3c-2 3-6 5-6 9a6 6 0 0 0 12 0c0-4-4-6-6-9z"/><path d="M9 16a3 3 0 0 0 6 0"/>',
    shuffle: '<path d="M3 7h4l10 10h4M3 17h4l2-2M15 7h6M17 3l4 4-4 4M17 13l4 4-4 4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    reel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M8 4v5M16 4v5M8 15v5M16 15v5"/>',
    frame: '<rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="M9 6h2M9 10h2M9 14h2M9 18h2M13 6h2M13 10h2M13 14h2M13 18h2"/>',
    anime: '<circle cx="12" cy="12" r="8"/><path d="M8 10h2M14 10h2M8 15h8M12 4v2"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M8 4v5M16 4v5M8 15v5M16 15v5"/>',
    cartoon: '<circle cx="12" cy="12" r="8"/><path d="M8 10h2M14 10h2M8 15h8M12 4v2"/>',
    comic: '<rect x="3" y="4" width="12" height="14" rx="1.5"/><path d="M6 8h6M6 12h4M16 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/>',
    book: '<path d="M5 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5z"/><path d="M5 3v18M9 7h6M9 11h4"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    actress: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-7 7-7s7 3 7 7"/>',
    tag: '<path d="M11 3H5a2 2 0 0 0-2 2v6a2 2 0 0 0 .6 1.4l9 9a2 2 0 0 0 2.8 0l6-6a2 2 0 0 0 0-2.8l-9-9A2 2 0 0 0 11 3z"/><circle cx="8" cy="8" r="1.5"/>',
    series: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M9 8v5l4-2.5zM6 21h12"/>',
    history: '<path d="M4 12a8 8 0 1 1 2 6"/><path d="M4 4v5h5M12 7v5l3 2"/>',
    bell: '<path d="M18 16V10a6 6 0 0 0-12 0v6l-2 3h16zM10 21a2 2 0 0 0 4 0"/>',
    chart: '<path d="M4 20h16M7 16V10M12 16V6M17 16V9"/>',
    settings: '<path d="M4 8h16M4 16h16"/><circle cx="9" cy="8" r="2.5"/><circle cx="15" cy="16" r="2.5"/>',
    watch: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 8v5l4-2.5zM8 20h8"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M3 12h18M12 4c-2 2-3 5-3 8s1 6 3 8c2-2 3-5 3-8s-1-6-3-8z"/>',
    alert: '<path d="M12 3 21 20H3z"/><path d="M12 10v5"/><circle cx="12" cy="17" r=".6"/>',
    image: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 15l5-5 4 4 5-5 4 5"/><circle cx="8" cy="9" r="1.5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    star: '<path d="M12 3l2.5 5.5 5.5.8-4 4 .9 5.7-4.9-2.6-4.9 2.6.9-5.7-4-4 5.5-.8z"/>',
    play: '<path d="M7 4v16l13-8z"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12l5 5L20 6"/>',
    edit: '<path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16z"/>',
    trash: '<path d="M5 6h14M9 6V4h6v2M7 6l1 14h8l1-14M10 10v6M14 10v6"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2-6"/><path d="M20 4v5h-5"/>',
    folder: '<path d="M3 8a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>',
    link: '<path d="M10 14l4-4M12 7l2-2a4 4 0 0 1 6 6l-2 2M8 13l-2 2a4 4 0 0 0 6 6l2-2"/>',
    cloud: '<path d="M7 17a4 4 0 0 1-.5-8 6 6 0 0 1 11-1 4 4 0 0 1-.5 9z"/>',
    ai: '<path d="M12 3 13.5 9.5 20 11 13.5 12.5 12 19 10.5 12.5 4 11 10.5 9.5z"/><circle cx="18" cy="17" r="2"/>',
    moon: '<path d="M20 13A8 8 0 1 1 11 3a7 7 0 0 0 9 10z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
    sort: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
    more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    external: '<path d="M14 4h6v6M20 4 11 13M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v6"/><circle cx="12" cy="8" r=".6"/>',
    warning: '<path d="M12 3l8 3v6c0 5-3 9-8 10-5-1-8-5-8-10V6z"/><path d="M12 8v5"/><circle cx="12" cy="16" r=".6"/>',
    shield: '<path d="M12 3l7 3v6c0 4-3 8-7 9-4-1-7-5-7-9V6z"/>',
    key: '<circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M17 17l2-2"/>',
    cookie: '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="9" r="1"/><circle cx="14" cy="10" r="1"/><circle cx="10" cy="14" r="1"/><circle cx="15" cy="15" r="1"/>',
    tool: '<path d="M14 4a5 5 0 0 0 6 6L9 20 4 15z"/><circle cx="17" cy="7" r="1.2"/>',
    paint: '<path d="M4 10a8 8 0 0 1 16 0v2H4z"/><path d="M8 14v4a2 2 0 0 0 4 0v-4"/>',
    scan: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M3 12h18"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><circle cx="7" cy="7" r="1"/><circle cx="7" cy="17" r="1"/>',
    db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.6 3.6 3 8 3s8-1.4 8-3V6M4 12c0 1.6 3.6 3 8 3s8-1.4 8-3"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><circle cx="8" cy="15" r="1"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2-6 6-6s6 2 6 6M16 5a3 3 0 0 1 0 6M19 14c2 1 3 3 3 6"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 4H5a1 1 0 0 0-1 1v10"/>',
    save: '<path d="M5 3h10l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v5h6V3M8 21v-8h8v8"/>',
    logout: '<path d="M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4M15 8l4 4-4 4M9 12h10"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1"/>',
    unlock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2"/><circle cx="12" cy="15" r="1"/>',
    drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    pause: '<path d="M9 4v16M15 4v16"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
    headphones: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/>',
    waveform: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4M21 12h1"/>',
    fullscreen: '<path d="M4 9V5h4M16 5h4v4M20 15v4h-4M8 20H4v-4"/>',
    pip: '<rect x="3" y="4" width="18" height="12" rx="2"/><rect x="12" y="11" width="7" height="4" rx="1"/>',
    crop: '<path d="M6 3v15h15M3 6h15v15"/>',
    chat: '<path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-4 4V8a2 2 0 0 1 2-2z"/><path d="M8 10h8M8 14h5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M15 15l5 5"/>'
  };

  var SPRITE_ID = 'ic-sprite';

  function buildSprite() {
    if (document.getElementById(SPRITE_ID)) return;
    var parts = ['<svg id="' + SPRITE_ID + '" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">'];
    for (var name in ICONS) {
      if (!Object.prototype.hasOwnProperty.call(ICONS, name)) continue;
      parts.push('<symbol id="ic-' + name + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</symbol>');
    }
    parts.push('</svg>');
    var host = document.createElement('div');
    host.innerHTML = parts.join('');
    document.body.insertBefore(host.firstChild, document.body.firstChild);
  }

  function icon(name, size, extraClass) {
    size = size || 20;
    var cls = 'ic ic-' + name + (extraClass ? ' ' + extraClass : '');
    return '<svg class="' + cls + '" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false"><use href="#ic-' + name + '"/></svg>';
  }

  window.MidnightIcons = { icon: icon, names: Object.keys(ICONS), build: buildSprite };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSprite);
  } else {
    buildSprite();
  }
})();
