$ErrorActionPreference = 'Stop'
$node = 'C:\Users\Administrator\AppData\Roaming\Flowix\dsh\versions\1.0.2\node\node.exe'
$bin = 'C:\Users\Administrator\AppData\Roaming\Flowix\dsh\versions\1.0.2\runtime\node_modules\@deepseek-ai\dsh-sdk-jsonrpc-demo\lib\packaged-bin.js'
$configTemplate = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dsh-runtime-test\cordis-minimal.yml'))
$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-appserver-smoke-' + [Guid]::NewGuid().ToString('N'))
$sessionRoot = Join-Path $runRoot 'sessions'
[System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
$configText = [System.IO.File]::ReadAllText($configTemplate)
$configText = $configText -replace "(?m)^\s*root:\s*.*$", ("    root: '{0}'" -f $sessionRoot.Replace('\', '/'))
$config = Join-Path $runRoot 'cordis-minimal.yml'
[System.IO.File]::WriteAllText($config, $configText)
$env:DSH_HOME = $runRoot
$threadId = 'runtime-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$childId = $threadId + '-child'
$frames = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"provider":"deepseek-official","model":"deepseek-v4-flash","cwd":"D:/Notes/推广方案/dsh-appserver"}}',
  '{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"threadId":"__THREAD__"}}',
  '{"jsonrpc":"2.0","id":14,"method":"thread/approvalPolicy/read","params":{"threadId":"__THREAD__"}}',
  '{"jsonrpc":"2.0","id":3,"method":"thread/read","params":{"threadId":"__THREAD__","includeTurns":true}}',
  '{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{"threadId":"__THREAD__","input":"interrupt smoke"}}',
  '{"jsonrpc":"2.0","id":5,"method":"turn/interrupt","params":{"threadId":"__THREAD__"}}',
  '{"jsonrpc":"2.0","id":6,"method":"thread/fork","params":{"threadId":"__THREAD__","boundarySeq":4,"newThreadId":"__CHILD__"}}',
  '{"jsonrpc":"2.0","id":7,"method":"thread/read","params":{"threadId":"__CHILD__","includeTurns":true}}',
  '{"jsonrpc":"2.0","id":8,"method":"thread/list","params":{}}',
  '{"jsonrpc":"2.0","id":9,"method":"session/flush","params":{"threadId":"__THREAD__"}}',
  '{"jsonrpc":"2.0","id":10,"method":"thread/close","params":{"threadId":"__CHILD__"}}',
  '{"jsonrpc":"2.0","id":11,"method":"thread/events/list","params":{"threadId":"__THREAD__","afterSeq":-1,"limit":100}}',
  '{"jsonrpc":"2.0","id":13,"method":"thread/fork","params":{"threadId":"__THREAD__","boundarySeq":3,"newThreadId":"__INVALID_CHILD__"}}',
  '{"jsonrpc":"2.0","id":15,"method":"thread/close","params":{"threadId":"__THREAD__"}}',
  '{"jsonrpc":"2.0","id":12,"method":"shutdown","params":{}}'
) -join "`n"
$invalidChildId = $threadId + '-invalid-child'
$frames = $frames.Replace('__THREAD__', $threadId).Replace('__CHILD__', $childId).Replace('__INVALID_CHILD__', $invalidChildId)
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $node
$psi.Arguments = ('"{0}" "{1}"' -f $bin, $config)
$psi.WorkingDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $psi
if (-not $process.Start()) { throw 'failed to start packaged JSON-RPC runtime' }
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$process.StandardInput.WriteLine($frames)
$process.StandardInput.Flush()
Start-Sleep -Milliseconds 3000
$process.StandardInput.Close()
$exited = $process.WaitForExit(20000)
if (-not $exited) { $process.Kill(); $process.WaitForExit() }
$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result
if ($exited -and $process.ExitCode -ne 0) { throw "packaged JSON-RPC runtime failed: $stderr`n$stdout" }
$responses = @($stdout -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
foreach ($id in 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15) { if (-not ($responses | Where-Object { $_.id -eq $id })) { throw "missing JSON-RPC response id=$id`n$stdout`n$stderr" } }
$start = $responses | Where-Object { $_.id -eq 2 }
if (-not $start.result.thread.id) { throw "thread/start returned no thread id: $stdout" }
$approvalPolicy = $responses | Where-Object { $_.id -eq 14 }
if ($approvalPolicy.result.policy -ne 'ask') { throw "native DSH approval policy was not available: $stdout" }
$read = $responses | Where-Object { $_.id -eq 3 }
if ($read.result.thread.id -ne $threadId) { throw "thread/read returned wrong id: $stdout" }
$turnStarted = $responses | Where-Object { $_.method -eq 'turn/started' }
if (-not $turnStarted) { throw "missing turn/started notification: $stdout" }
$turnCompleted = $responses | Where-Object { $_.method -eq 'turn/completed' }
if (-not $turnCompleted) { throw "missing turn/completed notification: $stdout" }
$turn = $responses | Where-Object { $_.id -eq 4 }
if ($turn.result.turn.status -ne 'inProgress') { throw "turn/start did not admit a turn: $stdout" }
if ($turnStarted.params.turn.id -ne $turn.result.turn.id -or $turnCompleted.params.turn.id -ne $turn.result.turn.id) { throw "turn id was not stable across notifications: $stdout" }
$interrupt = $responses | Where-Object { $_.id -eq 5 }
if ($interrupt.result.interrupted -ne $true) { throw "turn/interrupt did not interrupt: $stdout" }
$fork = $responses | Where-Object { $_.id -eq 6 }
if ($fork.result.thread.id -ne $childId) { throw "thread/fork returned wrong id: $stdout" }
if ($fork.result.thread.parentThreadId -ne $threadId) { throw "thread/fork returned wrong parent: $stdout" }
$childRead = $responses | Where-Object { $_.id -eq 7 }
if ($childRead.result.thread.turns[0].items.Count -lt 1) { throw "fork did not copy stable history: $stdout" }
$flush = $responses | Where-Object { $_.id -eq 9 }
if ($flush.result.flushed -ne $true) { throw "session/flush did not flush: $stdout" }
$events = $responses | Where-Object { $_.id -eq 11 }
if ($events.result.page.data.Count -lt 1) { throw "thread/events/list returned no durable events: $stdout" }
$invalidFork = $responses | Where-Object { $_.id -eq 13 }
if (-not $invalidFork.error) { throw "fork accepted a boundary inside an active turn: $stdout" }
$restartFrames = @(
  '{"jsonrpc":"2.0","id":101,"method":"initialize","params":{"clientInfo":{"name":"restart-smoke","version":"1"}}}',
  '{"jsonrpc":"2.0","id":102,"method":"thread/read","params":{"threadId":"__THREAD__","includeTurns":true}}',
  '{"jsonrpc":"2.0","id":103,"method":"shutdown","params":{}}'
) -join "`n"
$restartFrames = $restartFrames.Replace('__THREAD__', $threadId)
$restart = [System.Diagnostics.Process]::new()
$restart.StartInfo = $psi
if (-not $restart.Start()) { throw 'failed to restart packaged JSON-RPC runtime' }
$restartStdoutTask = $restart.StandardOutput.ReadToEndAsync()
$restartStderrTask = $restart.StandardError.ReadToEndAsync()
$restart.StandardInput.WriteLine($restartFrames)
$restart.StandardInput.Flush()
Start-Sleep -Milliseconds 2000
$restart.StandardInput.Close()
$restartExited = $restart.WaitForExit(10000)
if (-not $restartExited) { $restart.Kill(); $restart.WaitForExit() }
$restartStdout = $restartStdoutTask.Result
$restartStderr = $restartStderrTask.Result
if ($restartExited -and $restart.ExitCode -ne 0) { throw "restarted runtime failed: $restartStderr`n$restartStdout" }
$restartResponses = @($restartStdout -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
$restartRead = $restartResponses | Where-Object { $_.id -eq 102 }
if ($restartRead.result.thread.turns.Count -lt 1) { throw "restart did not recover turns: $restartStdout" }
if ($restartRead.result.thread.turns[0].id -ne $turn.result.turn.id) { throw "turn id changed after restart: $restartStdout" }
Write-Output 'runtime JSON-RPC smoke: ok'
