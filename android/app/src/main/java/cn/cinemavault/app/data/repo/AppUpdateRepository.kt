package cn.cinemavault.app.data.repo

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import cn.cinemavault.app.BuildConfig
import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** 服务端 /api/app/android-version 返回的可用更新。 */
data class AppUpdateInfo(
    val versionName: String,
    val versionCode: Int,
    val apkUrl: String,
    val apkUrls: List<String> = listOf(apkUrl),   // 多源回退：公网镜像候选（含原站兜底）
    val apkSize: Long,
    val apkSha256: String,
    val minSdk: Int?,
    val changelog: String,
    val publishedAt: String?
)

sealed interface UpdateCheck {
    data class Available(val info: AppUpdateInfo) : UpdateCheck
    data object UpToDate : UpdateCheck
    data class Unavailable(val reason: String) : UpdateCheck
    data class Failed(val message: String) : UpdateCheck
}

/**
 * 安卓应用内更新：检查 → 断点续传 → SHA-256 → 签名证书 → versionCode 三重校验 → 安装。
 *
 * 信任根是本机已安装包的签名证书，不是服务端：即使 PC 被换包，签名不一致也装不上。
 * 服务端只负责给出「固定别名 APK 的 SHA-256」，哈希不符同样拒绝。
 */
class AppUpdateRepository(private val context: Context) {

    /** 公网版本源候选 URL：原站 + 国内镜像前缀。只接受 https，杜绝明文下载被篡改。 */
    private fun publicUrlCandidates(rawUrl: String): List<String> {
        val out = mutableListOf<String>()
        if (rawUrl.startsWith("https://")) out.add(rawUrl)
        for (m in BuildConfig.PUBLIC_MIRRORS.split(',').map { it.trim() }.filter { it.startsWith("https://") }) {
            val prefix = m.trimEnd('/')
            val target = if (rawUrl.startsWith("https://")) rawUrl.removePrefix("https://") else rawUrl
            out.add("$prefix/https://$target")
        }
        return out.distinct()
    }

    private fun httpGetJson(url: String): JSONObject? {
        val req = Request.Builder().url(url).header("Accept", "application/json").build()
        ApiClient.client.newCall(req).execute().use { resp ->
            if (resp.code != 200) return null
            val body = resp.body?.string() ?: return null
            return runCatching { JSONObject(body) }.getOrNull()
        }
    }

    /** 脱离 PC 的公网更新检查：从国内镜像拉版本 JSON，核验后给出可用更新。 */
    private suspend fun checkPublic(): UpdateCheck {
        val jsonUrl = BuildConfig.PUBLIC_VERSION_JSON
        val base = runCatching {
            publicUrlCandidates(jsonUrl).firstOrNull { httpGetJson(it) != null }?.let { httpGetJson(it) }
        }.getOrNull() ?: return UpdateCheck.Failed("无法连接更新服务器，请检查网络或先连接电脑")

        val versionCode = base.optInt("versionCode", 0)
        if (versionCode <= BuildConfig.VERSION_CODE) return UpdateCheck.UpToDate
        val versionName = base.optString("versionName", "")
        val sha = base.optString("apkSha256", "").lowercase()
        val size = base.optLong("apkSize", 0L)
        val apkName = base.optString("apkFileName", "")
        val minSdk = base.optInt("minSdk", 0).takeIf { it > 0 }
        if (!Regex("^[a-f0-9]{64}$").matches(sha) || size <= 0L || apkName.isBlank()) {
            return UpdateCheck.Unavailable("公网版本信息缺少 SHA-256/体积/文件名，已拒绝")
        }
        if (minSdk != null && minSdk > Build.VERSION.SDK_INT) {
            return UpdateCheck.Unavailable("新版本要求 Android ${minSdk}+，当前系统过低")
        }
        // APK 直链：优先国内镜像，下载时逐个尝试；哈希来自版本 JSON、签名比对在本机，双重保障
        val official = "https://github.com/${BuildConfig.PUBLIC_REPO}/releases/download/" +
            "android-v$versionName/$apkName"
        val apkUrls = publicUrlCandidates(official).ifEmpty { listOf(official) }
        return UpdateCheck.Available(
            AppUpdateInfo(
                versionName = versionName,
                versionCode = versionCode,
                apkUrl = apkUrls.first(),
                apkUrls = apkUrls,
                apkSize = size,
                apkSha256 = sha,
                minSdk = minSdk,
                changelog = base.optString("changelog", ""),
                publishedAt = null,
            )
        )
    }

