# install-windows.ps1
#
# Installs specular-telemetry as a Windows scheduled task that starts on
# boot and restarts on failure. Idempotent: safe to re-run after every
# repo pull; it rebuilds the venv deps and re-registers the task.
#
# The venv lives under ProgramData because the task runs as SYSTEM, and
# SYSTEM should not depend on any one user's profile existing.
#
# Run from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$TaskName   = "Atlas Specular Telemetry"
$ServiceDir = $PSScriptRoot
$VenvDir    = Join-Path $env:ProgramData "AtlasSystems\specular-telemetry\venv"
$Port       = 9000

Write-Host "specular-telemetry // Windows install" -ForegroundColor Yellow

# --- 1. Find Python 3.12 ------------------------------------------------
$python = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    try { & py -3.12 -c "pass" 2>$null; if ($LASTEXITCODE -eq 0) { $python = "py -3.12" } } catch {}
}
if (-not $python) {
    if (Get-Command python -ErrorAction SilentlyContinue) { $python = "python" }
}
if (-not $python) {
    throw "Python 3.12 not found. Install it (winget install Python.Python.3.12) and re-run."
}
Write-Host "  python: $python"

# --- 2. Create or reuse the venv ----------------------------------------
if (-not (Test-Path (Join-Path $VenvDir "Scripts\python.exe"))) {
    Write-Host "  creating venv at $VenvDir"
    New-Item -ItemType Directory -Force -Path $VenvDir | Out-Null
    Invoke-Expression "$python -m venv `"$VenvDir`""
} else {
    Write-Host "  venv exists at $VenvDir"
}
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

# --- 3. Install pinned dependencies --------------------------------------
Write-Host "  installing requirements"
& $VenvPython -m pip install --quiet --upgrade pip
& $VenvPython -m pip install --quiet -r (Join-Path $ServiceDir "requirements.txt")

# --- 4. Register the scheduled task --------------------------------------
# SYSTEM principal: survives logoff, needs no stored password. Restart
# up to 3 times a minute apart, no execution time limit (it is a
# service in a task's clothing).
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  replacing existing task"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute $VenvPython `
    -Argument "-m uvicorn telemetry:app --host 0.0.0.0 --port $Port" `
    -WorkingDirectory $ServiceDir

$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host "  task registered: $TaskName"

# --- 5. Start now and verify ---------------------------------------------
Start-ScheduledTask -TaskName $TaskName
Write-Host "  waiting for /health"
$ok = $false
foreach ($attempt in 1..10) {
    Start-Sleep -Seconds 2
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
        if ($health.ok) { $ok = $true; break }
    } catch {}
}

if ($ok) {
    Write-Host "specular-telemetry is live at http://127.0.0.1:$Port/telemetry" -ForegroundColor Green
} else {
    Write-Host "Task registered but /health did not answer within 20s." -ForegroundColor Red
    Write-Host "Inspect with: Get-ScheduledTaskInfo -TaskName `"$TaskName`""
    exit 1
}
