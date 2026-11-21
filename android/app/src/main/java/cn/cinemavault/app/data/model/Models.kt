package cn.cinemavault.app.data.model

import org.json.JSONObject

/** 核心影片 DTO（MovieRow 子集，够首页/列表用）。 */
data class Movie(
    val id: Long,
    val title: String,
    val type: String,
    val posterPath: String?,
    val localPosterPath: String?,
    val score: Double,
    val episodeCount: Int,
    val filePath: String,
    val overview: String,
    val watched: Boolean
) {
    companion object {
        fun from(j: JSONObject) = Movie(
            id = j.optLong("id"),
            title = j.optString("title").ifBlank { j.optString("cleanName").ifBlank { j.optString("fileName") } },
            type = j.optString("type"),
            posterPath = j.optString("posterPath").nullIfBlank(),
            localPosterPath = j.optString("localPosterPath").nullIfBlank(),
            score = j.optDouble("score", 0.0),
            episodeCount = j.optInt("episodeCount", 0),
            filePath = j.optString("filePath"),
            overview = j.optString("overview"),
            watched = j.optInt("watched", 0) == 1
        )
    }
}

private fun String.nullIfBlank(): String? = if (isBlank()) null else this

/** 本周放送条目。 */
data class CalendarItem(
    val title: String,
    val episode: Int?,
    val cover: String?,
    val score: Double,
    val totalEps: Int,
    val label: String
)

/** 统计概览。 */
data class Stats(
    val totalMovies: Int,
    val watchedCount: Int,
    val actressCount: Int,
    val tagCount: Int
) {
    companion object {
        fun from(j: JSONObject) = Stats(
            totalMovies = j.optInt("totalMovies"),
            watchedCount = j.optInt("watchedCount"),
            actressCount = j.optInt("actressCount"),
            tagCount = j.optInt("tagCount")
        )
    }
}

/** 海报完整 URL（对齐前端 getPosterUrl）。 */
fun Movie.posterUrl(base: String): String {
    var f = posterPath
    val local = localPosterPath?.substringAfterLast('/')?.substringAfterLast('\\').orEmpty()
    if (f?.startsWith("http") == true) {
        if (local.isNotEmpty()) f = local
        else return "$base/api/movie/poster/proxy?url=" + java.net.URLEncoder.encode(f, "UTF-8")
    }
    if (f.isNullOrEmpty() && local.isNotEmpty()) f = local
    return if (f.isNullOrEmpty()) "" else "$base/api/movie/poster/$f"
}
