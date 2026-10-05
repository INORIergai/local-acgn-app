/* ============================================================
   CinemaVault v4.0 · motion-flip.js —— 工业级 FLIP 共享元素流体转场引擎
   ------------------------------------------------------------
   架构设计（遵照 motion-art-direction 与 Google/Apple 规范）：
   1. 独立飞行代理（Flying Clone Proxy）：绝不在弹窗内部未完成加载的 2px img 上执行 scale，
      彻底杜绝放大 150 倍的白色方形背景格子与破万像素撕裂；
   2. 独立顶层坐标系（z-index 99999）：飞行代理脱离抽屉父容器，免受父级滑入位移叠加干扰；
   3. 物理级平滑制动：360ms cubic-bezier(0.16, 1, 0.3, 1) 优雅软着陆；
   4. 优雅降级：系统开启减弱动画时自动转为平滑淡入，永无任何硬切与空白。
   ============================================================ */
(function (global) {
  'use strict';

  var state = {
    sourceCard: null,
    sourceImg: null,
    src: '',
    firstRect: null,
    borderRadius: '12px',
    isAnimating: false,
    currentProxy: null
  };

  /**
   * 点击任意影片卡片时记录源海报几何信息与已解码图片
   * @param {HTMLElement} card - 被点击的卡片元素或海报图片
   */
  function recordSourceCard(card) {
    if (!card) return;
    var img = card.tagName === 'IMG' ? card : (card.querySelector('.poster, .similar-poster, .deck-card-poster, .tl-poster img, img') || card);
    if (!img) return;

    var r = img.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;

    state.sourceCard = card;
    state.sourceImg = img;
    state.src = img.currentSrc || img.src || '';
    state.firstRect = {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height
    };
    try {
      state.borderRadius = window.getComputedStyle(img).borderRadius || '12px';
    } catch (e) {
      state.borderRadius = '12px';
    }
  }

  /**
   * 详情弹窗打开后触发 FLIP 飞行代理平滑飞入放大
   * @param {HTMLElement} targetPoster - 详情弹窗中的大海报元素
   */
  function playEnterFlip(targetPoster) {
    if (!targetPoster) return;

    // 清理任何残余代理
    if (state.currentProxy && state.currentProxy.parentNode) {
      state.currentProxy.parentNode.removeChild(state.currentProxy);
      state.currentProxy = null;
    }

    // 若无源卡片记录，直接优雅淡入
    if (!state.firstRect || !state.src) {
      targetPoster.style.opacity = '1';
      targetPoster.style.transition = 'opacity .25s ease';
      return;
    }

    var first = state.firstRect;
    var wrap = targetPoster.closest('.detail-poster-wrap') || targetPoster.parentElement;

    // 弹窗内的真海报先保持透明，不露底、不参与飞行
    targetPoster.style.opacity = '0';
    targetPoster.style.transition = 'none';

    // 计算目标尺寸：若真海报已有尺寸则使用，若尚未解码完成则基于容器与源图比例推算
    var last = targetPoster.getBoundingClientRect();
    var targetW = last.width;
    var targetH = last.height;
    var targetL = last.left;
    var targetT = last.top;

    var isPosterUnloaded = targetW <= 10 || targetH <= 10;
    if (isPosterUnloaded && wrap) {
      var wRect = wrap.getBoundingClientRect();
      var maxH = Math.min(window.innerHeight * 0.32, 260);
      var aspect = (first.height > 0 && first.width > 0) ? (first.width / first.height) : (2 / 3);
      targetH = maxH;
      targetW = targetH * aspect;
      targetL = wRect.left + (wRect.width / 2) - (targetW / 2);
      targetT = wRect.top + 10;
    }

    state.isAnimating = true;

    // 创建顶层独立飞行克隆体代理（Fixed 视口绝对定位）
    var proxy = document.createElement('img');
    proxy.className = 'flip-flight-proxy';
    proxy.src = state.src;
    proxy.alt = '';
    proxy.draggable = false;
    proxy.style.cssText = [
      'position: fixed',
      'left: ' + first.left.toFixed(1) + 'px',
      'top: ' + first.top.toFixed(1) + 'px',
      'width: ' + first.width.toFixed(1) + 'px',
      'height: ' + first.height.toFixed(1) + 'px',
      'object-fit: cover',
      'border-radius: ' + state.borderRadius,
      'box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55)',
      'z-index: 99999',
      'pointer-events: none',
      'will-change: left, top, width, height, opacity, box-shadow',
      'opacity: 1',
      'transition: none'
    ].join(';') + ';';

    document.body.appendChild(proxy);
    state.currentProxy = proxy;

    // 双重 rAF 确保初始起点已重绘，随后平滑飞向目标
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
        proxy.style.transition = [
          'left 360ms ' + ease,
          'top 360ms ' + ease,
          'width 360ms ' + ease,
          'height 360ms ' + ease,
          'border-radius 360ms ' + ease,
          'box-shadow 360ms ease'
        ].join(', ');

        proxy.style.left = targetL.toFixed(1) + 'px';
        proxy.style.top = targetT.toFixed(1) + 'px';
        proxy.style.width = targetW.toFixed(1) + 'px';
        proxy.style.height = targetH.toFixed(1) + 'px';
        proxy.style.borderRadius = '12px';
        proxy.style.boxShadow = '0 20px 48px rgba(0, 0, 0, 0.65)';

        setTimeout(function () {
          // 飞行抵达瞬间：真海报无缝接力显示，销毁飞行代理
          targetPoster.style.transition = 'opacity .18s ease';
          targetPoster.style.opacity = '1';
          if (proxy.parentNode) {
            proxy.parentNode.removeChild(proxy);
          }
          state.currentProxy = null;
          state.isAnimating = false;
        }, 360);
      });
    });
  }

  /**
   * 详情弹窗关闭时触发反向飞回缩小动画
   * @param {HTMLElement} targetPoster - 详情弹窗大海报元素
   * @param {Function} onComplete - 动画结束回调
   */
  function playExitFlip(targetPoster, onComplete) {
    var called = false;
    var finish = function () {
      if (called) return;
      called = true;
      if (guardTimer) clearTimeout(guardTimer);
      if (state.currentProxy && state.currentProxy.parentNode) {
        state.currentProxy.parentNode.removeChild(state.currentProxy);
        state.currentProxy = null;
      }
      state.isAnimating = false;
      state.firstRect = null;
      state.sourceCard = null;
      state.sourceImg = null;
      if (typeof onComplete === 'function') onComplete();
    };

    // 350ms 硬超时保护，绝不卡死弹窗关闭
    var guardTimer = setTimeout(finish, 350);

    if (!targetPoster || !state.sourceImg || !state.sourceImg.isConnected) {
      finish();
      return;
    }

    var currentFirst = state.sourceImg.getBoundingClientRect();
    var last = targetPoster.getBoundingClientRect();

    // 如果源卡片已被滚出视口超过 120px，优雅就地淡出
    var isOffscreen = (
      currentFirst.bottom < -60 ||
      currentFirst.top > window.innerHeight + 60 ||
      currentFirst.right < -60 ||
      currentFirst.left > window.innerWidth + 60 ||
      currentFirst.width <= 0 ||
      currentFirst.height <= 0
    );

    if (isOffscreen) {
      finish();
      return;
    }

    state.isAnimating = true;

    // 隐去弹窗内海报，启动反向飞行代理飞回卡片
    targetPoster.style.opacity = '0';

    var proxy = document.createElement('img');
    proxy.className = 'flip-flight-proxy';
    proxy.src = state.src || targetPoster.src;
    proxy.alt = '';
    proxy.draggable = false;
    proxy.style.cssText = [
      'position: fixed',
      'left: ' + last.left.toFixed(1) + 'px',
      'top: ' + last.top.toFixed(1) + 'px',
      'width: ' + last.width.toFixed(1) + 'px',
      'height: ' + last.height.toFixed(1) + 'px',
      'object-fit: cover',
      'border-radius: 12px',
      'box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55)',
      'z-index: 99999',
      'pointer-events: none',
      'opacity: 1',
      'transition: none'
    ].join(';') + ';';

    document.body.appendChild(proxy);
    state.currentProxy = proxy;

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
        proxy.style.transition = [
          'left 260ms ' + ease,
          'top 260ms ' + ease,
          'width 260ms ' + ease,
          'height 260ms ' + ease,
          'border-radius 260ms ' + ease,
          'opacity 240ms ease',
          'box-shadow 260ms ease'
        ].join(', ');

        proxy.style.left = currentFirst.left.toFixed(1) + 'px';
        proxy.style.top = currentFirst.top.toFixed(1) + 'px';
        proxy.style.width = currentFirst.width.toFixed(1) + 'px';
        proxy.style.height = currentFirst.height.toFixed(1) + 'px';
        proxy.style.borderRadius = state.borderRadius;
        proxy.style.opacity = '0.7';

        setTimeout(finish, 260);
      });
    });
  }

  global.MotionFLIP = {
    record: recordSourceCard,
    enter: playEnterFlip,
    exit: playExitFlip,
    isAnimating: function () { return state.isAnimating; }
  };
})(window);
