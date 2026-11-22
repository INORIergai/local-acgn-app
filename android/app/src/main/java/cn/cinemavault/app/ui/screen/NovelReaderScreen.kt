package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.FormatSize
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.cinemavault.app.ReaderKeyBus
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.repo.ReaderRepository
import cn.cinemavault.app.playback.TtsController
import cn.cinemavault.app.reading.NovelFont
import cn.cinemavault.app.reading.NovelPageWidth
import cn.cinemavault.app.reading.NovelPaginator
import cn.cinemavault.app.reading.NovelSettings
import cn.cinemavault.app.reading.NovelSettingsSheet
import cn.cinemavault.app.reading.ReaderSettingsStore
import cn.cinemavault.app.reading.TurnStyle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 小说阅读器（v5.1）：
 *  - TXT：按屏分页 + HorizontalPager，翻页样式 覆盖/平移/滚动/无动画；
 *  - EPUB 富文本：继续 WebView 滚动（P0 不做 CSS 多列，避免破坏扫描书排版）；
 *  - 进度存章内字符偏移（/api/novel/:id/progress 的 position），重开精确回到原页；
 *  - 章末/章首翻页自动跨章，字号/行距变更后保持当前字符位置。
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun NovelReaderScreen(book: Movie, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val repo = remember { ReaderRepository() }

    var settings by remember { mutableStateOf(ReaderSettingsStore.loadNovel(ctx)) }
    var info by remember { mutableStateOf<ReaderRepository.NovelInfo?>(null) }
    var chapterIndex by remember { mutableIntStateOf(0) }
    var content by remember { mutableStateOf("") }
    var contentIsHtml by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var showToolbar by remember { mutableStateOf(true) }
    var showCatalog by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var polishOpen by remember { mutableStateOf(false) }
    var polishText by remember { mutableStateOf("") }
    var polishLoading by remember { mutableStateOf(false) }
    // 跨章定位：true=上一章末页；anchorChar>=0=恢复到该字符所在页
    var pendingSeekLast by remember { mutableStateOf(false) }
    var anchorChar by remember { mutableIntStateOf(-1) }
    val ttsActive = TtsController.isActive

    BackHandler {
        when {
            showCatalog -> showCatalog = false
            showSettings -> showSettings = false
            polishOpen -> polishOpen = false
            else -> onClose()
        }
    }

    suspend fun loadChapter(index: Int, seekLast: Boolean = false, seekPosition: Int = -1) {
        val cur = info ?: return
        if (index !in cur.chapters.indices) return
        if (TtsController.isActive) TtsController.stop(ctx)
        loading = true
        try {
            val c = repo.chapter(cur.id, index)
            val meta = cur.chapters.getOrNull(index)
            // 翻页优先：只有用户显式选「滚动」模式时，含图/扫描版 EPUB 才走 WebView 保住原排版；
            // 其余情况一律走原生分页（字号/行距/页宽可调、每页字数随窗口自适应、点击翻页）。
            // 服务端章节同时给纯文本 text 与富文本 content，无纯文本时做轻量标签剥离兜底。
            val wantsScroll = settings.turnStyle == TurnStyle.SCROLL
            val richOnly = c.isHtml && wantsScroll &&
                ((meta?.hasImage == true) || c.plainText.isBlank())
            chapterIndex = index
            contentIsHtml = richOnly
            content = when {
                !c.isHtml -> c.content
                richOnly -> c.content
                c.plainText.isNotBlank() -> c.plainText
                else -> stripHtmlForPaging(c.content)   // rich 模式下无纯文本：剥离标签后分页
            }
            pendingSeekLast = seekLast
            anchorChar = seekPosition
            repo.saveNovelProgress(cur.id, index, seekPosition.coerceAtLeast(0), cur.totalChapters)
        } catch (e: Exception) {
            error = e.message ?: "章节加载失败"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(book.id) {
        try {
            val i = repo.novelInfo(book.id)
            info = i
            if (i.readKind == "pdf") {
                error = "PDF 小说暂不支持原生渲染，请用网页版阅读"
            } else {
                loadChapter(
                    i.currentChapter.coerceIn(0, (i.totalChapters - 1).coerceAtLeast(0)),
                    seekPosition = i.currentPosition
                )
            }
        } catch (e: Exception) {
            error = e.message ?: "加载失败"
        } finally {
            loading = false
        }
    }

    DisposableEffect(book.id) {
        cn.cinemavault.app.FullScreenController.enter()
        scope.launch { repo.startReading(book.id, "novel") }
        onDispose {
            ReaderKeyBus.unregister()
            cn.cinemavault.app.FullScreenController.exit()
            scope.launch { repo.stopReading(book.id, "novel") }
        }
    }

    val bg = if (settings.night) Color(0xFF101010) else Color(settings.background)
    val fg = if (settings.night) Color(0xFFBDBDBD) else Color(0xFF262626)
    val fontFamily = when (settings.font) {
        NovelFont.SERIF -> FontFamily.Serif
        NovelFont.SANS -> FontFamily.SansSerif
        NovelFont.KAI -> FontFamily.Serif   // Android 无内置楷体，P0 回退宋体
    }
    val textStyle = remember(settings) {
        TextStyle(
            fontSize = settings.fontSize.sp,
            lineHeight = (settings.fontSize * settings.lineHeight).sp,
            fontFamily = fontFamily,
            color = fg
        )
    }

    BoxWithConstraints(
        modifier = Modifier.fillMaxSize().background(bg)
    ) {
        val density = LocalDensity.current
        val measurer = rememberTextMeasurer()
        val hPad = settings.padding.dp
        val topPad = 60.dp
        val bottomPad = 56.dp
        // 页宽（每行字数）：按屏宽自适应，窄≈20字/中≈28字/宽≈38字/全宽铺满
        val pageWidthCap = when (settings.pageWidth) {
            NovelPageWidth.NARROW -> 440.dp
            NovelPageWidth.MEDIUM -> 620.dp
            NovelPageWidth.WIDE -> 820.dp
            NovelPageWidth.FULL -> maxWidth
        }
        val contentWidth = minOf(maxWidth - hPad * 2, pageWidthCap).coerceAtLeast(200.dp)
        val sidePad = ((maxWidth - contentWidth) / 2).coerceAtLeast(0.dp)
        val widthPx = with(density) { contentWidth.roundToPx() }
        val heightPx = with(density) { (maxHeight - topPad - bottomPad).roundToPx() }
        val screenWidthPx = with(density) { maxWidth.toPx() }

        val pages = remember(content, textStyle, widthPx, heightPx, contentIsHtml) {
            if (contentIsHtml || content.isEmpty()) emptyList()
            else NovelPaginator.paginate(content, measurer, textStyle, widthPx, heightPx)
        }
        val pagerState = rememberPagerState(pageCount = { pages.size.coerceAtLeast(1) })
        val scrollState = rememberLazyListState()

        // 恢复页 / 跨章末页 / 设置变更后保持字符位置
        LaunchedEffect(pages, chapterIndex, content) {
            if (pages.isEmpty()) return@LaunchedEffect
            val target = when {
                pendingSeekLast -> pages.lastIndex
                anchorChar >= 0 -> NovelPaginator.pageOf(pages, anchorChar)
                else -> pagerState.currentPage.coerceIn(0, pages.lastIndex)
            }
            if (pagerState.currentPage != target) pagerState.scrollToPage(target)
            pendingSeekLast = false
            anchorChar = -1
        }

        // 页内进度落库（350ms 去抖，快速翻页不刷接口）
        LaunchedEffect(pagerState.currentPage, pages, chapterIndex) {
            if (pages.isEmpty()) return@LaunchedEffect
            if (contentIsHtml || settings.turnStyle == TurnStyle.SCROLL) return@LaunchedEffect
            val page = pages.getOrNull(pagerState.currentPage) ?: return@LaunchedEffect
            delay(350)
            repo.saveNovelProgress(book.id, chapterIndex, page.start, info?.totalChapters ?: 0)
        }

        // 章间跳转 / 页间跳转
        val goNext: () -> Unit = {
            if (settings.turnStyle == TurnStyle.SCROLL) {
                scope.launch {
                    if (scrollState.canScrollForward) {
                        scrollState.animateScrollBy(heightPx * 0.85f)
                    } else {
                        loadChapter(chapterIndex + 1)
                    }
                }
            } else {
                scope.launch {
                    if (pages.isEmpty()) return@launch
                    val next = pagerState.currentPage + 1
                    if (next <= pages.lastIndex) {
                        if (settings.turnStyle == TurnStyle.NONE) pagerState.scrollToPage(next)
                        else pagerState.animateScrollToPage(next)
                    } else {
                        loadChapter(chapterIndex + 1)
                    }
                }
            }
        }
        val goPrev: () -> Unit = {
            if (settings.turnStyle == TurnStyle.SCROLL) {
                scope.launch {
                    if (scrollState.canScrollBackward) {
                        scrollState.animateScrollBy(-heightPx * 0.85f)
                    } else {
                        loadChapter(chapterIndex - 1, seekLast = true)
                    }
                }
            } else {
                scope.launch {
                    if (pages.isEmpty()) return@launch
                    val prev = pagerState.currentPage - 1
                    if (prev >= 0) {
                        if (settings.turnStyle == TurnStyle.NONE) pagerState.scrollToPage(prev)
                        else pagerState.animateScrollToPage(prev)
                    } else {
                        loadChapter(chapterIndex - 1, seekLast = true)
                    }
                }
            }
        }
        val goNextState = rememberUpdatedState(goNext)
        val goPrevState = rememberUpdatedState(goPrev)

        // 音量键：页级翻页，到章界再跨章
        DisposableEffect(book.id) {
            ReaderKeyBus.register { dir ->
                if (dir > 0) goNextState.value() else goPrevState.value()
                true
            }
            onDispose { ReaderKeyBus.unregister() }
        }

        // 自动翻页
        LaunchedEffect(settings.autoTurnMs, pagerState.currentPage, chapterIndex, contentIsHtml) {
            if (settings.autoTurnMs <= 0 || contentIsHtml || settings.turnStyle == TurnStyle.SCROLL) {
                return@LaunchedEffect
            }
            delay(settings.autoTurnMs.toLong())
            goNextState.value()
        }

        when {
            loading && content.isEmpty() -> {
                CircularProgressIndicator(Modifier.align(Alignment.Center))
            }
            error != null && content.isEmpty() -> {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(error!!, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    TextButton(onClick = onClose) { Text("返回") }
                }
            }
            contentIsHtml -> {
                RichNovelContent(
                    html = content,
                    textSize = settings.fontSize.toFloat(),
                    onTap = { showToolbar = !showToolbar },
                    onSwipe = { dir -> scope.launch { loadChapter(chapterIndex + dir) } },
                    modifier = Modifier.fillMaxSize()
                )
            }
            settings.turnStyle == TurnStyle.SCROLL -> {
                LazyColumn(
                    state = scrollState,
                    modifier = Modifier
                        .fillMaxSize()
                        .pointerInput(Unit) {
                            detectTapGestures { pos ->
                                when {
                                    pos.x < screenWidthPx * 0.28f -> goPrevState.value()
                                    pos.x > screenWidthPx * 0.72f -> goNextState.value()
                                    else -> showToolbar = !showToolbar
                                }
                            }
                        },
                    contentPadding = PaddingValues(sidePad, topPad, sidePad, bottomPad)
                ) {
                    item {
                        Text(
                            text = content,
                            style = textStyle,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
            else -> {
                HorizontalPager(
                    state = pagerState,
                    modifier = Modifier.fillMaxSize(),
                    beyondBoundsPageCount = 1,
                    userScrollEnabled = settings.turnStyle != TurnStyle.NONE
                ) { page ->
                    val offset = ((pagerState.currentPage - page) + pagerState.currentPageOffsetFraction)
                        .coerceIn(-1f, 1f)
                    Box(
                        Modifier
                            .fillMaxSize()
                            .padding(start = sidePad, end = sidePad, top = topPad, bottom = bottomPad)
                            .graphicsLayer {
                                if (settings.turnStyle == TurnStyle.COVER) {
                                    val p = kotlin.math.abs(offset)
                                    scaleX = 1f - p * 0.05f
                                    scaleY = 1f - p * 0.05f
                                    alpha = 1f - p * 0.25f
                                }
                            }
                            .pointerInput(Unit) {
                                detectTapGestures { pos ->
                                    when {
                                        pos.x < screenWidthPx * 0.28f -> goPrevState.value()
                                        pos.x > screenWidthPx * 0.72f -> goNextState.value()
                                        else -> showToolbar = !showToolbar
                                    }
                                }
                            }
                    ) {
                        val slice = pages.getOrNull(page)
                        if (slice != null) {
                            Text(
                                text = content.substring(slice.start, slice.end),
                                style = textStyle,
                                modifier = Modifier.fillMaxSize()
                            )
                        }
                    }
                }
            }
        }

        // 顶部工具栏
        if (showToolbar && error == null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .background(bg.copy(alpha = 0.94f))
                    .padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = "返回", tint = fg)
                }
                Text(
                    text = info?.chapters?.getOrNull(chapterIndex)?.title ?: book.title,
                    color = fg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                IconButton(onClick = { showSettings = true }) {
                    Icon(Icons.Filled.FormatSize, contentDescription = "阅读设置", tint = fg)
                }
                IconButton(onClick = {
                    if (!polishLoading) {
                        polishLoading = true
                        scope.launch {
                            try {
                                val text = repo.polishNovel(book.id, chapterIndex)
                                if (text.isNotBlank()) {
                                    polishText = text
                                    polishOpen = true
                                } else {
                                    Toast.makeText(ctx, "没有拿到润色内容", Toast.LENGTH_SHORT).show()
                                }
                            } catch (e: Exception) {
                                Toast.makeText(ctx, "润色失败：${e.message?.take(40)}", Toast.LENGTH_LONG).show()
                            } finally {
                                polishLoading = false
                            }
                        }
                    }
                }) {
                    if (polishLoading) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Filled.AutoAwesome, contentDescription = "润色", tint = fg)
                    }
                }
                IconButton(onClick = {
                    if (ttsActive) {
                        TtsController.stop(ctx)
                        Toast.makeText(ctx, "已停止听书", Toast.LENGTH_SHORT).show()
                    } else {
                        TtsController.start(scope, ctx, book.id, book.title, chapterIndex)
                        Toast.makeText(ctx, "开始听书（合成中也可停止）", Toast.LENGTH_SHORT).show()
                    }
                }) {
                    if (ttsActive) {
                        Icon(Icons.Filled.Stop, contentDescription = "停止听书",
                            tint = MaterialTheme.colorScheme.error)
                    } else {
                        Icon(Icons.Filled.VolumeUp, contentDescription = "听书", tint = fg)
                    }
                }
                IconButton(onClick = { showCatalog = true }) {
                    Icon(Icons.Filled.List, contentDescription = "目录", tint = fg)
                }
            }
        }

        // 底部状态栏
        if (showToolbar && error == null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .background(bg.copy(alpha = 0.94f))
                    .padding(horizontal = 18.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "${chapterIndex + 1}/${info?.totalChapters ?: 0} 章",
                    color = fg.copy(alpha = 0.72f),
                    style = MaterialTheme.typography.labelMedium
                )
                Spacer(Modifier.weight(1f))
                if (ttsActive) {
                    Text(TtsController.statusText, color = fg.copy(alpha = 0.72f),
                        style = MaterialTheme.typography.labelMedium)
                } else if (settings.turnStyle == TurnStyle.SCROLL) {
                    Text("滚动阅读", color = fg.copy(alpha = 0.72f),
                        style = MaterialTheme.typography.labelMedium)
                } else if (pages.isNotEmpty()) {
                    Text(
                        "${pagerState.currentPage + 1}/${pages.size} 页",
                        color = fg.copy(alpha = 0.72f),
                        style = MaterialTheme.typography.labelMedium
                    )
                }
            }
        }

        // 阅读设置
        if (showSettings) {
            ModalBottomSheet(onDismissRequest = { showSettings = false }) {
                NovelSettingsSheet(settings) { next ->
                    // 先记住当前页字符位置，再重排，避免字号一变跳回章首
                    if (pages.isNotEmpty()) {
                        anchorChar = pages.getOrNull(pagerState.currentPage)?.start ?: 0
                    }
                    settings = next
                    ReaderSettingsStore.saveNovel(ctx, next)
                }
            }
        }

        // 目录
        if (showCatalog && info != null) {
            ModalBottomSheet(onDismissRequest = { showCatalog = false }) {
                LazyColumn(contentPadding = PaddingValues(16.dp)) {
                    itemsIndexed(info!!.chapters) { i, ch ->
                        ListItem(
                            headlineContent = { Text("${i + 1}. ${ch.title}") },
                            modifier = Modifier.clickable {
                                showCatalog = false
                                scope.launch { loadChapter(i) }
                            },
                            colors = ListItemDefaults.colors(
                                containerColor = if (i == chapterIndex)
                                    MaterialTheme.colorScheme.primaryContainer
                                else Color.Transparent
                            )
                        )
                    }
                }
            }
        }

        // 机翻润色（保持原功能）
        if (polishOpen) {
            ModalBottomSheet(onDismissRequest = { polishOpen = false }) {
                Column(Modifier.fillMaxHeight(0.85f).padding(16.dp)) {
                    Text("机翻润色 · 第 ${chapterIndex + 1} 章", style = MaterialTheme.typography.titleLarge)
                    Text("只改变本次阅读显示，不修改原书", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    LazyColumn(Modifier.weight(1f)) {
                        item {
                            Text(polishText, fontSize = settings.fontSize.sp,
                                lineHeight = (settings.fontSize * settings.lineHeight).sp)
                        }
                    }
                    Button(onClick = {
                        anchorChar = 0
                        content = polishText
                        contentIsHtml = false
                        polishOpen = false
                        Toast.makeText(ctx, "已切换到润色版，翻章后恢复原文", Toast.LENGTH_SHORT).show()
                    }, modifier = Modifier.fillMaxWidth()) { Text("使用润色版阅读") }
                }
            }
        }
    }
}

/** 富文本 EPUB 无纯文本字段时，轻量剥离标签用于原生分页。
 *  只处理块级标签换行 + 实体解码，服务端已做白名单净化，这里不解析脚本/属性。 */
private fun stripHtmlForPaging(html: String): String {
    if (html.isBlank()) return ""
    return html
        .replace(Regex("(?is)<(script|style)[^>]*>.*?</\\1>"), "")
        .replace(Regex("(?is)</?(p|div|br|h[1-6]|li|tr|blockquote)[^>]*>"), "\n")
        .replace(Regex("(?s)<[^>]*>"), "")
        .replace("&nbsp;", " ").replace("&amp;", "&")
        .replace("&lt;", "<").replace("&gt;", ">")
        .replace("&quot;", "\"").replace("&#39;", "'")
        .lines().map { it.trim() }.filter { it.isNotEmpty() }
        .joinToString("\n")
}
