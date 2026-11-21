package cn.cinemavault.app.capabilities;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * 能力注册表：能力名 → 处理器。是全原生迁移的核心接缝。
 *
 * <p>过渡期：BridgeHost（WebView 适配层）把 JS 调用转成 dispatch；
 * 未来：Compose ViewModel 直接持有本注册表调用同一批 handler。
 * 换载体不换能力实现。
 */
public final class CapabilityRegistry {

    private static final String TAG = "CV natives";

    private final Map<String, CapabilityHandler> handlers = new HashMap<>();

    public void register(String name, CapabilityHandler handler) {
        if (name == null || handler == null) return;
        handlers.put(name, handler);
    }

    public void unregister(String name) {
        handlers.remove(name);
    }

    public boolean has(String name) {
        return handlers.containsKey(name);
    }

    /**
     * 调用一个能力。args 为 JSON 对象字符串（可为空）。
     * 永远不抛异常：任何失败都转成 failure result，保证桥层稳定。
     */
    public CapabilityResult dispatch(String name, String argsJson) {
        CapabilityHandler handler = name != null ? handlers.get(name) : null;
        if (handler == null) {
            if (Capabilities.isPlanned(name)) {
                return CapabilityResult.failure("CAPABILITY_PLANNED: " + name);
            }
            return CapabilityResult.failure("CAPABILITY_NOT_FOUND: " + name);
        }
        JSONObject args;
        try {
            args = (argsJson == null || argsJson.isEmpty()) ? new JSONObject() : new JSONObject(argsJson);
        } catch (JSONException e) {
            return CapabilityResult.failure("BAD_ARGS: " + e.getMessage());
        }
        try {
            return handler.handle(args);
        } catch (Throwable t) {
            Log.e(TAG, "dispatch failed: " + name, t);
            return CapabilityResult.failure("HANDLER_ERROR: " + t.getMessage());
        }
    }
}
