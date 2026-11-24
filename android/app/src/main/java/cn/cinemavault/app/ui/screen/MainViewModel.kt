package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.QrPayload
import cn.cinemavault.app.data.api.ServerConfig
import cn.cinemavault.app.data.model.CalendarItem
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.model.Stats
import cn.cinemavault.app.data.repo.AuthRepository
import cn.cinemavault.app.data.repo.AuthState
import cn.cinemavault.app.data.repo.HomeRepository
import kotlinx.coroutines.launch

class MainViewModel : ViewModel() {
    private val authRepo = AuthRepository()
    private val homeRepo = HomeRepository()

    var state by mutableStateOf<AuthState>(AuthState.NeedServer)
        private set
    var loading by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set

    var calendar by mutableStateOf<List<CalendarItem>>(emptyList())
        private set
    var hotMovies by mutableStateOf<List<Movie>>(emptyList())
        private set
    var stats by mutableStateOf<Stats?>(null)
        private set
    var homeLoading by mutableStateOf(true)
        private set
    var homeError by mutableStateOf<String?>(null)
        private set

    init { check() }

    fun check() {
        viewModelScope.launch {
            loading = true
            state = authRepo.check()
            if (state is AuthState.Ready) loadHome()
            loading = false
        }
    }

    fun connect(server: String) {
        viewModelScope.launch {
            authRepo.connect(server)
            check()
        }
    }

    /**
     * 扫码连接：
     *  - 纯地址二维码 → 设置地址后走原流程（需要密码就显示登录页）；
     *  - 带配对码深链 → 先换 lml_session，再检测状态，直接进首页。
     * 配对码过期/被用过时保留地址并回退到登录页，不让用户重扫。
     */
    fun connectFromQr(raw: String, onResult: (String?) -> Unit = {}) {
        viewModelScope.launch {
            loading = true
            val payload = QrPayload.parse(raw)
            if (payload == null) {
                message = "无法识别的二维码，请扫描电脑连接页上的码"
                loading = false
                onResult(message)
                return@launch
            }
            authRepo.connect(payload.baseUrl)
            if (payload.pairCode != null) {
                try {
                    val root = ApiClient.post(
                        "/api/app/pair",
                        org.json.JSONObject().put("pairCode", payload.pairCode)
                    )
                    if (root.optInt("code", -1) != 0) {
                        message = root.optString("msg", "配对码已失效，已切换为密码登录")
                    }
                } catch (e: Exception) {
                    // 网络/服务器异常不阻断连接：地址已保存，登录页仍可用
                    message = "配对失败：${e.message}"
                }
            }
            state = authRepo.check()
            if (state is AuthState.Ready) {
                message = null
                loadHome()
            }
            loading = false
            onResult(message)
        }
    }

    fun login(password: String, onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            loading = true
            val r = authRepo.login(password)
            loading = false
            if (r.isSuccess) {
                state = AuthState.Ready
                loadHome()
                onResult(true)
            } else {
                message = r.exceptionOrNull()?.message ?: "登录失败"
                onResult(false)
            }
        }
    }

    private suspend fun loadHome() {
        homeLoading = true
        homeError = null
        try {
            // 三块数据独立加载：一块失败不至于全空
            calendar = try { homeRepo.calendar() } catch (e: Exception) { emptyList() }
            hotMovies = try { homeRepo.hot() } catch (e: Exception) {
                homeError = "热度榜加载失败：${e.message}"; emptyList()
            }
            stats = try { homeRepo.stats() } catch (e: Exception) { null }
        } finally {
            homeLoading = false
        }
    }

    fun refreshHome() {
        viewModelScope.launch { loadHome() }
    }

    fun consumeMessage() { message = null }

    val baseUrl: String get() = ServerConfig.baseUrl
}
