package cn.cinemavault.app.ui.screen

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import cn.cinemavault.app.ui.scan.DeepLinkBus
import cn.cinemavault.app.ui.scan.ScanConnectButton
import cn.cinemavault.app.ui.screen.update.UpdateViewModel

/** 完整设置页（bug2：之前完全没有设置概念）。 */
@Composable
fun SettingsScreen(
    modifier: Modifier = Modifier,
    vm: SettingsViewModel = androidx.lifecycle.viewmodel.compose.viewModel(),
    updateVm: UpdateViewModel = androidx.lifecycle.viewmodel.compose.viewModel()
) {
    val context = LocalContext.current
    var autoCheck by remember { mutableStateOf(updateVm.autoCheckEnabled) }

    vm.toast?.let {
        LaunchedEffect(it) { Toast.makeText(context, it, Toast.LENGTH_SHORT).show(); vm.consumeToast() }
    }

    LazyColumn(modifier = modifier.fillMaxSize()) {
        item {
            Text("设置", style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(20.dp, 20.dp, 16.dp, 8.dp))
        }

        // 连接
        item { SectionHeader("影库连接") }
        item {
            Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                Column(modifier = Modifier.padding(16.dp)) {
                    OutlinedTextField(
                        value = vm.serverDraft, onValueChange = { vm.onServerDraft(it) },
                        label = { Text("服务器地址") },
                        placeholder = { Text("192.168.1.5 或 xxx.trycloudflare.com") },
                        singleLine = true, modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("主机状态：${vm.hostInfo}", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                        TextButton(onClick = { vm.refresh() }) { Text("检测") }
                    }
                    Button(onClick = { vm.saveServer() }, modifier = Modifier.fillMaxWidth()) {
                        Text("保存并重连")
                    }
                }
            }
        }
        item {
            ScanConnectButton(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                label = "扫码连接电脑"
            ) { raw -> DeepLinkBus.offer(raw) }
        }

        // 外观
        item { SectionHeader("外观主题") }
        item {
            Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                Column {
                    listOf("跟随系统" to 0, "午夜场（暗金）" to 1, "日场纸书（浅色）" to 2).forEach { (label, mode) ->
                        ListItem(
                            headlineContent = { Text(label) },
                            leadingContent = {
                                RadioButton(selected = vm.themeMode == mode, onClick = { vm.setTheme(mode) })
                            },
                            modifier = Modifier.clickable { vm.setTheme(mode) }
                        )
                    }
                }
            }
        }

        // TTS
        item { SectionHeader("语音朗读（TTS）") }
        item {
            Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                ListItem(
                    headlineContent = { Text("引擎状态") },
                    supportingContent = { Text(vm.ttsStatus) },
                    leadingContent = { Icon(Icons.Filled.RecordVoiceOver, contentDescription = null) }
                )
                HorizontalDivider()
                ListItem(
                    headlineContent = { Text("当前音色") },
                    supportingContent = { Text(vm.currentVoiceName) },
                    leadingContent = { Icon(Icons.Filled.Tune, contentDescription = null) }
                )
                // 音色直接列出来点选：选中即服务端热重载，不用重启也不用回电脑端
                vm.voices.forEach { v ->
                    ListItem(
                        headlineContent = { Text(v.name) },
                        supportingContent = { Text(v.group.ifBlank { "音色" }) },
                        leadingContent = {
                            RadioButton(selected = vm.currentVoiceId == v.id, onClick = { vm.selectVoice(v) })
                        },
                        modifier = Modifier.clickable(enabled = !vm.voiceBusy) { vm.selectVoice(v) }
                    )
                }
                if (vm.voices.isEmpty()) {
                    ListItem(
                        headlineContent = { Text("音色/引擎详细设置") },
                        supportingContent = { Text("在电脑端 Cinema Vault 设置中调整") }
                    )
                }
            }
        }

        // AI
        item { SectionHeader("AI 伴侣") }
        item {
            Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                ListItem(
                    headlineContent = { Text("当前模型") },
                    supportingContent = { Text(vm.aiModel.ifBlank { "未获取" }) },
                    leadingContent = { Icon(Icons.Filled.SmartToy, contentDescription = null) }
                )
                HorizontalDivider()
                ListItem(
                    headlineContent = { Text("人格与密钥") },
                    supportingContent = { Text("在电脑端设置，手机端自动同步") },
                    leadingContent = { Icon(Icons.Filled.Person, contentDescription = null) }
                )
            }
        }

        // 应用更新
        item { SectionHeader("应用更新") }
        item {
            Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                ListItem(
                    headlineContent = { Text("当前版本") },
                    supportingContent = { Text("v${updateVm.currentVersion} · 全 Compose 原生") },
                    leadingContent = { Icon(Icons.Filled.SystemUpdate, contentDescription = null) }
                )
                HorizontalDivider()
                ListItem(
                    headlineContent = { Text("检查更新") },
                    supportingContent = { Text("从电脑端获取最新安装包（需先连接影库）") },
                    leadingContent = { Icon(Icons.Filled.Refresh, contentDescription = null) },
                    trailingContent = { Icon(Icons.Filled.ChevronRight, contentDescription = null) },
                    modifier = Modifier.clickable { updateVm.check(manual = true) }
                )
                HorizontalDivider()
                ListItem(
                    headlineContent = { Text("自动检查") },
                    supportingContent = { Text("启动时每 24 小时检查一次，发现新版才提示") },
                    leadingContent = { Icon(Icons.Filled.Autorenew, contentDescription = null) },
                    trailingContent = {
                        Switch(
                            checked = autoCheck,
                            onCheckedChange = {
                                autoCheck = it
                                updateVm.autoCheckEnabled = it
                            }
                        )
                    }
                )
            }
        }

        // 关于
        item { SectionHeader("关于") }
        item {
            Card(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                ListItem(
                    headlineContent = { Text("Cinema Vault 安卓原生版") },
                    supportingContent = { Text("v${updateVm.currentVersion} · 全 Compose · 纯 API 客户端") },
                    leadingContent = { Icon(Icons.Filled.Info, contentDescription = null) }
                )
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(title, style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(20.dp, 20.dp, 16.dp, 4.dp))
}
