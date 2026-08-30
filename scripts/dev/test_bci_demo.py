#!/usr/bin/env python3
"""End-to-end contract tests for the bundled BCI demo workspace."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "bci-trends"
REFERENCE = Path(__file__).with_name("bci_reference_analyze.py")


def run_verify(workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(workspace / "verify.py"), "--workspace", str(workspace), *args],
        cwd=workspace,
        text=True,
        capture_output=True,
        check=False,
    )


def write_platform_records(workspace: Path) -> None:
    meta = workspace / ".deeplab"
    meta.mkdir()
    outputs = [
        "data/processed/corpus_summary.csv",
        "figures/year_trend.png",
        "figures/topic_clusters.png",
        "figures/top_keywords.png",
        "reports/report.md",
    ]
    run = {
        "runId": "run_bci_contract",
        "command": "python scripts/analyze.py",
        "status": "ok",
        "outputs": [{"path": path, "sha256": "test"} for path in outputs],
    }
    (meta / "runs.jsonl").write_text(json.dumps(run) + "\n", encoding="utf-8")
    records = [
        {"path": path, "version": 1, "tool": "run", "runId": "run_bci_contract"}
        for path in outputs
    ]
    (meta / "provenance.jsonl").write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="deeplab-bci-demo-") as temp:
        workspace = Path(temp) / "bci-trends"
        shutil.copytree(EXAMPLE, workspace)
        scripts = workspace / "scripts"
        scripts.mkdir(exist_ok=True)
        shutil.copy2(REFERENCE, scripts / "analyze.py")
        source = workspace / "data" / "raw" / "bci_literature_seed.csv"
        source_bytes = source.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        source.write_bytes(source_bytes.replace(b"\n", b"\r\n"))

        result = run_verify(workspace, "--rerun")
        assert result.returncode == 0, result.stdout + result.stderr
        assert "Status: **PASS**" in (workspace / "reviews" / "review.md").read_text(
            encoding="utf-8"
        )

        write_platform_records(workspace)
        result = run_verify(workspace, "--require-platform-records")
        assert result.returncode == 0, result.stdout + result.stderr

        summary = workspace / "data" / "processed" / "corpus_summary.csv"
        summary.write_text(summary.read_text(encoding="utf-8").replace("2025,4,210", "2025,4,999"), encoding="utf-8")
        result = run_verify(workspace)
        assert result.returncode == 1, "corrupt summary unexpectedly passed"
        assert "year-level statistics" in result.stdout
        assert "Status: **FAIL**" in (workspace / "reviews" / "review.md").read_text(
            encoding="utf-8"
        )

    print("BCI demo contract: valid workflow passes; corrupt output fails; platform records link")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
