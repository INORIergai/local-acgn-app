package cn.cinemavault.app

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import coil.ImageLoader
import coil.compose.LocalImageLoader
import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.prefs.ThemeStore
import cn.cinemavault.app.ui.theme.CinemaVaultTheme
import cn.cinemavault.app.ui.screen.CinemaVaultApp

/**
 * 全 Compose 原生入口（v5.0.0 起）。
 * 旧 MainActivity（WebView 套壳）保留但不再作为 launcher。
 */
class NativeActivity : ComponentActivity() {

    private lateinit var imageLoader: ImageLoader

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        FullScreenController.bind(window)
        // 图片加载走带 lml_session Cookie 的 OkHttp（海报/漫画页需鉴权）
        imageLoader = ImageLoader.Builder(this)
            .okHttpClient { ApiClient.client }
            .build()
        setContent {
            // 主题跟随 ThemeStore：设置页改动后立刻重组生效，冷启动从持久化读回
            val dark = ThemeStore.resolveDark(androidx.compose.foundation.isSystemInDarkTheme())
            CinemaVaultTheme(darkTheme = dark) {
                androidx.compose.runtime.CompositionLocalProvider(LocalImageLoader provides imageLoader) {
                    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        CinemaVaultApp()
                    }
                }
            }
        }
    }

    /** 音量键：阅读器打开时转发为翻页（DOWN=下一页、UP=上一页），否则交系统。 */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_VOLUME_DOWN -> if (ReaderKeyBus.dispatch(1)) return true
                KeyEvent.KEYCODE_VOLUME_UP -> if (ReaderKeyBus.dispatch(-1)) return true
            }
        }
        return super.dispatchKeyEvent(event)
    }
}
