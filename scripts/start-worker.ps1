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
$stdout = Join-Path '.agent-logs' "$Role-$stamp.stdout.log"
$stderr = Join-Path '.agent-logs' "$Role-$stamp.stderr.log"
$share = Join-Path '.agent-logs' "$Role-$stamp.session.md"

if ($Role -eq 'developer') {
  $agent = 'whetstone-developer'
  $prompt = 'Run one whetstone developer tick. Follow prompts/developer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one developer work unit, then exit.'
} else {
  $agent = 'whetstone-reviewer'
  $prompt = 'Run one whetstone reviewer tick. Follow prompts/reviewer-once.txt and docs/LOCAL_AGENT_WORKFLOW.md exactly. Use local status and process at most one reviewer work unit, then exit.'
}

if ($null -eq [System.Diagnostics.ProcessStartInfo].GetProperty('ArgumentList')) {
  throw 'ProcessStartInfo.ArgumentList is required to pass Copilot prompts safely.'
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'copilot'
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

foreach ($argument in @(
  "--agent=$agent",
  '--allow-all',
  '--no-ask-user',
  "--share=$share",
  '-p',
  $prompt
)) {
  [void] $startInfo.ArgumentList.Add($argument)
}

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$stdoutWriter = [System.IO.StreamWriter]::new($stdout, $false, [System.Text.UTF8Encoding]::new($false))
$stderrWriter = [System.IO.StreamWriter]::new($stderr, $false, [System.Text.UTF8Encoding]::new($false))

try {
  $process.add_OutputDataReceived({
    param($sender, $eventArgs)
    if ($null -ne $eventArgs.Data) {
      $stdoutWriter.WriteLine($eventArgs.Data)
      $stdoutWriter.Flush()
    }
  })
  $process.add_ErrorDataReceived({
    param($sender, $eventArgs)
    if ($null -ne $eventArgs.Data) {
      $stderrWriter.WriteLine($eventArgs.Data)
      $stderrWriter.Flush()
    }
  })

  [void] $process.Start()
  Set-Content (Join-Path $lock 'role.txt') $Role
  Set-Content (Join-Path $lock 'pid.txt') $process.Id
  Set-Content (Join-Path $lock 'startedAt.txt') $started
  Set-Content (Join-Path $lock 'command.txt') "scripts\start-$Role.cmd"
  Set-Content (Join-Path $lock 'stdout.txt') $stdout
  Set-Content (Join-Path $lock 'stderr.txt') $stderr
  Set-Content (Join-Path $lock 'session.txt') $share

  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  $process.WaitForExit()
  $process.WaitForExit()
  exit $process.ExitCode
} finally {
  $stdoutWriter.Dispose()
  $stderrWriter.Dispose()
  $process.Dispose()
}
