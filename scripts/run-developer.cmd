@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"
rem One unit of work per run, decided deterministically (work in progress = 1). A maintainer-supplied
rem issue number overrides the decision and implements that issue directly.
if not "%~1"=="" (
  set "TASK=Run the whetstone developer role per your agent instructions. Implement issue #%~1 end to end on a clean branch and open one scoped pull request, then stop."
  goto run
)

echo === Deciding the next developer action ^(fix open PR ^| wait ^| implement next issue^) ===
set "ACTION="
set "NUM="
for /f "usebackq tokens=1,2 delims= " %%a in (`node scripts\developer-next-action.mjs`) do (
  set "ACTION=%%a"
  set "NUM=%%b"
)

if "%ACTION%"=="fix" (
  set "TASK=Run the whetstone developer role per your agent instructions. Pull request #%NUM% was sent back by the reviewer with changes requested: check out its existing branch, address the review feedback, push, set it back to needs-review, then stop."
  goto run
)
if "%ACTION%"=="implement" (
  set "TASK=Run the whetstone developer role per your agent instructions. Implement issue #%NUM% end to end on a clean branch and open one scoped pull request, then stop."
  goto run
)
if "%ACTION%"=="wait" (
  echo Pull request #%NUM% is open and awaiting review/merge. Not starting a new issue.
  exit /b 0
)
echo Nothing to do: no workflow PR needs fixing and no dependency-ready issue is queued.
exit /b 0

:run
copilot --agent=whetstone-developer --model claude-opus-4.8 --effort high --allow-all -p "%TASK%"
