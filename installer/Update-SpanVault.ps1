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
      6. Builds the frontend (next build - NOT standalone).
      7. (Re)registers the three NSSM services and starts them.
      8. Runs a health check against the API.

    Resilience: before touching anything, the script snapshots the current git
    commit plus root node_modules / frontend .next / frontend node_modules (via
    Rename-Item - a metadata-only operation regardless of directory size, so this
    is cheap). If any step from git-pull onward fails, it automatically reverts to
    that snapshot, restarts all 3 services, and re-verifies health before giving
    up, instead of leaving the app on broken/partial code. Every run (success or
    failure) writes a structured logs\last-update-status.json.

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

# The in-app updater launches this script as a SYSTEM scheduled task, and SYSTEM
# has a minimal PATH that does NOT include git/node/npm. Without this, the
# pre-flight tool checks below (Get-Command git/npm) fail under SYSTEM and the
# whole update aborts before anything runs. Prepend the standard install
# locations so the toolchain resolves under SYSTEM (mirrors Update-NetVault.ps1).
$env:PATH = @(
    "C:\Program Files\Git\cmd",
    "C:\Program Files\Git\bin",
    "C:\Program Files\nodejs",
    $env:PATH
) -join ";"

# Windows Task Scheduler's default task priority (level 7) maps to the BelowNormal
# process priority class, unlike a manually-run script (Normal). This starves the
# CPU-bound npm install/build under contention from the rest of the suite, making
# an in-app-triggered update (Settings -> Updates, which schedules this as a
# SYSTEM task) look "stuck" compared to the same update run manually from an
# interactive PowerShell window. Reset to Normal regardless of how this script was
# invoked - a no-op when already Normal (the manual-run case). Child processes
# inherit the parent's priority class by default, so this also covers the
# npm/node/next child processes it spawns. (Same fix as NetVault/DDIVault/LogVault.)
try {
    $proc = Get-Process -Id $PID
    if ($proc.PriorityClass -ne 'Normal') { $proc.PriorityClass = 'Normal' }
} catch { Write-Warning "Could not adjust process priority: $($_.Exception.Message)" }

# The in-app updater (Settings -> Updates) is fire-and-forget: it schedules this
# script as a SYSTEM task and immediately returns { started: true } to the
# browser, with no live output stream. Without a transcript, a run triggered
# that way leaves NO durable record of what happened — every Write-Host/
# Write-Step/Write-Warn line below is otherwise lost the moment the scheduled
# task's process exits, which is exactly the case that most needs diagnosing.
# Start it as early as possible (before pre-flight) so even a pre-flight
# failure is captured. Best-effort: a transcript that fails to start (e.g. one
# is already open in this session) must never block the actual update.
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null
$transcriptPath = Join-Path $InstallDir "logs\update-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
try { Start-Transcript -Path $transcriptPath -Append | Out-Null } catch { Write-Warning "Could not start transcript: $($_.Exception.Message)" }

# Give the API a moment to return its { started: true } response to the frontend
# before we start stopping services.
Write-Host "=== Update starting in 5 seconds ==="
Start-Sleep -Seconds 5

# FIREWALL NOTE: SpanVault agents connect outbound to port 3010.
# Ensure port 3010 is reachable from all agent servers to this host.
# Open inbound: netsh advfirewall firewall add rule name="SpanVault Agent WS"
#   protocol=TCP dir=in localport=3010 action=allow

# The repo is cloned one level deeper than the install dir: the install dir
# ($InstallDir) holds top-level artifacts (logs, nssm), while the application
# code lives in the 'app' subfolder. All git/npm/build/file operations and the
# NSSM working directories target $AppRoot / $Frontend, not $InstallDir.
#
# Self-locate $AppRoot instead of deriving it from -InstallDir. This script lives at
# <appRoot>\installer\Update-SpanVault.ps1, so the real app root is the PARENT of the
# script's own folder — correct on BOTH the suite install (C:\Apps\SpanVault\app) and a
# standalone install, regardless of what -InstallDir is (or isn't) passed. -InstallDir is
# kept for backward-compat (nssm resolution still falls back to it - see Resolve-Nssm
# below) but no longer drives the app/git/npm path. (Mirrors LogVault/DDIVault/NetVault's
# fix for this exact class of bug - see their installer/Update-*.ps1.)
# Resolve a path to its TRUE on-disk casing (walking each parent for the real component
# name). Get-Item().FullName only echoes the TYPED casing, which is not enough here.
function Get-TrueCasePath([string]$p) {
    try {
        $di = New-Object System.IO.DirectoryInfo([System.IO.Path]::GetFullPath($p))
        $parts = @()
        while ($null -ne $di.Parent) {
            $m = $di.Parent.GetFileSystemInfos($di.Name)
            if ($m.Count -eq 0) { return [System.IO.Path]::GetFullPath($p) }
            $parts = ,($m[0].Name) + $parts; $di = $di.Parent
        }
        $root = $di.Name; if (-not $root.EndsWith('\')) { $root += '\' }
        return $root + ($parts -join '\')
    } catch { return $p }
}
$AppRoot  = Split-Path -Parent $PSScriptRoot
# Normalize the build directory to its true on-disk casing. `next build` caches absolute
# module paths in .next; if a later run's cwd casing differs (e.g. C:\Apps\SpanVault vs
# ...\spanvault, depending on how the invocation path was typed), webpack
# treats the two casings as different modules and loads React twice -> the build crashes
# with "Cannot read properties of null (reading 'useContext')". Pin to on-disk casing.
$AppRoot  = Get-TrueCasePath $AppRoot
$Frontend = Join-Path $AppRoot 'frontend'

# ── Configuration ──────────────────────────────────────────────
# Note: SpanVault-API also starts a WebSocket server on SV_WS_PORT (default 3010)
# for distributed polling agents. Ensure port 3010 is reachable from agent servers
# (the loopback-only API on 3009 is NOT used by agents - they reach it through the
# frontend proxy on 3008 for file downloads, and 3010 directly for the WS link).
$Services = @(
    @{ Name = 'SpanVault-API';       App = 'node'; Args = 'api\server.js';            Dir = $AppRoot },
    @{ Name = 'SpanVault-Collector'; App = 'node'; Args = 'collector\collector.js';   Dir = $AppRoot },
    @{ Name = 'SpanVault-App';       App = 'node'; Args = 'node_modules\next\dist\bin\next start -p 3008'; Dir = $Frontend }
)
function Write-Step($msg)  { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!]  $msg"   -ForegroundColor Yellow }

function Get-ServiceStatus($name) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) { return "NOT_FOUND" }
    return $svc.Status.ToString().ToUpper()
}

function Resolve-Tool($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "$name not found on PATH. $hint" }
    return $cmd.Source
}

