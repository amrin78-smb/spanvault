<#
.SYNOPSIS
    Installs the SpanVault Agent as a Windows service on a remote server.

.DESCRIPTION
    Downloads the agent files from the SpanVault server, writes config.json,
    installs Node.js + dependencies, and registers the SpanVault-Agent NSSM
    service. Run on the remote (polling) server.

.PARAMETER ServerUrl
    Base URL of the SpanVault server (the frontend, which proxies /api/*),
    e.g. http://<server>:3008

.PARAMETER ApiKey
    The agent's API key (generated when the agent was created in the UI).

.EXAMPLE
    & ([scriptblock]::Create((irm http://<server>:3008/api/agent/install.ps1))) -ServerUrl "http://<server>:3008" -ApiKey "abc-123-xyz"
#>
param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [Parameter(Mandatory=$true)][string]$ApiKey
)

$ErrorActionPreference = 'Stop'
$InstallDir = "C:\Apps\SpanVaultAgent"
$NodeUrl = "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi"

Write-Host "=== SpanVault Agent Installer ===" -ForegroundColor Cyan

# Check/install Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Node.js..." -ForegroundColor Yellow
  $msi = "$env:TEMP\node.msi"
  Invoke-WebRequest -Uri $NodeUrl -OutFile $msi
  Start-Process msiexec -Args "/i $msi /quiet" -Wait
  $env:PATH += ";C:\Program Files\nodejs"
}

# Create install directory
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Download agent files from the SpanVault server
Write-Host "Downloading agent files..." -ForegroundColor Yellow
Invoke-WebRequest -Uri "$ServerUrl/api/agent/agent.js"     -OutFile "$InstallDir\agent.js"
Invoke-WebRequest -Uri "$ServerUrl/api/agent/package.json" -OutFile "$InstallDir\package.json"

# Write config
@{ serverUrl = $ServerUrl; apiKey = $ApiKey; wsPort = 3010 } |
  ConvertTo-Json | Out-File "$InstallDir\config.json" -Encoding UTF8

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Yellow
Push-Location $InstallDir
npm install --omit=dev 2>&1 | Out-Null
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) {
  throw "npm install failed (exit $npmExit). Agent dependencies are incomplete - aborting before service registration."
}

# Install NSSM and register service
$NssmPath = "C:\Apps\NetVault\nssm\nssm-2.24\win64\nssm.exe"
if (-not (Test-Path $NssmPath)) { $NssmPath = "nssm" }

Write-Host "Registering Windows service..." -ForegroundColor Yellow
& $NssmPath install SpanVault-Agent (Get-Command node).Source | Out-Null
& $NssmPath set SpanVault-Agent AppParameters "$InstallDir\agent.js" | Out-Null
& $NssmPath set SpanVault-Agent AppDirectory $InstallDir | Out-Null
& $NssmPath set SpanVault-Agent DisplayName "SpanVault Agent" | Out-Null
& $NssmPath set SpanVault-Agent Description "SpanVault remote polling agent" | Out-Null
& $NssmPath set SpanVault-Agent Start SERVICE_AUTO_START | Out-Null
& $NssmPath set SpanVault-Agent AppStdout "$InstallDir\agent.log" | Out-Null
& $NssmPath set SpanVault-Agent AppStderr "$InstallDir\agent-err.log" | Out-Null
& $NssmPath set SpanVault-Agent AppRotateFiles 1 | Out-Null

sc.exe start SpanVault-Agent | Out-Null

Write-Host "SpanVault Agent installed and started." -ForegroundColor Green
Write-Host "Check status: sc.exe query SpanVault-Agent" -ForegroundColor Gray
