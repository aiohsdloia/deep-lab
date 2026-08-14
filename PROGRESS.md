# DeepLab — Progress

One line per real milestone, `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top.
Results and blockers only.

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

## Retained-but-inactive OpenCode code

`OpenCodeClient` and `runtime/opencode-profile`, `opencode_config.rs` helpers, and the
goal/browser plugins remain as the retained reference runtime (the ACP-agent path still
uses them). Their config-seeding call sites were removed from the dsh spawn path, which
leaves a set of `dead_code` warnings in the Rust build; they are intentional and will be
pruned once the dsh runtime is the only supported runtime.
