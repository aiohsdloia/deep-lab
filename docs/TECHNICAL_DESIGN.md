# DeepLab — Technical Design

> Companion to [`docs/PRD.md`](./PRD.md). Describes the shipped architecture (v1.0.2)
> and the reasoning behind the significant decisions. Forward-looking notes are
> marked *target*.

## 1. Technical goals

- **Local-first.** All state lives on the machine (`~/Documents/DeepLab`); no
  mandatory network access, no telemetry.
- **Model-agnostic.** The UI never calls a model directly. It speaks to a bundled,
  pinned **DeepSeek Harness (dsh)** sidecar over its `/api` gateway (HTTP POST
  unary + WebSocket event downlinks).
- **Decoupled.** Frontend (React), desktop shell (Tauri/Rust), and agent runtime
  (dsh) stay separate layers with narrow, typed boundaries.
- **Verifiable.** Every artifact and number is traceable; review gates and a
  deterministic domain gate run before results are presented.

## 2. Overall architecture

```
┌────────────────────────────────────────────────────────────┐
│ Frontend  (React + Vite + Tailwind, packages/ui)           │
│   zustand stores · react-router · i18next (2 locales)      │
└───────────────┬────────────────────────────────────────────┘
                │ packages/sdk (DshRuntime) — the ONLY way
                │ the UI touches the runtime
┌───────────────▼────────────────────────────────────────────┐
│ Desktop shell (Tauri 2, Rust)  — window, commands, files   │
│   runtime.rs (dsh spawn, DSH_HOME) · project.rs · debug_log│
│   git_snapshot.rs · settings_io.rs · provenance.rs         │
└───────────────┬────────────────────────────────────────────┘
                │ spawns node runtime/dsh/launcher.mjs +
                │ talks to /api (HTTP + WebSocket, loopback)
┌───────────────▼────────────────────────────────────────────┐
│ dsh sidecar (pinned @deepseek-ai/dsh)  — agent runtime     │
│   app-private DSH_HOME · bundled skills · cordis.yml rows  │
└────────────────────────────────────────────────────────────┘
```

The UI's session view (composer, thread, artifact inspector) is a client of the
sidecar's `/api` gateway. Unary calls POST a `ClientRequest` envelope to
`/api/<method>`; the two event streams (`/api/events.mux`, `/api/events.host`)
are WebSocket downlinks whose frames are `ServerRequest` envelopes carrying
`MuxFrame`/`HostFrame`. `DshRuntime` folds dsh `session/event` frames into the
normalized `OpenCodeEvent` shapes the store already consumed, so the thread,
provenance, and runs layers are runtime-agnostic above the SDK seam.

## 3. Tauri over Electron

- Rust sidecar-control (spawn, probe, restart) is far lighter than Electron's
  Node-side control.
- Native dialogs, open-in-terminal, and file operations are first-class.
- The web gateway client reuses the same React frontend with the native-only
  surfaces hidden behind `isGatewayWeb`.

## 4. Frontend

- **Stores** (`apps/desktop/src/lib/`): `runtime.ts` (sessions, threads, queues,
  models, projects, event folding), `layout.ts` (tiling), `ui.ts`, `store.ts`,
  `chartPalette.ts`, `csv.ts`, `dos.ts`, `fits.ts`, `genome.ts`.
- **Threads** are append-only block lists (`user`, `text`, `tool`, `artifact`, …)
  with an index; only `session.idle` may clear the running/shell/step maps.
- **Per-session models**: each pane can pin `provider/model` + a reasoning variant,
  sent per turn, persisted to localStorage.
- **Prompt queues**: `queues: Record<sid, string[]>` with FIFO
  `enqueuePrompt → drainQueue` on idle, persisted and reloaded across crashes.
- **Reconnect safety**: `justIdledSessions` prevents a sidecar-restart replay of a
  finished turn from re-locking a session.

## 5. Agent runtime

- dsh is pinned (`DSH_VERSION` in `packages/sdk/src/types.ts`) and installed into
  `runtime/dsh/` by `scripts/dev/fetch-dsh.sh`. The Rust shell spawns
  `node runtime/dsh/launcher.mjs --profile web --host 127.0.0.1 --port <port>` with
  an app-private `DSH_HOME` (under the runtime root), so it never touches the
  user's own `~/.dsh`.
