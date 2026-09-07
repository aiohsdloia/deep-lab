# Test the production Rust proxy without the desktop/WebView test binary.
# Reuses serde_json from an existing GNU desktop build on Windows.
param([switch]$SkipBrowser)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$target = Join-Path $repo 'apps/desktop/src-tauri/target'
$deps = Join-Path $target 'x86_64-pc-windows-gnu/release/deps'
$serde = Get-ChildItem -LiteralPath $deps -Filter 'libserde_json*.rlib' | Select-Object -First 1
if (-not $serde) { throw 'Build the GNU desktop target first to supply serde_json.' }
Push-Location $repo
try {
    $common = @('+stable-x86_64-pc-windows-gnu', '--edition=2021', '--extern', "serde_json=$($serde.FullName)", '-L', "dependency=$deps")
    & rustc @common --test apps/desktop/src-tauri/src/browser_mcp_proxy.rs -o "$target/browser-proxy-tests.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Proxy test compilation failed.' }
    & "$target/browser-proxy-tests.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Proxy unit tests failed.' }
    & rustc @common scripts/dev/browser-proxy-harness.rs -o "$target/browser-proxy-harness.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Proxy harness compilation failed.' }
    & rustc @common scripts/dev/browser-proxy-fixture.rs -o "$target/browser-proxy-fixture.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Proxy fixture compilation failed.' }
    node scripts/dev/test-browser-proxy-failures.mjs "$target/browser-proxy-harness.exe" "$target/browser-proxy-fixture.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Proxy failure recovery tests failed.' }
    if (-not $SkipBrowser) {
        node scripts/dev/test-browser-proxy.mjs "$target/browser-proxy-harness.exe" apps/desktop/src-tauri/binaries/agent-browser-x86_64-pc-windows-gnu.exe
        if ($LASTEXITCODE -ne 0) { throw 'Real browser acceptance failed.' }
    }
} finally {
    Pop-Location
}
