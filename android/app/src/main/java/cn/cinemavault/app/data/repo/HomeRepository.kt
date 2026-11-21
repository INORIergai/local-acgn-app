package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.model.CalendarItem
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.model.Stats
import org.json.JSONObject

class HomeRepository {
    /** 本周放送（免鉴权）。 */
    suspend fun calendar(): List<CalendarItem> = try {
        val root = ApiClient.get("/api/acg/calendar")
        val data = ApiClient.unwrap(root)
        val days = data.optJSONArray("days") ?: org.json.JSONArray()
        val result = mutableListOf<CalendarItem>()
        for (i in 0 until minOf(days.length(), 7)) {
            val day = days.optJSONObject(i) ?: continue
            val label = day.optString("label")
            val items = day.optJSONArray("items") ?: continue
            for (j in 0 until minOf(items.length(), 8)) {
                val it = items.optJSONObject(j) ?: continue
                result.add(CalendarItem(
                    title = it.optString("title"),
                    episode = it.opt("episode")?.let { v -> if (v is Number) v.toInt() else null },
                    cover = it.optString("cover").ifBlank { null },
                    score = it.optDouble("score", 0.0),
                    totalEps = it.optInt("totalEps", 0),
                    label = label
                ))
            }
        }
        result
    } catch (e: Exception) {
        throw e
    }

    /** 热度榜（需登录，取公开视图 exclude）。 */
    suspend fun hot(): List<Movie> = try {
        val root = ApiClient.get("/api/movie?sort=hot&filter=all&type=all&privacy=exclude&page=1&pageSize=20")
        val arr = ApiClient.unwrapArray(root)
        (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let { Movie.from(it) } }
    } catch (e: Exception) {
        throw e
    }

    /** 统计概览。 */
    suspend fun stats(): Stats? = try {
        val root = ApiClient.get("/api/stats/overview")
        Stats.from(ApiClient.unwrap(root))
    } catch (e: Exception) {
        null
    }
}
