package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import cn.cinemavault.app.data.repo.SeriesRepository

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SeriesScreen(modifier: Modifier = Modifier, vm: SeriesViewModel = androidx.lifecycle.viewmodel.compose.viewModel()) {
    val context = LocalContext.current

    Column(modifier.fillMaxSize()) {
        // 6 态分段（横滑）
        ScrollableTabRow(selectedTabIndex = vm.tab, edgePadding = 16.dp) {
            vm.tabs.forEachIndexed { i, (label, _) ->
                Tab(selected = vm.tab == i, onClick = { vm.selectTab(i) }, text = { Text(label) })
            }
        }

        if (vm.loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else if (vm.error != null) {
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text(vm.error!!, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { vm.load() }) { Text("重试") }
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                // 本周新番横滑
                if (vm.calendar.isNotEmpty()) {
                    item {
                        Text("本周新番", style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.padding(16.dp, 16.dp, 16.dp, 8.dp))
                    }
                    item {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp),
                            contentPadding = PaddingValues(horizontal = 16.dp)) {
                            items(vm.calendar.take(20)) { c ->
                                CalendarCard(c) {
                                    if (c.seriesId > 0) vm.openDetail(c.seriesId)
                                    else Toast.makeText(context, "${c.title} · 尚未入库", Toast.LENGTH_SHORT).show()
                                }
                            }
                        }
                    }
                }

                // 追番看板
                item {
                    Text("我的追番", style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.padding(16.dp, 20.dp, 16.dp, 8.dp))
                }
                if (vm.follows.isEmpty()) {
                    item {
                        Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) {
                            Text("该分类还没有番剧", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } else {
                    items(vm.follows) { s -> FollowCard(s) { vm.openDetail(s.id) } }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }

    // 详情 / 分集抽屉
    vm.detailId?.let { id ->
        DetailSheet(
            detail = vm.detail,
            loading = vm.detailLoading,
            onDismiss = { vm.closeDetail() },
            onFollow = { status -> vm.follow(id, status) },
            onUnfollow = { vm.unfollow(id) },
            onEpisode = { ep ->
                Toast.makeText(context, "第 ${ep.episodeNo} 话 · 在线播放即将上线", Toast.LENGTH_SHORT).show()
            }
        )
    }
}

@Composable
private fun CalendarCard(c: SeriesRepository.CalendarItem, onClick: () -> Unit) {
    Column(modifier = Modifier.width(110.dp).clickable(onClick = onClick)) {
        Box(modifier = Modifier.size(110.dp, 150.dp).clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)) {
            if (c.cover != null) AsyncImage(model = c.cover, contentDescription = c.title,
                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            c.episode?.let {
                Text("第 $it 话", style = MaterialTheme.typography.labelMedium, color = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier.align(Alignment.BottomStart).padding(6.dp)
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.85f), RoundedCornerShape(6.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp))
            }
        }
        Text(c.title, style = MaterialTheme.typography.bodySmall, maxLines = 2,
            modifier = Modifier.padding(top = 4.dp))
        if (c.followStatus != null) {
            Text("已追", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun FollowCard(s: SeriesRepository.Series, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
        .clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface)
        .clickable(onClick = onClick).padding(8.dp)) {
        Box(modifier = Modifier.size(64.dp, 90.dp).clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)) {
            if (s.posterPath != null) AsyncImage(model = s.posterPath, contentDescription = s.title,
                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(s.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("${s.watchedCount}/${s.episodeTotal} 集 · ${s.followStatus ?: "未追"}",
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (s.nextEpisode > 0 && s.watchedCount < s.episodeTotal) {
                Text("看到第 ${s.nextEpisode} 集", style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailSheet(
    detail: SeriesRepository.Detail?,
    loading: Boolean,
    onDismiss: () -> Unit,
    onFollow: (String) -> Unit,
    onUnfollow: () -> Unit,
    onEpisode: (SeriesRepository.Episode) -> Unit
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        if (loading || detail == null) {
            Box(Modifier.fillMaxWidth().height(200.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else {
            val s = detail.series
            LazyColumn(contentPadding = PaddingValues(16.dp)) {
                item {
                    Row {
                        if (s.posterPath != null) {
                            Box(modifier = Modifier.size(96.dp, 136.dp).clip(RoundedCornerShape(10.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)) {
                                AsyncImage(model = s.posterPath, contentDescription = null,
                                    contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                            }
                        }
                        Spacer(Modifier.width(14.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(s.title, style = MaterialTheme.typography.titleLarge, maxLines = 3)
                            Spacer(Modifier.height(8.dp))
                            Text("${s.episodeTotal} 集 · ${s.status}", style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("已看 ${s.watchedCount} 集", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                item {
                    Row(modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (s.followStatus == null) {
                            Button(onClick = { onFollow("watching") }, modifier = Modifier.weight(1f)) { Text("追番") }
                            OutlinedButton(onClick = { onFollow("planned") }, modifier = Modifier.weight(1f)) { Text("计划看") }
                        } else {
                            OutlinedButton(onClick = onUnfollow, modifier = Modifier.fillMaxWidth()) { Text("取消追番") }
                        }
                    }
                }
                item {
                    Text("分集", style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(top = 20.dp, bottom = 8.dp))
                }
                items(detail.episodes) { ep ->
                    ListItem(
                        headlineContent = { Text("第 ${ep.episodeNo} 话 ${ep.title}") },
                        supportingContent = {
                            if (ep.watched) Text("已看") else if (ep.position > 0) Text("看到 ${ep.position.toInt()}s") else null
                        },
                        modifier = Modifier.clickable { onEpisode(ep) }
                    )
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}
