package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.model.Movie
import org.json.JSONObject

/** 影剧库：列表 / 搜索 / 详情。 */
class MovieRepository {

    /** 类型分段。film/cartoon 当前库为 0，jav/anime 需登录；privacy=adult 只看成人。 */
    suspend fun list(type: String, page: Int, privacy: String = "exclude"): ListResult = try {
        val privParam = if (type == "adult") "&privacy=adult" else "&privacy=$privacy"
        val root = ApiClient.get("/api/movie?sort=hot&filter=all&type=$type&page=$page&pageSize=40$privParam")
        val arr = ApiClient.unwrapArray(root)
        val total = root.optInt("total", arr.length())
        ListResult((0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let { Movie.from(it) } }, total)
    } catch (e: Exception) {
        throw e
    }

    suspend fun search(q: String, type: String = "all"): List<Movie> {
        if (q.isBlank()) return emptyList()
        val enc = java.net.URLEncoder.encode(q, "UTF-8")
        val root = ApiClient.get("/api/movie/search?q=$enc&type=$type&sort=name&order=asc")
        val arr = ApiClient.unwrapArray(root)
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let { Movie.from(it) } }
    }

    suspend fun detail(id: Long): JSONObject {
        val root = ApiClient.get("/api/movie/$id")
        return ApiClient.unwrap(root)
    }

    data class ListResult(val movies: List<Movie>, val total: Int)
}
