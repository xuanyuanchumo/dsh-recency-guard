@echo off
REM 沙箱 DSH 启动器 —— 解决「路径含空格」在 bash 执行器里的引号地狱。
REM 用法: scripts\sandbox-dsh.cmd <profile> [args...]
REM 之所以需要它：DSH 装在 "D:\DSH\DeepSeek Harness\..."（含空格），
REM 直接从 bash 调 dsh.cmd 会被执行器拆成 'D:\DSH\DeepSeek'。
setlocal
set "DSH_EXE=D:\DSH\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
"%DSH_EXE%" --profile %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%
