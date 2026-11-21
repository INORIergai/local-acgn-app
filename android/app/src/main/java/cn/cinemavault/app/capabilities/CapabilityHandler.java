package cn.cinemavault.app.capabilities;

import org.json.JSONObject;

/**
 * 单个能力处理器。
 *
 * <p>故意做成纯 Java 接口（不继承 Android 类、不持有 WebView）——
 * 这样同一个 handler 在 WebView 桥和未来的原生 ViewModel 里都能注册复用，
 * 是"渐进式全原生迁移"的接缝点。
 */
public interface CapabilityHandler {
    CapabilityResult handle(JSONObject args);
}
