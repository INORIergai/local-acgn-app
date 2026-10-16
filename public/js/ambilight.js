/* ============================================================
   CinemaVault v4.0 · ambilight.js —— 自适应海报动态氛围光引擎
   - 从影片海报中提取双色相（主调色与对比环境色）；
   - 注入 CSS 变量 --amb-c1 与 --amb-c2；
   - 配合 radial-gradient 与 backdrop-blur 呈现 Apple TV 放映厅漫反射流光。
   ============================================================ */
(function (global) {
  'use strict';

  var canvas = null;
  var ctx = null;

  function getCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 24;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    return { canvas: canvas, ctx: ctx };
  }

  // 默认优雅回退色（电影胶片暖金与极夜蓝）
  var DEFAULT_C1 = 'rgba(245, 158, 11, 0.26)';
  var DEFAULT_C2 = 'rgba(99, 102, 241, 0.16)';

  /**
   * 从图片中提取主色并应用到目标容器
   * @param {string|HTMLImageElement} srcOrImg - 图片地址或已加载的 img 元素
   * @param {HTMLElement} target - 接收 CSS 变量的目标容器（如 #detailModal）
   */
  function extractAndApply(srcOrImg, target) {
    if (!target) return;

    if (!srcOrImg) {
      applyColors(target, DEFAULT_C1, DEFAULT_C2);
      return;
    }

    if (typeof srcOrImg === 'string') {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { processImage(img, target); };
      img.onerror = function () { applyColors(target, DEFAULT_C1, DEFAULT_C2); };
      img.src = srcOrImg;
    } else if (srcOrImg.complete && srcOrImg.naturalWidth > 0) {
      processImage(srcOrImg, target);
    } else {
      srcOrImg.addEventListener('load', function () { processImage(srcOrImg, target); }, { once: true });
      srcOrImg.addEventListener('error', function () { applyColors(target, DEFAULT_C1, DEFAULT_C2); }, { once: true });
    }
  }

  function processImage(img, target) {
    try {
      var c = getCanvas();
      c.ctx.clearRect(0, 0, 16, 24);
      c.ctx.drawImage(img, 0, 0, 16, 24);
      var data = c.ctx.getImageData(0, 0, 16, 24).data;

      var r1 = 0, g1 = 0, b1 = 0, count1 = 0;
      var r2 = 0, g2 = 0, b2 = 0, count2 = 0;

      // 上半区采样主色 1（偏暖/亮）
      for (var y = 2; y < 12; y++) {
        for (var x = 2; x < 14; x++) {
          var idx = (y * 16 + x) * 4;
          var r = data[idx], g = data[idx + 1], b = data[idx + 2];
          // 排除过黑或过灰像素
          if (r + g + b > 50 && Math.abs(r - g) + Math.abs(g - b) > 15) {
            r1 += r; g1 += g; b1 += b; count1++;
          }
        }
      }

      // 下半区采样主色 2（偏冷/基底）
      for (var y = 12; y < 22; y++) {
        for (var x = 2; x < 14; x++) {
          var idx = (y * 16 + x) * 4;
          var r = data[idx], g = data[idx + 1], b = data[idx + 2];
          if (r + g + b > 40) {
            r2 += r; g2 += g; b2 += b; count2++;
          }
        }
      }

      var c1 = count1 > 0
        ? 'rgba(' + Math.round(r1 / count1) + ',' + Math.round(g1 / count1) + ',' + Math.round(b1 / count1) + ', 0.32)'
        : DEFAULT_C1;

      var c2 = count2 > 0
        ? 'rgba(' + Math.round(r2 / count2) + ',' + Math.round(g2 / count2) + ',' + Math.round(b2 / count2) + ', 0.20)'
        : DEFAULT_C2;

      applyColors(target, c1, c2);
    } catch (e) {
      applyColors(target, DEFAULT_C1, DEFAULT_C2);
    }
  }

  function applyColors(target, c1, c2) {
    target.style.setProperty('--amb-c1', c1);
    target.style.setProperty('--amb-c2', c2);
    target.classList.add('has-ambilight');
  }

  function reset(target) {
    if (!target) return;
    target.style.removeProperty('--amb-c1');
    target.style.removeProperty('--amb-c2');
    target.classList.remove('has-ambilight');
  }

  global.Ambilight = {
    apply: extractAndApply,
    reset: reset
  };
})(window);
