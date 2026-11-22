package cn.cinemavault.app.reading

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** 小说阅读设置面板（字段与 Web 端 reader-settings.js 对齐）。 */
@Composable
fun NovelSettingsSheet(settings: NovelSettings, onChange: (NovelSettings) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp)
            .padding(bottom = 28.dp)
    ) {
        Text("阅读设置", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(14.dp))

        SettingRow("翻页样式") {
            Chips(
                listOf(
                    TurnStyle.COVER to "覆盖",
                    TurnStyle.SLIDE to "平移",
                    TurnStyle.SCROLL to "滚动",
                    TurnStyle.NONE to "无动画"
                ),
                settings.turnStyle
            ) { onChange(settings.copy(turnStyle = it)) }
        }
        if (settings.turnStyle != TurnStyle.SCROLL && settings.turnStyle != TurnStyle.NONE) {
            SettingRow("翻页速度") {
                Chips(
                    listOf(900 to "慢", 560 to "标准", 320 to "快"),
                    settings.turnSpeedMs
                ) { onChange(settings.copy(turnSpeedMs = it)) }
            }
        }
        SettingRow("字号") {
            Chips(listOf(14 to "小", 18 to "中", 22 to "大", 26 to "特大"), settings.fontSize) {
                onChange(settings.copy(fontSize = it))
            }
        }
        SettingRow("行距") {
            Chips(listOf(1.5f to "紧凑", 1.8f to "标准", 2.2f to "宽松"), settings.lineHeight) {
                onChange(settings.copy(lineHeight = it))
            }
        }
        SettingRow("页边距") {
            Chips(listOf(10 to "窄", 20 to "标准", 30 to "宽"), settings.padding) {
                onChange(settings.copy(padding = it))
            }
        }
        SettingRow("页宽（每行字数）") {
            Chips(
                listOf(
                    NovelPageWidth.NARROW to "窄", NovelPageWidth.MEDIUM to "中",
                    NovelPageWidth.WIDE to "宽", NovelPageWidth.FULL to "全宽"
                ),
                settings.pageWidth
            ) { onChange(settings.copy(pageWidth = it)) }
        }
        SettingRow("字体") {
            Chips(
                listOf(NovelFont.SERIF to "宋体", NovelFont.SANS to "黑体", NovelFont.KAI to "楷体"),
                settings.font
            ) { onChange(settings.copy(font = it)) }
        }
        SettingRow("背景") {
            Swatches(
                listOf(
                    0xFFF5F0E6 to "纸黄",
                    0xFFFFFFFF to "纯白",
                    0xFFC7EDCC to "护眼绿",
                    0xFFE8E0D0 to "米色",
                    0xFF2A2A2A to "暗色"
                ),
                settings.background
            ) { onChange(settings.copy(background = it)) }
        }
        SettingRow("夜间模式") {
            Switch(checked = settings.night, onCheckedChange = { onChange(settings.copy(night = it)) })
        }
        SettingRow("自动翻页") {
            Chips(listOf(0 to "关", 5000 to "5 秒", 8000 to "8 秒", 12000 to "12 秒"), settings.autoTurnMs) {
                onChange(settings.copy(autoTurnMs = it))
            }
        }
    }
}

/** 漫画阅读设置面板。 */
@Composable
fun ComicSettingsSheet(settings: ComicSettings, onChange: (ComicSettings) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp)
            .padding(bottom = 28.dp)
    ) {
        Text("阅读设置", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(14.dp))

        SettingRow("阅读模式") {
            Chips(listOf(false to "翻页", true to "长条连续"), settings.continuous) {
                onChange(settings.copy(continuous = it))
            }
        }
        if (!settings.continuous) {
            SettingRow("排版") {
                Chips(listOf(ComicLayout.SINGLE to "单页", ComicLayout.DUAL to "双页"), settings.layout) {
                    onChange(settings.copy(layout = it))
                }
            }
            SettingRow("翻页样式") {
                Chips(listOf(TurnStyle.SLIDE to "平移", TurnStyle.COVER to "覆盖", TurnStyle.NONE to "无动画"), settings.turnStyle) {
                    onChange(settings.copy(turnStyle = it))
                }
            }
        }
        SettingRow("阅读方向") {
            Chips(listOf(false to "左翻（常规）", true to "右翻（日漫）"), settings.rtl) {
                onChange(settings.copy(rtl = it))
            }
        }
        if (!settings.continuous) {
            SettingRow("缩放默认值") {
                Chips(
                    listOf(ComicFit.CONTAIN to "适应屏幕", ComicFit.WIDTH to "适应宽度", ComicFit.NONE to "原尺寸"),
                    settings.fit
                ) { onChange(settings.copy(fit = it)) }
            }
        }
        SettingRow("背景") {
            Swatches(
                listOf(
                    0xFFFFFFFF to "纯白",
                    0xFFD8D4CC to "浅灰",
                    0xFF22222A to "深灰",
                    0xFF12100C to "观赏黑",
                    0xFF000000 to "纯黑"
                ),
                settings.background
            ) { onChange(settings.copy(background = it)) }
        }
        SettingRow("夜间模式") {
            Switch(checked = settings.night, onCheckedChange = { onChange(settings.copy(night = it)) })
        }
    }
}

@Composable
private fun SettingRow(title: String, content: @Composable () -> Unit) {
    Column(Modifier.padding(vertical = 8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(6.dp))
        content()
    }
}

@Composable
private fun <T> Chips(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        options.forEach { (value, label) ->
            FilterChip(
                selected = value == selected,
                onClick = { onSelect(value) },
                label = { Text(label) }
            )
        }
    }
}

@Composable
private fun Swatches(options: List<Pair<Long, String>>, selected: Long, onSelect: (Long) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        options.forEach { (value, label) ->
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(Color(value))
                        .border(
                            width = if (value == selected) 3.dp else 1.dp,
                            color = if (value == selected) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.outlineVariant,
                            shape = CircleShape
                        )
                        .clickable { onSelect(value) }
                )
                Spacer(Modifier.height(3.dp))
                Text(label, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}
