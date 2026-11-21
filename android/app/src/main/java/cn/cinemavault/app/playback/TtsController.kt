package cn.cinemavault.app.playback

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import cn.cinemavault.app.data.repo.TtsRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * 听书总控：UI 与 Service 之间唯一的状态源。
 *
 * 修的是「点了播放停不下来」的三条根因：
 * 1) 旧版播放状态只存在 NovelReaderScreen 的局部 Compose state 里，页面一重组/离开就和服务脱节；
 *    现在状态在这里，UI 只读不写，服务结束也会回写。
 * 2) 旧版停止只发 ACTION_STOP，后台还在把剩余几十块文本逐块合成完（每块约 20~40 秒），
 *    期间用户看到的就是「还在播/还在转」。现在停止会 cancel 掉合成协程。
 * 3) 旧版要等全部块合成完才一次性 append，且只在最后判断一次是否已停止。
 *    现在逐块合成、逐块投递，每块前后都检查协程是否还活着。
 */
object TtsController {

    enum class State { IDLE, PREPARING, PLAYING }

    var state by mutableStateOf(State.IDLE)
        private set
    var statusText by mutableStateOf("")
        private set
    var title by mutableStateOf("")
        private set

    private var job: Job? = null
    private val repo = TtsRepository()

    val isActive: Boolean get() = state != State.IDLE

    /** 开始听书：先起占位前台服务（通知里就有停止键），再逐块合成逐块投递。 */
    fun start(scope: CoroutineScope, context: Context, bookId: Long, bookTitle: String, chapter: Int) {
        if (state != State.IDLE) return
        val appCtx = context.applicationContext
        job?.cancel()
        title = bookTitle
        state = State.PREPARING
        statusText = "准备合成…"
        // 先占位：合成阶段通知栏就有停止按钮，锁屏也能停
        TtsPlaybackService.prepare(appCtx, bookTitle)

        job = scope.launch {
            try {
                val (_, text) = repo.chapterText(bookId, chapter)
                if (text.isBlank()) {
                    statusText = "本章没有可朗读的文字"
                    stop(appCtx)
                    return@launch
                }
                val chunks = repo.split(text).take(40)
                var started = false
                chunks.forEachIndexed { i, chunk ->
                    ensureActive()                       // 停止后不再发起新的合成请求
                    statusText = "合成 ${i + 1}/${chunks.size}"
                    val url = repo.synthesize(chunk)
                    ensureActive()                       // 这一块在途时点了停止，也不再投递
                    if (url != null) {
                        if (!started) {
                            TtsPlaybackService.start(appCtx, listOf(url), bookTitle)
                            started = true
                            state = State.PLAYING
                        } else {
                            TtsPlaybackService.append(appCtx, listOf(url), bookTitle)
                        }
                        statusText = "播放中 · 已就绪 ${i + 1}/${chunks.size}"
                    }
                }
                if (!started) {
                    statusText = "合成失败，请检查电脑端语音引擎"
                    stop(appCtx)
                }
            } catch (ce: CancellationException) {
                throw ce                                  // 正常取消，不当错误处理
            } catch (e: Exception) {
                statusText = "听书失败：${e.message?.take(40)}"
                stop(appCtx)
            }
        }
    }

    /** 停止：先砍合成协程，再停服务，状态立即归零。 */
    fun stop(context: Context) {
        job?.cancel()
        job = null
        state = State.IDLE
        statusText = ""
        title = ""
        TtsPlaybackService.stop(context.applicationContext)
    }

    /** 服务自己结束时（播完/被系统回收/通知栏停止）回调，保证 UI 不卡在「播放中」。 */
    fun onServiceStopped() {
        state = State.IDLE
        statusText = ""
    }
}