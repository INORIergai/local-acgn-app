# 03 · 后端与手机端发布链路审计

> 范围：`routes/app-update.js`（版本接口 + APK 分发）、Android 构建/发布链路（`android/`、`packaging/`）、`server.js` 鉴权与静态托管、移动端依赖的流媒体/图片/下载能力、安全面与可运维性。
> 方法：静态审计 + 本机 3517 只读探测（`curl` GET/HEAD，不改数据、不重启服务）+ APK 二进制实测（`sha256` / `apksigner` / `aapt2`）。**未修改任何源码与 runtime**。

## 0. 速览表

| # | 问题（现象一句话） | 证据 | 等级 | 工作量 |
|---|---|---|---|---|
| 1 | APK 下载接口无鉴权，且被列入 `/api` 公开白名单 | `server.js:45`、`routes/app-update.js:86` | **P0** | S |
| 2 | 全链路无 SHA-256 / 签名校验，客户端下完就装 | `routes/app-update.js:86-98`、`MainActivity.java:734-757` | **P0** | M |
| 3 | 三个 APK 全是 debug 证书 + `application-debuggable` | 实测 `apksigner` / `aapt2` | **P0** | M |
| 4 | APK 选取靠「文件名候选 + 目录存在性」，可能发旧包甚至 `app-debug.apk` | `routes/app-update.js:10-37` | **P0** | S |
| 5 | 版本号有 7 处独立来源，`build.gradle` 正则取不到就回退硬编码 | `routes/app-update.js:39-60` | P1 | M |
| 6 | 下载接口无 Range / 206 / ETag / 缓存头 / 并发限流 | 实测 `Range: bytes=0-99` → 200 + 6 907 262 字节 | P1 | S |
| 7 | 单一版本版权限下调（debuggable、密钥丢失即断更）无迁移方案 | `android/app/build.gradle:19-24` | P1 | M |
| 8 | 运行实例 `auth.enabled=false` → 整个 `/api/*` 局域网裸奔 | 实测 `/api/auth/status`、`/api/config` 无 cookie 即 200 | **P0**（配置） | XS |
| 9 | 会话只存内存，服务重启全体手机掉登录态 | `utils/auth.js:26`、`server.js:23` | P2 | S |
| 10 | 海报无缩略图、无长缓存（中位 166 KB/张） | `routes/movie.js:2069-2079` + `cache/posters` 实测 | P2 | M |
| 11 | 无 mDNS/SSDP/二维码配对，手机上只能手输 IP | grep 无命中；`MainActivity.java:183` | P2 | M |
| 12 | App 崩溃 / 前端错误无回传，更新失败无埋点 | `MainActivity.java:758-764` | P2 | M |
| 13 | `versionCode` 只能升，回滚 = 让用户卸载重装 | `android/app/build.gradle:13` | P2 | S |
| 14 | 反代 `Access-Control-Allow-Origin: *` | `routes/webview-proxy.js:786,810,827` | P2 | XS |
| 15 | `public/js/app.js.bak-nr` 等备份文件可被静态服务直出 | `public/js/app.js.bak-nr`（316 KB） | P3 | XS |

**一句话结论**：手机端「能更新」是侥幸——版本元数据、APK 文件、签名证书三者互不校验，任何一环漂移（旧包残留 / gradle 正则失效 / debug key 丢失）都会让全体手机卡在无法覆盖安装的状态，而且客户端**没有任何机制能发现下错包**。

---

## 1. `routes/app-update.js` 逐行审计

文件共 100 行，已全读。下面按行号逐条。

### 1.1 `APK_NAMES` 多候选 + 顺序优先（P0）

```js
// routes/app-update.js:10-15
const APK_NAMES = [
    'CinemaVault-Android.apk',            // ← 无版本名，排第一
    'CinemaVault-v4.5.6-Android.apk',
    'CinemaVault-v4.5.5-Android.apk',
    'CinemaVault-v4.5.4-Android.apk'
];
```
- **现象**：`getLatestApk()`（`:23-37`）按「目录 × 文件名」双循环，**第一个 `existsSync` 命中的就是"最新"**。无版本名的 `CinemaVault-Android.apk` 排第一，只要它还在，后面三个版本名文件永远不会被选中。
- 实测（`sha256`）：

  | 文件 | 字节 | sha256 前 16 | versionCode / versionName |
  |---|---|---|---|
  | `CinemaVault-Android.apk` | 6 907 262 | `e885d528b3c5017e` | 3 / 4.5.6 |
  | `CinemaVault-v4.5.6-Android.apk` | 6 907 262 | `e885d528b3c5017e` | 3 / 4.5.6 |
  | `CinemaVault-v4.5.5-Android.apk` | 6 901 293 | `adeef75965d91e8a` | 2 / 4.5.5 |
  | `CinemaVault-v4.5.4-Android.apk` | 7 914 858 | `a36d26c64c49705f` | 1 / 4.5.4 |
  | `android/app/build/outputs/apk/debug/app-debug.apk` | 6 907 262 | `e885d528b3c5017e` | 3 / 4.5.6 |

  当前之所以"对"，是因为 `CinemaVault-Android.apk` 恰好被人工覆盖成了 4.5.6（与 4.5.6 包、debug 产物三者字节完全相同）。
- **风险**：下一次发版若只新增 `CinemaVault-v4.6.0-Android.apk` 而忘了覆盖无版本名副本 → 版本接口报 `4.6.0`，实际下发 `4.5.6`。客户端 `versionCode(3) > current(3)` 为假 → 更新弹窗不出现，用户以为"已是最新"；若强行安装则因同版本 / 降级被安装器拒绝。**静默故障，无任何日志**。
- **修复**：删掉候选名单，改为「读清单 → 只认清单里的文件 → 校验后下发」：

