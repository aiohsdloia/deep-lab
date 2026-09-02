# DeepLab Project Handoff Report

Date: 2026-09-02

Repository: `C:\Users\10840\Documents\ChatGPT\deeplab`

Branch: `codex/week-1-dsh-foundation`

Implementation baseline: `f425e21` (`docs: record installed research pipeline acceptance`)

Product version: `1.0.2`

## 1. Executive decision

DeepLab is **substantially formed as an initial, usable dsh-native desktop
product**. It can be installed and launched on this Windows machine, start its
bundled DeepSeek Harness sidecar, configure an official or OpenAI-compatible
model, run agent sessions with approval controls, manage research workspaces,
record runs and provenance, execute the bundled BCI example, expose a research
pipeline, and optionally run the complete upstream DeepSeek usage whale as a
standalone desktop widget.

DeepLab is **not yet a finished OpenLab replacement or a production release**.
The remaining work is no longer foundation work; it is release hardening,
OpenLab parity closure, full installed-app acceptance, and repeatable
cross-platform packaging. The correct next action is to continue from the
current repository, not restart or replace it.

The most precise status description is:

> DeepLab 1.0.2 is a working beta and a credible initial product. Its primary
> architecture and user path are established, but complete OpenLab feature
> parity and production-grade distribution are still in progress.

## 2. Product direction and decisions already made

### 2.1 This was not a rewrite of the teacher's DeepLab

The work continued the existing DeepLab direction. It did not create a new
parallel application and did not discard the original product structure.

The retained product layer includes:

- the Tauri desktop shell and React workbench;
- projects, workspaces, sessions, files, viewers, notebooks, and layouts;
- research runs, provenance, artifacts, history, and remote-compute surfaces;
- the gateway web client and Chinese/English interface;
- OpenLab workspace compatibility where it is safe to retain.

The replaced layer was the old runtime assumption. OpenCode and ACP were
removed as competing agent runtimes, and dsh became the only runtime. This is a
runtime migration inside the existing workbench, not a new product built from a
written list of OpenLab features.

### 2.2 OpenLab remains the product baseline

OpenLab is still the reference for the major product functions that users
expect. DeepLab does not aim to implement only a small collection of generic
"research features." The goal is to preserve or migrate most of OpenLab's
useful workbench behavior while changing the underlying harness.

Feature ownership is deliberately divided:

| Owner | Responsibilities |
| --- | --- |
| DeepLab | Projects, workspace files, notebooks, artifact viewing, runs, provenance, layout, remote compute, gateway, and desktop UX. |
| dsh | Agent sessions, model invocation, event streams, credentials, permissions, skills, presets, goals, and runtime state. |
| Mixed integration | Model/provider settings, MCP composition, plan/goal UI, queues, workflow projections, memory, usage, and tool-result presentation. |

For mixed features, DeepLab should adapt dsh's real domains and projections.
It must not recreate obsolete OpenCode behavior or maintain a second source of
truth.

### 2.3 "Local model" means the laboratory server

Future local inference is expected to run on laboratory servers, potentially a
2 x 6000 Pro 96 GB or 8 x 4090 48 GB host. DeepLab will access that service
through an internal OpenAI-compatible endpoint and server credentials. It does
not mean that the model must run on the user's laptop.

The app-private local component is dsh itself: DeepLab owns an isolated
`DSH_HOME`, profile, skills, credentials references, and event state. Model
serving is a separate infrastructure concern and must not block product work.

## 3. Architecture at handoff

### 3.1 Main stack

| Layer | Current implementation |
| --- | --- |
| Desktop | Tauri 2, Rust, React, TypeScript, Vite |
| Agent runtime | Pinned `@deepseek-ai/dsh` `0.1.1-rc.2` |
| Runtime launch | Bundled sidecar using `runtime/dsh/launcher.mjs` and the `web` profile |
| Runtime SDK | `packages/sdk`, with `AgentRuntime` as the boundary and `DshRuntime` as the only implementation |
| RPC | HTTP POST to dsh `/api/*` methods |
| Events | WebSocket streams `/api/events.mux` and `/api/events.host` |
| Desktop bridge | Rust same-origin gateway proxies dsh HTTP and WebSocket traffic to the WebView |
| Runtime isolation | App-private `DSH_HOME`, `DSH_AGENTS_HOME`, and XDG directories |
| Research records | Workspace `.deeplab/` metadata, append-only JSONL provenance, and a global SQLite run index |
| Packaging | Tauri bundle with dsh, skills, presets, commands, tools, examples, and optional whale resources |

