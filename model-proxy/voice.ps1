<#
.SYNOPSIS
  本地语音服务管理：后台启动、停止、重启、查看状态和日志。

.DESCRIPTION
  真正的启动参数解析在 start-voice.ps1；本脚本负责后台常驻和进程管理。
  服务配置仍来自 VoiceHome\voice.conf（可用 VOICE_CONFIG 或 start 的参数覆盖）。
  启动前会做依赖检查；缺失时只把安装方法写进日志，不会自动安装。

  用法:
    scripts\voice.cmd start                 # 后台启动（默认命令）
    scripts\voice.cmd start -Port 9531      # 附加参数会传给 start-voice.ps1
    scripts\voice.cmd stop                  # 停止
    scripts\voice.cmd restart               # 重启（重新读取配置文件）
    scripts\voice.cmd status                # 查看是否在运行
    scripts\voice.cmd check                 # 只做启动前依赖检查
    scripts\voice.cmd log                   # 查看日志尾部（默认 80 行）
    scripts\voice.cmd log -f                # 持续跟踪日志
    scripts\voice.cmd log -n 200            # 查看最近 200 行
    scripts\voice.cmd run                   # 前台运行，Ctrl+C 停止

  运行目录:
    VoiceHome\voice.pid  进程号和启动时间
    VoiceHome\voice.log  服务日志

  环境变量:
    VOICE_HOME    运行目录，默认 %LOCALAPPDATA%\app-product\voice
    VOICE_CONFIG  配置文件，默认 %VOICE_HOME%\voice.conf
#>

$ErrorActionPreference = "Stop"

# Python 和子脚本都输出中文；统一 UTF-8，否则 Windows PowerShell 5.1
# 会用 ANSI 解码，日志里只剩乱码。
$env:PYTHONIOENCODING = "utf-8"
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
}
catch {
    # 极旧的宿主可能不支持修改，忽略即可，不影响服务启动。
}

$ScriptDir = $PSScriptRoot
$StartScript = Join-Path $ScriptDir "start-voice.ps1"
$Checker = Join-Path $ScriptDir "voice\preflight.py"

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

$VenvPython = Join-Path $VoiceHome "venv\Scripts\python.exe"
$PidFile = Join-Path $VoiceHome "voice.pid"
$LogFile = Join-Path $VoiceHome "voice.log"
$DefaultTail = 80

function Get-VoiceConfigPath {
    if ($env:VOICE_CONFIG) {
        return $env:VOICE_CONFIG
    }
    return (Join-Path $VoiceHome "voice.conf")
}

function Get-LiveProcessId {
    if (-not (Test-Path $PidFile)) {
        return $null
    }
    $lines = @(Get-Content -Path $PidFile -ErrorAction SilentlyContinue)
    if ($lines.Count -lt 1) {
        return $null
    }

    $processId = 0
    if (-not [int]::TryParse(([string]$lines[0]).Trim(), [ref]$processId)) {
        return $null
    }
    if ($processId -le 0) {
        return $null
    }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $process) {
        return $null
    }

    # PID 可能被系统回收；第二行记录了启动时间，用来确认还是同一个进程。
    if ($lines.Count -ge 2) {
        [long]$expectedTicks = 0
        if ([long]::TryParse(([string]$lines[1]).Trim(), [ref]$expectedTicks)) {
            try {
                $actualTicks = $process.StartTime.ToUniversalTime().Ticks
            }
            catch {
                return $null
            }
            if ($actualTicks -ne $expectedTicks) {
                return $null
            }
        }
    }
    return $processId
}

function Write-VoiceLogTail {
    if (Test-Path $LogFile) {
        Write-Host ""
        Write-Host "最近日志（$LogFile）："
        Get-Content -Path $LogFile -Tail 40 -Encoding UTF8
    }
}

function ConvertTo-CommandArgument([string]$Value) {
    if ($null -eq $Value -or $Value -eq "") {
        return "''"
    }
    # 只放行最安全的字符；其余一律用单引号包住（单引号本身写成两个）。
    if ($Value -match '^[A-Za-z0-9_./:\\=-]+$') {
        return $Value
    }
    return "'" + $Value.Replace("'", "''") + "'"
}