```js
// routes/app-update.js（建议重写）
const MANIFEST = path.join(__dirname, '..', 'release', 'android-manifest.json');
function readRelease() {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));   // {versionCode,versionName,file,size,sha256,changelog,publishedAt}
  const apk = path.join(__dirname, '..', 'release', m.file);
  const st = fs.statSync(apk);
  if (st.size !== m.size) throw new Error(`APK size mismatch: ${st.size} != ${m.size}`);
  return { apk, st, m };
}
```
- **工作量**：S（清单 + 删除候选名单，约 40 行改动）。

### 1.2 硬编码 `D:\` 绝对路径 + 会把 gradle debug 产物当发行包（P0）

```js
// routes/app-update.js:17-21
const SEARCH_DIRS = [
    path.join(__dirname, '..'),
    'D:\\ai program\\local-movie-library',
    'D:\\ai program\\local-movie-library\\android\\app\\build\\outputs\\apk\\debug'
];
```
```js
// routes/app-update.js:31-34
const debugApk = path.join(dir, 'app-debug.apk');
if (fs.existsSync(debugApk)) return { path: debugApk, stat: fs.statSync(debugApk) };
```
- **现象**：第 19-20 行把开发机路径写死；第 21 行把 **Gradle 的 debug 输出目录**列为候选，`:31` 还额外接受任意 `app-debug.apk`。
- **风险**：换机器 / 装到别的盘 / EXE 部署到 `%APPDATA%\CinemaVault\runtime` 时，第 18 行 `__dirname/..` 是唯一的相对路径，前两个 `D:\` 直接失效（不影响功能，只是死配置）；真正的危险是第 21 行——**只要根目录的包被清掉，服务器会把开发机上刚编译的 `app-debug.apk` 当作发行包发给所有手机**。debug 产物可能指向 `http://10.0.2.2:3517`（模拟器专用）、带未完成改动，且它天生 `debuggable`。
- 实测该目录确实存在同字节文件：`android/app/build/outputs/apk/debug/app-debug.apk`（6 907 262 B）。
- **修复**：候选目录只留一处，且必须排除 `build/` 与 `*-debug.apk`：

```js
const RELEASE_DIR = process.env.CV_RELEASE_DIR || path.join(__dirname, '..', 'release', 'android');
if (/[\\/]build[\\/]/.test(apkPath) || /debug/i.test(path.basename(apkPath))) throw new Error('refuse debug artifact');
```
- **工作量**：S。

### 1.3 运行时读 `build.gradle` 正则取版本（P1，脆）

```js
// routes/app-update.js:39-60
const codeMatch = content.match(/versionCode\s+(\d+)/);
const nameMatch = content.match(/versionName\s+["']([^"']+)["']/);
...
} catch (e) {}
return { versionCode: 3, versionName: '4.5.6' };   // ← 第 59 行硬编码回退
```
- **现象**：每次请求 `/api/app/android-version` 都同步读一次 `build.gradle` 并正则扫；`catch` 空吞（`:58`）；取不到就回退到写死的 `3 / 4.5.6`。
- **风险**：
  1. 正则对**注释**敏感——`build.gradle` 里出现 `// versionCode 4` 或 `versionCode = 3`（Kotlin DSL）即取错；
  2. 一旦加了 flavor（`productFlavors` 里各有一份 `versionCode`），取到的是第一个；
  3. **最致命的是第 59 行**：gradle 文件被清掉 / EXE 部署包里没带 `android/` 目录时，接口永远返回 `4.5.6`。此时服务端进入"永远没有新版本"状态，或反过来（APK 已 4.7.0、接口说 4.5.6）更糟——手机拿到 `4.7.0` 的包但比对 `4.5.6`，每次都提示更新，装完还是提示更新，形成**更新死循环**。
- 实测：`GET /api/app/android-version` → `{"version":"4.5.6","versionCode":3,"fileSize":6907262}`，与 APK 内 `aapt2 dump badging` 的 `versionCode='3' versionName='4.5.6'` 一致（当前之对，同样是人工同步的结果）。
- **修复**：版本只从**构建产物**读，且构建时写死进清单；接口只读清单，不碰 gradle：

```bash
# 构建脚本里：以 APK 自身的 manifest 为准，而不是以 gradle 文本为准
AAPT="$ANDROID_HOME/build-tools/34.0.0/aapt2.exe"
VC=$("$AAPT" dump badging "$APK" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")
VN=$("$AAPT" dump badging "$APK" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
jq -n --argjson vc "$VC" --arg vn "$VN" --arg sha "$SHA" --arg f "$(basename "$APK")" \
      --argjson size "$(stat -c%s "$APK")" \
      '{versionCode:$vc,versionName:$vn,file:$f,size:$size,sha256:$sha}' > release/android-manifest.json
```
- **工作量**：M（含打包脚本改造）。

### 1.4 `changelog` 硬编码 / `publishedAt` 依赖文件 mtime（P2）

```js
// routes/app-update.js:74-82
changelog: [ '1.【智能返回键】…', '2.【实体按键】…', … ].join('\n'),
publishedAt: apk ? apk.stat.mtime.toISOString() : new Date().toISOString()
```
- **现象**：5 条更新说明写死在代码里；发布时间直接用 APK 的 `mtime`。
- **风险**：发 4.5.7 时若忘了改这里，手机会显示"4.5.7 的更新内容是 4.5.6 的五条"；`mtime` 在拷贝/`git checkout`/解压后会变，`publishedAt` 因此不可信（实测返回 `2026-10-17T04:50:49.205Z`，恰是文件复制时间）。
- **修复**：`changelog` 移入清单（`android-manifest.json.changelog`），`publishedAt` 用构建时间戳字段。
- **工作量**：XS（并进 1.3 的清单改造）。

### 1.5 下载接口：无鉴权 / 无 Range / 无 ETag / 无 SHA-256 / 无版本名 / 无速率限制（P0 + P1）

