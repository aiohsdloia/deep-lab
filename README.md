<div align="center">

# DeepLab

**Local-first, model-agnostic AI research workbench for macOS, Windows & Linux — powered by the DeepSeek Harness (dsh) agent runtime.**

DeepLab is an open-source desktop alternative to Claude Science and similar
AI-for-science workbenches. It reproduces the functionality of
[Open Lab](https://gitee.com/sculab/openscience) — projects, sessions,
provenance, runs, review skills, viewers, notebooks, remote compute, and a
token-authenticated gateway — but replaces the agent runtime with the
**DeepSeek Harness**: `dsh --profile web` runs as a bundled sidecar and the UI
talks to it through the dsh `/api` HTTP+WebSocket gateway (the dsh client
framework), instead of an OpenCode sidecar.

<p>
  <b>English</b>
</p>

<p>
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20React-24C8DB" alt="Built with Tauri + React">
  <img src="https://img.shields.io/badge/runtime-DeepSeek%20Harness-success" alt="dsh runtime">
</p>

</div>

---

## What it does

**Runs the whole research loop** — from a broad direction to a finished report:
exploration, literature survey, experiment code, analysis, figures, and write-up,
in one continuous, auditable session.

- **Everything traces back** — figures, tables, reports, notebooks, and run outputs
  link to the exact code, inputs, environment, model output, and conversation that
  produced them. The domain-check gate audits code for the classic error classes of
  each field before it is presented.
- **Local-first and yours** — sessions, data, provenance, notebooks, and run records
  live in `~/Documents/DeepLab` on your machine. Nothing leaves by default; the app
  makes **no background network requests**.
- **Model-agnostic runtime** — the UI talks through `packages/sdk` to a bundled,
  pinned dsh sidecar. Bring your own model; providers, skills, and MCP servers
  stay pluggable.
- **Reproducible by construction** — local, SSH/Slurm, Modal, and notebook-batch runs
  are captured as reproducible run records, not loose terminal scrollback.
- **Organize your work** — projects are pinned to the sidebar and colored, each with
  its own workspace folder; per-session prompt queues are persisted across crashes;
  global history is searchable across every workspace.
- **Reach it from anywhere** — a built-in, token-authenticated gateway serves the
  *real* desktop UI to a browser on your LAN or phone.
- **Plan before it acts** — `/plan` lays out an execution plan before touching a
  file, and `/goal` fixes the objective, constraints, and acceptance criteria the
  agent then works toward.

### Platform

| Area | State |
| --- | --- |
| Desktop shell | Tauri 2 + React + TypeScript + Vite, with macOS, Windows, and Linux desktop builds. |
| Runtime | Bundled DeepSeek Harness sidecar (`runtime/dsh/launcher.mjs`), auto-started by the app with an app-private `DSH_HOME`, isolated from the user's own `~/.dsh`. |
| Projects | Pinned projects with accent color, own workspace folder, import/rename/delete. |
| Sessions | Multi-session chat/history, `/` commands, `!` shell mode, persisted prompt queues, searchable history. |
| Agent modes | `/plan` for plan-then-execute, `/goal` for objective and acceptance criteria. |
| Memory | Global and per-project memory layers plus automatic context compaction. |
| Remote compute | Register machines from `~/.ssh/config`, probe them, submit/track/cancel jobs. |
| Runs | Append-only run logs, global SQLite run index, search/facets/pagination. |
| Provenance | `.deeplab/provenance.jsonl` tracks file versions and links artifacts to the run or edit that created them. |
| Review | First-party scientific skills: traceability-review, stats-integrity, domain-check, large-file, publication-figures, remote-compute, modal-run, phylo-inference, image-tools. |
| Viewers | PDF, image, video, HTML, Markdown, code, CSV/TSV with charts, DOCX, XLSX, PPTX, molecules, 3D meshes, genome tracks, FITS, bands, and more. |
| Gateway | Token-authenticated gateway that serves the real UI to a CLI, a LAN browser, or a phone. |
| Models | dsh's provider catalog (settings/credentials/llm domains). |
| Interface languages | English and Simplified Chinese. |

## Runtime swap: OpenCode → DeepSeek Harness

The defining difference from Open Lab is the agent runtime:

| | Open Lab | DeepLab |
| --- | --- | --- |
| Sidecar | `opencode serve` binary | `dsh --profile web` (Node CLI via `runtime/dsh/launcher.mjs`) |
| Transport | OpenCode HTTP + SSE | dsh `/api` HTTP POST unary + `/api/events.mux` `/api/events.host` WebSocket downlinks |
| SDK | `OpenCodeClient` | `DshRuntime` (same `AgentRuntime` seam; `OpenCodeClient` retained as reference) |
| Sessions | OpenCode session/message | dsh `session.*` RPC + session-log event folding |
| Skills | `<xdg>/opencode/skills/` | `<dsh-home>/skills/` + workspace `.dsh/skills/` |
| Providers/MCP | OpenCode config API | dsh `llm.*` / `credentials.*` / `settings.*` (MCP wired in cordis.yml) |

Everything else — the thread, provenance, runs, projects, review, viewers,
notebooks, remote compute, and gateway — is runtime-agnostic and unchanged.

## Build from source

Prerequisites: Node.js >= 22, pnpm, Rust toolchain, Tauri system deps.

```bash
git clone <this repo> DeepLab
cd DeepLab
pnpm install

# Fetch pinned sidecar and bundled skills (git-ignored).
bash scripts/dev/fetch-dsh.sh
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh

# Run in development or build installers.
pnpm --filter @deeplab/desktop tauri dev
pnpm --filter @deeplab/desktop tauri build
```

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

A live smoke test (`apps/desktop/src/test/dsh-live.smoke.test.ts`) connects
`DshRuntime` to a running dsh server and is skipped when no server is up.

## Safety and privacy

- Workspace files, raw data, session history, provenance, notebooks, and run records
  stay local by default. The app makes **no outbound network requests on its own**.
- Command execution, file deletion, dependency installation, and remote connections
  are human-approved flows in the desktop app (approval mode is never shipped off).
- Provider credentials are written to app-private runtime config, not to the
  workspace, provenance, git, exports, or global dsh config.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/desktop/` | Tauri + React desktop app. |
| `packages/sdk/` | `AgentRuntime` seam + `DshRuntime` (dsh client framework). |
| `packages/shared/` | Shared domain types and chart palette. |
| `packages/ui/` | Shared UI package. |
| `runtime/skills/core/` | First-party scientific skills. |
| `runtime/skills/external/` | Build-fetched external skills. |
| `runtime/dsh/` | Bundled dsh sidecar (launcher + pinned CLI). |
| `runtime/dsh-acp/` | Bundled DeepSeek Harness ACP agent. |
| `docs/` | Product, technical, operator, connector, and research notes. |
| `scripts/dev/` | Sidecar, `uv`, skill fetchers. |

## Status

DeepLab is a working desktop MVP derived from Open Lab with the runtime swapped
to the DeepSeek Harness. The most reliable current implementation log is
[`PROGRESS.md`](./PROGRESS.md). Known deviations from Open Lab (dsh v1 API gaps)
are listed there.

## License

[MIT](./LICENSE). Bundled third-party skills and connectors keep their own licenses.

> DeepLab is beta research tooling. Treat outputs as drafts: verify numbers,
> citations, code, and conclusions before publication or decision-making.
