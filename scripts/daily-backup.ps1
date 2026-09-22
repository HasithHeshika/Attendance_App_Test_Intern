<#
.SYNOPSIS
  Daily Firestore backup -> single overwritten file in OneDrive.

.DESCRIPTION
  Wrapper around scripts/firestore-backup.mjs, meant to be run unattended by
  Windows Task Scheduler (see scripts/register-backup-task.ps1).

  Two outputs, both overwritten on every run:
    1. Local staging copy   backups\firestore-latest.json
    2. OFFSITE (the real backup) - uploaded to the OneDrive configured in the
       app's API playground, via Microsoft Graph app-only auth, by
       scripts/onedrive-upload.mjs. Target comes from Firestore
       app_config/cloud_storage, e.g.
         quotations@altavision.lk/drive/root:/attendance.altavision.lk

  This does NOT use the OneDrive desktop sync client or the C:\Users\...\OneDrive
  folder - that folder has no account connected on this machine and does not sync.

  The backup is staged to a temp file and only promoted once it passes validation,
  so a failed / truncated run can never destroy the last known-good backup. An
  upload failure fails the whole run: a local-only copy is not a backup.

  Defaults to the (default) PRODUCTION database. The repo's .env.local pins
  FIRESTORE_DB_ID=test for local dev, so --db is passed explicitly here.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\daily-backup.ps1

.EXAMPLE
  # Back up the test database to a separate file in OneDrive
  .\scripts\daily-backup.ps1 -Database test -RemoteName firestore-test.json

.EXAMPLE
  # Accept a backup that shrank a lot (e.g. after a legitimate bulk delete)
  .\scripts\daily-backup.ps1 -Force
#>
[CmdletBinding()]
param(
    # Firestore database to back up. "(default)" = production.
    # NB: not -Db, which collides with the built-in -Debug alias.
    [string] $Database = '(default)',

    # Local staging file (default: backups\firestore-latest.json). Overwritten each run.
    # The offsite copy is the Graph upload, not this.
    [string] $Dest,

    # Reject a new backup smaller than this fraction of the current one.
    [double] $MinSizeRatio = 0.5,

    # Skip the shrink guard.
    [switch] $Force,

    # Keep the local copy only; don't push to OneDrive via Microsoft Graph.
    [switch] $SkipUpload,

    # Firestore database holding app_config/cloud_storage (default: auto-detect).
    [string] $ConfigDatabase,

    # Filename to write in OneDrive (default: same name as the local file).
    [string] $RemoteName
)

$ErrorActionPreference = 'Stop'

$ProjectRoot   = Split-Path -Parent $PSScriptRoot
$BackupScript  = Join-Path $ProjectRoot 'scripts\firestore-backup.mjs'
$UploadScript  = Join-Path $ProjectRoot 'scripts\onedrive-upload.mjs'
$LogFile       = Join-Path $ProjectRoot 'backups\daily-backup.log'
$MaxLogLines   = 500

# Local staging copy. Deliberately NOT the C:\Users\...\OneDrive sync folder: that
# folder is not connected to any account on this machine, so a file placed there
# never leaves the disk. The offsite copy is the Graph upload below.
if (-not $Dest) { $Dest = Join-Path $ProjectRoot 'backups\firestore-latest.json' }

# ── logging ────────────────────────────────────────────────────────────────────
# Appended line-by-line rather than buffered to the end: if the process is killed
# mid-run (Task Scheduler can tear a task down), the log still shows how far it got.
$logDir = Split-Path -Parent $LogFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log {
    param([string] $Message, [string] $Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Output $line
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 -ErrorAction Stop } catch { }
}

# Best-effort trim so the log can't grow without bound.
function Trim-Log {
    try {
        if (-not (Test-Path $LogFile)) { return }
        $all = @(Get-Content -Path $LogFile -Encoding utf8)
        if ($all.Count -gt $MaxLogLines) {
            Set-Content -Path $LogFile -Value $all[($all.Count - $MaxLogLines)..($all.Count - 1)] -Encoding utf8
        }
    } catch { }
}

