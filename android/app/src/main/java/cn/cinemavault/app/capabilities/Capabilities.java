package cn.cinemavault.app.capabilities;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 能力契约的单一定义源：版本号 + 能力名清单。
 *
 * <p>这一层刻意不依赖 WebView 或 Activity —— 全原生迁移后，Compose ViewModel
 * 直接读同一份清单来探测设备能力，因此今天定义的契约在纯原生架构里同样有效。
 */
public final class Capabilities {

    /** 契约协议版本。前端据此决定是否降级；ABI 变更时 +1。 */
    public static final int BRIDGE_VERSION = 1;

    // ── 命名空间.方法 ─────────────────────────────────────────────
    public static final String APP_GET_INFO = "app.getInfo";
    public static final String UI_TOAST = "ui.toast";
    public static final String UI_VIBRATE = "ui.vibrate";
    public static final String UI_SET_MODE = "ui.setMode";
    public static final String READER_SET_MODE = "reader.setMode";
    public static final String NAV_SET_BACK_HANDLER = "nav.setBackHandler";
    public static final String NAV_RELEASE_BACK = "nav.releaseBack";
    public static final String UPDATE_TRIGGER = "update.trigger";

    /** 当前实现的能力集合（有序、不可变）。 */
    private static final Set<String> IMPLEMENTED = Collections.unmodifiableSet(
            new LinkedHashSet<>(Arrays.asList(
                    APP_GET_INFO,
                    UI_TOAST,
                    UI_VIBRATE,
                    UI_SET_MODE,
                    READER_SET_MODE,
                    NAV_SET_BACK_HANDLER,
                    NAV_RELEASE_BACK,
                    UPDATE_TRIGGER)));

    private Capabilities() {
    }

    public static boolean has(String name) {
        return name != null && IMPLEMENTED.contains(name);
    }

    public static List<String> all() {
        return Collections.unmodifiableList(new java.util.ArrayList<>(IMPLEMENTED));
    }

    /** 尚未实现、但契约已预留的能力（前端据此显示"即将支持"而非静默失败）。 */
    public static boolean isPlanned(String name) {
        return name != null && (name.startsWith("media.") || name.startsWith("tts.")
                || name.startsWith("scanner.") || name.startsWith("file."));
    }
}
