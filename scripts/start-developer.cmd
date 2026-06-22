@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
copilot --agent=whetstone-developer -p "Run the developer coordinator workflow in docs/LOCAL_AGENT_WORKFLOW.md. Process at most one ready issue. Use a coding subagent for implementation when available. Then stop." --no-ask-user --allow-all
