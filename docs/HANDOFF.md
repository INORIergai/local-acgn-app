# 交接文档 · 本地影库（D:\ai program\local-movie-library）

> 更新时间：2026-09-19。给接手的 agent：**先读完这份，再去看技能文档**（下面第 0.3 节），别从零开始诊断。
>
> ⚠️ **发版/增量更新相关**请看专门的 [增量更新 · 签名密钥与发版交接](增量更新-签名密钥与发版交接.md)：签名私钥位置、换钥风险、patch 生成与验签约定、发版必须真 GUI 启动的验收铁律（v6.8.3 曾因模块未打包导致启动崩溃）。

---

## 0. 30 秒上手

### 0.1 怎么跑

```bash
cd "D:/ai program/local-movie-library"
docker compose restart          # 改 JS/CSS/路由后：restart 生效
docker compose up --detach      # 改 Dockerfile / package.json 后：重新 build 再 up
docker compose build            # 改镜像（如加浏览器）才需要，约 5-10 分钟
```

- 容器名 `local-movie-library`，宿主 **3002 → 容器 3000**，项目目录 bind mount 到 `/app`
- 配置真身：`config.docker.json`（**不是**根目录的 config.json），容器里 `CONFIG_FILE=/app/config.docker.json`
- 登录口令在 `config.docker.json` 的 `auth.password`（脚本用它自动登录，**别打印出来**）
- 局域网：`http://192.168.31.143:3002`

### 0.2 前端缓存

`public/library.html` 里三个资源带版本号，改完前端就 **+1**；告诉用户 **Ctrl+F5**。当前是 `?v=25`：

```html
<link rel="stylesheet" href="css/style.css?v=25">
<script src="js/app.js?v=25"></script>
<script src="js/features.js?v=25"></script>
```

### 0.3 先读这些（技能里已有大量沉淀，别重复诊断）

- 技能 `local-media-library-maintenance`：
  - `references/project-state.md` — 文件地图、每个已修 bug 的根因、验证套路、待办
  - `references/scraper-sources.md` — **刮削源/在线观看/播放链路**的全部细节（接入新源、地址切换、播放层配方）
  - `references/cloud-drive-integration.md` — 夸克网盘的坑
  - `references/ui-redesign-proposal.md`、`references/lan-access-diagnostics.md` 等
- 项目根目录自检脚本（见第 5 节）

---

## 1. 本轮（2026-09-19 这次会话）做完的事，都带验证

### 1.1 「在线观看」页：从「iframe 打不开」到「应用内能看能播」

| 能力 | 状态 | 验证证据 |
|---|---|---|
| 多标签，**切标签不丢网页状态** | ✅ | 3 个标签同时存活；列表滚到 400 切走再切回仍是 400；iframe 上打的记号切回还在（没被重建） |
| 铺满内容区 | ✅ | 宽 1448/1680 = 内容区 100%，底边 936/950 |
| 站点按「能不能内嵌」分流 | ✅ | JavBus 直接 iframe；Jable/Hanime1 走应用内列表；不可嵌又无列表的给说明卡 + 新标签 |
| 应用内列表（浏览器抓） | ✅ | Jable 24 条/页、Hanime1 20 条、91动漫 16 条 |
| **分页** | ✅ | Jable 分页是**路径式** `/new-release/2/`（不是 `?page=`）；第 1 页 SNOS-299…、第 2 页 FNS-257… |
| 应用内播放 | ✅ | 点卡片 → 播放器打开，`readyState=4`、时长 8876s、`<video>` src 是 `blob:`（hls.js 在跑） |

**四个端点**（都在 `routes/webview.js`）：

```
GET /api/webview/sites                    站点清单（key/name/addrs/canList）
GET /api/webview/site?key=jable[&force=1] 逐级选线路 + 探测能否内嵌 → {url, frameable, unknown, canList}
GET /api/webview/list?site=jable&page=2   容器内浏览器抓列表（含分页）
GET /api/webview/resolve?url=<影片页>      嗅探真流地址 → 返回**已签名**的代理地址
GET /api/webview/stream?u=&ref=&sig=      流代理（播放列表/分片/AES 密钥/图片都走它）
GET /api/webview/frameable?url=           单 URL 探测（旧接口，保留）
```

