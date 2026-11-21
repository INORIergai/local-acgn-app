package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig
import org.json.JSONObject

/** 在线追番：聚合在线搜索（watch-hub）数据层。 */
class OnlineRepository {

    data class Site(val key: String, val name: String, val canSearch: Boolean)
    data class Result(val href: String, val cover: String?, val title: String, val duration: String)

    suspend fun sites(): List<Site> = try {
        val arr = ApiClient.unwrapArray(ApiClient.get("/api/webview/sites"))
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Site(o.optString("key"), o.optString("name"), o.optBoolean("canSearch"))
        }.filter { it.canSearch }
    } catch (e: Exception) { emptyList() }

    suspend fun search(site: String, q: String): List<Result> = try {
        val enc = java.net.URLEncoder.encode(q, "UTF-8")
        val root = ApiClient.get("/api/webview/list?site=$site&q=$enc&limit=24")
        val d = ApiClient.unwrap(root)
        val items = d.optJSONArray("items") ?: org.json.JSONArray()
        (0 until items.length()).mapNotNull { i ->
            val o = items.optJSONObject(i) ?: return@mapNotNull null
            var cover = o.optString("cover").ifBlank { null }
            if (cover?.startsWith("/") == true) cover = ServerConfig.api(cover)
            Result(o.optString("href"), cover, o.optString("title"), o.optString("duration"))
        }
    } catch (e: Exception) { emptyList() }

    /** 解析在线源为可播放 streamUrl。 */
    suspend fun resolve(url: String): String? = try {
        val enc = java.net.URLEncoder.encode(url, "UTF-8")
        val root = ApiClient.get("/api/media-source/resolve?url=$enc")
        val d = ApiClient.unwrap(root)
        val stream = d.optString("streamUrl").ifBlank { d.optString("url") }
        if (stream.isBlank()) null
        else if (stream.startsWith("http")) stream else ServerConfig.api(stream)
    } catch (e: Exception) { null }
}
