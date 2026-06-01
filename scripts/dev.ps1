# SMM dev launcher.
# Starts: Cloudflare Tunnel -> writes URL into .env -> opens API + worker + web windows.
# Run from anywhere via:   pnpm dev    (from repo root)
# Or directly:             powershell -ExecutionPolicy Bypass -File scripts/dev.ps1

$ErrorActionPreference = "Stop"

# ---- locate repo root ----
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

Write-Host ""
Write-Host "==> SMM dev launcher" -ForegroundColor Cyan
Write-Host ""

# ---- check prereqs ----
function Require-Cmd($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Host "[error] '$name' not found on PATH" -ForegroundColor Red
        Write-Host "        install it first, then re-run." -ForegroundColor Red
        exit 1
    }
}
Require-Cmd cloudflared
Require-Cmd pnpm
Require-Cmd node

$EnvPath = Join-Path $RepoRoot ".env"
if (-not (Test-Path $EnvPath)) {
    Write-Host "[error] .env not found at $EnvPath" -ForegroundColor Red
    exit 1
}

$PidsFile = Join-Path $RepoRoot ".dev-pids"

# ---- stop anything we previously started ----
function Stop-PreviousRun {
    # Kill any cloudflared running on this machine (we never want two).
    Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  stopping previous cloudflared (pid $($_.Id))" -ForegroundColor DarkGray
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    # Kill processes still holding our ports.
    foreach ($port in 3000, 4000) {
        try {
            $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
            foreach ($c in $conns) {
                Write-Host "  freeing port $port (pid $($c.OwningProcess))" -ForegroundColor DarkGray
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    # Kill PIDs we recorded last time, if any.
    if (Test-Path $PidsFile) {
        Get-Content $PidsFile | ForEach-Object {
            if ($_ -match '^\d+$') {
                Stop-Process -Id [int]$_ -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item $PidsFile -Force
    }
    Start-Sleep -Milliseconds 600
}
Stop-PreviousRun

# ---- start cloudflared ----
$TunnelLog = Join-Path $env:TEMP "smm-cloudflared.log"
if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force }

Write-Host "==> starting Cloudflare Tunnel..." -ForegroundColor Cyan
$TunnelProc = Start-Process cloudflared `
    -ArgumentList "tunnel","--url","http://localhost:4000" `
    -RedirectStandardOutput $TunnelLog `
    -RedirectStandardError "$TunnelLog.err" `
    -PassThru `
    -WindowStyle Hidden

# ---- wait for the trycloudflare URL to appear ----
$Url = $null
$Deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 500
    $content = ""
    if (Test-Path $TunnelLog) { $content += Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue }
    if (Test-Path "$TunnelLog.err") { $content += Get-Content "$TunnelLog.err" -Raw -ErrorAction SilentlyContinue }
    if ($content -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        $Url = $matches[0]
        break
    }
}
if (-not $Url) {
    Write-Host "[error] Cloudflare Tunnel didn't print a URL within 45s." -ForegroundColor Red
    if (Test-Path $TunnelLog) { Write-Host "--- log tail ---"; Get-Content $TunnelLog -Tail 20 }
    if (Test-Path "$TunnelLog.err") { Write-Host "--- err tail ---"; Get-Content "$TunnelLog.err" -Tail 20 }
    Stop-Process -Id $TunnelProc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "    tunnel ready: $Url" -ForegroundColor Green
Write-Host ""

# ---- update PUBLIC_BASE_URL in .env (preserves other lines + encoding without BOM) ----
$EnvLines = Get-Content $EnvPath
$Found = $false
$NewLines = $EnvLines | ForEach-Object {
    if ($_ -match '^\s*PUBLIC_BASE_URL\s*=') {
        $Found = $true
        "PUBLIC_BASE_URL=$Url"
    } else {
        $_
    }
}
if (-not $Found) { $NewLines += "PUBLIC_BASE_URL=$Url" }
[System.IO.File]::WriteAllLines($EnvPath, $NewLines)
Write-Host "==> updated PUBLIC_BASE_URL in .env" -ForegroundColor Green
Write-Host ""

# ---- launch API + worker + web in their own windows ----
function Start-DevWindow($Title, $WorkDir, $Cmd) {
    $inner = "`$Host.UI.RawUI.WindowTitle='$Title'; Set-Location '$WorkDir'; Write-Host '== $Title ==' -ForegroundColor Cyan; $Cmd"
    return Start-Process powershell `
        -ArgumentList "-NoExit","-ExecutionPolicy","Bypass","-Command", $inner `
        -PassThru
}

$ApiProc    = Start-DevWindow "SMM | API"    (Join-Path $RepoRoot "apps/api") "pnpm dev"
Start-Sleep -Milliseconds 700
$WorkerProc = Start-DevWindow "SMM | Worker" (Join-Path $RepoRoot "apps/api") "pnpm worker"
Start-Sleep -Milliseconds 700
$WebProc    = Start-DevWindow "SMM | Web"    (Join-Path $RepoRoot "apps/web") "pnpm dev"

# ---- record PIDs so stop.ps1 can clean up cleanly later ----
@($TunnelProc.Id, $ApiProc.Id, $WorkerProc.Id, $WebProc.Id) | Set-Content $PidsFile

Write-Host "==> all services launched" -ForegroundColor Green
Write-Host ""
Write-Host "    dashboard      http://localhost:3000"
Write-Host "    api            http://localhost:4000/health"
Write-Host "    public tunnel  $Url"
Write-Host ""
Write-Host "    tunnel log     $TunnelLog"
Write-Host ""
Write-Host "    to stop:       pnpm stop   (or close the 3 windows + cloudflared)" -ForegroundColor Yellow
Write-Host ""

# Open the dashboard in default browser.
Start-Process "http://localhost:3000" | Out-Null