# psql is often not on PATH on Windows. Resolve it like the other tools, but fall
# back to the standard PostgreSQL install locations (newest version first).
# Returns $null if not found - the schema step treats psql as optional.
function Resolve-Psql {
    $cmd = Get-Command psql -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $roots = @('C:\Program Files\PostgreSQL', 'C:\Program Files (x86)\PostgreSQL')
    $found = Get-ChildItem -Path $roots -Filter 'psql.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}

# nssm is NOT on the SYSTEM PATH (it lives at a full path under the install dir),
# so resolving it via Get-Command/PATH aborts the SYSTEM-scheduled update on the
# first pre-flight line. Resolve it by FULL PATH instead, in priority order:
#   1. SV_NSSM_PATH from the root .env.local (written by the suite installer)
#   2. this app's bundled nssm  ($InstallDir\nssm\nssm-2.24\win64\nssm.exe)
#   3. NetVault's bundled nssm  (C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe)
# Returns the first that exists on disk; throws only if none are found.
function Resolve-Nssm($installDir, $appRoot) {
    $candidates = @()
    $envFile = Join-Path $appRoot '.env.local'
    if (Test-Path $envFile) {
        $svNssm = (Get-Content $envFile | Where-Object { $_ -match '^\s*SV_NSSM_PATH\s*=' } | Select-Object -First 1)
        if ($svNssm) {
            $val = ($svNssm -replace '^\s*SV_NSSM_PATH\s*=', '').Trim().Trim('"')
            if ($val) { $candidates += $val }
        }
    }
    $candidates += (Join-Path $installDir 'nssm\nssm-2.24\win64\nssm.exe')
    $candidates += 'C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe'
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    throw "nssm.exe not found. Tried SV_NSSM_PATH in .env.local, '$installDir\nssm\nssm-2.24\win64\nssm.exe', and 'C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe'. Install NSSM or set SV_NSSM_PATH."
}

# --- Resilience: rollback + structured status reporting -------------------
# SpanVault has no `output: 'standalone'` build - SpanVault-App runs `next start`
# directly against a plain `frontend\.next`, sharing the app's normal node_modules
# (root for the API/Collector, `frontend\node_modules` for the Next.js app). A
# rollback here has to protect THREE things: the git source, root node_modules
# (the API/Collector are plain JS with no build step - a broken npm install can
# break them directly), and both `frontend\.next` and `frontend\node_modules` (the
# Next.js build output + its deps). Renaming is a metadata-only operation on the
# same NTFS volume regardless of directory size, so snapshotting all three this way
# is cheap. (Same shape as DDIVault/LogVault's equivalent - the closest structural
# match in the suite, since SpanVault is also a non-standalone Next.js build.)
#
# Unlike DDIVault/LogVault, this script does NOT need to back up/restore
# .env.local for rollback: Write-EnvFile (below) never regenerates .env.local if
# it already exists, and `git clean` explicitly excludes it - so it's never
# mutated by a normal update run in the first place.
$StatusPath      = Join-Path $InstallDir "logs\last-update-status.json"
$prevCommit      = $null
$attemptedCommit = $null
$currentStage    = 'init'

$StageCodes = @{
    'init'                 = 5
    'pre-flight'           = 10
    'git-pull'             = 20
    'schema-apply'         = 25
    'npm-install-root'     = 30
    'npm-install-frontend' = 35
    'npm-build'            = 40
    'service-start'        = 50
    'health-check'         = 60
    'rollback-failed'      = 70
}

function Write-StatusJson {
    param(
        [bool]$Success,
        [string]$Stage,
        [int]$ErrorCode = 0,
        [string]$ErrorMessage = $null,
        [bool]$RolledBack = $false,
        [bool]$HealthCheckPassed = $false
    )
    $status = [ordered]@{
        timestamp         = (Get-Date).ToString('o')
        success           = $Success
        stage             = $Stage
        errorCode         = $ErrorCode
        errorMessage      = $ErrorMessage
        previousCommit    = $prevCommit
        attemptedCommit   = $attemptedCommit
        finalCommit       = if ($RolledBack) { $prevCommit } else { $attemptedCommit }
        rolledBack        = $RolledBack
        healthCheckPassed = $HealthCheckPassed
    }
    try {
        $json = $status | ConvertTo-Json
        # Write via .NET directly with a BOM-less UTF8Encoding, not Out-File
        # -Encoding UTF8 (which writes a UTF-8 BOM in Windows PowerShell 5.1) -
        # Node's fs.readFileSync(path, 'utf8') doesn't strip a BOM, which would
        # break JSON.parse on every single write. (Same bug found and fixed in
        # NetVault's Update-NetVault.ps1 1.23.27 - fixed here from the start.)
        [System.IO.File]::WriteAllText($StatusPath, $json, (New-Object System.Text.UTF8Encoding $false))
    } catch {
        Write-Warn "Could not write status file $StatusPath - $($_.Exception.Message)"
    }
}

# Poll the API's /api/health until it reports ok, or $TimeoutSec elapses.
function Wait-Healthy([int]$TimeoutSec = 60) {
    Write-Host "  Waiting for SpanVault API to respond on :3009 " -ForegroundColor Gray -NoNewline
    $healthy = $false
    for ($i = 0; $i -lt $TimeoutSec; $i++) {
        try {
            $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3009/api/health' -TimeoutSec 2 -ErrorAction Stop
            if ($resp.status -eq 'ok') { $healthy = $true; break }
        } catch {}
        Write-Host "." -ForegroundColor DarkGray -NoNewline
        Start-Sleep -Seconds 1
    }
    Write-Host ""
    return $healthy
}

# Revert to the pre-update commit + restore the node_modules/.next snapshots,
# restart all 3 services (same order the main script already starts them in: API,
# Collector, App), and confirm the OLD version is actually healthy before
# declaring the rollback itself successful.
#
# Note on database migrations: this rolls back CODE, not schema. STEP 5 below
# still refuses to deploy new code against a database it failed to migrate (a
# schema migration is not something a code-level rollback can undo, and
# scripts/schema.sql is not applied inside a single transaction) - but a schema
# failure now triggers this same rollback instead of leaving the app down
# entirely, since the old code is far more likely to tolerate a few extra/partial
# columns than SpanVault is to tolerate being completely offline (same reasoning
# DDIVault/LogVault use for their own schema-apply step).
function Invoke-Rollback([string]$Reason) {
    Write-Host ""
    Write-Step "ROLLING BACK - reason: $Reason"
    $ok = $true
    try {
        # Stop services BEFORE touching node_modules/.next below. STEP 7 already
        # started all 3 services by the time a failure can trigger this function,
        # so without this, the restore's Remove-Item/Rename-Item would be mutating
        # a directory tree while SpanVault-API/-Collector are still live and
        # actively require()-ing from it - a real race that produced exactly this
        # symptom in production (LogVault's identical bug): the restore reported
        # success, but the resulting node_modules ended up with only a handful of
        # packages, and the Collector crash-looped on a missing module. Mirrors
        # the safe order the main update flow already uses (STEP 1 stops services
        # before STEP 4/6 ever touch node_modules/.next).
        Write-Step "Stopping services before restoring last known-good version"
        foreach ($svc in $Services) {
            $null = & sc.exe query $svc.Name 2>&1
            if ($LASTEXITCODE -eq 0) { $null = & sc.exe stop $svc.Name 2>&1 }
        }
        Start-Sleep -Seconds 3

        Push-Location $AppRoot
        if ($prevCommit) {
            Write-Host "  Reverting source to $prevCommit" -ForegroundColor Gray
            $null = & $git reset --hard $prevCommit 2>&1
            if ($LASTEXITCODE -eq 0) { Write-Ok "Source reverted" } else { Write-Warn "git reset during rollback failed (exit $LASTEXITCODE)"; $ok = $false }
        } else {
            Write-Warn "No pre-update commit recorded - skipping source revert"
        }
        Pop-Location

        $rootModulesBackup     = Join-Path $AppRoot 'node_modules.lastgood'
        $frontendNextBackup    = Join-Path $Frontend '.next.lastgood'
        $frontendModulesBackup = Join-Path $Frontend 'node_modules.lastgood'

        if (Test-Path $rootModulesBackup) {
            $target = Join-Path $AppRoot 'node_modules'
            if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -Path $rootModulesBackup -NewName 'node_modules' -ErrorAction Stop
            Write-Ok "Restored root node_modules"
        } else {
            Write-Warn "No root node_modules snapshot found to restore"
        }
        if (Test-Path $frontendNextBackup) {
            $target = Join-Path $Frontend '.next'
            if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -Path $frontendNextBackup -NewName '.next' -ErrorAction Stop
            Write-Ok "Restored frontend .next build output"
        } else {
            Write-Warn "No frontend .next snapshot found to restore"
            $ok = $false
        }
        if (Test-Path $frontendModulesBackup) {
            $target = Join-Path $Frontend 'node_modules'
            if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
            Rename-Item -Path $frontendModulesBackup -NewName 'node_modules' -ErrorAction Stop
            Write-Ok "Restored frontend node_modules"
        } else {
            Write-Warn "No frontend node_modules snapshot found to restore"
            $ok = $false
        }

        Write-Step "Restarting services on last known-good version"
        foreach ($svc in $Services) {
            $null = & $nssm start $svc.Name 2>&1
        }
        Start-Sleep -Seconds 3

        # Informational only - SCM's STARTPENDING -> RUNNING transition can lag
        # several seconds behind the process actually serving traffic (confirmed
        # live in LogVault's identical rollback code: "Rollback verified...
        # healthy" printed immediately followed by "ROLLBACK ALSO FAILED", from
        # this exact check alone overriding a passing health check). Poll briefly
        # for a clean status line, but only $healthy below decides the return value.
        foreach ($svc in $Services) {
            $status = 'UNKNOWN'
            for ($i = 0; $i -lt 30; $i++) {
                $status = Get-ServiceStatus $svc.Name
                if ($status -eq "RUNNING") { break }
                Start-Sleep -Seconds 1
            }
            if ($status -ne "RUNNING") { Write-Warn "$($svc.Name) - $status (SCM status can lag - health check below is authoritative)" }
        }

        $healthy = Wait-Healthy -TimeoutSec 30
        if ($healthy) { Write-Ok "Rollback verified - last known-good version is up and healthy" }
        else { Write-Warn "Rollback restart did not pass the health check"; $ok = $false }
        return ($ok -and $healthy)
    } catch {
        Write-Warn "Rollback itself failed: $($_.Exception.Message)"
        return $false
    }
}

# Every failure path in this script funnels through here instead of just
# Write-Warn-and-continue, so a failure always attempts recovery and always
# leaves a structured record behind - see the resilience block above.
function Fail-Update {
    param([string]$Stage, [string]$Message)
    $code = if ($StageCodes.ContainsKey($Stage)) { $StageCodes[$Stage] } else { 99 }
    Write-Host ""
    Write-Warn "Update failed at stage '$Stage': $Message"
    $rollbackOk = Invoke-Rollback -Reason $Message
    if (-not $rollbackOk) {
        Write-Warn "!!! ROLLBACK ALSO FAILED - SpanVault may be DOWN. Manual intervention required. !!!"
        $code = $StageCodes['rollback-failed']
    }
    Write-StatusJson -Success $false -Stage $Stage -ErrorCode $code -ErrorMessage $Message -RolledBack $rollbackOk -HealthCheckPassed $rollbackOk
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
}

# ── Pre-flight ─────────────────────────────────────────────────
Write-Step 'Pre-flight checks'
$currentStage = 'pre-flight'
# nssm is resolved by FULL PATH (not via PATH) — see Resolve-Nssm above.
$nssm = Resolve-Nssm $InstallDir $AppRoot
# git/npm resolve via PATH, which we prepended with Git/Node locations at the top
# of the script, so they are found even under the SYSTEM scheduled task.
$git  = Resolve-Tool 'git'  'Install Git for Windows.'
$npm  = Resolve-Tool 'npm'  'Install Node.js (which provides npm).'
$psql = Resolve-Psql
Write-Ok "nssm: $nssm"
Write-Ok "git:  $git"
Write-Ok "npm:  $npm"
if ($psql) { Write-Ok "psql: $psql" } else { Write-Warn 'psql not found - schema apply will be skipped.' }

if (-not (Test-Path $AppRoot)) {
    throw "App directory '$AppRoot' does not exist. Clone the repo into '$AppRoot' first, then re-run."
}

# From here on every step shells out to native tools (git, npm, nssm, psql) that
# write progress/notices to stderr. Under Windows PowerShell 5.1 over WinRM, a
# native command's stderr is wrapped as an ErrorRecord and, with
# $ErrorActionPreference = 'Stop', terminates the whole script even on a
# successful (exit 0) run -- this is what aborted 'npm install' at the harmless
# "npm notice" line. Switch to 'Continue' so stderr chatter is non-fatal; each
# step is already gated on $LASTEXITCODE / Write-Warn, and the hard preconditions
# above use explicit `throw` (which terminates regardless of this setting).
$ErrorActionPreference = 'Continue'

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
    $null = & sc.exe query $svc.Name 2>&1
    if ($LASTEXITCODE -eq 0) {
        $null = & sc.exe stop $svc.Name 2>&1
        Start-Sleep -Seconds 2
        Write-Ok "Stopped $($svc.Name)"
    } else {
        Write-Warn "$($svc.Name) not yet installed"
    }
}
$ErrorActionPreference = $prevEAP

