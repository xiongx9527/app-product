# 安装 Ollama（Windows）。
#
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-ollama.ps1
#
# 说明：
#   - 优先用 winget 安装 Ollama.Ollama。
#   - 没有 winget 时下载官方 OllamaSetup.exe 并静默安装。
#   - macOS / Linux 请用同目录的 install-ollama.sh。
$ErrorActionPreference = 'Stop'

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "Ollama 已安装：$(& ollama --version 2>$null)"
    Write-Host '服务通常随托盘程序自动启动；未启动时运行：ollama serve'
    exit 0
}

$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
    Write-Host '==> 使用 winget 安装 Ollama'
    winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
} else {
    Write-Host '==> 未检测到 winget，下载官方安装包'
    $installer = Join-Path $env:TEMP 'OllamaSetup.exe'
    Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $installer
    Write-Host '==> 静默安装'
    Start-Process -FilePath $installer -ArgumentList '/VERYSILENT', '/NORESTART' -Wait
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '安装完成。若当前终端找不到 ollama，请新开一个终端（PATH 需要刷新）。'
Write-Host '验证：ollama --version；下载模型：powershell -ExecutionPolicy Bypass -File .\scripts\pull-ollama-models.ps1'
