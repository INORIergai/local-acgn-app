package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.data.repo.SeriesRepository
import kotlinx.coroutines.launch

class SeriesViewModel : ViewModel() {
    private val repo = SeriesRepository()

    // 6 态（对齐前端 series-view：全部/追番中/计划看/搁置/已完成/抛弃）
    val tabs = listOf("全部" to null, "追番中" to "watching", "计划看" to "planned",
        "搁置" to "onHold", "已完成" to "completed", "抛弃" to "dropped")
    var tab by mutableStateOf(0)
        private set

    var follows by mutableStateOf<List<SeriesRepository.Series>>(emptyList())
        private set
    var calendar by mutableStateOf<List<SeriesRepository.CalendarItem>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    var detailId by mutableStateOf<Long?>(null)
        private set
    var detail by mutableStateOf<SeriesRepository.Detail?>(null)
        private set
    var detailLoading by mutableStateOf(false)
        private set

    init { load() }

    fun selectTab(i: Int) { tab = i; load() }

    fun load() {
        viewModelScope.launch {
            loading = true; error = null
            // 两块数据独立容错：一块失败不让整个看板变错误页
            try {
                follows = repo.follows(tabs[tab].second)
            } catch (e: Exception) {
                error = "追番列表：${e.message ?: "加载失败"}"
                follows = emptyList()
            }
            try {
                calendar = repo.calendar()
            } catch (e: Exception) {
                // 新番非关键，静默降级
                calendar = emptyList()
            }
            loading = false
        }
    }

    fun openDetail(id: Long) {
        detailId = id
        detail = null
        detailLoading = true
        viewModelScope.launch {
            try { detail = repo.detail(id) }
            catch (e: Exception) { error = e.message ?: "详情加载失败" }
            finally { detailLoading = false }
        }
    }

    fun closeDetail() { detailId = null; detail = null }

    fun follow(seriesId: Long, status: String = "watching") {
        viewModelScope.launch { repo.follow(seriesId, status); closeDetail(); load() }
    }

    fun unfollow(seriesId: Long) {
        viewModelScope.launch { repo.unfollow(seriesId); closeDetail(); load() }
    }
}
