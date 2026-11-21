package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.data.repo.AiRepository
import kotlinx.coroutines.launch

class AiViewModel : ViewModel() {
    private val repo = AiRepository()

    var sessions by mutableStateOf<List<AiRepository.Session>>(emptyList())
        private set
    var currentSessionId by mutableStateOf("main")
        private set
    var messages by mutableStateOf<List<AiRepository.Message>>(emptyList())
        private set
    var input by mutableStateOf("")
        private set
    var generating by mutableStateOf(false)
        private set
    var streamingText by mutableStateOf("")
        private set
    var statusText by mutableStateOf("")
        private set
    var tools by mutableStateOf(Triple(0, 0, 0))
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var speakUrl by mutableStateOf<String?>(null)
        private set
    var personas by mutableStateOf<AiRepository.PersonaState?>(null)
        private set
    var showPersonaPicker by mutableStateOf(false)
        private set

    init { load() }

    fun load() {
        viewModelScope.launch {
            try {
                sessions = repo.sessions()
                val st = repo.status()
                statusText = st.currentModel.ifBlank { st.provider }
                tools = repo.toolsSummary()
                personas = repo.personas()
                loadHistory(currentSessionId)
            } catch (e: Exception) {
                error = e.message ?: "AI 服务不可用"
            }
        }
    }

    fun selectSession(id: String) {
        currentSessionId = id
        streamingText = ""
        viewModelScope.launch { messages = repo.history(id) }
    }

    fun newSession() {
        viewModelScope.launch {
            val s = repo.newSession()
            sessions = repo.sessions()
            if (s != null) selectSession(s.id)
        }
    }

    private suspend fun loadHistory(id: String) {
        messages = repo.history(id)
    }

    fun onInput(s: String) { input = s }

    fun send() {
        val text = input.trim()
        if (text.isBlank() || generating) return
        input = ""
        error = null
        streamingText = ""
        generating = true
        // 先追加用户气泡
        messages = messages + AiRepository.Message("user", text)
        val historySnapshot = messages.toList()
        viewModelScope.launch {
            val result = repo.chat(text, currentSessionId, historySnapshot) { token ->
                if (token.isNotEmpty()) streamingText += token
            }
            generating = false
            if (result.isSuccess) {
                val reply = result.getOrDefault("")
                // done 全文到达时用全文替换，避免流式尾迹与最终不一致
                messages = messages + AiRepository.Message("assistant", reply)
                streamingText = ""
                sessions = repo.sessions()
                // 让 AI「说话」——全 API 驱动
                speakUrl = repo.ttsSpeak(reply)
            } else {
                error = result.exceptionOrNull()?.message ?: "发送失败"
                streamingText = ""
            }
        }
    }

    fun togglePersonaPicker() { showPersonaPicker = !showPersonaPicker }

    fun switchPersona(id: String) {
        viewModelScope.launch {
            val ok = repo.switchPersona(id)
            if (ok) {
                personas = repo.personas()
                showPersonaPicker = false
                error = "人格已切换，下一条对话生效"
            } else error = "人格切换失败"
        }
    }

    fun consumeSpeak() { speakUrl = null }
    fun consumeError() { error = null }
}
