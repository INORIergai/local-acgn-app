package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.cinemavault.app.data.repo.OnlineRepository
import kotlinx.coroutines.launch

class OnlineViewModel : ViewModel() {
    private val repo = OnlineRepository()

    var query by mutableStateOf("")
        private set
    var sites by mutableStateOf<List<OnlineRepository.Site>>(emptyList())
        private set
    var site by mutableStateOf("cycanime")
        private set
    var results by mutableStateOf<List<OnlineRepository.Result>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set

    fun init(q: String) {
        query = q
        viewModelScope.launch {
            sites = repo.sites()
            if (sites.isNotEmpty() && sites.none { it.key == site }) site = sites[0].key
            search()
        }
    }

    fun onQuery(s: String) { query = s }
    fun onSite(s: String) { site = s; search() }

    fun search() {
        if (query.isBlank()) return
        viewModelScope.launch {
            loading = true
            results = repo.search(site, query)
            loading = false
        }
    }

    suspend fun resolve(url: String) = repo.resolve(url)
}
