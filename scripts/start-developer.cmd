@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
git fetch origin --prune
powershell -NoProfile -Command "Get-Content -Raw 'prompts\developer-schedule.txt' | Set-Clipboard"
echo Developer schedule prompt copied to clipboard.
echo Paste it into Copilot and press Enter to start the recurring scheduled task.
copilot --experimental --agent=whetstone-developer --allow-all
