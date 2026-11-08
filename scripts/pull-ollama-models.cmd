@echo off
rem Windows 下载 Ollama 模型的入口：转发到 pull-ollama-models.ps1。
rem 用法：
rem   scripts\pull-ollama-models.cmd                  按 ollama-models.txt 下载
rem   scripts\pull-ollama-models.cmd gpt-oss:20b      只下载指定模型
rem   scripts\pull-ollama-models.cmd -DryRun          只打印清单
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pull-ollama-models.ps1" %*
exit /b %errorlevel%
