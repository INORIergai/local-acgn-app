package cn.cinemavault.app.ui.screen

import android.text.Html
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.cinemavault.app.ReaderKeyBus
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.repo.ReaderRepository
import kotlinx.coroutines.launch

/** 小说阅读器：章节文本、字号 A-/A+、目录抽屉、断点续章、进度保存。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NovelReaderScreen(book: Movie, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val cnv = LocalContext.current
    val repo = remember { ReaderRepository() }

    var info by remember { mutableStateOf<ReaderRepository.NovelInfo?>(null) }
    var chapterIndex by remember { mutableIntStateOf(0) }
    var content by remember { mutableStateOf("") }
    var textSize by remember { mutableFloatStateOf(18f) }
    var loading by remember { mutableStateOf(true) }
    var showCatalog by remember { mutableStateOf(false) }
    var showToolbar by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    // 听书状态只读 TtsController：UI 与服务共用一份，不会再出现「停了还显示在播」
    val ttsActive = cn.cinemavault.app.playback.TtsController.isActive

    // 系统返回键：目录开着先关目录，否则关阅读器（不退出 App）
    BackHandler {
        if (showCatalog) showCatalog = false else onClose()
    }

    suspend fun loadChapter(i: Int) {
        val cur = info ?: return
        if (i < 0 || i >= cur.chapters.size) return
        // 翻章就停掉上一章的听书，避免旧章还在念、新章又起一份
        if (cn.cinemavault.app.playback.TtsController.isActive) {
            cn.cinemavault.app.playback.TtsController.stop(cnv)
        }
        chapterIndex = i
        loading = true
        try {
            val c = repo.chapter(cur.id, i)
            // HTML 净化文本 → 纯文本显示（图片章节在原生降级为提示）
            content = if (c.isHtml) {
                val spanned = Html.fromHtml(c.content, Html.FROM_HTML_MODE_COMPACT)
                spanned.toString()
            } else c.content
            repo.saveNovelProgress(cur.id, i, cur.totalChapters)
        } catch (e: Exception) {
            error = e.message ?: "章节加载失败"
        } finally { loading = false }
    }

    val chapterNavState = rememberUpdatedState { dir: Int ->
        val cur = info
        if (cur != null) scope.launch { loadChapter(chapterIndex + dir) }
    }

    DisposableEffect(book.id) {
        ReaderKeyBus.register { dir ->
            chapterNavState.value(dir)
            true
        }
        cn.cinemavault.app.FullScreenController.enter() // 沉浸全屏阅读（bug4）
        scope.launch { repo.startReading(book.id, "novel") }
        onDispose {
            ReaderKeyBus.unregister()
            cn.cinemavault.app.FullScreenController.exit()
            scope.launch { repo.stopReading(book.id, "novel") }
        }
    }

    LaunchedEffect(book.id) {
        try {
            val i = repo.novelInfo(book.id)
            info = i
            if (i.readKind == "pdf") {
                error = "PDF 小说暂不支持原生渲染，请用网页版阅读"
            } else {
                loadChapter(i.currentChapter.coerceIn(0, (i.totalChapters - 1).coerceAtLeast(0)))
            }
        } catch (e: Exception) {
            error = e.message ?: "加载失败"
        } finally { loading = false }
    }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        when {
            loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            error != null -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(error!!, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = onClose) { Text("返回") }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize()
                        .pointerInput(Unit) {
                            var totalDrag = 0f
                            detectHorizontalDragGestures(
                                onDragStart = { totalDrag = 0f },
                                onHorizontalDrag = { _, amount -> totalDrag += amount },
                                onDragEnd = {
                                    if (kotlin.math.abs(totalDrag) > 70f) {
                                        scope.launch { loadChapter(chapterIndex + if (totalDrag < 0) 1 else -1) }
                                    }
                                }
                            )
                        }
                        .clickable { showToolbar = !showToolbar },
                    contentPadding = PaddingValues(20.dp, 72.dp, 20.dp, 72.dp)
                ) {
                    item {
                        Text(info?.chapters?.getOrNull(chapterIndex)?.title ?: book.title,
                            style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.padding(bottom = 16.dp))
                    }
                    item {
                        Text(content, fontSize = textSize.sp, lineHeight = (textSize * 1.7f).sp,
                            color = MaterialTheme.colorScheme.onBackground)
                    }
                }
            }
        }

        if (showToolbar && !loading && error == null) {
            Row(modifier = Modifier.fillMaxWidth().statusBarsPadding()
                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.95f))
                .padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.Filled.ArrowBack, contentDescription = "返回") }
                // 听书进行中把合成/播放进度顶在标题位，让用户看得见它在干嘛
                Text(
                    if (ttsActive) cn.cinemavault.app.playback.TtsController.statusText
                    else "${chapterIndex + 1}/${info?.totalChapters ?: 0}",
                    modifier = Modifier.weight(1f)
                )
                TextButton(onClick = { textSize = (textSize - 2f).coerceAtLeast(12f) }) { Text("A−") }
                TextButton(onClick = { textSize = (textSize + 2f).coerceAtMost(32f) }) { Text("A+") }
                IconButton(onClick = {
                    val ctx = cnv
                    if (ttsActive) {
                        // 停止：cancel 合成协程 + 停服务，通知栏的停止键走同一条路
                        cn.cinemavault.app.playback.TtsController.stop(ctx)
                        Toast.makeText(ctx, "已停止听书", Toast.LENGTH_SHORT).show()
                    } else {
                        cn.cinemavault.app.playback.TtsController.start(
                            scope, ctx, book.id, book.title, chapterIndex
                        )
                        Toast.makeText(ctx, "开始听书（合成中也可停止）", Toast.LENGTH_SHORT).show()
                    }
                }) {
                    if (ttsActive) {
                        // 合成中也在转圈，但图标保持 Stop：任何时刻点下去都能停
                        Icon(Icons.Filled.Stop, contentDescription = "停止听书",
                            tint = MaterialTheme.colorScheme.error)
                    } else Icon(Icons.Filled.VolumeUp, contentDescription = "听书")
                }
                IconButton(onClick = { showCatalog = true }) { Icon(Icons.Filled.List, contentDescription = "目录") }
            }
        }
    }

    if (showCatalog && info != null) {
        ModalBottomSheet(onDismissRequest = { showCatalog = false }) {
            LazyColumn(contentPadding = PaddingValues(16.dp)) {
                itemsIndexed(info!!.chapters) { i, ch ->
                    ListItem(
                        headlineContent = { Text("${i + 1}. ${ch.title}") },
                        modifier = Modifier.clickable {
                            scope.launch { loadChapter(i) }
                            showCatalog = false
                        },
                        colors = ListItemDefaults.colors(
                            containerColor = if (i == chapterIndex) MaterialTheme.colorScheme.primaryContainer
                            else Color.Transparent
                        )
                    )
                }
            }
        }
    }
}