The UI must continue to call the runtime through `packages/sdk`. Direct dsh
calls from React components would break the primary architecture boundary.

### 3.2 Runtime capabilities

The current capability contract in
`packages/sdk/src/dsh/DshRuntime.ts` is the authoritative runtime feature gate.

Available:

- session fork and archive;
- skills, agents, and slash commands;
- interactive questions and per-operation permission responses;
- model selection, write-only credentials, goals, and custom providers;
- desktop-host MCP configuration through the app-owned Cordis bridge.

Explicitly unavailable in the pinned composition:

- session restore, permanent delete, and move;
- historical message revert/edit and synthetic message parts;
- remembered or persistent permission grants;
- OAuth authentication;
- dynamic MCP configuration without the desktop host bridge.

The UI already hides or blocks unsupported operations. A future agent must not
turn those flags on until an actual dsh-native implementation and tests exist.

### 3.3 Important directories on this machine

| Purpose | Path |
| --- | --- |
| Source repository | `C:\Users\10840\Documents\ChatGPT\deeplab` |
| Installed executable | `C:\Users\10840\AppData\Local\Programs\DeepLab\deeplab-workbench.exe` |
| User workspaces | `C:\Users\10840\Documents\DeepLab` |
| Private app runtime | `C:\Users\10840\AppData\Roaming\com.sculab.deeplab\runtime` |
| Deployed dsh skills | `%APPDATA%\com.sculab.deeplab\runtime\dsh-home\skills` |
| Deployed dsh commands | `%APPDATA%\com.sculab.deeplab\runtime\xdg-config\dsh\command` |
| Current Windows installer | `apps\desktop\src-tauri\target\x86_64-pc-windows-gnu\release\bundle\nsis\DeepLab_1.0.2_x64-setup.exe` |

The current installer SHA-256 is:

```text
91A21679C83AE7DCA89B7736C2A65F41C6486067FDCA06F0F3236F1C949F7564
```

## 4. Implemented capability inventory

### 4.1 Product capabilities

| Area | State | Evidence or qualification |
| --- | --- | --- |
| Windows desktop startup | Accepted | Installed executable and desktop shortcut launch a stable application. |
| Bundled dsh lifecycle | Accepted | Automatic start, transient port retry, exited-process detection, and respawn are implemented. Fault injection recovered in 13.3 seconds. |
| Project/workspace management | Implemented | Create/import/pin/rename/delete projects with workspace-scoped sessions. |
| Sessions and history | Implemented | Multi-session chat, archive, fork, global search, event replay, titles, and running-state recovery. Unsupported lifecycle actions are gated. |
| Prompt queue | Implemented | Per-session persisted queue with edit/remove/steer behavior and recovery paths. |
| Agent modes | Implemented | Dsh-native preset picker, `/plan`, `/goal`, reviewer preset, and read-only review path. |
| Questions and approvals | Implemented | Dsh event mapping, response receipts, recovery, explicit full-access confirmation, and workspace-write default. |
| Official DeepSeek API | Accepted | A real model response and an approved file-writing tool turn were previously verified. |
| Custom/lab model endpoint | Accepted at integration level | Add/list/select/remove an OpenAI-compatible endpoint through dsh domains; `/models` discovery and manual models are supported. |
| Runs and provenance | Implemented | Append-only run records, SQLite index, search/facets/paging, content-addressed logs, and `.deeplab/provenance.jsonl`. |
| Artifacts and viewers | Implemented | PDF, image, video, HTML, Markdown, code, tabular data/charts, Office, molecule, mesh, genome, FITS, and band-data surfaces are present. |
| Notebooks | Implemented, environment-dependent | Python/R notebook creation and editor surfaces exist; Jupyter setup and kernels depend on host tools/connectors. |
| Remote compute | Implemented, environment-dependent | SSH config discovery, probing, Slurm/job actions, and supporting skills are present; each laboratory environment still needs acceptance. |
| MCP connectors | Implemented through desktop bridge | Cordis configuration, credential references, Jupyter/browser/science connector UI, enable/disable, and sidecar reload are present. |
| Gateway web client | Implemented | Token-authenticated LAN/phone client, same UI, reconnect paths, and file preview routes exist. Latest release still needs a complete mobile regression pass. |
| Internationalization | Implemented | English and Simplified Chinese are current supported interface languages. Some old docs mention a previous seven-language state and are not authoritative. |
| BCI example | Accepted | Deterministic pipeline, versioned artifact contract, tamper-negative verification, figures, report, runs, and provenance are bundled. |
| Research pipeline | Installed and discovered | Five dsh-native research skills and `/research` are deployed and discovered by the real pinned sidecar. A full model-driven study remains a next-stage acceptance test. |
| Whale widget | Accepted on Windows | Complete upstream v0.2.10 client, optional switch, independent transparent always-on-top window, full-display dragging, settings/menu/interactions, and balance/usage queries. |

