package cn.cinemavault.app.cvnative;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.annotation.Nullable;

import cn.cinemavault.app.capabilities.Capabilities;
import cn.cinemavault.app.capabilities.CapabilityRegistry;
import cn.cinemavault.app.capabilities.CapabilityResult;

/**
 * WebView 适配层：只负责把 CVNative 的 JS 调用翻译成能力层 dispatch，
 * 并用 evaluateJavascript 驱动前端 Promise / 事件通道。
 *
 * <p>这是"渐进式全原生"里可丢弃的一层 —— 原生 ViewModel 直接调
 * CapabilityRegistry，不再需要 JS 桥；能力实现本身完全复用。
 */
public final class CVNativeBridge {

    private final WebView webView;
    private final CapabilityRegistry registry;

    public CVNativeBridge(WebView webView, CapabilityRegistry registry) {
        this.webView = webView;
        this.registry = registry;
    }

    /**
     * JS 侧：CVNative.call('ui.toast', {message:'hi'}) → Promise
     * callbackId 由前端生成，原生回填 __cvResolve / __cvReject。
     */
    @JavascriptInterface
    public void call(String method, String argsJson, String callbackId) {
        CapabilityResult result = registry.dispatch(method, argsJson);
        String js = result.isOk()
                ? "window.__cvResolve && window.__cvResolve(" + jsString(callbackId) + "," + result.toJson() + ");"
                : "window.__cvReject && window.__cvReject(" + jsString(callbackId) + "," + result.toJson() + ");";
        evaluate(js);
    }

    /** 同步握手：返回协议版本 + 能力清单，前端据此决定能否调用某能力。 */
    @JavascriptInterface
    public String handshake() {
        CapabilityResult r = registry.dispatch(Capabilities.APP_GET_INFO, "");
        return r.toJson();
    }

    /** 原生 → JS 事件通道（如返回键事件）。 */
    public void emit(String event, @Nullable String payloadJson) {
        String js = "window.__cvEmit && window.__cvEmit(" + jsString(event) + ","
                + (payloadJson == null ? "null" : payloadJson) + ");";
        evaluate(js);
    }

    private void evaluate(String js) {
        try {
            webView.evaluateJavascript(js, null);
        } catch (Throwable ignored) {
            // WebView 已销毁时忽略
        }
    }

    /** 把 Java 字符串安全转义成 JS 字符串字面量（含引号）。 */
    private static String jsString(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\u2028': sb.append("\\u2028"); break;
                case '\u2029': sb.append("\\u2029"); break;
                default: sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
