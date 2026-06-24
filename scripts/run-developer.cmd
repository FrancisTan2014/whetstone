@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"
rem Resolve the issue to implement. A maintainer-supplied number wins; otherwise pick deterministically
rem (lowest-numbered ready-for-dev issue whose dependencies are closed) so the agent never grabs the
rem newest issue just because `gh issue list` returns newest-first.
set "ISSUE=%~1"
if "%ISSUE%"=="" (
  echo === Selecting next dependency-ready issue ^(lowest number^) ===
  for /f "usebackq tokens=* delims=" %%i in (`node scripts\pick-next-issue.mjs`) do set "ISSUE=%%i"
)

if "%ISSUE%"=="" (
  echo No ready-for-dev issue is dependency-ready. Nothing to implement.
  exit /b 0
)

set "TASK=Run the whetstone developer role per your agent instructions. Implement issue #%ISSUE% end to end on a clean branch and open one scoped pull request, then stop."
copilot --agent=whetstone-developer --model claude-opus-4.8 --effort high --allow-all -p "%TASK%"
