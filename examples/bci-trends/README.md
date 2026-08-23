# examples/bci-trends

The built-in end-to-end demo project, used for the README, website, screenshots,
video, and release marketing. It ships with a small seed corpus at
`data/raw/bci_literature_seed.csv` so the agent can produce a deterministic
workflow without web access.

Task:

> 2023–2026 brain–computer interface literature trends

Expected outputs (a full project workspace):

```text
plan.md
data/raw/bci_literature_seed.csv
data/processed/corpus_summary.csv
scripts/analyze.py
figures/year_trend.png
figures/topic_clusters.png
figures/top_keywords.png
reports/report.md
reviews/review.md
provenance.jsonl
```

## Workspace layout (mirrors a real project)

```text
data/{raw,processed}/   papers/   parsed/   scripts/   notebooks/
figures/   reports/   artifacts/   reviews/   provenance.jsonl   manifest.json
```

Most directories are seeded empty; the demo content is produced when the workbench
runs the workflow against the local seed corpus.
