@echo off
REM Boot a clean sandbox from the app default profile (correct bundle versions).
REM Usage: scripts\sandbox-default-boot.cmd <profile> <port> <logfile>
setlocal
set "DSH_EXE=D:\DSH\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
set "PROFILE=%~1"
set "PORT=%~2"
set "LOG=%~3"
if "%LOG%"=="" set "LOG=%TEMP%\dsh-sandbox-default.log"
echo --- boot start profile=%PROFILE% port=%PORT% --- > "%LOG%"
"%DSH_EXE%" --profile %PROFILE% --from-default-profile web --port %PORT% >> "%LOG%" 2>&1
exit /b %errorlevel%