# ── 1.5. Snapshot current version for rollback ─────────────────
# Must happen BEFORE git touches anything and BEFORE npm install/build overwrites
# node_modules/.next, so a failure anywhere from here on can be undone by putting
# these exact folders back rather than needing to rebuild (which could itself
# fail for the same reason the original update did).
Write-Step 'Snapshotting current version for rollback'
Push-Location $AppRoot
$rp = & $git rev-parse HEAD 2>&1
if ($rp -match '^[0-9a-f]{40}$') { $prevCommit = $rp }
Pop-Location
if ($prevCommit) { Write-Ok "Current commit: $prevCommit" }
else { Write-Warn "Could not determine current commit - rollback will not be able to revert source" }

$rootModulesBackup     = Join-Path $AppRoot 'node_modules.lastgood'
$frontendNextBackup    = Join-Path $Frontend '.next.lastgood'
$frontendModulesBackup = Join-Path $Frontend 'node_modules.lastgood'
# Clear any stale backups left by a prior interrupted run before snapshotting the
# CURRENTLY-serving version, not an older leftover one.
foreach ($stale in @($rootModulesBackup, $frontendNextBackup, $frontendModulesBackup)) {
    if (Test-Path $stale) { Remove-Item $stale -Recurse -Force -ErrorAction SilentlyContinue }
}
$rootModulesPath = Join-Path $AppRoot 'node_modules'
if (Test-Path $rootModulesPath) {
    Rename-Item -Path $rootModulesPath -NewName 'node_modules.lastgood' -ErrorAction SilentlyContinue
    Write-Ok "Snapshotted root node_modules"
}
$frontendNextPath = Join-Path $Frontend '.next'
if (Test-Path $frontendNextPath) {
    Rename-Item -Path $frontendNextPath -NewName '.next.lastgood' -ErrorAction SilentlyContinue
    Write-Ok "Snapshotted frontend .next build output"
}
$frontendModulesPath = Join-Path $Frontend 'node_modules'
if (Test-Path $frontendModulesPath) {
    Rename-Item -Path $frontendModulesPath -NewName 'node_modules.lastgood' -ErrorAction SilentlyContinue
    Write-Ok "Snapshotted frontend node_modules"
}

