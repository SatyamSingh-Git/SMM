# Push every secret your API needs from .env into Fly's secrets store.
# Skips PUBLIC_BASE_URL (set separately after the app URL is known) and any
# dev-only vars (DIRECT_URL, UPLOAD_DIR -- Fly sets these itself).
#
# Run once after the app is created:
#   pnpm secrets:push     (from repo root)
# Or directly:
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-secrets.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Split-Path -Parent $ScriptDir
Set-Location $RepoRoot

$flyCmd = $null
if (Get-Command fly -ErrorAction SilentlyContinue) { $flyCmd = "fly" }
elseif (Get-Command flyctl -ErrorAction SilentlyContinue) { $flyCmd = "flyctl" }

if (-not $flyCmd) {
    Write-Host "[error] Fly CLI not found on PATH." -ForegroundColor Red
    Write-Host "  Install: iwr https://fly.io/install.ps1 -useb | iex"
    exit 1
}

if (-not (Test-Path ".env")) {
    Write-Host "[error] .env not found at repo root. Cannot read secrets to push." -ForegroundColor Red
    exit 1
}

# Vars that should NEVER go to Fly:
#   PUBLIC_BASE_URL -- depends on the deployed Fly URL, set separately
#   UPLOAD_DIR      -- Fly sets via Dockerfile to /data/uploads
#   API_PORT / PORT -- Fly sets API_PORT to 8080 in Dockerfile
#   WEB_PORT        -- not used in production
#   NODE_ENV        -- Fly sets to production
#   KILL_SWITCH     -- prefer leaving default unless explicitly toggled
$skip = @("PUBLIC_BASE_URL", "UPLOAD_DIR", "API_PORT", "PORT", "WEB_PORT", "NODE_ENV", "KILL_SWITCH")

$pairs = @()
Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    if ($line -notmatch '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { return }
    $k = $matches[1]
    $v = $matches[2]
    if ($v.StartsWith('"') -and $v.EndsWith('"')) {
        $v = $v.Substring(1, $v.Length - 2)
    }
    if ($skip -contains $k) {
        Write-Host "  skipping $k (Fly sets or excluded)" -ForegroundColor DarkGray
        return
    }
    if ($v -eq "") {
        Write-Host "  skipping $k (empty)" -ForegroundColor DarkGray
        return
    }
    $pairs += "$k=$v"
}

if ($pairs.Count -eq 0) {
    Write-Host "[error] no secrets to push" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "==> pushing $($pairs.Count) secrets to Fly..." -ForegroundColor Cyan
Write-Host "    (keys only, values stay in your terminal)"
foreach ($p in $pairs) {
    $key = ($p -split "=", 2)[0]
    Write-Host "    + $key"
}
Write-Host ""

& $flyCmd secrets set --stage @pairs
if ($LASTEXITCODE -ne 0) {
    Write-Host "[error] fly secrets set failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "==> secrets staged. They will be applied on the next deploy." -ForegroundColor Green
Write-Host "    next:  fly deploy -a smm-personal" -ForegroundColor Yellow
