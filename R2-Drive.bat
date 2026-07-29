@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

cls
echo ====================================================
echo  R2 Drive 小白启动器 · Windows
echo ====================================================
echo 这个窗口只在你的电脑上运行，不会把密钥发给项目作者。
echo.

where node >nul 2>nul
if errorlevel 1 goto node_missing
where npm >nul 2>nul
if errorlevel 1 goto node_missing

node -e "const v=process.versions.node.split('.').map(Number); process.exit(v[0] * 1000 + v[1] >= 22013 ? 0 : 1)"
if errorlevel 1 goto node_missing

for /f "delims=" %%V in ('node --version') do set "NODE_VERSION=%%V"
echo Node.js %NODE_VERSION% 已就绪。
echo 请选择打开网盘、配置，或删除当前实例。
echo.
node scripts\launcher.mjs
if errorlevel 1 goto launcher_failed
echo.
echo R2 Drive 启动器已退出。下次需要时重新双击本文件即可。
pause
goto end

:node_missing
echo.
echo 未找到可用的 Node.js 22.13 或更高版本。
echo 现在将打开 Node.js 官方下载页面。请安装 LTS 版本，然后重新双击本文件。
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:launcher_failed
echo.
echo R2 Drive 启动器意外停止。请重新双击 R2-Drive.bat 再试一次。
pause
exit /b 1

:end
endlocal
