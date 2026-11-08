<#
.SYNOPSIS
  启动本地语音服务（STT: SenseVoice / TTS: edge-tts），默认监听 0.0.0.0:9529。

.DESCRIPTION
  所有运行参数都可以写在配置文件里（默认 VoiceHome\voice.conf）；
  命令行参数优先级最高，只覆盖本次启动，不改配置文件。
  默认不启用 API Key，需要时用 -RequireApiKey 或配置文件开启。

  启动前会调用 voice\preflight.py 检查依赖环境（本地模式检查模型 / ffmpeg，
  代理模式检查基础包和上游地址）。检查失败时只打印安装方法，不会自动安装。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1 -Port 9531
  powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1 -Ip 127.0.0.1
  powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1 -Config C:\path\voice.conf
  powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1 -RequireApiKey
  powershell -ExecutionPolicy Bypass -File .\scripts\start-voice.ps1 -ApiKey off
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [Alias("Ip")]
    [string]$BindHost = "",
    [string]$VoiceHome = "",
    [string]$Config = "",
    [string]$ApiKey = "",
    [string]$ApiKeyFile = "",
    [switch]$RequireApiKey,
    [switch]$NoApiKey,
    # 供 voice.ps1 在后台启动前同步预检；对用户无副作用。
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

# Python 按 UTF-8 输出中文；同步控制台解码方式，避免日志里的安装提示变成乱码。
$env:PYTHONIOENCODING = "utf-8"
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
}
catch {
    # 极旧的宿主可能不支持修改，忽略即可，不影响服务启动。
}

$ScriptDir = $PSScriptRoot
$Server = Join-Path $ScriptDir "voice\openai_voice_server.py"
$Checker = Join-Path $ScriptDir "voice\preflight.py"

if (-not $VoiceHome) {
    if ($env:VOICE_HOME) {
        $VoiceHome = $env:VOICE_HOME
    }
    else {
        $local = $env:LOCALAPPDATA
        if (-not $local) {
            $local = Join-Path $HOME "AppData\Local"
        }
        $VoiceHome = Join-Path $local "app-product\voice"
    }
}

if (-not $Config) {
    if ($env:VOICE_CONFIG) {
        $Config = $env:VOICE_CONFIG
    }
    else {
        $Config = Join-Path $VoiceHome "voice.conf"
    }
}

# 鉴权模式只允许选一种，避免 -RequireApiKey 和 -ApiKey off 同时出现时行为不明确。
$authModes = @()
if ($RequireApiKey) { $authModes += "require" }
if ($NoApiKey) { $authModes += "off" }
if ($ApiKey) { $authModes += "value" }
if ($authModes.Count -gt 1) {
    throw "只能指定 -RequireApiKey、-NoApiKey、-ApiKey 中的一个"
}

$VenvPython = Join-Path $VoiceHome "venv\Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    throw "未找到虚拟环境：$VenvPython`n手动安装（启动脚本不会自动安装）：scripts\install-voice.cmd`n如果依赖装在别处，请设置 VOICE_HOME 指向包含 venv 的目录。"
}
if (-not (Test-Path $Server)) {
    throw "未找到服务脚本：$Server"
}
if (-not (Test-Path $Checker)) {
    throw "未找到依赖检查脚本：$Checker"
}

# 只导出显式设置的值，让配置文件里的其它项继续生效。
$env:VOICE_CONFIG = $Config
$env:VOICE_HOME = $VoiceHome
if ($Port -gt 0) {
    $env:VOICE_PORT = "$Port"
}
if ($BindHost) {
    $env:VOICE_HOST = $BindHost
}
if ($RequireApiKey) {
    $env:VOICE_API_KEY = "auto"
}
elseif ($NoApiKey) {
    $env:VOICE_API_KEY = "off"
}
elseif ($ApiKey) {
    $env:VOICE_API_KEY = $ApiKey
}
if ($ApiKeyFile) {
    $env:VOICE_API_KEY_FILE = $ApiKeyFile
}

if (-not (Test-Path $Config)) {
    Write-Host "提示: 配置文件不存在，使用内置默认值；可运行 scripts\install-voice.cmd 生成模板。"
}
Write-Host "启动前检查依赖环境（只检查，不自动安装）..."
& $VenvPython $Checker
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
if ($CheckOnly) {
    exit 0
}
Write-Host ""
Write-Host "启动后以服务打印的监听地址、模型状态和鉴权状态为准。"
Write-Host "按 Ctrl+C 停止。"
Write-Host ""

& $VenvPython $Server
exit $LASTEXITCODE
