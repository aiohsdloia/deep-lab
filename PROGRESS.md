# DeepLab — Progress

One line per real milestone, `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top.
Results and blockers only.

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
- Runtime `addCustomProvider` / `addMcpServer` — dsh wires providers in settings namespaces and MCP servers in `cordis.yml`; the runtime `add*` calls throw a descriptive error. Connectors deploy via `runtime/skills` + setup.
- OAuth authorize/callback flows — dsh v1 has no OAuth RPC; configure provider credentials in Settings.
- Per-session model select persists per session (`session.selectModel`) rather than a global default; `setDefaultModel` applies to live sessions.
- `session.list` is unpaginated in dsh v1; `querySessions` pages in the client.

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

## Retained-but-inactive OpenCode code

`OpenCodeClient` and `runtime/opencode-profile`, `opencode_config.rs` helpers, and the
goal/browser plugins remain as a retained reference runtime. The app drives exactly one
runtime — the bundled DeepSeek Harness sidecar — so their config-seeding call sites were
removed from the dsh spawn path, leaving a set of `dead_code` warnings in the Rust build;
they are intentional and will be pruned once dsh is the only supported runtime. The ACP
*server* direction (external editors driving DeepLab over the Agent Client Protocol) is
kept: it is gateway functionality, not a runtime choice.
