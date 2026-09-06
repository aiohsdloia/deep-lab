# Stage a fresh DeepLab Windows release folder from the current source.
# The folder is layout-identical to the installed app (exe + resources side by
# side) and can be run directly. NSIS bundling of the full dsh tree is blocked
# by makensis MAX_PATH on ~460-char vendored paths; this staged folder is the
# reproducible "initial version" artifact until that is pruned/fixed.
#
# Usage (repo root, GNU toolchain):
#   powershell -File scripts/release/stage-windows-release.ps1 [-OutDir <dir>]
param(
  [string]$OutDir = ""
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$desktop = Join-Path $repo "apps\desktop"
$srcTauri = Join-Path $desktop "src-tauri"
$confPath = Join-Path $srcTauri "tauri.conf.json"
$target = Join-Path $desktop "src-tauri\target\x86_64-pc-windows-gnu\release"
if (-not $OutDir) { $OutDir = Join-Path $repo "dist\DeepLab-windows-x64" }
$stage = Join-Path $OutDir (Split-Path $OutDir -Leaf)
$root = Split-Path $OutDir -Parent

Write-Host "repo   : $repo"
Write-Host "stage  : $OutDir"

if (-not (Test-Path (Join-Path $target "deeplab-workbench.exe"))) {
  throw "release exe missing; run 'pnpm --filter @deeplab/desktop tauri build --target x86_64-pc-windows-gnu --no-bundle' first"
}

# 1) Clean staging dir and copy the app binary + runtime DLLs.
if (Test-Path $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -LiteralPath (Join-Path $target "deeplab-workbench.exe") -Destination $OutDir
foreach ($dll in @("WebView2Loader.dll")) {
  $src = Join-Path $target $dll
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $OutDir }
}

# 2) Copy bundled resources exactly per tauri.conf bundle.resources.
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
foreach ($prop in $conf.bundle.resources.PSObject.Properties) {
  $srcRel = $prop.Name.TrimEnd('/')
  $dstRel = ([string]$prop.Value).Trim().TrimEnd('/')
  $src = Join-Path $srcTauri $srcRel
  if (Test-Path $src) {
    $dst = Join-Path $OutDir $dstRel
    New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
    if ((Get-Item $src).PSIsContainer) {
      Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    } else {
      Copy-Item -LiteralPath $src -Destination $dst -Force
    }
  } else {
    Write-Warning "resource source missing: $src"
  }
}

# 3) Also ship the two binary tools beside the exe (tauri 'externalBin').
foreach ($tool in @("uv.exe", "agent-browser.exe")) {
  $src = Join-Path $target $tool
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $OutDir }
}

# 4) Integrity: the bundled dsh tree must verify, and a manifest records hashes.
node (Join-Path $repo "scripts\dev\check-dsh-bundle.mjs") --root (Join-Path $OutDir "dsh")
if ($LASTEXITCODE -ne 0) { throw "staged dsh failed integrity check" }

$files = Get-ChildItem -LiteralPath $OutDir -Recurse -File | Sort-Object FullName
$total = ($files | Measure-Object).Count
$sha = Get-FileHash (Join-Path $OutDir "deeplab-workbench.exe") -Algorithm SHA256
$manifest = @{
  app        = "deeplab-workbench"
  version    = $conf.version
  stagedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
  files      = $total
  exeSha256  = $sha.Hash
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir "release-manifest.json") -Encoding UTF8
Write-Host "staged $total files -> $OutDir"
Write-Host "exe sha256: $($sha.Hash)"
