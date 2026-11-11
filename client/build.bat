@echo off
chcp 65001 >nul
cd /d %~dp0
rem 打包桌面客户端。可加参数：--skip-frontend（只改了后端/客户端代码时更快）
python build.py %*
if errorlevel 1 (
    echo.
    echo 打包失败，请查看上面的错误信息。
)
pause
