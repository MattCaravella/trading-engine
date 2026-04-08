$TradingDir = "C:\Users\Matth\Desktop\Trading"
$LogFile = "$TradingDir\startup.log"
$Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

$nodeProcs = Get-WmiObject Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like "*scheduler.js*" }

if ($nodeProcs) {
    $msg = "[$Timestamp] OK - scheduler.js already running (PID: $($nodeProcs.ProcessId))"
    Add-Content -Path $LogFile -Value $msg
} else {
    $msg = "[$Timestamp] STARTING - scheduler.js was not running. Launching now..."
    Add-Content -Path $LogFile -Value $msg

    Start-Process -FilePath "node" `
        -ArgumentList "$TradingDir\scheduler.js" `
        -RedirectStandardOutput "$TradingDir\scheduler.log" `
        -RedirectStandardError "$TradingDir\scheduler_err.log" `
        -WindowStyle Hidden `
        -WorkingDirectory $TradingDir

    Start-Sleep -Seconds 5

    $nodeProcs2 = Get-WmiObject Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like "*scheduler.js*" }

    if ($nodeProcs2) {
        $msg2 = "[$Timestamp] SUCCESS - scheduler.js started (PID: $($nodeProcs2.ProcessId))"
    } else {
        $msg2 = "[$Timestamp] ERROR - scheduler.js failed to start! Check scheduler_err.log"
    }

    Add-Content -Path $LogFile -Value $msg2
}
