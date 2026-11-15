@echo off
rem 安装本地语音服务（STT + TTS），Windows 原生运行，不使用 Docker。
rem 用法: scripts\install-voice.cmd [-TtsOnly] [-SttOnly] [-ProxyOnly] [-SkipModel] [-DryRun]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-voice.ps1" %*
exit /b %ERRORLEVEL%
