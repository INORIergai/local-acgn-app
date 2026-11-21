package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import coil.compose.AsyncImage
import cn.cinemavault.app.data.repo.OnlineRepository

/** 在线追番搜索页（bug2：首页本周放送点进来的在线源搜索）。 */
@Composable
fun OnlineSearchScreen(
    query: String,
    onClose: () -> Unit,
    vm: OnlineViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(query) { vm.init(query) }

    Column(modifier = Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = vm.query, onValueChange = { vm.onQuery(it) },
            placeholder = { Text("搜索番剧名…") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(16.dp, 12.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { vm.search() })
        )
        // 站点筛选
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(vm.sites) { s ->
                FilterChip(selected = vm.site == s.key, onClick = { vm.onSite(s.key) },
                    label = { Text(s.name) })
            }
        }
        Spacer(Modifier.height(8.dp))
        when {
            vm.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            vm.results.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("未找到在线源，试试其它站点", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(vm.results) { r ->
                    Column(modifier = Modifier.clickable {
                        scope.launch {
                            val url = vm.resolve(r.href)
                            if (url != null) {
                                VideoPlayerActivity.startDirect(context, url, r.title)
                            } else Toast.makeText(context, "在线源解析失败", Toast.LENGTH_SHORT).show()
                        }
                    }) {
                        Box(modifier = Modifier.fillMaxWidth().aspectRatio(0.72f)
                            .clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant)) {
                            if (r.cover != null) AsyncImage(model = r.cover, contentDescription = r.title,
                                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        }
                        Text(r.title, style = MaterialTheme.typography.bodySmall, maxLines = 2,
                            modifier = Modifier.padding(top = 4.dp))
                    }
                }
            }
        }
    }
}
