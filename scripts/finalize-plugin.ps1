param(
    [Parameter(Mandatory = $true)]
    [string]$AppId
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($AppId -notmatch '^(plugin_)?asdk_app_[A-Za-z0-9]+$') {
    throw "AppId must be the technical ID copied from the ChatGPT developer-mode connection."
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$appPath = Join-Path $projectRoot ".app.json"
$manifestPath = Join-Path $projectRoot ".codex-plugin\plugin.json"

$app = [ordered]@{
    apps = [ordered]@{
        "universal-calendar" = [ordered]@{
            id = $AppId
            required = $true
        }
    }
}
$app | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $appPath -Encoding utf8

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest | Add-Member -NotePropertyName apps -NotePropertyValue "./.app.json" -Force
$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host "Plugin package finalized: $projectRoot"
Write-Host "Run the plugin validator before installing or publishing it."