    suspend fun check(): UpdateCheck = withContext(Dispatchers.IO) {
        // 未连 PC 时走公网版本源（国内镜像），实现脱离电脑也能更新
        if (!ServerConfig.isConfigured) {
            return@withContext checkPublic()
        }
        try {
            val root = ApiClient.get("/api/app/android-version")
            if (!root.optBoolean("success", false)) {
                return@withContext UpdateCheck.Failed(root.optString("error", "版本接口异常"))
            }
            val versionCode = root.optInt("versionCode", 0)
            if (versionCode <= BuildConfig.VERSION_CODE) {
                return@withContext UpdateCheck.UpToDate
            }
            val versionName = root.optString("version", "")
            val apkAvailable = root.optBoolean("apkAvailable", false)
            val apkExact = root.optBoolean("apkExact", false)
            val apkSha256 = root.optString("apkSha256", "").lowercase()
            val apkSize = root.optLong("apkSize", 0L)
            val apkPath = root.optString("apkUrl", "")
            val minSdk = root.optInt("minSdk", 0).takeIf { it > 0 }

            if (!apkAvailable || !apkExact || apkPath.isBlank()) {
                return@withContext UpdateCheck.Unavailable(
                    root.optString("error", "电脑上还没有可用的 v$versionName 安装包")
                )
            }
            if (!Regex("^[a-f0-9]{64}$").matches(apkSha256) || apkSize <= 0L) {
                return@withContext UpdateCheck.Unavailable("安装包缺少 SHA-256/体积信息，已拒绝")
            }
            if (minSdk != null && minSdk > Build.VERSION.SDK_INT) {
                return@withContext UpdateCheck.Unavailable("新版本要求 Android ${minSdk}+，当前系统过低")
            }
            val url = if (apkPath.startsWith("http://") || apkPath.startsWith("https://")) {
                apkPath
            } else {
                ServerConfig.api(apkPath)
            }
            UpdateCheck.Available(
                AppUpdateInfo(
                    versionName = versionName,
                    versionCode = versionCode,
                    apkUrl = url,
                    apkSize = apkSize,
                    apkSha256 = apkSha256,
                    minSdk = minSdk,
                    changelog = root.optString("changelog", ""),
                    publishedAt = root.optString("publishedAt", "").ifBlank { null }
                )
            )
        } catch (e: Exception) {
            UpdateCheck.Failed(e.message ?: "检查更新失败")
        }
    }

    /**
     * 下载到 external-files/Download/updates/，先写 .part；断线重试时带 Range 续传。
     * 返回校验通过的目标 APK 文件。
     */
    suspend fun download(
        info: AppUpdateInfo,
        onProgress: (downloaded: Long, total: Long) -> Unit
    ): File = withContext(Dispatchers.IO) {
        val dir = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir,
            "updates"
        ).apply { mkdirs() }
        val target = File(dir, "CinemaVault-${info.versionCode}.apk")
        val part = File(dir, target.name + ".part")

        // 已经下载过且校验通过：直接复用
        if (target.exists() && target.length() == info.apkSize && sha256Of(target) == info.apkSha256) {
            onProgress(info.apkSize, info.apkSize)
            return@withContext target
        }
        if (target.exists()) target.delete()

        var existing = if (part.exists()) part.length() else 0L
        if (existing >= info.apkSize) {
            part.delete()
            existing = 0L
        }

