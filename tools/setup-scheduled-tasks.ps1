# ============================================================
#  Campus network auto login - Windows Task Scheduler setup
#  Creates one daily task per time point. Each task launches
#  Edge with the trigger URL; the browser extension then fills
#  and submits the campus portal form automatically.
#
#  Run **as the current user** (no admin needed for your own tasks):
#    powershell -ExecutionPolicy Bypass -File setup-scheduled-tasks.ps1
#
#  Options:
#    -Times "08:00,12:30,18:00"   time points, comma separated
#    -Url   "http://10.0.0.55/srun_portal_pc?ac_id=1"   trigger URL
#    -Wake                        wake the PC to run the task
#    -Remove                      delete previously created tasks
#    -DryRun                      show what would be done, change nothing
# ============================================================

param(
    [string]$Times = "08:00,12:30,18:00",
    [string]$Url = "http://connectivitycheck.platform.hicloud.com/generate_204",
    [string]$Prefix = "CampusNetLogin",
    [switch]$Wake,
    [switch]$Remove,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $scriptDir "login-edge.cmd"

if (-not (Test-Path $launcher)) {
    Write-Host "[ERROR] launcher not found: $launcher"
    exit 1
}

function Get-TaskName([string]$time) {
    return ($Prefix + "_" + $time.Replace(":", ""))
}

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName ($Prefix + "_*") -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "No task named $Prefix_* found."
        exit 0
    }
    foreach ($t in $existing) {
        if ($DryRun) {
            Write-Host "[DryRun] would delete task: " + $t.TaskName
        } else {
            Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false
            Write-Host "deleted: " + $t.TaskName
        }
    }
    exit 0
}

$list = @()
$Times = $Times.Replace([char]0xFF0C, ",")   # accept full-width comma without non-ASCII source
foreach ($part in ($Times -split "[,;\s]+")) {
    $t = $part.Trim()
    if ($t -eq "") { continue }
    if ($t -notmatch "^\d{1,2}:\d{2}$") {
        Write-Host ("[WARN] skip invalid time: " + $t)
        continue
    }
    $list += $t
}

if ($list.Count -eq 0) {
    Write-Host "[ERROR] no valid time point. Example: -Times ""08:00,12:30"""
    exit 1
}

$userId = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "launcher : $launcher"
Write-Host "url      : $Url"
Write-Host "user     : $userId"
Write-Host "times    : $($list -join ', ')"
Write-Host "wake pc  : $Wake"
Write-Host ""

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
if ($Wake) { $settings.WakeToRun = $true }

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ("/c `"" + $launcher + "`" `"" + $Url + "`"")

foreach ($t in $list) {
    $name = Get-TaskName $t
    if ($DryRun) {
        Write-Host ("[DryRun] would create task " + $name + " daily at " + $t)
        continue
    }
    $trigger = New-ScheduledTaskTrigger -Daily -At $t
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host ("created: " + $name + " @ " + $t)
}

if (-not $DryRun) {
    Write-Host ""
    Write-Host "Done. Check with: Get-ScheduledTask -TaskName '$Prefix*'"
    Write-Host "Test now with  : Start-ScheduledTask -TaskName '$($Prefix)_$($list[0].Replace(':',''))'"
}