```js
// routes/app-update.js:86-98
router.get('/download/android-apk', (req, res) => {
    const apk = getLatestApk();
    if (!apk) return res.status(404).json({ error: '未找到 APK 安装包文件' });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="CinemaVault-Android.apk"`);
    res.setHeader('Content-Length', apk.stat.size);
    const stream = fs.createReadStream(apk.path);
    stream.pipe(res);
});
```

实测（本机 3517，只读）：

```
$ curl -I http://127.0.0.1:3517/api/app/download/android-apk
HTTP/1.1 200 OK
Content-Type: application/vnd.android.package-archive
Content-Disposition: attachment; filename="CinemaVault-Android.apk"
Content-Length: 6907262            ← 无 Accept-Ranges / ETag / Last-Modified / Cache-Control / Digest

$ curl -r 0-99 -D - -o /tmp/apkpart.bin …        # 请求 bytes=0-99
HTTP/1.1 200 OK                    ← 不是 206
Content-Length: 6907262            ← 仍回整包
$ ls -l /tmp/apkpart.bin → 6907262 bytes
```

逐项风险与修复：

| 缺失项 | 现象 | 风险 | 修复 | 工作量 |
|---|---|---|---|---|
| 鉴权 | 任何人不带 cookie 直接 GET | 同一 Wi-Fi 下任何人都能拉走 APK；攻击者拿到后可反编译看服务端口/接口路径，配合无鉴权 API 直接进后台 | 见 §5.1：`/app` 从白名单移除，或改为「一次性签名 token」 | S |
| Range / 206 | `Range: bytes=0-99` 返回 200 + 整包 | 手机下载中断（切后台、锁屏、Wi-Fi 抖动）只能从 0 重来；6.9 MB 在弱信号下极难一次成功 | 用 `res.sendFile` + `acceptRanges: true`（Express 自带 206/ETag/Last-Modified），或手写 start/end | S |
| ETag / Cache-Control | 无 | 每次 `HEAD` 都要 stat；无 304 协商 | `sendFile` 自动带 ETag + `max-age=0`，或显式 `Cache-Control: public, max-age=31536000, immutable`（文件名带 hash 时） | XS |
| SHA-256 | 响应与清单都没有 | 客户端无法判断下到的是不是那个包；见 §3 的伪造覆盖安装路径 | 响应头 `Digest: sha-256=<base64>` + 清单字段；客户端校验后才 `installApk` | S |
| `Content-Disposition` 版本名 | 固定 `CinemaVault-Android.apk` | 用户在下载目录里无法分辨新旧包；浏览器下载重名会变 `(1)` | `filename="CinemaVault-v${version}-Android.apk"` | XS |
| 速率 / 并发 | 无 | 100 Mbps 局域网下单个客户端即可占满；`fs.createReadStream` 每次一个 fd，无并发上限 | `res.setHeader('Cache-Control', …)` + 简单并发信号量（`p-limit`/自写计数器，上限 3）+ `stream.pause()` 背压已有 pipe 保障 | S |

**推荐改法（一次性解决 Range/SHA/缓存/版本名）**：

```js
router.get('/download/android-apk', async (req, res) => {
  const { apk, m } = readRelease();                    // §1.1
  res.setHeader('Content-Disposition', `attachment; filename="CinemaVault-v${m.versionName}-Android.apk"`);
  res.setHeader('Digest', `sha-256=${Buffer.from(m.sha256, 'hex').toString('base64')}`);
  res.setHeader('X-Apk-Sha256', m.sha256);             // 给客户端直接读
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(apk, { acceptRanges: true, cacheControl: true });
});
```

### 1.6 客户端（原生侧）对应缺陷（放在一起看才是完整链路）

```java
// android/.../MainActivity.java:734-757
InputStream input = conn.getInputStream();
byte[] data = new byte[4096];
while ((count = input.read(data)) != -1) { output.write(data, 0, count); }
...
mainHandler.post(() -> { progressDialog.dismiss(); installApk(finalApk); });
```
- **现象**：4 KB 手写缓冲、无断点续传、无重试、无超时续期（`setReadTimeout(30000)`，`:726`）、无 sha256 校验、下载完成后**直接 `installApk`**、不可取消（`progressDialog.setCancelable(false)`，`:707`）。
- **风险**：弱网下必然出现"下到一半失败 → 只剩 Toast（`:762`）→ 用户重来"；更危险的是**没有任何手段发现被中间人替换/被缓存污染的包**。
- **修复**：`Range` 续传（`conn.setRequestProperty("Range", "bytes=" + downloaded + "-")`）+ 下完校验 `X-Apk-Sha256`（不一致删文件并报错）+ 失败重试 3 次指数退避。
- **工作量**：M。

---

## 2. 发布流水线（APK 怎么来的、版本号散在哪）

### 2.1 现状：**没有 Android 打包脚本**（P0）

- 全仓库 grep `assembleDebug|app-debug.apk|CinemaVault-v4.5`，命中仅三处：`routes/app-update.js`、`android/app/build/outputs/apk/debug/output-metadata.json`、以及 EXE 里的副本 `exe/免安装目录/win-unpacked/resources/payload/routes/app-update.js`。**`packaging/` 下没有任何 Android 相关脚本**（`packaging/README.md`、`build-exe.bat`、`_r23-publish.py` 均只处理 Electron）。
- 结论：现在的流程是**手工**——Android Studio 点 Build / `gradlew assembleDebug` → 手工把 APK 复制到仓库根 → 手工改名（有时带版本号、有时不带）→ 手工确认 `CinemaVault-Android.apk` 已覆盖。
- 旁证：部署侧 runtime 副本与仓库逐字节一致（`%APPDATA%\CinemaVault\runtime\routes\app-update.js` 与仓库 diff 为空），说明**线上 EXE 里跑的就是这段硬编码候选名单**。
- **风险**：发版完全依赖人的记忆。上面 §1.1 的"旧包静默下发"就是这套流程的必然产物，不是偶然。
- **修复**：新增 `packaging/build-android.ps1`（或 `.cjs`），把 5 步固化：

```powershell
# packaging/build-android.ps1 —— 单一版本源 = android/version.properties
$props = Get-Content android/version.properties | ConvertFrom-StringData   # versionCode/versionName/changelog
# 1) 版本写回 gradle（构建期唯一消费者）  2) 构建 release
(gc android/app/build.gradle) -replace 'versionCode \d+', "versionCode $($props.versionCode)" `
                              -replace 'versionName "[^"]+"', "versionName ""$($props.versionName)""" | set-content android/app/build.gradle
pushd android; ./gradlew.bat :app:assembleRelease; popd
# 3) 产物落 release/android/，文件名由版本号生成（不再有"无版本名副本"）
Copy-Item "android/app/build/outputs/apk/release/app-release.apk" `
          "release/android/CinemaVault-v$($props.versionName)-Android.apk" -Force