# ── 2. Pull latest code ────────────────────────────────────────
Write-Step 'Pulling latest code'
$currentStage = 'git-pull'
Push-Location $AppRoot
# git writes informational messages ("Already on 'main'", "Your branch is
# up to date", fetch progress) to stderr. Over a remote PowerShell (WinRM)
# session, stderr from a native command ALWAYS raises NativeCommandError -
# a plain 2>&1 redirect is not enough because the merged error records still
# surface. Assign every git invocation to $null (which fully consumes both
# streams) and gate success on $LASTEXITCODE instead of trusting stderr.
# Deploy with fetch + HARD RESET, never 'git pull'. A 'git pull' merge is
# refused whenever the working tree is dirty - and 'npm install' rewrites the
# tracked package-lock.json on every update, so from the second update onward a
# pull would silently fail to fast-forward and the checkout would stay frozen at
# an old commit (the in-app updater then perpetually reports "update available").
# 'git reset --hard origin/$Branch' force-advances HEAD regardless of local
# changes; 'git clean -fd' drops untracked cruft while preserving env files and
# node_modules. This mirrors the DDIVault / LogVault / NetVault update scripts.
# SYSTEM has never run git in this repo before (only whichever interactive
# account originally cloned it has), and Git >= 2.35.2 (CVE-2022-24765)
# refuses to operate in a repo it doesn't consider "owned" by the current
# account: "fatal: detected dubious ownership in repository at '...'". Register
# this repo as safe for whichever account is running right now (idempotent —
# safe to add the same path twice) so this class of failure can't happen at all.
try { $null = & $git config --global --add safe.directory $AppRoot 2>&1 } catch {}

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$null = & $git fetch origin 2>&1
$fetchExit = $LASTEXITCODE
$null = & $git reset --hard "origin/$Branch" 2>&1
$resetExit = $LASTEXITCODE
$null = & $git clean -fd --exclude=".env.local" --exclude="node_modules" 2>&1
$null = & $git status 2>&1
$ErrorActionPreference = $prevEAP
if ($fetchExit -eq 0 -and $resetExit -eq 0) {
    Write-Ok "Reset to origin/$Branch"
} else {
    Pop-Location
    Fail-Update -Stage 'git-pull' -Message "git fetch/reset failed (fetch=$fetchExit reset=$resetExit)"
}
$rp = & $git rev-parse HEAD 2>&1
if ($rp -match '^[0-9a-f]{40}$') { $attemptedCommit = $rp }
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
    (Get-Content $examplePath -Raw).Replace('SERVER_IP:', ($ServerIp + ':')) |
        Set-Content -Path $targetPath -Encoding UTF8 -NoNewline
    Write-Ok "Wrote $targetPath (SERVER_IP -> $ServerIp)"
}
Write-EnvFile $rootExample $rootEnv
Write-EnvFile $feExample   $feEnv