# ── locate node ────────────────────────────────────────────────────────────────
function Resolve-NodeExe {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

$exitCode = 1
$tmpOut   = Join-Path $env:TEMP ("firestore-backup-{0}.json"      -f $PID)
$tmpStdOut= Join-Path $env:TEMP ("firestore-backup-{0}.stdout.txt" -f $PID)
$tmpStdErr= Join-Path $env:TEMP ("firestore-backup-{0}.stderr.txt" -f $PID)
$tmpUpOut = Join-Path $env:TEMP ("firestore-upload-{0}.stdout.txt" -f $PID)
$tmpUpErr = Join-Path $env:TEMP ("firestore-upload-{0}.stderr.txt" -f $PID)

try {
    Write-Log "=== Firestore daily backup starting (db=$Database) ==="

    $node = Resolve-NodeExe
    if (-not $node) { throw 'node.exe not found on PATH or in the usual install locations.' }
    if (-not (Test-Path $BackupScript)) { throw "Backup script not found: $BackupScript" }
    if (-not $SkipUpload -and -not (Test-Path $UploadScript)) { throw "Upload script not found: $UploadScript" }

    # ── run the backup into a temp file ────────────────────────────────────────
    $argList = @(
        ('"{0}"' -f $BackupScript),
        'backup',
        '--db',  ('"{0}"' -f $Database),
        '--out', ('"{0}"' -f $tmpOut)
    )
    Write-Log "Running: $node $($argList -join ' ')"

    $proc = Start-Process -FilePath $node -ArgumentList $argList `
        -WorkingDirectory $ProjectRoot -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $tmpStdOut -RedirectStandardError $tmpStdErr

    # node writes UTF-8; without -Encoding utf8 the box-drawing chars come back as mojibake.
    foreach ($l in @(Get-Content -Path $tmpStdOut -Encoding utf8 -ErrorAction SilentlyContinue)) {
        if ($l.Trim()) { Write-Log "  $l" }
    }
    $errText = @(Get-Content -Path $tmpStdErr -Encoding utf8 -ErrorAction SilentlyContinue) -join "`n"

    if ($proc.ExitCode -ne 0) {
        if ($errText.Trim()) { Write-Log $errText.Trim() 'ERROR' }
        throw "firestore-backup.mjs exited with code $($proc.ExitCode)."
    }

    # ── validate before we overwrite the good copy ─────────────────────────────
    if (-not (Test-Path $tmpOut)) { throw "Backup produced no output file at $tmpOut." }

    $newSize = (Get-Item $tmpOut).Length
    if ($newSize -lt 1024) { throw "Backup file is implausibly small ($newSize bytes) - refusing to overwrite." }

    $head = Get-Content -Path $tmpOut -TotalCount 5 -Encoding utf8
    if (($head -join '') -notmatch '__firestore_backup__') {
        throw 'Backup file is missing the __firestore_backup__ marker - refusing to overwrite.'
    }

    if ((Test-Path $Dest) -and (-not $Force)) {
        $oldSize = (Get-Item $Dest).Length
        if ($oldSize -gt 0 -and ($newSize / $oldSize) -lt $MinSizeRatio) {
            $pct = [math]::Round(100 * $newSize / $oldSize, 1)
            Write-Log "New backup is $pct% of the existing one ($newSize vs $oldSize bytes)." 'ERROR'
            Write-Log "Staged file kept for inspection: $tmpOut" 'ERROR'
            Write-Log "If the shrink is legitimate, re-run with -Force." 'ERROR'
            $tmpOut = $null   # don't delete it in finally
            throw 'Shrink guard tripped - existing backup left untouched.'
        }
    }

    # ── promote the staged file over the previous local copy ───────────────────
    $destDir = Split-Path -Parent $Dest
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        Write-Log "Created destination folder: $destDir"
    }

    Move-Item -Path $tmpOut -Destination $Dest -Force
    $tmpOut = $null   # moved; nothing to clean up

    $sizeMB = [math]::Round($newSize / 1MB, 2)
    Write-Log "OK - wrote $sizeMB MB to $Dest"

    # ── push offsite via Microsoft Graph ───────────────────────────────────────
    # The local folder above is NOT synced by the OneDrive desktop client, so this
    # upload is what actually gets the backup off this machine. Treat a failure as
    # a failed backup - a local-only copy is not a backup.
    if ($SkipUpload) {
        Write-Log 'Upload skipped (-SkipUpload). Local copy only - this is NOT an offsite backup.' 'WARN'
    } else {
        if (-not $RemoteName) { $RemoteName = Split-Path -Leaf $Dest }
        $upArgs = @(
            ('"{0}"' -f $UploadScript),
            '--file', ('"{0}"' -f $Dest),
            '--name', ('"{0}"' -f $RemoteName)
        )
        if ($ConfigDatabase) { $upArgs += @('--config-db', ('"{0}"' -f $ConfigDatabase)) }

        Write-Log "Uploading to OneDrive as '$RemoteName'..."
        $up = Start-Process -FilePath $node -ArgumentList $upArgs `
            -WorkingDirectory $ProjectRoot -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $tmpUpOut -RedirectStandardError $tmpUpErr

        foreach ($l in @(Get-Content -Path $tmpUpOut -Encoding utf8 -ErrorAction SilentlyContinue)) {
            if ($l.Trim()) { Write-Log "  $l" }
        }
        $upErrText = @(Get-Content -Path $tmpUpErr -Encoding utf8 -ErrorAction SilentlyContinue) -join "`n"

        if ($up.ExitCode -ne 0) {
            if ($upErrText.Trim()) { Write-Log $upErrText.Trim() 'ERROR' }
            throw "OneDrive upload failed (exit $($up.ExitCode)). Local copy at $Dest is up to date, but it is NOT offsite."
        }
    }

    Write-Log '=== Firestore daily backup finished ==='
    $exitCode = 0
}
catch {
    Write-Log $_.Exception.Message 'ERROR'
    Write-Log '=== Firestore daily backup FAILED ===' 'ERROR'
    $exitCode = 1
}
finally {
    foreach ($f in @($tmpOut, $tmpStdOut, $tmpStdErr, $tmpUpOut, $tmpUpErr)) {
        if ($f -and (Test-Path $f)) { Remove-Item -Path $f -Force -ErrorAction SilentlyContinue }
    }
    Trim-Log
}

exit $exitCode
