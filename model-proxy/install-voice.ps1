<#
.SYNOPSIS
  安装本地语音服务：STT（SenseVoice）+ TTS（edge-tts），Windows 原生运行，不使用 Docker。

.DESCRIPTION
  默认同时安装 STT 和 TTS：
    1. 在 VoiceHome 下创建独立 Python 虚拟环境，不污染系统 Python；
    2. STT：sherpa-onnx + SenseVoice-small 模型（约 240MB，下载后离线可用）；
    3. TTS：edge-tts + ffmpeg（edge-tts 只输出 MP3，网关要求 WAV，需要 ffmpeg 转码）；
    4. 首次安装时把 voice.conf.example 复制成 VoiceHome\voice.conf。

  运行目录默认 %LOCALAPPDATA%\app-product\voice，可用 -VoiceHome 覆盖。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -TtsOnly
  powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -SttOnly
  powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -ProxyOnly
  powershell -ExecutionPolicy Bypass -File .\scripts\install-voice.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$SttOnly,
    [switch]$TtsOnly,
    [switch]$ProxyOnly,
    [switch]$SkipModel,
    [switch]$DryRun,
    [string]$Python = "",
    [string]$VoiceHome = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptDir = $PSScriptRoot
$ReqDir = Join-Path $ScriptDir "voice"

if ($SttOnly -and $TtsOnly) {
    throw "不能同时指定 -SttOnly 和 -TtsOnly"
}
if ($ProxyOnly -and ($SttOnly -or $TtsOnly)) {
    throw "-ProxyOnly 不能和 -SttOnly / -TtsOnly 同时使用"
}

# 运行目录放在用户目录而不是仓库里：模型约 240MB，避免污染 git 状态。
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

$VenvDir = Join-Path $VoiceHome "venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ModelDir = Join-Path $VoiceHome "models\sensevoice"
$ConfigFile = Join-Path $VoiceHome "voice.conf"
$ModeFile = Join-Path $VoiceHome "install-mode"
$ConfigTemplate = Join-Path $ReqDir "voice.conf.example"

$DoStt = (-not $TtsOnly) -and (-not $ProxyOnly)
$DoTts = (-not $SttOnly) -and (-not $ProxyOnly)
$DownloadModel = $DoStt -and (-not $SkipModel)

# 记录安装模式，供启动前的 preflight 判断哪些本地依赖是“预期缺失”。
# 例如 -TtsOnly 没装 SenseVoice，启动检查不应因此拒绝启动。
if ($ProxyOnly) {
    $InstallMode = "proxy-only"
}
elseif ($TtsOnly) {
    $InstallMode = "tts-only"
}
elseif ($SttOnly) {
    $InstallMode = "stt-only"
}
else {
    $InstallMode = "full"
}

$ModelMirror = "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"
$ModelFallback = "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host $Message -ForegroundColor Cyan
}

function Write-DryRun([string]$Message) {
    Write-Host "  [dry-run] $Message" -ForegroundColor DarkGray
}

# ── 找 Python 3.10+ ──────────────────────────────────────────────
# 优先用 Windows 自带的 py launcher；没有时再找 PATH 里的 python / python3。
$PythonExe = $null
$PythonArgs = @()

if ($Python) {
    $cmd = Get-Command $Python -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "找不到 Python：$Python"
    }
    $PythonExe = $cmd.Source
}
elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonExe = (Get-Command py).Source
    $PythonArgs = @("-3")
}
elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonExe = (Get-Command python).Source
}
elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    $PythonExe = (Get-Command python3).Source
}
else {
    throw "找不到 Python，请先安装 Python 3.10+，并用 -Python 指定 python.exe 路径"
}

& $PythonExe @PythonArgs -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"
if ($LASTEXITCODE -ne 0) {
    $version = (& $PythonExe @PythonArgs --version 2>&1) -join " "
    throw "需要 Python 3.10+（当前 $version）"
}