### 4.2 Dsh-native research pipeline

The current pipeline is not a mock UI. It consists of five first-party dsh
skills:

1. `ai4s-agent` coordinates the research process and delegates work.
2. `research-explorer` narrows a broad direction into testable questions.
3. `literature-survey` performs reproducible search, deduplication, and evidence organization.
4. `experiment-suite` builds and verifies executable experiments and artifacts.
5. `paper-writer` converts verified evidence and outputs into a structured draft.

DeepLab also includes scientific review and execution skills such as
`traceability-review`, `stats-integrity`, `domain-check`, `large-file`,
`publication-figures`, `remote-compute`, `modal-run`, `phylo-inference`,
`image-tools`, and `word-revise`.

The installed app-managed dsh instance returned a 22-skill catalog and included
all five new pipeline skills. The `/research` command was also deployed. This
proves packaging and dsh discovery, but it is not equivalent to completing a
long, real, model-driven research project.

### 4.3 Whale widget integration contract

The user's requirement is that DeepLab only owns the enable/disable control and
does not redesign or reduce the plugin. Preserve these invariants:

- the bundled client remains the complete upstream widget;
- DeepLab-specific code is limited to packaging, authenticated asset access,
  lifecycle control, and the native transparent host;
- the widget is a standalone desktop window and survives hiding the main app;
- the original settings, menu, animations, audio, interaction, balance, usage,
  and last-turn-cost behavior remain available;
- it can be dragged across the active display work area, not only inside the
  DeepLab window;
- transparent pixels pass pointer input through where possible;
- starting DeepLab or enabling the widget must not reveal a Node/dsh console or
  an inherited native application menu.

Do not replace it with a simplified React imitation or add DeepLab controls
inside the widget.

## 5. Verification evidence

The latest research-pipeline milestone recorded the following successful
checks:

- full frontend suite: 118 test files passed and 1 skipped;
- assertions: 910 passed and 4 skipped;
- `pnpm typecheck` passed;
- `pnpm lint` passed;
- `pnpm build` passed;
- `pnpm test:dsh-research` passed 4/4, including a real temporary dsh launch and skill discovery;
- focused workflow starter tests passed 8/8;
- `pnpm test:dsh-presets` passed;
- installed Windows app attached to an existing session and discovered the deployed pipeline.

Other milestone-specific acceptance includes:

- real DeepSeek chat and approved workspace file writing;
- isolated custom-provider add/list/select/remove round trips;
- dsh-native MCP bridge tests;
- deterministic BCI contract and tamper checks;
- whale vendor-integrity, real-dsh mounting, balance/usage, native-window, menu,
  transparency, full-display drag, and main-window-independence checks;
- forced dsh termination and automatic recovery.

The full frontend run emits known React `act(...)` and canvas warnings but no
test failures. Do not hide new failures under those existing warnings.

## 6. What is not finished

### 6.1 OpenLab parity gaps

The migration is broad but not complete. The most important remaining gaps are:

- native restore/delete/move semantics for dsh sessions;
- historical message editing/revert, which dsh v1 does not expose;
- generalized provider/model/session usage and cost accounting beyond the
  DeepSeek whale path;
- exhaustive recovery testing for plan, goal, queue, jobs, subagents, workflow,
  compaction, and memory after process restarts;
- full real-environment acceptance for Jupyter, browser/science MCP connectors,
  SSH/Slurm, and Modal;
- per-skill real-task acceptance for auxiliary skills, including mind-map and
  integrity workflows that still live primarily in the external pack;
- a documented, tested migration path for every legacy `.openlab` metadata
  case while all new writes remain `.deeplab`;
- application self-update and mature release distribution.

