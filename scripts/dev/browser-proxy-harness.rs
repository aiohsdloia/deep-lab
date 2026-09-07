// Compile this small entry point against the desktop's serde_json artifact to
// exercise the production proxy without linking Tauri or WebView2.
#[path = "../../apps/desktop/src-tauri/src/browser_mcp_proxy.rs"]
mod browser_mcp_proxy;

fn main() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(browser_mcp_proxy::PROXY_FLAG)) {
        std::process::exit(2);
    }
    std::process::exit(browser_mcp_proxy::run(args.collect()));
}
