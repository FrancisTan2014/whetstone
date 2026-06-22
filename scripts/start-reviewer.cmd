@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
if not exist ".agent-locks" mkdir ".agent-locks" >nul
mkdir ".agent-locks\worker.lock" 2>nul
if errorlevel 1 (
  echo A whetstone worker is already running; reviewer one-shot skipped.
  exit /b 0
)
for /f %%p in ('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId"') do set "WORKER_PID=%%p"
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format o"') do set "STARTED_AT=%%t"
> ".agent-locks\worker.lock\role.txt" echo reviewer
> ".agent-locks\worker.lock\pid.txt" echo %WORKER_PID%
> ".agent-locks\worker.lock\startedAt.txt" echo %STARTED_AT%
> ".agent-locks\worker.lock\command.txt" echo scripts\start-reviewer.cmd
copilot --agent=whetstone-reviewer --allow-all --no-ask-user -p "Run one whetstone reviewer tick. Follow prompts/reviewer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one reviewer work unit, then exit."
set "EXIT_CODE=%ERRORLEVEL%"
powershell -NoProfile -Command "$statusPath = '.agent-status.local.json'; $status = Get-Content -Raw $statusPath | ConvertFrom-Json; $now = Get-Date -Format o; $status.reviewer.lastRunCompletedAt = $now; if (%EXIT_CODE% -eq 0) { if (-not $status.reviewer.lastResult) { $status.reviewer.lastResult = 'completed' } } else { $status.reviewer.state = 'failed'; $status.reviewer.lastResult = 'process_failed_exit_%EXIT_CODE%'; $failure = [pscustomobject]@{ role = 'reviewer'; exitCode = %EXIT_CODE%; completedAt = $now; command = 'scripts\\start-reviewer.cmd' }; $failure | ConvertTo-Json -Depth 4 | Set-Content '.agent-locks\\worker-failed.json' }; $status.updatedAt = $now; $status | ConvertTo-Json -Depth 12 | Set-Content $statusPath"
rmdir /s /q ".agent-locks\worker.lock" 2>nul
exit /b %EXIT_CODE%
