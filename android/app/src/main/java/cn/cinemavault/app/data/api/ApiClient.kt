package cn.cinemavault.app.data.api

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** 轻量 HTTP 客户端（OkHttp + 持久化 Cookie），对齐前端 fetch('/api/...')。 */
object ApiClient {

    class ApiException(message: String, val code: Int = -1) : Exception(message)

    lateinit var client: OkHttpClient
        private set
    lateinit var cookieJar: PersistentCookieJar
        private set

    fun init(context: Context) {
        cookieJar = PersistentCookieJar(context)
        client = OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .connectTimeout(20, TimeUnit.SECONDS)
            // 追番 from-calendar 首次可能要抓 90+ 条源，放宽读取超时
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    suspend fun get(path: String): JSONObject = request("GET", path, null)

    suspend fun post(path: String, body: JSONObject): JSONObject =
        request("POST", path, body.toString())

    private suspend fun request(method: String, path: String, bodyJson: String?): JSONObject =
        withContext(Dispatchers.IO) {
            val url = ServerConfig.api(path)
            val body = if (bodyJson != null)
                bodyJson.toRequestBody("application/json; charset=utf-8".toMediaType())
            else null
            val req = Request.Builder()
                .url(url)
                .method(method, body)
                .header("Accept", "application/json")
                .build()
            try {
                // 整章 AI 润色实测可超过 60 秒；只对伴读接口放宽，其他请求维持原超时
                val callClient = if (path.contains("/ai-companion")) {
                    client.newBuilder().readTimeout(180, TimeUnit.SECONDS).build()
                } else client
                callClient.newCall(req).execute().use { resp ->
                    val text = resp.body?.string() ?: ""
                    if (!resp.isSuccessful) {
                        // 失败体里通常有 {code:-1,msg:'...'}，尽量解析出 msg
                        val msg = try {
                            val j = JSONObject(text); j.optString("msg", j.optString("message", "HTTP ${resp.code}"))
                        } catch (e: Exception) { "HTTP ${resp.code}" }
                        throw ApiException(msg, resp.code)
                    }
                    if (text.isBlank()) JSONObject()
                    else JSONObject(text)
                }
            } catch (e: ApiException) {
                throw e
            } catch (e: Exception) {
                throw ApiException("网络错误: ${e.message}")
            }
        }

    /**
     * SSE 流式 POST：逐帧解析 `data: <json>\n\n`，把每帧的 JSONObject 回调给 onEvent。
     * 用于 AI 聊天主链路 /api/ai/agent/run（真 token 流）。
     */
    suspend fun postSSE(path: String, body: JSONObject, onEvent: (JSONObject) -> Unit) =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(ServerConfig.api(path))
                .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
                .header("Accept", "text/event-stream")
                .build()
            try {
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw ApiException("HTTP ${resp.code}", resp.code)
                    val reader = resp.body?.byteStream()?.bufferedReader(Charsets.UTF_8)
                        ?: throw ApiException("empty stream")
                    reader.useLines { lines ->
                        for (line in lines) {
                            if (line.startsWith("data:")) {
                                val payload = line.removePrefix("data:").trim()
                                if (payload.isEmpty() || payload == "[DONE]") continue
                                try { onEvent(JSONObject(payload)) } catch (_: Exception) { }
                            }
                            // 心跳 ': ping' 与其它行忽略
                        }
                    }
                }
            } catch (e: ApiException) {
                throw e
            } catch (e: Exception) {
                throw ApiException("SSE 错误: ${e.message}")
            }
        }

    /** 解包 {code:0, data:...}：code==0 返回 data，否则抛异常（读 msg 字段）。 */
    fun unwrap(root: JSONObject): JSONObject {
        val code = root.optInt("code", -1)
        if (code != 0) {
            throw ApiException(root.optString("msg", root.optString("message", "API error")), code)
        }
        val data = root.opt("data")
        return when (data) {
            is JSONObject -> data
            else -> JSONObject()
        }
    }

    /** 解包数组型 data。 */
    fun unwrapArray(root: JSONObject): JSONArray {
        val code = root.optInt("code", -1)
        if (code != 0) {
            throw ApiException(root.optString("msg", "API error"), code)
        }
        return root.optJSONArray("data") ?: JSONArray()
    }
}
