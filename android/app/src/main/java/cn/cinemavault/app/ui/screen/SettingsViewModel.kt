package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig
import cn.cinemavault.app.data.prefs.ThemeStore
import cn.cinemavault.app.data.repo.AiRepository
import cn.cinemavault.app.data.repo.TtsRepository
import kotlinx.coroutines.launch

class SettingsViewModel : ViewModel() {
    private val ttsRepo = TtsRepository()
    private val aiRepo = AiRepository()

    var serverUrl by mutableStateOf(ServerConfig.baseUrl)
        private set
    var serverDraft by mutableStateOf(ServerConfig.baseUrl)
    var hostInfo by mutableStateOf("未连接")
        private set
    var ttsStatus by mutableStateOf("检测中…")
        private set
    var aiModel by mutableStateOf("")
        private set
    var testing by mutableStateOf(false)
        private set
    var toast by mutableStateOf<String?>(null)
        private set

    // 主题：0=跟随系统 1=暗金 2=纸书（真实生效 + 持久化到 ThemeStore）
    var themeMode by mutableStateOf(ThemeStore.mode)
        private set

    // 音色：fishaudio 的 reference_id 列表
    var voices by mutableStateOf<List<TtsRepository.Voice>>(emptyList())
        private set
    var currentVoiceId by mutableStateOf("")
        private set
    var currentVoiceName by mutableStateOf("未获取")
        private set
    var voiceBusy by mutableStateOf(false)
        private set

    init { refresh() }

    private fun loadVoices() {
        viewModelScope.launch {
            try {
                val (cur, list) = ttsRepo.fishVoices()
                currentVoiceId = cur
                voices = list
                currentVoiceName = list.firstOrNull { it.id == cur }?.name
                    ?: list.firstOrNull()?.name ?: "未选择"
            } catch (_: Exception) { /* 引擎没起来就留空，不拖垮整个设置页 */ }
        }
    }

    fun selectVoice(v: TtsRepository.Voice) {
        if (voiceBusy) return
        voiceBusy = true
        viewModelScope.launch {
            try {
                ttsRepo.selectFishVoice(v.id, v.name)
                currentVoiceId = v.id
                currentVoiceName = v.name
                toast = "音色已切换：${v.name}"
            } catch (e: Exception) {
                toast = "音色切换失败：${e.message?.take(40)}"
            } finally { voiceBusy = false }
        }
    }

    fun onServerDraft(s: String) { serverDraft = s }

    fun refresh() {
        viewModelScope.launch {
            serverUrl = ServerConfig.baseUrl
            serverDraft = ServerConfig.baseUrl
            hostInfo = try {
                val d = ApiClient.unwrap(ApiClient.get("/api/health/env"))
                "v${d.optString("appVersion")} · ${d.optJSONObject("counts")?.optInt("movies") ?: 0} 部影片"
            } catch (e: Exception) { "连接失败：${e.message?.take(40)}" }
            ttsStatus = ttsRepo.status()
            aiModel = try { aiRepo.status().currentModel } catch (e: Exception) { "" }
        }
        loadVoices()
    }

    fun saveServer() {
        viewModelScope.launch {
            ServerConfig.baseUrl = serverDraft
            serverUrl = ServerConfig.baseUrl
            refresh()
            toast = "服务器地址已保存"
        }
    }

    fun setTheme(mode: Int) {
        // 写入 ThemeStore：全局状态一变，CinemaVaultTheme 立刻重组换皮，无需重启
        ThemeStore.set(mode)
        themeMode = ThemeStore.mode
        toast = "主题已切换"
    }

    fun consumeToast() { toast = null }
}
