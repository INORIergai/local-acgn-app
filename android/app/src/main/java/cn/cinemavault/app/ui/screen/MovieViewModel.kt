package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.repo.MovieRepository
import cn.cinemavault.app.data.repo.TagRepository
import kotlinx.coroutines.launch

class MovieViewModel : ViewModel() {
    private val repo = MovieRepository()
    private val tagRepo = TagRepository()

    // 分段：只保留视频类（comic/novel 归书架阅读器，不在影剧页否则会误把漫画当视频播放→3003）
    val segments = listOf("推荐" to "all", "影片" to "adult", "动漫" to "anime")
    var segment by mutableStateOf(0)
        private set

    var movies by mutableStateOf<List<Movie>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var query by mutableStateOf("")
        private set
    var searching by mutableStateOf(false)
        private set

    // 标签筛选状态
    var tags by mutableStateOf<List<TagRepository.Tag>>(emptyList())
        private set
    var tagsOpen by mutableStateOf(false)
    var tagQuery by mutableStateOf("")
    var selectedTags by mutableStateOf<Set<Int>>(emptySet())
        private set
    var tagMode by mutableStateOf("and")
    var tagsLoading by mutableStateOf(false)
        private set
    var tagFilterActive by mutableStateOf(false)
        private set

    init { load() }

    private fun tagLib(): String = when (segment) {
        1 -> "jav"
        2 -> "anime"
        else -> ""
    }

    fun openTags() { tagsOpen = true; loadTags() }
    fun closeTags() { tagsOpen = false }
    fun onTagMode(m: String) { tagMode = m }
    fun onTagQuery(q: String) { tagQuery = q; loadTags() }

    private fun loadTags() {
        viewModelScope.launch {
            tagsLoading = true
            try { tags = tagRepo.list(tagLib(), tagQuery) }
            catch (_: Exception) { tags = emptyList() }
            finally { tagsLoading = false }
        }
    }

    fun toggleTag(id: Int) {
        selectedTags = if (selectedTags.contains(id)) selectedTags - id else selectedTags + id
    }

    fun clearSelectedTags() { selectedTags = emptySet() }

    fun applyTags() {
        if (selectedTags.isEmpty()) return
        viewModelScope.launch {
            searching = true; error = null
            try {
                movies = tagRepo.filter(selectedTags.toList(), tagLib(), tagMode)
                tagFilterActive = true
                query = ""
                tagsOpen = false
            } catch (e: Exception) {
                error = e.message ?: "标签筛选失败"
            } finally { searching = false }
        }
    }

    fun clearTagFilter() {
        selectedTags = emptySet()
        tagFilterActive = false
        load()
    }

    fun selectSegment(i: Int) {
        segment = i
        query = ""
        selectedTags = emptySet()
        tagFilterActive = false
        load()
    }

    fun load() {
        viewModelScope.launch {
            loading = true; error = null
            try {
                movies = repo.list(segments[segment].second, 1).movies
            } catch (e: Exception) {
                error = e.message ?: "加载失败"; movies = emptyList()
            } finally {
                loading = false
            }
        }
    }

    fun onQueryChange(q: String) { query = q }

    fun search() {
        if (query.isBlank()) { load(); return }
        viewModelScope.launch {
            searching = true; error = null
            try {
                movies = repo.search(query, if (segment == 0) "all" else segments[segment].second)
            } catch (e: Exception) {
                error = e.message ?: "搜索失败"
            } finally {
                searching = false
            }
        }
    }
}
