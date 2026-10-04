# DSH app icon manager -- shortcut (.lnk) icon read/write helper.
#
# Invocation (from lib/shortcut.js): the script text is base64-encoded as
# UTF-16LE and passed to powershell.exe -EncodedCommand, so no quoting or
# code-page issues can reach this file. Input and output travel through the
# temp files named by two environment variables:
#
#   DSH_ICON_REQUEST -> JSON { items: [ { path, iconLocation? } ] }
#   DSH_ICON_RESULT  <- JSON { ok, entries: [ ... ] }
#
# Passing iconLocation on an item performs a write; omitting it only reads.
#
# Implementation note: this uses the WScript.Shell COM automation object
# instead of parsing the .lnk binary format. Shell links have several
# optional structures and ID lists, and COM is the system's own reader/writer.
#
# This file MUST stay pure ASCII: Windows PowerShell 5.1 decodes a UTF-8 file
# without a BOM as ANSI, which corrupts non-ASCII text and breaks parsing.

$ErrorActionPreference = 'Stop'

function Read-Request([string] $path) {
  $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

function Write-Result([string] $path, $payload) {
  $json = $payload | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$requestPath = $env:DSH_ICON_REQUEST
$resultPath = $env:DSH_ICON_RESULT
$request = Read-Request $requestPath

try {
  $shell = New-Object -ComObject WScript.Shell
} catch {
  Write-Result $resultPath ([ordered]@{ ok = $false; error = "cannot create WScript.Shell: $($_.Exception.Message)" })
  exit 1
}

$entries = @()
foreach ($item in @($request.items)) {
  $entry = [ordered]@{
    path = [string]$item.path
    exists = $false
    targetPath = $null
    arguments = $null
    workingDirectory = $null
    iconLocation = $null
    changed = $false
    error = $null
  }
  try {
    if (-not (Test-Path -LiteralPath $item.path)) {
      $entry.error = 'file-not-found'
      $entries += $entry
      continue
    }
    $entry.exists = $true
    $shortcut = $shell.CreateShortcut($item.path)
    $entry.targetPath = $shortcut.TargetPath
    $entry.arguments = $shortcut.Arguments
    $entry.workingDirectory = $shortcut.WorkingDirectory
    $entry.iconLocation = $shortcut.IconLocation

    # Only write when the request supplies a non-empty iconLocation. COM
    # rejects an empty string, so "restore" must pass back the recorded
    # original value rather than clearing the field.
    $desired = [string]$item.iconLocation
    if ($null -ne $item.iconLocation -and $desired.Length -gt 0) {
      if ($desired -ne [string]$shortcut.IconLocation) {
        $shortcut.IconLocation = $desired
        $shortcut.Save()
        $verify = $shell.CreateShortcut($item.path)
        $entry.iconLocation = $verify.IconLocation
        $entry.changed = ($verify.IconLocation -eq $desired)
        if (-not $entry.changed) {
          $entry.error = "write-verify-failed: wanted '$desired', read back '$($verify.IconLocation)'"
        }
      }
    }
  } catch {
    $entry.error = $_.Exception.Message
  }
  $entries += $entry
}

Write-Result $resultPath ([ordered]@{ ok = $true; entries = $entries })
exit 0
