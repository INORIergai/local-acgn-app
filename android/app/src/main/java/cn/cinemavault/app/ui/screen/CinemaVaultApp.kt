package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LibraryBooks
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import cn.cinemavault.app.ui.scan.DeepLinkBus
import cn.cinemavault.app.ui.screen.update.UpdateSheet
import cn.cinemavault.app.ui.screen.update.UpdateViewModel

private data class Tab(val route: String, val label: String, val icon: @Composable () -> Unit)

private val tabs = listOf(
    Tab("home", "首页") { Icon(Icons.Filled.Home, contentDescription = null) },
    Tab("movies", "影剧") { Icon(Icons.Filled.Movie, contentDescription = null) },
    Tab("shelf", "书架") { Icon(Icons.Filled.LibraryBooks, contentDescription = null) },
    Tab("assistant", "AI助手") { Icon(Icons.Filled.AutoAwesome, contentDescription = null) },
    Tab("settings", "我的") { Icon(Icons.Filled.Person, contentDescription = null) }
)

/** 五个顶级频道有独立返回栈；阅读/追番等全屏任务仍由原页面处理返回。 */
@Composable
fun CinemaVaultApp() {
    val context = LocalContext.current
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val selectedRoute = backStack?.destination?.route ?: "home"
    val updateVm: UpdateViewModel = viewModel()
    val mainVm: MainViewModel = viewModel()
    LaunchedEffect(Unit) { updateVm.autoCheck() }
    LaunchedEffect(DeepLinkBus.pending) {
        val raw = DeepLinkBus.pending ?: return@LaunchedEffect
        // 扫码属于连接任务，不应把用户从正在阅读的页面强制拉回首页。
        mainVm.connectFromQr(raw)
        DeepLinkBus.consume()
    }
    LaunchedEffect(mainVm.state) {
        if (mainVm.state is cn.cinemavault.app.data.repo.AuthState.Ready) updateVm.autoCheck()
    }

    val readerBookState = remember { mutableStateOf<cn.cinemavault.app.data.model.Movie?>(null) }
    val readerBook = readerBookState.value
    var seriesOpen by rememberSaveable { mutableStateOf(false) }
    var onlineQuery by rememberSaveable { mutableStateOf<String?>(null) }
    val overlayOpen = readerBook != null || seriesOpen || onlineQuery != null

    // 覆盖层自己有 BackHandler 时优先关闭；只有根页面才走 tab 返回规则。
    BackHandler(enabled = !overlayOpen && selectedRoute != "home") {
        navController.popBackStack("home", inclusive = false)
    }

    fun selectTab(route: String) {
        if (route == selectedRoute) return
        navController.navigate(route) {
            popUpTo(navController.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    fun openBook(book: cn.cinemavault.app.data.model.Movie) {
        if (book.type == "comic" || book.type == "novel") readerBookState.value = book
        else {
            val ext = book.filePath.substringAfterLast('.', "").lowercase()
            if (ext in setOf("mp4", "mkv", "avi", "mov", "m4v", "ts", "webm"))
                VideoPlayerActivity.start(context, book.filePath, book.title)
            else Toast.makeText(context, "该内容请到书架阅读", Toast.LENGTH_SHORT).show()
        }
    }

    @Composable
    fun tabContent(modifier: Modifier) {
        NavHost(
            navController = navController,
            startDestination = "home",
            modifier = modifier
        ) {
            composable("home") {
                HomeScreen(
                    vm = mainVm,
                    onOpenSeries = { seriesOpen = true },
                    onOpenBook = ::openBook,
                    onOpenOnline = { title -> onlineQuery = title }
                )
            }
            composable("movies") { MovieScreen() }
            composable("shelf") { ShelfScreen(onOpenBook = { readerBookState.value = it }) }
            composable("assistant") { AiChatScreen() }
            composable("settings") { SettingsScreen(updateVm = updateVm) }
        }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val useRail = maxWidth >= 720.dp && !overlayOpen
        Row(modifier = Modifier.fillMaxSize()) {
            if (useRail) {
                NavigationRail {
                    tabs.forEach { tab ->
                        NavigationRailItem(
                            selected = selectedRoute == tab.route,
                            onClick = { selectTab(tab.route) },
                            icon = tab.icon,
                            label = { Text(tab.label) }
                        )
                    }
                }
                Box(modifier = Modifier.weight(1f)) { tabContent(Modifier.fillMaxSize()) }
            } else {
                Scaffold(
                    bottomBar = {
                        if (!overlayOpen) {
                            NavigationBar {
                                tabs.forEach { tab ->
                                    NavigationBarItem(
                                        selected = selectedRoute == tab.route,
                                        onClick = { selectTab(tab.route) },
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
                    }
                ) { innerPadding -> tabContent(Modifier.padding(innerPadding)) }
            }
        }

        readerBook?.let { book -> ReaderHost(book = book, onClose = { readerBookState.value = null }) }

        if (seriesOpen) {
            BackHandler { seriesOpen = false }
            Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                SeriesScreen(modifier = Modifier.fillMaxSize())
                OverlayCloseButton("关闭追番") { seriesOpen = false }
            }
        }

        onlineQuery?.let { query ->
            BackHandler { onlineQuery = null }
            Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                OnlineSearchScreen(query = query, onClose = { onlineQuery = null })
                OverlayCloseButton("关闭在线搜索") { onlineQuery = null }
            }
        }
        UpdateSheet(updateVm)
    }
}

@Composable
private fun OverlayCloseButton(description: String, onClose: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().statusBarsPadding()) {
        androidx.compose.material3.IconButton(
            onClick = onClose,
            modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)
                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.92f), CircleShape)
        ) {
            Icon(Icons.Filled.Close, contentDescription = description)
        }
    }
}
