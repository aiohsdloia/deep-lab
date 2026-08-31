# DeepLab — Progress

One line per real milestone, `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top.
Results and blockers only.

- `2026-08-31 16:43` — Completed the first general-use DeepLab version: per-session model and reasoning choices now reach dsh before each turn, missing-model setup is a guarded user flow, provenance/runs name the effective session model, and opt-in live acceptance passed against a real DeepSeek model for both exact chat output and an approved workspace file-writing tool turn; typecheck, lint, production build, MCP, BCI, and focused regressions pass, while the full 903-test run had one unrelated preview timeout that passed 12/12 on immediate isolated rerun.
- `2026-08-31 11:37` — Restored a general initial product capability beyond demos: DeepLab can now discover, add, list, select, and remove lab/self-hosted OpenAI-compatible model endpoints through dsh-native `llm.*`, `settings.mutate`, and write-only credentials; focused contracts and a real isolated dsh sidecar round-trip pass without secrets entering settings.
- `2026-08-31 11:22` — Made the BCI trends workflow presentation-ready: bundled a deterministic dependency-free pipeline, added readable report figures and pipeline tamper verification, routed dsh through execution/verification/presentation with DeepLab run/provenance records, and restricted bundled example resources to a clean allowlist; BCI contract tests, dsh MCP tests, lint, typecheck, the full frontend suite, and production build pass, while Rust test linking remains blocked by this Windows host lacking MSVC Build Tools and the installed GNU linker exceeding its DLL export ordinal limit.
- `2026-08-30 23:52` — Unified DeepLab's permission control on dsh-native presets: removed the competing Rust/OpenCode-style config path and duplicate unlimited toggle, added SDK-level default/current-session permission APIs plus projection recovery, and required explicit confirmation for full access; typecheck, lint, production build, and all 893 non-live tests pass, while Rust tests remain blocked by this host resolving MSYS `link.exe` instead of MSVC Build Tools.
- `2026-08-30 23:29` — Aligned interactive approvals with pinned dsh semantics: response receipts are enforced, cross-client resolution correlates `approvalId` back to the request `rpcId`, reasons survive pending-request recovery, and the UI no longer offers unsupported persistent grants; typecheck, lint, production build, and all 889 non-live tests pass.
- `2026-08-30 23:08` — Hardened the BCI trends demo with a versioned artifact contract, cross-platform verifier, tamper-negative tests, and DeepLab-owned run/provenance auditing; the deterministic workflow passes locally, while a real dsh model turn remains gated by the absence of provider credentials in this host's app-private dsh home.
- `2026-08-30 18:21` — Added the dsh-native MCP composition bridge: desktop connector inventory now renders official Cordis plugin rows, credentials remain in dsh's managed store, Jupyter/browser/science connector surfaces are re-enabled, and sidecar reloads preserve the frontend gateway URL and token.
- `2026-08-30 17:14` — Added a typed runtime capability contract for the pinned dsh composition and wired session/history/settings surfaces to it, so unsupported OpenCode-era actions (message revert/edit, session restore/delete/move, dynamic MCP/provider setup, and OAuth) are hidden and defensively blocked instead of appearing to work.
- `2026-08-24 11:47` — OpenLab-to-DeepLab migration scope clarified: added a dsh-aware feature ownership report that separates DeepLab-owned product features from dsh-owned runtime state and mixed integration areas, with P0-P3 migration priorities in `docs/migration/OPENLAB-DSH-MIGRATION-SCOPE.md`.
- `2026-08-24 00:59` — Direct harness inspection completed: separated `runtime/harness` as a workspace rule/memory scaffold from the real bundled dsh sidecar and SDK adapter layer, and recorded the recommendation to keep Open Lab's research-workbench product layer while continuing the dsh-native runtime migration in `docs/migration/HARNESS-INSPECTION-REPORT.md`.
- `2026-08-24 00:12` — Week-two direction changed to a decisive dsh-backed demo: added a one-click BCI literature trends starter that installs the bundled `bci-trends` workspace, switches the draft into it, and prompts the agent to produce script, figures, processed data, report, and provenance from a local seed corpus; lab-hosted model serving remains a later provider-switch milestone, not a prerequisite for the demo.
- `2026-08-23 14:20` — Week-one dsh foundation complete on `codex/week-1-dsh-foundation`: pinned Harness `0.1.1-rc.2`, added a typed RPC contract and Goal/Model/Settings adapters, fixed Goal CAS and current-model protocol drift, switched Settings to the live provider catalog, documented the OpenLab migration matrix, removed dead ACP/goal-plugin build references, and passed typecheck, lint, production web build, real sidecar smoke, dsh contract tests, and GNU-target Rust source check; a credentialed model prompt and formal Windows bundle remain explicit environment-gated checks.
- `2026-08-15 04:10` — DeepLab is now fully dsh-only and isolated from Open Lab / OpenCode: removed `OpenCodeClient` (only `DshRuntime` remains), the entire ACP runtime (acp.rs, sdk/acp, acp-server, ACP settings UI), `opencode_config.rs` (renamed `dsh_config`), the goal plugin's `@opencode-ai/plugin` dependency + goal.rs/GoalPill, `runtime/opencode-profile` (renamed `dsh-profile`), and every config path / brand label (`opencode/` dirs → `dsh/`, `OpenCodeEvent` → `RuntimeEvent`, Open Lab → DeepLab). Migrated the Open Lab remote-machine list (life-bioinfo-gpu/cpu/win) into `~/Documents/DeepLab/.deeplab/compute.json`. Verified speed (session ~140ms, first token ~1s), a 5-turn long session, and 3 parallel sessions all complete; the session skill list contains only bundled English dsh science skills.
- `2026-08-15 02:10` — Installed DeepLab.app to /Applications (no dmg) and fixed the two bugs that blocked real use there: (1) the sidecar launcher's chdir/spawn hung under LaunchServices (`open`/Dock), so Rust now spawns the dsh CLI directly with current_dir = the bundled resource dir; (2) dsh's `tool/result` event carries the callId on `message.source.callId`/`toolCallId` and the output in NESTED content — the SDK read neither, so every bash/tool result was empty; it now resolves both and the app renders tool output. Verified end to end from the installed app: a Tic-Tac-Toe game written + 13 unit tests passing via bash.
- `2026-08-15 01:20` — DeepLab sessions no longer see the legacy Open Lab Chinese skills (academic-translation, paper-review): the sidecar is spawned with `DSH_AGENTS_HOME` pointed at an app-private dir, so dsh stops scanning the user's `~/.agents/skills` pack (verified: session skill list now contains only the bundled English science skills).
- `2026-08-15 00:55` — Stress-tested DeepLab with three parallel sessions: remote SSH to a CPU server (upload + run hello.py), a Tic-Tac-Toe game (code + tests verified), and an office-docs skill (docx/xlsx/pptx/pdf, self-test all PASS). Fixed a real bug found under load: dsh records SYSTEM-injected rows (runtime context, skill catalog) as `user/message`, polluting every reopened session — the SDK now folds only `source.kind === "user"` rows into history.
- `2026-08-15 00:10` — Deleted sessions no longer reappear: dsh's `session.list` neither filters archived rows nor returns a title, so the SDK now reads the persisted `workspace.list` archivedSessionIds (filters `listSessions`), reads the auto-generated title from `projections.values.title`, and folds dsh's `session/title` event into a `session.renamed` update (verified: archived sessions stay hidden across new-session/reconnect, conversations show their summarized names).
- `2026-08-14 22:40` — Desktop build now connects: the bundled dsh sidecar is reached through a same-origin internal gateway (`start_internal` + CORS + a hand-rolled WebSocket upgrade proxy for `/api/events.*`), so the `tauri://localhost` WebView passes dsh's browser-trust fence; verified live (`connect OK`, host+mux streams active end to end).
- `2026-08-14 21:30` — Simplified DeepLab to dsh-only: removed ACP/OpenCodeClient runtime selection, the runtime settings section, the model browser, and the main-UI model status pill; models are now one DeepSeek API key + a Flash/Pro choice (verified live against dsh's `deepseek-v4-flash`/`deepseek-v4-pro`).
- `2026-08-14 19:00` — DeepLab scaffolded from open-lab source, rebranded (`@deeplab/*`, `com.sculab.deeplab`, `~/Documents/DeepLab`, `.deeplab/`), with the runtime swapped to the DeepSeek Harness: frontend typecheck + full unit suite (1018 tests) pass and a live dsh-sidecar smoke test connects DshRuntime end to end.
- `2026-08-14 18:40` — `packages/sdk` implements `DshRuntime` (the `AgentRuntime` seam) over the dsh `/api` HTTP+WebSocket gateway with session-event folding, plus `DshApiClient` transport; provider/MCP surface mapped onto dsh `llm.*`/`credentials.*`/`settings.*`.
- `2026-08-14 18:10` — Rust `runtime.rs` spawns `dsh --profile web` via `runtime/dsh/launcher.mjs` with app-private `DSH_HOME`, deploys skills to `<dsh-home>/skills/`, and the gateway proxies dsh `/api` + WebSocket downlinks; `cargo check` clean.

## Known deviations from Open Lab (dsh v1 API gaps)

- `revert` / `unrevert` (edit-a-past-message) — dsh v1 has no revert RPC; `DshRuntime` throws a descriptive error. Fork a session instead.
- `appendTextPart` (background-agent result parts) — dsh has no synthetic-part append; surfaced live as a text update instead.
- OAuth authorize/callback flows — dsh v1 has no OAuth RPC; configure provider credentials in Settings.
- Model selection is session-scoped at runtime; `session.selectModel` also persists dsh's default for future agents, so DeepLab updates one selected session instead of rewriting every conversation.
- `session.list` is unpaginated in dsh v1; `querySessions` pages in the client.

## Isolation leftovers (dsh-architecture migration backlog)

- `runtime/tools/{ssh_connect,present_artifact}.ts` still import
  `@opencode-ai/plugin` (they work — dsh loads them — but should be rewritten
  with dsh's native tool schema).
- Approval mode / memory / agent-model settings are stored by
  `dsh_config.rs` in a private `dsh.json` under the app config dir; dsh reads
  its own `settings.yaml`, so these should move to dsh's `settings.*` domain
  (approval policy lives in dsh's permission-presets).
- Legacy path migration (OpenLab/OpenScience/`.openlab`) remains so old
  workspaces keep working; it will be dropped once all workspaces are native.

## Desktop connection model (verified)

The bundled sidecar is loopback-only and dsh's browser-trust fence demands
`Origin === Host`, but the WebView origin is `tauri://localhost` — so the shell
never dials the sidecar directly. `start_runtime` spawns dsh, waits for its
socket, then starts an internal same-origin gateway (`gateway::start_internal`,
fresh token) and returns the gateway URL. The SDK talks to the gateway:
`Authorization: Bearer <token>` on unary calls, `?token=` on the WebSocket
streams, and the gateway proxies `/api` (HTTP) plus `/api/events.*` (a
hand-written WebSocket upgrade proxy — `tungstenite::accept` cannot be used
because `Request::parse` already consumed the handshake through its own
BufReader, so the 101 is written manually and the socket is wrapped with
`WebSocket::from_raw_socket`). CORS headers on every response let the cross-origin
WebView fetch succeed (all privileged paths stay token-gated).
