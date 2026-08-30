$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configPath = Join-Path $projectRoot "wrangler.jsonc"
$packagePath = Join-Path $projectRoot "package.json"

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js 24+ and npm are required. Install them, reopen this window, and run deploy.cmd again."
}

$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 24) {
    throw "Node.js 24 or newer is required."
}

$config = Get-Content -LiteralPath $configPath -Raw
if ($config -match "REPLACE_WITH_") {
    throw "wrangler.jsonc still contains REPLACE_WITH_ placeholders. Complete DEPLOY.md sections 2-3 first."
}

Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    }
    npm run deploy
    if ($LASTEXITCODE -ne 0) { throw "Worker deployment failed." }
}
finally {
    Pop-Location
}