播放链路：`/list` 拿卡片 → 点卡片 → `/resolve` 用 Chromium 嗅探页面自己请求的 `.m3u8` → 交给 `/stream`（签名代理）→ 前端复用已有的 `showVideoPlayer(url,'','hls')` + 内置 hls.js。

### 1.2 地址级备份 + 逐级切换（**重点**，用户核心诉求）

- 站点注册表 `SITES`（`routes/webview.js` 顶部）：**一个站一串地址，直连能通的排前面、官方域名垫底**，从上往下探测取第一个通的，缓存 5 分钟；顶栏 `🔁 换线路` 可强制重探。白名单也从这张表派生（镜像自动放行）。
- 实测连通性（容器内直连，无代理）：

| 地址 | 结果 |
|---|---|
| `284.iffuglfyc.com` / `9ed.nodgswul.cc` / `ajwrqqywa.cc` / `dongmanwang.net` | **200**（91动漫国内可用地址） |
| `91dongman.net`（官方，原来在用） | **000 直连不通** ← 这就是「91 有时打不开/播放报错」的根因 |

- 91动漫现在自动选中 `https://284.iffuglfyc.com/`，**全程不经代理**抓列表 ✓
- 地址来源：91动漫**官方发布页**（`fdu.ritewaxm.cc/redirect/`）明列「国内可用地址（直连无需代理）」；其它站在 `SITES` 里留了官方域名，**没验证过的地址不要往里加**。

### 1.3 本轮新增的刮削源（AV / 动漫）

`sourcePriority` 现在：`jav321 → javbus → javdb → netflav → onejav → javcl → jable → javmenu → tmdb`

| 源 | 取法 | 注意 |
|---|---|---|
| **netflav** | `/search?type=id&keyword=<番号>` 页面里的 `__NEXT_DATA__`（JSON） | 别抓 DOM；`docs[0].preview_hp` 是 DMM 大图 |
| **onejav** | `/search/<番号>` → 拿真实 href → `/torrent/<id>` | 搜索是模糊的必须精确比对；id **不带横杠**；不存在时回 500 不是 404 |
| **javcl** | `/movie/<番号小写>` 跳转后的 `og:` | 站上没有的番号回 **404 → 返回 null，不要抛错** |
| **其** | 同款：404 当「无结果」 | |
| **jable** | 首页过 CF → `/search/<番号>/` → 影片页 `og:image` | **唯一需要浏览器的源**；在「选封面」弹窗里被主动跳过（太慢） |
| **javmenu** | `/` + 番号大写（**不用搜索**） | 搜索页第一张卡常是 Telegram 广告 |
| **91动漫**（里番，动漫库第二个源） | `/search-result/<关键词>/` 的 `.dm-card`（跳过 `--comic`） | 封面是懒加载 `data-src` 且**带有效期签名**，抓到必须马上下载 |

**接入新源要改两个地方**（只改一个 = 界面里永远看不到它）：
`utils/poster-fetcher.js` 里有**两套分发**——元数据主循环（首个命中即返回）和 `searchAllPosters()`（收集所有候选给「选封面」弹窗）。两处都要加 `case`，并在 `config.docker.json` 的 `sources.<name>` + `scraper.sourcePriority` 里登记。

### 1.4 封面/扫描相关的修复（本轮）

- **没封面时可以选**：`GET /api/movie/:id/frame-candidates` 用 ffmpeg 在 10%/35%/60%/85% 各截一帧当候选；「选封面」弹窗并排给出「刮削结果 + 视频截帧」，都刮不到时给「自己上传/粘贴图片」入口。`change-poster` 遇到自家 `/api/movie/poster/...` 地址时**直接复制文件**不走网络。
- **扫描 EIO 重试**：目录 EIO 多为 bind mount 瞬时抖动（实测同一目录几分钟后就好了），`getVideoFiles` 里 `readdirSafe()` 对 EIO/EAGAIN/EBUSY 重试 2 次再判失败。
- **时长自愈**：`startQuickScan()` 会补爬 `duration=0` 的历史记录（ffprobe 坏掉期间入库的），第一次修好 648/661，之后收敛为 0。
- **镜像内置 Chromium**：`Dockerfile` 里 apt 换 CN 镜像 + `npx playwright install --with-deps chromium`（装到 `/ms-playwright`，**不在 `/app` 下**，所以不会被 node_modules 匿名卷遮掉）；`package.json` 的 playwright **钉死 1.62.1**（版本不一致会和浏览器修订号对不上）。

