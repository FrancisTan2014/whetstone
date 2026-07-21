@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"

rem The deterministic supervisor polls without a model and invokes run-developer.cmd as a fresh
rem one-shot process only when work exists. It blocks during the unit, so no timer tick can enter the
rem worker's context. Ctrl+C stops the foreground supervisor.
node scripts\delivery-supervisor.mjs developer
