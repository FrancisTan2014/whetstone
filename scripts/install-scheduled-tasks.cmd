@echo off
setlocal

set "ROOT=%~dp0.."
set "DEV=%~dp0start-developer.cmd"
set "REV=%~dp0start-reviewer.cmd"

for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddMinutes(1).ToString('HH:mm')"') do set "DEV_START=%%i"
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddMinutes(6).ToString('HH:mm')"') do set "REV_START=%%i"

schtasks /Create /TN "whetstone-developer" /SC MINUTE /MO 10 /ST %DEV_START% /TR "\"%DEV%\"" /F
if errorlevel 1 exit /b %ERRORLEVEL%

schtasks /Create /TN "whetstone-reviewer" /SC MINUTE /MO 10 /ST %REV_START% /TR "\"%REV%\"" /F
if errorlevel 1 exit /b %ERRORLEVEL%

echo Installed scheduled tasks:
echo   whetstone-developer every 10 minutes, starting %DEV_START%
echo   whetstone-reviewer every 10 minutes, starting %REV_START%
echo.
echo The start scripts fetch origin before running and skip if a previous run is still active.
