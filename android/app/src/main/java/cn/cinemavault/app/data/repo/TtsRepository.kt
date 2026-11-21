package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig
import org.json.JSONObject

/** TTS 听书：章节文本 → 分块 → 逐块合成 → 音频 URL 列表（交给前台 Service 连播）。 */
class TtsRepository {

    /** 探测引擎是否就绪。 */
    suspend fun status(): String = try {
        val d = ApiClient.unwrap(ApiClient.get("/api/tts/status"))
        "${d.optString("engine")}:${d.optString("state")}"
    } catch (e: Exception) { "unknown" }

    /** 章节纯文本。 */
    suspend fun chapterText(bookId: Long, chapter: Int): Pair<String, String> = try {
        val d = ApiClient.unwrap(ApiClient.get("/api/novel/$bookId/chapter/$chapter"))
        val text = d.optString("text").ifBlank {
            d.optString("content").replace(Regex("<[^>]+>"), " ").replace(Regex("\\s+"), " ").trim()
        }
        Pair(d.optString("title"), text)
    } catch (e: Exception) { Pair("", "") }

    /**
     * 分块（对齐前端 splitText）：非 breeze 220 字（首块 50），按句末切分。
     * 这里统一用 180 字上限（首块 50），够用且稳。
     */
    fun split(text: String, max: Int = 180): List<String> {
        val parts = text.split(Regex("(?<=[。！？；…\\n])|(?<=[.!?;])\\s+"))
        val out = mutableListOf<String>()
        var buf = ""
        for (p in parts) {
            if ((buf + p).length > max && buf.isNotEmpty()) {
                out.add(buf); buf = p
            } else buf += p
            while (buf.length > max) {
                out.add(buf.take(max)); buf = buf.drop(max)
            }
        }
        if (buf.isNotBlank()) out.add(buf)
        return if (out.isEmpty()) listOf(text) else out
    }

    /** 合成一块，返回可播放的绝对 URL（play:false，服务端不占用音频设备）。 */
    suspend fun synthesize(text: String): String? = try {
        val d = ApiClient.unwrap(ApiClient.post("/api/tts/synthesize", JSONObject()
            .put("text", text).put("play", false)))
        val path = d.optString("path").ifBlank { d.optString("wavPath") }
        if (path.isBlank()) null else {
            val name = path.substringAfterLast('/').substringAfterLast('\\')
            ServerConfig.api("/api/tts/audio/$name")
        }
    } catch (e: Exception) { null }

    /** 音色条目：fishaudio 下 id 就是 reference_id。 */
    data class Voice(val id: String, val name: String, val group: String)

    /** 当前音色 id + 可选音色列表。 */
    suspend fun fishVoices(): Pair<String, List<Voice>> {
        val d = ApiClient.unwrap(ApiClient.get("/api/tts/voices?engine=fishaudio"))
        val arr = d.optJSONArray("voices")
        val list = mutableListOf<Voice>()
        if (arr != null) {
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                list.add(Voice(o.optString("id"), o.optString("name"), o.optString("group")))
            }
        }
        return Pair(d.optString("current"), list)
    }

    /** 选音色：服务端热重载，无需重启（同时会同步 AI 伴侣声线）。 */
    suspend fun selectFishVoice(id: String, name: String) {
        ApiClient.unwrap(ApiClient.post(
            "/api/tts/fishaudio/voice",
            JSONObject().put("referenceId", id).put("voiceName", name)
        ))
    }

    /** 读完标 done。 */
    suspend fun markDone(bookId: Long) {
        try { ApiClient.post("/api/media/novel/$bookId/status", JSONObject().put("status", "done")) }
        catch (_: Exception) { }
    }
}
