# 下载 Ollama 模型（Windows）。
#
# 用法（PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\pull-ollama-models.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\pull-ollama-models.ps1 gpt-oss:20b qwen3:8b
#   powershell -ExecutionPolicy Bypass -File .\scripts\pull-ollama-models.ps1 -DryRun
#
# 默认读取同目录 ollama-models.txt；服务未启动时会尝试拉起 ollama serve。
param(
    [switch]$DryRun,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Models
)
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ModelsFile = Join-Path $ScriptDir 'ollama-models.txt'

if (-not $Models -or $Models.Count -eq 0) {
    if (-not (Test-Path $ModelsFile)) {
        throw "找不到模型清单：$ModelsFile"
    }
    $Models = Get-Content $ModelsFile |
        ForEach-Object { ($_ -split '#', 2)[0].Trim() } |
        Where-Object { $_ -ne '' }
}

if (-not $Models -or $Models.Count -eq 0) {
    throw "模型清单为空：$ModelsFile"
}

if ($DryRun) {
    Write-Host '将下载以下模型（dry-run，未执行）：'
    $Models | ForEach-Object { Write-Host "  - $_" }
    exit 0
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw '未找到 ollama。请先运行 .\scripts\install-ollama.ps1。'
}

function Test-OllamaReady {
    $null = & ollama list 2>$null
    return $?
}

if (-not (Test-OllamaReady)) {
    $hostValue = $env:OLLAMA_HOST
    $isLocal = (-not $hostValue) -or $hostValue -match '^(127\.0\.0\.1|localhost|0\.0\.0\.0)'
    if (-not $isLocal) {
        throw "Ollama 服务不可用（OLLAMA_HOST=$hostValue），请先确认远端服务已启动。"
    }

    $logFile = Join-Path $env:TEMP 'ollama-serve.log'
    $errFile = Join-Path $env:TEMP 'ollama-serve.err.log'
    Write-Host "Ollama 服务未启动，后台拉起 ollama serve（日志：$logFile）"
    Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden `
        -RedirectStandardOutput $logFile -RedirectStandardError $errFile

    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-OllamaReady) { $ready = $true; break }
    }
    if (-not $ready) {
        Write-Host 'Ollama 启动失败，最近日志：' -ForegroundColor Red
        if (Test-Path $errFile) { Get-Content $errFile -Tail 20 }
        if (Test-Path $logFile) { Get-Content $logFile -Tail 20 }
        exit 1
    }
}

$failed = @()
foreach ($model in $Models) {
    Write-Host ''
    Write-Host "==> 下载 $model"
    & ollama pull $model
    if ($LASTEXITCODE -ne 0) { $failed += $model }
}

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host "以下模型下载失败：$($failed -join ' ')" -ForegroundColor Red
    Write-Host '完整列表：ollama list'
    exit 1
}

Write-Host '全部完成。已安装模型：'
& ollama list
