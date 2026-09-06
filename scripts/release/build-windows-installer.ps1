# Build the DeepLab NSIS installer with dsh shipped as a single zip (the raw
# vendored tree exceeds makensis MAX_PATH). Temporarily swaps tauri.conf.json's
# dsh resource for dist/dsh.zip, builds, then restores the config.
# Requires: python, pnpm, GNU toolchain env (RUSTUP_TOOLCHAIN=stable-...-gnu).
param(
  [switch]$SkipZip
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$srcTauri = Join-Path $repo "apps\desktop\src-tauri"
$conf = Join-Path $srcTauri "tauri.conf.json"
$backup = "$conf.bak-nsis"
Set-Location $repo

if (-not $SkipZip) {
  python scripts\dev\package-dsh-zip.py
  if ($LASTEXITCODE -ne 0) { throw "dsh.zip packaging failed" }
}

Copy-Item -LiteralPath $conf -Destination $backup -Force
try {
  python scripts\dev\nsis-switch-conf.py on
  if ($LASTEXITCODE -ne 0) { throw "failed to switch conf to dsh.zip" }
  pnpm --filter @deeplab/desktop tauri build --target x86_64-pc-windows-gnu --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "tauri nsis build failed" }
} finally {
  Move-Item -LiteralPath $backup -Destination $conf -Force -ErrorAction SilentlyContinue
  git -C $repo checkout -- apps/desktop/src-tauri/Cargo.toml 2>$null
}
Write-Host "installer ready: apps/desktop/src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/DeepLab_1.0.2_x64-setup.exe"
