@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"
rem A maintainer-supplied PR number overrides the decision and reviews that PR directly.
if not "%~1"=="" (
  set "TASK=Run the whetstone reviewer role per your agent instructions. Review pull request #%~1 against GUIDELINES.md, then stop."
  goto review
)

echo === Selecting the next PR to review ^(oldest needs-review, non-draft^) ===
set "ACTION="
set "NUM="
for /f "usebackq tokens=1,2 delims= " %%a in (`node scripts\reviewer-next-action.mjs`) do (
  set "ACTION=%%a"
  set "NUM=%%b"
)

if "%ACTION%"=="review" (
  set "TASK=Run the whetstone reviewer role per your agent instructions. Review pull request #%NUM% against GUIDELINES.md, then stop."
  goto review
)

echo No pull request is waiting for review.
goto merge

:review
copilot --agent=whetstone-reviewer --model gpt-5.5 --allow-all -p "%TASK%"

:merge
echo.
echo === Deterministic merge step (merges review-approved PRs whose gates pass) ===
call "%~dp0run-merge.cmd"

echo.
echo === Deterministic unblock step (unblocks blocked issues whose dependencies are now resolved) ===
node scripts\unblock-ready-issues.mjs
