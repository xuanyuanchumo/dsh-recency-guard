@echo off
REM Sandbox pnpm runner (ASCII-only; the DSH runtime path contains spaces).
REM Usage: scripts\sandbox-pnpm.cmd <profile-dir> <args...>
setlocal
set "NODE=D:\DSH\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
set "PNPM=D:\DSH\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
set "DIR=%1"
shift
cd /d "%DIR%"
"%NODE%" "%PNPM%" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%
