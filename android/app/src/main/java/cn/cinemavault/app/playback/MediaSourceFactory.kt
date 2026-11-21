package cn.cinemavault.app.playback

import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import cn.cinemavault.app.data.api.ApiClient

/**
 * 播放用 MediaSource 工厂 —— 复用 ApiClient.client（带 lml_session Cookie + 持久化）。
 * 视频串流 / TTS 音频 / HLS 分片都走这个工厂，Range 由 OkHttpDataSource 自动处理。
 */
object MediaSourceFactory {
    fun create(): DefaultMediaSourceFactory {
        val ds = OkHttpDataSource.Factory(ApiClient.client)
            .setUserAgent("CinemaVault-Android")
        return DefaultMediaSourceFactory(ds)
    }
}
