@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem
rem Windows 版 USB 真机安装脚本（仅 Android；iOS 需 macOS + Xcode + ios-deploy，请用 install.sh ios）。
rem 分工与 install.sh 一致：build.bat 负责「前端构建 + 网关 bundle + 资源接入 + 编译产物」；
rem   本脚本在其产物上执行「USB 真机安装」这一层，不重复构建逻辑。
rem   - Android：build.bat 出 APK 后，用 adb -d 装到当前 USB 在线真机。
rem   - iOS：Windows 不支持，直接报错并提示去 macOS 跑 install.sh。
rem
rem 网关同包约定：build.bat 已含 npm run build:bundle，本脚本沿用，不再单独处理网关。
rem
rem 用法：
rem   install.bat <platform> [--env dev] [--no-build]
rem     platform   = android | ios | all
rem     --env      = dev | test | pro（默认 dev；与 build.bat 同套 .build_env.<env>）
rem     --no-build：跳过 build.bat 的构建/资源整合，直接安装已有产物
rem     -h|--help  显示本帮助
rem
rem 前置：
rem   - 设备用 USB 连接并授权 USB 调试。
rem   - adb 在 PATH（Android SDK platform-tools）。

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT=%%~fI"

rem —— 参数解析 ——
set "PLATFORM="
set "ENV=dev"
set "NO_BUILD=0"

:parse
if "%~1"=="" goto :afterparse
set "ARG=%~1"
if /i "%ARG%"=="android" (set "PLATFORM=android" & shift & goto :parse)
if /i "%ARG%"=="ios" (set "PLATFORM=ios" & shift & goto :parse)
if /i "%ARG%"=="all" (set "PLATFORM=all" & shift & goto :parse)
if /i "%ARG%"=="--no-build" (set "NO_BUILD=1" & shift & goto :parse)
if /i "%ARG%"=="--env" (set "ENV=%~2" & shift & shift & goto :parse)
if /i "%ARG:~0,6%"=="--env=" (set "ENV=%ARG:~6%" & shift & goto :parse)
if /i "%ARG%"=="-h" goto :usage
if /i "%ARG%"=="--help" goto :usage
echo 未知参数: %ARG% >&2
goto :usage
:afterparse

if "%PLATFORM%"=="" goto :usage
if /i not "%ENV%"=="dev" if /i not "%ENV%"=="test" if /i not "%ENV%"=="pro" (
  echo 未知环境: %ENV%（应为 dev^|test^|pro） >&2
  exit /b 1
)

rem —— 主流程 ——
set "RC=0"
if /i "%PLATFORM%"=="android" call :install_android || set "RC=1"
if /i "%PLATFORM%"=="ios" call :install_ios || set "RC=1"
if /i "%PLATFORM%"=="all" (
  call :install_android || set "RC=1"
  echo （iOS 安装需 macOS + Xcode，Windows 上跳过；请在 Mac 运行 install.sh ios）
)

if %RC%==0 (echo ==^> 安装完成) else (echo ==^> 安装存在失败（详见上方输出） >&2)
exit /b %RC%

rem —— Android：构建（可选）+ adb 装到 USB 单设备 ——
:install_android
if %NO_BUILD%==0 (
  echo ==^> [Android] 构建并接入资源 (build.bat %ENV% android)
  call "%SCRIPT_DIR%build.bat" %ENV% android
  if errorlevel 1 (
    echo Android 构建失败，中止安装 >&2
    exit /b 1
  )
)

set "APK_DIR=%ROOT%\native\android\app\build\outputs\apk\debug"
if not exist "%APK_DIR%" (
  echo 找不到 APK 目录: %APK_DIR%（先不带 --no-build 构建一次） >&2
  exit /b 1
)
set "APK="
for /f "delims=" %%f in ('dir "%APK_DIR%\*.apk" /b /o-d /a-d 2^>nul') do (
  set "APK=%APK_DIR%\%%f"
  goto :apk_found
)
:apk_found
if not defined APK (
  echo 该目录无 APK: %APK_DIR% >&2
  exit /b 1
)
echo ==^> [Android] APK: %APK%

where adb >nul 2>&1
if errorlevel 1 (
  echo 找不到 adb，请确认 Android SDK platform-tools 在 PATH >&2
  exit /b 1
)

rem 只认 USB 在线设备：adb -d 指向单台 USB 设备，规避模拟器与多设备误装
set "COUNT=0"
for /f "tokens=1,2" %%a in ('adb devices 2^>nul') do (
  if "%%b"=="device" set /a COUNT+=1
)
if %COUNT%==0 (
  echo 当前没有 USB 在线的 Android 设备（adb devices 为空）。请连接并授权 USB 调试。 >&2
  exit /b 1
)
if %COUNT% gtr 1 (
  echo 检测到多台设备，adb -d 只能指定单台。请保留一台，或手动: >&2
  echo   adb -s ^<serial^> install -r -t %APK% >&2
  adb devices 2>nul
  exit /b 1
)

echo ==^> [Android] 安装到 USB 设备
adb -d install -r -t "%APK%"
if errorlevel 1 (
  echo adb install 失败 >&2
  exit /b 1
)
exit /b 0

rem —— iOS：Windows 不支持 ——
:install_ios
echo 当前为 Windows：iOS 安装需 macOS + Xcode + ios-deploy，请在 macOS 运行 install.sh ios。 >&2
exit /b 1

:usage
echo 用法: install.bat ^<platform^> [--env dev] [--no-build]
echo   platform   android ^| ios ^| all
echo   --env      dev ^| test ^| pro  （默认 dev）
echo   --no-build 跳过 build.bat 的构建/资源整合，直接装已有产物
echo   -h^|--help  显示本帮助
exit /b 1
