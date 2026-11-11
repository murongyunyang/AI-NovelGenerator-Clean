@echo off
chcp 65001 >nul
cd /d %~dp0
rem 开发模式：直接运行仓库源码。改前端代码后在窗口里按 F5 刷新；改后端代码后关闭窗口重新运行本文件。
if not exist "build\runtime\python\python.exe" (
    echo 首次运行，正在准备运行环境...
    python build.py --runtime-only || (pause & exit /b 1)
)
if not exist "..\frontend\node_modules" (
    pushd ..\frontend
    set "PATH=%~dp0build\runtime\node;%PATH%"
    call npm ci || (popd & pause & exit /b 1)
    popd
)
set "PATH=%~dp0build\runtime\node;%PATH%"
"build\runtime\python\python.exe" launch.py
