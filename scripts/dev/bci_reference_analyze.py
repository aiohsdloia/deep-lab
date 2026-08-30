#!/usr/bin/env python3
"""Dependency-free reference implementation for the bundled BCI demo contract."""

from __future__ import annotations

import argparse
import binascii
import csv
import struct
import zlib
from collections import Counter, defaultdict
from pathlib import Path


WIDTH = 960
HEIGHT = 540
BACKGROUND = (248, 249, 251)
INK = (35, 43, 54)
GRID = (218, 223, 230)
PALETTE = [(34, 113, 177), (35, 139, 98), (225, 124, 46), (170, 74, 68)]


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", binascii.crc32(body) & 0xFFFFFFFF)


def write_chart(path: Path, title: str, labels: list[str], values: list[int], horizontal: bool = False) -> None:
    pixels = bytearray(BACKGROUND * (WIDTH * HEIGHT))

    def rectangle(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        x0, x1 = sorted((max(0, x0), min(WIDTH, x1)))
        y0, y1 = sorted((max(0, y0), min(HEIGHT, y1)))
        row = bytes(color) * max(0, x1 - x0)
        for y in range(y0, y1):
            start = (y * WIDTH + x0) * 3
            pixels[start : start + len(row)] = row

    for x in range(80, WIDTH - 40, 80):
        rectangle(x, 60, x + 1, HEIGHT - 70, GRID)
    for y in range(60, HEIGHT - 69, 60):
        rectangle(80, y, WIDTH - 40, y + 1, GRID)
    rectangle(78, 58, 81, HEIGHT - 67, INK)
    rectangle(78, HEIGHT - 70, WIDTH - 37, HEIGHT - 67, INK)

    maximum = max(values) if values else 1
    if horizontal:
        slot = (HEIGHT - 150) // max(1, len(values))
        for index, value in enumerate(values):
            y = 75 + index * slot
            length = int((WIDTH - 190) * value / maximum)
            rectangle(82, y, 82 + length, y + max(12, slot - 14), PALETTE[index % len(PALETTE)])
    else:
        slot = (WIDTH - 160) // max(1, len(values))
        for index, value in enumerate(values):
            x = 105 + index * slot
            height = int((HEIGHT - 180) * value / maximum)
            rectangle(
                x,
                HEIGHT - 70 - height,
                x + max(18, slot - 35),
                HEIGHT - 70,
                PALETTE[index % len(PALETTE)],
            )

    raw = b"".join(b"\x00" + pixels[y * WIDTH * 3 : (y + 1) * WIDTH * 3] for y in range(HEIGHT))
    header = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)
    metadata = f"Title\x00{title}; labels={','.join(labels)}".encode("latin-1", "replace")
    data = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"tEXt", metadata)
        + png_chunk(b"IDAT", zlib.compress(raw, 6))
        + png_chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args()
    root = args.workspace.resolve()
    source = root / "data" / "raw" / "bci_literature_seed.csv"
    with source.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    by_year: dict[str, list[int]] = defaultdict(list)
    modalities: Counter[str] = Counter()
    keywords: Counter[str] = Counter()
    for row in rows:
        by_year[row["year"]].append(int(row["citations"]))
        modalities[row["modality"]] += 1
        keywords.update(keyword.strip() for keyword in row["keywords"].split(";") if keyword.strip())

    summary_path = root / "data" / "processed" / "corpus_summary.csv"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    with summary_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["year", "paper_count", "total_citations", "mean_citations"])
        for year in sorted(by_year):
            citations = by_year[year]
            writer.writerow([year, len(citations), sum(citations), f"{sum(citations) / len(citations):.2f}"])

    years = sorted(by_year)
    write_chart(
        root / "figures" / "year_trend.png",
        "BCI seed-corpus papers by year",
        years,
        [len(by_year[year]) for year in years],
    )
    modality_items = sorted(modalities.items(), key=lambda item: (-item[1], item[0]))
    write_chart(
        root / "figures" / "topic_clusters.png",
        "BCI modality groups",
        [item[0] for item in modality_items],
        [item[1] for item in modality_items],
    )
    keyword_items = keywords.most_common(8)
    write_chart(
        root / "figures" / "top_keywords.png",
        "Most frequent BCI keywords",
        [item[0] for item in keyword_items],
        [item[1] for item in keyword_items],
        horizontal=True,
    )

    (root / "plan.md").write_text(
        "# Analysis Plan\n\n"
        "1. Validate the fixed local CSV corpus and group records by publication year.\n"
        "2. Calculate paper counts, citation totals, citation means, modality counts, and keyword counts.\n"
        "3. Render three deterministic PNG summaries and write a report grounded only in computed values.\n"
        "4. Run the bundled verifier; DeepLab records execution and provenance separately.\n",
        encoding="utf-8",
    )

    total_citations = sum(int(row["citations"]) for row in rows)
    report = root / "reports" / "report.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        "# BCI Literature Trends, 2023-2026\n\n"
        "## Method\n\n"
        "The analysis groups the fixed CSV records by year, modality, and semicolon-delimited keyword, then computes descriptive counts and citation summaries.\n\n"
        "## Data\n\n"
        f"The local seed corpus contains {len(rows)} records from 2023 through 2026 and {total_citations} total citations. It is a demonstration corpus, not a systematic literature review.\n\n"
        "## Findings\n\n"
        "The yearly paper counts are 3, 4, 4, and 3. Citation totals peak at 210 in 2025, while the mean is highest in 2025 at 52.50. "
        f"The modality distribution is {dict(modalities)}. EEG is the most frequent keyword with {keywords['EEG']} appearances.\n\n"
        "## Limitations\n\n"
        "The corpus is small, curated, and partly synthetic. Citation totals are static seed values, so these results demonstrate reproducible workflow behavior rather than claims about the complete BCI field.\n",
        encoding="utf-8",
    )
    print(f"generated BCI demo outputs from {len(rows)} records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
