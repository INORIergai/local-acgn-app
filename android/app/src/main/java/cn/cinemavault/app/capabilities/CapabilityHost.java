package cn.cinemavault.app.capabilities;

/**
 * 能力层与宿主（Activity / 未来的原生容器）之间的窄接口。
 *
 * <p>能力 handler 不直接持有 MainActivity，只依赖本接口。
 * 全原生迁移时，新的原生容器实现同一接口即可，能力代码零改动。
 */
public interface CapabilityHost {
    void showToast(String message);

    void vibrateTap();

    /** UI 模式：normal / comic / novel / player / tts。 */
    void setUiMode(String mode);

    /** 阅读器模式（兼容旧桥语义）。 */
    void setReaderMode(boolean inReader);

    int getVersionCode();

    String getVersionName();

    /** 触发 APK 更新下载安装。 */
    void triggerUpdate(String url, String versionName, String sha256);

    /** H5 是否接管返回键：注册后由前端消费返回，原生侧不直接 goBack。 */
    void setBackHandler(boolean canHandle);

    /** 前端请求消费一次返回事件（由原生调用 CVNative 的 emit 回传）。 */
    boolean consumeBack();

    /** 前端放弃消费返回 → 执行原生默认返回链路。 */
    void releaseBack();
}