function Start-VoiceBackground {
    param([string[]]$StartArgs)

    $processId = Get-LiveProcessId
    if ($processId) {
        Write-Host "语音服务已在运行（pid=$processId），无需重复启动。"
        Write-Host "  日志：$LogFile"
        return 0
    }
    Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $StartScript)) {
        throw "未找到启动脚本：$StartScript"
    }
    if (-not (Test-Path $VenvPython)) {
        throw "未找到虚拟环境：$VenvPython`n手动安装（启动脚本不会自动安装）：scripts\install-voice.cmd`n如果依赖装在别处，请设置 VOICE_HOME 指向包含 venv 的目录。"
    }
    New-Item -ItemType Directory -Force -Path $VoiceHome | Out-Null
    Add-Content -Path $LogFile -Encoding UTF8 -Value "`n=== start @ $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

    # 先同步预检，失败时直接返回非零并展示原因；不要先报“已启动”再让服务悄悄退出。
    # start-voice.ps1 启动时还会再检查一次，这里是为了让后台管理命令本身给出确定的失败结果。
    [string]$checkOutput = & $StartScript -CheckOnly @StartArgs *>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        if ($checkOutput.Trim()) {
            Add-Content -Path $LogFile -Encoding UTF8 -Value $checkOutput.TrimEnd()
        }
        Add-Content -Path $LogFile -Encoding UTF8 -Value @(
            "启动失败：依赖检查未通过时，请按上方 [check] 提示手动安装。",
            "启动脚本不会自动安装依赖；完整日志用 scripts\voice.cmd log 查看。"
        )
        Write-Host "语音服务启动失败：依赖检查未通过。"
        Write-VoiceLogTail
        Write-Host ""
        Write-Host "完整日志：scripts\voice.cmd log"
        Write-Host "安装依赖后重试；启动脚本不会自动安装。"
        return 1
    }

    $quotedStart = $StartScript.Replace("'", "''")
    $quotedLog = $LogFile.Replace("'", "''")
    $argumentText = ""
    if ($StartArgs -and $StartArgs.Count -gt 0) {
        $argumentText = ($StartArgs | ForEach-Object { ConvertTo-CommandArgument ([string]$_) }) -join " "
    }

    # 用 -EncodedCommand 避免路径 / 参数里的空格和引号被二次解析。
    # 子 PowerShell 与 Python 是父子进程，停止时用 taskkill /T 一起结束。
    # 显式用 UTF-8 追加日志：Windows PowerShell 5.1 的 *>> 默认写 UTF-16，
    # 会和管理脚本自己追加的 UTF-8 行混在一个文件里。
    $inner = "& '$quotedStart' $argumentText *>&1 | Out-File -FilePath '$quotedLog' -Append -Encoding utf8"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $shell = (Get-Process -Id $PID).Path

    $child = Start-Process -FilePath $shell `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) `
        -WindowStyle Hidden -PassThru

    $startTicks = 0
    try {
        $startTicks = $child.StartTime.ToUniversalTime().Ticks
    }
    catch {
        # 进程可能瞬间退出；写入 0，后续按“进程不存在”处理。
    }
    Set-Content -Path $PidFile -Value @($child.Id, $startTicks)

    # 给依赖检查留出时间（要导入 fastapi / uvicorn）；入口脚本失败时能及时发现。
    Start-Sleep -Seconds 3
    if (-not (Get-Process -Id $child.Id -ErrorAction SilentlyContinue)) {
        Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
        Add-Content -Path $LogFile -Encoding UTF8 -Value @(
            "启动失败：请查看上方日志里的错误信息。",
            "若是依赖问题，按 [check] 提示手动安装；启动脚本不会自动安装。"
        )
        Write-Host "语音服务启动失败。"
        Write-VoiceLogTail
        Write-Host ""
        Write-Host "完整日志：scripts\voice.cmd log"
        Write-Host "安装依赖后重试；启动脚本不会自动安装。"
        return 1
    }

    Write-Host "语音服务已后台启动（pid=$($child.Id)）。"
    Write-Host "  配置文件：$(Get-VoiceConfigPath)"
    if ($StartArgs -and $StartArgs.Count -gt 0) {
        Write-Host "  附加参数：$($StartArgs -join ' ')"
    }
    Write-Host "  日志：$LogFile"
    Write-Host "  状态：scripts\voice.cmd status"
    Write-Host "  停止：scripts\voice.cmd stop"
    return 0
}

function Stop-Voice {
    $processId = Get-LiveProcessId
    if (-not $processId) {
        Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
        Write-Host "语音服务未在运行。"
        return 0
    }

    Write-Host "正在停止语音服务（pid=$processId）..."
    # /T 一并结束 start-voice.ps1 起的 python 子进程；先尝试正常结束，再强制。
    & taskkill.exe /PID $processId /T 2>$null | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
        Write-Host "进程未在 3 秒内退出，强制结束。"
        & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
        Start-Sleep -Milliseconds 200
    }

    Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "语音服务已停止。"
    return 0
}

function Restart-Voice {
    param([string[]]$StartArgs)

    $code = Stop-Voice
    if ($code -ne 0) {
        return $code
    }
    Start-Sleep -Milliseconds 500
    # 临时命令行参数不落盘；重启以配置文件为准。需要临时覆盖时用 start 的参数。
    return (Start-VoiceBackground -StartArgs $StartArgs)
}

