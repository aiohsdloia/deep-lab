import type { RuntimeStatus, ToolCallStatus } from "@deeplab/shared";

export type { RuntimeStatus, ToolCallStatus };

/** Pinned DeepSeek Harness (dsh) release this client targets. */
export const DSH_VERSION = "0.1.1-rc.2";

/** dsh web server defaults (`dsh --profile web`). */
export const DEFAULT_DSH_URL = "http://127.0.0.1:3080";

/**
 * Product-facing abilities exposed by the active runtime composition.
 *
 * These flags describe what DeepLab can safely offer through its current
 * adapter/profile combination, not every feature the upstream runtime may
 * contain. UI code uses them to avoid presenting controls that can only fail.
 */
export interface RuntimeCapabilities {
  sessionFork: boolean;
  sessionArchive: boolean;
  sessionRestore: boolean;
  sessionDelete: boolean;
  sessionMove: boolean;
  sessionMessageRevert: boolean;
  syntheticMessageParts: boolean;
  skills: boolean;
  agents: boolean;
  commands: boolean;
  interactiveQuestions: boolean;
  interactivePermissions: boolean;
  /** Whether one approval can create a remembered rule for later tool calls. */
  persistentPermissionGrants: boolean;
  modelSelection: boolean;
  credentials: boolean;
  goals: boolean;
  dynamicMcpConfiguration: boolean;
  dynamicProviderConfiguration: boolean;
  oauthAuthentication: boolean;
}

/** Safe default before a runtime has been selected or connected. */
export const NO_RUNTIME_CAPABILITIES: Readonly<RuntimeCapabilities> = Object.freeze({
  sessionFork: false,
  sessionArchive: false,
  sessionRestore: false,
  sessionDelete: false,
  sessionMove: false,
  sessionMessageRevert: false,
  syntheticMessageParts: false,
  skills: false,
  agents: false,
  commands: false,
  interactiveQuestions: false,
  interactivePermissions: false,
  persistentPermissionGrants: false,
  modelSelection: false,
  credentials: false,
  goals: false,
  dynamicMcpConfiguration: false,
  dynamicProviderConfiguration: false,
  oauthAuthentication: false,
});

// ---- Normalized events (dsh → app) ----
// dsh emits idempotent "updated" events (full current value), not deltas, so
// text/tool events carry a stable id and the app upserts by that id.

export interface TextUpdatedEvent {
  type: "text.updated";
  sessionId: string;
  partId: string;
  text: string;
}
/** The model's reasoning ("thinking") for a step — streamed like text but kept
 *  separate so the UI can show it dimmed, apart from the final answer. Without
 *  surfacing this, "what is the agent doing?" between tool calls is invisible. */
export interface ReasoningUpdatedEvent {
  type: "reasoning.updated";
  sessionId: string;
  partId: string;
  text: string;
}
/** A model "step" boundary (AI-SDK `step-start`). One turn can run several steps
 *  — each an LLM call, often followed by tool calls — so `step` (1-based) tells
 *  the user the turn is progressing, not frozen. */
export interface StepUpdatedEvent {
  type: "step.updated";
  sessionId: string;
  step: number;
}
export interface ToolUpdatedEvent {
  type: "tool.updated";
  sessionId: string;
  callId: string;
  tool: string;
  status: ToolCallStatus;
  title?: string;
  /** Tool arguments (e.g. a write tool's `filePath` + `content`). */
  input?: Record<string, unknown>;
  /** Tool result text, when the tool returned one. */
  output?: string;
  /** Accumulated stdout tail while the tool is still running (bash streams it
   *  via `state.metadata.output` on every update — verified on 1.17.13). */
  partialOutput?: string;
  /** Unified diff an edit tool reports in `state.metadata.diff`. */
  diff?: string;
  /** Epoch ms the tool started / finished (`state.time`). */
  startedAt?: number;
  endedAt?: number;
  /** A `task` tool's spawned subagent session — that session's interactive
   *  requests (question/permission) belong to THIS conversation. */
  childSessionId?: string;
}
export interface SessionIdleEvent {
  type: "session.idle";
  sessionId: string;
}
/** Token usage for one assistant message (dsh attaches it to the message). */
export interface UsageSnapshot {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}
export interface UsageUpdatedEvent {
  type: "usage.updated";
  sessionId: string;
  usage: UsageSnapshot;
}
/** The runtime auto-named the session (dsh appends a `session/title` event after
 *  the first turn) — the app renames the sidebar row to match. */