- The dsh `/api` gateway serves loopback-only by default with a browser-trust
  fence; no sidecar password exists (unlike OpenCode's `OPENCODE_SERVER_PASSWORD`).
  The remote-access gateway's token is the only auth a LAN/phone client needs.
- Bundled skills are deployed from the `skills-core/`, `skills/`, and
  `skills-office/` Tauri resources into `<DSH_HOME>/skills/` on every sidecar
  start; user skills live in the workspace's `.dsh/skills/` and are never
  overwritten.

## 6. Skills & MCP

- **First-party core skills** (`runtime/skills/core/`): `traceability-review`,
  `stats-integrity`, `domain-check`, `large-file`, `publication-figures`,
  `remote-compute`, `modal-run`, `phylo-inference`, `image-tools`.
- **Domain gate** (`domain-check/domain_check.py`): stdlib-only AST analysis. One
  `check_<field>` per discipline, appended to `VALIDATORS`. Disciplines: physics,
  earth, biology, chemistry, social, **phylo**, **ecology**, **evolution**.
- **image-tools skill**: reading = vision chat model; generation = direct
  `/images/generations` POST using the provider's `baseURL`+`apiKey` from the
  app-private config, PNG saved to `figures/`.
- **External packs** (`runtime/skills/external/`, git-ignored, fetch via
  `scripts/dev/fetch-skills.sh`): `ai4s-skills` and Anthropic office skills
  (docx, pdf, pptx, xlsx).
- **MCP connectors**: dsh configures MCP servers as `cordis.yml` plugin rows, not a
  runtime API. The app's own connectors deploy with the bundled profile; runtime
  `addMcpServer` is a documented no-op (`DshRuntime` throws a descriptive error).

## 7. Execution layer

- **Bash / tools**: dsh runs tools inside the current workspace; command
  execution is human-approved (approval mode is never shipped off).
- **Notebooks**: real `.ipynb` files executed by a local Jupyter kernel; a managed
  Python environment is provisioned with the bundled `uv`.
- **Runs**: append-only logs + a global SQLite index; local, SSH/Slurm, Modal, and
  notebook-batch surfaces; each run is a reproducible record.
- **Provenance**: `.deeplab/provenance.jsonl` records file versions and links
  artifacts to the run/edit that produced them.

## 8. Local Runtime Manager

`runtime.rs` owns the base directory resolution. Current default is
`~/Documents/DeepLab`; on first launch it migrates the older names in order
(`~/Documents/OpenLab`, `~/Documents/OpenScience`, `~/Documents/Open Science`,
the old runtime `workspace`). `settings_io.rs` uses `deeplab-settings.json` for
exported settings.

## 9. Storage

| Layer | Backing |
| --- | --- |
| Sessions + history | dsh session log (appended JSONL events; dsh persistence); frontend folds threads in memory. |
| Per-session models/queues | localStorage (`deeplab.*` keys). |
| Projects | `~/Documents/DeepLab/projects/<id>/.deeplab/project.json` (id, name, pinned, color, sourcePath/importedFrom). |
| Runs index | Global SQLite. |
| Provenance | `.deeplab/provenance.jsonl` per workspace. |
| Exported settings | `deeplab-settings.json`. |

## 10. Artifact provenance

The artifact inspector opens any produced artifact (figure, report, notebook) and
shows the generating script, the input files, and the conversation that produced it.
Provenance entries are append-only and dismissible; nothing is rewritten silently.

## 11. Security

- Workspace sandbox: the agent only accesses the current workspace.
- Approvals: command execution, file deletion, dependency install, remote connect.
- Credentials: app-private config / OS keychain; never into provenance, logs, git,
  or exports.
- No outbound requests from the app itself (update checker removed).
- Gateway (when enabled) is token-authenticated and loopback-bound by default.

## 12. Packaging & release

- `tauri build` produces `.app`/`.dmg` (macOS), `.exe`/`.msi` (Windows), `.deb`/`.rpm`
  (Linux). The dsh sidecar, uv, and skill packs are fetched by `scripts/dev/*.sh`
  before building (git-ignored). Not signed/notarized yet.
- The dsh sidecar requires a Node runtime; releases bundle one (dev uses system
  node; override with `DEEPLAB_NODE`).

## 13. Process model

- The app spawns one dsh sidecar on a stable free port; split panes attach
  per-directory background streams via `clientForSession` (dsh's mux stream is
  global, so a background stream simply re-folds the same events idempotently).
- WebSocket downlinks are self-healing: `connect()` opens both streams and the
  store's reconcile backstop clears any stale running lock.

## 14. High-performance design

- Per-field zustand selectors prevent whole-map repaints during streaming.
- `log_debug` is `#[tauri::command(async)]` and appends on a blocking thread
  (`spawn_blocking`) so rotating debug.log never blocks the UI thread.
- Event logging throttles high-frequency `text.updated`/`reasoning.updated`/running
  `tool.updated` events.

## 15. Repository structure

See [`README.md`](./README.md#repository-layout).

## 16. Final stack

Tauri 2 + React + TypeScript + Vite · Tailwind + Radix UI · Zustand · i18next ·
DeepSeek Harness sidecar (HTTP + WebSocket `/api`) · SQLite + JSONL provenance ·
Python (stdlib-only gates) · bundled `uv`/Jupyter.
