@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"

rem Start the developer as an automatic FOREGROUND loop. Uses -i (interactive + initial prompt) so the
rem session stays alive across ticks: the agent schedules itself with Copilot's scheduled-task feature
rem and does exactly one unit of work per tick, re-arming after each, until you stop it (Ctrl+C). The
rem deterministic helper scripts decide the next action, so each tick spends its budget on the work.
set "PROMPT=Run automatically per your agent instructions (## Run automatically): schedule a self-paced foreground loop with Copilot's scheduled-task feature, and on each tick FIRST run `node scripts/developer-next-action.mjs` and act only on its single decision line -- load no other context (skill, PRODUCT.md, the issue, worktrees) until it returns fix/implement -- then complete exactly one unit of work (fix the changes-requested PR and push, or implement the next ready issue and open a PR; for wait/idle do nothing and load nothing), then re-arm the schedule to run the next tick in about 2 minutes (120s). Stay in the foreground; never detach. Do the first tick now."

copilot --agent=whetstone-developer --model claude-opus-4.8 --effort high --allow-all -i "%PROMPT%"
