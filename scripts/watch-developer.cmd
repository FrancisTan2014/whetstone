@echo off
setlocal
cd /d "%~dp0.."

:loop
call "%~dp0start-developer.cmd"
echo.
echo whetstone developer watcher sleeping for 10 minutes. Press Ctrl+C to stop.
timeout /t 600 /nobreak
goto loop
