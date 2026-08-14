# DeepLab — Product Requirements

> **Status (v1.0.2).** The runtime is **DeepSeek Harness (dsh)**, bundled as an
> isolated sidecar (one-click, auto-started, does not touch a user's own `~/.dsh`).
> This document describes the shipped product; forward-looking notes are marked
> *target*.

## 1. Positioning

**DeepLab** is an open-source AI research workbench with macOS / Windows / Linux
installers, positioned as an **open-source alternative to Claude Science style
products**. It ships a self-contained research environment on the DeepSeek Harness
(dsh) as the agent runtime.

It is not an ordinary paper-summarization tool. It is a local-first, model-agnostic,
reproducible, auditable research agent workbench that helps researchers do:

- Literature search
- Paper parsing
- Data analysis
- Code execution
- Figure generation
- Report writing
- Citation checking
- Artifact provenance
- Reusable research workflows

Slogan:

> Local-first, model-agnostic AI research workbench.

## 2. Goals

### 2.1 Non-negotiable pillars

| Pillar | Meaning |
| --- | --- |
| Local-first | Sessions, data, provenance, notebooks, and runs live in `~/Documents/DeepLab`. Nothing leaves by default. |
| Model-agnostic | The UI never calls a model directly — it goes through a pinned dsh sidecar. Providers, skills, MCP servers are pluggable. |
| Auditable | Every artifact traces to the code, inputs, environment, and conversation that produced it; review gates flag unsourced claims. |
| Safe by default | Command execution, deletion, installs, and remote connections are human-approved. No background network requests. |

### 2.2 Scope in / out

**In:** desktop workbench, bundled agent runtime, skills, MCP connectors, notebooks,
run records, provenance, review gates, gateway access from a LAN/phone, browser
control.

**Out:** hosted cloud, a proprietary model marketplace, telemetry/analytics, and any
automatic update downloads.

## 3. Users

| Persona | Need |
| --- | --- |
| Academic researcher | Read literature, run analysis, produce a figure + report, keep every number traceable. |
| Computational scientist | Run experiments (local/remote), inspect notebooks and run logs, reproduce benchmarks. |
| Students / hobbyists | Low-friction entry: one prompt for a starter workflow, no model lock-in. |
| Reviewer / PI | Audit a report's traceability and statistics before it is trusted. |

## 4. Key user journeys

### 4.1 New session (empty-session starters)

An empty session offers a quiet welcome plus four on-ramps:

1. **Build a bioinformatics tool** — the agent proposes 2–3 tool designs from the
   workspace literature, asks the user to pick, then implements a small CLI tool
   with synthetic-data validation, tests, README, and a report whose numbers trace
   to executed code.
2. **New browser action** — the agent opens a browser and waits; the user drives the
   page, then asks questions; every value traces to a page actually read.
3. **Build a phylogenetic tree** — the agent asks which sequence file to use (no
   bundled examples), then aligns with MAFFT, infers an ML tree with IQ-TREE (MFP +
   UFBoot + SH-aLRT), roots on an outgroup, draws a publication figure with toytree,
   and reports the model and support values.
4. **Clean conversation** — NOT a prompt: it opens a truly blank session. No preset
   roles, skills, or system template is loaded — the plainest, most token-efficient
   chat. The `sendPrompt` API accepts a `clean` flag to omit the artifact-presentation
   system message.

### 4.2 Image understanding / generation

- **Reading an image** is a chat turn routed to the configured **解读图片** model
  (`设置 → 模型`); the free Zhipu `glm-4v-flash` is offered automatically when the
  Zhipu provider is configured. Works on attached/pasted/workspace images.
- **Generating an image** is a **skill** task (`image-tools`): image models such as
  `cogview-3-flash` are not streaming chat models, so a chat turn against them fails
  with an SSE error. The skill instead calls the provider's `/images/generations`
  endpoint directly, saves the PNG to `figures/`, and presents it.

### 4.3 Organizing projects

Projects live under `~/Documents/DeepLab/projects/`. Each can be **pinned** to the
sidebar (pinned projects always show; unpinned show the most recent five) and given
an **accent color** (`set_project_color`, tokens red/orange/yellow/green/blue/
purple/gray). Imported external repos get an "imported" badge and are never written
to; deleting an imported project removes only its stub.

### 4.4 Queued prompts survive crashes

Each session's prompt queue (`enqueuePrompt`/`removeQueuedPrompt`/… and
`drainQueue`) is persisted to localStorage on every mutation and restored at startup,
so a quit or crash never loses queued work. Draft→session grafts and session deletion
carry/clean the persisted queues.

## 5. Feature requirements

| Area | Requirement |
| --- | --- |
| Runtime | Bundle a pinned dsh; auto-start; isolate from the user's own `~/.dsh` (`DSH_HOME`). |
| Sessions | Multi-session chat + history, per-session workspace folders, `/` commands, `!` shell mode, queue persistence, clean mode. |
| Skills | First-party core skills: traceability-review, stats-integrity, domain-check, large-file, publication-figures, remote-compute, modal-run, phylo-inference, image-tools. |
| Domain gate | `domain-check` covers physics, earth, biology, chemistry, social, phylogenetics, ecology, evolution. Deterministic, dismissible findings. |
| Projects | Pin + color; imported badge; delete keeps the user's files. |
| Multimodal | Vision routing (解读图片 model) + `image-tools` skill for generation. |
| Notebooks | Real `.ipynb`, Python/R kernels, bundled `uv` Jupyter env. |
| Runs | Append-only logs, global SQLite index, reproduce prompts. |
| Provenance | `.deeplab/provenance.jsonl`, artifact inspector. |
| Gateway | Token-authenticated access to the real UI from LAN/phone; loopback by default. |
| i18n | 2 languages (en, zh-Hans), parity-checked by tests. |
| Privacy | No telemetry; no auto-update downloads; credentials in app-private config only. |

## 6. Safety and privacy requirements

- Approval required for: command execution, file deletion, dependency install,
  remote connections. Approval mode is never shipped as `off`.
- The agent may only access the current workspace.
- API keys go to the app-private runtime config / OS credential store, never into
  provenance, logs, crash reports, git, or exported projects.
- The app itself makes no outbound network requests (the update checker was removed).

## 7. Non-functional requirements

- Works on macOS, Windows, Linux, and the gateway web client (including phone-width
  viewports). Native-only features are hidden in web mode.
- Every feature must produce a checkable result; tests run in CI (`pnpm test`,
  `pnpm typecheck`, `pnpm lint`, `cargo test`, `test_domain_check.py`).
- Keep the artifact schema and workflow templates stable and versioned.

## 8. Success metrics

- A first-time user can go from an empty session to a figure + traceable report in
  one session.
- A reviewer can resolve any number in a produced report to the code that made it.
- All disciplines covered by `domain-check` reject the classic silent error classes.
- i18n parity tests pass across all 2 locales.
