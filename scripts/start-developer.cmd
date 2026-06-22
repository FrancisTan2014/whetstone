@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
if not exist ".agent-locks" mkdir ".agent-locks" >nul
copilot --agent=whetstone-developer --allow-all --no-ask-user -p "Run one whetstone developer tick. Follow prompts/developer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one developer work unit, then exit."
