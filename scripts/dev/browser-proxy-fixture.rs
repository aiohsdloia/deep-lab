// A deliberately broken MCP backend for timeout/EOF regression tests.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    if std::env::args().nth(1).as_deref() != Some("mcp") {
        println!(
            "{}",
            json!({"success":true,"data":{"runtime":{"browserLaunched":true}}})
        );
        return;
    }
    std::fs::write(
        std::env::var("DEEPLAB_FIXTURE_PID_FILE").unwrap(),
        std::process::id().to_string(),
    )
    .unwrap();
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if request["method"] == "initialize" {
            println!(
                "{}",
                json!({"jsonrpc":"2.0","id":request["id"],"result":{}})
            );
            io::stdout().flush().unwrap();
        } else if request["method"] == "tools/call" {
            if std::env::var("DEEPLAB_FIXTURE_MODE").unwrap() == "eof" {
                return;
            }
            // A silent backend must not hold the proxy forever.
            std::thread::sleep(std::time::Duration::from_secs(120));
        }
    }
}