# 4) 从 APK 自身读版本 + 算 sha256 + 写清单（§1.3 片段）
# 5) 断言：签名非 debug、versionCode 单调递增、size>0
```

- **工作量**：M。

### 2.2 版本号重复的 7 处（P1）

| # | 位置 | 现值 | 说明 |
|---|---|---|---|
| 1 | `android/app/build.gradle:13` | `versionCode 3` | 唯一"真正的"版本码，但只在构建期被 Android 用 |
| 2 | `android/app/build.gradle:14` | `versionName "4.5.6"` | 同上 |
| 3 | `MainActivity.java:262` | `s.setUserAgentString(defaultUa + " CinemaVault-Android/4.5.6")` | **UA 里手打版本号**；前端靠它识别客户端 |
| 4 | `public/js/mobile-updater.js:27-31` | `if (m[1]==='4.5.4') return 1; … 4.5.6 → 3` | **版本名→versionCode 硬编码映射表**，UA 一变就查不到 |
| 5 | `routes/app-update.js:59` | `{ versionCode: 3, versionName: '4.5.6' }` | gradle 读不到时的回退 |
| 6 | `MainActivity.java:666` | `json.optString("version", "4.5.5")` | 服务端没给 version 时的默认值 |
| 7 | 文件名 / `Content-Disposition` / `/api/update/status` | `CinemaVault-v4.5.x-Android.apk`；EXE 版本 `4.5.4` | 实测 `/api/update/status` → `{"version":"4.5.4"}`，与 APK 的 4.5.6 **不同源不同步** |

- **风险**：任何一次只改其中 1-2 处，就会出现「UA 说 4.5.6 → mobile-updater 映射到 3 → 服务端说 3 → 不提示更新」或「服务端说 4.5.7 → 客户端 UA 还是 4.5.6 → 每次进页面都提示更新，装完还是提示」。
- **修复（单一版本源 + 构建产物 sha256 + 清单 json）**：

```
android/version.properties          ← 唯一人工编辑的版本源
  versionCode=4
  versionName=4.6.0
  changelog=1.【…】\n2.【…】
        │
        ├─ build-android.ps1 写进 build.gradle（构建期才用）
        ├─ build-android.ps1 生成 release/android-manifest.json
        │    { "versionCode":4, "versionName":"4.6.0",
        │      "file":"CinemaVault-v4.6.0-Android.apk",
        │      "size":6907262, "sha256":"…", "publishedAt":"2026-10-22T…",
        │      "changelog":"…", "channel":"stable",
        │      "minSupportedVersionCode":1,
        │      "signingCertSha256":"eb5a75…" }
        ├─ routes/app-update.js 只读清单（不再读 build.gradle）
        └─ 运行时注入 UA / 前端版本表的替代：
             · MainActivity 用 BuildConfig.VERSION_NAME 拼 UA（不再手写）
             · mobile-updater.js 改用 AndroidBridge.getVersionCode()，
               UA 只做兜底且不再维护映射表
```
- **工作量**：M（清单与接口 S，UA/前端去硬编码 S，构建脚本 M）。

---

## 3. 签名与完整性（三个 APK 全是 debug 证书）

### 3.1 实测结论（P0）

```
$ java -jar apksigner.jar verify --print-certs CinemaVault-v4.5.6-Android.apk
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
Signer #1 certificate SHA-256 digest: eb5a75710a63db433816c071ceb71d64a2338bc292d0e55c3045865d978c8e7b
（4.5.4 / 4.5.5 三包 DN 与 SHA-256 完全相同）

