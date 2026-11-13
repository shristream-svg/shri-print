<#
.SYNOPSIS
    Creates or updates SHRI Print desktop and Startup shortcuts for the current user.

.DESCRIPTION
    This script creates a desktop shortcut named "SHRI Print.lnk" and a Startup folder shortcut
    named "SHRI Print Admin.lnk" for the SHRI Print Admin Electron application.
    It backs up only these specific SHRI Print shortcuts before replacing them.
    Other CSC/Vault shortcuts are never modified.

.PARAMETER AppExecutable
    Full path to the SHRI Print Admin executable (e.g., SHRI Print Admin.exe).

.EXAMPLE
    .\install-native.ps1 -AppExecutable "C:\Program Files\SHRI Print Admin\SHRI Print Admin.exe"

.NOTES
    Requires Windows with WScript.Shell COM object available.
    Run once after installation or update. Does not require elevation.
#>

param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$AppExecutable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DesktopShortcutName = 'SHRI Print.lnk'
$StartupShortcutName = 'SHRI Print Admin.lnk'
$BackupDirName = 'SHRI Print Shortcut Backups'

function Get-SpecialFolderPath([System.Environment+SpecialFolder]$Folder) {
    return [System.Environment]::GetFolderPath($Folder)
}

function Get-BackupDirectory() {
    $localAppData = Get-SpecialFolderPath 'LocalApplicationData'
    $backupDir = Join-Path $localAppData $BackupDirName
    if (-not (Test-Path $backupDir)) {
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }
    return $backupDir
}

function Backup-Shortcut([string]$ShortcutPath, [string]$BackupPrefix) {
    if (Test-Path $ShortcutPath) {
        $backupDir = Get-BackupDirectory
        $timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
        $backupName = "${BackupPrefix}_$timestamp.lnk"
        $backupPath = Join-Path $backupDir $backupName

        try {
            Copy-Item -Path $ShortcutPath -Destination $backupPath -Force -ErrorAction Stop
            Write-Host "Backed up existing shortcut to: $backupPath"
        } catch {
            Write-Warning "Failed to backup shortcut '$ShortcutPath': $_"
        }
    }
}

function Create-Shortcut([string]$TargetPath, [string]$ShortcutPath, [string]$WorkingDirectory, [string]$Description, [string]$Arguments = '') {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.Arguments = $Arguments
    $iconFile = Join-Path (Split-Path -Parent $TargetPath) 'SHRI Print.ico'
    $shortcut.IconLocation = if(Test-Path -LiteralPath $iconFile) { $iconFile } else { "$TargetPath,0" }
    $shortcut.Save()
    Write-Host "Created/updated shortcut: $ShortcutPath"
}

function Main() {
    if (-not (Test-Path $AppExecutable -PathType Leaf)) {
        Write-Error "Executable not found: $AppExecutable"
        exit 1
    }

    $exeDir = Split-Path -Parent $AppExecutable
    $desktopPath = Join-Path (Get-SpecialFolderPath 'Desktop') $DesktopShortcutName
    $startupPath = Join-Path (Get-SpecialFolderPath 'Startup') $StartupShortcutName
    $description = 'SHRI Print Admin - Desktop administration interface for SHRI Print'

    Write-Host "Installing shortcuts for SHRI Print Admin..."
    Write-Host "Executable: $AppExecutable"

    Backup-Shortcut $desktopPath 'SHRI_Print'
    Backup-Shortcut $startupPath 'SHRI_Print_Admin'

    Create-Shortcut -TargetPath $AppExecutable -ShortcutPath $desktopPath -WorkingDirectory $exeDir -Description $description
    Create-Shortcut -TargetPath $AppExecutable -ShortcutPath $startupPath -WorkingDirectory $exeDir -Description $description

    Write-Host "Shortcut installation complete."
}

Main