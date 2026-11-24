package cn.cinemavault.app.data.prefs

import android.content.Context
import android.content.SharedPreferences

/** 应用更新偏好：自动检查、忽略版本、上次检查时间。 */
object UpdatePrefs {
    private const val PREFS = "CinemaVaultPrefs"
    private const val KEY_AUTO_CHECK = "update_auto_check"
    private const val KEY_IGNORED_CODE = "update_ignored_code"
    private const val KEY_LAST_CHECK = "update_last_check_at"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    var autoCheck: Boolean
        get() = prefs.getBoolean(KEY_AUTO_CHECK, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_CHECK, value).apply()

    var ignoredVersionCode: Int
        get() = prefs.getInt(KEY_IGNORED_CODE, 0)
        set(value) = prefs.edit().putInt(KEY_IGNORED_CODE, value).apply()

    var lastCheckAt: Long
        get() = prefs.getLong(KEY_LAST_CHECK, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_CHECK, value).apply()
}
