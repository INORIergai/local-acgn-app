package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import cn.cinemavault.app.data.repo.AuthState
import cn.cinemavault.app.data.model.CalendarItem
import cn.cinemavault.app.data.model.Movie
import cn.cinemavault.app.data.model.Stats
import cn.cinemavault.app.data.model.posterUrl

@Composable
fun HomeScreen(
    modifier: Modifier = Modifier,
    vm: MainViewModel = androidx.lifecycle.viewmodel.compose.viewModel(),
    onOpenSeries: () -> Unit = {},
    onOpenBook: (cn.cinemavault.app.data.model.Movie) -> Unit = {},
    onOpenOnline: (String) -> Unit = {}
) {
    when (val s = vm.state) {
        is AuthState.NeedServer -> ConnectScreen(vm, modifier)
        is AuthState.NeedLogin -> LoginScreen(vm, modifier)
        is AuthState.Error -> ErrorScreen(s.message, vm, modifier)
        is AuthState.Ready -> HomeContent(vm, modifier, onOpenSeries, onOpenBook, onOpenOnline)
    }
}

@Composable
private fun ConnectScreen(vm: MainViewModel, modifier: Modifier) {
    var server by remember { mutableStateOf("") }
    Column(modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("Cinema Vault", style = MaterialTheme.typography.displayLarge, color = MaterialTheme.colorScheme.primary)
        Text("连接到电脑/NAS 本地影库", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(32.dp))
        OutlinedTextField(
            value = server, onValueChange = { server = it },
            label = { Text("局域网 IP 或穿透网址") },
            placeholder = { Text("192.168.1.5 或 xxx.trycloudflare.com") },
            singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Uri)
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = { vm.connect(server) }, modifier = Modifier.fillMaxWidth().height(52.dp)) {
            Text("立即连接")
        }
    }
}

