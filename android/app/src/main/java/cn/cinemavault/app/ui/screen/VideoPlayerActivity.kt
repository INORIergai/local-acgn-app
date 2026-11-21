package cn.cinemavault.app.ui.screen

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import cn.cinemavault.app.data.prefs.ThemeStore
import cn.cinemavault.app.ui.theme.CinemaVaultTheme

/**
 * 独立全屏视频播放 Activity（横屏沉浸，无底部导航）。
 * bug3 修复：横过来自动全屏、隐藏系统栏与功能按钮。
 */
class VideoPlayerActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val filePath = intent.getStringExtra(EXTRA_PATH).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        val directUrl = intent.getStringExtra(EXTRA_DIRECT_URL).orEmpty()

        // 进入即请求横屏（跟随传感器），横过来就是全屏
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

        // 沉浸式：隐藏状态栏/导航栏
        hideSystemBars()

        setContent {
            // 播放器也跟随同一套主题偏好
            val dark = ThemeStore.resolveDark(androidx.compose.foundation.isSystemInDarkTheme())
            CinemaVaultTheme(darkTheme = dark) {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    VideoPlayerScreen(filePath = filePath, title = title, directUrl = directUrl,
                        onClose = { finish() })
                }
            }
        }
    }

    private fun hideSystemBars() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    companion object {
        const val EXTRA_PATH = "path"
        const val EXTRA_TITLE = "title"
        const val EXTRA_DIRECT_URL = "directUrl"

        fun start(context: Context, filePath: String, title: String) {
            val i = Intent(context, VideoPlayerActivity::class.java).apply {
                putExtra(EXTRA_PATH, filePath)
                putExtra(EXTRA_TITLE, title)
            }
            context.startActivity(i)
        }

        /** 在线源直链播放（在线追番）。 */
        fun startDirect(context: Context, url: String, title: String) {
            val i = Intent(context, VideoPlayerActivity::class.java).apply {
                putExtra(EXTRA_DIRECT_URL, url)
                putExtra(EXTRA_TITLE, title)
            }
            context.startActivity(i)
        }
    }
}
