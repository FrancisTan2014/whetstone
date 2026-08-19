@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"

rem The deterministic supervisor polls without a model and invokes the single delivery agent through
rem run-developer.cmd. It blocks during the unit, so no timer tick can enter the worker's context.
rem Ctrl+C stops the foreground supervisor.
node scripts\delivery\supervisor.mjs developer