# ── Ensure SERVER_IP is recorded in the root .env.local ─────────
# The in-app updater (Settings -> Updates) reads SERVER_IP via dotenv to re-run
# this installer. Set it from -ServerIp, replacing the template placeholder or
# appending it when missing. A real existing value is left untouched. This runs
# even on updates (where .env.local is preserved) so existing installs get it.
if ((Test-Path $rootEnv) -and $ServerIp) {
    $envText = Get-Content $rootEnv -Raw
    if ($envText -match '(?m)^\s*SERVER_IP\s*=\s*(your_server_ip\s*)?$') {
        # Empty or template-placeholder value → set the real one.
        $envText = $envText -replace '(?m)^\s*SERVER_IP\s*=.*$', "SERVER_IP=$ServerIp"
        Set-Content -Path $rootEnv -Value $envText -Encoding UTF8 -NoNewline
        Write-Ok "Set SERVER_IP=$ServerIp in $rootEnv"
    } elseif ($envText -notmatch '(?m)^\s*SERVER_IP\s*=') {
        Add-Content -Path $rootEnv -Value "SERVER_IP=$ServerIp"
        Write-Ok "Added SERVER_IP=$ServerIp to $rootEnv"
    } else {
        Write-Ok "Preserving existing SERVER_IP in $rootEnv"
    }
}

