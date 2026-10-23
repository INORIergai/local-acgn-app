# 拉起桌面版 CinemaVault，并强制它绑到指定端口（默认 3527）
# 背景：本机 3517 会被其它常驻程序占用，桌面版 findFreePort 的探活有竞态，
#       会误判 3517 空闲 → 后端 EADDRINUSE → waitServer 超时 → 应用自动退出。
param([int]$Port = 3527)
$ErrorActionPreference = 'Stop'

$exe   = 'D:\ai program\local-movie-library\exe\免安装目录\win-unpacked\CinemaVault.exe'
$dir   = Split-Path -Parent $exe
$link  = 'D:\cv-unpacked'          # 纯 ASCII 软链，供 bat 使用（避免 cmd 的 GBK/UTF-8 路径问题）
$bat   = 'D:\cv-launch.bat'

if (-not (Test-Path $exe)) { Write-Output "MISSING_EXE $exe"; exit 1 }

if (-not (Test-Path (Join-Path $link 'CinemaVault.exe'))) {
    if (Test-Path $link) { cmd /c rmdir $link | Out-Null }
    New-Item -ItemType Junction -Path $link -Target $dir | Out-Null
}
if (-not (Test-Path (Join-Path $link 'CinemaVault.exe'))) { Write-Output "JUNCTION_FAILED"; exit 1 }

$lines = @(
    '@echo off',
    ('set "CV_PORT=' + $Port + '"'),
    ('start "" "' + $link + '\CinemaVault.exe"')
)
Set-Content -Path $bat -Value $lines -Encoding ASCII

$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = ('cmd.exe /c ' + $bat)
    CurrentDirectory = $dir
}
Write-Output ("spawn=" + $r.ReturnValue + " pid=" + $r.ProcessId)

$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 3
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c) { $ok = $true; break }
}
if ($ok) { Write-Output ("LISTENING 127.0.0.1:" + $Port) }
else { Write-Output ("NOT_LISTENING " + $Port); exit 2 }
