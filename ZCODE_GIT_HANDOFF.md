# CinemaVault 安卓最终版 · ZCode Git 化与提交交接

> 交接时间：2026-11-21
> 用途：让 ZCode 把当前安卓原生版安全整理进 Git 并提交到项目仓库。
> 这不是继续开发的通知书。先整理、验证、提交，不要顺手改功能。

---

## 1. 项目位置与仓库事实

```text
项目根目录：D:\ai program\local-movie-library
安卓工程：D:\ai program\local-movie-library\android
当前分支：main
远端名称：origin
远端仓库：https://github.com/INORIergai/local-acgn-app.git
当前 HEAD：9ddd5f2
```

交接时本地引用显示：

```text
origin/main...HEAD = behind 12 / ahead 9
```

即：**本地有 9 个未推送提交，同时远端多 12 个本地没有的提交。**
禁止直接强推，禁止在不了解远端改动时 rebase 或覆盖 main。

最近本地提交：

```text
9ddd5f2 refactor(frontend): P0 加固 —— XSS 收敛、统一请求层、竞态保护、首屏资源合并
7235eb3 feat(android): 五库标签筛选与 EPUB 富文本阅读
d1baae6 fix(android): 播放控制条隐藏时标题同步淡出
427e5c7 fix(android): 听书可停止 + 手机端可选音色
391e23d fix(android): 主题切换即时生效并持久化
ab76538 fix(dev): 穿透脚本自动探测端口 + 新增带端口启动的桌面版拉起脚本
e917120 chore(dev): 桌面版同步脚本改为「前端全量 + 后端 + 安装包」同步
a95c5f3 feat(v4.6.0): 安卓端安全加固 + 首屏提速 + release 签名
4f5d32b v4.5.4：局域网访问修复（手机打不开）
```

工作区交接时有 **722 条状态记录**，既有源码，也有临时脚本、文档、第三方目录、APK、测试配置和运行数据。**当前目录不是可直接 `git add -A` 的干净交付物。**

---

## 2. 本次要 Git 化的安卓能力基线

当前为 Compose 全原生 v5.0.0，不再以 WebView 为入口。已经存在的主要能力：

- 首页、影剧、书架、AI 伴侣、追番、播放器与听书
- 主题即时切换并持久化
- 听书合成中/播放中可停止，通知栏可停止，fishaudio 音色手机端切换
- H.264 横屏全屏播放、标题自动淡出与触摸恢复、HEVC 硬解
- 影剧/漫画/小说标签搜索与且/或组合筛选
- EPUB 富文本阅读（段落、表格、内嵌图片）
- 小说机翻润色入口与异常结果防线

不要把下面几项写进「已完成」：

- 小说润色质量仍受 AI 路由影响，曾答非所问，最后实测长时间未返回
- 漫画图片翻译尚未实现
- HEVC `transcode=1` 降级路径未触发验证
- 漫画 PDF 原生渲染、AI Markdown、WebView 遗留清理、正式发布链未全部完成

完整开发交接见同目录 `ANDROID_NATIVE_HANDOFF.md`。

---

## 3. 必须入库的源码范围（按依赖审查，不是照单全收）

### 安卓核心

```text
android/app/src/main/java/cn/cinemavault/app/**.kt
android/app/src/main/java/cn/cinemavault/app/MainActivity.java
android/app/src/main/AndroidManifest.xml
android/app/src/main/res/**
android/app/src/main/assets/**       # 先检查是否含大文件、密钥、缓存
android/app/build.gradle
android/build.gradle
android/settings.gradle
android/gradle.properties            # 先审查内容
android/gradle/**                    # wrapper 配置与版本目录需要，构建缓存不需要
android/gradlew
android/gradlew.bat
```

重点：许多 Kotlin 文件此前是 untracked，只有部分修复文件进过提交。必须确认 **NativeActivity、CvApplication、data/model、data/repo、playback、ui/theme、ui/screen 等完整源码都进入版本控制**，否则别人 clone 后无法构建。

### 安卓依赖的服务端/前端改动

按实际依赖审查，不要因为目录大就整目录提交：

- `routes/novel.js`：EPUB 章节、资源、润色接口与异常防线
- `routes/tts.js`、`utils/tts/**`：如当前 App 依赖的变化尚未入库才纳入
- `utils/db.js` / `db/schema.sql`：标签接口和数据库结构若依赖变化则纳入
- `public/**`：只提交项目运行需要且明确属于本次交付的源文件，不提交临时副本

### 文档

可选择纳入：

