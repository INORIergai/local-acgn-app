package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import org.json.JSONObject

/** 追番（round173 series 系统）数据层。 */
class SeriesRepository {

    data class Series(
        val id: Long, val title: String, val posterPath: String?, val type: String,
        val status: String, val episodeCount: Int, val followStatus: String?,
        val favorite: Int, val episodeTotal: Int, val watchedCount: Int, val nextEpisode: Int,
        val overview: String
    ) {
        companion object {
            fun from(j: JSONObject) = Series(
                j.optLong("id"), j.optString("title"),
                j.optString("posterPath").ifBlank { null },
                j.optString("type"), j.optString("status"), j.optInt("episodeCount"),
                j.optString("followStatus").ifBlank { null },
                j.optInt("favorite", -1), j.optInt("episodeTotal"), j.optInt("watchedCount"),
                j.optInt("nextEpisode"), j.optString("overview")
            )
        }
    }

    data class CalendarItem(
        val title: String, val cover: String?, val seriesId: Long,
        val followStatus: String?, val episode: Int?, val date: String
    )

    data class Episode(
        val id: Long, val episodeNo: Int, val title: String, val duration: Double,
        val movieId: Long?, val position: Double, val watched: Boolean, val hasSource: Boolean
    )

    data class Detail(val series: Series, val episodes: List<Episode>)

    /** 看板：status=null 取全部。 */
    suspend fun follows(status: String?): List<Series> {
        val path = if (status == null) "/api/series/follows" else "/api/series/follows?status=$status"
        val root = ApiClient.get(path)
        val arr = ApiClient.unwrapArray(root)
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let { Series.from(it) } }
    }

    /**
     * 本周新番。用稳定的 /api/acg/calendar（首页同款），
     * 不用 /api/series/from-calendar —— 后者首次会触发大量抓取，曾把服务端拖崩（unexpected end of stream）。
     */
    suspend fun calendar(): List<CalendarItem> = try {
        val root = ApiClient.get("/api/acg/calendar")
        val data = ApiClient.unwrap(root)
        val days = data.optJSONArray("days") ?: org.json.JSONArray()
        val out = mutableListOf<CalendarItem>()
        for (d in 0 until days.length()) {
            val day = days.optJSONObject(d) ?: continue
            val date = day.optString("date")
            val items = day.optJSONArray("items") ?: continue
            for (i in 0 until minOf(items.length(), 8)) {
                val o = items.optJSONObject(i) ?: continue
                val ep = o.opt("episode")
                // acg/calendar 的 cover 是远程 URL，用 /api/acg/cover?u= 代理
                val cover = o.optString("cover").ifBlank { null }
                val proxied = if (cover?.startsWith("http") == true)
                    cn.cinemavault.app.data.api.ServerConfig.api(
                        "/api/acg/cover?u=" + java.net.URLEncoder.encode(cover, "UTF-8")) else cover
                // acg/calendar 无 series 库 id，seriesId 固定 0 → 点击时提示“尚未入库”
                out.add(CalendarItem(
                    o.optString("title"), proxied, 0L, null,
                    if (ep is Number) ep.toInt() else null, date
                ))
            }
        }
        out
    } catch (e: Exception) {
        emptyList()
    }

    /** 详情 + 分集（含进度 + 在线源标记）。 */
    suspend fun detail(id: Long): Detail {
        val root = ApiClient.get("/api/series/$id/detail")
        val data = ApiClient.unwrap(root)
        val series = Series.from(data.optJSONObject("series") ?: JSONObject())
        val progress: Map<Long, JSONObject> = try {
            val pr = ApiClient.get("/api/series/$id/progress")
            val pd = ApiClient.unwrap(pr)
            val map = mutableMapOf<Long, JSONObject>()
            val it = pd.keys()
            while (it.hasNext()) {
                val key = it.next()
                map[key.toLongOrNull() ?: 0L] = pd.optJSONObject(key) ?: JSONObject()
            }
            map
        } catch (e: Exception) { emptyMap() }

        val arr = data.optJSONArray("episodes") ?: org.json.JSONArray()
        val episodes = (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val eid = o.optLong("id")
            val p = progress[eid]
            Episode(
                eid, o.optInt("episodeNo"), o.optString("title"), o.optDouble("duration"),
                if (o.isNull("movieId")) null else o.optLong("movieId"),
                p?.optDouble("position", 0.0) ?: o.optDouble("position", 0.0),
                (p?.optInt("watched", 0) ?: o.optInt("watched", 0)) == 1,
                false
            )
        }
        return Detail(series, episodes)
    }

    suspend fun follow(seriesId: Long, status: String = "watching") {
        try {
            ApiClient.post("/api/series/follow", JSONObject()
                .put("seriesId", seriesId).put("status", status))
        } catch (_: Exception) { }
    }

    suspend fun unfollow(seriesId: Long) {
        try { ApiClient.post("/api/series/unfollow", JSONObject().put("seriesId", seriesId)) } catch (_: Exception) { }
    }

    suspend fun onlineUrl(episodeId: Long): String? = try {
        val root = ApiClient.get("/api/series/episode/online-url?episodeId=$episodeId")
        val d = ApiClient.unwrap(root)
        d.optString("url").ifBlank { null }
    } catch (e: Exception) { null }
}
