# Explicit developer setup assistant for Windows PowerShell.
# This file is never run automatically by git clone.

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot

function Write-Ok([string]$Message) { Write-Host "✓ $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "⚠ $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "✗ $Message" -ForegroundColor Red }
function Confirm-Action([string]$Prompt) {
  return (Read-Host "$Prompt [y/N]") -match '^[Yy]$'
}
function Has-Command([string]$Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }
function Get-NodeMajor {
  if (-not (Has-Command 'node')) { return 0 }
  $version = (node --version).Trim().TrimStart('v')
  return [int]($version.Split('.')[0])
}
function Install-WithWinget([string]$Id, [string]$Purpose) {
  if (-not (Has-Command 'winget')) {
    Write-Warn "$Purpose is missing. Install it manually, then rerun this script. winget is not available on this computer."
    return $false
  }
  Write-Warn "$Purpose is missing. winget can install it using: winget install --id $Id --exact"
  if (Confirm-Action 'Run this system-level installation?') {
    winget install --id $Id --exact
    return $true
  }
  Write-Warn 'Skipped installation.'
  return $false
}

Write-Host 'Vyntrix setup assistant'
Write-Host "Project: $ProjectDir`n"

if ($env:OS -ne 'Windows_NT') {
  Write-Fail 'This script is for Windows. On macOS/Linux run: bash scripts/setup.sh'
  exit 1
}
Write-Ok "Operating system: Windows ($([System.Environment]::OSVersion.VersionString))"

if (Has-Command 'git') {
  Write-Ok "Git: $((git --version).Trim())"
} else {
  Install-WithWinget 'Git.Git' 'Git is required to clone and manage this repository' | Out-Null
}

if (-not (Has-Command 'git')) {
  Write-Fail 'Git is still unavailable. Install Git, open a new PowerShell window, then rerun this assistant.'
  exit 1
}

$nodeMajor = Get-NodeMajor
if ($nodeMajor -ge 18) {
  Write-Ok "Node.js: $((node --version).Trim())"
  if ($nodeMajor -ne 20) { Write-Warn 'Node 20 LTS is recommended; Node 18+ is supported.' }
} else {
  if (Has-Command 'node') { Write-Warn "Node.js $((node --version).Trim()) is too old. Node 18+ is required." }
  Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js 18+ is required to run Vyntrix' | Out-Null
}

if (Has-Command 'npm') {
  Write-Ok "npm: $((npm --version).Trim())"
} else {
  Write-Warn 'npm is missing. It is normally installed with Node.js; reinstall or upgrade Node.js 18+.'
}

if ((Get-NodeMajor) -lt 18 -or -not (Has-Command 'npm')) {
  Write-Fail 'Required tools are unavailable. Install Node.js 18+ (including npm), open a new PowerShell window, then rerun this assistant.'
  exit 1
}

Set-Location $ProjectDir
if (Test-Path 'node_modules') { Write-Ok 'node_modules directory found.' } else { Write-Warn 'node_modules directory is missing.' }

if (Confirm-Action 'Install or update project dependencies with npm install?') {
  npm install
  Write-Ok 'Project dependencies installed.'
} else {
  Write-Warn 'Skipped npm install. Run it before starting if dependencies are missing.'
}

if (Test-Path '.env.local') {
  Write-Ok '.env.local found.'
} else {
  Write-Warn '.env.local is not present. It is optional for local development, but required values should be set before production.'
  if (Confirm-Action 'Create .env.local from .env.example?') {
    Copy-Item '.env.example' '.env.local'
    Write-Ok 'Created .env.local. Replace the SESSION_SECRET placeholder before production use.'
  }
}

Write-Host "`nRunning read-only diagnostics...`n"
npm run doctor

Write-Host "`nSetup complete. Start Vyntrix with:`n  npm start"
