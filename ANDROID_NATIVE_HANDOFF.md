# CinemaVault 安卓原生版 · Claude 二次开发交接

> 本版交接更新时间：**2026-11-21**
> 项目根目录：`D:\ai program\local-movie-library`
> 安卓工程：`D:\ai program\local-movie-library\android`
> 当前基线：**Compose 全原生 v5.0.0，六大场景已迁移，本轮四项修复已提交并真机验收**
> 下一棒建议：先读本文和 `CLAUDE_ANDROID_PROMPT.md`，不要从旧 WebView 计划重新开始。

---

## 0. 接手时最重要的警告

1. **真代码在 D 盘上述目录。** `C:\Users\Administrator\alma\worktrees\local-movie-library\competitive-crab` 下曾有废弃 WebView 骨架，不要在那里继续开发。
2. **主工作区非常脏。** 有大量此前未提交的 Node、前端、打包与安卓改动；许多原生 Kotlin 文件仍是 untracked。
   - 禁止 `git reset --hard`、`git clean -fd`、整仓 checkout。
   - 不要以为自己只改了某文件，就把整个工作区当成可丢弃状态。
   - 本轮四笔提交只暂存了相关文件，没有吞并整个脏工作区。
3. **「构建成功」不等于「功能验收通过」。** 本轮就在真机上发现过：此前标称完成的标题淡出实际不生效、润色会答非所问。新功能必须尽量真机验证，并写明未验项。
4. PC 端 AI 全走 API，**安卓本地不放模型**。
5. **禁止调用 `/api/series/from-calendar`**，首次大量抓取可能拖崩 EXE；首页日历使用 `/api/acg/calendar`。
6. Kotlin 块注释里不要写 `/api/ai/*` 这类内容，会触发嵌套注释 `Unclosed comment`，写「AI 系列接口」即可。

---

## 1. 当前版本与本轮提交

当前 HEAD：

```text
7235eb3 feat(android): 五库标签筛选与 EPUB 富文本阅读
d1baae6 fix(android): 播放控制条隐藏时标题同步淡出
427e5c7 fix(android): 听书可停止 + 手机端可选音色
391e23d fix(android): 主题切换即时生效并持久化
ab76538 fix(dev): 穿透脚本自动探测端口 + 新增带端口启动的桌面版拉起脚本
```

### 本轮实际完成

| 项目 | 代码结果 | 真机验收结果 |
|---|---|---|
| 主题切换 | 新增 `ThemeStore`，0 跟随系统 / 1 暗金 / 2 纸书；即时重组并写 SharedPreferences | 切换立即换皮；`theme_mode=1` 落盘；杀进程冷启动仍暗金 |
| 听书停止 | 新增 `TtsController` 统一 UI/Service 状态；停止取消合成协程；通知栏有停止动作 | 合成 1/12 时停止成功；合成 8/12 时再次停止成功；服务记录归零，按钮恢复 |
| 音色选择 | 设置页列出 fishaudio 音色，点选热重载 | 手机选「爱弥斯」后，服务端 current 同步变化 |
| 视频播放器 | 横屏全屏；标题改为触摸显示、3 秒无操作自动隐藏 | H.264 播放正常；标题自动消失与触摸恢复通过；HEVC 海思硬解通过 |
| 标签归类 | 影剧/漫画/小说接入标签搜索、多选、且/或组合 | 漫画标签勾选后结果列表正确变化 |
| EPUB 排版 | 净化 HTML 用 WebView 富文本渲染，保留段落、表格、图片 | 章节标题不重复，段落正常；不再压成纯文本/`[OBJ]` |
| 小说润色 | 阅读器新增入口，可切换原文/润色版；服务端异常结果防线 | **质量未通过**：曾返回别章内容；最后一次请求 180 秒未返回，不能宣称好用 |

本轮最终 APK 已安装到手机：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 2. 技术与构建环境