$ aapt2 dump badging CinemaVault-v4.5.6-Android.apk | grep -E "package|debuggable"
package: name='cn.cinemavault.app' versionCode='3' versionName='4.5.6'
application-debuggable          ← 三个包全有
```
- `android/app/build.gradle:19-24` 的 `release` 块**没有 `signingConfig`**，仓库里也没有任何 `.jks/.keystore`（`find` 无命中）→ 实际只构建过 `assembleDebug`。

### 3.2 风险

1. **`debuggable=true`**：任何人拿到手机/同网 adb 即可 `run-as cn.cinemavault.app` 读私有目录（`CinemaVaultPrefs` 里的服务器地址、WebView cookie 库）、可 attach 调试器改运行时行为、可 `WebView.setWebContentsDebuggingEnabled` 抓全部页面数据。
2. **debug keystore 是公共的**：`CN=Android Debug` 的私钥口令就是 `android`，位置在开发机 `%USERPROFILE%\.android\debug.keystore`，**等同于公开**。攻击者可用同一把 key 签一个"同包名"的恶意 APK，在**没有签名校验的更新链路**（§1.5/§1.6）里替换下载内容 → 用户点"立即更新"就完成了覆盖安装，这是完整的供应链攻击路径。
3. **密钥丢失即永久断更**：debug.keystore 只存在于那台开发机的用户目录，重装系统/换机器/清理 `.android` 就没了。Android 的规则是**签名不同不能覆盖安装**，`versionCode` 又只能升 → 所有存量用户只能卸载重装（丢本地设置），否则永远收不到更新。
4. **OEM 安装器警告/拦截**：小米/华为/OPPO 对 `debuggable=true` + debug 签名的包会弹"未经检测/风险应用"，部分机型直接拒绝静默安装；Google Play Protect 也会拦。
5. **无法上架**：任何商店都拒绝 debug 签名包。

### 3.3 修复：release keystore + signingConfig

```bash
# 一次性生成（RSA 4096，有效期 10000 天，CN 用真实组织名）
keytool -genkeypair -v -keystore cinemavault-release.jks -alias cinemavault \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=CinemaVault, OU=Mobile, O=CinemaVault, L=Local, C=CN"
# 打印并抄进清单，供客户端校验
keytool -list -v -keystore cinemavault-release.jks -alias cinemavault | grep SHA256
```
```groovy
// android/app/build.gradle
def keystoreProps = new Properties()
file("${rootDir}/key.properties").withInputStream { keystoreProps.load(it) }   // 不入库（.gitignore）
android {
    signingConfigs {
        release {
            storeFile     file(keystoreProps['storeFile'])
            storePassword keystoreProps['storePassword']
            keyAlias      keystoreProps['keyAlias']
            keyPassword   keystoreProps['keyPassword']
            enableV1Signing true; enableV2Signing true; enableV3Signing true   // v1 兼容老机型
        }
    }
    buildTypes {
        release { signingConfig signingConfigs.release; minifyEnabled false; debuggable false }
    }
}
```
**轮换 / 迁移注意（务必写进发布说明）**：
- **换签名后无法覆盖安装**。第一次从 debug 迁到 release，必须让用户"卸载重装"，或保留一个过渡版（同一 debug key 签的最后一版）在应用内提示并引导。
- 保留 **debug → release 的过渡期**：`versionCode` 从 4 起推一个 release 签名包，检测到 "`INSTALL_FAILED_UPDATE_INCOMPATIBLE`" 时原生侧要能捕获并弹「请先卸载旧版」而不是只 Toast。
- `apksigner` 轮换（API 28+ 签名血缘）：只有在 release key 已经用 v3 签名铺开后才可用 `--lineage`，**第一次迁移没有 lineage 可用**。
- keystore + 口令**离线两份备份**（U 盘 + 密码管理器），并在清单里固化 `signingCertSha256`，客户端校验"包是这把 key 签的"。
- 长期应改用 Play App Signing 或自建签名服务，避免人走密钥丢。

- **工作量**：M（keystore + gradle + 一次全量重装迁移）。

---

## 4. 移动端相关服务能力

### 4.1 登录 / 门禁鉴权在 WebView 里（P2）

- 服务端签发：`utils/auth.js:58-62` 随机 32 字节 token，内存 `Map`；下发见 `routes/auth.js:117-121`：

```js
res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL });   // 30 天
```
- WebView 侧：`MainActivity.java:267-269` `CookieManager.setAcceptCookie(true)` + `setAcceptThirdPartyCookies(webView, true)`。
- **问题**：
  1. **没有 `secure`**（局域网本来就是 http，无解，但要写明）；没有 `path` 限制；cookie 名不是 `__Host-` 前缀。
  2. **会话只存内存**（`utils/auth.js:26` `const sessions = new Map()`）→ **EXE 重启 / 应用内更新 / 进程崩溃 = 全体手机掉登录态**，且用户看不到"为什么又要输密码"。手机端体验上是"随机让我重登"。
  3. **过期处理粗糙**：`server.js:19` 注释说"前端 401 统一拉起密码框"，但那只覆盖 `fetch`；`<video src="/api/movie/stream?path=…">` 收到 401 时不会触发任何前端逻辑 → **视频区静默黑屏**，用户以为文件坏了。
  4. `setAcceptThirdPartyCookies(true)` 对反代进来的外站也算放宽，配合 `MIXED_CONTENT_ALWAYS_ALLOW`（`:258`）安全面偏松。
- **修复**：会话落盘（`sessions` → SQLite 表 `sessions(token_hash, expires_at)`，或签名 JWT），重启不掉线；`<video>` 前置一次 `fetch` 探活拿 401 再弹密码框。
- **工作量**：S（落盘）+ S（视频 401 处理）。

### 4.2 视频 Range 流：seek 与断点续传（P1，实现有，边界缺）

```js
// routes/movie.js:158-176
const range = req.headers.range;
if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                         'Accept-Ranges': 'bytes', 'Content-Length': chunkSize,
                         'Content-Type': 'video/mp4' });
    file.pipe(res);
}
```
- **好的部分**：206 + `Accept-Ranges: bytes` + `Content-Range` 齐全 → 手机端 `<video>` 拖动进度条与断点续传可用。
- **缺陷**：
  1. **`Content-Type` 恒为 `video/mp4`**（`:172`、`:181`）。`.mkv/.avi/.ts` 会被标成 mp4，Android WebView（Chromium）可能拒播或按容器乱解；`allowedVideoExt` 允许 10 种扩展名（`utils/config.js`），扩展名与 MIME 完全没映射。
  2. **`start > fileSize` / 非法 `Range` 无校验**：`createReadStream({start: 999999999})` 会在**异步**阶段抛 `ERR_OUT_OF_RANGE`，不在 `:145` 的 `try` 覆盖范围内 → 落到 `server.js:27` 的全局 `uncaughtException` 兜底（进程活着，但请求挂死）。
  3. **无并发/带宽上限**：每个播放器一个 `createReadStream`，多台手机同时看 4K 会把磁盘 IO 打满，桌面端播放跟着卡。
  4. `path` 参数（`:146`）只靠 `isPathAllowed` 白名单——这是对的（`:150-154` 有注释说明修过任意文件读取），但白名单是"扫描目录内任意文件"，**同目录下的 `.nfo`、封面、`.txt` 也能读**。
- **修复**：扩展名→MIME 映射表；`Range` 解析加容器（`/^bytes=\d*-\d*$/`）与 `end = Math.min(end, fileSize-1)`；`file.on('error', …)` 兜底；并发限流。
- **工作量**：S。

### 4.3 海报 / 缩略图：移动端拿的是原图（P2）

```js
// routes/movie.js:2069-2079
router.get('/poster/:hash', (req, res) => {
    if (!/^[\w.-]+$/.test(hash)) return res.status(400).end();       // 防穿越，OK
    const posterPath = path.join(__dirname, '../cache/posters', hash);
    if (fs.existsSync(posterPath)) res.sendFile(posterPath);          // 原图直出
    else res.status(404).end();
});
```
- 实测 `cache/posters/`：11 965 张、合计 **1 677 MB**、**中位 166 KB**、最大 1 043 311 B（约 1 MB）。
- **风险**：手机首屏 50 张 ≈ **8 MB**；`sendFile` 默认 `Cache-Control: public, max-age=0` → 每次进页面都发条件请求（304 也要一次 RTT），弱网下列表滚动明显卡顿/灰块。无 WebP、无 `?w=` 参数、无 CDN 缓存。
- **修复**：加 `GET /api/movie/poster/:hash?w=320`（`sharp` 现成依赖可直接用），首次生成落到 `cache/thumbs/<hash>@320.webp`；`Cache-Control: public, max-age=31536000, immutable`（hash 文件名天然不可变）+ 前端 `loading="lazy"` 已有。
- **工作量**：M（sharp 管线 + 前端换 URL）。

### 4.4 HLS 切片（在线观看，非本地上传）

```js
// routes/media-source.js:243-274
if (range) baseHeaders.Range = range;      // 拖动进度条会带 Range，必须透传
if (cr) res.set('Content-Range', cr);
res.set('Accept-Ranges', 'bytes');
```
- 结论：`/api/media-source/seg` 已透传 Range 并回 206，**HLS 拖拽可用**；`/api/media-source/stream` 负责把 `m3u8` 内分片改写成同源地址（`:208-243`）。风险点：m3u8 与分片无缓存头、无并发上限，源站抖动时直连失败（该链路本就有失败重试，属既有实现）。
- **工作量**：S（若要加缓存）。

### 4.5 大文件下载的背压（backpressure）

- 服务端：`routes/app-update.js:96-97` `fs.createReadStream(...).pipe(res)` → **背压正确**（`pipe` 会按 `write` 返回值暂停读取）。
- 客户端：`MainActivity.java:737-747` 4 KB 手写循环 → 会阻塞在 `input.read`，但**下游是本地文件写入**，问题不大；真正缺的是续传/校验/取消（见 §1.6）。

### 4.6 局域网发现：完全没有（P2）

- grep `mdns|bonjour|ssdp|qrcode|局域网发现` 在 `routes/ utils/ public/js/ server.js` 中**零命中**（`public/js/app.js:9083` 的二维码是**夸克网盘登录**用的，不是配对）。
- 现状：手机端首次启动只能手输 IP（`MainActivity.java:624` 提示文案 `http://192.168.x.x:3517`），而默认值写死 `http://10.0.2.2:3517`（`:183`、`:205`、`:720`）——这是**Android 模拟器访问宿主的特殊地址，真机永远连不上**，第一次打开必然超时，对普通用户等于"装完不可用"。
- 服务端还在 `server.js:207` 打印"手机扫码或输入上面的局域网地址即可访问"，但**根本没有扫码入口**，误导排查。
- **修复**（成本从低到高）：① 桌面端设置页用 `qrcode` 生成 `http://<lan-ip>:3517` 二维码（`utils/config.js` 的 `lanInfo()` 已经有 IP，10 行代码）；② 手机端加 SSDP/`multicast` UDP 广播探测（服务端 1 个 UDP **P2**，客户端一个 socket）；③ mDNS `_cinemavault._tcp`（需 `bonjour-service`）。把 `10.0.2.2` 从默认值改成上次地址或空 + 引导。
- **工作量**：S（二维码）/ M（SSDP 或 mDNS）。

