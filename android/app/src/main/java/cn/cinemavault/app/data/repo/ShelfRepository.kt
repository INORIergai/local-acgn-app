package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.model.Movie

/** 书架：漫画/小说列表（复用 /api/movie?type=comic|novel），带阅读进度。 */
class ShelfRepository {
    suspend fun books(kind: String): List<Movie> {
        val root = ApiClient.get("/api/movie?type=$kind&sort=lastplay&page=1&pageSize=200&privacy=exclude")
        val arr = ApiClient.unwrapArray(root)
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let { Movie.from(it) } }
    }

    /** 阅读进度 map：{movieId: percent}。 */
    suspend fun progressMap(): Map<Long, Int> = try {
        val root = ApiClient.get("/api/media/progress-map?type=all")
        val data = ApiClient.unwrap(root)
        val out = mutableMapOf<Long, Int>()
        data.keys().forEach { key ->
            out[key.toLongOrNull() ?: return@forEach] = data.optInt(key)
        }
        out
    } catch (e: Exception) {
        emptyMap()
    }
}
