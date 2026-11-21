package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig

/** 漫画/小说阅读器数据层。 */
class ReaderRepository {

    data class ComicInfo(
        val id: Long, val title: String, val format: String,
        val totalPages: Int, val currentPage: Int
    ) {
        companion object {
            fun from(j: org.json.JSONObject) = ComicInfo(
                j.optLong("id"), j.optString("title"), j.optString("format"),
                j.optInt("totalPages"), j.optInt("currentPage")
            )
        }
    }

    data class Chapter(val index: Int, val title: String, val length: Int, val hasImage: Boolean)
    data class NovelInfo(
        val id: Long, val title: String, val readKind: String,
        val totalChapters: Int, val currentChapter: Int, val chapters: List<Chapter>
    ) {
        companion object {
            fun from(j: org.json.JSONObject): NovelInfo {
                val arr = j.optJSONArray("chapters")
                val list = mutableListOf<Chapter>()
                if (arr != null) for (i in 0 until arr.length()) {
                    val c = arr.optJSONObject(i) ?: continue
                    list.add(Chapter(c.optInt("index"), c.optString("title"),
                        c.optInt("length"), c.optBoolean("hasImage")))
                }
                return NovelInfo(j.optLong("id"), j.optString("title"), j.optString("readKind"),
                    j.optInt("totalChapters"), j.optInt("currentChapter"), list)
            }
        }
    }

    suspend fun comicInfo(id: Long): ComicInfo {
        val root = ApiClient.get("/api/comic/$id/info")
        if (root.optInt("code", -1) != 0) throw Exception(root.optString("msg", "加载失败"))
        return ComicInfo.from(ApiClient.unwrap(root))
    }

    suspend fun novelInfo(id: Long): NovelInfo {
        val root = ApiClient.get("/api/novel/$id/info")
        if (root.optInt("code", -1) != 0) throw Exception(root.optString("msg", "加载失败"))
        return NovelInfo.from(ApiClient.unwrap(root))
    }

    data class ChapterContent(val index: Int, val title: String, val content: String, val isHtml: Boolean)

    suspend fun chapter(id: Long, index: Int): ChapterContent {
        val root = ApiClient.get("/api/novel/$id/chapter/$index")
        if (root.optInt("code", -1) != 0) throw Exception(root.optString("msg", "章节超出范围"))
        val d = ApiClient.unwrap(root)
        val html = d.optBoolean("isHtml")
        var text = if (html) d.optString("content") else d.optString("text").ifBlank { d.optString("content") }
        // 图片相对路径补全为绝对 URL（带 Cookie 由 Coil 加载）
        text = text.replace("src=\"/api/novel/", "src=\"${ServerConfig.baseUrl}/api/novel/")
        return ChapterContent(d.optInt("index"), d.optString("title"), text, html)
    }

    /** 当前章机翻润色：服务端按书/章缓存，结果不覆盖原书。 */
    suspend fun polishNovel(id: Long, chapterIndex: Int): String {
        val root = ApiClient.post(
            "/api/novel/$id/ai-companion",
            org.json.JSONObject().put("mode", "polish").put("chapterIndex", chapterIndex)
        )
        return ApiClient.unwrap(root).optString("text")
    }

    suspend fun saveComicProgress(id: Long, page: Int, total: Int) {
        try {
            ApiClient.post("/api/comic/$id/progress", org.json.JSONObject()
                .put("page", page).put("total", total))
        } catch (_: Exception) { /* 进度写入失败不影响阅读 */ }
    }

    suspend fun saveNovelProgress(id: Long, chapter: Int, total: Int) {
        try {
            ApiClient.post("/api/novel/$id/progress", org.json.JSONObject()
                .put("chapter", chapter).put("position", 0).put("total", total))
        } catch (_: Exception) { }
    }

    suspend fun startReading(id: Long, kind: String) {
        try { ApiClient.post("/api/$kind/$id/start-reading", org.json.JSONObject()) } catch (_: Exception) { }
    }

    suspend fun stopReading(id: Long, kind: String) {
        try { ApiClient.post("/api/$kind/$id/stop-reading", org.json.JSONObject()) } catch (_: Exception) { }
    }

    fun pageUrl(id: Long, index: Int) = ServerConfig.api("/api/comic/$id/page/$index")
}
