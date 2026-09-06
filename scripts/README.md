# scripts

Repo tooling.

- `release/` — packaging and release scripts (Tauri build matrix, signing/notarization
  helpers, GitHub Release upload, `latest.json` generation).
- `dev/` — local development helpers (bootstrap, run the app, seed the demo workspace).

## dev/ helpers added during the dsh migration (2026-09)

Run from the repo root.

### dsh bundle integrity
- `check-dsh-bundle.mjs [--root <dir>]… [--json] [--min-files N]`
  Sentinel-file integrity check for a bundled dsh tree (missing files here made
  the sidecar crash with a stack trace instead of a readable error). Defaults to
  `runtime/dsh`. Exit 0 = healthy.
- `test-dsh-bundle.mjs` — `pnpm test:dsh-bundle` (5 node:test cases incl. a
  "half-copied bundle" negative).

### Research pipeline (headless, uses the app's real dsh home)
- `run-research-pipeline.mjs [--smoke | --fidelity] [--keep]`
  Spawns the pinned sidecar against a copy of the app dsh home, auto-answers
  approvals/questions, and runs a bounded five-stage study with the configured
  model. `--smoke` = one cheap real turn; `--fidelity` forces one subagent per
  stage. Writes `status.json` / `run.log` under `%TEMP%/deeplab-rp-<mode>/`.
  Model spend is real and bounded; not a CI test.
- `check-research-recordings.mjs <workspace-root>`
  After an **in-app** `/research` run, asserts `.deeplab/runs.jsonl` (local runs),
  provenance rows for authored files, and content-addressed logs — the app-side
  recording chain B1 needed.

### WebView2 GUI driving (experimental)
- `cdp.mjs eval|text|click|fill …` (env `CDP_WS`) — raw CDP driver used to probe
  the packaged WebView2 (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`).
