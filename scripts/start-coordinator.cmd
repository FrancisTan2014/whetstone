@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
if not exist ".agent-locks" mkdir ".agent-locks" >nul
call "%~dp0cleanup-agent-locks.cmd"
copilot --experimental --agent=whetstone-coordinator --allow-all -i "/every 5m Run one whetstone coordinator tick. Follow prompts/coordinator-schedule.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Sync remote status, choose developer or reviewer, and invoke at most one one-shot role per tick."