# ── 4. Install dependencies ────────────────────────────────────
Write-Step 'Installing dependencies (root)'
$currentStage = 'npm-install-root'
Push-Location $AppRoot
# npm writes progress/warnings to stderr; consume both streams to avoid
# NativeCommandError over WinRM, and gate on $LASTEXITCODE for real failures.
$null = & $npm install --omit=dev 2>&1
$rootInstallExit = $LASTEXITCODE
Pop-Location
if ($rootInstallExit -eq 0) {
    Write-Ok 'Root dependencies installed'
} else {
    # Previously this only warned and kept going, deploying the API/Collector
    # against a possibly-broken root node_modules. Root deps failing to install
    # is exactly the class of failure the rollback exists for.
    Fail-Update -Stage 'npm-install-root' -Message "npm install (root) failed (exit $rootInstallExit)"
}

Write-Step 'Installing dependencies (frontend)'
$currentStage = 'npm-install-frontend'
Push-Location $Frontend
$null = & $npm install 2>&1
$feInstallExit = $LASTEXITCODE
Pop-Location
if ($feInstallExit -eq 0) {
    Write-Ok 'Frontend dependencies installed'
} else {
    Fail-Update -Stage 'npm-install-frontend' -Message "npm install (frontend) failed (exit $feInstallExit)"
}

# ── 4b. Reassign public-object ownership to spanvault_user ─────
# Self-heal for fresh installs: the DB is created OWNER spanvault_user but its
# schema is first applied as the postgres superuser, so the tables/sequences/
# views/functions end up owned by postgres. Both THIS updater's schema-apply
# (step 5, as spanvault_user) AND the API's boot-time applySchema() (also as
# spanvault_user) then fail on the first ALTER with "must be owner of table
# monitored_devices", aborting the self-migration silently. Reassign every public
# object to spanvault_user ONCE here, as the postgres superuser, using
# POSTGRES_PASSWORD from the root .env.local (written by the suite installer).
# Idempotent, non-fatal, and a soft-skip (warning only) when the password is
# absent (pre-existing installs) - we never invent a password.
Write-Step 'Reassigning table ownership (idempotent)'
$ownEnvContent  = if (Test-Path $rootEnv) { Get-Content $rootEnv -Raw } else { '' }
$pgPwReassign   = [regex]::Match($ownEnvContent, 'POSTGRES_PASSWORD=(.+)').Groups[1].Value.Trim()
$svDbNameOwn    = [regex]::Match($ownEnvContent, 'SV_DB_NAME=(.+)').Groups[1].Value.Trim()
if (-not $svDbNameOwn) { $svDbNameOwn = 'spanvault' }
if ($psql -and $pgPwReassign) {
    $reassign = @'
DO $$
DECLARE r RECORD;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'spanvault_user') THEN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO spanvault_user', r.tablename);
    END LOOP;
    FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' LOOP
      EXECUTE format('ALTER SEQUENCE public.%I OWNER TO spanvault_user', r.sequencename);
    END LOOP;
    FOR r IN SELECT viewname FROM pg_views WHERE schemaname='public' LOOP
      EXECUTE format('ALTER VIEW public.%I OWNER TO spanvault_user', r.viewname);
    END LOOP;
    FOR r IN SELECT p.proname AS nm, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') LOOP
      EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO spanvault_user', r.nm, r.args);
    END LOOP;
    GRANT CREATE ON SCHEMA public TO spanvault_user;
  END IF;