- `ANDROID_NATIVE_HANDOFF.md`
- `CLAUDE_ANDROID_PROMPT.md`
- `ZCODE_GIT_HANDOFF.md`
- `ZCODE_COMMIT_PROMPT.md`

其他 `docs/`、`docs/reports/` 下的 300+ 未跟踪文件必须逐个判断，不得全目录加入。

---

## 4. 明确禁止入库

### 密钥与登录态

```text
config.json
config.test.json                  # 可能含测试口令，先视为敏感
.env / .env.*
**/*cookie*.json
android/keystore.properties
android/keystore/**
*.jks / *.keystore
android/local.properties
```

**额外警告：`docs/DELIVERY_VERIFICATION.md` 含明文访问密码。** 不得原样公开推送；如确需入库，先去敏并复查，或者保持本地不提交。

任何报告、日志、配置示例若含真实 API Key、Token、Cookie、密码，也只能去敏后入库。输出日志时不要打印这些值。

### 构建产物与本地运行数据

```text
*.apk                              # 含根目录现有两个 APK
android/build/
android/app/build/
android/.gradle/
node_modules/
cache/
data/
exe/
archive/
runtime/
```

APK 不进 Git 历史。需要分发时走 GitHub Release 附件，另行经用户确认。

### 临时/第三方/代理工作区

下列目录不得默认提交，除非用户明确说要：

```text
.acl-recovery/
.agents/
.workbuddy/
.zcode/
.v2c/
.backup-css-20261113-095858/
animeko-main/
```

还有根目录大量 `_*.cjs`、一次性 benchmark、备份脚本、烟雾测试脚本。`.gitignore` 已忽略根目录 `/_*`，不要强行添加。

### 删除项

`LICENSE` 和 `README.md` 当前显示 deleted。**不得擅自提交删除。** 先确认是用户有意删除还是整理时误删；无法确认就保留现状并在报告中单独列出。

---

## 5. 推荐执行顺序

### A. 只读审查

```bash
cd "D:/ai program/local-movie-library"
git status -sb
git log --oneline -12
git diff --stat
git status --short
```

产出一张分类清单：拟提交、忽略、本地保留、待用户确认。不要一上来修改文件。

### B. 先补忽略规则，再暂存

审查现有 `.gitignore`，确需补充时只加明确规则。不要凭 `.gitignore` 已忽略就放松检查，必须用：

```bash
git status --short
git diff --cached --name-only
```

确认暂存区不含敏感文件和产物。

### C. 构建验证

```bat
cd /d "D:\ai program\local-movie-library\android"
set JAVA_HOME=D:\apps\jdk-21
gradlew.bat assembleDebug
```

另对改动的 Node 文件跑 `node --check`。构建产物只用于本地验证，不入库。

### D. 分批提交

建议按逻辑分批，而不是一个巨型 commit：

1. `feat(android): 原生客户端完整源码基线`
2. `feat(android): 标签、EPUB、播放与听书配套服务端能力`（仅未入库的依赖）
3. `docs: 安卓原生版交接与验收记录`（先去敏）

如果某些脏文件属于此前的桌面/网页工作，无法确认边界，就不要混入安卓提交，单独列给用户。

### E. 处理远端分叉

先：

```bash
git fetch origin
git rev-list --left-right --count origin/main...HEAD
git log --oneline HEAD..origin/main
```

- **禁止 `git push --force` / `--force-with-lease` 直接解决分叉。**
- 若仍 behind，不要自行 merge/rebase 这 9 个本地提交；先展示远端新增 12 个提交并询问用户。
- 更稳妥的默认方案：新建 `android-native-v5-handoff` 分支并推送该分支，让用户在 GitHub 上审查/合并，不直接推 main。

---

## 6. 最终验收标准

只有全部满足才能报告完成：

- [ ] 安卓完整源码已被 Git 跟踪，不只是四笔修复文件
- [ ] 工作区敏感文件、APK、构建目录、运行数据均未进入暂存区
- [ ] `git diff --cached --check` 通过
- [ ] `gradlew.bat assembleDebug` 成功
- [ ] 改动 Node 文件 `node --check` 通过
- [ ] 没有擅自删除 LICENSE/README，没有吞并不明第三方目录
- [ ] 没有强推；远端分叉已向用户说明
- [ ] 报告 commit hash、分支名、推送结果、未提交文件清单
- [ ] 能给出仓库/分支链接，且用户知道下一步是合并还是继续开发

如果任何一项不满足，报告「部分完成」，不要写「已安全提交全部交付」。
