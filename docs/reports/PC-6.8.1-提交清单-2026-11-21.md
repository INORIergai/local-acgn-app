# PC 6.8.1 提交清单（2026-11-21）

给 zcode 的提交说明。本轮只做 **Windows Electron 桌面版（EXE）**，未改 `android/`。
版本号已在本工作区改为 **6.8.1**。

---

## 1. 当前状态

- 分支：`android-native-v5-handoff`
- 本地 `main` 最新：`9ddd5f2`（P0 加固）
- 远端 `origin/main` 最新：`db64349`（v6.8.0 发布快照；由 `_r23-publish.py` 以孤儿提交方式替换，不是普通 merge 关系）
- 分支在本地 main 之上已有两个安卓提交：`b341c18`、`e17c0c1`
- 本轮修改**全部未提交**，共 10 个文件（见下表）

### 需要提交的文件

| # | 文件 | 内容 |
| --- | --- | --- |
| 1 | `public/js/app.js` | P1：轮询治理、卡片事件委托 |
| 2 | `packaging/main.js` | 桌面壳：窗口状态、托盘、全局快捷键、防息屏、后端自愈、开机自启 |
| 3 | `package.json` | 版本 6.8.1 |
| 4 | `package-lock.json` | 版本 6.8.1 |
| 5 | `packaging/package.json` | 版本 6.8.1 |
| 6 | `packaging/package-lock.json` | 版本 6.8.1 |
| 7 | `packaging/_r23-release.py` | `VER/TAG` → 6.8.1，Release 正文改为 6.8.1 |
| 8 | `packaging/_r23-publish.py` | `TAG` → v6.8.1，提交说明改为 6.8.1 |
| 9 | `docs/reports/前端功能诊断与改进建议-2026-11-21.md` | P0/P1 实施记录（含 9.5–9.7 桌面批次） |
| 10 | `docs/reports/PC-6.8.1-提交清单-2026-11-21.md` | 本文件 |

### 明确不要提交

- `config.json`、`config.test.json`（含真实 TMDB/AI Key、kmoe Cookie）
- `android/`（用户会单独处理）
- `packaging/dist/`、`packaging/payload/`、`exe/`、`git/`（构建产物/发布镜像）
- `.workbuddy/`、`docs/reports/*.png`（个人记录/截图）
- 根目录里其余大量 `M` 文件（CSS/旧脚本等基线改动，不是本轮产物）
- `docs/handoff/mobile-*.md` 里的 `6.8.0` 字样属于安卓交接文档，本次未改；如需同步桌面版本号，另行提交

---

## 2. 提交前检查

```bash
cd "D:/ai program/local-movie-library"
git branch --show-current        # 应为 android-native-v5-handoff
git status --short               # 确认下列 10 个路径的状态
git diff --check                 # 检查空白错误
```

CRLF 提示说明：仓库 `core.autocrlf=true`，`git add` 时会把索引里的行尾规范成 LF，
工作区仍是 CRLF，属正常现象；**不要**执行 `git add --renormalize .`。

`package.json` / `package-lock.json` / 两个 `_r23` 脚本里除了本轮版本号，还有工作区基线
（4.5.4 → 6.8.0、`qrcode` 依赖等）。这些是 6.8.0 发布后遗留的未提交内容，本次一起提交；
不要用 `git add -A` 把仓库里其它改动扫进来。

---

## 3. 建议提交顺序（4 个提交）

### 提交 1：前端 P1

```bash
git add -- public/js/app.js
git commit -F - <<'MSG'
perf(frontend): 轮询治理与卡片事件委托

- 页面隐藏时暂停高频轮询，回到前台立即补刷
- 扫描状态空闲时降到 10s 一次，扫描中保持 1.5s
- 卡片点击/悬停改为容器级事件委托，嵌套容器只处理一次
- 500 张卡渲染+绑定约 139ms；不再写 __clickBound
MSG
```

### 提交 2：桌面壳

```bash
git add -- packaging/main.js
git commit -F - <<'MSG'
feat(desktop): 托盘、全局快捷键、窗口状态与后端自愈

- 关闭到托盘 + 托盘菜单 + 首次气泡提示
- Ctrl+Shift+Space 切换窗口，被占用时回退 Ctrl+Shift+F12（首次提示一次）
- 记住窗口位置/大小/最大化/缩放，副屏拔插保护
- 全屏播放阻止显示器息屏，暂停/关窗释放
- 后端异常退出退避重启，稳定 10 分钟重置额度；失败弹窗可手动重启
- 可选开机自启（--hidden 静默驻留托盘）
- 新增 CINEMAVAULT_USER_DATA 排障变量（用于多实例/打包验证）
MSG
```

### 提交 3：版本 6.8.1

```bash
git add -- package.json package-lock.json packaging/package.json packaging/package-lock.json \
  packaging/_r23-release.py packaging/_r23-publish.py
git commit -F - <<'MSG'
chore(release): 6.8.1 版本号与发布说明

- 两份 package.json / package-lock.json 同步到 6.8.1
- _r23-release.py、_r23-publish.py 的 VER/TAG 与正文改为 6.8.1
MSG
```

### 提交 4：文档

```bash
git add -- "docs/reports/前端功能诊断与改进建议-2026-11-21.md" \
  "docs/reports/PC-6.8.1-提交清单-2026-11-21.md"
git commit -F - <<'MSG'
docs: 6.8.1 桌面改进记录与提交清单
MSG
```

### 只提交一次（可选）

如果不想拆成 4 个提交：

