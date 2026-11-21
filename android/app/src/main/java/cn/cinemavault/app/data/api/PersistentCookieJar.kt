package cn.cinemavault.app.data.api

import android.content.Context
import android.content.SharedPreferences
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * 把 lml_session 等 Cookie 持久化到 SharedPreferences，进程重启后仍登录。
 * 用 name|value|expiresAt(ms)|domain|path 的自有格式，避开 OkHttp Cookie 内部 API 差异。
 */
class PersistentCookieJar(context: Context) : CookieJar {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("cine_cookies", Context.MODE_PRIVATE)

    private val memory = mutableMapOf<String, MutableList<Cookie>>()

    init {
        prefs.all.forEach { (key, value) ->
            if (value is String) {
                memory[key] = value.lines().mapNotNull { parse(it) }.toMutableList()
            }
        }
    }

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val host = url.host
        val list = memory.getOrPut(host) { mutableListOf() }
        cookies.forEach { c ->
            list.removeAll { it.name == c.name }
            // expiresAt == Long.MIN_VALUE 表示会话 Cookie / 删除指令
            if (c.expiresAt > System.currentTimeMillis()) list.add(c)
        }
        prefs.edit().putString(host, list.joinToString("\n") { serialize(it) }).apply()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        return memory[url.host]?.filter { it.expiresAt > now } ?: emptyList()
    }

    fun clear() {
        memory.clear()
        prefs.edit().clear().apply()
    }

    private fun serialize(c: Cookie): String = listOf(
        c.name, c.value, c.expiresAt.toString(), c.domain, c.path
    ).joinToString("\u0001")

    private fun parse(s: String): Cookie? {
        return try {
            val p = s.split("\u0001")
            if (p.size < 5) return null
            val expires = p[2].toLongOrNull() ?: return null
            if (expires <= System.currentTimeMillis()) return null
            Cookie.Builder()
                .name(p[0]).value(p[1]).domain(p[3]).path(p[4])
                .expiresAt(expires)
                .build()
        } catch (e: Exception) {
            null
        }
    }
}