---

## 2. 本轮改动/新增的文件

| 文件 | 作用 |
|---|---|
| `routes/webview.js` | **新**：站点注册表 + 5 个端点（sites/site/list/resolve/stream）+ 持久化浏览器 + 签名流代理 + m3u8 重写 |
| `public/js/features.js` | 在线观看：标签系统、应用内列表、加载下一页、点卡播放、换线路 |
| `public/js/app.js` | 网盘图片灯箱（方向键+页数+Esc）、选封面弹窗（截帧候选）、`case 'watch'` |
| `public/css/style.css` | `.watch-full`/`.watch-tabs`/`.watch-chip`/`.watch-pane`/`.watch-grid` 一组规则 |
| `public/library.html` | 左侧导航加「📺 在线观看」；资源版本号 |
| `utils/crawler/{netflav,onejav,javcl,jable,javmenu,dongman}.js` | **新**：6 个源 |
| `utils/poster-fetcher.js` | 两套 switch 接入新源；动漫分流改成 hanime → 91动漫 两级 |
| `utils/metadata.js` | `captureVideoThumb(..., atTime)` 支持指定秒数截帧 |
| `utils/scanner.js` | `readdirSafe()` EIO 重试 + 时长自愈补爬 |
| `routes/movie.js` | `/frame-candidates` 截帧候选；`change-poster` 支持本地图 |
| `server.js` | 挂载 `/api/webview` |
| `Dockerfile` / `package.json` | CN 镜像源 + 内置 Chromium；playwright 版本钉死 |
| `config.docker.json` | 新增 6 个 `sources.*` + sourcePriority |
| `test-scanner-retry.js` / `test-frame-poster.js` / `test-sources.js` | **新**：自检脚本（见第 5 节） |

---

## 3. 必须记住的坑（都踩过，别再踩）

1. **纵向 flex 里子项写 `flex:1` 会盖掉 JS 设的 inline height**（`flex-basis:0` 优先），症状是量出来永远等于 `min-height`。在线观看的高度交给 `fitWatch()` 明确指定。
2. **切换标签不要用 `display:none`**：它会把滚动容器的 `scrollTop` 和 iframe 内部状态清掉（实测列表滚到 400 切回变 0）。用 `visibility:hidden` + 绝对定位保活。
3. **探测失败 ≠ 站点禁止内嵌**：网络抖动很常见，`/site` 会回 `unknown:true`，前端照样放 iframe；只有明确读到 XFO / CSP `frame-ancestors` / Cloudflare 才说「不能嵌」。（91动漫 就被这样冤枉过一次。）
4. **Cloudflare 站只有真浏览器过得去**：服务端 curl/node-fetch 一律 403 `Just a moment`。反过来，**JavBus / netflav / onejav / javcl 这些根本不需要代理**，容器直连就 200。
5. **封面必须走签名代理**：很多站 CDN 有防盗链，浏览器直接 `<img>` 拉是白图（实测 jable 全白）。
6. **m3u8 里的 AES 密钥是相对名且伪装成 `.ts`**（`URI="c9728533d5cb9443.ts"`）：只重写绝对 URL 会在**解密**那步卡死（表现是能加载但不出画面）。注释行里的 `URI="..."` 和裸 URL 两种都要重写。
7. **流 CDN 域名会变**，别用白名单：用**进程级随机密钥签名** `HMAC(url|ref)`，代理只肯转发本服务刚解析出来的地址。
8. **容器重启会清掉内存里的登录会话**：任何浏览器侧验证之前先重新 `POST /api/auth/login`（否则接口全回 `未登录或会话已过期`，看起来像功能坏了）。
9. **curl 是原生 Windows 版**：`-c /tmp/x.txt` 这种 MSYS 路径会被静默丢掉，cookie 存不下来 → 用 `"$LOCALAPPDATA/Temp/x.txt"`。
10. **验证要看几何/实际行为，不要只看元素存在**：这一轮两个 bug（图片跑到页面底部、嵌入区只有 360px 高）都是「元素在、断言过」但用户一眼看出错，必须断言 `getBoundingClientRect()` 的位置/尺寸或 `video.readyState`。

