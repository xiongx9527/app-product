@echo off
rem Windows 安装 Ollama 的入口：转发到 install-ollama.ps1。
rem 用法：scripts\install-ollama.cmd
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ollama.ps1" %*
exit /b %errorlevel%
