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
  echo A whetstone worker is already running; developer one-shot skipped.
  exit /b 0
)
powershell -NoProfile -Command "$lock = '.agent-locks\worker.lock'; $startedDate = Get-Date; $started = $startedDate.ToString('o'); $stamp = $startedDate.ToString('yyyyMMdd-HHmmss'); $stdout = '.agent-logs/developer-' + $stamp + '.stdout.log'; $stderr = '.agent-logs/developer-' + $stamp + '.stderr.log'; $share = '.agent-logs/developer-' + $stamp + '.session.md'; $prompt = 'Run one whetstone developer tick. Follow prompts/developer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one developer work unit, then exit.'; $quotedPrompt = [char]34 + $prompt + [char]34; $args = @('--agent=whetstone-developer','--allow-all','--no-ask-user','--share=' + $share,'-p',$quotedPrompt); try { $proc = Start-Process -FilePath 'copilot' -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr; Set-Content (Join-Path $lock 'role.txt') 'developer'; Set-Content (Join-Path $lock 'pid.txt') $proc.Id; Set-Content (Join-Path $lock 'startedAt.txt') $started; Set-Content (Join-Path $lock 'command.txt') 'scripts\start-developer.cmd'; Set-Content (Join-Path $lock 'stdout.txt') $stdout; Set-Content (Join-Path $lock 'stderr.txt') $stderr; Set-Content (Join-Path $lock 'session.txt') $share; $proc.WaitForExit(); exit $proc.ExitCode } catch { Write-Error $_; exit 1 }"
set "EXIT_CODE=%ERRORLEVEL%"
powershell -NoProfile -Command "$statusPath = '.agent-status.local.json'; $status = Get-Content -Raw $statusPath | ConvertFrom-Json; foreach ($p in @('failureCount','lastFailureAt','nextRetryAfter')) { if ($status.developer.PSObject.Properties.Name -notcontains $p) { $status.developer | Add-Member -NotePropertyName $p -NotePropertyValue $null } }; foreach ($p in @('paused','pauseReason')) { if ($status.coordinator.PSObject.Properties.Name -notcontains $p) { $status.coordinator | Add-Member -NotePropertyName $p -NotePropertyValue $null } }; $nowDate = Get-Date; $now = $nowDate.ToString('o'); $status.developer.lastRunCompletedAt = $now; if (%EXIT_CODE% -eq 0) { $status.developer.failureCount = 0; $status.developer.lastFailureAt = $null; $status.developer.nextRetryAfter = $null; if (-not $status.developer.lastResult -or ($status.developer.lastResult -like 'process_failed*')) { $status.developer.lastResult = 'completed' }; if ($status.developer.state -eq 'failed') { $status.developer.state = 'idle' } } else { $previous = 0; if ($null -ne $status.developer.failureCount) { $previous = [int]$status.developer.failureCount }; $count = $previous + 1; $status.developer.failureCount = $count; $status.developer.lastFailureAt = $now; $status.developer.state = 'failed'; $status.developer.lastResult = 'process_failed_exit_%EXIT_CODE%'; $delay = [Math]::Min(60, [Math]::Pow(2, [Math]::Min($count, 5))); $status.developer.nextRetryAfter = $nowDate.AddMinutes($delay).ToString('o'); $failure = [pscustomobject]@{ role = 'developer'; exitCode = %EXIT_CODE%; failureCount = $count; completedAt = $now; nextRetryAfter = $status.developer.nextRetryAfter; command = 'scripts\\start-developer.cmd' }; $failure | ConvertTo-Json -Depth 4 | Set-Content '.agent-locks\\worker-last-failure.json'; if ($count -ge 3) { $status.coordinator.paused = $true; $status.coordinator.pauseReason = 'developer_failed_3_times' } }; $status.updatedAt = $now; $status | ConvertTo-Json -Depth 12 | Set-Content $statusPath"
rmdir /s /q ".agent-locks\worker.lock" 2>nul
exit /b %EXIT_CODE%