### 4.7 HTTPS / 明文

- `AndroidManifest.xml`：`android:usesCleartextTraffic="true"`；`res/xml/network_security_config.xml:3-7` `cleartextTrafficPermitted="true"` 且 `trust-anchors` 含 `<certificates src="user"/>`（信任用户 CA）。
- **风险**：局域网明文 → 同网任何人可嗅探到登录密码（`POST /api/auth/login` body 明文）与全部片单；信任用户 CA 便于抓包（开发有用），但也让"装个证书就能 MITM"变容易。
- **修复**：至少给「远程访问」场景加自签证书 + 证书固定（`networkSecurityConfig` 里 `<pin-set>`），或明确文档化"仅可信局域网使用"。
- **工作量**：L。

---

## 5. 安全面

### 5.1 `/api/app/*` 被列入公开白名单（P0，实测）

```js
// server.js:45
const PUBLIC_API_PREFIXES = ['/auth', '/acg', '/ai/chat', '/ai/status', '/app'];
// server.js:51
if (PUBLIC_API_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/') || …)) return next();
```
- **现象**：`/api/app` 整个前缀跳过 `sessionMiddleware`。而 `routes/app-update.js:63` 与 `:86` 正是该前缀下仅有的两个接口。
- **实测**：无 cookie 请求 → `200`（版本接口 654 B / APK 6 907 262 B）。
- **风险**：注释里写的理由是"手机启动即查"（`:62`），但**下载不该跟着免鉴权**。同一个 Wi-Fi（咖啡馆/宿舍/公司）里任何人可以直接把 APK 拖走，并可借此确认这台机器在跑 CinemaVault（`/api/app/android-version` 是绝佳的指纹探针：扫 `192.168.0.0/16` 一顿 200 就知道哪台机器开着）。
- **修复**：
  - 版本查询保留公开（要给出 `sha256/versionCode`，泄密成本低，但**不要**下发 `apkUrl` 给未鉴权者）；
  - 下载改为**短时签名 URL**：`/api/app/download/android-apk?t=<hmac(exp)>`，`t` 由已登录后的 `/api/auth/status` 流程或 App 首次配对时获取；
  - 或简单粗暴：把 `/app/download` 从白名单剔掉，App 侧下载时带 WebView 的 cookie（`MainActivity` 走 `CookieManager.getInstance().getCookie(base)` 注入 `Cookie` 头）。
