@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"
copilot --agent=whetstone-design --allow-all
