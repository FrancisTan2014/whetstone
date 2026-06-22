@echo off
setlocal
set "EXIT_CODE=0"
set "LOCK=%TEMP%\whetstone-developer.lock"
mkdir "%LOCK%" 2>nul
if errorlevel 1 (
  echo whetstone developer run already active; skipping.
  exit /b 0
)
cd /d "%~dp0.."
if errorlevel 1 (
  set "EXIT_CODE=%ERRORLEVEL%"
  goto cleanup
)
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
git fetch origin --prune
if errorlevel 1 (
  set "EXIT_CODE=%ERRORLEVEL%"
  goto cleanup
)
copilot --agent=whetstone-developer -p "Run the developer coordinator workflow in docs/LOCAL_AGENT_WORKFLOW.md. Process at most one ready issue. Use a coding subagent for implementation when available. Then stop." --no-ask-user --allow-all
set "EXIT_CODE=%ERRORLEVEL%"
:cleanup
rmdir "%LOCK%" 2>nul
exit /b %EXIT_CODE%
