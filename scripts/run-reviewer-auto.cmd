@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"

rem The deterministic supervisor polls without a model and invokes run-reviewer.cmd as a fresh
rem one-shot process only when review work exists. The one-shot launcher still runs merge/unblock
rem deterministically after each cycle. Ctrl+C stops the foreground supervisor.
node scripts\delivery-supervisor.mjs reviewer