- **工作量**：S。

### 5.2 运行实例 `auth.enabled=false` → 整个 `/api/*` 局域网裸奔（P0·配置）

- 仓库 `config.json`：`auth = {"password":"6799","sections":{}}`（无 `enabled` 字段 → 按 `utils/auth.js:37-41` 的兼容逻辑 = **启用**）。
- **实际部署的 runtime**：`%APPDATA%\CinemaVault\runtime\config.json` → `auth = {"password":"","sections":{},"enabled":false}`。
- **实测**：`GET /api/auth/status` → `{"authEnabled":false,"loggedIn":true}`；于是

  | 请求（无 cookie） | 结果 |
  |---|---|
  | `GET /api/app/android-version` | 200（预期，白名单） |
  | `GET /api/config` | **200, 8 314 B**（配置全量：扫描目录、`ai`、`sources`、`push`、`cloudOAuth`…） |
  | `GET /api/update/status` | **200, 6 927 B** |
  | `GET /api/movie?type=film` | 200（设计上 film 本就放行） |
  | `GET /api/stats/overview?type=film` | 200 |
  | `GET /api/acg/rank` | 200（设计放行） |
- **风险**：只要 `auth.enabled=false`，`server.js:48` 的 `if (!isAuthEnabled()) return next();` 让**所有** `/api/*` 直接放行 —— 包括 `POST /api/scanner`（触发扫描）、`POST /api/maintenance/*`（删封面缓存）、`POST /api/config`（改配置）、`POST /api/auth/access`（改密码）。同网任何人可改配置、删缓存、看全库片单。**这是本次审计里最高危的一条**，而且它不在代码里，在部署配置里。
- 好消息：`/api/config` 的响应是脱敏过的（`auth` 只回 `{enabled, hasPassword}`、`danmaku` 只回 `hasSecret`，实测无 `tmdbApiKey` 字段），无明文密钥外泄。
- **修复**：把 `auth.enabled` 默认设为 `true`（首次启动强制设密码，或在 UI 里显著提示"关闭密码 = 局域网任何人可访问"）；`isAuthEnabled()` 对 `enabled` 缺失时按 `!!password` 兼容（已有），但**空密码 + `enabled:false` 的组合要在启动日志里打红色警告**。
- **工作量**：XS（改默认 + 日志）/ S（强制首启设密）。

### 5.3 静态目录暴露：敏感文件**没有**泄露（实测通过）

```
GET /config.json            → 404      GET /package.json       → 404
GET /cache/cache.db         → 404      GET /.git/config        → 404
GET /public/../config.json  → 404      GET /config.json%00     → 404
```
- 结论：`server.js:116` 只挂 `public/`，`server.js:104-106` 根路径 302 到 `/library.html`，`server.js:181-191` 的 `/avatars`、`/custom`、`/ui-anime` 只映射到 `data/` 与配置的图片目录，**db / config.json / .git 均不可直取**。这条是好的，不需要改。
- 唯一小问题：`public/js/app.js.bak-nr`（316 KB 旧版前端备份）会被 `express.static` 直出（代码推定：`GET /js/<name>` 走静态，实测时服务刚好不可达未取到）。属信息泄露 P3，删文件即可。

### 5.4 反代 SSRF：受限（可接受）

```js
// routes/webview-proxy.js:558
const originOverride = String(req.query._o || '');
// routes/webview-proxy.js:667-672
async function pickOrigin(key, site, override) {
  if (override) {
    const u = new URL(override);
    if (hostInSite(site, u.hostname)) return u.origin;   // ← 必须命中站点白名单
  }
```
- **结论**：`_o` 只能把请求打到 `site.addrs / site.cdn` 里的主机（精确匹配，`:690-698`），**不能** `_o=http://127.0.0.1:3517` 打内网 → 无通用 SSRF。子域请求也走 `hostInSite` 校验（`:575-578`，不命中返回 403）。
- 残余风险：一旦 `webview-sites` 配置里出现内网地址，就等于开了口子；建议 `hostInSite` 里再加 `isPrivateHost()` 黑名单（`127.0.0.1`、`10.`、`192.168.`、`169.254.`、`::1`）。

### 5.5 CORS

- 主 API **无** `Access-Control-Allow-Origin`（grep `server.js`、`routes/*.js` 只有反代侧），这是对的：手机 WebView 是同源访问，不需要 CORS。
- 但反代三处 `res.setHeader('Access-Control-Allow-Origin', '*')`（`routes/webview-proxy.js:786,810,827`）+ `routes/webview.js:715,724` → 任意网页（含恶意站）可以跨域读取反代回来的在线观看内容（含带 cookie 的渲染结果）。**P2**，建议改成只允许 `http://<lan-ip>:3517` 同源。
- 无 CSRF token：`sameSite: 'lax'` 挡住了大部分跨站 POST，但 `lax` 对顶层 GET 导航放行 → `GET /api/config`（读）可被跨站导航触发。全部写操作都是 POST + JSON，风险低。

