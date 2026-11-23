package cn.cinemavault.app.reading

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Constraints

/** 一页在整章原文里的字符区间 [start, end)。 */
data class PageSlice(val start: Int, val end: Int)

/**
 * 按「行高 + 视口高度」贪心分页。
 *
 * 关键约束（Web 端踩过的坑）：
 *  - 分页源必须是完整原文，不能拿已切片的页面再切；
 *  - 一次测量整章，按 TextLayoutResult 的真实行高切，不按字数估算；
 *  - 页边界用 getLineEnd(visibleEnd=false)，把换行留给上一页，下一页从新段开始。
 */
object NovelPaginator {

    fun paginate(
        text: String,
        measurer: TextMeasurer,
        style: TextStyle,
        maxWidthPx: Int,
        maxHeightPx: Int
    ): List<PageSlice> {
        if (text.isEmpty()) return listOf(PageSlice(0, 0))
        if (maxWidthPx <= 0 || maxHeightPx <= 0) return listOf(PageSlice(0, text.length))

        val layout = measurer.measure(
            text = AnnotatedString(text),
            style = style,
            softWrap = true,
            constraints = Constraints(maxWidth = maxWidthPx)
        )
        if (layout.lineCount <= 0) return listOf(PageSlice(0, text.length))

        val pages = ArrayList<PageSlice>(layout.lineCount / 20 + 1)
        var line = 0
        while (line < layout.lineCount) {
            val top = layout.getLineTop(line)
            var last = line
            while (last + 1 < layout.lineCount &&
                layout.getLineBottom(last + 1) - top <= maxHeightPx
            ) {
                last++
            }
            val start = layout.getLineStart(line)
            var end = layout.getLineEnd(last, visibleEnd = false)
            if (end <= start) end = (start + 1).coerceAtMost(text.length)
            if (pages.isNotEmpty() && start <= pages.last().start) {
                // 防御：布局异常时至少前进一行，避免死循环
                end = (pages.last().end + 1).coerceAtMost(text.length)
            }
            pages.add(PageSlice(start, end))
            line = last + 1
        }
        return if (pages.isEmpty()) listOf(PageSlice(0, text.length)) else pages
    }

    /** 给定字符偏移，找它落在哪一页。 */
    fun pageOf(pages: List<PageSlice>, position: Int): Int {
        if (pages.isEmpty()) return 0
        val pos = position.coerceAtLeast(0)
        val idx = pages.indexOfFirst { pos < it.end }
        return if (idx >= 0) idx else pages.lastIndex
    }
}
