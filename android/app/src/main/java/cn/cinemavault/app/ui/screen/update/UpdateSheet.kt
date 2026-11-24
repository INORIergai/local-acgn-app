package cn.cinemavault.app.ui.screen.update

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.cinemavault.app.data.repo.AppUpdateInfo

/**
 * 应用更新底部面板：检查中 / 有新版本 / 下载 / 校验 / 安装。
 * 只有手动检查或发现新版本时才出现；静默检查失败不打扰用户。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UpdateSheet(vm: UpdateViewModel) {
    val s = vm.state.collectAsState().value
    if (s is UpdateUiState.Idle) return

    ModalBottomSheet(
        onDismissRequest = { vm.dismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .align(Alignment.CenterHorizontally)
                .padding(horizontal = 24.dp)
                .padding(bottom = 28.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.SystemUpdate, contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(10.dp))
                Text("应用更新", style = MaterialTheme.typography.titleLarge)
            }
            Spacer(Modifier.height(16.dp))

            when (s) {
                is UpdateUiState.Checking -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(12.dp))
                        Text("正在检查更新…")
                    }
                }

                is UpdateUiState.Available -> {
                    AvailableBody(s.info)
                    Spacer(Modifier.height(20.dp))
                    Button(onClick = { vm.download() }, modifier = Modifier.fillMaxWidth()) {
                        Text("立即更新")
                    }
                    TextButton(onClick = { vm.dismiss() }, modifier = Modifier.fillMaxWidth()) {
                        Text("稍后")
                    }
                    TextButton(onClick = { vm.ignoreThisVersion() }, modifier = Modifier.fillMaxWidth()) {
                        Text("忽略此版本", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                is UpdateUiState.Downloading -> {
                    DownloadingBody(s)
                    Spacer(Modifier.height(16.dp))
                    TextButton(onClick = { vm.dismiss() }, modifier = Modifier.fillMaxWidth()) {
                        Text("取消下载")
                    }
                }

                is UpdateUiState.Verifying -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(12.dp))
                        Text("正在校验 SHA-256 与签名证书…")
                    }
                    Spacer(Modifier.height(16.dp))
                    TextButton(onClick = { vm.dismiss() }, modifier = Modifier.fillMaxWidth()) {
                        Text("取消")
                    }
                }

                is UpdateUiState.Ready -> {
                    AvailableBody(s.info)
                    Spacer(Modifier.height(8.dp))
                    Text("安装包已通过 SHA-256 与签名校验",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { vm.install() }, modifier = Modifier.fillMaxWidth()) {
                        Text("安装")
                    }
                    TextButton(onClick = { vm.dismiss() }, modifier = Modifier.fillMaxWidth()) {
                        Text("稍后")
                    }
                }

                is UpdateUiState.NeedsPermission -> {
                    AvailableBody(s.info)
                    Spacer(Modifier.height(10.dp))
                    Text("需要允许本应用安装未知来源应用，授权后返回点「继续安装」。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { vm.openInstallPermissionSettings() },
                        modifier = Modifier.fillMaxWidth()) {
                        Text("去授予权限")
                    }
                    OutlinedButton(onClick = { vm.install() }, modifier = Modifier.fillMaxWidth()) {
                        Text("继续安装")
                    }
                    TextButton(onClick = { vm.dismiss() }, modifier = Modifier.fillMaxWidth()) {
                        Text("稍后")
                    }
                }

                is UpdateUiState.Message -> {
                    Text(s.title, style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(8.dp))
                    Text(s.text, style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.verticalScroll(rememberScrollState()))
                    Spacer(Modifier.height(18.dp))
                    if (s.title.contains("失败") || s.title.contains("暂无")) {
                        Button(onClick = { vm.check(manual = true) }, modifier = Modifier.fillMaxWidth()) {
                            Text("重新检查")
                        }
                    }
                    TextButton(onClick = { vm.dismiss() }, modifier = Modifier.fillMaxWidth()) {
                        Text("关闭")
                    }
                }

                UpdateUiState.Idle -> Unit
            }
        }
    }
}

@Composable
private fun AvailableBody(info: AppUpdateInfo) {
    Text("发现新版本 v${info.versionName}", style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold)
    Spacer(Modifier.height(6.dp))
    Text("当前 v${cn.cinemavault.app.BuildConfig.VERSION_NAME} · 新包 ${humanSize(info.apkSize)}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (info.changelog.isNotBlank()) {
        Spacer(Modifier.height(14.dp))
        Text("更新说明", style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(6.dp))
        Text(
            info.changelog,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier
                .heightIn(max = 180.dp)
                .verticalScroll(rememberScrollState())
        )
    }
}

@Composable
private fun DownloadingBody(state: UpdateUiState.Downloading) {
    val total = if (state.total > 0) state.total else state.info.apkSize
    val fraction = if (total > 0) (state.downloaded.toFloat() / total).coerceIn(0f, 1f) else 0f
    Text("正在下载 v${state.info.versionName}", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(12.dp))
    LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
    Spacer(Modifier.height(8.dp))
    Text(
        "${(fraction * 100).toInt()}% · ${humanSize(state.downloaded)} / ${humanSize(total)}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    Spacer(Modifier.height(6.dp))
    Text("断线后重新点「立即更新」会从断点续传。",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private fun humanSize(bytes: Long): String {
    if (bytes <= 0) return "未知"
    val mb = bytes / 1024.0 / 1024.0
    return if (mb >= 1) "%.1f MB".format(mb) else "${bytes / 1024} KB"
}
