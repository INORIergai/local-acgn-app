@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

REM ============================================
REM  本地影库 - 注册唤起协议（仅需运行一次）
REM  注册 lmlplayer://（PotPlayer 播放）
REM         lmlfolder://（打开所在文件夹）
REM  仅写入当前用户的注册表（无需管理员权限）
REM ============================================

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

REM 定位 node.exe
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%i"
)

if not defined NODE (
    echo [错误] 未找到 node.exe，请先安装 Node.js 后重试。
    pause
    exit /b 1
)

echo 使用 Node: %NODE%
echo 处理脚本目录: %ROOT%
echo.

REM ---- 注册 lmlplayer:// 协议 ----
echo [1/2] 注册 lmlplayer:// 协议（PotPlayer 播放）...
reg add "HKCU\Software\Classes\lmlplayer" /ve /d "URL:Local Movie Library Player" /f >nul
reg add "HKCU\Software\Classes\lmlplayer" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\lmlplayer\shell" /ve /d "open" /f >nul
reg add "HKCU\Software\Classes\lmlplayer\shell\open\command" /ve /d "\"%NODE%\" \"%ROOT%\protocol-handler.js\" \"%%1\"" /f >nul

REM ---- 注册 lmlfolder:// 协议 ----
echo [2/2] 注册 lmlfolder:// 协议（打开所在文件夹）...
reg add "HKCU\Software\Classes\lmlfolder" /ve /d "URL:Local Movie Library Folder" /f >nul
reg add "HKCU\Software\Classes\lmlfolder" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\lmlfolder\shell" /ve /d "open" /f >nul
reg add "HKCU\Software\Classes\lmlfolder\shell\open\command" /ve /d "\"%NODE%\" \"%ROOT%\protocol-handler.js\" \"%%1\"" /f >nul

echo.
echo [完成] 协议注册成功！
echo 现在可以使用影库里的「用 PotPlayer 打开」和「打开文件夹」按钮了。
echo.
pause
