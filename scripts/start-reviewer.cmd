@echo off
setlocal
cd /d "%~dp0.."
set "GH_CONFIG_DIR=%USERPROFILE%\.config\gh-personal"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "NO_COLOR=1"
if not exist ".agent-status.local.json" copy "docs\agent-status.example.json" ".agent-status.local.json" >nul
if not exist ".agent-locks" mkdir ".agent-locks" >nul
if not exist ".agent-logs" mkdir ".agent-logs" >nul
call "%~dp0cleanup-agent-locks.cmd"
mkdir ".agent-locks\worker.lock" 2>nul
if errorlevel 1 (
  echo A whetstone worker is already running; reviewer one-shot skipped.
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-worker.ps1" -Role reviewer
set "EXIT_CODE=%ERRORLEVEL%"
powershell -NoProfile -Command "$statusPath = '.agent-status.local.json'; $status = Get-Content -Raw $statusPath | ConvertFrom-Json; foreach ($p in @('failureCount','lastFailureAt','nextRetryAfter')) { if ($status.reviewer.PSObject.Properties.Name -notcontains $p) { $status.reviewer | Add-Member -NotePropertyName $p -NotePropertyValue $null } }; foreach ($p in @('paused','pauseReason')) { if ($status.coordinator.PSObject.Properties.Name -notcontains $p) { $status.coordinator | Add-Member -NotePropertyName $p -NotePropertyValue $null } }; $nowDate = Get-Date; $now = $nowDate.ToString('o'); $status.reviewer.lastRunCompletedAt = $now; if (%EXIT_CODE% -eq 0) { $status.reviewer.failureCount = 0; $status.reviewer.lastFailureAt = $null; $status.reviewer.nextRetryAfter = $null; if (-not $status.reviewer.lastResult -or ($status.reviewer.lastResult -like 'process_failed*')) { $status.reviewer.lastResult = 'completed' }; if ($status.reviewer.state -eq 'failed') { $status.reviewer.state = 'idle' } } else { $previous = 0; if ($null -ne $status.reviewer.failureCount) { $previous = [int]$status.reviewer.failureCount }; $count = $previous + 1; $status.reviewer.failureCount = $count; $status.reviewer.lastFailureAt = $now; $status.reviewer.state = 'failed'; $status.reviewer.lastResult = 'process_failed_exit_%EXIT_CODE%'; $delay = [Math]::Min(60, [Math]::Pow(2, [Math]::Min($count, 5))); $status.reviewer.nextRetryAfter = $nowDate.AddMinutes($delay).ToString('o'); $failure = [pscustomobject]@{ role = 'reviewer'; exitCode = %EXIT_CODE%; failureCount = $count; completedAt = $now; nextRetryAfter = $status.reviewer.nextRetryAfter; command = 'scripts\\start-reviewer.cmd' }; $failure | ConvertTo-Json -Depth 4 | Set-Content '.agent-locks\\worker-last-failure.json'; if ($count -ge 3) { $status.coordinator.paused = $true; $status.coordinator.pauseReason = 'reviewer_failed_3_times' } }; $status.updatedAt = $now; $status | ConvertTo-Json -Depth 12 | Set-Content $statusPath"
rmdir /s /q ".agent-locks\worker.lock" 2>nul
exit /b %EXIT_CODE%
