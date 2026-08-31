# examples/bci-trends

The built-in end-to-end demo project. It ships with a small seed corpus and a
dependency-free analysis pipeline, so the dsh agent can execute, verify,
explain, and present a deterministic workflow without web access or package
installation.

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
.deeplab/runs.jsonl
.deeplab/provenance.jsonl
```

`demo-contract.json` defines the accepted data, summary schema, figures, and
report facts. In DeepLab, run `python scripts/analyze.py` and then
`python verify.py` as two separate commands. This lets DeepLab attribute every
output to the analysis run before the verifier writes the machine-generated
`reviews/review.md`. Developers can use `python verify.py --rerun` for a quick
off-app contract check.

The agent must not create either `.deeplab` JSONL file. DeepLab records the run
and links its outputs to provenance from dsh tool events. After a run inside the
desktop app, `python verify.py --require-platform-records` also audits those
platform-owned records.

## Workspace layout (mirrors a real project)

```text
data/{raw,processed}/   papers/   parsed/   scripts/   notebooks/
figures/   reports/   artifacts/   reviews/   .deeplab/
```

The pipeline is bundled rather than written live by the model. This keeps a
classroom demonstration reproducible while leaving orchestration, execution,
verification, interpretation, artifact presentation, and approval handling to
the dsh agent. Output directories are seeded empty and populated during the run.
