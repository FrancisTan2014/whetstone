@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"

echo === Deciding whether the Tester should run (open-bug backlog headroom) ===
set "ACTION="
set "BUDGET="
for /f "usebackq tokens=1,2 delims= " %%a in (`node scripts\tester-next-action.mjs`) do (
  set "ACTION=%%a"
  set "BUDGET=%%b"
)

if "%ACTION%"=="test" (
  set "TASK=Run the whetstone tester (QA) role per your agent instructions. Boot the real stack on origin/main and explore the app beyond the E2E smoke; file at most %BUDGET% new, reproduced, de-duplicated [Bug] issue(s), and file nothing if you find nothing. Leave the mandatory exploration report every run even when you file nothing: save artifacts under a UTC-timestamped folder in artifacts/tester/ (SHA, report.md, screenshots) and append a concise summary comment to the persistent [Tester] Exploration run log issue. Then stop."
  copilot --agent=whetstone-tester --model gpt-5.5 --allow-all -p "%TASK%"
  goto end
)

echo The open-bug backlog is at the cap; the Tester is idle this run.

:end
