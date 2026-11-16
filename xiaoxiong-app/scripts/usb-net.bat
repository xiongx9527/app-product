@echo off
chcp 65001 >nul
rem USB 联网（Android 真机借用电脑网络）的 Windows 包装。
rem 真实逻辑在 usb-net.mjs（Node 实现，三平台通用）；本脚本只切到脚本目录并转发参数。
rem
rem 用法：
rem   usb-net.bat                等同 up（默认对所有 USB 在线的 Android 设备生效）
rem   usb-net.bat up             起代理 + 逐台 adb reverse + 写设备全局代理（幂等）
rem   usb-net.bat down           逐台清设备代理 + 删 adb reverse + 停本机代理
rem   usb-net.bat status         查看每台 USB 设备的代理 / 反代 / 本机代理状态
rem   usb-net.bat up --port 8901 换代理端口（默认 8899）
rem   usb-net.bat up --serial A,B 只处理指定设备（逗号分隔多台）
rem
rem 前置：adb 在 PATH；设备用 USB 连接并授权 USB 调试；Node 已在 PATH。
setlocal
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%"
node usb-net.mjs %*
set "RC=%ERRORLEVEL%"
popd
endlocal & exit /b %RC%
