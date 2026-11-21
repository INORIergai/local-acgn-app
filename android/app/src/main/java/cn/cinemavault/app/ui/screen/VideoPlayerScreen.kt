package cn.cinemavault.app.ui.screen

import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import cn.cinemavault.app.data.api.ServerConfig
import cn.cinemavault.app.playback.MediaSourceFactory
import java.net.URLEncoder

/**
 * 原生视频播放器（看番/影片通用）。
 * @param filePath 服务端 filePath（串流 path 源）
 * @param title 标题
 * @param startPositionMs 续播起点
 */
@Composable
fun VideoPlayerScreen(
    filePath: String,
    title: String,
    startPositionMs: Long = 0L,
    directUrl: String = "",
    onClose: () -> Unit
) {
    val context = LocalContext.current
    BackHandler { onClose() }

    var error by remember { mutableStateOf<String?>(null) }
    var playerRef by remember { mutableStateOf<ExoPlayer?>(null) }
    // 控制条可见性：标题条跟随控制器一起淡出（bug1：全屏后标题一直挂着）
    var controlsVisible by remember { mutableStateOf(true) }

    DisposableEffect(filePath, directUrl) {
        // 有直链（在线源）直接用；否则拼本地串流 URL
        var url = if (directUrl.isNotBlank()) directUrl
                  else ServerConfig.api("/api/movie/stream?path=" + URLEncoder.encode(filePath, "UTF-8"))
        val canTranscode = directUrl.isBlank()
        var triedTranscode = false

        val player = ExoPlayer.Builder(context)
            .setMediaSourceFactory(MediaSourceFactory.create())
            .build()
        playerRef = player

        fun play(u: String) {
            player.setMediaItem(MediaItem.fromUri(u))
            if (startPositionMs > 0) player.seekTo(startPositionMs)
            player.prepare()
            player.play()
        }
        play(url)

        player.addListener(object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                val msg = e.message.orEmpty()
                val hevc = msg.contains("hevc", true) || msg.contains("VID_DEC_ERR", true) ||
                    e.errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED
                if (hevc && canTranscode && !triedTranscode) {
                    // HEVC 降级：追加 transcode=1 重建
                    triedTranscode = true
                    url += "&transcode=1"
                    player.seekTo(0)
                    play(url)
                } else {
                    error = "播放失败：${e.errorCode} ${msg.take(80)}"
                }
            }
        })

        onDispose {
            player.release()
            playerRef = null
        }
    }

    // 真机实测：PlayerView 的 ControllerVisibilityListener 没有按预期回调，
    // 标题条在控制条隐去后仍挂着。改为「触摸即显示，3 秒无操作自动隐藏」，
    // 不再把标题可见性绑死在播放器内部回调上。
    LaunchedEffect(controlsVisible) {
        if (controlsVisible) {
            kotlinx.coroutines.delay(3000)
            controlsVisible = false
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    useController = true
                    controllerShowTimeoutMs = 3000
                    // 任意触摸都重新亮出标题条；返回 false 不拦截 PlayerView 自己的控制手势
                    setOnTouchListener { _, _ ->
                        controlsVisible = true
                        false
                    }
                }
            },
            modifier = Modifier.fillMaxSize()
        ) { view ->
            playerRef?.let { view.player = it }
        }

        // 顶部返回 + 标题：跟随播放控制器淡出/淡入（bug1）
        AnimatedVisibility(
            visible = controlsVisible,
            enter = fadeIn(), exit = fadeOut(),
            modifier = Modifier.align(Alignment.TopStart)
        ) {
            Row(modifier = Modifier.fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.55f)).padding(8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = "返回", tint = Color.White)
                }
                Text(title, color = Color.White, maxLines = 1,
                    modifier = Modifier.weight(1f))
            }
        }

        error?.let {
            Text(it, color = Color.White, modifier = Modifier.align(Alignment.Center))
        }
    }
}
