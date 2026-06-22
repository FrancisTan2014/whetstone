@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
git fetch origin --prune
copilot --experimental --agent=whetstone-developer --allow-all -i "/every 10m Run the whetstone developer scheduled tick. Follow prompts/developer-schedule.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Process at most one unit of developer work per tick."
