@echo off
setlocal
cd /d "%~dp0.."

echo whetstone reviewer watcher starts after 5 minutes so developer gets the first slot. Press Ctrl+C to stop.
timeout /t 300 /nobreak

:loop
call "%~dp0start-reviewer.cmd"
echo.
echo whetstone reviewer watcher sleeping for 10 minutes. Press Ctrl+C to stop.
timeout /t 600 /nobreak
goto loop
