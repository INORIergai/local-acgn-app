package cn.cinemavault.app.ui.screen

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import kotlinx.coroutines.launch
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import cn.cinemavault.app.data.repo.AiRepository

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AiChatScreen(modifier: Modifier = Modifier, vm: AiViewModel = androidx.lifecycle.viewmodel.compose.viewModel()) {
    val context = LocalContext.current
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var player by remember { mutableStateOf<MediaPlayer?>(null) }

    // 系统返回先关闭会话抽屉，再交给顶级 tab 返回栈处理。
    androidx.activity.compose.BackHandler(enabled = drawerState.isOpen) {
        scope.launch { drawerState.close() }
    }

    // 语音识别：系统 SpeechRecognizer（无服务端 ASR，本地识别成文字）
    val speechLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val text = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!text.isNullOrBlank()) vm.onInput(text)
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "说出你想问的…")
            try { speechLauncher.launch(intent) }
            catch (e: Exception) { Toast.makeText(context, "设备不支持语音输入", Toast.LENGTH_SHORT).show() }
        } else Toast.makeText(context, "需要麦克风权限", Toast.LENGTH_SHORT).show()
    }

    // TTS 播放（全 API：/api/tts/synthesize 拿 URL）
    LaunchedEffect(vm.speakUrl) {
        vm.speakUrl?.let { url ->
            try {
                player?.release()
                player = MediaPlayer().apply {
                    setDataSource(url)
                    prepare()
                    start()
                    setOnCompletionListener { vm.consumeSpeak() }
                }
            } catch (e: Exception) { vm.consumeSpeak() }
        }
    }
    DisposableEffect(Unit) { onDispose { player?.release() } }

    vm.error?.let {
        LaunchedEffect(it) {
            Toast.makeText(context, it, Toast.LENGTH_LONG).show()
            vm.consumeError()
        }
    }

    ModalNavigationDrawer(
        drawerContent = {
            ModalDrawerSheet(modifier = Modifier.width(300.dp)) {
                Row(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("AI 会话", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    IconButton(onClick = { vm.newSession() }) { Icon(Icons.Filled.Add, contentDescription = "新建会话") }
                }
                LazyColumn {
                    items(vm.sessions) { s ->
                        NavigationDrawerItem(
                            selected = s.id == vm.currentSessionId,
                            onClick = {
                                vm.selectSession(s.id)
                                scope.launch { drawerState.close() }
                            },
                            label = { Text(s.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            badge = { if (s.messageCount > 0) { Text("${s.messageCount}") } },
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp)
                        )
                    }
                }
            }
        },
        drawerState = drawerState
    ) {
        // 上面 drawerState 写法简化：直接用 remembered state
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CompanionAvatar(generating = vm.generating)
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Text("AI 伴侣", style = MaterialTheme.typography.titleMedium)
                                Text(vm.statusText, style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(Icons.Filled.Menu, contentDescription = "会话列表")
                        }
                    },
                    actions = {
                        val curName = vm.personas?.presets?.firstOrNull { it.id == vm.personas?.currentId }?.name
                            ?: "人格"
                        TextButton(onClick = { vm.togglePersonaPicker() }) { Text(curName) }
                    }
                )
            }
        ) { innerPadding ->
            Column(modifier.fillMaxSize().padding(innerPadding).imePadding()) {
                // 消息列表
                LazyColumn(modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                    reverseLayout = false) {
                    items(vm.messages) { m -> MessageBubble(m) }
                    if (vm.generating) {
                        item {
                            Row(modifier = Modifier.fillMaxWidth().padding(8.dp),
                                verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                                Text(if (vm.streamingText.isNotBlank()) vm.streamingText
                                     else "思考中…", style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.weight(1f))
                            }
                        }
                    }
                }
                // 输入栏
                Row(modifier = Modifier.fillMaxWidth().padding(8.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(24.dp))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED) {
                            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
                            try { speechLauncher.launch(intent) }
                            catch (e: Exception) { Toast.makeText(context, "不支持语音", Toast.LENGTH_SHORT).show() }
                        } else permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }) { Icon(Icons.Filled.Mic, contentDescription = "语音输入") }
                    TextField(
                        value = vm.input, onValueChange = { vm.onInput(it) },
                        placeholder = { Text("和 AI 聊聊…") },
                        modifier = Modifier.weight(1f),
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent
                        ),
                        maxLines = 4
                    )
                    IconButton(onClick = { vm.send() }, enabled = !vm.generating && vm.input.isNotBlank()) {
                        Icon(Icons.Filled.Send, contentDescription = "发送", tint = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
    }

    // 人格切换 BottomSheet（bug4）
    if (vm.showPersonaPicker) {
        ModalBottomSheet(onDismissRequest = { vm.togglePersonaPicker() }) {
            Text("选择人格", style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(20.dp, 8.dp, 16.dp, 8.dp))
            Text("切换后下一条对话生效", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp))
            LazyColumn(contentPadding = PaddingValues(12.dp)) {
                val state = vm.personas
                if (state != null) {
                    items(state.presets) { p ->
                        ListItem(
                            headlineContent = { Text("${p.name}  (${p.id})") },
                            supportingContent = { if (p.desc.isNotBlank()) Text(p.desc) else null },
                            leadingContent = {
                                if (p.id == state.currentId) Icon(Icons.Filled.CheckCircle,
                                    contentDescription = "当前", tint = MaterialTheme.colorScheme.primary)
                            },
                            modifier = Modifier.clickable { vm.switchPersona(p.id) }
                        )
                    }
                } else {
                    item { Text("人格列表加载失败", modifier = Modifier.padding(16.dp)) }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** 伴侣状态头像（Live2D 无原生 SDK，用状态色环 + 微动画表达 thinking/talking/idle）。 */
@Composable
private fun CompanionAvatar(generating: Boolean) {
    val ring by animateFloatAsState(
        targetValue = if (generating) 1f else 0f,
        animationSpec = if (generating) infiniteRepeatable(tween(900)) else tween(200)
    )
    Box(modifier = Modifier.size(36.dp).clip(CircleShape)
        .background(MaterialTheme.colorScheme.primaryContainer)
        .border(if (generating) 2.dp else 0.dp, MaterialTheme.colorScheme.primary, CircleShape),
        contentAlignment = Alignment.Center) {
        Text("${ring}", color = Color.Transparent, modifier = Modifier.size(1.dp)) // 占位触发重组
        Icon(Icons.Filled.AutoAwesome, contentDescription = null,
            tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun MessageBubble(m: AiRepository.Message) {
    val isUser = m.role == "user"
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
        BubbleText(
            text = m.content,
            container = if (isUser) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
            content = if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun BubbleText(text: String, container: Color, content: Color) {
    // 把 [[ID|标题]] 渲染成纯文本「标题」
    val clean = text.replace(Regex("\\[\\[[^|]+\\|([^]]+)\\]\\]"), "$1")
    Text(clean, color = content, modifier = Modifier
        .widthIn(max = 300.dp)
        .background(container, RoundedCornerShape(12.dp))
        .padding(10.dp, 8.dp), style = MaterialTheme.typography.bodyMedium)
}
