#!/usr/bin/env python3
"""Verify the deterministic BCI demo without third-party dependencies."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import struct
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def read_jsonl(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    records: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        return [], [f"cannot read {path}: {error}"]
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            errors.append(f"{path}:{number} is invalid JSON: {error.msg}")
            continue
        if isinstance(value, dict):
            records.append(value)
        else:
            errors.append(f"{path}:{number} must contain a JSON object")
    return records, errors


def normalized(value: str) -> str:
    return value.replace("\\", "/").removeprefix("./")


def verify_source(root: Path, contract: dict[str, Any], errors: list[str]) -> None:
    spec = contract["source"]
    path = root / spec["path"]
    if not path.is_file():
        errors.append(f"missing source file: {spec['path']}")
        return
    normalized_bytes = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    digest = hashlib.sha256(normalized_bytes).hexdigest()
    if digest != spec["sha256"]:
        errors.append(
            f"source corpus changed: expected normalized sha256 {spec['sha256']}, got {digest}"
        )
    try:
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            rows = list(reader)
            if reader.fieldnames != spec["columns"]:
                errors.append(
                    f"source columns differ: expected {spec['columns']}, got {reader.fieldnames}"
                )
            if len(rows) != 14:
                errors.append(f"source corpus must contain 14 records, got {len(rows)}")
    except (OSError, csv.Error) as error:
        errors.append(f"cannot parse source corpus: {error}")


def verify_required_files(root: Path, contract: dict[str, Any], errors: list[str]) -> None:
    for relative in contract["requiredFiles"]:
        path = root / relative
        if not path.is_file():
            errors.append(f"missing required output: {relative}")
        elif path.stat().st_size == 0:
            errors.append(f"required output is empty: {relative}")
    for relative, minimum in (("plan.md", 80), ("scripts/analyze.py", 200)):
        path = root / relative
        if path.is_file() and path.stat().st_size < minimum:
            errors.append(f"{relative} is too small to be a usable artifact")


def verify_summary(root: Path, contract: dict[str, Any], errors: list[str]) -> None:
    spec = contract["summary"]
    path = root / spec["path"]
    if not path.is_file():
        return
    try:
        with path.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.reader(handle))
    except (OSError, csv.Error) as error:
        errors.append(f"cannot parse {spec['path']}: {error}")
        return
    expected = [spec["columns"], *spec["rows"]]
    if rows != expected:
        errors.append(f"{spec['path']} does not match the contracted year-level statistics")


def verify_figures(root: Path, contract: dict[str, Any], errors: list[str]) -> None:
    spec = contract["figures"]
    signature = b"\x89PNG\r\n\x1a\n"
    for relative in spec["paths"]:
        path = root / relative
        if not path.is_file():
            continue
        data = path.read_bytes()
        if len(data) < spec["minimumBytes"]:
            errors.append(f"{relative} is too small to be a substantive PNG figure")
            continue
        if len(data) < 24 or data[:8] != signature or data[12:16] != b"IHDR":
            errors.append(f"{relative} is not a valid PNG file")
            continue
        width, height = struct.unpack(">II", data[16:24])
        if width < spec["minimumWidth"] or height < spec["minimumHeight"]:
            errors.append(
                f"{relative} is {width}x{height}; minimum is "
                f"{spec['minimumWidth']}x{spec['minimumHeight']}"
            )


def verify_report(root: Path, contract: dict[str, Any], errors: list[str]) -> None:
    spec = contract["report"]
    path = root / spec["path"]
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")
    for heading in spec["requiredHeadings"]:
        if not re.search(rf"^#{{1,6}}\s+{re.escape(heading)}\s*$", text, re.IGNORECASE | re.MULTILINE):
            errors.append(f"{spec['path']} is missing the {heading!r} heading")
    for fact in spec["requiredFacts"]:
        if not re.search(rf"(?<!\d){re.escape(fact)}(?!\d)", text):
            errors.append(f"{spec['path']} does not report the contracted fact {fact!r}")


def verify_platform_records(root: Path, contract: dict[str, Any], errors: list[str]) -> None:
    spec = contract["platformRecords"]
    runs, run_errors = read_jsonl(root / spec["runs"])
    provenance, provenance_errors = read_jsonl(root / spec["provenance"])
    errors.extend(run_errors)
    errors.extend(provenance_errors)
    if run_errors or provenance_errors:
        return

    command_fragment = normalized(spec["commandContains"])
    expected_outputs = {normalized(path) for path in spec["outputPaths"]}
    matches = []
    for run in runs:
        command = normalized(str(run.get("command", "")))
        outputs = {
            normalized(str(item.get("path", "")))
            for item in run.get("outputs", [])
            if isinstance(item, dict)
        }
        if run.get("status") == "ok" and command_fragment in command and expected_outputs <= outputs:
            matches.append(run)
    if not matches:
        errors.append("DeepLab run history has no successful analyze.py run owning all outputs")
        return

    run_ids = {run.get("runId") for run in matches}
    linked = {
        normalized(str(record.get("path", "")))
        for record in provenance
        if record.get("runId") in run_ids
    }
    missing = sorted(expected_outputs - linked)
    if missing:
        errors.append(f"DeepLab provenance does not link these run outputs: {', '.join(missing)}")


def write_review(root: Path, contract: dict[str, Any], errors: list[str], reran: bool) -> None:
    path = root / contract["verificationOutput"]
    path.parent.mkdir(parents=True, exist_ok=True)
    status = "PASS" if not errors else "FAIL"
    lines = [
        "# BCI Demo Verification",
        "",
        f"- Status: **{status}**",
        f"- Contract version: `{contract['version']}`",
        f"- Analysis rerun: `{'yes' if reran else 'no'}`",
        f"- Verified at: `{datetime.now(timezone.utc).isoformat()}`",
        "",
    ]
    if errors:
        lines.extend(["## Problems", "", *[f"- {error}" for error in errors]])
    else:
        lines.extend(
            [
                "## Result",
                "",
                "The source digest, summary statistics, figures, report facts, and required files match the contract.",
            ]
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--rerun", action="store_true", help="run scripts/analyze.py before checking")
    parser.add_argument(
        "--require-platform-records",
        action="store_true",
        help="also require DeepLab-owned run and provenance records",
    )
    args = parser.parse_args()
    root = args.workspace.resolve()
    contract = load_json(root / "demo-contract.json")
    errors: list[str] = []

    if args.rerun:
        script = root / "scripts" / "analyze.py"
        if script.is_file():
            result = subprocess.run(
                [sys.executable, str(script)],
                cwd=root,
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout).strip()
                errors.append(f"scripts/analyze.py exited with {result.returncode}: {detail[-500:]}")
        else:
            errors.append("cannot rerun: scripts/analyze.py is missing")

    verify_source(root, contract, errors)
    verify_required_files(root, contract, errors)
    verify_summary(root, contract, errors)
    verify_figures(root, contract, errors)
    verify_report(root, contract, errors)
    if args.require_platform_records:
        verify_platform_records(root, contract, errors)
    write_review(root, contract, errors, args.rerun)

    if errors:
        print(f"BCI demo verification FAILED ({len(errors)} problem(s))")
        for error in errors:
            print(f"- {error}")
        return 1
    print("BCI demo verification PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
