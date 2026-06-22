@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
if not exist ".agent-locks" mkdir ".agent-locks" >nul
mkdir ".agent-locks\worker.lock" 2>nul
if errorlevel 1 (
  echo A whetstone worker is already running; reviewer one-shot skipped.
  exit /b 0
)
copilot --agent=whetstone-reviewer --allow-all --no-ask-user -p "Run one whetstone reviewer tick. Follow prompts/reviewer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one reviewer work unit, then exit."
set "EXIT_CODE=%ERRORLEVEL%"
rmdir ".agent-locks\worker.lock" 2>nul
exit /b %EXIT_CODE%
