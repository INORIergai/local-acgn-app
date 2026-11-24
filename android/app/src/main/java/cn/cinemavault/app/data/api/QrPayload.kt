package cn.cinemavault.app.data.api

import android.net.Uri

/** 扫码连接二维码的解析结果。 */
data class QrPayload(
    val baseUrl: String,
    val pairCode: String? = null
) {
    companion object {
        /**
         * 支持三种内容：
         *  1) cinemavault://pair?u=<地址>&c=<配对码>   ← 新版 connect.html
         *  2) http(s)://ip:port                        ← 旧版二维码
         *  3) ip:port / ip                             ← 只扫到地址
         */
        fun parse(raw: String): QrPayload? {
            val s = raw.trim()
            if (s.isEmpty()) return null
            if (s.startsWith("cinemavault://", ignoreCase = true)) {
                val uri = try { Uri.parse(s) } catch (e: Exception) { return null }
                if (!uri.host.equals("pair", ignoreCase = true)) return null
                val u = uri.getQueryParameter("u")?.trim().orEmpty()
                if (u.isEmpty()) return null
                val code = uri.getQueryParameter("c")?.trim()?.takeIf {
                    Regex("^[a-f0-9]{64}$").matches(it)
                }
                return QrPayload(ServerConfig.normalize(u), code)
            }
            if (s.startsWith("http://") || s.startsWith("https://")) {
                return QrPayload(ServerConfig.normalize(s), null)
            }
            if (Regex("^[0-9A-Za-z.-]+(:\\d+)?$").matches(s)) {
                return QrPayload(ServerConfig.normalize(s), null)
            }
            return null
        }
    }
}
