# 桌面版打包说明（Electron）

把整个媒体库做成一个**双击就能用的 exe**。产物不再需要 Node、Docker、浏览器。

```
main.js                Electron 主进程 = GUI 外壳（起后端、开窗口、做菜单）
prepare-export.js      从仓库根目录抽一份「脱敏副本」到 payload/（不含个人数据/密钥）
ensure-native.js       把 better-sqlite3 换成 Electron ABI 的预编译版
prebuilt/              随仓库携带的原生模块（1.7MB，省掉联网下载 prebuild）
build/_make-icon.js    用 Playwright 渲图标 PNG；_make-ico.py 合成 .ico
build-exe.bat          一键打包
payload/               导出的应用副本（构建产物，不入库）
dist/                  最终 exe（构建产物，不入库）
```

## 一键打包

```bat
cd packaging
build-exe.bat
```

产物：

- `dist\CinemaVault-Setup-<版本>.exe` —— 安装版（NSIS），建桌面快捷方式
- `dist\CinemaVault-Portable-<版本>.exe` —— 免安装单文件

## 运行时的目录布局

```
Electron 壳（只读）
  resources/app/main.js
  resources/app/payload/         ← prepare-export.js 的产物

用户数据（可写，升级不动）
  安装版：%APPDATA%\CinemaVault\
  便携版：<exe 同级>\CinemaVault-Data\
    runtime\        ← 首次启动把 payload/ 复制到这里，之后一直跑这里
    server.log
    bin\ffmpeg.exe  ← 可选
```

**为什么必须复制一份再跑**：这个后端的数据（`db/movie.db`、`posters/`、`cache/`、
`config.json`）都是相对 `__dirname` 写的，而安装后的程序目录是只读的
（NSIS 装到 `%LOCALAPPDATA%\Programs`、便携版每次解压到随机临时目录）。
在原位跑 = 一写库就崩，或者便携版每次重启库就没了。

同步策略：`payload` 指纹（版本号 + `server.js` 大小）写在 `runtime\.build-stamp`，
不一致才重新复制，且 `config.json / db / posters / cache / data / tmp-render / backups`
**永远不覆盖**（`main.js` 里的 `PRESERVE` 集合）。

## 十个必须知道的坑

### 1. 目录不能叫 `app`

electron-builder 的约定：项目根下若有名为 `app` 的目录，**它就认定那是应用目录**，
去读那份 `package.json`。而我们的应用 `package.json` 里 `main` 是 `server.js`（后端入口），
于是打包时报：

```
⨯ Application entry file "...\resources\app\server.js" does not exist.
```

所以脱敏副本目录叫 `payload`。改名后 electron-builder 走默认（项目根即应用目录），
读到的 `main` 才是 `main.js`。

### 2. 原生模块的 ABI 必须与 Electron 对齐

Electron 33 的 `NODE_MODULE_VERSION` 是 **130**，Node 22 是 127。用错会抛
`was compiled against a different Node.js version`。

后端进程是用 Electron 自带 Node 跑的（`ELECTRON_RUN_AS_NODE=1`），所以必须是 Electron ABI。
`ensure-native.js` 用 sha256 比对，把 `prebuilt/better-sqlite3/electron-v130-win32-x64/better_sqlite3.node`
覆盖到 `payload/node_modules/better-sqlite3/build/Release/`。幂等，重复跑没副作用。

同时 `package.json` 里必须写 `"npmRebuild": false` —— 否则 electron-builder 会自作主张
重新编译原生依赖，把准备好的预编译版冲掉。

### 3. 后端进程不能直接 require 原生模块以外的 Electron API

它是 `ELECTRON_RUN_AS_NODE` 子进程，就是个纯 Node。Electron 相关的东西全在 `main.js`。
崩溃互不影响：后端挂了主进程只记日志，不会让窗口一起消失。

### 4. 反代引擎用的是 undici 全局 fetch —— 代理要走 `dispatcher`

（这是应用本身的坑，不是打包的，但第一次跑容易以为是打包问题）
`fetch(url, { agent })` 里的 `agent` 会被静默忽略，必须传 `dispatcher`。

### 5. ★ ESM-only 依赖 + Electron 内置的 Node 20.18 —— 最坑的一个

依赖里有 **ESM-only** 的包，而源码是用 CommonJS 的 `require()` 引它们的：

