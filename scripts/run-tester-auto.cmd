@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"

rem Start the Tester (QA) as an automatic FOREGROUND loop. Uses -i (interactive + initial prompt) so
rem the session stays alive across ticks: the agent schedules itself with Copilot's scheduled-task
rem feature and, each tick, explores the booted app on main and files high-signal, de-duplicated
rem [Bug]s (or nothing), re-arming after each -- until you stop it (Ctrl+C). It runs independently of
rem the reviewer, on a different model than the developer (author/tester diversity). The deterministic
rem helper script decides the per-run filing budget, so each tick spends its budget on exploration.
set "PROMPT=Run automatically per your agent instructions (## Run automatically): schedule a self-paced foreground loop with Copilot's scheduled-task feature, and on each tick decide with `node scripts/tester-next-action.mjs` then, if it says `test <budget>`, boot the real stack on origin/main and explore the app beyond the E2E smoke, filing at most <budget> new, reproduced, de-duplicated [Bug] issues (file nothing if you find nothing); for `idle` do nothing; then re-arm the schedule to run the next tick in about 10 minutes (600s). Stay in the foreground; never detach. Do the first tick now."

copilot --agent=whetstone-tester --model gpt-5.5 --allow-all -i "%PROMPT%"