export interface SessionRenamedEvent {
  type: "session.renamed";
  sessionId: string;
  title: string;
}
/** dsh's host stream reported a new session (from any client) — the app can add
 *  it to the sidebar without a full re-list. */
export interface SessionAddedEvent {
  type: "session.added";
  sessionId: string;
  blank?: boolean;
  title?: string;
  cwd?: string;
  updatedAt?: number;
}
/** dsh's host stream reported a session removed / a running-status flip. */
export interface SessionRemovedEvent {
  type: "session.removed";
  sessionId: string;
}
export interface SessionStatusEvent {
  type: "session.status";
  sessionId: string;
  running: boolean;
}
/** The turn's model call failed and the server is retrying it — dsh backs
 *  off exponentially with NO attempt cap, so without surfacing these the UI
 *  shows a bare "Working…" forever while every attempt fails. */
/** A user message landed carrying its agent — including the build message
 *  dsh injects itself when the plan_exit question is answered Yes. The
 *  app syncs its per-session agent-mode state from this (never from question
 *  text, which is locale/version-brittle). */
export interface MessageAgentEvent {
  type: "message.agent";
  sessionId: string;
  /** The user message's id, when known — lets the app tag the live message
   *  block so it can later be edited (revert + resend). */
  messageID?: string;
  /** Agent the user message carries; absent when dsh didn't set one. */
  agent?: string;
}

export interface SessionRetryEvent {
  type: "session.retry";
  sessionId: string;
  attempt: number;
  /** The provider's error message for the failed attempt. */
  message: string;
  /** Epoch ms of the next scheduled attempt. */
  nextAt: number;
}

// ---- Interactive requests (the agent asks; the user must answer) ----
// dsh blocks the run until answered. Two kinds: a `question` (pick from
// options) and a `permission` (approve a command / file write / etc.).

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  /** Allow selecting more than one option. */
  multiple?: boolean;
  /** Allow a free-text answer in addition to the options. */
  custom?: boolean;
}
export interface QuestionAskedEvent {
  type: "question.asked";
  sessionId: string;
  requestId: string;
  questions: QuestionItem[];
}
/** A question was answered or rejected elsewhere — clear it from the UI. */
export interface QuestionResolvedEvent {
  type: "question.resolved";
  sessionId: string;
  requestId: string;
}

export interface PermissionAskedEvent {
  type: "permission.asked";
  sessionId: string;
  requestId: string;
  /** e.g. "bash", "write", "edit" — what the agent wants to do. */
  action: string;
  /** The concrete targets (a command line, file paths). */
  resources: string[];
}
export interface PermissionResolvedEvent {
  type: "permission.resolved";
  sessionId: string;
  requestId: string;
}

/** Permission policy selected for a session or inherited by a new session. */
export type PermissionPreset = "workspace-write" | "danger-full-access";

/** dsh's effective permission preset for one session changed or was recovered. */
export interface PermissionPresetUpdatedEvent {
  type: "permission.preset.updated";
  sessionId: string;
  preset: string;
}
export interface RuntimeErrorEvent {
  type: "error";
  sessionId?: string;
  message: string;
}

/** The runtime compacted the conversation's older turns to stay inside the
 *  model's context window. Emitted so the thread can show one quiet marker
 *  instead of the user hitting "Input exceeds context window". */
