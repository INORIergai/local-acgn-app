$ErrorActionPreference = 'Stop'
# 把仓库当前的「前端 + 后端 + 安卓安装包」同步进桌面版的两个运行目录，
# 让手机上连同一台电脑时，看到的就是仓库里的最新版本（含 v4.6.0 的启动门/gzip/更新校验）。
# 只覆盖不删除：运行目录里用户自己的额外文件（runtime/public/index.html 等）保持原样。
$root = (Get-Location).Path
$runtime = Join-Path (Join-Path $env:APPDATA 'CinemaVault') 'runtime'
$payload = Join-Path (Join-Path (Join-Path (Join-Path $root 'exe') '免安装目录') 'win-unpacked\resources') 'payload'
$targets = @($runtime, $payload) | Where-Object { Test-Path $_ }
if (-not $targets) { throw '找不到运行目录（runtime / payload 都不存在），未做任何拷贝' }

$copied = 0

function Copy-Rel($rel) {
    $source = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $source)) { throw "源文件不存在: $rel" }
    foreach ($base in $targets) {
        $dst = Join-Path $base $rel
        $dir = Split-Path $dst -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item -LiteralPath $source -Destination $dst -Force
    }
    $script:copied++
}

# 1) 前端整棵树（含 js/css/lib/img 与各 reader 页面）
$publicRoot = Join-Path $root 'public'
Get-ChildItem -LiteralPath $publicRoot -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1)
    Copy-Rel $rel
}

# 2) 后端：server.js(gzip 中间件) + routes/ + 版本解析要用到的 build.gradle
Copy-Rel 'server.js'
Get-ChildItem -LiteralPath (Join-Path $root 'routes') -File | Where-Object { $_.Extension -eq '.js' } | ForEach-Object {
    Copy-Rel ($_.FullName.Substring($root.Length + 1))
}

# 3) 安卓安装包：让 /api/app/android-version 能算出真实体积与 sha256
$gradle = Join-Path $root 'android\app\build.gradle'
$ver = [regex]::Match((Get-Content -LiteralPath $gradle -Raw), 'versionName\s+"([^"]+)"').Groups[1].Value
if (-not $ver) { throw '未能从 android/app/build.gradle 解析 versionName' }
$apk = Join-Path $root ("CinemaVault-v{0}-Android.apk" -f $ver)
if (-not (Test-Path -LiteralPath $apk)) { throw "安装包不存在: $apk（先跑 packaging\build-android.ps1）" }
foreach ($base in $targets) {
    Copy-Item -LiteralPath $apk -Destination (Join-Path $base ("CinemaVault-v{0}-Android.apk" -f $ver)) -Force
    Copy-Item -LiteralPath $apk -Destination (Join-Path $base 'CinemaVault-Android.apk') -Force
    $gdir = Join-Path $base 'android\app'
    if (-not (Test-Path $gdir)) { New-Item -ItemType Directory -Path $gdir -Force | Out-Null }
    Copy-Item -LiteralPath $gradle -Destination (Join-Path $gdir 'build.gradle') -Force
}
Write-Output ("APK 已同步: v{0}  {1:N0} 字节" -f $ver, (Get-Item -LiteralPath $apk).Length)

Write-Output ("共覆盖 {0} 个文件 → {1}" -f $copied, ($targets -join ' , '))

# 4) 直接问正在运行的服务确认生效
try {
    $r = Invoke-WebRequest 'http://127.0.0.1:3517/api/app/android-version' -UseBasicParsing -TimeoutSec 10
    $j = $r.Content | ConvertFrom-Json
    Write-Output ("在线版本接口: version={0} fileSize={1} sha={2} source={3}" -f $j.version, $j.fileSize, ($j.apkSha256 -replace '^(.{12}).*', '$1…'), $j.versionSource)
} catch {
    Write-Output ("在线校验跳过（服务未运行?）: {0}" -f $_.Exception.Message)
}
