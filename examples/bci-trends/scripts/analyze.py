#!/usr/bin/env python3
"""Generate the deterministic outputs for DeepLab's bundled BCI demo."""

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
FONT = {
    " ": ("00000",) * 7,
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("01110", "10000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00001", "01110"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01111", "10000", "10000", "10111", "10001", "10001", "01110"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00111", "00010", "00010", "00010", "10010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "10101", "01010"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
}


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", binascii.crc32(body) & 0xFFFFFFFF)


def write_chart(
    path: Path,
    title: str,
    labels: list[str],
    values: list[int],
    horizontal: bool = False,
) -> None:
    pixels = bytearray(BACKGROUND * (WIDTH * HEIGHT))

    def rectangle(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        x0, x1 = sorted((max(0, x0), min(WIDTH, x1)))
        y0, y1 = sorted((max(0, y0), min(HEIGHT, y1)))
        row = bytes(color) * max(0, x1 - x0)
        for y in range(y0, y1):
            start = (y * WIDTH + x0) * 3
            pixels[start : start + len(row)] = row

    def text_width(text: str, scale: int) -> int:
        return max(0, len(text) * 6 * scale - scale)

    def draw_text(x: int, y: int, text: str, color: tuple[int, int, int], scale: int = 2) -> None:
        cursor = x
        for char in text.upper():
            glyph = FONT.get(char, FONT[" "])
            for row_index, row in enumerate(glyph):
                for column_index, pixel in enumerate(row):
                    if pixel == "1":
                        rectangle(
                            cursor + column_index * scale,
                            y + row_index * scale,
                            cursor + (column_index + 1) * scale,
                            y + (row_index + 1) * scale,
                            color,
                        )
            cursor += 6 * scale

    left = 250 if horizontal else 80
    right = WIDTH - 40
    top = 70
    bottom = HEIGHT - 70
    title_text = title[:58]
    draw_text(80, 22, title_text, INK, 2)
    for x in range(left, right, 80):
        rectangle(x, 60, x + 1, HEIGHT - 70, GRID)
    for y in range(60, HEIGHT - 69, 60):
        rectangle(left, y, right, y + 1, GRID)
    rectangle(left - 2, 58, left + 1, bottom + 3, INK)
    rectangle(left - 2, bottom, right + 3, bottom + 3, INK)

    maximum = max(values) if values else 1
    if horizontal:
        slot = (HEIGHT - 150) // max(1, len(values))
        for index, (label, value) in enumerate(zip(labels, values)):
            y = 75 + index * slot
            length = int((right - left - 55) * value / maximum)
            bar_height = max(12, slot - 14)
            rectangle(left + 2, y, left + 2 + length, y + bar_height, PALETTE[index % len(PALETTE)])
            compact_label = label[:24]
            draw_text(left - 12 - text_width(compact_label, 1), y + 4, compact_label, INK, 1)
            draw_text(left + 10 + length, y + 4, str(value), INK, 1)
    else:
        slot = (right - left) // max(1, len(values))
        for index, (label, value) in enumerate(zip(labels, values)):
            x = left + 25 + index * slot
            height = int((HEIGHT - 180) * value / maximum)
            bar_width = max(18, slot - 45)
            rectangle(
                x,
                bottom - height,
                x + bar_width,
                bottom,
                PALETTE[index % len(PALETTE)],
            )
            compact_label = label[:15]
            draw_text(
                x + (bar_width - text_width(compact_label, 1)) // 2,
                bottom + 12,
                compact_label,
                INK,
                1,
            )
            value_text = str(value)
            draw_text(
                x + (bar_width - text_width(value_text, 2)) // 2,
                bottom - height - 22,
                value_text,
                INK,
                2,
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
    year_counts = ", ".join(f"{year}: {len(by_year[year])}" for year in years)
    peak_total_year = max(years, key=lambda year: sum(by_year[year]))
    peak_mean_year = max(years, key=lambda year: sum(by_year[year]) / len(by_year[year]))
    modality_summary = ", ".join(f"{name}: {count}" for name, count in modality_items)
    report = root / "reports" / "report.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        "# BCI Literature Trends, 2023-2026\n\n"
        "## Method\n\n"
        "The analysis groups the fixed CSV records by year, modality, and semicolon-delimited keyword, then computes descriptive counts and citation summaries.\n\n"
        "## Data\n\n"
        f"The local seed corpus contains {len(rows)} records from 2023 through 2026 and {total_citations} total citations. It is a demonstration corpus, not a systematic literature review.\n\n"
        "## Findings\n\n"
        f"The yearly paper counts are {year_counts}. Citation totals peak at "
        f"{sum(by_year[peak_total_year])} in {peak_total_year}, while the mean is highest in "
        f"{peak_mean_year} at {sum(by_year[peak_mean_year]) / len(by_year[peak_mean_year]):.2f}. "
        f"The modality distribution is {modality_summary}. {keyword_items[0][0]} is the most "
        f"frequent keyword with {keyword_items[0][1]} appearances.\n\n"
        "## Limitations\n\n"
        "The corpus is small, curated, and partly synthetic. Citation totals are static seed values, so these results demonstrate reproducible workflow behavior rather than claims about the complete BCI field.\n",
        encoding="utf-8",
    )
    print(f"generated BCI demo outputs from {len(rows)} records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