export interface CompactedEvent {
  type: "session.compacted";
  sessionId: string;
  /** True when the runtime decided on its own, false when the user asked. */
  auto: boolean;
  /** The context had already overflowed rather than merely neared the limit. */
  overflow?: boolean;
}

export type RuntimeEvent =
  | TextUpdatedEvent
  | ReasoningUpdatedEvent
  | CompactedEvent
  | StepUpdatedEvent
  | ToolUpdatedEvent
  | UsageUpdatedEvent
  | SessionIdleEvent
  | SessionRenamedEvent
  | SessionAddedEvent
  | SessionRemovedEvent
  | SessionStatusEvent
  | MessageAgentEvent
  | SessionRetryEvent
  | RuntimeErrorEvent
  | QuestionAskedEvent
  | QuestionResolvedEvent
  | PermissionAskedEvent
  | PermissionResolvedEvent
  | PermissionPresetUpdatedEvent;

/** Approve a permission once, always (persist a rule), or reject it. */
export type PermissionReply = "once" | "always" | "reject";

// ---- REST shapes the app consumes ----

export interface SessionMeta {
  id: string;
  title: string;
  slug?: string;
  /** Session-fixed agent preset reported by the runtime (for dsh, e.g.
   *  "standard" or "code"). */
  agentPreset?: string;
  /** Workspace folder this session operates in (absolute path). */
  directory?: string;
  /** Set on subagent sessions: the session whose task tool spawned this one. */
  parentId?: string;
  /** Epoch ms the session was created / last updated (from dsh's `time`).
   *  Drives "Updated" timestamps and recency ordering. */
  created?: number;
  updated?: number;
  /** Epoch ms the user archived this conversation; absent when active.
   *  Archived conversations are kept and searchable — just out of the way. */
  archived?: number;
  /** The runtime's whole metadata object, so a write can merge instead of
   *  clobbering keys another client owns. */
  metadata?: Record<string, unknown>;
}

/** One page of conversation history. Both the filter and the paging run on the
 *  server so a multi-year history never has to be held in memory. */
export interface SessionQuery {
  /** Rows per page. */
  limit?: number;
  /** Page from here (an epoch-ms `updated`); omit for the newest page. */
  cursor?: number | null;
  /** Server-side title search. */
  search?: string;
  /** Include archived conversations (they are excluded by default). */
  archived?: boolean;
}

export interface SessionPage {
  sessions: SessionMeta[];
  /** Cursor for the next page, or null when the history is exhausted. */
  nextCursor: number | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  location?: string;
}

export interface AgentInfo {
  name: string;
  /** Human-readable preset name; `name` remains the stable runtime id. */
  label?: string;
  description: string;
  mode?: string;
  /** True for the preset new runtime sessions start with. */
  isDefault?: boolean;
}

/** A slash command the runtime can run. GET /command merges every source:
 *  config commands, skills, and MCP prompts — one list for the composer's
 *  "/" palette. */
export interface CommandInfo {
  name: string;
  description?: string;
  /** Where it came from, e.g. "command" | "skill" | "mcp". */
  source?: string;
  /** Agent the command pins, when it does. */
  agent?: string;
  /** The prompt text the command expands to. dsh stores that EXPANSION
   *  as the user message in history — the template lets the app reverse-map
   *  it back to the "/name" the user actually typed. */
  template?: string;
}

