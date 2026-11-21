package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import org.json.JSONObject

/**
 * AI 能力数据层 —— 全部走 PC 端 /api/ai/ 系列接口，本地不放任何模型。
 * 用户约束：AI 必须 API 化；即使要本地部署也是 PC 侧部署后转 API 给手机。
 */
class AiRepository {

    data class Session(
        val id: String, val title: String, val archived: Int,
        val createdAt: Long, val updatedAt: Long, val messageCount: Int, val lastMessage: String?
    ) {
        companion object {
            fun from(j: JSONObject) = Session(
                j.optString("id"), j.optString("title").ifBlank { "新对话" },
                j.optInt("archived"), j.optLong("createdAt"), j.optLong("updatedAt"),
                j.optInt("messageCount"), j.optString("lastMessage").ifBlank { null }
            )
        }
    }

    data class AiStatus(
        val available: Boolean, val enabled: Boolean, val currentModel: String,
        val provider: String, val apiKeyConfigured: Boolean
    ) {
        companion object {
            fun from(j: JSONObject) = AiStatus(
                j.optBoolean("available"), j.optBoolean("enabled"), j.optString("currentModel"),
                j.optString("provider"), j.optBoolean("apiKeyConfigured")
            )
        }
    }

    data class Message(val role: String, val content: String)

    suspend fun status(): AiStatus {
        val d = ApiClient.unwrap(ApiClient.get("/api/ai/status"))
        return AiStatus.from(d)
    }

    suspend fun sessions(): List<Session> {
        val arr = ApiClient.unwrapArray(ApiClient.get("/api/ai/sessions"))
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let { Session.from(it) } }
    }

    suspend fun models(): List<String> = try {
        val d = ApiClient.unwrap(ApiClient.get("/api/ai/models"))
        val arr = d.optJSONArray("models") ?: org.json.JSONArray()
        (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.optString("id")?.ifBlank { null } }
    } catch (e: Exception) { emptyList() }

    suspend fun renameSession(id: String, title: String) {
        try {
            ApiClient.post("/api/ai/sessions/$id/rename", JSONObject().put("title", title))
        } catch (_: Exception) { }
    }

    suspend fun newSession(title: String = "新对话"): Session? {
        return try {
            val d = ApiClient.unwrap(ApiClient.post("/api/ai/sessions", JSONObject().put("title", title)))
            Session.from(d)
        } catch (e: Exception) { null }
    }

    /** 历史消息（独立端点 /api/ai/history，不是 /sessions/:id/history）。 */
    suspend fun history(sessionId: String): List<Message> = try {
        val enc = java.net.URLEncoder.encode(sessionId, "UTF-8")
        val d = ApiClient.unwrap(ApiClient.get("/api/ai/history?sessionId=$enc&limit=60"))
        val arr = d.optJSONArray("messages") ?: org.json.JSONArray()
        (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Message(o.optString("role"), o.optString("content"))
        }
    } catch (e: Exception) { emptyList() }

    /**
     * AI 聊天：优先 SSE 流式（/api/ai/agent/run），逐 token 回调；
     * 失败回退非流式 /api/ai/chat（body 字段是 message）。
     * @param onToken 增量文本回调（UI 累积显示）
     * @return 最终完整回复
     */
    suspend fun chat(
        message: String,
        sessionId: String,
        history: List<Message>,
        onToken: (String) -> Unit
    ): Result<String> {
        // 构造 history 数组（最近 12 条）
        val histArr = org.json.JSONArray()
        history.takeLast(12).forEach {
            histArr.put(JSONObject().put("role", it.role).put("content", it.content))
        }
        val body = JSONObject()
            .put("message", message)
            .put("sessionId", sessionId.ifBlank { "main" })
            .put("history", histArr)

        var finalText = ""
        var streamOk = false
        try {
            ApiClient.postSSE("/api/ai/agent/run", body) { frame ->
                when (frame.optString("type")) {
                    "token" -> {
                        val t = frame.optString("token")
                        finalText += t
                        onToken(t)
                    }
                    "done" -> {
                        val content = frame.optString("content")
                        if (content.isNotBlank()) {
                            finalText = content
                            onToken("") // 触发 UI 以最终全文刷新（去掉流式尾迹差异）
                        }
                        streamOk = true
                    }
                    "error" -> throw Exception(frame.optString("error", "AI 错误"))
                }
            }
            if (streamOk && finalText.isNotBlank()) return Result.success(finalText)
        } catch (e: Exception) {
            // SSE 失败 → 非流式降级
        }

        return try {
            val fallback = JSONObject()
                .put("message", message)
                .put("sessionId", sessionId.ifBlank { "main" })
            val d = ApiClient.unwrap(ApiClient.post("/api/ai/chat", fallback))
            val reply = d.optString("reply")
            if (reply.isNotBlank()) onToken(reply)
            Result.success(reply)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /** 让 AI 回复"说话"：走 /api/tts/synthesize 拿文件 URL（原生 MediaPlayer 播）。 */
    suspend fun ttsSpeak(text: String): String? = try {
        val clean = text.replace(Regex("\\[\\[.*?\\]\\]"), "")
            .replace(Regex("[（(][^)）]*[)）]"), "").trim().take(120)
        if (clean.isBlank()) null else {
            val d = ApiClient.unwrap(ApiClient.post("/api/tts/synthesize", JSONObject()
                .put("text", clean).put("play", false)))
            val path = d.optString("path").ifBlank { d.optString("wavPath") }
            if (path.isBlank()) null
            else {
                val name = path.substringAfterLast('/').substringAfterLast('\\')
                cn.cinemavault.app.data.api.ServerConfig.api("/api/tts/audio/$name")
            }
        }
    } catch (e: Exception) { null }

    data class Persona(val id: String, val name: String, val desc: String)
    data class PersonaState(val presets: List<Persona>, val currentId: String, val customPrompt: String)

    /** 人格预设列表 + 当前人格。 */
    suspend fun personas(): PersonaState = try {
        val d = ApiClient.unwrap(ApiClient.get("/api/ai/persona"))
        val arr = d.optJSONArray("presets") ?: org.json.JSONArray()
        val list = (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Persona(o.optString("id"), o.optString("name"), o.optString("desc"))
        }
        val cur = d.optJSONObject("current")
        PersonaState(list, cur?.optString("presetId") ?: "butler", cur?.optString("customPrompt") ?: "")
    } catch (e: Exception) {
        PersonaState(emptyList(), "butler", "")
    }

    /** 切换人格。 */
    suspend fun switchPersona(id: String, customPrompt: String = ""): Boolean = try {
        val r = ApiClient.post("/api/ai/persona", JSONObject()
            .put("presetId", id).put("customPrompt", customPrompt))
        r.optInt("code", -1) == 0
    } catch (e: Exception) { false }

    /** 工具区：技能数 / MCP / 最近任务数。 */
    suspend fun toolsSummary(): Triple<Int, Int, Int> = Triple(
        try { ApiClient.unwrap(ApiClient.get("/api/ai/skills")).optInt("count") } catch (e: Exception) { 0 },
        try { ApiClient.unwrap(ApiClient.get("/api/ai/mcp/status")).optInt("totalTools") } catch (e: Exception) { 0 },
        try { ApiClient.unwrapArray(ApiClient.get("/api/ai/agent/jobs?limit=20")).length() } catch (e: Exception) { 0 }
    )
}
