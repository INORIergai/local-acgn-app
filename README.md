<p align="center">
  <img src="packaging/build/icon-128.png" width="128" height="128" alt="Cinema Vault">
</p>

<h1 align="center">Cinema Vault · 午夜场</h1>

<p align="center">
  <b>本地优先的私人媒体库</b>：影片 / 动漫 / 漫画 / 小说四合一。<br>
  自动扫描、多源刮削元数据与海报，自带网页播放器、漫画 / 小说阅读器、播放列表、新作监视、年度报告。
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Docker%20%7C%20Node-lightgrey.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg">
</p>

界面是原生 HTML/CSS/JS（无前端框架），后端 Node + SQLite，**数据全部留在本机**，不上传任何服务器。

> ⚠️ 本项目仅供管理**你自己合法拥有**的本地媒体文件。请遵守你所在地区的法律法规。

---

## 目录

- [三种跑法](#三种跑法) —— 桌面版 exe（推荐）/ Docker / 本地 Node
- [访问密码](#访问密码可选默认关闭)
- [打不开怎么办](#打不开怎么办)
- [功能一览](#功能一览)
- [可选依赖](#可选依赖)
- [从源码打包桌面版](#从源码打包桌面版)
- [目录结构](#目录结构)
- [配置](#配置)
- [卸载 / 清理](#卸载--清理)
- [License](#license)

---

## 三种跑法

### 一、桌面版 exe（推荐，最省事）

到 [Releases](../../releases) 下载：

| 文件 | 说明 |
|---|---|
| `CinemaVault-Setup-x.y.z.exe` | **安装版（推荐）**：装一次，桌面快捷方式双击秒开 |
| `CinemaVault-Portable-x.y.z.exe` | 免安装单文件，双击即用，数据存在 exe 同级的 `CinemaVault-Data\` |

> 便携版每次启动都要把约 90MB 的运行时解压到临时目录，**首次打开要等 20 秒上下**
> （安装版没有这一步，装好后是秒开）。图省事就选安装版，要绿色免安装就选便携版。

**不需要装 Node、不需要 Docker。** 首次启动会自动建库，**默认不设密码，打开就能用**。
之后到「设置 → 📂 扫描路径」添加你的媒体文件夹，点扫描即可。

数据位置（升级程序不会动它们）：

- 安装版：`%APPDATA%\CinemaVault\`
- 便携版：与 exe 同级的 `CinemaVault-Data\`

### 访问密码（可选，默认关闭）

默认**不需要密码**。如果你会用手机通过局域网访问，建议打开它：

> **设置 → 🔒 安全与通知 → 勾选「进入影库需要输入密码」→ 填一个至少 4 位的密码 → 保存**

- 打开后，影片 / 动漫 / 漫画 / 小说**四个库统一都要先登录**（登录一次记 30 天）
- 关闭后，同一局域网内任何人都能直接打开影库、观看和改设置。家里自用没问题；
  **一旦把本机端口暴露到公网，务必打开**
- 忘记密码：删掉数据目录里 `runtime/config.json` 的 `auth` 段，重启即恢复免密。
  桌面版菜单「文件 → 打开配置 config.json」可以直接打开这个文件

### 打不开怎么办

桌面程序没有控制台，出问题不会弹错误信息。应用内置了两道自愈：

- **首次启动闪一下就没了** → 说明本机 Chromium 沙箱不可用（第三方杀软 / 企业安全策略 /
  远程桌面环境常见）。程序会自己记下来并在下次启动自动改用 `--no-sandbox`，**再双击一次即可**。
- **窗口一直不出现** → 会自动关掉硬件加速重试。

如果还是不行，把 `%TEMP%\cinemavault-boot.log` 发到 Issue，里面记着每一步的启动状态。
想手动指定，可以设置环境变量 `CV_NO_SANDBOX=1` / `CV_SOFTWARE_RENDER=1`。

### 二、Docker

```bash
cp config.example.json config.docker.json   # 填入媒体目录挂载点
docker compose up -d --build
```

### 三、本地 Node（≥ 18）

```bash
npm install
cp config.example.json config.json          # 填入扫描路径
node server.js
```

---

## 功能一览

- **影片 / 动漫库**：海报墙、详情抽屉、多源刮削（javbus / javdb / jav321 / netflav / onejav / jable / jdmenu / TMDB / AniList …）、批量海报修复、播放进度记忆
- **漫画 / 小说库**：目录树分栏、章节横滑阅读器、PDF / EPUB 封面自动兜底
- **在线观看**：内置整站反向代理，把外部站的首页、搜索、详情、播放全部搬进应用内（含 Cloudflare 站点的浏览器通道）
- **新作监视**：女优 / 漫画系列更新追踪，封面本地落盘
- **年度报告**：面积图 / 气泡图 / 比例条等可视化
- **高度自定义**：主页与 Banner 背景图、侧栏收缩、海报比例、播放器大小位置
- **单代码库响应式**：桌面 / 平板 / 手机同一份代码，媒体查询全适配
- **服务端会话鉴权**：httpOnly cookie + 30 天会话，页面与 API 双层拦截

## 可选依赖

| 依赖 | 作用 | 不装会怎样 |
|---|---|---|
| `ffmpeg` / `ffprobe` | 视频截帧取封面、读取时长与分辨率 | 该功能不可用；其余照常 |
| Chromium（Playwright） | 通过 Cloudflare 人机验证的站点抓取 | 这类源的刮削失败，其余源照常 |

桌面版启用 ffmpeg：把 `ffmpeg.exe`、`ffprobe.exe` 放进数据目录的 `bin\` 子目录，下次启动自动生效。

---

## 从源码打包桌面版

```bat
cd packaging
build-exe.bat
```

产物在 `packaging\dist\`。脚本会自动：生成脱敏应用副本 → 装好 Electron ABI 的原生模块 →
调用 electron-builder 出安装版与便携版。

打包细节、目录结构、以及几个必踩的坑（原生模块 ABI、只读目录、升级同步）见
[`packaging/README.md`](packaging/README.md)。

## 目录结构

```
server.js              Express 入口
routes/                API 路由
utils/                 扫描器 / 刮削器 / 数据层
public/                前端（原生 HTML/JS/CSS）
db/schema.sql          建库脚本（首次启动自动执行）
host/                  Windows 宿主协议处理器
packaging/             桌面版打包（Electron 壳 + 打包脚本）
```

## 配置

复制 `config.example.json` 为 `config.json`（本地 / 桌面版）或 `config.docker.json`（容器），
填入扫描路径等。访问密码也在这里（`auth` 段，**留空即免密**）。
**真实配置与个人数据都已被 `.gitignore` 排除，请勿提交。**

首次启动会自动执行 `db/schema.sql` 建空库，不需要手动初始化。

## 卸载 / 清理

| 方式 | 怎么卸干净 |
|---|---|
| 桌面版（安装版） | 从「设置 → 应用」卸载。数据默认**保留**在 `%APPDATA%\CinemaVault\`，想彻底清掉就手动删这个目录 |
| 桌面版（便携版） | 直接删掉 exe 和同级的 `CinemaVault-Data\`。便携版不写注册表、不留残余 |
| Docker | `docker compose down -v`，再手动删 `db/ posters/ cache/` |
| 本地 Node | 删掉项目目录即可（数据都在 `db/ posters/ cache/` 里） |

## License

MIT