- Kotlin 1.9.24、Compose BOM 2024.06.00、Material3
- Media3 1.4.1、Coil 2.6.0、OkHttp 4.12.0
- `compileSdk 34 / targetSdk 34 / minSdk 24 / Java 17`
- `versionCode 5 / versionName 5.0.0`
- `NativeActivity` 为 launcher；旧 WebView `MainActivity` 不再作为入口
- `VideoPlayerActivity` 最终保持 **`android:exported="false"`**
- `TtsPlaybackService` 为 `mediaPlayback` 前台 Service，未导出
- release 签名读取 `keystore.properties`；不要把 keystore 或密码提交进仓库

构建命令（必须指定 JDK 21，系统默认 Java 是 1.8）：

```bat
cd /d "D:\ai program\local-movie-library\android"
set JAVA_HOME=D:\apps\jdk-21
gradlew.bat assembleDebug
```

成功标准：

```text
BUILD SUCCESSFUL
android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 3. 源码地图（本轮新增/重点）

```text
cn/cinemavault/app/
  CvApplication.kt                 初始化 ServerConfig / ApiClient / ThemeStore
  NativeActivity.kt                Compose 入口；主题跟随 ThemeStore；音量键转发
  MainActivity.java                [WebView 遗留] 不再作为 launcher，后续经用户同意再删
  capabilities/                    [WebView 遗留] 不主动使用
  cvnative/                        [WebView 遗留] 不主动使用

  data/api/
    ApiClient.kt                   OkHttp + Cookie + unwrap + SSE；伴读请求 180 秒超时
    PersistentCookieJar.kt         lml_session 持久化
    ServerConfig.kt                baseUrl 与地址规范化
  data/prefs/ThemeStore.kt          主题模式状态 + 持久化
  data/repo/
    TtsRepository.kt               分块合成、音色列表与音色热切换
    TagRepository.kt               GET /api/tags + POST /api/tags/filter/movies
    ReaderRepository.kt            章节读取与机翻润色
    MovieRepository.kt             影剧列表/搜索
    ShelfRepository.kt             书架列表与进度

  playback/
    TtsController.kt               听书唯一状态源；合成 Job 可取消
    TtsPlaybackService.kt          前台播放、追加队列、通知栏停止、结束回写状态
    MediaSourceFactory.kt          带 Cookie 的媒体数据源

  ui/theme/Theme.kt                午夜场暗金 / 日场纸书
  ui/screen/
    SettingsScreen.kt              主题选择、fishaudio 音色选择
    SettingsViewModel.kt           设置状态与音色热切换
    NovelReaderScreen.kt           TXT/EPUB 阅读、TTS、目录、字号、机翻润色
    RichNovelContent.kt            EPUB 富文本 WebView 渲染层
    MovieScreen.kt                 影剧列表 + 标签入口
    MovieViewModel.kt              影剧标签筛选状态
    ShelfScreen.kt                 漫画/小说列表 + 标签入口
    ShelfViewModel.kt              书架标签筛选状态
    TagFilterSheet.kt              通用标签搜索/多选/且或抽屉
    VideoPlayerActivity.kt         独立横屏播放 Activity，未导出
    VideoPlayerScreen.kt           ExoPlayer + 标题自动隐藏 + HEVC 降级逻辑
```

---

## 4. 服务端契约与已知坑

### 通用

- 服务：`http://127.0.0.1:3517`
- 鉴权：httpOnly Cookie `lml_session`，即使当前免鉴权也继续带 Cookie
- 响应：`{code:0,data:...}`；错误字段是 **`msg`**

### 标签

- 列表：`GET /api/tags?lib=film|anime|comic|novel|jav&q=关键词`
- 组合：`POST /api/tags/filter/movies`
  - body：`{tagIds:[...], lib:"comic", mode:"and"|"or"}`
  - 全库推荐页传空 lib；影剧「影片」分段映射 `jav`，「动漫」映射 `anime`

### EPUB / 小说

- 信息：`GET /api/novel/:id/info`
- 章节：`GET /api/novel/:id/chapter/:index`
  - `content` 是净化富文本，`text` 是纯文本，`isHtml` 标识渲染方式
- 图片：`GET /api/novel/:id/asset/<EPUB内路径>`
- 机翻润色：`POST /api/novel/:id/ai-companion`
  - body：`{mode:"polish",chapterIndex:N}`
  - 当前模型可能答非所问或长时间不返回；服务端已加篇幅异常防线，但不等于质量保障
  - `/api/novel/37367` 的服务端 EPUB OOM 是独立问题，不要改成 App 假象修复

