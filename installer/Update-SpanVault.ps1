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
    Where SpanVault lives. Default: C:\Apps\SpanVault

.PARAMETER Branch
    Git branch to deploy. Default: main

.EXAMPLE
    .\Update-SpanVault.ps1 -ServerIp 10.20.30.40
#>

[CmdletBinding()]
param(
    [string]$ServerIp,
    [string]$InstallDir = 'C:\Apps\SpanVault',
    [string]$Branch     = 'main'
)

$ErrorActionPreference = 'Stop'

# The repo is cloned one level deeper than the install dir: the install dir
# ($InstallDir) holds top-level artifacts (logs, nssm), while the application
# code lives in the 'app' subfolder. All git/npm/build/file operations and the
# NSSM working directories target $AppRoot / $Frontend, not $InstallDir.
$AppRoot  = Join-Path $InstallDir 'app'
$Frontend = Join-Path $AppRoot 'frontend'

# ── Configuration ──────────────────────────────────────────────
$Services = @(
    @{ Name = 'SpanVault-API';       App = 'node'; Args = 'api\server.js';            Dir = $AppRoot },
    @{ Name = 'SpanVault-Collector'; App = 'node'; Args = 'collector\collector.js';   Dir = $AppRoot },
    @{ Name = 'SpanVault-App';       App = 'node'; Args = 'node_modules\next\dist\bin\next start -p 3008'; Dir = $Frontend }
)
function Write-Step($msg)  { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!]  $msg"   -ForegroundColor Yellow }

function Resolve-Tool($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "$name not found on PATH. $hint" }
    return $cmd.Source
}

# psql is often not on PATH on Windows. Resolve it like the other tools, but fall
# back to the standard PostgreSQL install locations (newest version first).
# Returns $null if not found — the schema step treats psql as optional.
function Resolve-Psql {
    $cmd = Get-Command psql -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $roots = @('C:\Program Files\PostgreSQL', 'C:\Program Files (x86)\PostgreSQL')
    $found = Get-ChildItem -Path $roots -Filter 'psql.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}

# ── Pre-flight ─────────────────────────────────────────────────
Write-Step 'Pre-flight checks'
$nssm = Resolve-Tool 'nssm' 'Install NSSM and add it to PATH.'
$git  = Resolve-Tool 'git'  'Install Git for Windows.'
$npm  = Resolve-Tool 'npm'  'Install Node.js (which provides npm).'
$psql = Resolve-Psql
Write-Ok "nssm: $nssm"
Write-Ok "git:  $git"
Write-Ok "npm:  $npm"
if ($psql) { Write-Ok "psql: $psql" } else { Write-Warn 'psql not found — schema apply will be skipped.' }

if (-not (Test-Path $AppRoot)) {
    throw "App directory '$AppRoot' does not exist. Clone the repo into '$AppRoot' first, then re-run."
}

# ── 1. Stop services ───────────────────────────────────────────
Write-Step 'Stopping services'
# nssm status writes "Can't open service!" to stderr for a non-existent service,
# which PowerShell turns into a terminating NativeCommandError even with
# 2>&1 | Out-Null under $ErrorActionPreference='Stop'. Use sc.exe query for the
# existence probe (it does not trip NativeCommandError) and relax error handling
# for the whole loop so any remaining native noise cannot terminate the script.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
foreach ($svc in $Services) {
    $scQuery = sc.exe query $svc.Name 2>&1
    if ($LASTEXITCODE -eq 0) {
        sc.exe stop $svc.Name | Out-Null
        Start-Sleep -Seconds 2
        Write-Ok "Stopped $($svc.Name)"
    } else {
        Write-Warn "$($svc.Name) not yet installed"
    }
}
$ErrorActionPreference = $prevEAP

# ── 2. Pull latest code ────────────────────────────────────────
Write-Step 'Pulling latest code'
Push-Location $AppRoot
& $git fetch --all --prune
& $git checkout $Branch
& $git pull origin $Branch
Write-Ok "On branch $Branch"
Pop-Location

# ── 3. Write .env.local from template (SERVER_IP substitution) ──
Write-Step 'Writing environment files'
$rootExample = Join-Path $AppRoot '.env.local.example'
$rootEnv     = Join-Path $AppRoot '.env.local'
$feExample   = Join-Path $Frontend '.env.local.example'
$feEnv       = Join-Path $Frontend '.env.local'

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
Push-Location $AppRoot
& $npm install --omit=dev
Write-Ok 'Root dependencies installed'
Pop-Location

Write-Step 'Installing dependencies (frontend)'
Push-Location $Frontend
& $npm install
Write-Ok 'Frontend dependencies installed'
Pop-Location

# ── 5. Apply database schema (idempotent) ──────────────────────
Write-Step 'Applying database schema'
$schema = Join-Path $AppRoot 'scripts\schema.sql'
if ($psql -and (Test-Path $schema)) {
    # Connect as spanvault_user (the DB owner) using the password from .env.local
    # so the apply runs unattended. Connecting as 'postgres' would prompt for a
    # password interactively and break the update.
    $envContent = Get-Content $rootEnv -Raw
    $dbPass = [regex]::Match($envContent, 'SV_DB_PASS=(.+)').Groups[1].Value.Trim()
    $dbUser = [regex]::Match($envContent, 'SV_DB_USER=(.+)').Groups[1].Value.Trim()
    $dbName = [regex]::Match($envContent, 'SV_DB_NAME=(.+)').Groups[1].Value.Trim()
    $env:PGPASSWORD = $dbPass
    & $psql -U $dbUser -d $dbName -f $schema
    $env:PGPASSWORD = ''
    Write-Ok "Schema applied (as $dbUser)"
} else {
    Write-Warn 'psql not found or schema.sql missing — apply scripts\schema.sql manually.'
}

# ── 6. Build frontend (NOT standalone) ─────────────────────────
Write-Step 'Building frontend'
Push-Location $Frontend
& $npm run build
Write-Ok 'Frontend built'
Pop-Location

# ── 7. (Re)register and start NSSM services ────────────────────
Write-Step 'Registering services'
$nodeExe = (Get-Command node).Source
foreach ($svc in $Services) {
    # Same guard as the stop section: probe existence with sc.exe query rather
    # than nssm status, which would raise NativeCommandError for a service that
    # does not exist yet on first install. Non-zero $LASTEXITCODE means "install it".
    sc.exe query $svc.Name 2>&1 | Out-Null
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
