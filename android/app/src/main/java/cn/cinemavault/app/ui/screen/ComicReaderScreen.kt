package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import cn.cinemavault.app.ReaderKeyBus
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.repo.ReaderRepository
import kotlinx.coroutines.launch

/** 漫画阅读器：翻页（滑动+点击三分区+音量键）、缩放、断点续读、进度保存。 */
@Composable
fun ComicReaderScreen(book: Movie, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val repo = remember { ReaderRepository() }
    val cnv = LocalContext.current
    // 系统返回键：先关阅读器，不退出 App
    BackHandler { onClose() }
    // 屏幕宽度 px，用于点击三分区判定（pointerInput 的 size 在嵌套 detector 下不可靠）
    val screenWidthPx = remember {
        cnv.resources.displayMetrics.widthPixels.toFloat()
    }

    var total by remember { mutableIntStateOf(0) }
    var page by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var showToolbar by remember { mutableStateOf(true) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }
    var error by remember { mutableStateOf<String?>(null) }

    // 翻页函数
    val turn: (Int) -> Unit = { delta ->
        val next = (page + delta).coerceIn(0, (total - 1).coerceAtLeast(0))
        if (next != page) {
            page = next
            scale = 1f; offsetX = 0f; offsetY = 0f
            scope.launch { repo.saveComicProgress(book.id, page, total) }
        }
    }
    // 关键：音量键总线只注册一次，必须读到最新重组捕获的 turn（否则 total=0 时翻页恒为 0）
    val turnState = rememberUpdatedState(turn)

    DisposableEffect(book.id) {
        ReaderKeyBus.register { dir -> turnState.value(dir); true }
        cn.cinemavault.app.FullScreenController.enter() // 沉浸：横竖屏都全屏阅读（bug4）
        scope.launch { repo.startReading(book.id, "comic") }
        onDispose {
            ReaderKeyBus.unregister()
            cn.cinemavault.app.FullScreenController.exit()
            scope.launch { repo.stopReading(book.id, "comic") }
        }
    }

    LaunchedEffect(book.id) {
        try {
            val info = repo.comicInfo(book.id)
            total = info.totalPages
            page = info.currentPage.coerceIn(0, (total - 1).coerceAtLeast(0))
            error = null
        } catch (e: Exception) {
            error = e.message ?: "加载失败"
        } finally {
            loading = false
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        when {
            loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center), color = MaterialTheme.colorScheme.primary)
            error != null -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(error!!, color = Color.White)
                TextButton(onClick = onClose) { Text("返回", color = Color.White) }
            }
            total == 0 -> Text("纯 PDF 漫画暂不支持原生渲染，请用网页版阅读",
                color = Color.White, modifier = Modifier.align(Alignment.Center))
            else -> {
                AsyncImage(
                    model = repo.pageUrl(book.id, page),
                    contentDescription = "第 ${page + 1} 页",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize()
                        .graphicsLayer {
                            scaleX = scale; scaleY = scale
                            translationX = offsetX; translationY = offsetY
                        }
                        // 点击三分区翻页 / 唤工具栏（独立 detector，优先响应）
                        .pointerInput(Unit) {
                            detectTapGestures { pos ->
                                val ratio = pos.x / screenWidthPx
                                when {
                                    ratio < 0.3f -> turn(1)     // 左 30% → 下一页
                                    ratio > 0.7f -> turn(-1)    // 右 30% → 上一页
                                    else -> showToolbar = !showToolbar
                                }
                            }
                        }
                        // 捏合缩放 / 放大后平移
                        .pointerInput(Unit) {
                            detectTransformGestures { _, pan, zoom, _ ->
                                scale = (scale * zoom).coerceIn(0.5f, 3f)
                                if (scale > 1f) { offsetX += pan.x; offsetY += pan.y }
                                else { offsetX = 0f; offsetY = 0f }
                            }
                        }
                        // 横向滑动翻页（阈值 45px，仅在未缩放时）
                        .pointerInput(Unit) {
                            var totalDrag = 0f
                            detectHorizontalDragGestures(
                                onDragStart = { totalDrag = 0f },
                                onHorizontalDrag = { _, amount -> totalDrag += amount },
                                onDragEnd = {
                                    if (scale <= 1f && kotlin.math.abs(totalDrag) > 45f) {
                                        turn(if (totalDrag < 0) 1 else -1)
                                    }
                                }
                            )
                        }
                )
            }
        }

        if (showToolbar && !loading && error == null) {
            Row(modifier = Modifier.fillMaxWidth().align(Alignment.TopStart)
                .background(Color.Black.copy(alpha = 0.75f))
                .padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = "返回", tint = Color.White)
                }
                Text("${page + 1}/$total  ·  ${book.title}", color = Color.White,
                    maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f))
                TextButton(onClick = { scale = (scale + 0.25f).coerceAtMost(3f) }) { Text("+", color = Color.White) }
                TextButton(onClick = { scale = (scale - 0.25f).coerceAtLeast(0.5f) }) { Text("−", color = Color.White) }
            }
        }
    }
}
