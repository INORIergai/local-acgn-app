package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import coil.compose.AsyncImage
import cn.cinemavault.app.data.api.ServerConfig
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.model.posterUrl

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MovieScreen(modifier: Modifier = Modifier, vm: MovieViewModel = androidx.lifecycle.viewmodel.compose.viewModel()) {
    val context = LocalContext.current
    var detail by remember { mutableStateOf<Movie?>(null) }

    Column(modifier.fillMaxSize()) {
        // 搜索栏
        OutlinedTextField(
            value = vm.query, onValueChange = { vm.onQueryChange(it) },
            placeholder = { Text("搜索番号、片名、演员…") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(16.dp, 12.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { vm.search() })
        )
        // 分段控件（单手横滑切换）
        ScrollableTabRow(selectedTabIndex = vm.segment, edgePadding = 16.dp) {
            vm.segments.forEachIndexed { i, (label, _) ->
                Tab(selected = vm.segment == i, onClick = { vm.selectSegment(i) }, text = { Text(label) })
            }
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
        // 状态
        if (vm.loading || vm.searching) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else if (vm.error != null) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text(vm.error!!, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { vm.load() }) { Text("重试") }
            }
        } else if (vm.movies.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("这里还没有内容", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            // 双列大卡片海报墙（移动端拇指友好）
            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(vm.movies) { m -> PosterCard(m) { detail = m } }
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

    detail?.let { m ->
        DetailSheet(m) { dismiss ->
            if (dismiss) detail = null
            else {
                detail = null
                val ext = m.filePath.substringAfterLast('.', "").lowercase()
                val isVideo = ext in setOf("mp4", "mkv", "avi", "mov", "m4v", "ts", "webm", "flv", "wmv")
                if (isVideo) {
                    // 独立全屏 Activity：横屏自动全屏 + 隐藏底部导航（bug3）
                    VideoPlayerActivity.start(context, m.filePath, m.title)
                } else {
                    // 漫画/小说/EPUB 等非视频：引导去书架阅读（不喂给播放器，否则 3003）
                    Toast.makeText(context, "书籍类内容请到「书架」阅读", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }
}

@Composable
private fun PosterCard(m: Movie, onClick: () -> Unit) {
    Column(modifier = Modifier.clickable(onClick = onClick)) {
        Box(modifier = Modifier.fillMaxWidth().aspectRatio(0.72f).clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)) {
            val url = m.posterUrl(ServerConfig.baseUrl)
            if (url.isNotBlank()) {
                AsyncImage(model = url, contentDescription = m.title, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize())
            }
            if (m.score > 0) {
                Text("★ ${m.score}", modifier = Modifier.align(Alignment.TopEnd).padding(6.dp)
                    .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onPrimary)
            }
        }
        Text(m.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1,
            modifier = Modifier.padding(top = 4.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailSheet(m: Movie, onAction: (Boolean) -> Unit) {
    ModalBottomSheet(onDismissRequest = { onAction(true) }) {
        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Row {
                Box(modifier = Modifier.size(96.dp, 136.dp).clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)) {
                    val url = m.posterUrl(ServerConfig.baseUrl)
                    if (url.isNotBlank()) AsyncImage(model = url, contentDescription = null,
                        contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                Spacer(Modifier.width(14.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(m.title, style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(8.dp))
                    Text("类型 ${m.type.uppercase()}", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (m.score > 0) Text("评分 ★ ${m.score}", style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (m.overview.isNotBlank()) {
                Spacer(Modifier.height(14.dp))
                Text(m.overview, style = MaterialTheme.typography.bodyMedium, maxLines = 4)
            }
            Spacer(Modifier.height(20.dp))
            Button(onClick = { onAction(false) }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Text("立即播放")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
