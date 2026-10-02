@echo off
rem ============================================================
rem  Quark login helper for Cinema Vault
rem
rem  IMPORTANT - keep this file PURE ASCII.
rem  Chinese text inside a .bat breaks cmd.exe: once "chcp 65001" has
rem  run, cmd re-reads the batch file with a mis-computed byte offset,
rem  splits a multi-byte character in half, and executes the tail of the
rem  line as a command:
rem      'xxx' is not recognized as an internal or external command,
rem      operable program or batch file.
rem  A UTF-8 BOM makes it worse (cmd does not skip the BOM on a CP437
rem  console, so "@echo off" on line 1 stops working).
rem  All user-facing Chinese messages are printed by quark-login.js.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo [ERROR] node.exe not found. Install Node.js from https://nodejs.org
    echo         or add the folder containing node.exe to PATH, then rerun.
    echo.
    pause
    exit /b 1
)

echo Detecting the running Cinema Vault instance - desktop app or Docker...
echo.
"%NODE_EXE%" quark-login.js %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
    echo [TIP] script exit code %RC%.
    echo       If no running instance was found, start one first and retry.
    echo.
)
pause
