package cn.cinemavault.app.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import cn.cinemavault.app.data.api.ServerConfig
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.model.posterUrl

@Composable
fun ShelfScreen(
    modifier: Modifier = Modifier,
    vm: ShelfViewModel = androidx.lifecycle.viewmodel.compose.viewModel(),
    onOpenBook: (Movie) -> Unit
) {
    Column(modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = if (vm.kind == "comic") 0 else 1) {
            Tab(selected = vm.kind == "comic", onClick = { vm.select("comic") }, text = { Text("漫画") })
            Tab(selected = vm.kind == "novel", onClick = { vm.select("novel") }, text = { Text("小说") })
        }
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { vm.openTags() }) {
                Text(if (vm.selectedTags.isEmpty()) "标签归类" else "标签归类 · ${vm.selectedTags.size}")
            }
            if (vm.tagFilterActive) {
                TextButton(onClick = { vm.clearTagFilter() }) { Text("清除标签筛选") }
            }
        }
        if (vm.loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else if (vm.error != null) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text(vm.error!!, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { vm.load() }) { Text("重试") }
            }
        } else if (vm.books.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("书架空空如也", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(vm.books) { book ->
                    BookCard(book, vm.progress[book.id] ?: 0) { onOpenBook(book) }
                }
            }
        }
    }

    if (vm.tagsOpen) {
        TagFilterSheet(
            tags = vm.tags, selected = vm.selectedTags, query = vm.tagQuery,
            mode = vm.tagMode, loading = vm.tagsLoading,
            onQuery = { vm.onTagQuery(it) }, onMode = { vm.onTagMode(it) },
            onToggle = { vm.toggleTag(it) }, onClear = { vm.clearSelectedTags() },
            onApply = { vm.applyTags() }, onDismiss = { vm.closeTags() }
        )
    }
}

@Composable
private fun BookCard(book: Movie, percent: Int, onClick: () -> Unit) {
    Column(modifier = Modifier.clickable(onClick = onClick)) {
        Box(modifier = Modifier.fillMaxWidth().aspectRatio(0.72f).clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)) {
            val url = book.posterUrl(ServerConfig.baseUrl)
            if (url.isNotBlank()) {
                AsyncImage(model = url, contentDescription = book.title, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize())
            }
            if (percent > 0) {
                // 底部进度条
                Box(modifier = Modifier.fillMaxWidth().height(4.dp).align(Alignment.BottomStart)
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.25f))) {
                    Box(modifier = Modifier.fillMaxWidth(percent / 100f).fillMaxHeight()
                        .background(MaterialTheme.colorScheme.primary))
                }
            }
        }
        Text(book.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1,
            modifier = Modifier.padding(top = 4.dp))
        if (percent > 0) {
            Text("$percent%", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary)
        }
    }
}
