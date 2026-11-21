package cn.cinemavault.app.capabilities;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 能力调用的统一返回值。所有 handler 都返回它，桥层据此驱动
 * 前端 Promise 的 resolve / reject。
 */
public final class CapabilityResult {

    private final boolean ok;
    private final JSONObject data;
    private final String error;

    private CapabilityResult(boolean ok, JSONObject data, String error) {
        this.ok = ok;
        this.data = data;
        this.error = error;
    }

    public static CapabilityResult success(JSONObject data) {
        return new CapabilityResult(true, data != null ? data : new JSONObject(), null);
    }

    public static CapabilityResult failure(String error) {
        return new CapabilityResult(false, new JSONObject(), error);
    }

    public boolean isOk() {
        return ok;
    }

    public String error() {
        return error;
    }

    /** 序列化为 JSON 字符串，供 evaluateJavascript 回填。 */
    public String toJson() {
        JSONObject wrapper = new JSONObject();
        try {
            wrapper.put("ok", ok);
            if (ok) {
                wrapper.put("data", data);
            } else {
                wrapper.put("error", error);
            }
        } catch (JSONException e) {
            return "{\"ok\":false,\"error\":\"serialize-failed\"}";
        }
        return wrapper.toString();
    }
}
