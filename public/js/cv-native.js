/**
 * CVNative —— CinemaVault 原生能力统一入口（v1 契约）
 *
 * 设计目标：
 *  - WebView 过渡期：走 window.CVNative（由 APK 注入的 CVNativeBridge）；
 *  - 全原生迁移后：同一份能力由原生 ViewModel 直接消费，本文件只保留调用侧 API；
 *  - 能力探测 + 优雅降级：native 不具备的能力，call() 返回 rejected Promise，
 *    调用方据此回退到纯 H5 实现，App 永不全崩。
 *
 * 不依赖任何框架，必须在页面脚本最前部加载（见 library.html）。
 */
(function (global) {
  'use strict';

  var BRIDGE_VERSION = 1;
  var pending = Object.create(null);   // callbackId -> {resolve, reject, timer}
  var seq = 0;
  var eventHandlers = Object.create(null);
  var handshakeResult = null;
  var available = false;
  var detecting = false;

  // 关键：先捕获原生壳在页面加载前注入的 bridge，再覆盖 global.CVNative。
  // 否则 bridge() 会读到我们自己暴露的 api，导致
  //   isAvailable() → detect() → api.handshake() → detect() → … 无限递归（栈溢出/OOM）。
  // 桌面 Electron / 普通浏览器里没有原生注入，rawBridge 为 null，能力探测恒为不可用，前端优雅降级。
  var rawBridge = (typeof global.CVNative !== 'undefined' && global.CVNative !== null)
    ? global.CVNative
    : null;

  function bridge() {
    return rawBridge;
  }

  // ── 原生 → JS 回调通道 ────────────────────────────────────────
  global.__cvResolve = function (id, resultWrapper) {
    var p = pending[id];
    if (!p) return;
    clearTimeout(p.timer);
    delete pending[id];
    var payload = resultWrapper && resultWrapper.data ? resultWrapper.data : {};
    p.resolve(payload);
  };

  global.__cvReject = function (id, resultWrapper) {
    var p = pending[id];
    if (!p) return;
    clearTimeout(p.timer);
    delete pending[id];
    var msg = (resultWrapper && resultWrapper.error) || 'native error';
    var err = new Error(msg);
    err.capabilityError = msg;
    p.reject(err);
  };

  global.__cvEmit = function (event, payload) {
    var list = eventHandlers[event];
    if (!list) return;
    list.slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { /* 单个监听器异常不影响其它 */ }
    });
  };

  function detect() {
    if (detecting) return available;   // 重入守卫：杜绝 handshake ↔ detect 互调递归
    detecting = true;
    try {
      var b = bridge();
      available = !!(b && typeof b.call === 'function');
      if (available && typeof b.handshake === 'function') {
        try {
          var raw = b.handshake();
          handshakeResult = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        } catch (e) {
          handshakeResult = null;
        }
      }
      return available;
    } finally {
      detecting = false;
    }
  }

  var api = {
    /** 协议版本（本地声明）。 */
    version: BRIDGE_VERSION,

    /** 是否运行在提供能力桥的原生壳里。 */
    isAvailable: function () {
      return available || detect();
    },

    /** 握手信息：{ok, data:{bridgeVersion, appVersionCode, appVersionName, capabilities[]}} */
    handshake: function () {
      if (!detect()) return null;
      return handshakeResult;
    },

    /**  native 是否具备某个能力（如 'media.play' / 'ui.toast'）。 */
    has: function (name) {
      if (!detect()) return false;
      var caps = handshakeResult && handshakeResult.data && handshakeResult.data.capabilities;
      return Array.isArray(caps) ? caps.indexOf(name) >= 0 : false;
    },

    /**
     * 调用能力，返回 Promise。
     * 任一步失败都 reject，调用方用 .catch 回退到 H5 实现。
     */
    call: function (method, args) {
      return new Promise(function (resolve, reject) {
        var b = bridge();
        if (!b || typeof b.call !== 'function') {
          reject(new Error('CVNative unavailable'));
          return;
        }
        var id = 'cv' + (++seq) + '_' + Date.now();
        var timer = setTimeout(function () {
          delete pending[id];
          var e = new Error('CVNative timeout: ' + method);
          e.capabilityError = 'TIMEOUT';
          reject(e);
        }, 8000);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        var argsJson;
        try {
          argsJson = JSON.stringify(args || {});
        } catch (e) {
          argsJson = '{}';
        }
        try {
          b.call(method, argsJson, id);
        } catch (e) {
          clearTimeout(timer);
          delete pending[id];
          reject(e);
        }
      });
    },

    /** 订阅原生事件，如 'nav.back'。返回取消订阅函数。 */
    on: function (event, fn) {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(fn);
      return function () {
        var list = eventHandlers[event];
        if (!list) return;
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },

    // ── 常用能力的便捷方法（可选糖，call 仍是主通道）──
    toast: function (message) {
      return api.call('ui.toast', { message: message });
    },
    setUiMode: function (mode) {
      return api.call('ui.setMode', { mode: mode });
    },
    /** 前端注册返回键接管：handler 返回 true 表示已消费。 */
    setBackHandler: function (handler) {
      if (typeof handler === 'function') {
        api.on('nav.back', function () {
          if (handler() !== true) {
            // 前端放弃消费 → 通知原生执行默认返回
            api.call('nav.releaseBack').catch(function () {});
          }
        });
      }
      return api.call('nav.setBackHandler', { enabled: !!handler }).catch(function () {});
    }
  };

  // 首屏探测一次（不阻塞）
  detect();

  global.CVNative = api;
})(window);
