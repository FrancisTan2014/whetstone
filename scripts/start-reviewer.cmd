@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
if not exist ".agent-locks" mkdir ".agent-locks" >nul
copilot --experimental --agent=whetstone-reviewer --allow-all -i "/every 1m Run the whetstone reviewer scheduled tick. Follow prompts/reviewer-schedule.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Sync remote status when stale and process at most one reviewer work unit per tick."
