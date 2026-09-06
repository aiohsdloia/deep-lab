#!/usr/bin/env python3
"""Bundle the vendored dsh tree into dist/dsh.zip so installers can ship it as a
single shallow file (NSIS chokes on the ~460-char deep node_modules paths)."""
import io
import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "runtime", "dsh")
OUT = os.path.join(ROOT, "dist", "dsh.zip")


def main() -> int:
    if not os.path.isdir(SRC):
        print("runtime/dsh missing; run scripts/dev/fetch-dsh.sh first", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    n = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=6) as z:
        for root, _dirs, files in os.walk(SRC):
            for name in files:
                p = os.path.join(root, name)
                z.write(p, os.path.relpath(p, SRC))
                n += 1
    print(f"packed {n} files -> {OUT} ({os.path.getsize(OUT)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
