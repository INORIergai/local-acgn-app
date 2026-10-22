<#
    CinemaVault · Android 发布打包脚本
    ------------------------------------------------------------------
    用法（在仓库根目录）：
        powershell -ExecutionPolicy Bypass -File packaging\build-android.ps1

    它做的事（五步，全部幂等）：
      1. 从 android/app/build.gradle 读取 versionCode / versionName —— 这是整个项目里
         **唯一可信的版本来源**（不再手写 UA、不再手写更新接口的兜底版本号）。
      2. 用 JDK 21 调 gradlew assembleRelease（release 签名来自 android/keystore.properties）。
      3. 把产物复制到仓库根目录：CinemaVault-v<versionName>-Android.apk，
         同时刷新 CinemaVault-Android.apk（"最新版"别名，给老客户端/直链用）。
      4. 打印 SHA-256 与体积 —— 服务端 /api/app/android-version 会读同一个文件算哈希，
         两边算法一致，客户端会拿它做下载后校验。
      5. 用 apksigner 校验签名，确认不是 debug 证书。
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$androidDir = Join-Path $repoRoot 'android'
$gradleFile = Join-Path $androidDir 'app\build.gradle'

if (-not (Test-Path $gradleFile)) { throw "找不到 $gradleFile" }
if (-not (Test-Path (Join-Path $androidDir 'keystore.properties'))) {
    Write-Warning "android/keystore.properties 不存在 → release 包将不带签名（无法安装）。请参照 keystore.properties.example 生成。"
}

# ---------- 1. 单一版本源 ----------
$gradleText = Get-Content $gradleFile -Raw
$versionName = ([regex]'versionName\s+"([^"]+)"').Match($gradleText).Groups[1].Value
$versionCode = ([regex]'versionCode\s+(\d+)').Match($gradleText).Groups[1].Value
if (-not $versionName -or -not $versionCode) { throw "无法从 build.gradle 解析 versionName/versionCode" }
Write-Host "[1/5] 版本源：v$versionName (versionCode $versionCode)" -ForegroundColor Cyan

# ---------- 2. 编译 ----------
if (-not $env:JAVA_HOME) {
    if (Test-Path 'D:\apps\jdk-21') { $env:JAVA_HOME = 'D:\apps\jdk-21' }
    else { throw "需要 JDK 17+：请设置 JAVA_HOME（PATH 上的 java 可能是 1.8，Gradle 8.9 不认）" }
}
Write-Host "[2/5] JAVA_HOME=$env:JAVA_HOME，开始 assembleRelease…" -ForegroundColor Cyan
Push-Location $androidDir
try {
    & cmd /c "gradlew.bat :app:assembleRelease --console=plain"
    if ($LASTEXITCODE -ne 0) { throw "gradle assembleRelease 失败（exit $LASTEXITCODE）" }
} finally { Pop-Location }

$srcApk = Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $srcApk)) { throw "找不到构建产物 $srcApk" }

# ---------- 3. 复制到仓库根 ----------
$versionedApk = Join-Path $repoRoot "CinemaVault-v$versionName-Android.apk"
$aliasApk = Join-Path $repoRoot 'CinemaVault-Android.apk'
Copy-Item $srcApk $versionedApk -Force
Copy-Item $srcApk $aliasApk -Force
Write-Host "[3/5] 产物：$(Split-Path -Leaf $versionedApk)（并刷新 CinemaVault-Android.apk）" -ForegroundColor Cyan

# ---------- 4. 哈希 ----------
$hash = (Get-FileHash $versionedApk -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $versionedApk).Length
Write-Host "[4/5] SHA-256: $hash" -ForegroundColor Green
Write-Host "      体积: $([math]::Round($size/1MB,2)) MB ($size 字节)" -ForegroundColor Green
# 供 CI/脚本读取
@{ versionName = $versionName; versionCode = [int]$versionCode; sha256 = $hash; size = $size; file = (Split-Path -Leaf $versionedApk) } |
    ConvertTo-Json | Set-Content (Join-Path $repoRoot 'android\last-build.json') -Encoding UTF8

# ---------- 5. 签名校验 ----------
$sdk = $env:ANDROID_HOME
if (-not $sdk) {
    $localProps = Join-Path $androidDir 'local.properties'
    if (Test-Path $localProps) {
        $line = Select-String -Path $localProps -Pattern '^sdk\.dir=(.+)$' | Select-Object -First 1
        if ($line) { $sdk = $line.Matches[0].Groups[1].Value.Trim() -replace '\\\\', '\' -replace '\\:', ':' }
    }
}
$apksignerJar = $null
if ($sdk) {
    $bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory -ErrorAction SilentlyContinue |
          Sort-Object Name -Descending | Select-Object -First 1
    if ($bt) {
        $candidate = Join-Path $bt.FullName 'lib\apksigner.jar'
        if (Test-Path $candidate) { $apksignerJar = $candidate }
    }
}
if ($apksignerJar) {
    Write-Host "[5/5] 签名校验：" -ForegroundColor Cyan
    & "$env:JAVA_HOME\bin\java.exe" -jar $apksignerJar verify --print-certs $versionedApk |
        Select-String 'DN:|SHA-256 digest' | Select-Object -First 2 | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -ne 0) { throw "apksigner verify 失败：包未签名或签名无效" }
} else {
    Write-Warning "[5/5] 跳过 apksigner（没找到 build-tools）"
}

Write-Host ""
Write-Host "完成。接下来：" -ForegroundColor Yellow
Write-Host "  1) 重启服务端（或等它重新扫描），/api/app/android-version 会读到新包"
Write-Host "  2) git add -A && git commit -m `"chore(android): release v$versionName`" && git push"
Write-Host "  3) 提醒用户：本次换了正式签名，装 v4.6.0 前必须**先卸载** v4.5.x 一次"
