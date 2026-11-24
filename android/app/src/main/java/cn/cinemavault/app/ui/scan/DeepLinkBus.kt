package cn.cinemavault.app.ui.scan

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * 扫码/深链到连接流程的单一入口。
 * NativeActivity 收到 cinemavault:// 深链时 offer；CinemaVaultApp 消费后调 MainViewModel。
 * 用 Compose State 而不是 EventBus，避免生命周期/重复消费问题。
 */
object DeepLinkBus {
    var pending: String? by mutableStateOf(null)
        private set

    fun offer(raw: String) {
        pending = raw
    }

    fun consume() {
        pending = null
    }
}
