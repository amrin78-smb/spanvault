<#
.SYNOPSIS
    Installs the SpanVault Agent as a Windows service on a remote server.

.DESCRIPTION
    Preflight-checks connectivity to the SpanVault server, downloads the agent
    files, writes config.json, installs Node.js + dependencies, ensures NSSM is
    available (auto-downloads it if missing), registers the SpanVault-Agent
    service, starts it, and verifies it came up. Run on the remote (polling)
    server in an elevated PowerShell.

.PARAMETER ServerUrl
    Base URL of the SpanVault server (the frontend, which proxies /api/*),
    e.g. http://<server>:3008

.PARAMETER ApiKey
    The agent's API key (generated when the agent was created in the UI).

.PARAMETER WsPort
    WebSocket port the agent connects to (default 3010).

.EXAMPLE
    & ([scriptblock]::Create((irm http://<server>:3008/api/agent/install.ps1))) -ServerUrl "http://<server>:3008" -ApiKey "abc-123-xyz"
#>
param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [Parameter(Mandatory=$true)][string]$ApiKey,
  [int]$WsPort = 3010
)

$ErrorActionPreference = 'Stop'
$InstallDir = "C:\Apps\SpanVaultAgent"
$NodeUrl    = "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi"
$NssmZipUrl = "https://nssm.cc/release/nssm-2.24.zip"
$ServerUrl  = $ServerUrl.TrimEnd('/')

function Write-Step($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Write-Fail($msg) { Write-Host $msg -ForegroundColor Red }

Write-Host "=== SpanVault Agent Installer ===" -ForegroundColor Cyan

# -- Require elevation up front (installing a Windows service needs admin) so we
#    fail fast with clear guidance instead of after downloading files + NSSM. ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Fail "This installer must run in an elevated PowerShell (Run as Administrator)."
  Write-Fail "Right-click PowerShell, choose 'Run as administrator', then paste the install command again."
  throw "Administrator rights required."
}

# -- Preflight: confirm the server is reachable before changing anything --------
Write-Step "Checking connectivity to $ServerUrl ..."
try {
  Invoke-WebRequest -Uri "$ServerUrl/api/health" -UseBasicParsing -TimeoutSec 10 | Out-Null
  Write-Ok "  Server reachable."
} catch {
  Write-Fail "Cannot reach $ServerUrl/api/health - $($_.Exception.Message)"
  Write-Fail "Verify the URL, that this host can route to the SpanVault server, and that port is open."
  throw "Preflight connectivity check failed."
}

# Warn early if the WebSocket port looks unreachable (non-fatal - firewalls vary).
try {
  $wsHost = ([Uri]$ServerUrl).Host
  $probe = Test-NetConnection -ComputerName $wsHost -Port $WsPort -WarningAction SilentlyContinue
  if (-not $probe.TcpTestSucceeded) {
    Write-Fail "  Warning: WebSocket port $WsPort on $wsHost did not respond. The agent will keep retrying once installed; open that port if it stays offline."
  } else {
    Write-Ok "  WebSocket port $WsPort reachable."
  }
} catch { <# Test-NetConnection may be unavailable on older hosts - skip #> }

# -- Node.js -------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Step "Installing Node.js..."
  $msi = "$env:TEMP\node.msi"
  Invoke-WebRequest -Uri $NodeUrl -OutFile $msi -UseBasicParsing
  Start-Process msiexec -Args "/i `"$msi`" /quiet /norestart" -Wait
  $env:PATH += ";C:\Program Files\nodejs"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js install did not complete. Install Node 20 LTS manually and re-run."
  }
}

# -- Install directory + agent files -------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Step "Downloading agent files..."
Invoke-WebRequest -Uri "$ServerUrl/api/agent/agent.js"     -OutFile "$InstallDir\agent.js"     -UseBasicParsing
Invoke-WebRequest -Uri "$ServerUrl/api/agent/package.json" -OutFile "$InstallDir\package.json" -UseBasicParsing

# -- Verify agent.js integrity before it is ever installed/run as a service. -----
#    Plain Invoke-WebRequest has no built-in integrity check, so without this a
#    network-position attacker (rogue DHCP/ARP spoof at the install site) could
#    swap in a malicious agent.js with zero detection. This brings the bootstrap
#    install up to the same bar the agent's own self-update path already uses
#    (comparing sha256 against the agent_sha the server advertises) - see
#    agentMeta() in api/ws-server.js / maybeSelfUpdate() in agent/agent.js.
Write-Step "Verifying agent.js integrity..."
try {
  $expected = Invoke-RestMethod -Uri "$ServerUrl/api/agent/agent.js.sha256" -TimeoutSec 10
} catch {
  Remove-Item "$InstallDir\agent.js" -Force -ErrorAction SilentlyContinue
  Write-Fail "Could not fetch the expected agent.js checksum from $ServerUrl - $($_.Exception.Message)"
  throw "agent.js integrity check failed (checksum endpoint unreachable)."
}
$actualHash = (Get-FileHash -Algorithm SHA256 -Path "$InstallDir\agent.js").Hash
if (-not $expected -or -not $expected.sha256 -or ($actualHash.ToLower() -ne $expected.sha256.ToLower())) {
  Remove-Item "$InstallDir\agent.js" -Force -ErrorAction SilentlyContinue
  Write-Fail "agent.js checksum mismatch - the downloaded file does not match what the server advertises."
  Write-Fail "This usually means the download was tampered with in transit. Aborting before installing anything."
  throw "agent.js integrity check failed (checksum mismatch)."
}
Write-Ok "  agent.js verified (sha256 matches server)."

# -- Config: write UTF-8 WITHOUT a BOM. Windows PowerShell's Out-File -Encoding
#    UTF8 prepends a BOM that Node's JSON.parse rejects, crashing the agent. -----
$cfgJson = @{ serverUrl = $ServerUrl; apiKey = $ApiKey; wsPort = $WsPort } | ConvertTo-Json
[System.IO.File]::WriteAllText("$InstallDir\config.json", $cfgJson, (New-Object System.Text.UTF8Encoding $false))

# -- Dependencies (skip if a bundled node_modules is already present - offline) -
if (Test-Path "$InstallDir\node_modules\ws") {
  Write-Ok "Dependencies already present (offline bundle) - skipping npm install."
} else {
  Write-Step "Installing dependencies..."
  Push-Location $InstallDir
  npm install --omit=dev 2>&1 | Out-Null
  $npmExit = $LASTEXITCODE
  Pop-Location
  if ($npmExit -ne 0) {
    throw "npm install failed (exit $npmExit). Agent dependencies are incomplete - aborting before service registration."
  }
}

# -- Ensure NSSM is available (auto-download if missing) ------------------------
function Resolve-Nssm {
  # 1) A sibling NocVault app may already bundle it (only if agent shares the box).
  $shared = "C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe"
  if (Test-Path $shared) { return $shared }
  # 2) On PATH?
  $onPath = (Get-Command nssm -ErrorAction SilentlyContinue)
  if ($onPath) { return $onPath.Source }
  # 3) Previously downloaded by this installer?
  $local = "$InstallDir\nssm\nssm.exe"
  if (Test-Path $local) { return $local }

  New-Item -ItemType Directory -Force -Path "$InstallDir\nssm" | Out-Null

  # 4) Preferred: fetch nssm.exe straight from the SpanVault server. It is always
  #    reachable (the preflight just confirmed it) and needs no public internet.
  #    Unlike the nssm.cc fallback below, this copy is served by SpanVault's own
  #    server, so it can be integrity-checked the same way as agent.js above -
  #    the server hashes the exact bytes it just handed us. A checksum mismatch
  #    here is treated like an unreachable server copy (skip to the nssm.cc
  #    fallback) rather than a hard abort, since nssm.exe isn't the code path
  #    that changes on every release and a working install still matters more
  #    than hard-failing on a secondary, less-sensitive binary.
  try {
    Write-Step "Fetching NSSM from the SpanVault server..."
    Invoke-WebRequest -Uri "$ServerUrl/api/agent/nssm.exe" -OutFile $local -UseBasicParsing
    if ((Test-Path $local) -and ((Get-Item $local).Length -gt 0)) {
      $nssmVerified = $false
      try {
        $nssmExpected = Invoke-RestMethod -Uri "$ServerUrl/api/agent/nssm.exe.sha256" -TimeoutSec 10
        $nssmActual = (Get-FileHash -Algorithm SHA256 -Path $local).Hash
        if ($nssmExpected -and $nssmExpected.sha256 -and ($nssmActual.ToLower() -eq $nssmExpected.sha256.ToLower())) {
          $nssmVerified = $true
        } else {
          Write-Host "  NSSM checksum mismatch from server copy; trying nssm.cc..." -ForegroundColor Gray
        }
      } catch {
        Write-Host "  Could not verify NSSM checksum ($($_.Exception.Message)); trying nssm.cc..." -ForegroundColor Gray
      }
      if ($nssmVerified) { Write-Ok "  NSSM ready (sha256 verified)."; return $local }
      Remove-Item $local -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Host "  Server copy unavailable ($($_.Exception.Message)); trying nssm.cc..." -ForegroundColor Gray
  }

  # 5) Last resort: the public nssm.cc zip (may be unreachable in some networks).
  Write-Step "Downloading NSSM from nssm.cc..."
  $zip = "$env:TEMP\nssm.zip"
  $ex  = "$env:TEMP\nssm-extract"
  Invoke-WebRequest -Uri $NssmZipUrl -OutFile $zip -UseBasicParsing
  if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $ex -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
  $src  = Get-ChildItem -Path $ex -Recurse -Filter nssm.exe |
            Where-Object { $_.FullName -match "\\$arch\\" } | Select-Object -First 1
  if (-not $src) { throw "Could not locate nssm.exe in the downloaded archive." }
  Copy-Item $src.FullName -Destination $local -Force
  Write-Ok "  NSSM ready."
  return $local
}
$NssmPath = Resolve-Nssm

# -- Register (idempotent) + start the service ---------------------------------
Write-Step "Registering Windows service..."
# Remove any prior registration so re-running the installer is clean. Only touch
# the service if it already exists, and relax error handling around these native
# nssm calls (on a fresh host the service is absent and nssm writes to stderr,
# which would otherwise trip ErrorActionPreference='Stop').
if (Get-Service -Name SpanVault-Agent -ErrorAction SilentlyContinue) {
  Write-Step "Removing existing SpanVault-Agent service..."
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & $NssmPath stop SpanVault-Agent confirm 2>&1 | Out-Null
  & $NssmPath remove SpanVault-Agent confirm 2>&1 | Out-Null
  Start-Sleep -Seconds 1
  $ErrorActionPreference = $eap
}

& $NssmPath install SpanVault-Agent (Get-Command node).Source | Out-Null
& $NssmPath set SpanVault-Agent AppParameters "$InstallDir\agent.js" | Out-Null
& $NssmPath set SpanVault-Agent AppDirectory $InstallDir | Out-Null
& $NssmPath set SpanVault-Agent DisplayName "SpanVault Agent" | Out-Null
& $NssmPath set SpanVault-Agent Description "SpanVault remote polling agent" | Out-Null
& $NssmPath set SpanVault-Agent Start SERVICE_AUTO_START | Out-Null
& $NssmPath set SpanVault-Agent AppStdout "$InstallDir\agent.log" | Out-Null
& $NssmPath set SpanVault-Agent AppStderr "$InstallDir\agent-err.log" | Out-Null
& $NssmPath set SpanVault-Agent AppRotateFiles 1 | Out-Null

& $NssmPath start SpanVault-Agent | Out-Null

# -- Verify the service actually came up ---------------------------------------
Start-Sleep -Seconds 3
$svc = Get-Service -Name SpanVault-Agent -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
  Write-Ok "`nSpanVault Agent installed and running."
  Write-Host "It should appear Online in the SpanVault UI within ~30 seconds." -ForegroundColor Gray
  Write-Host "Logs: $InstallDir\agent.log  (errors: $InstallDir\agent-err.log)" -ForegroundColor Gray
} else {
  $state = if ($svc) { $svc.Status } else { 'not installed' }
  Write-Fail "`nService state is '$state' - it did not start cleanly."
  Write-Fail "Check $InstallDir\agent-err.log for details, then: $NssmPath start SpanVault-Agent"
  throw "SpanVault-Agent did not reach Running state."
}
