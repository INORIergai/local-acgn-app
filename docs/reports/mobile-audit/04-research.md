# 04 · 外部调研：Android 平台要求 + 同类竞品拆解 + 下一步建议

> 调研对象：CinemaVault 移动端（WebView 壳 APK v4.5.6，minSdk 24 / targetSdk 34 / compileSdk 34 / debug 签名）
> 调研问题：**这个 App 下一步最值得做什么**
> 数据截止：2026-10-22（所有"当前/最新"均指该日期）｜方法：官方文档 + 项目仓库 + 社区/媒体旁证（媒体文章只作旁证，结论以官方文档与源码为准）
> 约束：本报告只做外部调研，不改任何源码；本仓库既有的 `docs/reports/round36-animeko对标改进清单.md` 只覆盖 animeko 单一竞品且偏功能清单，本报告不重复其条目，只补充「平台约束 + 跨品类竞品 + 系统能力」三段。

---

## 速览：10 条最重要结论

1. **targetSdk 36 已是硬门槛且已生效**：Play 自 2026-08-31 起要求新应用与更新必须 ≥ API 36（Android 16），我们停在 34 —— 侧载不受约束，但"能不能上架"这条路已被时间线关闭。[link](https://developer.android.com/google/play/requirements/target-sdk)
2. **不升级 targetSdk 是"合法的省事策略"**：edge-to-edge 强制只对 targetSdk ≥ 35 生效、predictive back 默认化只对 ≥ 36 生效，我们因此**暂时白拿**了旧行为兼容；代价是系统级新交互永远用不上，且地板会继续抬（Android 15 起已拒绝安装 targetSdk < 24 的 APK）。[link](https://developer.android.com/about/versions/15/behavior-changes-15)
3. **16 KB page size 对我们是零成本，但埋了一颗未来的雷**：2025-11-01 起 targetSdk ≥ 35 的应用必须支持 16 KB 页；当前壳是纯 Java/WebView 无 `.so`，一旦引入 Media3 + ffmpeg/libass/ONNX 等 native 库就必须用 16 KB 对齐的 .so 与工具链重编。[link](https://developer.android.com/guide/practices/page-sizes)
4. **最大能力缺口是"听书没有后台播放"**：缺 MediaSession + MediaSessionService（前台服务类型 `mediaPlayback`）+ POST_NOTIFICATIONS，导致锁屏/切 App/蓝牙耳机/车机全部失控，而 TTS 听书是项目已实现的核心卖点。[link](https://developer.android.com/media/media3/session/background-playback)
5. **`dataSync` 类前台服务在 Android 15 有 6 小时/24 小时的硬上限**：所以"离线下载 / 全库扫描"这类长任务不能挂 dataSync FGS 硬扛，必须走 WorkManager 或用户可见的短任务 + 断点续传。[link](https://developer.android.com/develop/background-work/services/fgs/timeout)
6. **分发路径正在被收紧**：Android developer verification 自 2026-09-30 起在巴西/印尼/新加坡/泰国的参与商店生效，2027 年全球推开；中国大陆 2026 年内暂不受影响，但"自建安装器 + 签名校验 + 可解释的信任链"必须提前准备。[link](https://developer.android.com/blog/posts/android-developer-verification-building-a-safer-ecosystem-together)
7. **WebView 壳不是原罪，播放器才是**：Jellyfin 官方 Android App 本身就是"WebView 壳 + 官方 web client"，而原生体验（ExoPlayer、离线下载、TV）由 TV 版与第三方 Findroid 承担 —— 这正好印证我们的正确路线：**壳继续用，把播放/听书做成原生模块**。[link](https://github.com/jellyfin/jellyfin-android)
8. **最值得抄的配对方式来自飞牛 TV**：局域网自动发现 → 手动 IP/DDNS 兜底 → 手机 App 扫码授权登录，三步把"手输 IP"这个最大流失点干掉。[link](https://help.fnnas.com/articles/v1/start/install-tv)
9. **竞品主战场已从"能不能播"转向"刮削准不准 + 海报墙卡不卡"**：飞牛宣称电影刮削准确率 99% 并自动下字幕，Nova Video Player 在 2026-08-18 还在修"动漫绝对集数"的剧集匹配。[link](https://github.com/nova-video-player/aos-AVP/blob/nova/CHANGELOG.md)
10. **阅读器侧的差异化在"听书与排版细节"而非书源数量**：Legado 在 2026-07-22 给听书加了"目录级离线音频缓存 + 范围缓存 + 损坏自动回源"，这正是我们 TTS 链路最该补的一环。[link](https://github.com/LegadoTeam/legado/releases/tag/3.26072300)

---

## A. 平台与合规（2025–2026 现状）

### A1. targetSdk 时间线（已核实）

| 时间点 | 要求 | 对我们的意义 |
|---|---|---|
| 2025-08-31 | 新应用/更新 targetSdk ≥ 35（API 35） | 早已错过，说明本来就没走 Play |
| 2025-11-01 | targetSdk ≥ 35 的应用必须支持 16 KB 页（64 位设备） | 纯 Java 无影响；引入 native 库即触发 |
| 2025-06 / 2026-06 | Android 16（API 36）/ Android 17（API 37）正式版 | 17 于 2026-06-16 发布，新行为面在扩大 |
| **2026-08-31** | **新应用/更新 targetSdk ≥ 36**；Wear/Automotive ≥ 35；TV/XR ≥ 34 | **已生效**（本报告写作时已过 7 周） |
| 2027（预计 08-31） | targetSdk ≥ 37 | 规划用 |

- 除 Play 门槛外还有一条**设备侧地板**：Android 15 起系统直接拒绝安装 targetSdk 过低的 APK，且该地板逐年抬升（详见 [Android minimum target SDK matrix](https://bayton.org/android/android-minimum-targetsdk-matrix/)）。我们 targetSdk 34 目前安全，但这是"迟早要动"的信号，不是"永远不用动"。
- 官方口径：[Meet Google Play's target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)、[Play Console Help 11926878](https://support.google.com/googleplay/android-developer/answer/11926878)。

### A2. edge-to-edge：Android 15 强制，Android 16 起无法退出

- Android 15（targetSdk 35）：edge-to-edge **默认强制**，官方留了 `windowOptOutEdgeToEdgeEnforcement` 这一个逃生门（[behavior changes 15](https://developer.android.com/about/versions/15/behavior-changes-15)）。
- Android 16（targetSdk 36）：**逃生门被废弃/失效**，状态栏与导航栏透明成为不可退出的事实（[社区实证：RN 0.81 明确"Android 16+ 无法再 opt-out"](https://github.com/react-native-community/discussions-and-proposals/discussions/921)、[Android Police 报道](https://www.androidpolice.com/android-16-full-screen-edge-to-edge-no-opt-out/)）。
- **适配成本落到我们的真实位置**：壳层 `configChanges` + 全屏主题**不会**自动帮 H5 处理 insets。一旦升 35，必须同时做三件事：① H5 顶部/底部改用 `env(safe-area-inset-*)` 并保证 `viewport-fit=cover`；② 键盘弹起用 insets 而不是 `adjustResize` 的旧假设；③ 视频全屏与漫画全屏页的刘海挖孔避让统一走一套 CSS 变量。粗略估算 **1–2 人日 + 一次全页面回归**。

### A3. predictive back：升 36 才强制，但升了就必须改返回逻辑

- Android 15 及以下：需显式 `android:enableOnBackInvokedCallback="true"` 才出现返回预览动画（[官方指南](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture)）。
- Android 16 起：对新 targetSdk 应用默认启用并逐步取消退出开关，同时新增 `PRIORITY_SYSTEM_NAVIGATION_OBSERVER` 等 API（[Android 16 features](https://developer.android.com/about/versions/16/features)）。
- **对我们的直接影响**：现在 `MainActivity` 里靠 `onBackPressed`/`webView.canGoBack()` 的分支（漫画/小说阅读器、播放器全屏、弹窗栈）在升 36 后必须迁到 `OnBackInvokedCallback`，并且要在一"帧"内决定"是 H5 消费还是系统接管"，否则会出现"手势滑到一半突然退回桌面"的撕裂感。**这是升级 targetSdk 的真实工作量所在，不是 Gradle 改一行**。

### A4. 16 KB page size：短期零成本，长期一票否决

- 规则：2025-11-01 起，targetSdk ≥ 35 的新应用与更新必须支持 16 KB 页（64 位设备）；Play 会在审核侧校验（[官方博客](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html)、[技术细节](https://developer.android.com/guide/practices/page-sizes)）。
- 判断：**我们当前不受影响**（无 `.so`、纯 Java + WebView）。
- 影响面：未来若接 Media3 + FFmpeg/libass（字幕渲染）、或接本地 ONNX/TTS 推理，则必须：NDK r28+ / AGP 8.5.1+ 构建、`.so` 不压缩 + zip 对齐、禁用 `android:extractNativeLibs` 的旧路径。**这条要写进"引入 native 依赖"的准入清单**，否则某天打包直接过不了审（哪怕只侧载，16 KB 设备上也会随机 crash）。
- 侧载视角的补充：即使不上 Play，Android 15+ 的 16 KB 设备（部分 Pixel/新旗舰）已经在真实存在，native 不对齐 = 用户侧闪退。

### A5. 前台服务与后台限制（听书与下载的设计前提）

- **Android 14 起**：每个前台服务必须声明 `foregroundServiceType` 并申请对应权限（`FOREGROUND_SERVICE` + 类型权限）([service types 文档](https://developer.android.com/develop/background-work/services/fgs/service-types))。
- **听书/后台播放**：类型 `mediaPlayback` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`；官方推荐直接用 Media3 的 `MediaSessionService`（服务自动在前台/后台间切换并托管媒体通知）([Media3 background playback](https://developer.android.com/media/media3/session/background-playback))。
- **`dataSync` / `mediaProcessing` 在 Android 15 有 6 小时/24 小时上限**，超时系统回调 `onTimeout()` 并强制停服（[FGS timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout)、[FGS changes](https://developer.android.com/develop/background-work/services/fgs/changes)）。→ **结论：离线下载/刮削/扫描不能靠 dataSync FGS 长跑**，应是"WorkManager 任务 + 可见进度通知 + 断点续传"。
- **Doze / App Standby**：熄屏进入 Doze 后网络与 Job 被推迟，WebSocket 会被切断（[Doze 文档](https://developer.android.com/training/monitoring-device-state/doze-standby)）。我们现有的"新作监视"在**服务端**轮询是架构上的正确选择；手机端只需做到"回到前台立刻补拉 + 指数退避重连"，**不要**尝试用 FGS 保活长连接（耗电、且国产 ROM 会杀）。
- **国产 ROM 的现实**：小米/华为/OPPO/vivo 的自启动与"电池优化"白名单才是决定后台存活的第一因素，代码层面无解。产品上应做**首次连接后的一次性引导**（跳到系统的电池优化/自启动页），而不是无声失败。

### A6. 通知、存储与"局域网发现"的权限细节

- **POST_NOTIFICATIONS（Android 13+）**：运行时权限。听书媒体通知、下载完成、新作提醒都依赖它；应做"情境化请求"（第一次点播放/听书时问），而不是启动就弹（[通知权限文档](https://developer.android.com/develop/ui/views/notifications/notification-permission)）。
- **照片/文件选择器**：Android 13+ 用系统 Photo Picker；导入漫画/小说/字体/字幕应走 SAF（`ACTION_OPEN_DOCUMENT` + `takePersistableUriPermission`），彻底绕开存储权限（[Photo Picker](https://developer.android.com/training/data-storage/shared/photopicker)）。
- **局域网发现**：正确姿势是 `NsdManager`（mDNS/NSD）+ `WifiManager.MulticastLock`（组播常被 ROM 默认丢弃，这是"发现不到服务器"的头号坑）；Android 13+ 若还要读 Wi-Fi 信息才需 `NEARBY_WIFI_DEVICES`（可声明 `neverForLocation`）。**不要**为了发现去申请定位权限——那是会被用户直接拒绝的体验灾难。
- **TLS/证书**：我们已 `usesCleartextTraffic=true` + `networkSecurityConfig`。若用户用自签证书的 HTTPS（CF 穿透以外的自建反代），必须显式在 `trust-anchors` 里放用户 CA，否则 WebView 与原生下载会各自失败一次。

### A7. WebView / TWA / Custom Tabs 的取舍（结论：继续 WebView）

| 方案 | 能力 | 致命约束 | 结论 |
|---|---|---|---|
| **WebView（现状）** | 可注入 JS、可全屏/PiP、可拦截请求、可做原生桥 | 内核由系统 WebView 提供（国内 ROM 版本参差）、无地址栏无分享 | **保留**，做版本探测 + 降级兜底 |
| TWA (Trusted Web Activity) | 用 Chrome 渲染全屏、无地址栏、与 PWA 同源 | **依赖 Chrome 或支持 Custom Tabs 的浏览器**；国内大量设备无 Chrome → 直接打不开 | **否决** |
| Custom Tabs | 复用用户浏览器、有地址栏、安全 | 无法当壳：不能注入、不能自定义全屏/PiP、无法常驻会话 | 仅用于"打开帮助/更新说明/外链" |

官方对照：[TWA 概览](https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities)、[Web 内容选型](https://developer.android.com/develop/ui/views/layout/webapps/in-app-browsing-embedded-web)。补充一条工程现实：WebView 的 `MediaSession` 支持不可靠，**后台音频这件事在 WebView 里做不到**，必须原生。

### A8. 侧载分发：哪些要求可以忽略、哪些仍会咬人

| 要求 | 不上 Play 是否可忽略 | 真实影响 |
|---|---|---|
| targetSdk 36 / Play 审核 / AAB / 16 KB 审核校验 | ✅ 可忽略 | 但设备侧 targetSdk 地板与 16 KB 设备仍会命中 |
| edge-to-edge 强制 | ✅ 当前可忽略（因 targetSdk 34） | 升 35 后不可忽略 |
| predictive back | ✅ 当前可忽略 | 升 36 后不可忽略 |
| FGS 类型 / 通知权限 | ❌ 不可忽略 | 系统级行为，与上架无关 |
| Play Protect 拦截 | ❌ 不可忽略（体验） | debug 签名 + 未知来源 → "unsafe app blocked"/"仍要安装"；且每个来源（浏览器/文件管理器）要单独授权"安装未知应用"。[旁证](https://www.ziptoapk.com/guides/install-apk-on-android/) |
| developer verification | ⏳ 2026 年内大陆不影响，2027 全球 | 需准备：release 签名（不是 debug）、签名指纹公开可校验、安装器内展示 SHA-256 |

**立即可做的低成本改进**：把 `debug` 签名换成项目自有 keystore 的 release 签名（自签即可，不需要任何机构），签名一致才能保证"应用内更新"覆盖安装不被系统拒绝/不被识别为不同应用 —— 这与 Play 上架无关，纯粹是自升级链路的稳定性问题。

---

## B. 同类竞品拆解

### B1. 媒体服务器客户端

| 产品 | 它怎么做（可核实事实） | 可借鉴点 |
|---|---|---|
| **Jellyfin for Android** | 官方 App 本质是 **WebView 壳 + 官方 web client**（README 原文："integrates with the official web client"）；真正的原生播放/离线在 **Android TV 版**与第三方 **Findroid**（原生 UI + Media3 + 离线下载）([jellyfin-android](https://github.com/jellyfin/jellyfin-android)、[Findroid](https://github.com/jarnedemeulemeester/findroid)) | **架构印证**：壳 + 原生模块是行业主流解法，不必推翻重来；把"播放/下载/后台"切成原生模块即可 |
| **Nova Video Player** | 网络共享走 SMB v1–3（官方 FAQ 明确推荐 445 端口的 SMB）；刮削靠 TMDb、同步靠 Trakt；持续针对剧集匹配打磨，2026-08-18 的 v6.4.48 还在修"动漫绝对集数/非标准文件名"的集数识别 ([FAQ](https://github.com/nova-video-player/aos-AVP/blob/nova/faq/faq.md)、[CHANGELOG](https://github.com/nova-video-player/aos-AVP/blob/nova/CHANGELOG.md)) | ① **SMB/WebDAV 直连**可作为"不装服务端也能用"的降级路径；② 动漫绝对集数匹配是我们迟早要踩的坑；③ 刮削结果要允许"人工纠正 + 记住纠正" |
| **Kodi** | 插件（Add-on）体系 + JSON-RPC 远程控制 + PVR | ① JSON-RPC 式**远程控制 API** 可让我们做"手机当遥控器/网页遥控"；② 但插件生态是重资产，**不建议学** |
| **Plex** | 账号体系 + 服务端转码 + 多端"继续观看"统一 + 离线同步（付费墙） | ① **服务端决定码率/是否转码**（我们已有整站反代，可加"按带宽给不同清晰度"）；② "继续观看"跨端一致性的产品表达 |

### B2. 中文 NAS / 影音

| 产品 | 它怎么做 | 可借鉴点 |
|---|---|---|
| **飞牛影视（fnOS）/ 飞牛 TV** | TV 端启动即**自动发现局域网内的影视服务器**；发现失败可手输 IP 或 DDNS 域名；登录支持**手机 App 扫码 + 授权**或账号密码（[官方帮助](https://help.fnnas.com/articles/v1/start/install-tv)）；影视应用主打"海报墙 + 99% 刮削准确率 + 自动下字幕"（[官网](https://fnnas.com/)） | **最高优先借鉴**：自动发现 + 扫码配对 + 刮削/字幕自动化，正好对应我们"手输 IP"的痛点 |
| **网易爆米花（原 Filmly）** | 一个 App 聚合 Emby / Jellyfin / 飞牛 / 极空间 / 阿里云盘 / 百度网盘 / 115 / 天翼 / 移动云盘 / 123 云盘，支持 WebDAV、SMB 直连；统一刮削成海报墙；跨端（手机/盒子/iOS/AppleTV）**扫码登录后同步资源库与观看进度**（[官网](https://bmh.163.com/)、[体验文](https://ycyc.win/posts/46389.html)） | ① **"把别人的库当数据源"**——我们已有云盘 OAuth 与 WebDAV 基础，可加"挂载 SMB/WebDAV 作为片源"；② 跨端同步靠**扫码建立设备身份**，比输入 IP+口令优雅得多 |
| **极影视（极空间）** | NAS 端影视墙（刮削+分类+播放），手机/电视客户端；支持远程访问（[官网软件页/FAQ](https://m.zspace.cn/software/qa.html)、[实测](https://post.smzdm.com/p/avged4e4/)） | "库即应用"的一体感；远程访问与局域网体验**同一套 UI**，不区分两套客户端 |
| **绿联影视中心（UGOS Pro）** | 系统级"影视中心"：建媒体库 → 自动分类 → 多终端同步播放（[官方知识库](https://support.ugnas.com/detail/article/zh-CN/432)） | 建库流程的**引导式向导**（选目录 → 选刮削源 → 预览结果 → 确认）比"设置项堆叠"转化更高 |

### B3. 动漫 / 漫画 / 小说

| 产品 | 它怎么做 | 可借鉴点 |
|---|---|---|
| **animeko（本地源码可查：`animeko-main/`）** | Compose Multiplatform 一套 UI 多端；Android 侧 **Media3 1.9.0**（`gradle/libs.versions.toml`），桌面侧 libmpv；自研 `HttpMediaCacheEngine`（边下边播缓存）、`MediaDownloadManager`（`app/shared/app-data/.../media/download/`）、`PlayerGestureHost.android.kt`（手势宿主）、`PlayerDanmakuHost`（弹幕层）、`Anime4kQualityEffects`（超分）、torrent 模块 | ① **缓存引擎**（边下边播 + 可清理配额）比"整集下载"更贴合移动场景；② 手势做成可插拔 Host，播放器换内核时手势不用重写；③ Android 用 Media3、桌面用 mpv 的双内核路线 |
| **Mihon / Tachiyomi** | 扩展仓库体系（每个源是独立 APK 实现 Source 接口）+ 本地源（直接读本地 CBZ/文件夹）+ 备份/恢复 + 追更追踪（[mihonapp/mihon](https://github.com/mihonapp/mihon)） | 我们的解析器引擎（round36 已落地）本质同类；缺的是**本地源**：把 NAS 上已有的漫画目录直接当书源，零刮削即可读 |
| **Komga** | 服务端 + **OPDS v1/v2** + **Kobo Sync** + **KOReader Sync** + 官方 Mihon 扩展（Keiyoushi 仓库）+ Web 阅读器（[官网](https://komga.org/)、[Mihon 指南](https://github.com/gotson/komga-website/blob/master/website/docs/guides/mihon.md)） | ① **OPDS 输出**是低成本高杠杆：让 KOReader/Mihon/任何 OPDS 阅读器直接读我们的库（反向引流 + 免开发客户端）；② 进度同步协议化，将来做多端才不痛 |
| **阅读（Legado）** | 书源 = JSON 规则（CSS/XPath/JSONPath/正则）+ 换源 + 离线缓存 + 系统/在线 TTS；**2026-07-22 版本新增"听书离线音频缓存"**：支持范围缓存、目录缓存状态、损坏自动回源、取消/失败保留已缓存（[Release 3.26072300](https://github.com/LegadoTeam/legado/releases/tag/3.26072300)） | **直接对应我们 TTS 的短板**：音频按"段"缓存 + 预取下一段 + 失败回源 + 目录级状态可视化 |
| **Moon+ Reader** | 可视化排版细粒度可调（行距/字距/粗斜体/阴影/两端对齐/淡入边缘）+ 10+ 主题 + TTS 朗读 + 翻页动画（[MobileRead 特性表](https://wiki.mobileread.com/wiki/Moon%2B_Reader_Pro)、[官网](https://www.moondownload.com/)） | 阅读体验的护城河在**排版参数 + 手势 + 主题**的组合，不在功能数量；我们的双页/分页已有，缺"参数级可调 + 预设主题" |

### B4. 播放器内核（选型参考）

| 产品 | 它怎么做 | 可借鉴点 |
|---|---|---|
| **MX Player** | 解码三档 HW / HW+ / SW 自动降级；手势（音量/亮度/缩放/字幕滑动）；隐私文件夹；儿童锁 | **解码降级链**：硬解失败自动降 SW 并提示，而不是黑屏；**隐私库**（我们已有隐私分割器，可加生物识别） |
| **Just Player** | 极简 Media3/ExoPlayer 实现，无广告，支持 HDR/DoVi 直通（[moneytoo/Player](https://github.com/moneytoo/Player)） | **我们要写原生播放器时的最佳抄本**：结构小、纯 Media3、正好覆盖"能播 + 字幕 + PiP" |
| **mpv-android** | libmpv + libass（复杂 ASS 特效字幕）+ 高级缩放/插帧/着色器 + 后台播放 + PiP（[mpv-android](https://github.com/mpv-android/mpv-android)） | 若"字幕特效/番剧字幕组 ASS"是刚需，libass 是唯一解；但**体积 + 16 KB + 版权**三重成本，建议先用 Media3 内置字幕，ASS 特效列为观察项 |

---

## C. 平台能力清单：可接入但尚未接入

| 能力 | 关键 API | 现状 | 用户价值 | 成本 | 建议 |
|---|---|---|---|---|---|
| 听书/播放后台 + 锁屏控制 | `MediaSessionService` + `mediaPlayback` FGS + `POST_NOTIFICATIONS` | ❌ 无 | ★★★★★ 锁屏/切 App/耳机/车机 | M | **P0** |
| 原生视频播放器 | Media3 `ExoPlayer`（HLS/DASH/字幕/PiP） | ❌ 用 WebView `<video>` | ★★★★★ 硬解省电、字幕、PiP 稳定、手势 | M–L | **P0** |
| 离线下载 | `DownloadManager` 或自研（断点/多线程）+ WorkManager | ❌ | ★★★★☆ 地铁/外出 | M | **P1** |
| 投屏 | Cast SDK v3 / DLNA(jUPnP) / `MediaRouter` 系统输出切换 | ❌ | ★★★★☆ 电视大屏 | M–L | **P1**（国内优先 DLNA） |
| 局域网自动发现 | `NsdManager` + `MulticastLock` | ❌ 手输 IP | ★★★★☆ 首次连接转化 | S–M | **P0** |
| 扫码配对 | 原生 CameraX/ML Kit 或 WebView + `getUserMedia`；服务端出一次性 token | ❌ | ★★★★☆ 老人/电视场景 | S | **P1** |
| Android TV | Leanback / Compose for TV + D-pad 焦点 + `LEANBACK_LAUNCHER` | ❌ | ★★★★☆ 客厅 | L | P2 |
| 桌面小组件 | Glance AppWidget | ❌ | ★★★ 继续观看/新作 | M | P2 |
| 分享接收 | `ACTION_SEND`(video/*) / `ACTION_VIEW` | 部分（深链已有） | ★★★ 外部文件直接入库播放 | S | P1 |
| 通知渠道 | 分渠道（新作/下载/更新）+ 免打扰 | ❌ | ★★★ 可控打扰 | S | **P1** |
| App Links | `https://域名/.well-known/assetlinks.json`（CF 穿透域名可做） | ❌ 仅自定义 scheme | ★★★ 分享链接一键进 App | S | P2 |
| 生物识别锁 | `BiometricPrompt` | ❌ | ★★★★ 隐私库 | S | **P1** |
| 防截屏 | `FLAG_SECURE` | ❌ | ★★★★ 私密内容 | S | **P1** |
| 每应用语言 | `localeConfig`（Android 13+） | ❌ | ★★ | S | P3 |
| 动态取色 | Material You `DynamicColors` → 注入 H5 CSS 变量 | ❌ | ★★ 观感统一 | S | P3 |
| SAF 导入 | `ACTION_OPEN_DOCUMENT` + persistable URI | ❌ | ★★★ 本地漫画/字体/字幕 | S | P2 |
| 电池优化白名单引导 | `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + 厂商页跳转 | ❌ | ★★★ 后台不再莫名断 | S | **P1** |
| 签名校验自更新 | `PackageManager` 签名比对 + SHA-256 展示 | 部分（有自升级） | ★★★ 升级不失败/不被骗 | S | **P1** |

---

## D. 结论：可直接落地的建议清单

> 优先级：P0 = 决定下一步版本主题；P1 = 该主题内必做；P2 = 有余力做；P3 = 观察。
> 实现路径：**原生** = Java/Kotlin；**H5** = 现有前端；**双端** = 原生 + 后端接口。

| # | 做什么 | 为什么（用户价值） | 参考产品 | 路径 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|
| 1 | 听书接 `MediaSessionService`（`mediaPlayback` FGS + 媒体通知 + 耳机按键 + 章节切换） | 现在切 App 就断，TTS 卖点被"锁屏即停"抵消 | Moon+ Reader / Legado / Media3 官方指南 | 原生 | **P0** | M |
| 2 | 局域网自动发现服务器（mDNS 广播 + `NsdManager` + `MulticastLock`），保留手输 IP 兜底 | 消灭"手输 IP"这个最大首次流失点 | 飞牛 TV | 双端 | **P0** | S–M |
| 3 | 原生播放器 MVP：Media3 ExoPlayer 播 HLS/直链 + 内置字幕 + 系统 PiP + 手势层 | WebView `<video>` 无后台音频、字幕弱、PiP 不稳、耗电高 | Just Player / animeko(`video-player/androidMain`) | 原生 | **P0** | M–L |
| 4 | WebView 版本探测 + 渲染降级兜底（内核过旧提示、软件渲染开关自动建议） | 国内 ROM WebView 版本参差，是白屏/黑屏类反馈的根因 | 自有 round90 经验 | 原生+H5 | **P0** | S |
| 5 | release 签名替换 debug 签名 + 自更新时校验包名/签名/SHA-256 | 覆盖安装被拒、更新后数据丢失、下错包等事故的直接来源 | — | 原生 | **P1** | S |
| 6 | 应用锁（BiometricPrompt）+ 私密库 `FLAG_SECURE` 防截屏 | 私人媒体库的刚需；与既有隐私分割器形成闭环 | MX Player 隐私文件夹 | 原生 | **P1** | S |
| 7 | 离线下载 v1：服务端 `/api/download` + 原生下载器（断点/并发/暂停）+ 离线库入口 | 外出/地铁/弱网场景；也是"投屏/后台"的基础设施 | Findroid / Jellyfin | 双端 | **P1** | M |
| 8 | 电池优化/自启动一次性引导（首次连接后）+ 长连接指数退避重连 | 国产 ROM 后台必杀，不引导就一定被投诉"断连" | — | 原生+H5 | **P1** | S |
| 9 | 通知渠道化（新作/下载完成/更新）+ 情境化请求 `POST_NOTIFICATIONS` | 现在通知是一锅粥，用户只能全关 | — | 双端 | **P1** | S |
| 10 | 分享接收：`ACTION_SEND video/*` / 打开本地文件 → 直接播放/入库 | 从文件管理器/微信"用其他应用打开"直达 | Nova / 爆米花 | 原生 | **P1** | S |
| 11 | TTS 音频段级缓存 + 预取下一段 + 失败回源 + 目录级缓存状态 | 重复朗读不再重复合成，弱网也能连播 | Legado 3.26072300 | 双端 | **P1** | M |
| 12 | 投屏 v1：DLNA（jUPnP）优先 + Cast SDK 可选；播放页出"投屏"按钮 | 客厅场景是"私人影院"叙事的完成度关键 | 飞牛影视 / 极影视 | 原生+后端 | **P1** | M–L |
| 13 | 刮削"人工纠正 + 记住纠正" + 动漫绝对集数匹配 | 刮错一次就被记住错到底，是最伤的信任问题 | Nova v6.4.48 | 后端+H5 | **P1** | M |
| 14 | targetSdk 34→35 适配（edge-to-edge insets 全套）→ 36 适配（OnBackInvokedCallback） | 系统地板逐年抬升；早做成本低，晚做被迫做 | — | 原生+H5 | P2 | M |
| 15 | 阅读器"参数级可调 + 预设主题 + 手势可配置" | 阅读留存靠手感细节，不靠功能数量 | Moon+ Reader | H5 | P2 | M |
| 16 | SAF 导入本地漫画/小说（zip/cbz/epub）+ 字体导入 | 无需服务端也能读自己已有的文件 | Mihon 本地源 | 原生 | P2 | S |
| 17 | 桌面小组件（Glance）：继续观看 + 新作倒计时 | 提升"每天想起你"的频次 | — | 原生 | P2 | M |
| 18 | OPDS v1/v2 输出（只读） | 让 KOReader/Mihon 直接读我们的库，零客户端成本扩生态 | Komga | 后端 | P3 | M |

### 未来 3 个版本的主题建议

- **v4.6「稳与私」**：崩溃/ANR 与 WebView 兜底治理、release 签名与自更新校验、应用锁 + 防截屏、通知渠道、电池优化引导。
  *判据：把"说不清原因的闪退/黑屏/断连"清零，先止血再加速。*
- **v4.7「无感连接与离线」**：局域网自动发现 + 扫码配对、MediaSession 听书后台、离线下载 v1、分享接收、TTS 段级缓存。
  *判据：首次连接 ≤ 10 秒、锁屏不断、地铁可看 —— 三个可量化的体验拐点。*
- **v5.0「一个内核，多块屏」**：Media3 原生播放器（字幕/PiP/后台）+ 投屏（DLNA/Cast）+ Android TV 版。
  *判据：从"网页套壳"升级为"自带播放内核的客户端"，同时打开客厅入口。*

### 明确不建议做（防止过度工程）

1. **TWA**：依赖 Chrome，国内设备大量不可用。
2. **Kodi 式插件体系**：维护成本极高，我们的解析器引擎已覆盖 80% 需求。
3. **上架 Google Play**：内容型应用的政策风险 + 逐版审核成本，与"本地优先"定位冲突。
4. **用 Compose 重写现有 UI**：H5 已成型且跨端（Electron/Web），重写收益远小于成本。
5. **为保活做 FGS 长连接**：耗电 + 被 ROM 杀 + 违反后台限制精神，服务端轮询才是正解。

### 风险与不确定性（写报告时必须承认的）

- **时间线会变**：Play 的 targetSdk 与 16 KB 时间线历史上被修正过（如 16 KB 截止日曾被误发为别的日期，[官方澄清](https://support.google.com/googleplay/android-developer/thread/368982598/clarification-of-the-16kb-page-size-deadline-and-information-on-extensions?hl=en)）；developer verification 的生效地区与时间也可能调整。**引用日期时一律以官方页为准，本文所有日期对应 2026-10-22 的官方口径。**
- **旁证与一级来源的差别**：竞品"怎么做"里，标注了仓库/官方帮助的部分是一级来源；涉及第三方体验文的（极空间、爆米花、YouTube 类对比）只作旁证，不可作为承诺依据。
- **本地 ROM 差异无法从文档推出**：后台存活、组播、WebView 内核版本这三件事必须在真机矩阵（小米/华为/OPPO/vivo/三星 + 一台 TV）上实测，否则建议 #2/#4/#8 的效果无法验收。

---

## 参考来源

> 访问日期均为 **2026-10-22**。

**平台与合规（一级来源）**

1. Meet Google Play's target API level requirement — https://developer.android.com/google/play/requirements/target-sdk
2. Target API level requirements for Google Play apps（Play Console Help）— https://support.google.com/googleplay/android-developer/answer/11926878
3. 16 KB page sizes（技术细节）— https://developer.android.com/guide/practices/page-sizes
4. Prepare your apps for Google Play's 16 KB page size compatibility requirement（2025-05）— https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html
5. Clarification of the 16KB page size deadline — https://support.google.com/googleplay/android-developer/thread/368982598/clarification-of-the-16kb-page-size-deadline-and-information-on-extensions?hl=en
6. Behavior changes: apps targeting Android 15 — https://developer.android.com/about/versions/15/behavior-changes-15
7. Behavior changes: apps targeting Android 16 — https://developer.android.com/about/versions/16/behavior-changes-16
8. Behavior changes: apps targeting Android 17 — https://developer.android.com/about/versions/17/behavior-changes-17
9. Android 16 features（predictive back 新 API）— https://developer.android.com/about/versions/16/features
10. Add support for the predictive back gesture — https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture
11. Display content edge-to-edge in views — https://developer.android.com/develop/ui/views/layout/edge-to-edge
12. Foreground service types — https://developer.android.com/develop/background-work/services/fgs/service-types
13. Foreground service timeouts — https://developer.android.com/develop/background-work/services/fgs/timeout
14. Changes to foreground services — https://developer.android.com/develop/background-work/services/fgs/changes
15. Background playback with a MediaSessionService — https://developer.android.com/media/media3/session/background-playback
16. Notification runtime permission — https://developer.android.com/develop/ui/views/notifications/notification-permission
17. Photo picker — https://developer.android.com/training/data-storage/shared/photopicker
18. Doze and App Standby — https://developer.android.com/training/monitoring-device-state/doze-standby
19. Overview of Trusted Web Activities — https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities
20. In-app browsing using Embedded Web（WebView vs Custom Tabs）— https://developer.android.com/develop/ui/views/layout/webapps/in-app-browsing-embedded-web
21. Android developer verification（官方指南）— https://developer.android.com/developer-verification/guides
22. Android developer verification: Building a safer ecosystem together（2026-06）— https://developer.android.com/blog/posts/android-developer-verification-building-a-safer-ecosystem-together
23. Android 17 is here（2026-06-16 发布）— https://android-developers.googleblog.com/2026/06/Android-17.html
24. Prepare your app for the resizability and orientation changes in Android 17 — https://developer.android.com/blog/posts/prepare-your-app-for-the-resizability-and-orientation-changes-in-android-17

**平台（旁证 / 次级来源）**

25. Android minimum target SDK matrix（设备侧安装地板）— https://bayton.org/android/android-minimum-targetsdk-matrix/
26. Android 16 will force apps to use transparent status and navigation bars — https://www.androidpolice.com/android-16-full-screen-edge-to-edge-no-opt-out/
27. RN 0.81：Android 16+ 无法 opt-out edge-to-edge — https://github.com/react-native-community/discussions-and-proposals/discussions/921/
28. Android's controversial new developer rules are officially here（2026-10-01）— https://www.androidauthority.com/android-sideloading-developer-verification-first-wave-rollout-3717921/
29. How to Install an APK on Android — Sideloading & Play Protect（2026-09 更新）— https://www.ziptoapk.com/guides/install-apk-on-android/

**竞品（仓库 / 官方帮助 / 官网）**

30. jellyfin/jellyfin-android — https://github.com/jellyfin/jellyfin-android
31. jarnedemeulemeester/findroid — https://github.com/jarnedemeulemeester/findroid
32. Nova Video Player FAQ（网络共享协议）— https://github.com/nova-video-player/aos-AVP/blob/nova/faq/faq.md
33. Nova Video Player CHANGELOG（v6.4.48，2026-08-18）— https://github.com/nova-video-player/aos-AVP/blob/nova/CHANGELOG.md
34. 飞牛：如何安装飞牛 TV 并连接到影视服务器 — https://help.fnnas.com/articles/v1/start/install-tv
35. 飞牛 fnOS 官网（刮削/字幕能力）— https://fnnas.com/
36. 网易爆米花官网 — https://bmh.163.com/
37. 网易爆米花初体验（旁证）— https://ycyc.win/posts/46389.html
38. 极空间官网 软件/FAQ — https://m.zspace.cn/software/qa.html
39. 极空间极影视实测（旁证）— https://post.smzdm.com/p/avged4e4/
40. 绿联：使用影视中心搭建专属家庭影院 — https://support.ugnas.com/detail/article/zh-CN/432
41. Komga 官网 — https://komga.org/
42. Komga × Mihon 指南 — https://github.com/gotson/komga-website/blob/master/website/docs/guides/mihon.md
43. mihonapp/mihon — https://github.com/mihonapp/mihon
44. Legado Release 3.26072300（听书离线音频缓存，2026-07-22）— https://github.com/LegadoTeam/legado/releases/tag/3.26072300
45. Moon+ Reader 官网 — https://www.moondownload.com/
46. Moon+ Reader 特性表（MobileRead）— https://wiki.mobileread.com/wiki/Moon%2B_Reader_Pro
47. moneytoo/Player（Just Player）— https://github.com/moneytoo/Player
48. mpv-android — https://github.com/mpv-android/mpv-android

**本地一手证据（仓库内，非网络）**

49. `animeko-main/gradle/libs.versions.toml`（Media3 1.9.0）
50. `animeko-main/app/shared/video-player/src/androidMain/kotlin/ui/PlayerGestureHost.android.kt`、`.../media/AniExoPlayerLoadControl.kt`、`.../videoenhancement/Anime4kQualityEffects.kt`
51. `animeko-main/app/shared/app-data/src/commonMain/kotlin/domain/media/download/MediaDownloadManager.kt`、`.../cache/engine/HttpMediaCacheEngine.kt`
52. 本仓库 `android/app/build.gradle`（minSdk 24 / targetSdk 34 / compileSdk 34）、`android/app/src/main/AndroidManifest.xml`（无 FGS / 无 MediaSession / 有深链与 FileProvider）
