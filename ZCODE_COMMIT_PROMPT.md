# 给 ZCode 的提交提示词

你这次只负责把 CinemaVault 安卓最终版安全 Git 化并提交，**不继续开发功能**。

先完整阅读：

1. `D:\ai program\local-movie-library\ZCODE_GIT_HANDOFF.md`
2. `D:\ai program\local-movie-library\ANDROID_NATIVE_HANDOFF.md`
3. 当前 `git status -sb`、`git diff --stat`、`.gitignore`

项目根目录：`D:\ai program\local-movie-library`
远端：`origin = https://github.com/INORIergai/local-acgn-app.git`

## 当前事实（先核实，不要盲信）

- 交接时 HEAD 是 `9ddd5f2`，分支 main
- 本地相对 origin/main 为 ahead 9 / behind 12
- 工作区有 722 条变更，含大量临时文件、第三方目录、未跟踪源码与敏感配置
- 许多安卓 Kotlin 文件仍未跟踪，必须让完整原生工程入库，不能只提交修复补丁

如果实际状态不同，先停下来报告差异。

## 绝对禁令

1. 禁止 `git add -A`、`git add .`、`git commit -am` 一次性吞掉整个工作区。
2. 禁止 `git reset --hard`、`git clean -fd`、整仓 checkout。
3. 禁止 `git push --force` 或用 force-with-lease 覆盖 main。
4. 禁止擅自 rebase/merge 这 9 个本地提交来解决远端分叉。
5. 禁止提交任何 APK、构建目录、node_modules、运行数据、Cookie、密钥、签名文件。
6. 禁止原样提交 `config.json`、`config.test.json`、`android/keystore.properties`、`android/keystore/`、`android/local.properties`。
7. `docs/DELIVERY_VERIFICATION.md` 含明文访问密码，禁止原样公开推送。
8. 不擅自提交 LICENSE 与 README 的删除；先询问。
9. 不默认提交 `animeko-main/`、`.acl-recovery/`、`.agents/`、`.workbuddy/` 等第三方或代理目录。
10. 不在回复或日志里打印任何密钥、Token、Cookie、密码。

## 执行步骤

### 第一步：只读分类

先输出四张清单，不修改文件：

- 拟提交源码
- 应忽略的构建/运行产物
- 敏感文件
- 无法判断、需要我确认的文件

安卓至少检查这些是否完整纳入：

```text
NativeActivity.kt / CvApplication.kt
data/api / data/model / data/prefs / data/repo
playback/
ui/theme / ui/screen
AndroidManifest.xml / res / assets（先审查）
Gradle 构建脚本与 wrapper
```

PC 端只纳入安卓实际依赖且尚未入库的变化，不做全目录提交。

### 第二步：给忽略规则补丁

只对确需补充的明确规则提出 `.gitignore` 修改，先给我看 diff。
不要通过删除文件来让状态好看；本地保留不等于删除。

### 第三步：暂存与检查

分批 `git add <明确路径>`，每批后执行：

```bash
git diff --cached --name-only
git diff --cached --stat
git diff --cached --check
```

再做敏感文件名和内容检查。发现任何敏感内容立即取消暂存并告诉我，不要靠重写历史补救。

### 第四步：验证

```bat
cd /d "D:\ai program\local-movie-library\android"
set JAVA_HOME=D:\apps\jdk-21
gradlew.bat assembleDebug
```

改动的 Node 文件逐个 `node --check`。失败就停止提交，报告真实错误。

### 第五步：分批提交

建议：

1. 安卓完整源码基线
2. 安卓所需服务端配套
3. 去敏后的交接文档

每批只含相关文件，不把不明桌面/网页改动混入。

### 第六步：处理远端

```bash
git fetch origin
git rev-list --left-right --count origin/main...HEAD
git log --oneline HEAD..origin/main
```

如果仍 behind：

- 不直接推 main，不强推，不自行 rebase/merge
- 优先新建 `android-native-v5-handoff` 分支并推送该分支
- 把远端新增提交列出来，让我决定后续合并方式

## 交付报告

最后报告：

1. 每批 commit hash 与包含范围
2. 构建/语法检查结果
3. 推送的分支与仓库链接
4. 未提交文件分类清单，尤其敏感文件与无法判断的文件
5. 是否存在远端分叉、下一步需要我做什么

只要验证未完成、敏感文件未排清或分叉未处理，就写「部分完成」，不要写「全部安全提交」。
