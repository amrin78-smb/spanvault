<#
.SYNOPSIS
    Installs / updates SpanVault (NocVault suite) on a Windows Server.

.DESCRIPTION
    Mirrors the Update-DDIVault.ps1 pattern. Manages three NSSM services:
        SpanVault-API        node api/server.js            (127.0.0.1:3009)
        SpanVault-App        next start -p 3008            (frontend, :3008)
        SpanVault-Collector  node collector/collector.js   (background poller)

    The script:
      1. Stops the services (if present).
      2. Pulls the latest code (git).
      3. Writes .env.local from .env.local.example, substituting SERVER_IP.
         NEXT_PUBLIC_* vars are baked in at build time, so this happens BEFORE
         the frontend build.
      4. Installs npm dependencies (root + frontend).
      5. Applies scripts/schema.sql (idempotent).
      6. Builds the frontend (next build — NOT standalone).
      7. (Re)registers the three NSSM services and starts them.
      8. Runs a health check against the API.

.PARAMETER ServerIp
    The server's IP or hostname. Replaces the SERVER_IP placeholder in the
    .env.local templates. Required on first install.

.PARAMETER InstallDir
    Where SpanVault lives. Default: C:\NocVault\SpanVault

.PARAMETER Branch
    Git branch to deploy. Default: main

.EXAMPLE
    .\Update-SpanVault.ps1 -ServerIp 10.20.30.40
#>

[CmdletBinding()]
param(
    [string]$ServerIp,
    [string]$InstallDir = 'C:\NocVault\SpanVault',
    [string]$Branch     = 'main'
)

$ErrorActionPreference = 'Stop'

# ── Configuration ──────────────────────────────────────────────
$Services = @(
    @{ Name = 'SpanVault-API';       App = 'node'; Args = 'api\server.js';            Dir = $InstallDir },
    @{ Name = 'SpanVault-Collector'; App = 'node'; Args = 'collector\collector.js';   Dir = $InstallDir },
    @{ Name = 'SpanVault-App';       App = 'node'; Args = 'node_modules\next\dist\bin\next start -p 3008'; Dir = (Join-Path $InstallDir 'frontend') }
)
$PsqlUser = 'postgres'   # adjust if your schema apply uses a different superuser
$DbName   = 'spanvault'

function Write-Step($msg)  { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!]  $msg"   -ForegroundColor Yellow }

function Resolve-Tool($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "$name not found on PATH. $hint" }
    return $cmd.Source
}

# ── Pre-flight ─────────────────────────────────────────────────
Write-Step 'Pre-flight checks'
$nssm = Resolve-Tool 'nssm' 'Install NSSM and add it to PATH.'
$git  = Resolve-Tool 'git'  'Install Git for Windows.'
$npm  = Resolve-Tool 'npm'  'Install Node.js (which provides npm).'
Write-Ok "nssm: $nssm"
Write-Ok "git:  $git"
Write-Ok "npm:  $npm"

if (-not (Test-Path $InstallDir)) {
    throw "Install directory '$InstallDir' does not exist. Clone the repo there first, then re-run."
}

# ── 1. Stop services ───────────────────────────────────────────
Write-Step 'Stopping services'
foreach ($svc in $Services) {
    $exists = & $nssm status $svc.Name 2>$null
    if ($LASTEXITCODE -eq 0) {
        & $nssm stop $svc.Name 2>$null | Out-Null
        Write-Ok "Stopped $($svc.Name)"
    } else {
        Write-Warn "$($svc.Name) not yet installed"
    }
}

# ── 2. Pull latest code ────────────────────────────────────────
Write-Step 'Pulling latest code'
Push-Location $InstallDir
& $git fetch --all --prune
& $git checkout $Branch
& $git pull origin $Branch
Write-Ok "On branch $Branch"
Pop-Location

# ── 3. Write .env.local from template (SERVER_IP substitution) ──
Write-Step 'Writing environment files'
$rootExample = Join-Path $InstallDir '.env.local.example'
$rootEnv     = Join-Path $InstallDir '.env.local'
$feExample   = Join-Path $InstallDir 'frontend\.env.local.example'
$feEnv       = Join-Path $InstallDir 'frontend\.env.local'

