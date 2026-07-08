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
$AppRoot  = Join-Path $InstallDir 'app'
# Normalize the build directory to its true on-disk casing. `next build` caches absolute
# module paths in .next; if a later run's cwd casing differs (e.g. C:\Apps\SpanVault vs
# ...\spanvault, depending on how -InstallDir / the invocation path was typed), webpack
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

# ── Pre-flight ─────────────────────────────────────────────────
Write-Step 'Pre-flight checks'
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

# ── 2. Pull latest code ────────────────────────────────────────
Write-Step 'Pulling latest code'
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
    Write-Warn "git fetch/reset failed (fetch=$fetchExit reset=$resetExit) - the checkout may not have advanced. Verify the working tree manually."
}
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
Push-Location $AppRoot
# npm writes progress/warnings to stderr; consume both streams to avoid
# NativeCommandError over WinRM, and gate on $LASTEXITCODE for real failures.
$null = & $npm install --omit=dev 2>&1
if ($LASTEXITCODE -eq 0) { Write-Ok 'Root dependencies installed' }
else { Write-Warn "npm install (root) exited with code $LASTEXITCODE" }
Pop-Location

Write-Step 'Installing dependencies (frontend)'
Push-Location $Frontend
$null = & $npm install 2>&1
if ($LASTEXITCODE -eq 0) { Write-Ok 'Frontend dependencies installed' }
else { Write-Warn "npm install (frontend) exited with code $LASTEXITCODE" }
Pop-Location

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
    try { $null = & $psql --quiet -U $dbUser -d $dbName -f $schema 2>&1 } catch {}
    $psqlExit = $LASTEXITCODE
    $env:PGPASSWORD = ''
    # psql over WinRM commonly returns -1 on a successful run, so treat -1 as 0.
    if ($psqlExit -eq 0 -or $psqlExit -eq -1) { Write-Ok "Schema applied (as $dbUser)" }
    else { Write-Warn "psql exited with code $psqlExit - apply scripts\schema.sql manually." }
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
Push-Location $Frontend
$null = & $npm run build 2>&1
if ($LASTEXITCODE -eq 0) { Write-Ok 'Frontend built' }
else { Write-Warn "Frontend build exited with code $LASTEXITCODE - check the build output." }
Pop-Location

# ── 7. (Re)register and start NSSM services ────────────────────
Write-Step 'Registering services'
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
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null

Write-Step 'Starting services'
foreach ($svc in $Services) {
    $null = & $nssm start $svc.Name 2>&1
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