Write-Step "[1/4] 准备运行目录：$VoiceHome"
if ($DryRun) {
    Write-DryRun "创建 $VoiceHome 和 $ModelDir"
    Write-DryRun "写入 $ModeFile（$InstallMode）"
}
else {
    New-Item -ItemType Directory -Force -Path $VoiceHome, $ModelDir | Out-Null
    Set-Content -Path $ModeFile -Value $InstallMode -Encoding ASCII
}
Write-Host "  安装模式：$InstallMode"

# 只复制模板，不覆盖已有配置：用户改过的端口 / IP / API Key 必须保留。
if (Test-Path $ConfigFile) {
    Write-Host "  保留已有配置：$ConfigFile"
}
elseif (Test-Path $ConfigTemplate) {
    if ($DryRun) {
        Write-DryRun "复制 $ConfigTemplate -> $ConfigFile"
    }
    else {
        Copy-Item -Path $ConfigTemplate -Destination $ConfigFile
        Write-Host "  生成配置文件：$ConfigFile"
    }
}
else {
    Write-Warning "未找到配置模板 $ConfigTemplate，启动时将使用内置默认值。"
}

Write-Step "[2/4] 准备 Python 虚拟环境"
# 使用 venv 而不是直接装进系统 Python：依赖较多，隔离后卸载也只需删 VoiceHome。
if (Test-Path $VenvPython) {
    Write-Host "  复用已有虚拟环境：$VenvDir"
}
elseif ($DryRun) {
    Write-DryRun "$PythonExe $($PythonArgs -join ' ') -m venv $VenvDir"
}
else {
    Write-Host "  创建虚拟环境：$VenvDir"
    & $PythonExe @PythonArgs -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        throw "创建虚拟环境失败（退出码 $LASTEXITCODE）"
    }
}

$reqArgs = @()
# STT 和 TTS 的依赖拆成两个文件：-SttOnly / -TtsOnly 时只装需要的那一半。
# -ProxyOnly 两个都不装，只保留基础依赖（FastAPI / uvicorn / httpx）。
if ($DoStt) {
    $reqArgs += @("-r", (Join-Path $ReqDir "requirements-stt.txt"))
}
if ($DoTts) {
    $reqArgs += @("-r", (Join-Path $ReqDir "requirements-tts.txt"))
}
if ($reqArgs.Count -eq 0) {
    $reqArgs += @("-r", (Join-Path $ReqDir "requirements-base.txt"))
}

if ($DryRun) {
    Write-DryRun "$VenvPython -m pip install $($reqArgs -join ' ')"
}
else {
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
        throw "升级 pip 失败（退出码 $LASTEXITCODE）"
    }
    & $VenvPython -m pip install @reqArgs
    if ($LASTEXITCODE -ne 0) {
        throw "安装 Python 依赖失败（退出码 $LASTEXITCODE）"
    }
}

Write-Step "[3/4] 检查 ffmpeg（本地 TTS 把 edge-tts 的 MP3 转成 WAV 需要它）"
if ($ProxyOnly) {
    Write-Host "  跳过：代理模式不需要 ffmpeg"
}
elseif (-not $DoTts) {
    Write-Host "  跳过：只安装 STT"
}
else {
    $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ffmpegCmd) {
        Write-Host "  已安装：$($ffmpegCmd.Source)"
    }
    elseif ($DryRun) {
        Write-DryRun "winget install --id Gyan.FFmpeg -e"
    }
    elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  安装 ffmpeg..."
        & winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements --silent
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "ffmpeg 安装失败；TTS 的 wav 输出将不可用，可稍后手动安装。"
        }
        else {
            Write-Host "  已通过 winget 安装；如果当前终端还找不到 ffmpeg，新开一个终端再启动服务。"
        }
    }
    else {
        Write-Warning "未找到 ffmpeg，TTS 的 wav 输出将不可用。请安装 ffmpeg 后重试。"
    }
}

