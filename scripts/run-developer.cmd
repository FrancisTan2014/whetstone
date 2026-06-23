@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"
set "TASK=Run the whetstone developer role per your agent instructions. Implement the next dependency-ready issue labeled ready-for-dev (lowest number) end to end on a clean branch and open one scoped pull request, then stop."
if not "%~1"=="" set "TASK=Run the whetstone developer role per your agent instructions. Implement issue #%~1 end to end on a clean branch and open one scoped pull request, then stop."
copilot --agent=whetstone-developer --model claude-opus-4.8 --effort high --allow-all -p "%TASK%"
