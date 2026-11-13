@echo off
REM Sandbox boot + log capture. ASCII-only comments (cmd.exe mangles non-ASCII in REM).
REM Usage: scripts\sandbox-boot-check.cmd <profile> <port> <logfile>
REM
REM CLI shape (verified via `dsh --help` and by probing):
REM   dsh --profile <name> --port <port>
REM The profile's own app is booted (dsh-base + dsh-web-app => the web runtime).
REM Passing `web` as an app-arg makes the launcher reject it ("too many arguments").
setlocal
set "DSH_EXE=D:\DSH\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
set "PROFILE=%~1"
set "PORT=%~2"
set "LOG=%~3"
if "%LOG%"=="" set "LOG=%TEMP%\dsh-sandbox-boot.log"
echo --- boot start profile=%PROFILE% port=%PORT% --- > "%LOG%"
"%DSH_EXE%" --profile %PROFILE% --port %PORT% >> "%LOG%" 2>&1
exit /b %errorlevel%
