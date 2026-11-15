@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem
rem Windows 版离线包构建（仅 Android；iOS 需 macOS + Xcode，请用 build.sh ios）。
rem 逻辑与 build.sh 对齐：前端构建 -> 网关 bundle -> 接入离线资源 -> gradle 编译 -> APK 重命名为 环境+时间戳。
rem
rem 用法：
rem   build.bat <env> <platform>
rem     env      = dev | test | pro   （读取 scripts\.build_env.<env> 配置）
rem     platform = android            （Windows 仅支持 android）
rem
rem 说明：
rem   - 构建配置按环境拆分：scripts\.build_env.dev / .test / .pro（不入库，从 .build_env.example 复制填值）。
rem   - 本脚本直接解析这些 bash 风格（KEY=value，# 注释）的配置，不再另建 .bat 配置，保持单一真相源。
rem   - ANDROID_SDK_DIR 指向 DCloud 离线 SDK 壳（HBuilder-Integrate-AS）；NODE_LIB 留空则用 app 模块已内置的 libnode.so。

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT=%%~fI"

rem —— 参数：环境 + 平台 ——
set "ENV=%~1"
set "PLATFORM=%~2"
if "%ENV%"=="" goto :usage
if "%PLATFORM%"=="" goto :usage
if /i not "%ENV%"=="dev" if /i not "%ENV%"=="test" if /i not "%ENV%"=="pro" goto :usage
if /i not "%PLATFORM%"=="android" (
  echo 当前为 Windows：仅支持 android 构建；iOS 需 macOS + Xcode，请在 macOS 运行 build.sh ios。 >&2
  exit /b 1
)

rem —— 读取本机构建环境（scripts\.build_env.<env>，bash 风格 KEY=value）——
set "ENV_FILE=%SCRIPT_DIR%.build_env.%ENV%"
if not exist "%ENV_FILE%" (
  echo 找不到构建环境配置: %ENV_FILE% >&2
  exit /b 1
)
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  set "KEY=%%A"
  if not "!KEY:~0,1!"=="#" (
    if not "%%A"=="" set "%%A=%%B"
  )
)

rem —— 默认参数（与 build.sh 对齐）——
if not defined APP_DISPLAY_NAME set "APP_DISPLAY_NAME=小熊助手"
if "%APP_ICON_DIR%"=="" (
  if exist "%ROOT%\native\branding\%ENV%" set "APP_ICON_DIR=%ROOT%\native\branding\%ENV%"
)

rem APPID / APPKEY：环境变量 > .build_env.<env> 的 ANDROID_* > 内置默认
if defined APPID (set "THE_APPID=%APPID%") else (if defined ANDROID_APPID (set "THE_APPID=%ANDROID_APPID%") else (set "THE_APPID=__UNI__145C29C"))
if defined APPKEY (set "THE_APPKEY=%APPKEY%") else (set "THE_APPKEY=%ANDROID_APPKEY%")

rem —— 前置检查 ——
if "%ANDROID_SDK_DIR%"=="" (
  echo 请在 .build_env.%ENV% 设置 ANDROID_SDK_DIR（指向 DCloud 离线 SDK 壳 HBuilder-Integrate-AS 目录） >&2
  exit /b 1
)
if not exist "%ANDROID_SDK_DIR%" (
  echo 找不到 DCloud 离线 SDK 壳: %ANDROID_SDK_DIR% >&2
  exit /b 1
)

rem —— 可选参数（仅非空时追加）——
set "EXTRA="
if not "%THE_APPKEY%"=="" set EXTRA=%EXTRA% --appkey "%THE_APPKEY%"
if not "%NODE_LIB%"=="" set EXTRA=%EXTRA% --node-lib "%NODE_LIB%"
if not "%APP_ICON_DIR%"=="" set EXTRA=%EXTRA% --icon-dir "%APP_ICON_DIR%"

rem —— 1. 构建 uni-app 前端资源 ——
echo ==^> [1/3] 前端资源 (npm run build:app)  [env=%ENV% platform=%PLATFORM%]
cd /d "%ROOT%\uni_app"
call npm run build:app
if errorlevel 1 exit /b 1

rem —— 2. 构建内嵌网关 bundle（与前端、原生一起出包）——
echo ==^> [2/3] 网关 bundle (npm run build:bundle)
cd /d "%ROOT%\gateway"
call npm run build:bundle
if errorlevel 1 exit /b 1
set "GATEWAY_BUNDLE=%ROOT%\gateway\dist\gateway.bundle.mjs"
if not exist "%GATEWAY_BUNDLE%" (
  echo 网关 bundle 未生成: %GATEWAY_BUNDLE% >&2
  exit /b 1
)

rem —— 3. 接入离线资源 + 原生编译 ——
echo ==^> [3/3] 接入 Android 离线资源 + 原生编译 (gradlew :app:assembleDebug)
cd /d "%ROOT%"
node "%SCRIPT_DIR%package-android-offline.mjs" --sdk "%ANDROID_SDK_DIR%" --appid "%THE_APPID%" --gateway-bundle "%GATEWAY_BUNDLE%" --app-name "%APP_DISPLAY_NAME%"%EXTRA%
if errorlevel 1 exit /b 1

cd /d "%ANDROID_SDK_DIR%"
call gradlew.bat :app:clean :app:assembleDebug
if errorlevel 1 exit /b 1

rem —— 4. 重命名 APK：环境 + 时间戳 ——
set "APK_DIR=%ROOT%\native\android\app\build\outputs\apk\debug"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
set "SRC_APK=%APK_DIR%\app-debug.apk"
if exist "%SRC_APK%" (
  set "DST_APK=%APK_DIR%\app-debug-%ENV%-%TS%.apk"
  move /Y "%SRC_APK%" "%DST_APK%" >nul
  echo ==^> 完成：APK 位于 %DST_APK%
) else (
  echo ==^> 完成：APK 目录 %APK_DIR% 下未找到 app-debug.apk（请检查 gradle 产物名）
)

goto :eof

:usage
echo 用法: build.bat ^<env^> ^<platform^>
echo   env      = dev ^| test ^| pro
echo   platform = android   （Windows 仅支持 android；iOS 请使用 build.sh）
exit /b 1
