package cn.cinemavault.app.ui.screen.update

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.BuildConfig
import cn.cinemavault.app.data.prefs.UpdatePrefs
import cn.cinemavault.app.data.repo.AppUpdateInfo
import cn.cinemavault.app.data.repo.AppUpdateRepository
import cn.cinemavault.app.data.repo.UpdateCheck
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

sealed interface UpdateUiState {
    data object Idle : UpdateUiState
    data class Checking(val manual: Boolean) : UpdateUiState
    data class Available(val info: AppUpdateInfo) : UpdateUiState
    data class Downloading(val info: AppUpdateInfo, val downloaded: Long, val total: Long) : UpdateUiState
    data class Verifying(val info: AppUpdateInfo) : UpdateUiState
    data class Ready(val info: AppUpdateInfo, val file: File) : UpdateUiState
    data class NeedsPermission(val info: AppUpdateInfo, val file: File) : UpdateUiState
    data class Message(val title: String, val text: String) : UpdateUiState
}

/** 应用更新状态机：静默检查 / 手动检查 / 下载 / 校验 / 安装。 */
class UpdateViewModel(app: Application) : AndroidViewModel(app) {

    private val repo = AppUpdateRepository(app)
    private val _state = MutableStateFlow<UpdateUiState>(UpdateUiState.Idle)
    val state: StateFlow<UpdateUiState> = _state.asStateFlow()

    private var job: Job? = null

    val currentVersion: String get() = BuildConfig.VERSION_NAME
    var autoCheckEnabled: Boolean
        get() = UpdatePrefs.autoCheck
        set(value) { UpdatePrefs.autoCheck = value }

    fun autoCheck() {
        if (!UpdatePrefs.autoCheck) return
        val now = System.currentTimeMillis()
        if (now - UpdatePrefs.lastCheckAt < 24L * 60 * 60 * 1000) return
        // 不在这里写 lastCheckAt：首装时服务器还没配好，check 会失败；
        // 失败不该白耗 24h 窗口，等连接 Ready 后会再次触发。
        check(manual = false)
    }

    fun check(manual: Boolean = true) {
        if (job?.isActive == true) return
        job = viewModelScope.launch {
            _state.value = UpdateUiState.Checking(manual)
            when (val r = repo.check()) {
                is UpdateCheck.Available -> {
                    UpdatePrefs.lastCheckAt = System.currentTimeMillis()
                    if (!manual && r.info.versionCode == UpdatePrefs.ignoredVersionCode) {
                        _state.value = UpdateUiState.Idle
                    } else {
                        _state.value = UpdateUiState.Available(r.info)
                    }
                }
                UpdateCheck.UpToDate -> {
                    UpdatePrefs.lastCheckAt = System.currentTimeMillis()
                    _state.value = if (manual) {
                        UpdateUiState.Message("已是最新版本", "当前 v${BuildConfig.VERSION_NAME}")
                    } else UpdateUiState.Idle
                }
                is UpdateCheck.Unavailable -> {
                    // 服务器可达，只是暂时没有包；记一次，避免每次启动都提示
                    UpdatePrefs.lastCheckAt = System.currentTimeMillis()
                    _state.value = if (manual) {
                        UpdateUiState.Message("暂无可用更新", r.reason)
                    } else UpdateUiState.Idle
                }
                is UpdateCheck.Failed -> {
                    // 网络/未配置：不记时间，下次启动或连接就绪后重试
                    _state.value = if (manual) {
                        UpdateUiState.Message("检查失败", r.message)
                    } else UpdateUiState.Idle
                }
            }
        }
    }

    fun download() {
        val info = when (val s = _state.value) {
            is UpdateUiState.Available -> s.info
            is UpdateUiState.Ready -> s.info
            is UpdateUiState.NeedsPermission -> s.info
            else -> return
        }
        if (job?.isActive == true) return
        job = viewModelScope.launch {
            _state.value = UpdateUiState.Downloading(info, 0L, info.apkSize)
            try {
                val file = repo.download(info) { done, total ->
                    _state.value = UpdateUiState.Downloading(info, done, total)
                }
                _state.value = UpdateUiState.Verifying(info)
                val err = repo.verifyDownloadedApk(file, info)
                if (err != null) {
                    _state.value = UpdateUiState.Message("安装包校验失败", err)
                    return@launch
                }
                _state.value = if (repo.canInstall()) {
                    UpdateUiState.Ready(info, file)
                } else {
                    UpdateUiState.NeedsPermission(info, file)
                }
            } catch (e: Exception) {
                _state.value = UpdateUiState.Message("更新失败", e.message ?: "下载失败")
            }
        }
    }

    fun install() {
        val pair = when (val s = _state.value) {
            is UpdateUiState.Ready -> s.info to s.file
            is UpdateUiState.NeedsPermission -> s.info to s.file
            else -> return
        }
        val (info, file) = pair
        if (!repo.canInstall()) {
            repo.openInstallPermissionSettings()
            _state.value = UpdateUiState.NeedsPermission(info, file)
            return
        }
        val err = repo.verifyDownloadedApk(file, info)
        if (err != null) {
            _state.value = UpdateUiState.Message("安装包校验失败", err)
            return
        }
        if (repo.install(file)) {
            _state.value = UpdateUiState.Message(
                "已拉起系统安装器",
                "按系统提示完成安装。华为设备可能弹出统一认证，需人工确认。"
            )
        } else {
            _state.value = UpdateUiState.NeedsPermission(info, file)
        }
    }

    fun openInstallPermissionSettings() {
        repo.openInstallPermissionSettings()
    }

    fun ignoreThisVersion() {
        val code = when (val s = _state.value) {
            is UpdateUiState.Available -> s.info.versionCode
            is UpdateUiState.Downloading -> s.info.versionCode
            is UpdateUiState.Ready -> s.info.versionCode
            is UpdateUiState.NeedsPermission -> s.info.versionCode
            else -> 0
        }
        if (code > 0) UpdatePrefs.ignoredVersionCode = code
        dismiss()
    }

    fun dismiss() {
        job?.cancel()
        job = null
        _state.value = UpdateUiState.Idle
    }
}
