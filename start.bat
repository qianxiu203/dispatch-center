@echo off
rem 调度中心启动脚本（Windows 双击运行，需求 3.1 / A1）
rem 1) 首次运行自动 npm install + 构建；2) 后台启动服务；3) 等待就绪后自动打开浏览器
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 调度中心

if not exist "node_modules" (
  echo 首次运行：正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 goto :fail
)
if not exist "dist\main.js" (
  echo 正在构建...
  call npm run build
  if errorlevel 1 goto :fail
)
if not exist "config.json" (
  echo 尚未创建 config.json，已为你生成模板。请先在设置中心填写大脑 API Key。
  copy config.example.json config.json >nul
)

set RECORD_START=%DATE% %TIME%
if not exist "logs" mkdir "logs"
echo 正在启动调度中心服务...
start "调度中心服务" /min cmd /c "node dist\main.js > logs\start.log 2>&1"

if defined DISPATCH_NO_BROWSER goto :wait
echo 等待服务就绪...
powershell -NoProfile -Command ^
  "$rt='%~dp0data\runtime.json'; $start=Get-Date; $deadline=(Get-Date).AddSeconds(90);" ^
  "while((Get-Date) -lt $deadline){" ^
  "  if(Test-Path $rt){ $j=Get-Content $rt -Raw | ConvertFrom-Json; if($j.startedAt){ Start-Process ('http://127.0.0.1:' + $j.port); exit } }" ^
  "  Start-Sleep -Milliseconds 800 }"
goto :wait

:wait
echo 调度中心已在后台运行（端口见 data\runtime.json，默认 3210）。
echo 本窗口可以关闭；要停止服务请用任务管理器结束 node 进程。
timeout /t 3 >nul
exit /b 0

:fail
echo.
echo 启动失败，请把上面的报错截图反馈给开发者。
pause
exit /b 1
