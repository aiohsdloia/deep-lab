#!/usr/bin/env python3
"""Toggle tauri.conf.json's dsh resource between the raw tree and dist/dsh.zip.
Used by build-windows-installer.ps1 (NSIS cannot embed the ~460-char tree)."""
import io
import json
import os
import sys

RAW_KEY = "../../../runtime/dsh"
ZIP_KEY = "../../../dist/dsh.zip"
BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONF = os.path.join(BASE, "apps", "desktop", "src-tauri", "tauri.conf.json")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ("on", "off"):
        print("usage: nsis-switch-conf.py on|off", file=sys.stderr)
        return 2
    mode = sys.argv[1]
    c = json.load(io.open(CONF, encoding="utf-8"))
    res = c["bundle"]["resources"]
    if mode == "on":
        res.pop(RAW_KEY, None)
        res[ZIP_KEY] = "dsh.zip"
    else:
        res.pop(ZIP_KEY, None)
        res[RAW_KEY] = "dsh/"
    json.dump(c, io.open(CONF, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print(f"conf dsh resource -> {mode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
