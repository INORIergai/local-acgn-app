package cn.cinemavault.app.ui.screen

import android.graphics.Color as AndroidColor
import android.view.GestureDetector
import android.view.MotionEvent
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig
import cn.cinemavault.app.data.prefs.ThemeStore
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * EPUB 富文本正文：保留段落、标题、表格与内嵌图片。
 * 旧版 Html.fromHtml().toString() 会把 <img> 变成 [OBJ]，并丢失扫描书的排版。
 * 服务端 HTML 已做白名单净化，这里关闭 JavaScript，只负责渲染。
 */
@Composable
fun RichNovelContent(
    html: String,
    textSize: Float,
    onTap: () -> Unit,
    onSwipe: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    val dark = ThemeStore.resolveDark(isSystemInDarkTheme())
    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = false       // 只渲染服务端净化 HTML，不执行书内脚本
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.builtInZoomControls = false
                setBackgroundColor(AndroidColor.TRANSPARENT)

                // WebView 的图片请求不走 OkHttp，开启访问密码时要把会话 Cookie 同步过来
                runCatching {
                    val url = ServerConfig.baseUrl.toHttpUrl()
                    val cookies = ApiClient.cookieJar.loadForRequest(url)
                    val cm = CookieManager.getInstance()
                    cookies.forEach { cm.setCookie(ServerConfig.baseUrl, "${it.name}=${it.value}") }
                    cm.flush()
                }

                val detector = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
                    override fun onDown(e: MotionEvent): Boolean = true
                    override fun onSingleTapUp(e: MotionEvent): Boolean {
                        onTap()
                        return false                       // 不吞掉 WebView 的选择/滚动行为
                    }
                    override fun onFling(
                        e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float
                    ): Boolean {
                        if (kotlin.math.abs(velocityX) > kotlin.math.abs(velocityY) * 1.4f &&
                            kotlin.math.abs(velocityX) > 700f
                        ) {
                            onSwipe(if (velocityX < 0) 1 else -1)
                        }
                        return false
                    }
                })
                setOnTouchListener { _, event ->
                    detector.onTouchEvent(event)
                    false
                }
            }
        },
        update = { view ->
            view.settings.textZoom = (textSize / 18f * 100).toInt().coerceIn(60, 220)
            val fg = if (dark) "#F5F1E8" else "#26211A"
            val bg = if (dark) "#101216" else "#F1EEE6"
            val link = if (dark) "#E0A83B" else "#9A6A15"
            // 样式只负责可读性；章节结构仍使用服务端返回的富文本
            val document = """<!doctype html><html><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
                <style>
                html,body{margin:0;padding:0;background:$bg;color:$fg}
                body{padding:20px 20px 72px;font-family:serif;font-size:18px;line-height:1.75;
                     word-break:break-word;overflow-wrap:anywhere}
                p{margin:0 0 1em;text-align:justify}
                h1,h2,h3,h4,h5,h6{line-height:1.4;margin:1.2em 0 .6em}
                img,svg,video{display:block;max-width:100%;height:auto;margin:12px auto}
                table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
                td,th{padding:4px 8px;border:1px solid $link}
                a{color:$link;text-decoration:none}
                blockquote{margin:1em 0;padding-left:1em;border-left:3px solid $link}
                pre{white-space:pre-wrap;word-break:break-word}
                </style></head><body>$html</body></html>"""
            view.loadDataWithBaseURL(
                ServerConfig.baseUrl, document, "text/html", "utf-8", null
            )
        }
    )
}