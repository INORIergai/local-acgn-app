@echo off
rem ============================================================================
rem  Cinema Vault 桌面版一键打包（Windows x64）
rem ----------------------------------------------------------------------------
rem  产物（都在 dist\ 下）：
rem    CinemaVault-Setup-1.0.0.exe       安装版，会建桌面快捷方式 / 开始菜单项
rem    CinemaVault-Portable-1.0.0.exe    免安装单文件，双击即可，数据存 exe 同级
rem
rem  全程不需要 Docker；需要本机有 Node（≥18）与网络（走 npmmirror 镜像）。
rem  首次运行会下载 Electron 运行时与打包工具，约 200MB，请耐心等。
rem ============================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo  [1/5] 生成脱敏导出副本 payload\  （不含个人数据/密钥）
echo ============================================
call node prepare-export.js || goto :fail

echo.
echo ============================================
echo  [2/5] 应用依赖（Electron ABI 的 better-sqlite3）
echo ============================================
if exist "payload\node_modules\better-sqlite3" (
    echo     已存在 payload\node_modules，跳过安装
) else (
    echo     未安装，开始 npm install（--runtime=electron）...
    pushd payload
    set npm_config_runtime=electron
    set npm_config_target=33.4.11
    set npm_config_disturl=https://electronjs.org/headers
    call npm install --no-audit --no-fund || (popd & goto :fail)
    popd
)
call node ensure-native.js || goto :fail

echo.
echo ============================================
echo  [3/5] Electron 运行时与打包器
echo ============================================
if exist "node_modules\electron\dist\electron.exe" (
    echo     Electron 已就绪，跳过
) else (
    echo     正在安装（约 200MB，首次较慢）...
    call npm install --no-audit --no-fund || goto :fail
)

echo.
echo ============================================
echo  [4/5] 打包 exe（安装版 + 便携版）
echo ============================================
call npm run dist || goto :fail

echo.
echo ============================================
echo  [5/5] 完成！产物：
echo ============================================
dir /b dist\*.exe
echo.
pause
exit /b 0

:fail
echo.
echo ❌ 打包失败，请把上面的报错整段发给开发者。
echo.
pause
exit /b 1