| 包 | 被谁 require |
|---|---|
| `cheerio@1.2.0` | `routes/movie.js`、`routes/cloud.js`、`routes/webview-proxy.js`、`utils/crawler/base.js` |
| `https-proxy-agent@9.1.0` | `routes/movie.js`、`routes/cloud.js`、`utils/crawler/base.js`、`utils/crawler/quark.js` |

`require()` 加载 ESM 需要 **Node ≥ 20.19**（那之后才默认开启 `require(esm)`）：

- Docker 容器 → Node **20.20.2** ✅ 所以一直跑得好好的
- Electron 33 内置 → Node **20.18.3** ❌ 差一点点，直接抛 `ERR_REQUIRE_ESM`

而这个 require 一崩，`server.js` 的加载链就断了，`app.listen` 和建库都不执行。
**症状极其隐蔽**：进程活着、窗口不出来、`server.log` 是 0 字节、什么都不报。

解法（`main.js` 的 `startServer()` 已内置）：给后端子进程加
`NODE_OPTIONS=--experimental-require-module`（Node 20.17 起就有这个开关，
只是 20.19 才转正成默认行为）。顺带把宿主机可能存在的 `NODE_OPTIONS` 污染一并覆盖掉。
`utils/crawler/base.js` 里还对 `https-proxy-agent` 做了 try/catch 兜底。

> 排查手法：把运行目录里的 `server.js` 拉出来手跑
> `NODE_OPTIONS=--experimental-require-module ELECTRON_RUN_AS_NODE=1 <exe> server.js`，
> 报错会直接打出来。

### 6. `files` 里的 `node_modules` 会被无条件过滤掉

不管 glob 怎么写，electron-builder 都会把 `files` 里的 `node_modules` 与
`package-lock.json` 剔掉（它认为依赖该由自己的依赖树来收集）。
结果是 `dist\win-unpacked\resources\app\payload\` 里**少 3900+ 个文件**，
exe 一启动就 `Cannot find module`。

解法：改用 **`extraResources`**（原样复制，不走 files 过滤）：

```json
"extraResources": [{ "from": "payload", "to": "payload" }]
```

对应 `main.js` 里 `PAYLOAD` 要指向 `process.resourcesPath/payload`
（**不是** `resources/app/payload`）。

### 7. GPU 进程崩溃 / Chromium 沙箱不可用 —— 都会表现成「双击闪一下就没」

GUI 子系统没有控制台，Chromium 的子进程一崩，用户什么都看不到。
两种成因、两套自愈（`main.js` 已内置）：

| 症状 | 成因 | 自愈 |
|---|---|---|
| 主进程 0.1 秒内直接死 | Chromium **沙箱**不可用（杀软 / 企业策略 / 远程桌面） | 写 `.no-sandbox` 标记 + 自动重启，之后启动带 `--no-sandbox` |
| 进程活着但永远没窗口 | **GPU** 进程崩溃（`exitCode -1073741819` = 0xC0000005）+ `ready-to-show` 不触发 | 崩溃计数落 `.software-render` 标记；窗口加 4 秒强制显示兜底 |

实测 15 组开关组合，**只有 `--no-sandbox` 能让窗口出来**；只关 GPU 沙箱的各种组合
（`--disable-gpu-sandbox` / `--in-process-gpu` / `--use-gl=swiftshader` …）全部无效。
为了不牺牲正常机器的安全性，默认**不开** `--no-sandbox`，靠自愈机制兜。

排查工具：`_test-flags.py`（批量试开关）、`_verify.py`（模拟陌生人首次双击）、
`_probe2.py`（起进程读启动日志）、`_run-server.py`（单独跑后端）。
启动日志落在 `%TEMP%\cinemavault-boot.log`，用户报「打不开」时让他发这个文件即可。

### 8. winCodeSign 解压失败（非管理员身份）

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权 ... libcrypto.dylib
```

