# Runs the full whetstone validation gate, or the changed-scope developer handoff gate with -Changed,
# encoding-safely.
# Writes the full output to a timestamped log under .agent-logs/ and prints PASS/FAIL with
# the tail on failure, so worker sessions do not stream Unicode-heavy output into their context.
#
# Usage, from the repository or worktree root:
#   pwsh -NoProfile -File .github/skills/whetstone-engineering/validate.ps1
#   pwsh -NoProfile -File .github/skills/whetstone-engineering/validate.ps1 -Changed

param([switch]$Changed)

$ErrorActionPreference = 'Continue'
$env:NO_COLOR = '1'

$logDir = '.agent-logs'
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}
$gate = if ($Changed) { 'validate:changed' } else { 'validate' }
$log = Join-Path $logDir ($gate.Replace(':', '-') + "-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")

& pnpm $gate *> $log
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Output "VALIDATE: PASS ($gate; full log: $log)"
} else {
  Write-Output "VALIDATE: FAIL ($gate; exit $code) (full log: $log)"
  Write-Output '--- last 40 lines ---'
  Get-Content $log -Tail 40
}

exit $code