@Composable
private fun LoginScreen(vm: MainViewModel, modifier: Modifier) {
    var pwd by remember { mutableStateOf("") }
    var fail by remember { mutableStateOf(false) }
    Column(modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Text("访问密码", style = MaterialTheme.typography.headlineMedium)
        Text("影库已启用访问保护", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = pwd, onValueChange = { pwd = it; fail = false },
            label = { Text("密码") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            isError = fail, modifier = Modifier.fillMaxWidth()
        )
        if (vm.message != null) {
            Text(vm.message!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = { vm.login(pwd) { ok -> fail = !ok } }, modifier = Modifier.fillMaxWidth().height(52.dp), enabled = !vm.loading) {
            Text(if (vm.loading) "登录中…" else "登录")
        }
        Spacer(Modifier.height(12.dp))
        TextButton(onClick = { vm.check() }) { Text("重新检测连接") }
    }
}

@Composable
private fun ErrorScreen(msg: String, vm: MainViewModel, modifier: Modifier) {
    Column(modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("连接失败", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.error)
        Text(msg, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(16.dp))
        Button(onClick = { vm.check() }) { Text("重试") }
        TextButton(onClick = { vm.connect("") }) { Text("更换服务器") }
    }
}

@Composable
private fun HomeContent(
    vm: MainViewModel, modifier: Modifier, onOpenSeries: () -> Unit,
    onOpenBook: (cn.cinemavault.app.data.model.Movie) -> Unit,
    onOpenOnline: (String) -> Unit
) {
    val context = LocalContext.current
    val dark = isSystemInDarkTheme()
    val brandTitle = if (dark) "午夜场" else "纸上典藏"
    var detail by remember { mutableStateOf<cn.cinemavault.app.data.model.Movie?>(null) }

    LazyColumn(modifier.fillMaxSize()) {
        // ── Hero：策展叙事（产品的独有机制）──
        item {
            CuratedHero(
                title = brandTitle,
                count = vm.stats?.totalMovies ?: 0,
                dark = dark
            ) { onOpenSeries() }
        }

        // ── 追番入口卡（六大场景之一）──
        item {
            Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                .clickable(onClick = onOpenSeries),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
                Row(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("追番看板", style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSecondaryContainer)
                        Text("6 态管理 · 本周新番 · 在线源", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.8f))
                    }
                    Text("进入 ›", style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSecondaryContainer)
                }
            }
        }

        // ── 错误态：热度榜失败时给明确的重试，而不是静默空列表 ──
        vm.homeError?.let { err ->
            item {
                Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(err, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer)
                        TextButton(onClick = { vm.refreshHome() }) {
                            Text("重试", color = MaterialTheme.colorScheme.onErrorContainer)
                        }
                    }
                }
            }
        }

        if (vm.homeLoading) {
            item { Box(modifier = Modifier.fillMaxWidth().height(120.dp).padding(16.dp),
                contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
        } else {
            // 四统计退居次要行（hero 已承载大数字）
            vm.stats?.let { s -> item { StatsStrip(s) } }

            if (vm.calendar.isNotEmpty()) {
                item { SectionTitle("本周放送") }
                item {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp)) {
                        items(vm.calendar.take(12)) { c ->
                            // 本周放送 → 在线追番（按标题搜在线源）
                            CalendarCard(c) { onOpenOnline(c.title) }
                        }
                    }
                }
            }
            if (vm.hotMovies.isNotEmpty()) {
                item { SectionTitle("热度榜") }
                items(vm.hotMovies) { m ->
                    MovieRow(m, vm.baseUrl) { detail = m }
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }

    // 首页条目详情抽屉：按类型给正确 CTA（bug2/bug3：不再只弹名字）
    detail?.let { m ->
        HomeDetailSheet(m, vm.baseUrl,
            onDismiss = { detail = null },
            onReadOrPlay = { onOpenBook(m); detail = null },
            onOnline = { onOpenOnline(m.title); detail = null })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeDetailSheet(
    m: cn.cinemavault.app.data.model.Movie, base: String,
    onDismiss: () -> Unit, onReadOrPlay: () -> Unit, onOnline: () -> Unit
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        val isComic = m.type == "comic"
        val isNovel = m.type == "novel"
        val isBook = isComic || isNovel
        Row(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            Box(modifier = Modifier.size(96.dp, 136.dp).clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)) {
                val url = m.posterUrl(base)
                if (url.isNotBlank()) AsyncImage(model = url, contentDescription = null,
                    contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            }
            Spacer(Modifier.width(14.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(m.title, style = MaterialTheme.typography.titleLarge, maxLines = 3)
                Spacer(Modifier.height(8.dp))
                Text("类型 ${m.type.uppercase()}", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Button(onClick = onReadOrPlay, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                Text(if (isComic) "📖 立即阅读" else if (isNovel) "📖 立即阅读" else "▶ 立即播放")
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = onOnline, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                Text(if (isBook) "在线追更" else "🌐 在线搜源")
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** 策展 Hero——PC 端「PAPER ARCHIVE · 纸上典藏」的原生表达。 */
@Composable
private fun CuratedHero(title: String, count: Int, dark: Boolean, onClick: () -> Unit) {
    val heroBg = if (dark) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.primary
    val heroFg = if (dark) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onPrimary
    Card(
        modifier = Modifier.fillMaxWidth().padding(16.dp).height(if (dark) 168.dp else 184.dp)
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = heroBg)
    ) {
        Column(modifier = Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Text("CURATED ARCHIVE  ·  $title", style = MaterialTheme.typography.labelMedium, color = heroFg.copy(alpha = 0.82f))
            Column {
                Text("今天，翻开你的私人馆藏", style = MaterialTheme.typography.headlineMedium, color = heroFg)
                Spacer(Modifier.height(8.dp))
                Text("$count", style = MaterialTheme.typography.displayLarge, color = heroFg)
                Text("部珍藏 · 馆长为你甄选", style = MaterialTheme.typography.bodyMedium, color = heroFg.copy(alpha = 0.85f))
            }
        }
    }
}

@Composable
private fun StatsStrip(s: Stats) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.SpaceEvenly) {
        StatItem("${s.watchedCount}", "已看")
        StatItem("${s.actressCount}", "影人")
        StatItem("${s.tagCount}", "标签")
    }
}

@Composable
private fun StatItem(v: String, label: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(v, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SectionTitle(t: String) {
    Text(t, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(16.dp, 20.dp, 16.dp, 8.dp))
}

@Composable
private fun CalendarCard(c: CalendarItem, onClick: () -> Unit) {
    Column(modifier = Modifier.width(110.dp).clickable(onClick = onClick)) {
        Box(modifier = Modifier.size(110.dp, 150.dp).clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)) {
            if (c.cover != null) {
                AsyncImage(model = c.cover, contentDescription = c.title, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize())
            }
            // 集数徽标
            c.episode?.let {
                Text("第 $it 话", style = MaterialTheme.typography.labelMedium, color = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier.align(Alignment.BottomStart).padding(6.dp)
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.85f), RoundedCornerShape(6.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp))
            }
        }
        Text(c.title, style = MaterialTheme.typography.bodySmall, maxLines = 2, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun MovieRow(m: Movie, base: String, onClick: () -> Unit) {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
        .clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface)
        .clickable(onClick = onClick).padding(8.dp)) {
        Box(modifier = Modifier.size(64.dp, 90.dp).clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)) {
            val url = m.posterUrl(base)
            if (url.isNotBlank()) AsyncImage(model = url, contentDescription = m.title,
                contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(m.title, style = MaterialTheme.typography.titleMedium, maxLines = 2)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(m.type.uppercase(), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (m.score > 0) {
                    Spacer(Modifier.width(8.dp))
                    Text("★ ${m.score}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}
