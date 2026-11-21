package cn.cinemavault.app

/**
 * 音量键翻页事件总线：阅读器打开时注册处理器，NativeActivity.dispatchKeyEvent
 * 把 VOLUME_DOWN/UP 转发进来。DOWN=下一页、UP=上一页（对齐前端映射）。
 */
object ReaderKeyBus {
    private var handler: ((Int) -> Boolean)? = null

    fun register(h: (Int) -> Boolean) { handler = h }
    fun unregister() { handler = null }

    /** direction: 1=下一页(DOWN), -1=上一页(UP)。返回是否被消费。 */
    fun dispatch(direction: Int): Boolean = handler?.invoke(direction) ?: false
}
