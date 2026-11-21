package cn.cinemavault.app.playback

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import android.R as AndroidR
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

/**
 * TTS 听书前台播放服务（锁屏/切后台不中断）。
 *
 * 通知栏带「停止」动作：锁屏也能停，这是旧版「停不下来」最主要的补救——
 * 以前只能靠 App 里那个按钮，而那个按钮的状态还可能和真实播放脱节。
 * 播放状态统一回写 TtsController，UI 不再各存一份。
 */
class TtsPlaybackService : Service() {

    private var player: ExoPlayer? = null
    private var urls: List<String> = emptyList()
    private var currentIndex = 0
    private var currentTitle = "TTS 听书"
    /** 已播完手上所有块、正在等 UI 继续投递后续块。 */
    private var waitingMore = false

    companion object {
        const val ACTION_PREPARE = "cn.cinemavault.tts.PREPARE"
        const val ACTION_PLAY = "cn.cinemavault.tts.PLAY"
        const val ACTION_APPEND = "cn.cinemavault.tts.APPEND"
        const val ACTION_STOP = "cn.cinemavault.tts.STOP"
        const val EXTRA_URLS = "urls"
        const val EXTRA_TITLE = "title"
        const val CHANNEL_ID = "cinemavault_tts"
        const val NOTIF_ID = 1001

        private fun send(context: Context, action: String, urls: List<String>?, title: String?) {
            val i = Intent(context, TtsPlaybackService::class.java).apply {
                this.action = action
                if (urls != null) putStringArrayListExtra(EXTRA_URLS, ArrayList(urls))
                if (title != null) putExtra(EXTRA_TITLE, title)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(i)
            } else context.startService(i)
        }

        /** 合成阶段先占位：通知栏立刻出现停止键。 */
        fun prepare(context: Context, title: String) = send(context, ACTION_PREPARE, null, title)

        fun start(context: Context, urls: List<String>, title: String) =
            send(context, ACTION_PLAY, urls, title)

        fun append(context: Context, urls: List<String>, title: String) =
            send(context, ACTION_APPEND, urls, title)

        /** 停服务即可，onDestroy 里会释放播放器、撤通知、回写状态。 */
        fun stop(context: Context) {
            context.stopService(Intent(context, TtsPlaybackService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIF_ID, buildNotification("TTS 听书准备中…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PREPARE -> {
                currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: currentTitle
                startForeground(NOTIF_ID, buildNotification("$currentTitle · 合成中"))
            }
            ACTION_PLAY -> {
                urls = intent.getStringArrayListExtra(EXTRA_URLS)?.toList() ?: emptyList()
                currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: currentTitle
                currentIndex = 0
                waitingMore = false
                playCurrent()
            }
            ACTION_APPEND -> {
                val more = intent.getStringArrayListExtra(EXTRA_URLS)?.toList() ?: emptyList()
                currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: currentTitle
                urls = urls + more
                // 播完手上的块在等后续，或者还没起播，就接着往下放
                if (waitingMore || player?.isPlaying != true) playCurrent()
                else startForeground(NOTIF_ID, buildNotification(progressText()))
            }
            ACTION_STOP -> {
                releasePlayer()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun progressText() = "$currentTitle · ${currentIndex + 1}/${urls.size}"

    private fun playCurrent() {
        if (currentIndex >= urls.size) {
            // 手上的块播完了，但后面还在合成：挂住等服务，别误停
            waitingMore = true
            startForeground(NOTIF_ID, buildNotification("$currentTitle · 等待后续音频"))
            return
        }
        waitingMore = false
        releasePlayer()
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(MediaSourceFactory.create())
            .build().apply {
                setMediaItem(MediaItem.fromUri(urls[currentIndex]))
                prepare()
                play()
                addListener(object : Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == Player.STATE_ENDED) {
                            currentIndex++
                            playCurrent()
                        }
                    }
                })
            }
        startForeground(NOTIF_ID, buildNotification(progressText()))
    }

    private fun releasePlayer() {
        player?.release()
        player = null
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "TTS 听书", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): android.app.Notification {
        // 通知栏「停止」：直接给服务发 ACTION_STOP，锁屏下同样有效
        val stopPi = PendingIntent.getService(
            this, 0,
            Intent(this, TtsPlaybackService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(AndroidR.drawable.ic_media_play)
            .setContentTitle("Cinema Vault 听书")
            .setContentText(text)
            .setOngoing(true)
            .addAction(AndroidR.drawable.ic_media_pause, "停止", stopPi)
            .build()
    }

    override fun onDestroy() {
        releasePlayer()
        stopForeground(STOP_FOREGROUND_REMOVE)
        // 不管怎么结束的（播完/通知停止/系统回收），都让 UI 回到「未播放」
        TtsController.onServiceStopped()
        super.onDestroy()
    }
}