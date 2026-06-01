# Stop everything dev.ps1 started.

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = Split-Path -Parent $ScriptDir
$PidsFile  = Join-Path $RepoRoot ".dev-pids"

Write-Host "==> stopping SMM dev processes" -ForegroundColor Cyan

if (Test-Path $PidsFile) {
    Get-Content $PidsFile | ForEach-Object {
        if ($_ -match '^\d+$') {
            $procId = [int]$_
            try {
                $p = Get-Process -Id $procId -ErrorAction Stop
                Write-Host "  stopping pid $procId ($($p.ProcessName))" -ForegroundColor DarkGray
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            } catch {
                # already gone
            }
        }
    }
    Remove-Item $PidsFile -Force -ErrorAction SilentlyContinue
}

# Belt-and-braces: kill any cloudflared still hanging around.
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  stopping stray cloudflared (pid $($_.Id))" -ForegroundColor DarkGray
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

# Free our dev ports if anything's still listening.
foreach ($port in 3000, 4000) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            Write-Host "  freeing port $port (pid $($c.OwningProcess))" -ForegroundColor DarkGray
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

Write-Host "==> done" -ForegroundColor Green
