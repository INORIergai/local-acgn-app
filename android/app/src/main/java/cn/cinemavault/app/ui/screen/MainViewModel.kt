package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
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
