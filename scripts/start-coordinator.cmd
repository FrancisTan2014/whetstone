@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
if not exist ".agent-locks" mkdir ".agent-locks" >nul
powershell -NoProfile -Command "$lock = '.agent-locks\worker.lock'; if (Test-Path $lock) { $pidPath = Join-Path $lock 'pid.txt'; $startedPath = Join-Path $lock 'startedAt.txt'; $stale = $true; $started = $null; if (Test-Path $startedPath) { try { $started = [datetime](Get-Content -Raw $startedPath) } catch { $started = $null } }; if (Test-Path $pidPath) { try { $ownerPid = [int](Get-Content -Raw $pidPath); $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue; if ($proc -and $proc.ProcessName -eq 'cmd') { $stale = $false; if ($started -and $proc.StartTime -gt $started.AddMinutes(1)) { $stale = $true }; if ($started -and ((Get-Date) - $started).TotalHours -gt 12) { $stale = $true } } } catch { $stale = $true } }; if ($stale) { Remove-Item $lock -Recurse -Force; Write-Host 'Removed stale whetstone worker lock.' } }"
copilot --experimental --agent=whetstone-coordinator --allow-all -i "/every 1m Run one whetstone coordinator tick. Follow prompts/coordinator-schedule.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Sync remote status, choose developer or reviewer, and invoke at most one one-shot role per tick."
