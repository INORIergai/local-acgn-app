@echo off
chcp 65001 >nul
title 午夜场 · 海报中转 (poster-relay)
cd /d "%~dp0.."

echo ================================================
echo   午夜场 · 海报中转小服务
echo   作用：让 Docker 容器借用宿主机的网络出口，
echo         去抓 hanime / AniList 这类容器打不通的站。
echo   关掉这个黑窗口 = 停止服务（随时可以再双击启动）
echo ================================================
echo.

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not defined NODE_EXE (
  echo [x] 没找到 node.exe，请先装 Node.js，或手动改这个 bat 里的路径。
  pause
  exit /b 1
)

echo 使用 node: %NODE_EXE%
echo.
"%NODE_EXE%" "tools\poster-relay.js"

echo.
echo 服务已退出。
pause
