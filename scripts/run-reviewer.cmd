@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"
set "TASK=Run the whetstone reviewer role per your agent instructions. Review the oldest open non-draft pull request labeled needs-review against GUIDELINES.md, then stop."
if not "%~1"=="" set "TASK=Run the whetstone reviewer role per your agent instructions. Review pull request #%~1 against GUIDELINES.md, then stop."
copilot --agent=whetstone-reviewer --model gpt-5.5 --allow-all -p "%TASK%"
