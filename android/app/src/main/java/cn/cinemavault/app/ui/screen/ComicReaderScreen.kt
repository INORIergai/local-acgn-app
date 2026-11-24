package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.compose.LocalImageLoader
import coil.request.ImageRequest
import cn.cinemavault.app.ReaderKeyBus
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.repo.ReaderRepository
import cn.cinemavault.app.reading.ComicFit
import cn.cinemavault.app.reading.ComicLayout
import cn.cinemavault.app.reading.ComicSettings
import cn.cinemavault.app.reading.ComicSettingsSheet
import cn.cinemavault.app.reading.ReaderSettingsStore
import cn.cinemavault.app.reading.TurnStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.min

/**
 * 漫画阅读器（v5.1）：
 *  - 单页/双页 HorizontalPager，左右预取 ±2 页；
 *  - 长条连续模式（LazyColumn），适合 webtoon；
 *  - 日漫右翻（RTL）交换左右页序与点击方向；
 *  - 缩放 >1 时暂停翻页、拖拽平移；双击 1x/2x；
 *  - 点击三分区：LTR 右侧下一页、左侧上一页；RTL 反转。
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ComicReaderScreen(book: Movie, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val repo = remember { ReaderRepository() }
    var settings by remember { mutableStateOf(ReaderSettingsStore.loadComic(ctx)) }

    var total by remember { mutableIntStateOf(0) }
    var page by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var showToolbar by remember { mutableStateOf(true) }
    var showSettings by remember { mutableStateOf(false) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }
    // 首次/切换版式时先把 Pager 定位到保存页，再允许 page 被 Pager 回写
    var restored by remember { mutableStateOf(false) }

    val step = if (settings.layout == ComicLayout.DUAL) 2 else 1
    val slots = if (settings.layout == ComicLayout.DUAL) (total + 1) / 2 else total
    val bg = if (settings.night) Color.Black else Color(settings.background)

    val pagerState = rememberPagerState(pageCount = { slots.coerceAtLeast(1) })
    val listState = rememberLazyListState()
    val imageLoader = LocalImageLoader.current

    // 音量键处理要用最新 settings/slots（registered lambda 只注册一次，不能捕获旧闭包）
    val keyHandler: (Int) -> Boolean = { dir ->
        if (settings.continuous) {
            scope.launch {
                listState.animateScrollBy(if (dir > 0) 1000f else -1000f)
            }
        } else {
            scope.launch {
                val target = pagerState.currentPage + dir
                if (target in 0 until slots) {
                    if (settings.turnStyle == TurnStyle.NONE) pagerState.scrollToPage(target)
                    else pagerState.animateScrollToPage(target)
                }
            }
        }
        true
    }
    val keyHandlerState = rememberUpdatedState(keyHandler)

    BackHandler { onClose() }

    LaunchedEffect(book.id) {
        try {
            val info = repo.comicInfo(book.id)
            total = info.totalPages
            page = info.currentPage.coerceIn(0, (info.totalPages - 1).coerceAtLeast(0))
            error = null
        } catch (e: Exception) {
            error = e.message ?: "加载失败"
        } finally {
            loading = false
        }
    }

    DisposableEffect(book.id) {
        cn.cinemavault.app.FullScreenController.enter()
        ReaderKeyBus.register { dir -> keyHandlerState.value(dir) }
        scope.launch { repo.startReading(book.id, "comic") }
        onDispose {
            ReaderKeyBus.unregister()
            cn.cinemavault.app.FullScreenController.exit()
            scope.launch { repo.stopReading(book.id, "comic") }
        }
    }

    // 首次载入 / 切换单双页 / 切换长条：定位到当前页
    LaunchedEffect(total, settings.layout, settings.continuous) {
        if (total <= 0) return@LaunchedEffect
        restored = false
        scale = 1f; offsetX = 0f; offsetY = 0f
        if (settings.continuous) {
            listState.scrollToItem(page.coerceIn(0, total - 1))
        } else {
            val slot = (page / step).coerceIn(0, (slots - 1).coerceAtLeast(0))
            if (pagerState.currentPage != slot) pagerState.scrollToPage(slot)
        }
        restored = true
    }

    // 翻页进度 + 缩放复位（350ms 去抖）
    LaunchedEffect(pagerState.currentPage, total, settings.layout, settings.continuous, restored) {
        if (total <= 0 || !restored) return@LaunchedEffect
        if (!settings.continuous) {
            page = (pagerState.currentPage * step).coerceIn(0, total - 1)
            scale = 1f; offsetX = 0f; offsetY = 0f
        }
        delay(300)
        repo.saveComicProgress(book.id, page, total)
    }

    LaunchedEffect(listState.firstVisibleItemIndex, total, settings.continuous) {
        if (total <= 0 || !settings.continuous) return@LaunchedEffect
        page = listState.firstVisibleItemIndex.coerceIn(0, total - 1)
        delay(300)
        repo.saveComicProgress(book.id, page, total)
    }

    // 邻页预取：±2
    LaunchedEffect(page, total) {
        if (total <= 0) return@LaunchedEffect
        val from = (page - 2).coerceAtLeast(0)
        val to = (page + 2).coerceAtMost(total - 1)
        for (i in from..to) {
            imageLoader.enqueue(
                ImageRequest.Builder(ctx)
                    .data(repo.pageUrl(book.id, i))
                    .build()
            )
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize().background(bg)) {
        val density = LocalDensity.current
        val widthPx = with(density) { maxWidth.toPx() }
        val heightPx = with(density) { maxHeight.toPx() }

        when {
            loading -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = MaterialTheme.colorScheme.primary)
            error != null -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(error!!, color = Color.White)
                TextButton(onClick = onClose) { Text("返回", color = Color.White) }
            }
            total == 0 -> Text(
                "纯 PDF 漫画暂不支持原生渲染，请用网页版阅读",
                color = Color.White, modifier = Modifier.align(Alignment.Center)
            )
            settings.continuous -> {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectTapGestures { pos ->
                                val ratio = pos.x / widthPx
                                when {
                                    ratio < 0.3f -> scope.launch {
                                        listState.animateScrollBy(-heightPx * 0.85f)
                                    }
                                    ratio > 0.7f -> scope.launch {
                                        listState.animateScrollBy(heightPx * 0.85f)
                                    }
                                    else -> showToolbar = !showToolbar
                                }
                            }
                        }
                ) {
                    items(total) { i ->
                        AsyncImage(
                            model = repo.pageUrl(book.id, i),
                            contentDescription = "第 ${i + 1} 页",
                            contentScale = ContentScale.FillWidth,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
            else -> {
                HorizontalPager(
                    state = pagerState,
                    modifier = Modifier.fillMaxSize(),
                    beyondBoundsPageCount = 2,
                    userScrollEnabled = scale <= 1f && settings.turnStyle != TurnStyle.NONE
                ) { slot ->
                    val first = slot * step
                    val second = if (step == 2) first + 1 else -1
                    val offset = ((pagerState.currentPage - slot) + pagerState.currentPageOffsetFraction)
                        .coerceIn(-1f, 1f)
                    Box(
                        Modifier
                            .fillMaxSize()
                            .graphicsLayer {
                                scaleX = scale
                                scaleY = scale
                                translationX = offsetX
                                translationY = offsetY
                                if (settings.turnStyle == TurnStyle.COVER) {
                                    val p = abs(offset)
                                    alpha = 1f - p * 0.22f
                                    translationX += -p * 40f
                                }
                            }
                            .pointerInput(settings.rtl) {
                                detectTapGestures(
                                    onDoubleTap = {
                                        if (scale > 1f) {
                                            scale = 1f; offsetX = 0f; offsetY = 0f
                                        } else {
                                            scale = 2f
                                        }
                                    },
                                    onTap = { pos ->
                                        val ratio = pos.x / widthPx
                                        val nextZone = if (settings.rtl) ratio < 0.3f else ratio > 0.7f
                                        val prevZone = if (settings.rtl) ratio > 0.7f else ratio < 0.3f
                                        when {
                                            nextZone -> {
                                                val target = pagerState.currentPage + 1
                                                if (target < slots) scope.launch {
                                                    if (settings.turnStyle == TurnStyle.NONE) pagerState.scrollToPage(target)
                                                    else pagerState.animateScrollToPage(target)
                                                } else {
                                                    Toast.makeText(ctx, "已是最后一页", Toast.LENGTH_SHORT).show()
                                                }
                                            }
                                            prevZone -> {
                                                val target = pagerState.currentPage - 1
                                                if (target >= 0) scope.launch {
                                                    if (settings.turnStyle == TurnStyle.NONE) pagerState.scrollToPage(target)
                                                    else pagerState.animateScrollToPage(target)
                                                } else {
                                                    Toast.makeText(ctx, "已是第一页", Toast.LENGTH_SHORT).show()
                                                }
                                            }
                                            else -> showToolbar = !showToolbar
                                        }
                                    }
                                )
                            }
                            .pointerInput(Unit) {
                                detectTransformGestures { _, pan, zoom, _ ->
                                    scale = (scale * zoom).coerceIn(1f, 4f)
                                    if (scale > 1f) {
                                        offsetX += pan.x
                                        offsetY += pan.y
                                    } else {
                                        offsetX = 0f; offsetY = 0f
                                    }
                                }
                            }
                    ) {
                        if (step == 2) {
                            Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center) {
                                val leftIdx = if (settings.rtl) second else first
                                val rightIdx = if (settings.rtl) first else second
                                ImagePage(book.id, leftIdx, total, settings.fit, Modifier.weight(1f).fillMaxHeight())
                                if (rightIdx < total) {
                                    ImagePage(book.id, rightIdx, total, settings.fit, Modifier.weight(1f).fillMaxHeight())
                                }
                            }
                        } else {
                            ImagePage(
                                book.id, first, total, settings.fit,
                                Modifier.fillMaxSize()
                            )
                        }
                    }
                }
            }
        }

        if (showToolbar && !loading && error == null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .background(Color.Black.copy(alpha = 0.72f))
                    .padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = "返回", tint = Color.White)
                }
                Text(
                    "${pageLabel(page, total, step)} · ${book.title}",
                    color = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (!settings.continuous && scale > 1f) {
                    TextButton(onClick = { scale = 1f; offsetX = 0f; offsetY = 0f }) {
                        Text("复位", color = Color.White)
                    }
                }
                IconButton(onClick = { showSettings = true }) {
                    Icon(Icons.Filled.Tune, contentDescription = "阅读设置", tint = Color.White)
                }
            }
        }

        if (showSettings) {
            ModalBottomSheet(onDismissRequest = { showSettings = false }) {
                ComicSettingsSheet(settings) { next ->
                    val keep = page
                    settings = next
                    ReaderSettingsStore.saveComic(ctx, next)
                    // 切换单双页/长条后，上面的 LaunchedEffect 会按 page 重新定位
                    page = keep
                }
            }
        }
    }
}

@Composable
private fun ImagePage(
    bookId: Long,
    index: Int,
    total: Int,
    fit: ComicFit,
    modifier: Modifier
) {
    if (index !in 0 until total) {
        Spacer(modifier)
        return
    }
    val scale = when (fit) {
        ComicFit.CONTAIN -> ContentScale.Fit
        ComicFit.WIDTH -> ContentScale.FillWidth
        ComicFit.NONE -> ContentScale.None
    }
    AsyncImage(
        model = cn.cinemavault.app.data.api.ServerConfig.api("/api/comic/$bookId/page/$index"),
        contentDescription = "第 ${index + 1} 页",
        contentScale = scale,
        modifier = modifier
    )
}

private fun pageLabel(page: Int, total: Int, step: Int): String {
    if (total <= 0) return "0/0"
    return if (step == 2) {
        val end = min(page + 2, total)
        "${page + 1}-$end/$total"
    } else {
        "${page + 1}/$total"
    }
}
