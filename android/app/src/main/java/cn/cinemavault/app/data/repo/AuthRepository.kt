package cn.cinemavault.app.data.repo

import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig
import org.json.JSONObject

/** 连接与鉴权状态。 */
sealed interface AuthState {
    data object NeedServer : AuthState
    data object NeedLogin : AuthState
    data object Ready : AuthState
    data class Error(val message: String) : AuthState
}

class AuthRepository {
    suspend fun check(): AuthState {
        if (!ServerConfig.isConfigured) return AuthState.NeedServer
        return try {
            val root = ApiClient.get("/api/auth/status")
            val data = ApiClient.unwrap(root)
            val authEnabled = data.optBoolean("authEnabled", false)
            val loggedIn = data.optBoolean("loggedIn", false)
            if (authEnabled && !loggedIn) AuthState.NeedLogin else AuthState.Ready
        } catch (e: Exception) {
            // 连不上主机：仍需配置或主机离线，交给 UI 显示重试
            AuthState.Error(e.message ?: "连接失败")
        }
    }

    suspend fun login(password: String): Result<Unit> = try {
        val root = ApiClient.post("/api/auth/login", JSONObject().put("password", password))
        // code=0 即成功（未启用密码时也返回 0）
        if (root.optInt("code", -1) == 0) Result.success(Unit)
        else Result.failure(Exception(root.optString("msg", "登录失败")))
    } catch (e: Exception) {
        Result.failure(e)
    }

    fun connect(server: String) {
        ServerConfig.baseUrl = server
    }
}
