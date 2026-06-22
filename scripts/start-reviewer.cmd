@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
copilot --agent=whetstone-reviewer -p "Run the reviewer coordinator workflow in docs/LOCAL_AGENT_WORKFLOW.md. Review at most one PR. Use a review subagent for detailed analysis when available. Then stop." --no-ask-user --allow-all
