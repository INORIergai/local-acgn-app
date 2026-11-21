package cn.cinemavault.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// ── 午夜场（暗金，默认深色）──
private val MidnightGold = darkColorScheme(
    primary = Color(0xFFE0A83B),          // 暗金主色
    onPrimary = Color(0xFF1A1408),
    primaryContainer = Color(0xFF5C4315),
    onPrimaryContainer = Color(0xFFFFDFA0),
    secondary = Color(0xFFC9A227),
    onSecondary = Color(0xFF1A1408),
    surface = Color(0xFF14161C),           // 深墨底
    onSurface = Color(0xFFF5F1E8),
    surfaceVariant = Color(0xFF1E2129),
    onSurfaceVariant = Color(0xFFB8B2A6),
    outline = Color(0xFF3A3E48),
    background = Color(0xFF101216),
    onBackground = Color(0xFFF5F1E8),
    error = Color(0xFFCF6679)
)

// ── 日场纸书（浅色，复刻 PC EXE 经典纸底）──
private val MatineePaper = lightColorScheme(
    primary = Color(0xFF9A6A15),           // 钨丝琥珀金
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFF0DDB0),
    onPrimaryContainer = Color(0xFF3A2805),
    secondary = Color(0xFF7C7466),
    onSecondary = Color(0xFFFFFFFF),
    surface = Color(0xFFFAF8F1),           // 纸张浮层
    onSurface = Color(0xFF26211A),         // 古雅油墨黑
    surfaceVariant = Color(0xFFF1EEE6),
    onSurfaceVariant = Color(0xFF6B6157),
    outline = Color(0xFFDCD5C7),           // 纸切边
    background = Color(0xFFF1EEE6),
    onBackground = Color(0xFF26211A),
    error = Color(0xFFB3261E)
)

@Composable
fun CinemaVaultTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    // 默认跟随系统；后续接入 SettingsStore 持久化四皮肤（纸/夜/鲸/墨）
    val colorScheme = if (darkTheme) MidnightGold else MatineePaper
    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