END
$$;
'@
    # Connect as the postgres superuser (only it can reassign objects it owns) and
    # feed the SQL on stdin (-f -). --quiet suppresses NOTICE chatter that would
    # raise NativeCommandError over WinRM; consume both streams, gate on exit code.
    $env:PGPASSWORD = $pgPwReassign
    try { $null = $reassign | & $psql --quiet -U postgres -h localhost -p 5432 -d $svDbNameOwn -f - 2>&1 } catch {}
    $reassignExit = $LASTEXITCODE
    $env:PGPASSWORD = ''
    # As with the schema apply, psql over WinRM may return -1 on success.
    if ($reassignExit -eq 0 -or $reassignExit -eq -1) {
        Write-Ok "Reassigned public objects to spanvault_user (in $svDbNameOwn)"
    } else {
        Write-Warn "ownership reassign exited with code $reassignExit - if the schema self-migration fails, run it manually as postgres."
    }
} elseif (-not $psql) {
    Write-Warn 'psql not found - skipping ownership reassign.'
} else {
    Write-Warn 'POSTGRES_PASSWORD not in .env.local - skipping ownership reassign.'
}

# ── 5. Apply database schema (idempotent) ──────────────────────
Write-Step 'Applying database schema'
$currentStage = 'schema-apply'
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
    # --quiet suppresses NOTICE/INFO chatter that psql writes to stderr (which
    # would otherwise raise NativeCommandError over WinRM); consume both streams
    # and gate success on $LASTEXITCODE.
    # -v ON_ERROR_STOP=1 (added 2026-07-23): without it, psql prints a genuine
    # SQL error (e.g. a typo'd column in a REVOKE/GRANT block) to stderr and
    # keeps going, then still exits 0 - so this step would report "[OK] Schema
    # applied" while a security-relevant grant silently never took effect. This
    # is the exact failure mode that bit NetVault's own equivalent fix the same
    # day this was added (see that repo's Install-NocVault-Suite.ps1 comment).
    # schema.sql's own idempotent statements (IF NOT EXISTS/IF EXISTS/OR
    # REPLACE/ON CONFLICT) are not errors on a re-apply, so this does not
    # affect them - only a genuine SQL error now surfaces as a real failure.
    try { $null = & $psql --quiet -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -f $schema 2>&1 } catch {}
    $psqlExit = $LASTEXITCODE
    $env:PGPASSWORD = ''
    # psql over WinRM commonly returns -1 on a successful run, so treat -1 as 0.
    if ($psqlExit -eq 0 -or $psqlExit -eq -1) {
        Write-Ok "Schema applied (as $dbUser)"
    } else {
        # Still refuse to deploy new code against a database it failed to migrate
        # (ON_ERROR_STOP=1 halted it partway through) - but recover the SERVICE
        # instead of leaving SpanVault down entirely. This rolls back CODE only;
        # the database itself is left in whatever partial state the failed
        # statement produced (schema.sql is not applied inside one transaction,
        # so a code-level rollback cannot undo that part).
        Fail-Update -Stage 'schema-apply' -Message "psql exited with code $psqlExit applying scripts\schema.sql as $dbUser - re-run manually and fix the reported statement before assuming the schema is current"
    }
} else {
    Write-Warn 'psql not found or schema.sql missing - apply scripts\schema.sql manually.'
}