### TTS

- 状态：`GET /api/tts/status`
- 音色：`GET /api/tts/voices?engine=fishaudio`
- 切换：`POST /api/tts/fishaudio/voice`，body `{referenceId,voiceName}`，热重载
- 合成：`POST /api/tts/synthesize {text,play:false}`，取 `data.path` basename
- 音频：`GET /api/tts/audio/:name`

### 视频

- 串流：`GET /api/movie/stream?path=<filePath>`
- 路径必须在服务端白名单目录内，不在库内不能任意读盘
- `transcode=1` 可追加用于 HEVC 降级，但本次真机没有触发该路径

---

## 5. 真机验收 SOP

设备：华为 nova 7 Pro 5G，JER-AN10，Android 12 / SDK 31，1080×2340，serial `UJK0220421019630`。

每次新会话：

```bat
cd /d "D:\ai program\local-movie-library"
node _start-exe.js
adb -s UJK0220421019630 reverse tcp:3517 tcp:3517
adb devices -l
```

注意：

- `reverse` 会丢，重连/重启后必须重建
- 华为安装可能卡在风险确认/统一认证，需人工点允许；`INSTALL_FAILED_ABORTED` 后重发并在手机确认
- 不要对未导出的 `VideoPlayerActivity` 直接 `adb am start`，会 Permission Denial
- 本轮验收曾临时导出播放器，**最终已恢复 false**，不要再依赖这个测试捷径
- `uiautomator dump` 看不到 Compose 内容，只能靠截图与坐标；横竖屏坐标不可混用
- App 业务断言优先走 PC 端 HTTP API；logcat 查 FATAL/解码/服务状态
- 不要点播成人内容来做验收；本轮播放器使用本地生成的 H.264/HEVC 测试片，验后已删除

---

## 6. 本轮验收截图

目录：`_acceptance-shots/native-contract/`（被 gitignore，不要为了提交而强塞）

- `125-theme-switch-instant.png`
- `126-theme-persist-coldstart.png`
- `127-tts-synthesizing-with-stop.png`
- `128-tts-stopped-back-to-idle.png`
- `129-tts-voice-picker.png`
- `130-video-title-auto-hidden.png`
- `131-video-title-reappear-on-tap.png`
- `132-video-hevc-hardware-decode.png`
- `133-tag-filter-results.png`
- `134-epub-rich-layout.png`

---

## 7. 仍未完成 / 不得误报完成

1. **小说润色质量不可靠**：曾把「第四章 春丕」润色成「第二章 准备」；已加拒绝异常结果的防线，但模型路由本身未解决。最后实测 180 秒未返回。
2. **漫画图片翻译未实现**：没有 OCR/图片翻译链路，不要把小说润色按钮当成漫画翻译。
3. **HEVC `transcode=1` 降级未实测**：华为真机硬解成功，未触发降级。
4. 漫画 PDF 仍不支持原生渲染；扫描 EPUB 已改富文本，但服务端个别 OOM 仍需独立处理。
5. AI Markdown 仍按纯文本显示；Live2D 为 Material3 降级头像。
6. WebView 遗留 `MainActivity.java`、`capabilities/`、`cvnative/` 未清理，清理前需用户确认。
7. 分发 SHA、release 签名、版本流程未在本轮处理。
8. `/api/media-source/resolve` 对次元城某个系列页曾返回「未知源」，未定位；不要把它当成在线源全链路验收通过。
9. 大量既有代码仍未提交。下一轮应先确认变更边界，再决定是否做基线提交，不能擅自全仓提交。

---

## 8. 推荐下一步顺序

1. 先让当前工作区可追踪：审查未提交文件，给用户一份「应提交 / 应忽略 / 应保留本地」的清单，经确认后处理。
2. 给小说润色选择可靠 AI 路由，并用同一章做「原文一致、非别章、非摘要、可返回」的验收。
3. 单独设计漫画图片翻译：OCR → 翻译 → 结果展示，先做只读译文层，不直接改写原图。
4. 再处理 PDF、AI Markdown、WebView 清理与 release 分发。