/** A message loaded from history (GET /session/:id/message). */
export interface HistoryMessage {
  role: "user" | "assistant";
  /** dsh's message id — the handle for reverting/editing a user message
   *  (`POST /session/:id/revert`). Absent only on synthetic/mock messages. */
  id?: string;
  /** Epoch ms when the message finished — unset while it is still streaming.
   *  On the LAST message this is the server's truth for "is the turn over". */
  completed?: number;
  /** The error that ended this assistant turn, when it failed. Without it a
   *  failed turn whose live session.error was missed (SSE reconnect, app
   *  restart) reloads as an empty reply with no explanation at all. */
  error?: string;
  /** Agent that drove this message ("build" / "plan" / …) — required upstream
   *  on user messages; the app derives a session's agent mode from the last
   *  user message when (re)opening it. */
  agent?: string;
  parts: HistoryPart[];
}
export interface HistoryPart {
  type: string;
  text?: string;
  /** True on runtime-generated text (e.g. the "tool was executed by the user"
   *  marker a "!" shell run leaves in history) — not something the user typed. */
  synthetic?: boolean;
  tool?: string;
  state?: {
    status?: string;
    title?: string;
    input?: Record<string, unknown>;
    output?: string;
    /** Epoch ms the tool started/finished — persisted with the part. */
    time?: { start?: number; end?: number };
    /** Tool-specific extras (bash stdout tail, edit diff, task session link).
     *  `sessionId` is the subagent session a `task` tool spawned — the live
     *  event stream reads the same field, and without it here a RELOADED
     *  conversation loses every link to its subagents' own transcripts. */
    metadata?: { output?: string; diff?: string; sessionId?: string };
  };
}

/**
 * A file sent as a real multimodal part of a turn, so a vision-capable model
 * sees the image itself rather than a filename in the prose (#88).
 *
 * `url` MUST be a `data:` URL. dsh accepts a `file://` url and answers 204,
 * then stores no message at all — the turn is silently lost — so the bytes ride
 * in the request.
 */
export interface PromptFile {
  /** Name shown to the model; the workspace file name it was read from. */
  filename: string;
  /** e.g. "image/png". */
  mime: string;
  /** `data:<mime>;base64,<…>`. */
  url: string;
}

// ---- Provider / model configuration (dsh-native, one source of truth) ----

export interface ProviderModelInfo {
  id: string;
  name: string;
  /** Reasoning-effort variant names this model exposes, ordered low→high as
   *  dsh reports them (e.g. ["minimal","low","medium","high"]). Empty when
   *  the model has no selectable reasoning levels. Pass one as `sendPrompt`'s
   *  `variant` to pick a per-turn effort; dsh maps it to the provider's
   *  native param (OpenAI reasoningEffort, Anthropic thinking, …). `listProviders`
   *  always sets it (possibly []); optional so terse fixtures can omit it. */
  variants?: string[];
}

/** A provider dsh can use right now (auth present or public). */
export interface ProviderInfo {
  id: string;
  name: string;
  models: ProviderModelInfo[];
}

/** Extra input an auth method needs before starting (e.g. Copilot deployment). */
export interface AuthPrompt {
  type: "select" | "text";
  key: string;
  message: string;
  options?: Array<{ label: string; value: string; hint?: string }>;
}

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: AuthPrompt[];
}

/** Catalog entry: a provider dsh knows how to talk to (not necessarily connected). */
export interface ProviderCatalogEntry {
  id: string;
  name: string;
  /** Env var(s) that would carry the API key, e.g. ["ANTHROPIC_API_KEY"]. */
  env: string[];
}

export interface OAuthAuthorization {
  url: string;
  /** "auto" — callback completes on its own; "code" — the user pastes a code. */
  method: "auto" | "code";
  instructions: string;
}

// ---- MCP servers ----

export type McpConfig =
  | { type: "local"; command: string[]; enabled?: boolean; environment?: Record<string, string> }
  | { type: "remote"; url: string; enabled?: boolean; headers?: Record<string, string> };

export interface McpServer {
  name: string;
  /** e.g. "connected" | "failed" | "disabled" | "pending" */
  status: string;
  config?: McpConfig;
}

// ---- Raw dsh wire shapes (subset we consume) ----

export interface RuntimeRawEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface RuntimeTextPart {
  id: string;
  type: "text";
  text: string;
}
export interface RuntimeToolPart {
  id: string;
  type: "tool";
  callID: string;
  tool: string;
  state: { status: "pending" | "running" | "completed" | "error"; title?: string };
}
export type RuntimePart = RuntimeTextPart | RuntimeToolPart | { type: string };
