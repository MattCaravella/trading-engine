# Kill all stale trading node processes, preserve Claude Desktop (13332, 15808, 26816)
$toKill = @(5228, 18016, 11800, 20488, 13520, 15904, 10680, 15376, 5236, 6248, 21348, 9484, 10124, 21232, 6556, 7436, 30404, 33104, 27352, 24720, 32440)

foreach ($procId in $toKill) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "Killed $procId"
    } catch {
        Write-Host "Skip $procId (not found)"
    }
}
Write-Host "Done. Waiting 3s..."
Start-Sleep -Seconds 3
Write-Host "Remaining node processes:"
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet,StartTime | Format-Table
