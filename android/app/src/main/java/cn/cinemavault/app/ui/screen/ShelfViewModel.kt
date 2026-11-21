package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.repo.ShelfRepository
import cn.cinemavault.app.data.repo.TagRepository
import kotlinx.coroutines.launch

class ShelfViewModel : ViewModel() {
    private val repo = ShelfRepository()
    private val tagRepo = TagRepository()

    var kind by mutableStateOf("comic") // comic / novel
        private set
    var books by mutableStateOf<List<Movie>>(emptyList())
        private set
    var progress by mutableStateOf<Map<Long, Int>>(emptyMap())
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

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

    fun openTags() { tagsOpen = true; loadTags() }
    fun closeTags() { tagsOpen = false }
    fun onTagMode(m: String) { tagMode = m }
    fun onTagQuery(q: String) { tagQuery = q; loadTags() }

    private fun loadTags() {
        viewModelScope.launch {
            tagsLoading = true
            try { tags = tagRepo.list(kind, tagQuery) }
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
            loading = true; error = null
            try {
                books = tagRepo.filter(selectedTags.toList(), kind, tagMode)
                progress = repo.progressMap()
                tagFilterActive = true
                tagsOpen = false
            } catch (e: Exception) {
                error = e.message ?: "标签筛选失败"
            } finally { loading = false }
        }
    }

    fun clearTagFilter() {
        selectedTags = emptySet()
        tagFilterActive = false
        load()
    }

    fun select(k: String) {
        kind = k
        selectedTags = emptySet()
        tagFilterActive = false
        load()
    }

    fun load() {
        viewModelScope.launch {
            loading = true; error = null
            try {
                books = repo.books(kind)
                progress = repo.progressMap()
            } catch (e: Exception) {
                error = e.message ?: "加载失败"
            } finally {
                loading = false
            }
        }
    }
}
