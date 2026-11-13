param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$runtimePath = Join-Path $projectRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$ready = $false
try { $ready = (Invoke-WebRequest -Uri 'http://localhost:4888/api/config' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch {}
if (-not $ready) {
    Start-Process -FilePath $nodeExe -ArgumentList @('"' + (Join-Path $projectRoot 'local\server.mjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'server.log') -RedirectStandardError (Join-Path $runtimePath 'server-error.log')
}
$agentLock = Join-Path $runtimePath 'agent.lock'
$agentAlive = $false
$agentScript = (Join-Path $projectRoot 'agent\agent.mjs').Replace('\','/').ToLowerInvariant()
if (Test-Path -LiteralPath $agentLock) {
    $agentPid = 0
    [void][int]::TryParse((Get-Content -LiteralPath $agentLock -Raw).Trim(),[ref]$agentPid)
    if ($agentPid -gt 0) {
        try {
            $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$agentPid" -ErrorAction Stop).CommandLine
            if ($cmdLine) { $agentAlive = $cmdLine.Replace('\','/').ToLowerInvariant().Contains($agentScript) }
        } catch { $agentAlive = $null -ne (Get-Process -Id $agentPid -ErrorAction SilentlyContinue) }
    }
    if (-not $agentAlive) { Remove-Item -LiteralPath $agentLock -Force -ErrorAction SilentlyContinue }
}
if (-not $agentAlive) {
    Start-Process -FilePath $nodeExe -ArgumentList @('"' + (Join-Path $projectRoot 'agent\agent.mjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'agent.log') -RedirectStandardError (Join-Path $runtimePath 'agent-error.log')
}
if (-not $NoOpen) {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { if ((Invoke-WebRequest -Uri 'http://localhost:4888/api/config' -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200) { break } } catch {}
        Start-Sleep -Milliseconds 300
    }
    Start-Process 'http://localhost:4888/local-login'
}