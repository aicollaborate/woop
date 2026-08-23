param(
  [Parameter(Mandatory = $true)][string]$Artifact,
  [string]$ExpectedThumbprint = $env:WINDOWS_CERT_THUMBPRINT
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) {
  throw "Windows artifact not found: $Artifact"
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("flowix-verify-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Expand-Archive -LiteralPath $Artifact -DestinationPath $temp -Force
  $entries = Get-ChildItem -LiteralPath $temp -Recurse -File
  $forbidden = $entries | Where-Object {
    $_.Name -match '^(dsh-host|dsh-host-spawn-helper)(\.exe)?$' -or
    $_.FullName -match 'dsh-flowix-memory|dsh-web-ui|dsh-client-ui-'
  }
  if ($forbidden) {
    throw "Flowix installer archive contains DSH files: $($forbidden.FullName -join ', ')"
  }

  $signtool = Get-Command signtool.exe -ErrorAction Stop
  $binaries = $entries | Where-Object { $_.Extension -ieq '.exe' }
  if (-not $binaries) { throw 'No executable found in the Windows artifact.' }
  foreach ($binary in $binaries) {
    & $signtool.Source verify /pa /all /tw $binary.FullName
    if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed: $($binary.FullName)" }
    if ($ExpectedThumbprint) {
      $signature = Get-AuthenticodeSignature -FilePath $binary.FullName
      $subject = $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
      if ($subject -ne $ExpectedThumbprint.Replace(' ', '').ToUpperInvariant()) {
        throw "Certificate thumbprint mismatch for $($binary.FullName): expected $ExpectedThumbprint, got $subject"
      }
    }
  }
  Write-Host "==> Verified signed Windows artifact and DSH exclusion: $Artifact"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