`docs/migration/OPENLAB-FEATURE-MATRIX.md` was written on 2026-08-23 and is now
partly stale. For example, it still labels custom providers and the five
research skills as missing even though later commits implemented them. Use it
as the original scope, not as the current status. This report, the runtime
capability flags, tests, and `PROGRESS.md` are more current.

### 6.2 Release and platform gaps

- The latest complete installed-app acceptance was performed on Windows.
- macOS and Linux behavior exists in the codebase, but the latest whale,
  research-pipeline, and packaging changes have not received equivalent fresh
  installed-app acceptance on both platforms.
- This Windows host does not have MSVC Build Tools. Its default `link.exe` is
  an MSYS utility, so default Rust test linking fails for environmental reasons.
- A GNU Rust target can build the application, but some Rust test executables
  previously hit a GNU/WebView `STATUS_ENTRYPOINT_NOT_FOUND` mismatch.
- The large bundled dsh dependency tree caused NSIS path-length problems. The
  successful installer required generated-NSIS path normalization and temporary
  short drive mappings. That process is not automated in the repository.
- Launching the installer from the Microsoft Store-packaged Codex environment
  can virtualize `%LOCALAPPDATA%` into the Codex package `LocalCache`. The real
  installation was therefore deployed under
  `C:\Users\10840\AppData\Local\Programs\DeepLab`. A normal external installer
  run and a clean-machine test are still required.

The existing installer is useful for this machine, but the release process is
not yet reproducible enough to call production-ready.

### 6.3 Remaining cleanup debt

Some legacy names and comments remain, for example an `Open Lab` HTML title,
old settings-export filenames, compatibility comments, old RFC descriptions,
and OpenCode-oriented helper text in an image skill. These do not mean OpenCode
is still an active runtime, but they should be classified carefully:

- retain code that intentionally reads legacy OpenLab workspaces;
- migrate new write paths and visible branding to DeepLab;
- update stale documentation;
- remove dead fetch scripts and dependencies only after proving they are not
  used by packaging or compatibility tests.

Do not perform a broad search-and-replace across legacy names. Compatibility
paths are deliberate in several Rust modules.

## 7. Build, test, and run instructions

Use Node.js `^22.19.0` or `>=24`, pnpm `9.4.0`, Rust, and the Tauri platform
dependencies.

```powershell
Set-Location C:\Users\10840\Documents\ChatGPT\deeplab
pnpm install
```

Fetch ignored bundled dependencies when setting up a fresh checkout. These
scripts are Bash scripts and require a suitable shell:

```bash
bash scripts/dev/fetch-dsh.sh
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh
```

Development and standard checks:

```powershell
pnpm --filter @deeplab/desktop tauri dev
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:dsh-mcp
pnpm test:dsh-presets
pnpm test:dsh-research
pnpm test:dsh-whale
pnpm test:bci-demo
```

On this machine, use the GNU Rust target for a release application build:

```powershell
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
pnpm --filter @deeplab/desktop tauri build --target x86_64-pc-windows-gnu
```

Expect the NSIS path-length issue described above. Do not claim the installer
pipeline is fixed merely because the Rust executable builds. Automating a short
staging path or producing a deliberately flattened sidecar payload should be a
separate, tested packaging change.

## 8. Data, safety, and credential rules

- The agent may access only the current workspace by default.
- Workspace-write approval remains the default. Full filesystem access requires
  an explicit user confirmation and must never become the shipped default.
- API keys must go through dsh credentials/app-private storage. Never place them
  in source, workspace metadata, provenance, logs, crash reports, examples, or
  exported projects.
- A DeepSeek API key was shared in a previous conversation. It is not present in
  tracked repository files, but it should be treated as exposed conversational
  data and rotated before any public release or broader handoff.
- No git remote should be added and nothing should be pushed unless the user
  explicitly requests it.
- The worktree may contain user changes. Read and preserve them; never reset or
  revert unrelated work.
- The user canceled an earlier cleanup request. Do not delete other Codex
  workspaces or archived tasks. In particular, preserve the AMP-related project
  at `C:\Users\10840\Documents\Codex\2026-07-23\ni-d`.

## 9. Recommended continuation plan

### P0: Make the current beta reproducible

1. Automate the Windows package staging so NSIS succeeds without manual `subst`
   mappings or generated-script edits.
2. Test the installer from a normal external shell on a clean Windows user or
   VM and confirm installation under the real `%LOCALAPPDATA%\Programs` path.