### 5.6 日志里的敏感信息

- 实测 grep：`webview-proxy.js:218` 只打印**条数**（`渲染回写登录态 ${res.cookies.length} 条`），不打印值 —— OK。
- `routes/cloud-oauth.js:502` `console.log('[cloud-oauth] quick-token input:', JSON.stringify({...}))` —— 打印的是一段 JSON，**需人工确认是否包含 token 明文**（本次未展开该文件，标 P2 待复核）。
- `utils/auth.js` 全程不打印 token/password —— OK。
- **服务端日志本身**：全部 `console.log` 到 stdout，EXE 里没有落盘与轮转（`server.js` 无日志文件逻辑）→ 线上出问题时无历史可查（见 §6）。

---

## 6. 可运维性

| 项 | 现状 | 风险 | 修复 | 级别/工作量 |
|---|---|---|---|---|
| App 崩溃上报 | `MainActivity.java` 无 `Thread.setDefaultUncaughtExceptionHandler`；仓库无任何 crash 上报接口 | 用户"闪退"时服务端完全不知道；只能等用户说"打不开" | 加最小 handler：捕获 → 写 `getExternalFilesDir()/crash-<ts>.txt` → 下次启动 `POST /api/app/report`（`app-update.js` 里加个 30 行接口，落 `logs/app-crash.log`） | P2 / M |
| 前端错误回传 | grep `onerror` 只命中图片降级，无 `window.onerror` 上报；无 `/api/error` 端点 | 手机端白屏/JS 报错无感知（WebView 里看不到 console） | `window.addEventListener('error'|'unhandledrejection')` → 批量上报（含 UA、页面、版本） | P2 / S |
| 更新失败率 | `MainActivity.java:758-764` 失败只 `Toast`；服务端不记录下载开始/完成 | 无法回答"这次发版成功率多少" | 服务端给下载加计数（`apk_download_log` 表：ip_hash/version/bytes/range/status）；客户端上报 `update_start/ok/fail(reason)` | P2 / M |
| 服务端日志 | 纯 stdout，无文件、无请求日志（无 morgan 之类） | EXE 用户报障时无 access log；`app-update.js` 的 404/异常也不记 | 加 `pino`/简单 `fs.appendFileSync` 到 `logs/server-YYYYMMDD.log`，滚动保留 7 天；至少给 `/api/app/*` 记一行 | P2 / S |
| 灰度 | 单一 `apkUrl`，所有手机同一个包 | 新包有致命 bug 时全量用户受影响 | 清单加 `channel` + `rolloutPercent`，客户端按 `deviceId` 哈希取模；或 `minSupportedVersionCode` 控制强制更新范围 | P3 / M |
| 回滚 | `versionCode` 只能升；安装器拒绝降级 | 只能"发一个更高版本号的修复包"，无法真正回退 | ① 保留上一版 APK 与清单（`release/android/archive/`）；② 紧急回滚 = 用旧代码 + **更大的 versionCode** 重打（`4.6.1-rollback1`），这是唯一可行路径，应写进 runbook；③ 长期靠热更新（前端在 `public/`，改完即生效）覆盖 90% 的"回滚"需求 | P2 / S |

---

## 7. 若只做 5 件事

1. **把 `/app` 从 `PUBLIC_API_PREFIXES` 里摘掉，下载走短时签名 URL**（`server.js:45` + `routes/app-update.js:86`）。
   现在同一 Wi-Fi 里任何人都能无凭据拉走 APK，且 `/api/app/android-version` 是个完美的"这台机器在跑 CinemaVault"探针。工作量 **S**。

2. **发版改成「清单驱动」**：删掉 `APK_NAMES` / `SEARCH_DIRS` / `build.gradle` 正则（`routes/app-update.js:10-60`），改读 `release/android-manifest.json`（versionCode/versionName/size/sha256/changelog），构建脚本用 `aapt2` 从 APK 自身回读版本并算 sha256。
   这一步同时消灭"可能发旧包/发 debug 包/版本回退成硬编码 4.5.6"三个 P0。工作量 **M**。

3. **换成 release keystore 并关掉 `debuggable`**（`android/app/build.gradle:19-24` + `key.properties`），并在清单里固化 `signingCertSha256`。
   当前三包全是 `CN=Android Debug` + `application-debuggable`，debug 私钥等同公开 → 任何人可签同包名恶意包，配合"无校验直接装"就是完整供应链攻击。**这一步必须配一次"卸载重装"迁移公告**。工作量 **M**。

4. **下载链路补 Range + SHA-256 校验**：服务端 `res.sendFile(..., {acceptRanges:true})` + `Digest`/`X-Apk-Sha256` 头；客户端 `MainActivity.java:700-757` 加续传、重试 3 次、下完比对 sha256 不一致就删包报错。
   现状实测 `Range: bytes=0-99` 仍回整包 6.9 MB，弱网下更新失败率必然高，而且下错包无从发现。工作量 **M**。

5. **把 `auth.enabled` 默认打开并在启动日志里对"无密码"喊话**（`%APPDATA%\CinemaVault\runtime\config.json` 当前是 `false`，导致整个 `/api/*` 局域网可写）。
   这一条是本次审计**唯一一个"当前线上就跑在裸奔状态"**的问题，改动只有几行配置 + 一行警告日志，性价比最高。工作量 **XS**。

> 可选第 6 件（成本极低、体验收益极大）：桌面端设置页生成 `http://<lan-ip>:3517` 二维码，并把手机端默认地址 `10.0.2.2:3517`（`MainActivity.java:183/205/720`）改掉——手机首次安装目前"一定连不上"。
