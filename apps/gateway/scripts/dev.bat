@echo off
rem 跨平台开发服务器管理（Windows 批处理包装）。
rem 真实逻辑在 dev-server.mjs（Node 实现，三平台通用）；本脚本只负责切到脚本目录并转发参数。
rem
rem 用法：
rem   dev.bat                启动全部（热重载）
rem   dev.bat start          启动全部
rem   dev.bat stop           停止全部
rem   dev.bat restart        重启全部
rem   dev.bat status         查看状态
rem   dev.bat log            看日志尾部
rem   dev.bat start uniapp   只启动某个服务（gateway / uniapp）
setlocal
set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%"
node dev-server.mjs %*
popd
endlocal
