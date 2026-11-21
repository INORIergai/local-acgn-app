package cn.cinemavault.app.ui.screen

import androidx.compose.runtime.Composable
import cn.cinemavault.app.data.model.Movie

/** 根据书籍类型分发到漫画/小说阅读器。 */
@Composable
fun ReaderHost(book: Movie, onClose: () -> Unit) {
    if (book.type == "novel") {
        NovelReaderScreen(book, onClose)
    } else {
        ComicReaderScreen(book, onClose)
    }
}