3. Create an installed-app acceptance script covering first launch, dsh startup,
   provider setup, one streamed chat, one approved file write, restart/session
   recovery, research skill discovery, and optional whale lifecycle.
4. Update the stale migration matrix from actual code and acceptance evidence.

### P1: Close the main OpenLab parity gaps

1. Audit plan, goal, queue, jobs, subagents, workflow, memory, compaction, and
   usage against dsh projections and restart recovery.
2. Run real Jupyter, browser/science MCP, SSH/Slurm, and artifact workflows and
   repair only failures supported by reproducible tests.
3. Complete generalized usage accounting while preserving the upstream whale's
   independent provider-specific behavior.
4. Validate legacy OpenLab project import and ensure all new metadata writes use
   `.deeplab`.
5. Decide unsupported session actions explicitly: wait for dsh support, define a
   safe DeepLab-owned semantic, or keep them absent. Do not fake support.

### P1: Prove the research workflow

Run one bounded end-to-end study with a configured model:

- start from `/research` or the visible starter;
- produce exploration and literature evidence;
- generate and execute a small experiment;
- produce figures and a report;
- verify run records, provenance, references, and restart recovery;
- record failures by stage and add focused contract tests.

The BCI example is a useful deterministic fixture, but the project objective is
OpenLab capability migration, not a BCI-only product.

### P1/P2: Laboratory model readiness

1. Keep the OpenAI-compatible endpoint flow model-agnostic.
2. Add acceptance against the eventual laboratory endpoint over the server
   access path, including model discovery, streaming, tools, context length,
   concurrency, cancellation, and reconnect behavior.
3. Treat a proposed DeepSeek V4 Flash deployment as infrastructure selected by
   the laboratory, not as a hardcoded DeepLab dependency.
4. Verify that credentials remain write-only and that no cloud fallback occurs
   during an explicitly local-server run.

### P2: Cross-platform and release maturity

1. Run fresh installed-app acceptance on macOS and Linux.
2. Add reproducible CI or release scripts for web checks, Rust source checks,
   sidecar integrity, skill discovery, and platform bundles.
3. Revisit application update/signing only after the above release path is
   stable.

## 10. Acceptance criteria for the next release milestone

The next milestone should not be declared complete until all of the following
are demonstrated from an installed application:

- clean installation without path virtualization or manual file copying;
- no visible Node/dsh console during startup;
- dsh starts, reconnects, and recovers after forced termination;
- official DeepSeek or a custom OpenAI-compatible endpoint can be configured
  without exposing the credential;
- a streamed agent turn and an approved workspace file write both succeed;
- the session, queue, model choice, and run/provenance records recover after
  restart;
- all five research pipeline skills and `/research` are discovered;
- one bounded research workflow produces verified artifacts and provenance;
- the whale remains entirely optional and, when enabled, retains the complete
  upstream desktop behavior;
- frontend tests, typecheck, lint, production build, dsh integration tests, BCI
  verification, and package integrity checks pass;
- the migration matrix and `PROGRESS.md` match the accepted behavior.

## 11. First actions for the receiving agent

1. Read `AGENTS.md`, this report, `README.md`, `PROGRESS.md`,
   `docs/TECHNICAL_DESIGN.md`, and the three files under `docs/migration/` that
   describe the harness, adapter, and feature scope.
2. Run `git status --short --branch` and `git log -12 --oneline`. The expected
   starting state is a clean `codex/week-1-dsh-foundation` branch plus the
   handoff-report commit.
3. Verify the installed executable and app-private runtime paths listed above.
4. Run the standard TypeScript checks and focused dsh integration tests before
   modifying behavior.
5. Take P0 packaging reproducibility as the first engineering task unless the
   user redirects the project.
6. Preserve small, reviewable commits and add one newest-first line to
   `PROGRESS.md` for every real accepted milestone.

## 12. Final handoff judgment

DeepLab should be continued, not restarted. The core technical decision is now
proven: OpenLab's workbench can remain the product layer while dsh owns the
agent-runtime layer. The project has moved beyond architecture discussion into
a working Windows beta with a real model path, a real bundled harness, a real
research pipeline, reproducibility records, and a usable optional desktop
plugin.

The receiving agent's responsibility is to convert that working beta into a
repeatable release and systematically close the remaining OpenLab migration
gaps without introducing a second runtime or rewriting stable product code.