---

## 4. 当前状态速查

- 库量：jav 1852 / anime 983 / comic 178 / novel 5
- 站点注册表（`SITES`）里的站：`javbus`、`dongman`(91动漫)、`jable`、`hanime1`、`javmenu`、`netflav`、`onejav`、`porndude`（**javcl 已按用户要求下掉**）
- 有应用内列表的：`dongman`(路径 `/`) 、`jable`(/new-release/，**path 分页**)、`hanime1`(/)
- 浏览器 profile 落盘：`/app/cache/browser-profile`（cookie / CF 通行证会留到下次）
- 截图留档：`docs/redesign/`（在线观看-应用内列表.png / 应用内播放.png / 铺满-91动漫.png / 多标签.png 等）

---

## 5. 自检命令（改完就这些，省 token）

```bash
cd "D:/ai program/local-movie-library"

# 语法
node --check routes/webview.js && node --check public/js/features.js

# 刮削源自检（容器内跑，逐个源报结果）
docker exec local-movie-library node /app/test-sources.js SSIS-823

# 扫描器 EIO 重试自检
docker exec local-movie-library node /app/test-scanner-retry.js

# 「视频截帧当封面」闭环自检（**自带备份/还原**，跑完数据回原样）
JAR="$LOCALAPPDATA/Temp/ck.txt"
PW=$(node -e "const c=require('./config.docker.json');console.log(c.auth.password)")
curl -s -c "$JAR" -X POST http://localhost:3002/api/auth/login -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" >/dev/null
docker exec -e TOKEN=$(grep lml_session "$JAR" | awk '{print $7}') local-movie-library node /app/test-frame-poster.js

# 在线观看相关
curl -s -b "$JAR" http://localhost:3002/api/webview/sites
curl -s -b "$JAR" "http://localhost:3002/api/webview/site?key=dongman"
curl -s -b "$JAR" "http://localhost:3002/api/webview/list?site=dongman&limit=20"
```

前端验证：宿主 Playwright（`node_modules` 里已有）。**必须真点导航**（`.nav-item[data-view=watch]`），不要直接调函数；直接调会把内容渲染进隐藏容器，截图是空白。

---

## 6. 未完成 / 下一步（按优先级）

1. **javmenu / netflav / onejav 的应用内列表**：试过配 `listPath`（`/censored/1`、`/genre/1`）→ 抓到 0 条或垃圾，已回退成「说明卡 + 新标签打开」。要做得先看它们的列表 DOM 再配选择器（`LIST_SELECTORS` 里加一行）。
2. **91动漫播放偶发报错的复现**：怀疑就是「用了直连不通的官方域名」，换线路后应已消失；再遇到要让用户把报错原文发来。
3. **磁力链**：JavBus 详情页有磁力链，但**现有 javbus 爬虫没提取**（`grep magnet utils/crawler/javbus.js` 为空）。用户设想是「点磁力 → 自动在线缓存观看」；容器里**没有 aria2**，宿主有个 `video-dl-engine` 容器（端口 8866，返回 `{"error":"not found"}`，未能识别其 API）。**要么**问用户 aria2 的地址/密钥，**要么**退化成「取磁力 → 交给外部下载器 + 扫描入库」。
4. **更多站点的国内直连地址**：`SITES` 里按站追加即可（用户就是想让这些站点不用挂代理）。91动漫的可用地址已经填好；其它站的发布页还没找。
5. **porndude**：导航目录站，没有片源/元数据，接不进刮削，只能当链接簿。
6. 老待办：comic 178 / novel 5 条没有封面（comic 是按话入库，一条记录=一个 pdf）。

---

## 7. 给接手 agent 的开场建议

> 这是 `D:\ai program\local-movie-library`（Docker 部署的本地影库）。先读本文档 + 技能 `local-media-library-maintenance` 的 `references/project-state.md` 与 `references/scraper-sources.md`，再动手。改前端记得 `?v=N` +1 并让用户 Ctrl+F5；改路由/服务端 JS 后 `docker compose restart`；改 Dockerfile 才需要 `build`。验证要跑第 5 节的脚本、用真实浏览器点击断言几何/行为，别只断言元素存在。
