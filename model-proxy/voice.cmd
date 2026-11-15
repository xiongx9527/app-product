@echo off
rem 本地语音服务管理：start / stop / restart / status / check / log / run。
rem 用法: scripts\voice.cmd start [-Port 9531] [-Ip 127.0.0.1]
rem       scripts\voice.cmd status / stop / restart / check
rem       scripts\voice.cmd log [-f] [-n 200]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0voice.ps1" %*
exit /b %ERRORLEVEL%