electron-builder 下载的 `winCodeSign` 包里含 **macOS 符号链接**，非管理员解压会失败。
绕法：用 `7za x -x!darwin` 手动解压，把内容放进
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\2.6.0\`
（老版本还会找 `winCodeSign-2.6.0\`，两个名字都放一份最省事）。

### 9. 打包报 `remove ...\dist\win-unpacked\CinemaVault.exe: Access is denied`

```
⨯ remove D:\...\packaging\dist\win-unpacked\CinemaVault.exe: Access is denied.
github.com/develar/go-fs-util.EnsureEmptyDir
⨯ app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
```

**不是权限问题，是文件被占用** —— electron-builder 要先清空 `dist\win-unpacked\`，
而里面那个 `CinemaVault.exe` 正在运行（最常见的情况：你自己刚用它跑过测试后端，
比如 `packaging/_serve-desktop.py` / `_launch-exe.py` 就是直接跑这个文件的）。

修法：打包前先 `taskkill /IM CinemaVault.exe /F`。**测 exe 和打包不要同时进行。**

（顺带一个迷惑点：报错里那串 Go 堆栈来自 app-builder 内部，
会让人以为是 Go 工具链或镜像有问题，其实是它删不掉文件。）

### 10. 源码备份 `*.bak-nr` 被顺手打进安装包

实测：`public/js/app.js.bak-nr`（316KB，改代码前留的档）和 `public/css/polish.css.bak-nr`
跟着 exe 发到了用户机器上。`prepare-export.js` 的白名单是「整目录复制」，
所以目录里任何手工备份都会被一起带走。

已加 `JUNK_RE` 过滤（`*.bak` / `*.bak-*` / `*.old` / `*.orig` / `*~` / `*.log` / `*.repair`）。
**往白名单加新目录之前，先确认里面没有留档文件。**

## 换 Electron / better-sqlite3 版本

1. 改 `package.json` 的 `devDependencies.electron` 与 `prebuilt/…` 目录名里的 ABI。
2. 取对应 ABI 的预编译包：
   ```bash
   npx prebuild-install -r electron -t <electron版本> -a x64 --platform win32 \
       --prefix payload/node_modules/better-sqlite3
   ```
   或直接下载 `better-sqlite3-v<ver>-electron-v<abi>-win32-x64.tar.gz` 解到
   `prebuilt/better-sqlite3/electron-v<abi>-win32-x64/`。
3. 重跑 `ensure-native.js`。

## 网络

打包全程走国内镜像，不需要科学上网：

- Electron 运行时：`build.electronDownload.mirror` → `registry.npmmirror.com/-/binary/electron/`
- electron-builder 的 nsis / winCodeSign：环境变量
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`
  （`build-exe.bat` 里没设，走默认 GitHub；网络不通时手动加上）

## 已知限制

- 只出 **Windows x64**（要 Linux / macOS 需自行加 target，且 `better-sqlite3` 预编译包要换平台）。
- 不含 Chromium：依赖 Playwright 的刮削源（Cloudflare 站）在桌面版不可用，其余源正常。
- 不含 ffmpeg：把 `ffmpeg.exe` / `ffprobe.exe` 放进数据目录的 `bin\` 即可启用截帧与时长识别。

## 发布到 GitHub（维护者用）

仓库：`https://github.com/INORIergai/local-acgn-app`（公开）。仓库内容来自 `publish/`，
Release 附件来自 `dist/` 里的 exe。

```bash
# 1) 生成脱敏副本（会自动扫描敏感信息，命中就中止）
node packaging/make-public.js

# 2) 推仓库内容（走 REST API，不是 git push）
python packaging/_r23-publish.py check   # 先看看要推什么，不写远端
python packaging/_r23-publish.py push

# 3) 建 Release 并上传 exe（幂等：release 或附件已存在会自动跳过）
python packaging/_r23-release.py
```

### 为什么不用 `git push`

本机 `github.com:443` 不稳定（`ls-remote` 实测超时 21 秒），但 `api.github.com` 直连正常、
`uploads.github.com` 走系统代理正常。所以改用 GitHub REST API 完成同样的动作。

### 凭据从哪来

Windows 凭据管理器里存着 `git:https://github.com`（40 位 `ghp_`，scope=repo）。
两个脚本都用 `git credential fill` 非交互取值（stdin 传 `protocol=https\nhost=github.com\n\n`，
读 `password=` 那一行），**不落盘、不写环境变量**。

### ★ 关键设计：用「孤儿 commit」而不是 force push

`POST /git/commits` 故意**不带 `parent`**，于是新提交没有祖先 —— 旧提交从分支上彻底不可达。
`git push --force` 只是移动分支引用，旧 commit 仍能靠 SHA 从 `raw.githubusercontent.com` 拉到，
**等于没清干净**。（2026-09-24 就是用这招撤掉了一个含 `config.json` / 内网 IP 的旧提交。）

> 记住：**不可达 ≠ 已被 GitHub GC**。要彻底消除泄露，删仓库重建最干净。

### 上传注意

- 100MB 级附件走系统代理，**实测 >20 分钟**，别以为卡死了。
- 代理会偶发 `RemoteDisconnected`：脚本对 `0 / 429 / 5xx` 退避重试 5 次，并发压到 4。
