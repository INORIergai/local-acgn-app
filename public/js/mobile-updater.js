/**
 * public/js/mobile-updater.js
 * 移动端/Android 应用内版本自动检测与无感升级模块
 * 无论用户安装的是旧版 APK 还是通过浏览器访问，都能在页面内实时收到新版推送并一键升级
 */
(function () {
    'use strict';

    // 仅在移动端、Android 环境或特定客户端下激活
    // round117：安卓判定改为「UA 含 CinemaVault-Android」或「AndroidBridge 存在」二者其一，
    // 不再强依赖 UA —— 原生侧改 UA 格式时前端不会因此失效。
    var isMobile = window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
    var isAndroidClient = navigator.userAgent.indexOf('CinemaVault-Android') !== -1 || !!window.AndroidBridge;

    if (!isMobile && !isAndroidClient) return;

    var DISMISS_KEY = 'cv_android_update_dismissed';

    /**
     * 当前已安装的 versionCode。
     * round117：删掉「4.5.4→1 / 4.5.5→2」这类硬编码映射表 —— 版本判定一律以
     * /api/app/android-version 的下发值为准；bridge 不可用时返回 null，
     * 由 UA 版本名做语义比较兜底（见 isNewerVersion）。
     */
    function getInstalledVersionCode() {
        if (window.AndroidBridge && typeof window.AndroidBridge.getVersionCode === 'function') {
            try {
                var code = Number(window.AndroidBridge.getVersionCode());
                if (isFinite(code) && code > 0) return code;
            } catch (e) {}
        }
        return null;
    }

    /** 从 UA 解析形如 CinemaVault-Android/4.5.6 的版本名 */
    function getUaVersionName() {
        var m = navigator.userAgent.match(/CinemaVault-Android\/([0-9]+(?:\.[0-9]+)*)/);
        return m && m[1] ? m[1] : null;
    }

    /** 语义比较 a>b 返回 1，相等 0，a<b 返回 -1；非法输入按 0 处理 */
    function compareVersionName(a, b) {
        var pa = String(a || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
        var pb = String(b || '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
        var len = Math.max(pa.length, pb.length);
        for (var i = 0; i < len; i++) {
            var x = pa[i] || 0;
            var y = pb[i] || 0;
            if (x !== y) return x > y ? 1 : -1;
        }
        return 0;
    }

    /** 服务端下发版本是否比本机新：优先 versionCode，其次 UA 版本名，全未知时按「有新版」处理 */
    function isNewerVersion(data) {
        var code = getInstalledVersionCode();
        if (code !== null && Number(data.versionCode) > 0) {
            return Number(data.versionCode) > code;
        }
        var uaVersion = getUaVersionName();
        if (uaVersion && data.version) {
            return compareVersionName(data.version, uaVersion) > 0;
        }
        return true;
    }

    // 注入升级弹窗的专属 CSS
    function injectStyles() {
        if (document.getElementById('cv-updater-style')) return;
        var style = document.createElement('style');
        style.id = 'cv-updater-style';
        style.textContent = [
            '#cvUpdateModal { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 20px; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); opacity: 0; pointer-events: none; transition: opacity var(--mv2-d2, .25s) cubic-bezier(0.16,1,0.3,1); }',
            '#cvUpdateModal.show { opacity: 1; pointer-events: auto; }',
            '.cv-update-card { background: #151921; border: 1px solid rgba(229,169,60,0.35); border-radius: 16px; width: 100%; max-width: 360px; padding: 22px 20px; box-shadow: 0 16px 40px rgba(0,0,0,0.6); color: #f3f4f6; transform: translateY(12px) scale(0.96); transition: transform var(--mv2-d2, .25s) cubic-bezier(0.16,1,0.3,1); }',
            '#cvUpdateModal.show .cv-update-card { transform: translateY(0) scale(1); }',
            '.cv-update-tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: bold; background: rgba(229,169,60,0.18); color: #E5A93C; margin-bottom: 8px; }',
            '.cv-update-title { font-size: 18px; font-weight: bold; color: #fff; margin-bottom: 12px; }',
            '.cv-update-notes { background: #0B0E14; border-radius: 10px; padding: 12px 14px; font-size: 12.5px; line-height: 1.7; color: #9CA3AF; white-space: pre-wrap; margin-bottom: 20px; max-height: 180px; overflow-y: auto; border: 1px solid #232936; }',
            '.cv-update-btns { display: flex; gap: 10px; }',
            '.cv-update-btns button { flex: 1; height: 44px; border-radius: 10px; font-size: 14px; font-weight: bold; cursor: pointer; border: none; }',
            '.cv-btn-cancel { background: #232936; color: #9CA3AF; }',
            '.cv-btn-confirm { background: #E5A93C; color: #0B0E14; box-shadow: 0 4px 12px rgba(229,169,60,0.3); }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // 弹出更新提示
    function showUpdatePrompt(data) {
        injectStyles();

        var existing = document.getElementById('cvUpdateModal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'cvUpdateModal';
        modal.innerHTML = [
            '<div class="cv-update-card">',
            '  <div class="cv-update-tag">🚀 发现安卓端新版</div>',
            '  <div class="cv-update-title">Cinema Vault v' + data.version + '</div>',
            '  <div class="cv-update-notes">' + (data.changelog || '多项体验与手势优化') + '</div>',
            '  <div class="cv-update-btns">',
            '    <button class="cv-btn-cancel" id="cvBtnLater">稍后再说</button>',
            '    <button class="cv-btn-confirm" id="cvBtnNow">立即一键更新</button>',
            '  </div>',
            '</div>'
        ].join('\n');

        document.body.appendChild(modal);
        setTimeout(function () { modal.classList.add('show'); }, 20);

        document.getElementById('cvBtnLater').onclick = function () {
            modal.classList.remove('show');
            setTimeout(function () { modal.remove(); }, 250);
            try { sessionStorage.setItem(DISMISS_KEY, String(data.versionCode)); } catch (e) {}
        };

        document.getElementById('cvBtnNow').onclick = function () {
            modal.classList.remove('show');
            setTimeout(function () { modal.remove(); }, 250);

            var fullUrl = data.apkUrl || '';
            if (fullUrl.indexOf('http') !== 0) {
                fullUrl = window.location.origin + (fullUrl.indexOf('/') === 0 ? '' : '/') + fullUrl;
            }

            // 优先调用原生 AndroidBridge 进行后台静默下载并自动安装
            // round117：第 3 个参数传 apkSha256，原生侧下载完成后校验；缺省不影响旧版原生壳
            if (window.AndroidBridge && typeof window.AndroidBridge.triggerUpdate === 'function') {
                try {
                    window.AndroidBridge.triggerUpdate(fullUrl, data.version, data.apkSha256 || '');
                } catch (e) {
                    // 老壳的 triggerUpdate 只接受 2 个参数时可能抛错，退回 2 参调用
                    try { window.AndroidBridge.triggerUpdate(fullUrl, data.version); } catch (e2) {}
                }
            } else {
                // 旧版 APK 或浏览器环境：直接拉起下载
                window.location.href = fullUrl;
            }
        };
    }

    // 检查更新
    async function checkUpdate(silent) {
        try {
            var res = await fetch('/api/app/android-version');
            if (!res.ok) return;
            var data = await res.json();
            if (!data.success) return;

            // 如果已经在此会话中忽略过该版本，且是自动静默检测，则不再打扰
            try {
                if (silent && sessionStorage.getItem(DISMISS_KEY) === String(data.versionCode)) {
                    return;
                }
            } catch (e) {}

            // round117：版本比较统一走 isNewerVersion（versionCode 优先，UA 版本名兜底）
            if (isNewerVersion(data)) {
                showUpdatePrompt(data);
            } else if (!silent) {
                if (window.AndroidBridge && typeof window.AndroidBridge.toast === 'function') {
                    window.AndroidBridge.toast('当前已经是最新版本');
                } else {
                    alert('当前已是最新版本 v' + data.version);
                }
            }
        } catch (err) {
            if (!silent) alert('检测更新失败，请检查网络连接');
        }
    }

    // 暴露全局手动检查入口供设置页或侧边栏调用
    window.checkAndroidUpdate = function () {
        checkUpdate(false);
    };

    // 延迟 2.5 秒后自动检查，让页面主内容优先顺畅渲染
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(function () { checkUpdate(true); }, 2500);
        });
    } else {
        setTimeout(function () { checkUpdate(true); }, 2500);
    }
})();
