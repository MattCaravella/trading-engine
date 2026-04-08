# ============================================================
# Setup-TradingScheduler.ps1
# Run this ONCE in PowerShell (as Administrator) to create
# a Windows Scheduled Task that ensures scheduler.js is
# running every weekday morning at 9:00 AM ET.
# ============================================================

$TaskName = "TradingSchedulerAutoStart"
$TradingDir = "C:\Users\Matth\Desktop\Trading"
$LogFile = "$TradingDir\startup.log"
$DailyScriptPath = "$TradingDir\check-and-start.ps1"

# The script that will run each morning
$DailyScript = @"
`$TradingDir = "C:\Users\Matth\Desktop\Trading"
`$LogFile = "`$TradingDir\startup.log"
`$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

`$nodeProcs = Get-WmiObject Win32_Process -Filter "name = 'node.exe'" | Where-Object { `$_.CommandLine -like "*scheduler.js*" }

if (`$nodeProcs) {
    `$msg = "[`$Timestamp] OK - scheduler.js already running (PID: `$(`$nodeProcs.ProcessId))"
    Add-Content -Path `$LogFile -Value `$msg
} else {
    `$msg = "[`$Timestamp] STARTING - scheduler.js was not running. Launching now..."
    Add-Content -Path `$LogFile -Value `$msg

    Start-Process -FilePath "node" ``
        -ArgumentList "`$TradingDir\scheduler.js" ``
        -RedirectStandardOutput "`$TradingDir\scheduler.log" ``
        -RedirectStandardError "`$TradingDir\scheduler_err.log" ``
        -WindowStyle Hidden ``
        -WorkingDirectory `$TradingDir

    Start-Sleep -Seconds 5

    `$nodeProcs2 = Get-WmiObject Win32_Process -Filter "name = 'node.exe'" | Where-Object { `$_.CommandLine -like "*scheduler.js*" }

    if (`$nodeProcs2) {
        `$msg2 = "[`$Timestamp] SUCCESS - scheduler.js started (PID: `$(`$nodeProcs2.ProcessId))"
    } else {
        `$msg2 = "[`$Timestamp] ERROR - scheduler.js failed to start! Check scheduler_err.log"
    }

    Add-Content -Path `$LogFile -Value `$msg2
}
"@

# Save the daily check script
$DailyScript | Out-File -FilePath $DailyScriptPath -Encoding UTF8 -Force
Write-Host "Daily check script saved to: $DailyScriptPath" -ForegroundColor Green

# Define the scheduled task
$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$DailyScriptPath`""

$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
    -At "09:00AM"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -RestartCount 1 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

# Remove existing task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task: $TaskName" -ForegroundColor Yellow
}

# Register the task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Checks if Trading scheduler.js is running each weekday at 9AM ET and starts it if not." `
    -Force

Write-Host ""
Write-Host "SUCCESS! Scheduled task created: $TaskName" -ForegroundColor Green
Write-Host "Runs: Monday-Friday at 9:00 AM ET" -ForegroundColor Cyan
Write-Host "Log file: $LogFile" -ForegroundColor Cyan
Write-Host ""
Write-Host "To test it right now, run this command:" -ForegroundColor Gray
Write-Host "Start-ScheduledTask -TaskName TradingSchedulerAutoStart" -ForegroundColor White
