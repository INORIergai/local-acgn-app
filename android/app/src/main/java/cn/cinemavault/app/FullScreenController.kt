package cn.cinemavault.app

import android.view.Window
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/** 全局沉浸控制：阅读器/播放器进入时隐藏系统栏，退出时恢复。 */
object FullScreenController {
    private var window: Window? = null

    fun bind(window: Window) { this.window = window }

    fun enter() {
        window?.let { w ->
            WindowCompat.getInsetsController(w, w.decorView).apply {
                hide(WindowInsetsCompat.Type.systemBars())
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
    }

    fun exit() {
        window?.let { w ->
            WindowCompat.getInsetsController(w, w.decorView).show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
