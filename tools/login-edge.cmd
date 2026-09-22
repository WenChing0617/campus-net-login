@echo off
rem ============================================================
rem  Campus network auto login - Edge launcher
rem  Usage: login-edge.cmd [URL]
rem  If URL is omitted, a 204 test endpoint is opened; the campus
rem  gateway will redirect it to the login portal when not authed.
rem ============================================================
setlocal
set "URL=%~1"
if "%URL%"=="" set "URL=http://connectivitycheck.platform.hicloud.com/generate_204"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo [ERROR] msedge.exe not found.
  exit /b 1
)

start "" "%EDGE%" --no-first-run --no-default-browser-check "%URL%"
exit /b 0
