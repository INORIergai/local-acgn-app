package cn.cinemavault.app.reading

import android.content.Context
import android.content.SharedPreferences

enum class TurnStyle { COVER, SLIDE, SCROLL, NONE }
enum class NovelFont { SERIF, SANS, KAI }
/** 页宽（每行字数）：与 Web 端 reader-settings.js 的 pageWidth 对齐 */
enum class NovelPageWidth { NARROW, MEDIUM, WIDE, FULL }
enum class ComicLayout { SINGLE, DUAL }
enum class ComicFit { CONTAIN, WIDTH, NONE }

data class NovelSettings(
    val fontSize: Int = 18,
    val lineHeight: Float = 1.8f,
    val padding: Int = 20,
    val pageWidth: NovelPageWidth = NovelPageWidth.MEDIUM,
    val font: NovelFont = NovelFont.SERIF,
    val background: Long = 0xFFF5F0E6,
    val night: Boolean = false,
    val turnStyle: TurnStyle = TurnStyle.SLIDE,
    val turnSpeedMs: Int = 560,
    val autoTurnMs: Int = 0
)

data class ComicSettings(
    val layout: ComicLayout = ComicLayout.SINGLE,
    val rtl: Boolean = false,
    val fit: ComicFit = ComicFit.CONTAIN,
    val background: Long = 0xFF12100C,
    val night: Boolean = false,
    val turnStyle: TurnStyle = TurnStyle.SLIDE,
    val continuous: Boolean = false
)

/**
 * 阅读设置持久化。字段与 Web 端 public/js/reader-settings.js 的 SCHEMA 对齐，
 * 保证电脑和手机对「翻页样式 / 字号 / 行距 / 背景」的叫法与取值一致。
 */
object ReaderSettingsStore {
    private const val PREFS = "CinemaVaultReader"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun loadNovel(ctx: Context): NovelSettings {
        val p = prefs(ctx)
        return NovelSettings(
            fontSize = p.getInt("novel_font_size", 18),
            lineHeight = p.getFloat("novel_line_height", 1.8f),
            padding = p.getInt("novel_padding", 20),
            pageWidth = runCatching { NovelPageWidth.valueOf(p.getString("novel_page_width", "MEDIUM")!!) }
                .getOrDefault(NovelPageWidth.MEDIUM),
            font = runCatching { NovelFont.valueOf(p.getString("novel_font", "SERIF")!!) }
                .getOrDefault(NovelFont.SERIF),
            background = p.getLong("novel_bg", 0xFFF5F0E6),
            night = p.getBoolean("novel_night", false),
            turnStyle = runCatching { TurnStyle.valueOf(p.getString("novel_turn", "SLIDE")!!) }
                .getOrDefault(TurnStyle.SLIDE),
            turnSpeedMs = p.getInt("novel_turn_speed", 560),
            autoTurnMs = p.getInt("novel_auto_turn", 0)
        )
    }

    fun saveNovel(ctx: Context, s: NovelSettings) {
        prefs(ctx).edit()
            .putInt("novel_font_size", s.fontSize)
            .putFloat("novel_line_height", s.lineHeight)
            .putInt("novel_padding", s.padding)
            .putString("novel_page_width", s.pageWidth.name)
            .putString("novel_font", s.font.name)
            .putLong("novel_bg", s.background)
            .putBoolean("novel_night", s.night)
            .putString("novel_turn", s.turnStyle.name)
            .putInt("novel_turn_speed", s.turnSpeedMs)
            .putInt("novel_auto_turn", s.autoTurnMs)
            .apply()
    }

    fun loadComic(ctx: Context): ComicSettings {
        val p = prefs(ctx)
        return ComicSettings(
            layout = runCatching { ComicLayout.valueOf(p.getString("comic_layout", "SINGLE")!!) }
                .getOrDefault(ComicLayout.SINGLE),
            rtl = p.getBoolean("comic_rtl", false),
            fit = runCatching { ComicFit.valueOf(p.getString("comic_fit", "CONTAIN")!!) }
                .getOrDefault(ComicFit.CONTAIN),
            background = p.getLong("comic_bg", 0xFF12100C),
            night = p.getBoolean("comic_night", false),
            turnStyle = runCatching { TurnStyle.valueOf(p.getString("comic_turn", "SLIDE")!!) }
                .getOrDefault(TurnStyle.SLIDE),
            continuous = p.getBoolean("comic_continuous", false)
        )
    }

    fun saveComic(ctx: Context, s: ComicSettings) {
        prefs(ctx).edit()
            .putString("comic_layout", s.layout.name)
            .putBoolean("comic_rtl", s.rtl)
            .putString("comic_fit", s.fit.name)
            .putLong("comic_bg", s.background)
            .putBoolean("comic_night", s.night)
            .putString("comic_turn", s.turnStyle.name)
            .putBoolean("comic_continuous", s.continuous)
            .apply()
    }
}