        // 多源回退：公网镜像候选逐个尝试（含原站兜底），任一返回 200/206 即用
        var response: okhttp3.Response? = null
        var lastErr = ""
        for (url in info.apkUrls) {
            val builder = Request.Builder().url(url).header("Accept", "application/vnd.android.package-archive")
            if (existing > 0) builder.header("Range", "bytes=$existing-")
            try {
                val resp = ApiClient.client.newCall(builder.build()).execute()
                if (resp.code == 200 || resp.code == 206) { response = resp; break }
                lastErr = "HTTP ${resp.code}"
                resp.close()
            } catch (e: Exception) { lastErr = e.message ?: "网络错误" }
        }
        val resp0 = response ?: throw Exception("下载失败（已试 ${info.apkUrls.size} 个源）：$lastErr")

        resp0.use { resp ->
            if (resp.code != 200 && resp.code != 206) {
                throw Exception("下载失败：HTTP ${resp.code}")
            }
            // 服务端不支持 Range 时会回 200，只能从头写
            if (resp.code == 200) {
                existing = 0L
                if (part.exists()) part.delete()
            }
            val body = resp.body ?: throw Exception("下载失败：空响应")
            val total = when {
                info.apkSize > 0 -> info.apkSize
                resp.code == 206 && body.contentLength() > 0 -> existing + body.contentLength()
                body.contentLength() > 0 -> body.contentLength()
                else -> 0L
            }
            val input = body.byteStream()
            FileOutputStream(part, true).use { out ->
                val buf = ByteArray(64 * 1024)
                var written = existing
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    written += n
                    onProgress(written, total)
                }
                out.flush()
            }
            if (total > 0 && part.length() != total) {
                throw Exception("下载不完整：${part.length()} / $total")
            }
        }

        if (target.exists()) target.delete()
        if (!part.renameTo(target)) {
            part.copyTo(target, overwrite = true)
            part.delete()
        }

        val actual = sha256Of(target)
        if (actual != info.apkSha256) {
            target.delete()
            throw Exception("安装包 SHA-256 校验失败，已删除")
        }
        onProgress(target.length(), target.length())
        target
    }

    /** 安装前二次校验：APK 内 versionCode + 签名证书必须与本机已安装包一致。 */
    fun verifyDownloadedApk(file: File, info: AppUpdateInfo): String? {
        if (!file.exists() || file.length() <= 0) return "安装包不存在"
        val flags = signingFlags()
        val archive = try {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageArchiveInfo(file.absolutePath, flags)
        } catch (e: Exception) {
            null
        } ?: return "安装包无法解析（可能不是有效 APK）"

        @Suppress("DEPRECATION")
        val archiveCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        if (archiveCode != info.versionCode.toLong()) {
            return "安装包版本号不匹配（包内 $archiveCode / 服务端 ${info.versionCode}）"
        }

        val archiveHashes = signatureHashes(archive)
        if (archiveHashes.isEmpty()) return "安装包没有可读的签名证书"

        val installed = try {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, flags)
        } catch (e: Exception) {
            null
        } ?: return "无法读取本机安装签名"
        val installedHashes = signatureHashes(installed)
        if (installedHashes.isEmpty()) return "无法读取本机安装签名"
        if (installedHashes.none { it in archiveHashes }) {
            return "安装包签名与本机不一致，已拒绝安装"
        }
        return null
    }

    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    /** @return true=已拉起系统安装器；false=需要先授予「安装未知应用」权限 */
    fun install(file: File): Boolean {
        if (!canInstall()) return false
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        return true
    }

    fun openInstallPermissionSettings() {
        if (Build.VERSION.SDK_INT < 26) return
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
            data = Uri.parse("package:${context.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    private fun signingFlags(): Int =
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
        else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES

    private fun signatureHashes(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= 28) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        } ?: return emptySet()
        return signatures.mapTo(LinkedHashSet()) { sha256Of(it.toByteArray()) }
    }

    private fun sha256Of(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun sha256Of(bytes: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(bytes)
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
