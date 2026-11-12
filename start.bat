@echo off
chcp 65001>nul
title memory-studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH 环境变量。
  pause
  exit /b 1
)

set "PORT=18900"
echo 正在启动 memory-studio ...
echo 本机地址: http://127.0.0.1:%PORT%
echo 关闭本窗口或按 Ctrl+C 即可停止服务。
start "" "http://127.0.0.1:%PORT%"
node server.js

pause
