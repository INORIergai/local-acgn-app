package cn.cinemavault.app.data.prefs

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * 外观主题持久化：0=跟随系统 1=午夜场暗金 2=日场纸书。
 *
 * 用 Compose 的 mutableStateOf 承载当前值：设置页一改，读到它的地方立刻重组，
 * 不用重启。冷启动时从 SharedPreferences 读回，杀进程也不丢。
 * 复用 ServerConfig 的同一个 prefs 文件（CinemaVaultPrefs），不额外开库。
 */
object ThemeStore {
    private const val PREFS = "CinemaVaultPrefs"
    private const val KEY_THEME_MODE = "theme_mode"

    const val MODE_SYSTEM = 0
    const val MODE_DARK = 1
    const val MODE_LIGHT = 2

    private lateinit var prefs: SharedPreferences

    /** 当前主题模式；改动会触发重组。 */
    var mode by mutableStateOf(MODE_SYSTEM)
        private set

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        mode = prefs.getInt(KEY_THEME_MODE, MODE_SYSTEM)
    }

    fun set(value: Int) {
        val safe = if (value in MODE_SYSTEM..MODE_LIGHT) value else MODE_SYSTEM
        mode = safe
        prefs.edit().putInt(KEY_THEME_MODE, safe).apply()
    }

    /** 解析成「是否用深色」：跟随系统时用系统的深浅色判断。 */
    fun resolveDark(systemDark: Boolean): Boolean = when (mode) {
        MODE_DARK -> true
        MODE_LIGHT -> false
        else -> systemDark
    }
}