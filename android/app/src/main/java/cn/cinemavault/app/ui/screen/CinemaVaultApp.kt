package cn.cinemavault.app.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import android.widget.Toast
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LibraryBooks
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

/** 底部导航 5 大频道（对齐前端 mobile-nav 的 home/movie/library/ai/mine）。 */
private data class Tab(val label: String, val icon: @Composable () -> Unit)

private val tabs = listOf(
    Tab("首页") { Icon(Icons.Filled.Home, contentDescription = null) },
    Tab("影剧") { Icon(Icons.Filled.Movie, contentDescription = null) },
    Tab("书架") { Icon(Icons.Filled.LibraryBooks, contentDescription = null) },
    Tab("AI助手") { Icon(Icons.Filled.AutoAwesome, contentDescription = null) },
    Tab("我的") { Icon(Icons.Filled.Person, contentDescription = null) }
)

@Composable
fun CinemaVaultApp() {
    var selected by rememberSaveable { mutableIntStateOf(0) }
    val context = LocalContext.current
    // 全屏阅读器覆盖层（漫画/小说），打开时隐藏底部导航与系统栏
    val readerBookState = remember { mutableStateOf<cn.cinemavault.app.data.model.Movie?>(null) }
    val readerBook = readerBookState.value
    // 追番全屏覆盖层（从首页入口进入）
    val seriesOpen = remember { mutableStateOf(false) }
    // 在线追番搜索覆盖层（首页本周放送点进来）
    val onlineQuery = remember { mutableStateOf<String?>(null) }

    Box(modifier = Modifier.fillMaxSize()) {
        Scaffold(
            bottomBar = {
                NavigationBar {
                    tabs.forEachIndexed { index, tab ->
                        NavigationBarItem(
                            selected = selected == index,
                            onClick = { selected = index },
                            icon = tab.icon,
                            label = { Text(tab.label) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                                selectedTextColor = MaterialTheme.colorScheme.primary,
                                indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                                unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        )
                    }
                }
            }
        ) { innerPadding ->
            when (selected) {
                0 -> HomeScreen(
                    Modifier.padding(innerPadding),
                    onOpenSeries = { seriesOpen.value = true },
                    onOpenBook = { book ->
                        if (book.type == "comic" || book.type == "novel") readerBookState.value = book
                        else {
                            val ext = book.filePath.substringAfterLast('.', "").lowercase()
                            if (ext in setOf("mp4", "mkv", "avi", "mov", "m4v", "ts", "webm"))
                                VideoPlayerActivity.start(context, book.filePath, book.title)
                            else Toast.makeText(context, "该内容请到书架阅读", Toast.LENGTH_SHORT).show()
                        }
                    },
                    onOpenOnline = { title -> onlineQuery.value = title }
                )
                1 -> MovieScreen(Modifier.padding(innerPadding))
                2 -> ShelfScreen(Modifier.padding(innerPadding)) { book ->
                    readerBookState.value = book
                }
                3 -> AiChatScreen(Modifier.padding(innerPadding))
                4 -> SettingsScreen(Modifier.padding(innerPadding))
            }
        }

        // 全屏阅读器覆盖层
        readerBook?.let { book ->
            ReaderHost(book = book, onClose = { readerBookState.value = null })
        }

        // 追番全屏覆盖层
        if (seriesOpen.value) {
            androidx.activity.compose.BackHandler { seriesOpen.value = false }
            Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                SeriesScreen(modifier = Modifier.fillMaxSize())
                // 顶部关闭按钮
                androidx.compose.material3.IconButton(
                    onClick = { seriesOpen.value = false },
                    modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.8f), CircleShape)
                ) {
                    Icon(Icons.Filled.Close, contentDescription = "关闭追番")
                }
            }
        }

        // 在线追番搜索覆盖层（首页本周放送点进来）
        onlineQuery.value?.let { q ->
            androidx.activity.compose.BackHandler { onlineQuery.value = null }
            Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                OnlineSearchScreen(query = q, onClose = { onlineQuery.value = null })
                androidx.compose.material3.IconButton(
                    onClick = { onlineQuery.value = null },
                    modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.8f), CircleShape)
                ) {
                    Icon(Icons.Filled.Close, contentDescription = "关闭在线搜索")
                }
            }
        }
    }
}