function Get-RemoteFile {
    param(
        [string]$Url,
        [string]$Destination,
        [long]$MinBytes
    )

    if (Test-Path $Destination) {
        $size = (Get-Item $Destination).Length
        if ($size -ge $MinBytes) {
            Write-Host "  已存在：$(Split-Path $Destination -Leaf)（$size 字节），跳过"
            return $true
        }
        Write-Host "  文件不完整，重新下载：$(Split-Path $Destination -Leaf)"
    }

    if ($DryRun) {
        Write-DryRun "下载 $Url"
        Write-DryRun "     -> $Destination"
        return $true
    }

    $part = "$Destination.part"
    try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe -fL --retry 3 --retry-delay 2 -C - -o $part $Url
            if ($LASTEXITCODE -ne 0) {
                throw "curl 下载失败（退出码 $LASTEXITCODE）"
            }
        }
        else {
            Invoke-WebRequest -Uri $Url -OutFile $part
        }
        Move-Item -Force $part $Destination
        return $true
    }
    catch {
        Write-Warning "  下载失败：$($_.Exception.Message)"
        return $false
    }
}

function Get-ModelFile {
    param(
        [string]$Name,
        [long]$MinBytes
    )

    $dest = Join-Path $ModelDir $Name
    if (Get-RemoteFile -Url "$ModelMirror/$Name" -Destination $dest -MinBytes $MinBytes) {
        return $true
    }

    Write-Host "  镜像下载失败，改用 huggingface.co 重试..."
    return Get-RemoteFile -Url "$ModelFallback/$Name" -Destination $dest -MinBytes $MinBytes
}

if ($ProxyOnly) {
    Write-Step "[4/4] 跳过 SenseVoice 模型下载（-ProxyOnly）"
}
elseif (-not $DoStt) {
    Write-Step "[4/4] 跳过 SenseVoice 模型下载（-TtsOnly）"
}
elseif (-not $DownloadModel) {
    Write-Step "[4/4] 跳过 SenseVoice 模型下载（-SkipModel）"
}
else {
    Write-Step "[4/4] 下载 SenseVoice 模型（约 240MB）到 $ModelDir"

    if (-not (Get-ModelFile -Name "model.int8.onnx" -MinBytes 100000000)) {
        throw "下载 model.int8.onnx 失败"
    }
    if (-not (Get-ModelFile -Name "tokens.txt" -MinBytes 100000)) {
        throw "下载 tokens.txt 失败"
    }

    if (-not $DryRun) {
        $modelSize = (Get-Item (Join-Path $ModelDir "model.int8.onnx")).Length
        $tokenSize = (Get-Item (Join-Path $ModelDir "tokens.txt")).Length
        if ($modelSize -lt 100000000) {
            throw "model.int8.onnx 不完整（$modelSize 字节）"
        }
        if ($tokenSize -lt 100000) {
            throw "tokens.txt 不完整（$tokenSize 字节）"
        }
        Write-Host "  模型就绪：model.int8.onnx（$modelSize 字节），tokens.txt（$tokenSize 字节）"
    }
}

Write-Host ""
Write-Host "完成。配置文件：$ConfigFile" -ForegroundColor Green
Write-Host "安装模式：$InstallMode（启动检查会据此跳过未安装的能力）"
Write-Host ""
Write-Host "启动服务（后台管理，推荐）："
Write-Host "  scripts\voice.cmd start"
Write-Host "  scripts\voice.cmd status"
Write-Host "  scripts\voice.cmd log"
Write-Host "  scripts\voice.cmd stop"
Write-Host ""
Write-Host "前台运行：scripts\start-voice.cmd"
Write-Host "启动前会检查依赖；缺失时终端和日志会打印安装命令，不会自动安装。"
if ($ProxyOnly) {
    Write-Host ""
    Write-Host "仅基础依赖模式：STT / TTS 固定本地实现，仍需各自依赖与模型 / ffmpeg；"
    Write-Host "本模式适合只用 LLM 上游代理的场景，启动前无需填写任何语音上游地址。"
}
Write-Host ""
Write-Host "网关（xiaoxiong-app/gateway/.env）对应配置："
Write-Host "  ASR_PROVIDER=whisper"
Write-Host "  ASR_BASE_URL=http://127.0.0.1:9529"
Write-Host "  TTS_PROVIDER=edge"
Write-Host "  TTS_BASE_URL=http://127.0.0.1:9529"
Write-Host '  TTS_PARAMS={"voice":"zh-CN-XiaoxiaoNeural"}'
Write-Host "如果开启了 API Key，再补上 ASR_API_KEY / TTS_API_KEY（与配置文件一致）。"