# ── 5b. Grant spanvault_user read access to the netvault DB ─────
# Only on first install (-ServerIp given). SpanVault reads the netvault DB for
# SSO auth (users/user_sites), device import (devices/device_types/sites) and
# RBAC site filtering. The grants must run as a superuser/owner, so connect as
# 'postgres' against the netvault database (NOT spanvault). Idempotent + wrapped
# in try/catch so re-running (or pre-existing grants) never fails the install.
if ($ServerIp) {
    if ($psql) {
        # Read the env file directly - the schema block's $envContent may be
        # unset (e.g. schema.sql missing), so don't depend on it here.
        $nvEnvContent = if (Test-Path $rootEnv) { Get-Content $rootEnv -Raw } else { '' }
        $nvName = [regex]::Match($nvEnvContent, 'NETVAULT_DB_NAME=(.+)').Groups[1].Value.Trim()
        $svUser = [regex]::Match($nvEnvContent, 'SV_DB_USER=(.+)').Groups[1].Value.Trim()
        $pgPass = [regex]::Match($nvEnvContent, 'POSTGRES_PASSWORD=(.+)').Groups[1].Value.Trim()
        if (-not $nvName) { $nvName = 'netvault' }
        if (-not $svUser) { $svUser = 'spanvault_user' }
        $grantSql = "GRANT CONNECT ON DATABASE $nvName TO $svUser; " +
                    "GRANT USAGE ON SCHEMA public TO $svUser; " +
                    "GRANT SELECT ON users, user_sites, sites, devices, device_types TO $svUser;"
        # Connect as the postgres superuser using POSTGRES_PASSWORD from .env.local
        # so the grant runs unattended (no interactive password prompt). Failure is
        # non-fatal.
        if ($pgPass) { $env:PGPASSWORD = $pgPass }
        try { $null = & $psql --quiet -U postgres -d $nvName -c $grantSql 2>&1 } catch {}
        $grantExit = $LASTEXITCODE
        $env:PGPASSWORD = ''
        # As with the schema apply, psql over WinRM may return -1 on success.
        if ($grantExit -eq 0 -or $grantExit -eq -1) {
            Write-Ok "Granted $svUser read access to the $nvName database"
        } else {
            Write-Warn "netvault grants exited with code $grantExit - run them manually as postgres:"
            Write-Warn "  psql -U postgres -d $nvName -c `"$grantSql`""
        }
    } else {
        Write-Warn 'psql not found - grant spanvault_user read access to netvault manually.'
    }
}

# ── 6. Build frontend (NOT standalone) ─────────────────────────
Write-Step 'Building frontend'
$currentStage = 'npm-build'
Push-Location $Frontend
$null = & $npm run build 2>&1
$buildExit = $LASTEXITCODE
Pop-Location
if ($buildExit -eq 0) {
    Write-Ok 'Frontend built'
} else {
    # Previously this warned and kept going into service (re)registration/start
    # against a broken or missing .next - Fail-Update now actually restores the
    # last-known-good build output and restarts services on it.
    Fail-Update -Stage 'npm-build' -Message "Frontend build failed (exit $buildExit)"
}

# ── 7. (Re)register and start NSSM services ────────────────────
Write-Step 'Registering services'
$currentStage = 'service-start'
$nodeExe = (Get-Command node).Source
foreach ($svc in $Services) {
    # Same guard as the stop section: probe existence with sc.exe query rather
    # than nssm status, which would raise NativeCommandError for a service that
    # does not exist yet on first install. Non-zero $LASTEXITCODE means "install it".
    $null = & sc.exe query $svc.Name 2>&1
    if ($LASTEXITCODE -ne 0) {
        $null = & $nssm install $svc.Name $nodeExe 2>&1
        Write-Ok "Installed $($svc.Name)"
    }
    # (Re)apply configuration each run so changes propagate.
    $null = & $nssm set $svc.Name Application       $nodeExe              2>&1
    $null = & $nssm set $svc.Name AppDirectory      $svc.Dir             2>&1
    $null = & $nssm set $svc.Name AppParameters     $svc.Args            2>&1
    $null = & $nssm set $svc.Name AppStdout         (Join-Path $InstallDir "logs\$($svc.Name).log")     2>&1
    $null = & $nssm set $svc.Name AppStderr         (Join-Path $InstallDir "logs\$($svc.Name).err.log") 2>&1
    $null = & $nssm set $svc.Name AppRotateFiles    1                    2>&1
    $null = & $nssm set $svc.Name AppRotateBytes    10485760             2>&1
    $null = & $nssm set $svc.Name Start             SERVICE_AUTO_START   2>&1
    $null = & $nssm set $svc.Name AppExit Default   Restart              2>&1
}
# logs\ is already created near the top of the script (transcript setup) —
# no need to re-create it here.

Write-Step 'Starting services'
foreach ($svc in $Services) {
    $null = & $nssm start $svc.Name 2>&1
    Write-Ok "Started $($svc.Name)"
}

# ── 8. Health check (now a mandatory gate, not advisory) ───────
Write-Step 'Health check'
$currentStage = 'health-check'
Start-Sleep -Seconds 5
# Mandatory final health check (matches NetVault/DDIVault/LogVault's resilience
# upgrade): a service that "started" per NSSM is not proof the app is actually
# serving traffic - poll /api/health with retries instead of a single best-effort
# attempt, and treat a failure here the same as any other stage failure (triggers
# a rollback) rather than just printing a warning and reporting success anyway.
$healthy = Wait-Healthy -TimeoutSec 60
if ($healthy) {
    Write-Ok "API health check passed"
} else {
    Fail-Update -Stage 'health-check' -Message "API did not answer /api/health within 60s of starting - service may be crash-looping or stuck"
}

# Update succeeded and is confirmed healthy - the pre-update snapshots are no
# longer needed. Remove them so they don't accumulate across updates or get
# mistaken for a stale rollback target on the next run.
foreach ($snap in @($rootModulesBackup, $frontendNextBackup, $frontendModulesBackup)) {
    if (Test-Path $snap) { Remove-Item $snap -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-StatusJson -Success $true -Stage $null -ErrorCode 0 -RolledBack $false -HealthCheckPassed $true

# Prefer the actually-configured SERVER_IP from .env.local over the -ServerIp param —
# now that self-location means -ServerIp is routinely omitted on a routine update, this
# summary line used to print a blank "http://:3008" instead of the real address.
$displayIp = $ServerIp
if (-not $displayIp -and (Test-Path $rootEnv)) {
    $m = Select-String -Path $rootEnv -Pattern '^\s*SERVER_IP\s*=\s*(.+?)\s*$' | Select-Object -First 1
    if ($m) { $displayIp = $m.Matches[0].Groups[1].Value }
}
if (-not $displayIp) { $displayIp = 'localhost' }
Write-Host "`nSpanVault update complete." -ForegroundColor Green
Write-Host "  Frontend:  http://$($displayIp):3008" -ForegroundColor Green
Write-Host "  API:       http://127.0.0.1:3009 (loopback only)" -ForegroundColor Green

# Best-effort — if Start-Transcript never succeeded (see top of script), this
# throws harmlessly; never let it mask the update's own success/failure.
try { Stop-Transcript | Out-Null } catch {}
