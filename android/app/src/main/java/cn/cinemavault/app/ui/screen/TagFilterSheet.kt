package cn.cinemavault.app.ui.screen

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.cinemavault.app.data.repo.TagRepository

/** 影剧/书架共用标签筛选抽屉：搜索标签、多选、且/或组合。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TagFilterSheet(
    tags: List<TagRepository.Tag>,
    selected: Set<Int>,
    query: String,
    mode: String,
    loading: Boolean,
    onQuery: (String) -> Unit,
    onMode: (String) -> Unit,
    onToggle: (Int) -> Unit,
    onClear: () -> Unit,
    onApply: () -> Unit,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.fillMaxWidth().fillMaxHeight(0.82f).padding(horizontal = 16.dp)) {
            Text("按标签归类", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = query, onValueChange = onQuery,
                placeholder = { Text("搜索标签或别名，支持繁简") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                singleLine = true, modifier = Modifier.fillMaxWidth()
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = mode == "and", onClick = { onMode("and") },
                    label = { Text("同时满足") })
                Spacer(Modifier.width(8.dp))
                FilterChip(selected = mode == "or", onClick = { onMode("or") },
                    label = { Text("任一满足") })
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onClear, enabled = selected.isNotEmpty()) { Text("清空") }
            }
            Spacer(Modifier.height(8.dp))
            when {
                loading -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                tags.isEmpty() -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text("这个库里还没有可用标签", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> LazyColumn(modifier = Modifier.weight(1f)) {
                    items(tags, key = { it.id }) { tag ->
                        ListItem(
                            headlineContent = { Text(tag.name) },
                            supportingContent = { Text("${tag.movieCount} 部") },
                            leadingContent = {
                                Checkbox(checked = selected.contains(tag.id), onCheckedChange = { onToggle(tag.id) })
                            },
                            modifier = Modifier.clickable { onToggle(tag.id) }
                        )
                    }
                }
            }
            Button(onClick = onApply, enabled = selected.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                Text("查看 ${selected.size} 个标签的结果")
            }
        }
    }
}