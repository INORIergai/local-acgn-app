package cn.cinemavault.app.ui.scan

import android.Manifest
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * 「扫码连接电脑」按钮：运行时申请相机权限 → zxing 扫码 → 把原始文本交给 onScanned。
 * 故意不使用 Google Play Services 的 ML Kit：华为等无 GMS 设备也能扫。
 */
@Composable
fun ScanConnectButton(
    modifier: Modifier = Modifier,
    label: String = "扫码连接电脑",
    onScanned: (String) -> Unit
) {
    val context = LocalContext.current
    val options = remember {
        ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("扫描电脑上的配对二维码")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
            .setBarcodeImageEnabled(false)
    }
    val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
        val text = result.contents
        if (!text.isNullOrBlank()) onScanned(text)
    }
    val permission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            scanner.launch(options)
        } else {
            Toast.makeText(context, "未授予相机权限，可改用手动输入地址", Toast.LENGTH_LONG).show()
        }
    }

    Button(
        onClick = {
            val ok = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
            if (ok) scanner.launch(options) else permission.launch(Manifest.permission.CAMERA)
        },
        modifier = modifier.height(52.dp)
    ) {
        Icon(Icons.Filled.QrCodeScanner, contentDescription = null)
        Spacer(Modifier.width(8.dp))
        Text(label)
    }
}
