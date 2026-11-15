@echo off
rem 启动本地语音服务（STT + TTS），默认监听 0.0.0.0:9529。
rem 用法: scripts\start-voice.cmd [-Port 9531] [-Ip 127.0.0.1] [-Config voice.conf]
rem       scripts\start-voice.cmd [-RequireApiKey] [-ApiKey off] [-ApiKeyFile path]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-voice.ps1" %*
exit /b %ERRORLEVEL%
