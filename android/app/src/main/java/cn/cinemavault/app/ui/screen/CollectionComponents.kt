package cn.cinemavault.app.ui.screen

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** 页面宽度决定网格密度，避免平板仍被压成两张大卡。 */
fun collectionColumns(width: Dp): Int = when {
    width < 360.dp -> 2
    width < 600.dp -> 3
    width < 900.dp -> 4
    width < 1200.dp -> 5
    else -> 6
}

@Composable
fun CollectionState(
    message: String,
    modifier: Modifier = Modifier,
    retryLabel: String? = null,
    onRetry: (() -> Unit)? = null
) {
    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        if (retryLabel != null && onRetry != null) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = onRetry) { Text(retryLabel) }
        }
    }
}
