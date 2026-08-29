$ErrorActionPreference = 'Stop'
$dsh = 'C:\Users\Administrator\AppData\Roaming\Flowix\dsh\versions\1.0.2\bin\dsh.cmd'
$runtimeHome = Join-Path $PSScriptRoot '..\dsh-runtime-test'
$env:DSH_HOME = [System.IO.Path]::GetFullPath($runtimeHome)
$output = & $dsh --profile flowix --dump-config 2>&1
if ($LASTEXITCODE -ne 0) { throw "Flowix DSH dump-config failed: $output" }
$text = $output -join "`n"
if ($text -notmatch 'dsh-app-server-extension') { throw 'dsh-app-server extension was not loaded' }
if ($text -notmatch 'dsh-user-approval') { throw 'native DSH approval service was not loaded' }
if ($text -match 'sdk-jsonrpc-server') { throw 'stock SDK JSON-RPC server must not be used by dsh-app-server' }
Write-Output 'runtime profile smoke: ok'