function Write-EnvFile($examplePath, $targetPath) {
    if (-not (Test-Path $examplePath)) { Write-Warn "Template missing: $examplePath"; return }
    if (Test-Path $targetPath) {
        Write-Ok "Preserving existing $targetPath (not regenerated on update)"
        return
    }
    if (-not $ServerIp) {
        throw "No -ServerIp given and $targetPath does not exist. Provide -ServerIp on first install."
    }
    (Get-Content $examplePath -Raw).Replace('SERVER_IP', $ServerIp) |
        Set-Content -Path $targetPath -Encoding UTF8 -NoNewline
    Write-Ok "Wrote $targetPath (SERVER_IP -> $ServerIp)"
}
Write-EnvFile $rootExample $rootEnv
Write-EnvFile $feExample   $feEnv

# ── 4. Install dependencies ────────────────────────────────────
Write-Step 'Installing dependencies (root)'
Push-Location $InstallDir
& $npm install --omit=dev
Write-Ok 'Root dependencies installed'
Pop-Location

Write-Step 'Installing dependencies (frontend)'
Push-Location (Join-Path $InstallDir 'frontend')
& $npm install
Write-Ok 'Frontend dependencies installed'
Pop-Location

# ── 5. Apply database schema (idempotent) ──────────────────────
Write-Step 'Applying database schema'
$psql = Get-Command psql -ErrorAction SilentlyContinue
$schema = Join-Path $InstallDir 'scripts\schema.sql'
if ($psql -and (Test-Path $schema)) {
    & $psql.Source -U $PsqlUser -d $DbName -f $schema
    Write-Ok 'Schema applied'
} else {
    Write-Warn 'psql not found or schema.sql missing — apply scripts\schema.sql manually.'
}

# ── 6. Build frontend (NOT standalone) ─────────────────────────
Write-Step 'Building frontend'
Push-Location (Join-Path $InstallDir 'frontend')
& $npm run build
Write-Ok 'Frontend built'
Pop-Location

# ── 7. (Re)register and start NSSM services ────────────────────
Write-Step 'Registering services'
$nodeExe = (Get-Command node).Source
foreach ($svc in $Services) {
    $status = & $nssm status $svc.Name 2>$null
    if ($LASTEXITCODE -ne 0) {
        & $nssm install $svc.Name $nodeExe | Out-Null
        Write-Ok "Installed $($svc.Name)"
    }
    # (Re)apply configuration each run so changes propagate.
    & $nssm set $svc.Name Application       $nodeExe              | Out-Null
    & $nssm set $svc.Name AppDirectory      $svc.Dir             | Out-Null
    & $nssm set $svc.Name AppParameters     $svc.Args            | Out-Null
    & $nssm set $svc.Name AppStdout         (Join-Path $InstallDir "logs\$($svc.Name).log")     | Out-Null
    & $nssm set $svc.Name AppStderr         (Join-Path $InstallDir "logs\$($svc.Name).err.log") | Out-Null
    & $nssm set $svc.Name AppRotateFiles    1                    | Out-Null
    & $nssm set $svc.Name AppRotateBytes    10485760             | Out-Null
    & $nssm set $svc.Name Start             SERVICE_AUTO_START   | Out-Null
    & $nssm set $svc.Name AppExit Default   Restart              | Out-Null
}
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null

Write-Step 'Starting services'
foreach ($svc in $Services) {
    & $nssm start $svc.Name 2>$null | Out-Null
    Write-Ok "Started $($svc.Name)"
}

# ── 8. Health check ────────────────────────────────────────────
Write-Step 'Health check'
Start-Sleep -Seconds 5
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3009/api/health' -TimeoutSec 10
    if ($resp.status -eq 'ok') {
        Write-Ok "API healthy: $($resp.service) @ $($resp.time)"
    } else {
        Write-Warn "API responded but status was '$($resp.status)'"
    }
} catch {
    Write-Warn "API health check failed: $($_.Exception.Message)"
    Write-Warn "Check logs in $InstallDir\logs\"
}

Write-Host "`nSpanVault update complete." -ForegroundColor Green
Write-Host "  Frontend:  http://$($ServerIp):3008" -ForegroundColor Green
Write-Host "  API:       http://127.0.0.1:3009 (loopback only)" -ForegroundColor Green
