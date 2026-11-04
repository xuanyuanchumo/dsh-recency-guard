@echo off
REM Sandbox runner: boots DSH with the given profile.
REM Usage: scripts\run-dsh.cmd <profile> [extra args...]
setlocal
set "DSH=D:\DSH\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
"%DSH%" --profile %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%
