param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('developer', 'reviewer')]
  [string] $Role
)

$ErrorActionPreference = 'Stop'

$lock = '.agent-locks\worker.lock'
$startedDate = Get-Date
$started = $startedDate.ToString('o')
$stamp = $startedDate.ToString('yyyyMMdd-HHmmss')
$stdout = ".agent-logs/$Role-$stamp.stdout.log"
$stderr = ".agent-logs/$Role-$stamp.stderr.log"
$share = ".agent-logs/$Role-$stamp.session.md"

if ($Role -eq 'developer') {
  $agent = 'whetstone-developer'
  $prompt = 'Run one whetstone developer tick. Follow prompts/developer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one developer work unit, then exit.'
} else {
  $agent = 'whetstone-reviewer'
  $prompt = 'Run one whetstone reviewer tick. Follow prompts/reviewer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one reviewer work unit, then exit.'
}

# Pass the prompt as a single argument. Start-Process receives one pre-built command
# line string (not an array), so the spaced prompt is not split into separate argv
# tokens. Only the prompt and share path are wrapped in quotes; the rest are bare flags.
$argumentList = "--agent=$agent --allow-all --no-ask-user --share=`"$share`" -p `"$prompt`""

$process = Start-Process -FilePath 'copilot' `
  -ArgumentList $argumentList `
  -PassThru `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr

Set-Content (Join-Path $lock 'role.txt') $Role
Set-Content (Join-Path $lock 'pid.txt') $process.Id
Set-Content (Join-Path $lock 'startedAt.txt') $started
Set-Content (Join-Path $lock 'command.txt') "scripts\start-$Role.cmd"
Set-Content (Join-Path $lock 'stdout.txt') $stdout
Set-Content (Join-Path $lock 'stderr.txt') $stderr
Set-Content (Join-Path $lock 'session.txt') $share

$process.WaitForExit()
exit $process.ExitCode