```bash
git add -- public/js/app.js packaging/main.js \
  package.json package-lock.json packaging/package.json packaging/package-lock.json \
  packaging/_r23-release.py packaging/_r23-publish.py \
  "docs/reports/前端功能诊断与改进建议-2026-11-21.md" \
  "docs/reports/PC-6.8.1-提交清单-2026-11-21.md"

git commit -F - <<'MSG'
feat: 6.8.1 桌面端体验与首屏性能

- 托盘 / 关闭到托盘 / 全局快捷键（Space 被占用回退 F12）
- 窗口位置、大小、最大化、缩放持久化
- 播放时阻止显示器息屏
- 后端崩溃自愈与失败手动重启
- 可选开机自启（--hidden 驻留托盘）
- 前端轮询治理、卡片事件委托
- 版本号与发布脚本更新到 6.8.1
MSG
```

### 提交后核对

```bash
git status --short
git log --oneline -5
git show --stat --oneline HEAD~3..HEAD
```

暂存区核对（每个提交前可先跑）：

```bash
git diff --cached --name-only
```

应只出现上述 10 个文件，不能出现 `config*.json`、`android/`、`dist/`、`payload/`。

---

## 4. 提交与「进主线」怎么走

这个项目的远端 `main` 不是用普通 PR/merge 维护的：

- 开发仓库本地有完整历史（含安卓、P0/P1）；
- 发布时由 `packaging/_sync-public.py` 把开发树同步到 `git/` 镜像；
- `packaging/_r23-publish.py push` 再用**无父提交的孤儿 commit** 替换远端 `main` 的内容（远端历史每次是一条快照提交）。

所以：

1. **先在本分支提交**（第 3 节的 4 个提交），这是开发历史；
2. **发布会走第 6 节的 sync + publish**，这才相当于「进主线」；
3. 不要对远端 `main` 开普通 PR 期待 merge——两边的历史没有共同基准。

### 关于安卓提交

当前分支已包含 `b341c18`、`e17c0c1` 两个安卓提交。`_sync-public.py` 以 `git ls-files`
为准同步，会把已跟踪的 `android/` 一起带进发布镜像。

- 如果 6.8.1 打算**只发 PC**：先在 dry-run 里确认 `git/` 会不会多出安卓文件；必要时不要在当前分支直接发布，
  改用只含 PC 提交的临时分支（见下）；
- 如果安卓也在本次公开范围内：按正常流程发布即可。

只带 PC 提交的临时分支：

```bash
git checkout -b release/pc-6.8.1 <提交4的sha>
# 若该分支仍包含 android/，用 git rm -r --cached android 后再提交一次
git log --oneline -6
```

> 不要 force push 远端 main；发布脚本自己做快照替换，失败时重跑脚本即可。

---

## 5. 打包验证（6.8.1）

先完全退出正在运行的 6.8.0（旧版没有托盘，关闭主窗口即退出），否则 `runtime` 文件会被占用。

```bash
cd "D:/ai program/local-movie-library/packaging"
node prepare-export.js
npm run dist
```

产物：

- `packaging/dist/CinemaVault-Setup-6.8.1.exe`
- `packaging/dist/CinemaVault-Portable-6.8.1.exe`

启动便携版后逐项确认：

1. 托盘出现，点 × 后窗口隐藏、进程仍在；
2. 托盘左键单击恢复窗口，右键菜单可打开数据文件夹/重启后端/退出；
3. `Ctrl+Shift+Space` 或回退的 `Ctrl+Shift+F12` 能切换窗口；
4. 拖动/最大化/缩放后重启，窗口状态恢复；
5. 播放视频时不息屏（电源计划到点不黑屏），暂停后恢复；
6. 菜单「文件 → 开机自动启动」可勾选，重启系统后只驻留托盘。

无显示器/无人值守环境可跳过第 5、6 项的人工观察，以日志为准：
`%TEMP%\cinemavault-boot.log` 中应出现「系统托盘已创建」「全局快捷键已注册」。

---

## 6. 发布 6.8.1（可选，按需执行）

```bash
cd "D:/ai program/local-movie-library"
python packaging/_sync-public.py            # 先 dry-run 看差异
python packaging/_sync-public.py --apply --prune
python packaging/_r23-publish.py check
python packaging/_r23-publish.py push
python packaging/_r23-release.py
```

注意：

- `_r23-publish.py` / `_r23-release.py` 从 `git credential` 取 GitHub Token，不要把 token 写进任何文件；
- 发布前确认 `packaging/dist/` 里是 **6.8.1** 的两个 exe；
- `_r23-release.py` 会创建 `v6.8.1` Release 并上传安装版 + 便携版；
- `git/` 是发布镜像目录，不要把它提交进开发仓库。

---

## 7. 回滚

未推送时：

```bash
git reset --soft HEAD~4     # 保留改动，撤销 4 个提交
```

已推送但未发版时：

```bash
git revert --no-edit <提交4> <提交3> <提交2> <提交1>
```

已发版：不要删除 Release/tag 来「回滚」；新增一个 6.8.2 修复版本更安全。

---

## 8. 本轮验证记录（供 review 参考）

- `node --check packaging/main.js`、`node --check public/js/app.js`、`node --check server.js` 通过；
- Electron 38 探针：`powerSaveBlocker` 启停正常，`media-started-playing` / `media-paused` 均触发，登录项写入/取消正常；
- 打包版 `--dir` 冒烟：`--hidden` 启动可见窗口 0、托盘创建、`Ctrl+Shift+F12` 唤出主窗口；正常启动可见窗口 1、日志无 `!!!`；
- P1 实测：隐藏页面 3.2s 内扫描轮询 0 次；500 张卡渲染+委托绑定约 139ms。
