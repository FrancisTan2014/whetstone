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
set "ACTION_FILE=%TEMP%\whetstone-developer-action-%RANDOM%-%RANDOM%.txt"
if defined WHETSTONE_SELECTOR_COMMAND (
  call "%WHETSTONE_SELECTOR_COMMAND%" > "%ACTION_FILE%"
) else (
  node scripts\delivery\developerNextAction.mjs > "%ACTION_FILE%"
)
set "SELECTOR_STATUS=%ERRORLEVEL%"
if not "%SELECTOR_STATUS%"=="0" (
  del /q "%ACTION_FILE%" >nul 2>&1
  exit /b %SELECTOR_STATUS%
)
for /f "usebackq tokens=1,2 delims= " %%a in ("%ACTION_FILE%") do (
  set "ACTION=%%a"
  set "NUM=%%b"
)
del /q "%ACTION_FILE%" >nul 2>&1

if "%ACTION%"=="fix" (
  set "TASK=Run the whetstone developer role per your agent instructions. Pull request #%NUM% was sent back by the reviewer with changes requested: check out its existing branch, address the review feedback, push, set it back to needs-review, then stop."
  goto run
)
if "%ACTION%"=="fix-ci" (
  set "TASK=Run the whetstone developer role per your agent instructions. Pull request #%NUM% has a completed failing blocking CI check: check out its existing branch and triage the exact failure. Fix a reproducible regression; rerun a transient infrastructure failure once without changing product code. Push any required fix, remove stale review-approved, set needs-review, and stop."
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
