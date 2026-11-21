package cn.cinemavault.app.capabilities;

import org.json.JSONObject;

/** 把宿主能力绑定到注册表。新增能力只在这里加一行 register。 */
public final class CapabilityRegistrations {

    private CapabilityRegistrations() {
    }

    public static CapabilityRegistry build(CapabilityHost host) {
        CapabilityRegistry r = new CapabilityRegistry();

        r.register(Capabilities.APP_GET_INFO, args -> {
            JSONObject data = new JSONObject();
            try {
                data.put("bridgeVersion", Capabilities.BRIDGE_VERSION);
                data.put("appVersionCode", host.getVersionCode());
                data.put("appVersionName", host.getVersionName());
                org.json.JSONArray caps = new org.json.JSONArray();
                for (String c : Capabilities.all()) caps.put(c);
                data.put("capabilities", caps);
            } catch (Throwable ignored) {
            }
            return CapabilityResult.success(data);
        });

        r.register(Capabilities.UI_TOAST, args ->
                ok(() -> host.showToast(args.optString("message", ""))));

        r.register(Capabilities.UI_VIBRATE, args ->
                ok(host::vibrateTap));

        r.register(Capabilities.UI_SET_MODE, args ->
                ok(() -> host.setUiMode(args.optString("mode", "normal"))));

        r.register(Capabilities.READER_SET_MODE, args ->
                ok(() -> host.setReaderMode(args.optBoolean("enabled", false))));

        r.register(Capabilities.NAV_SET_BACK_HANDLER, args ->
                ok(() -> host.setBackHandler(args.optBoolean("enabled", false))));

        r.register(Capabilities.NAV_RELEASE_BACK, args ->
                ok(host::releaseBack));

        r.register(Capabilities.UPDATE_TRIGGER, args -> {
            String url = args.optString("url", "");
            String ver = args.optString("versionName", "");
            String sha = args.optString("sha256", null);
            if (url.isEmpty()) return CapabilityResult.failure("MISSING_URL");
            return ok(() -> host.triggerUpdate(url, ver, sha));
        });

        return r;
    }

    private interface ThrowingRunnable {
        void run() throws Throwable;
    }

    private static CapabilityResult ok(ThrowingRunnable action) {
        try {
            action.run();
            return CapabilityResult.success(new JSONObject());
        } catch (Throwable t) {
            return CapabilityResult.failure(t.getMessage());
        }
    }
}
