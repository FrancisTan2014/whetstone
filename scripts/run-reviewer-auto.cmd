@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "NO_COLOR=1"

rem Start the reviewer as an automatic FOREGROUND loop. Uses -i (interactive + initial prompt) so the
rem session stays alive across ticks: the agent schedules itself with Copilot's scheduled-task feature
rem and, each tick, reviews one PR, runs the deterministic merge step, and re-arms -- until you stop it
rem (Ctrl+C). The helper script decides which PR is next, so each tick spends its budget on the review.
set "PROMPT=Run automatically per your agent instructions (## Run automatically): schedule a self-paced foreground loop with Copilot's scheduled-task feature, and on each tick FIRST run `node scripts/reviewer-next-action.mjs` and act only on its single decision line -- load no other context (skill, GUIDELINES.md, the PR diff) until a PR is waiting -- then, if a PR is waiting, review exactly that one PR against GUIDELINES.md and record your verdict; afterwards run the deterministic merge step `node scripts/merge-approved-prs.mjs` and then the deterministic unblock step `node scripts/unblock-ready-issues.mjs` (which flips any `blocked` issue whose `Depends on:` dependencies are now closed to `ready-for-dev`); then re-arm the schedule to run the next tick in about 2 minutes (120s). Stay in the foreground; never detach. Do the first tick now."

copilot --agent=whetstone-reviewer --model gpt-5.5 --allow-all -i "%PROMPT%"