function Show-VoiceStatus {
    $processId = Get-LiveProcessId
    $config = Get-VoiceConfigPath

    if (-not $processId) {
        Write-Host "语音服务：未运行"
        Write-Host "  配置文件：$config"
        Write-Host "  日志：$LogFile"
        return 3
    }

    Write-Host "语音服务：运行中（pid=$processId）"
    Write-Host "  配置文件：$config"
    Write-Host "  日志：$LogFile"

    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $childIds = @(
            Get-CimInstance Win32_Process -Filter "ParentProcessId = $processId" `
                -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty ProcessId
        )
        $allIds = @($processId) + $childIds
        $listeners = @(
            Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $allIds -contains $_.OwningProcess } |
                ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" } |
                Sort-Object -Unique
        )
        if ($listeners.Count -gt 0) {
            Write-Host "  监听：$($listeners -join ' ')"
        }
    }

    if (Test-Path $LogFile) {
        $last = Get-Content -Path $LogFile -Tail 20 -Encoding UTF8 `
            -ErrorAction SilentlyContinue |
            Where-Object { $_.Trim() } |
            Select-Object -Last 1
        if ($last) {
            Write-Host "  最近一行：$last"
        }
    }
    return 0
}

function Show-VoiceLog {
    param([string[]]$LogArgs)

    $lines = $DefaultTail
    $follow = $false
    $i = 0
    while ($i -lt $LogArgs.Count) {
        $arg = ([string]$LogArgs[$i])
        switch ($arg) {
            "-f" { $follow = $true }
            "--follow" { $follow = $true }
            "-n" {
                $i++
                if ($i -ge $LogArgs.Count) {
                    throw "-n / --lines 需要一个数字"
                }
                $parsed = 0
                if (-not [int]::TryParse(([string]$LogArgs[$i]), [ref]$parsed) -or $parsed -le 0) {
                    throw "行数必须是正整数：$($LogArgs[$i])"
                }
                $lines = $parsed
            }
            "--lines" {
                $i++
                if ($i -ge $LogArgs.Count) {
                    throw "-n / --lines 需要一个数字"
                }
                $parsed = 0
                if (-not [int]::TryParse(([string]$LogArgs[$i]), [ref]$parsed) -or $parsed -le 0) {
                    throw "行数必须是正整数：$($LogArgs[$i])"
                }
                $lines = $parsed
            }
            "-h" {
                Show-VoiceUsage
                return 0
            }
            "--help" {
                Show-VoiceUsage
                return 0
            }
            default {
                throw "未知参数：$arg（用法：log [-f] [-n 行数]）"
            }
        }
        $i++
    }

    if (-not (Test-Path $LogFile)) {
        Write-Host "暂无日志：$LogFile"
        return 0
    }
    Write-Host "日志：$LogFile"
    if ($follow) {
        Get-Content -Path $LogFile -Tail $lines -Wait -Encoding UTF8
    }
    else {
        Get-Content -Path $LogFile -Tail $lines -Encoding UTF8
    }
    return 0
}

function Show-VoiceUsage {
    Get-Help $PSCommandPath -Detailed | Out-String | Write-Host
}

function Invoke-VoiceCheck {
    if (-not (Test-Path $VenvPython)) {
        throw "未找到虚拟环境：$VenvPython`n手动安装（启动脚本不会自动安装）：scripts\install-voice.cmd"
    }
    if (-not (Test-Path $Checker)) {
        throw "未找到依赖检查脚本：$Checker"
    }
    & $VenvPython $Checker
    return $LASTEXITCODE
}

function Invoke-VoiceForeground {
    param([string[]]$StartArgs)

    if (-not (Test-Path $StartScript)) {
        throw "未找到启动脚本：$StartScript"
    }
    & $StartScript @StartArgs
    return $LASTEXITCODE
}

$command = "start"
$rest = @()
if ($args.Count -gt 0) {
    $command = [string]$args[0]
    if ($args.Count -gt 1) {
        $rest = @($args[1..($args.Count - 1)])
    }
}

try {
    $exitCode = 0
    switch ($command.ToLowerInvariant()) {
        "start" { $exitCode = Start-VoiceBackground -StartArgs $rest }
        "stop" { $exitCode = Stop-Voice }
        "restart" { $exitCode = Restart-Voice -StartArgs $rest }
        "status" { $exitCode = Show-VoiceStatus }
        "check" { $exitCode = Invoke-VoiceCheck }
        "doctor" { $exitCode = Invoke-VoiceCheck }
        "log" { $exitCode = Show-VoiceLog -LogArgs $rest }
        "logs" { $exitCode = Show-VoiceLog -LogArgs $rest }
        "run" { $exitCode = Invoke-VoiceForeground -StartArgs $rest }
        "foreground" { $exitCode = Invoke-VoiceForeground -StartArgs $rest }
        "-h" { Show-VoiceUsage; $exitCode = 0 }
        "--help" { Show-VoiceUsage; $exitCode = 0 }
        "help" { Show-VoiceUsage; $exitCode = 0 }
        default {
            throw "未知命令：$command（支持 start / stop / restart / status / check / log / run）"
        }
    }
    exit $exitCode
}
catch {
    Write-Host "错误: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
