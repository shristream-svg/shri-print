$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\server\index.js'))) { throw 'Run npm install and npm run build first.' }
$runtimePath = Join-Path $projectRoot 'runtime'
New-Item -ItemType Directory -Force -Path (Join-Path $runtimePath 'bin') | Out-Null
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $runtimePath /inheritance:r /grant:r ($currentUser + ':(OI)(CI)F') 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
$engine = Join-Path $runtimePath 'bin\SumatraPDF.exe'
if (-not (Test-Path -LiteralPath $engine)) {
    $zipPath = Join-Path $runtimePath 'sumatra-portable.zip'
    Invoke-WebRequest -Uri 'https://www.sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip' -OutFile $zipPath -UseBasicParsing
    Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $runtimePath 'sumatra-extract') -Force
    $downloaded = Get-ChildItem -LiteralPath (Join-Path $runtimePath 'sumatra-extract') -Filter '*.exe' | Select-Object -First 1
    if (-not $downloaded) { throw 'SumatraPDF executable not found in official download.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $downloaded.FullName
    if ($signature.Status -ne 'Valid') { throw 'PDF print engine signature could not be verified.' }
    Copy-Item -LiteralPath $downloaded.FullName -Destination $engine
}
# Initialize the local database and private keys without opening a window.
$ready = $false
try { $ready = (Invoke-WebRequest -Uri 'http://localhost:4888/api/config' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch {}
if (-not $ready) { Start-Process -FilePath $nodeExe -ArgumentList @('"' + (Join-Path $projectRoot 'local\server.mjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'server.log') -RedirectStandardError (Join-Path $runtimePath 'server-error.log') }
for ($attempt = 0; $attempt -lt 30; $attempt++) { if (Test-Path -LiteralPath (Join-Path $runtimePath 'secrets.json')) { break }; Start-Sleep -Milliseconds 300 }
$configPath = Join-Path $projectRoot 'agent\config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $secrets = Get-Content -LiteralPath (Join-Path $runtimePath 'secrets.json') -Raw | ConvertFrom-Json
    [System.IO.File]::WriteAllText($configPath,(@{ server = 'http://localhost:4888'; token = $secrets.AGENT_TOKEN; mode = 'dry-run'; id = 'shri-shop-pc'; engine = $engine } | ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false)))
}
& icacls.exe $configPath /inheritance:r /grant:r ($currentUser + ':F') 'SYSTEM:F' 'BUILTIN\Administrators:F' | Out-Null
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutInfo in @(@{Directory=[Environment]::GetFolderPath('Desktop');Name='SHRI Print.lnk';NoOpen=$false},@{Directory=[Environment]::GetFolderPath('Startup');Name='SHRI Print Agent.lnk';NoOpen=$true})) {
    $shortcut = $shell.CreateShortcut((Join-Path $shortcutInfo.Directory $shortcutInfo.Name))
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $projectRoot 'launch.ps1') + '"' + $(if ($shortcutInfo.NoOpen) { ' -NoOpen' } else { '' })
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'SHRI Print shop panel and background printer agent'
    $shortcut.Save()
}
& (Join-Path $projectRoot 'launch.ps1')
Write-Host 'SHRI Print installed. Desktop shortcut and Windows startup are ready.'
