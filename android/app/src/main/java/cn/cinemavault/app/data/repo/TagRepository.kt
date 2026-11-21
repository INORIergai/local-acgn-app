package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.model.Movie
import org.json.JSONObject
import java.net.URLEncoder

/** 五库标签检索与组合筛选（film/anime/comic/novel/jav）。 */
class TagRepository {
    data class Tag(val id: Int, val name: String, val movieCount: Int)

    suspend fun list(lib: String, query: String = ""): List<Tag> {
        val q = URLEncoder.encode(query, "UTF-8")
        val root = ApiClient.get("/api/tags?lib=$lib&q=$q")
        val arr = ApiClient.unwrapArray(root)
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let {
                Tag(it.optInt("id"), it.optString("name"), it.optInt("movieCount"))
            }
        }.filter { it.movieCount > 0 }
    }

    /** mode=and 交集 / or 并集；lib 与标签列表保持同一资源库，避免串库。 */
    suspend fun filter(tagIds: List<Int>, lib: String, mode: String = "and"): List<Movie> {
        if (tagIds.isEmpty()) return emptyList()
        val body = JSONObject()
            .put("tagIds", org.json.JSONArray(tagIds))
            .put("lib", lib)
            .put("mode", mode)
        val arr = ApiClient.unwrapArray(ApiClient.post("/api/tags/filter/movies", body))
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { Movie.from(it) }
        }
    }
}