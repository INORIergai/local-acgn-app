package cn.cinemavault.app.data.api

import android.content.Context
import android.content.SharedPreferences

/** 服务端地址配置（沿用旧版 server_url 键，便于升级迁移）。 */
object ServerConfig {
    private const val PREFS = "CinemaVaultPrefs"
    private const val KEY_SERVER_URL = "server_url"
    const val DEFAULT_PORT = 3517

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    var baseUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, normalize(value)).apply()
        }

    val isConfigured: Boolean
        get() = baseUrl.isNotBlank()

    /** 地址规范化：纯 IP 补 :3517；去尾斜杠。与旧版 normalizeUrl 对齐。 */
    fun normalize(raw: String): String {
        var u = raw.trim().trimEnd('/')
        if (u.isEmpty()) return u
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://$u"
        // trycloudflare 穿透地址强制 https 且去端口
        if (u.contains("trycloudflare.com")) {
            u = u.replace(Regex("^http://"), "https://")
            u = u.replace(Regex(":[0-9]+$"), "")
        } else if (u.contains("://")) {
            val afterScheme = u.substringAfter("://")
            if (!afterScheme.contains(":")) {
                // 无显式端口 → 补 3517（域名或 IP 都补）
                u = "$u:$DEFAULT_PORT"
            }
        }
        return u
    }

    fun api(path: String): String = baseUrl.trimEnd('/') + path
}
