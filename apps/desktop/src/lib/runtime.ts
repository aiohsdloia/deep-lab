import { create } from "zustand";
import {
  DshRuntime,
  DEFAULT_DSH_URL,
  isApiStatus,
  type AgentInfo,
  type AgentRuntime,
  type CommandInfo,
  type HistoryMessage,
  type OpenCodeEvent,
  type PermissionAskedEvent,
  type PermissionReply,
  type ProviderInfo,
  type QuestionAskedEvent,
  type SessionMeta,
  type SkillInfo,
  type ToolCallStatus,
} from "@deeplab/sdk";
import type {
  ArtifactBlock,
  ReviewerBlock,
  RuntimeStatus,
  ThreadBlock,
  ToolVerb,
} from "@deeplab/shared";
import {
  adoptWorkspaceSkills,
  detectTools as probeTools,
  commitWorkspaceSnapshot,
  createProject as createProjectFolder,
  importProject as importProjectFolder,
  setProjectPinned as setProjectPinnedCmd,
  setProjectColor as setProjectColorCmd,
  deleteProject as deleteProjectCmd,
  getAgentModels,
  getAgentVariants,
  getApprovalMode,
  installSkillMarkdown,
  isTauri,
  listProjects,
  logDebug,
  markSession,
  newDatedWorkspace,
  setApprovalMode as persistApprovalMode,
  setMultimodalModels,
  setProxySetting as persistProxySetting,
  setWorkspace,
  startRuntime,
  runtimePassword,
  workspacePath,
  workspaceSkillNames,
  type ApprovalMode,
  type ProjectImportMode,
  type ProjectInfo,
  type ProxyMode,
  type ToolStatus,
} from "./tauri";
import { isGatewayWeb, gatewayToken, gatewayOrigin } from "./webMode";
import { samePath } from "./workspacePath";
import { kernelReset } from "./kernel";
import { moveScrollMemory } from "./scrollMemory";
import { deriveArtifact, deriveArtifactPresentation } from "./artifacts";
import { useLayoutStore } from "./layout";
import { provenanceInputsFromEvent, recordProvenance } from "./provenance";
import { clearResolvedPaths } from "./artifactFile";
import { imageAttachmentParts } from "./promptAttachments";
import { recordRun, runInputFromEvent } from "./runs";
import { splitReview } from "./review";
import { useSshStore } from "./ssh";
import {
  AUTO_REVIEW_KEY,
  AUTO_REVIEW_PROMPT,
  REVIEWER_AGENT,
  autoReviewPrompt,
  isMutatingTool,
  shouldAutoReview,
} from "./autoReview";
import { notifyPermissionRequest } from "./systemNotification";
import { fallbackDefaultModel } from "@/components/settings/modelCatalog";
import { toast } from "@/lib/toast";
import i18n from "@/i18n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pending per-session queue timers (a delayed queue item's wake-up). Stored so
 *  a repeated drainQueue call never stacks timers and so editing/clearing a
 *  queue can cancel a stale wake-up. */
const queueTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearQueueTimer(sessionId: string): void {
  const t = queueTimers.get(sessionId);
  if (t !== undefined) {
    clearTimeout(t);
    queueTimers.delete(sessionId);
  }
}

/** Wake `sessionId`'s queue after `ms` (used for a queued item's run plan). */
function wakeQueue(sessionId: string, ms: number): void {
  clearQueueTimer(sessionId);
  queueTimers.set(
    sessionId,
    setTimeout(() => {
      queueTimers.delete(sessionId);
      useRuntimeStore.getState().drainQueue(sessionId);
    }, ms),
  );
}

const URL_KEY = "deeplab.url";
const HIDDEN_KEY = "ai4s.hiddenExamples";
// The composer's chosen reasoning-effort variant, kept across restarts (favorites
// / recent models persist too, so the effort should as well). Sibling of the
// model-preferences keys in components/settings/modelPreferences.
const REASONING_KEY = "ai4s.models.variant.v1";
/** Per-session model + reasoning-effort overrides, persisted so a restored split
 *  layout keeps each pane's model/effort (they're keyed by real session id,
 *  which survives across runs). */
const SESSION_MODELS_KEY = "ai4s.session.models.v1";
const SESSION_VARIANTS_KEY = "ai4s.session.variants.v1";
/** Per-session prompt queues, auto-saved on every change and reloaded at
 *  startup so a crash (or a quit) never loses queued prompts. Keyed by real
 *  session id, which survives across runs. */
const QUEUES_KEY = "ai4s.queues.v1";

/** The run plans a queued instruction may pick from: delay (minutes) before it
 *  starts. 0 = immediately. */
export const QUEUE_DELAYS = [0, 5, 10, 30, 60] as const;
/** Repeat-count bounds for a queued instruction. */
export const QUEUE_REPEATS_MAX = 99;

/** One queued instruction: the prompt text plus its run plan — how long to
 *  wait before starting it (`delayMin`) and how many times to run it
 *  (`repeats`, default 1). `readyAt` is the epoch ms at which the item may
 *  start (enqueue/plan time + delayMin); it is persisted so a delayed item
 *  keeps its schedule across restarts. */
export interface QueueItem {
  text: string;
  delayMin: number;
  repeats: number;
  readyAt?: number;
}

/** Clamp a run-plan delay to the allowed set (0/5/10/30/60 minutes). */
function clampDelay(value: unknown): number {
  const n = typeof value === "number" ? value : 0;
  return (QUEUE_DELAYS as readonly number[]).includes(n) ? n : 0;
}

/** Clamp a repeat count to [1, 99]. */
function clampRepeats(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1;
  return Math.min(QUEUE_REPEATS_MAX, Math.max(1, n));
}

/** Normalize a raw persisted value into a QueueItem (legacy plain strings are
 *  migrated to an immediately-run, single-repeat item). */
function toQueueItem(value: unknown): QueueItem | null {
  if (typeof value === "string") return { text: value, delayMin: 0, repeats: 1 };
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.text !== "string") return null;
    return {
      text: o.text,
      delayMin: clampDelay(o.delayMin),
      repeats: clampRepeats(o.repeats),
      readyAt: typeof o.readyAt === "number" ? o.readyAt : undefined,
    };
  }
  return null;
}
/** The "解读图片" (image-understanding) model: turns that attach an image are
 *  routed to it, so a non-vision main model can still see images. */
const VISION_MODEL_KEY = "ai4s.models.vision.v1";
/** The image-GENERATION model: not a chat model — the `image-tools` skill
 *  calls its images API directly. Stored here so the app can hand both choices
 *  to the skill (multimodal.json). */
const IMAGE_GEN_MODEL_KEY = "ai4s.models.imagegen.v1";
function loadRecord<V>(key: string): Record<string, V> {
  if (typeof window === "undefined") return {};
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveRecord(key: string, rec: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(rec));
  } catch {
    /* storage full/unavailable never blocks a model switch */
  }
}

function initialUrl(): string {
  if (typeof window === "undefined") return DEFAULT_DSH_URL;
  const stored = window.localStorage.getItem(URL_KEY);
  if (stored) return stored;
  // Plain-browser dev (`pnpm dev`, no Tauri, not the gateway): vite proxies the
  // same-origin /api prefix to the dsh sidecar (see vite.config.ts server.proxy)
  // so the app talks to the same origin and the browser-trust fence passes.
  if (!isTauri && !isGatewayWeb && typeof window !== "undefined") {
    return window.location.origin;
  }
  return DEFAULT_DSH_URL;
}
function initialHidden(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function initialReasoningVariant(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REASONING_KEY) || null;
}
function initialAutoReview(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTO_REVIEW_KEY) === "1";
}

/** Load the persisted per-session queues. Entries are normalized to QueueItems
 *  (legacy plain-string entries migrate to immediately-run, single-repeat) so a
 *  corrupt entry can never break drainQueue. */
export function loadQueues(): Record<string, QueueItem[]> {
  const raw = loadRecord<unknown>(QUEUES_KEY);
  const out: Record<string, QueueItem[]> = {};
  for (const [sid, v] of Object.entries(raw)) {
    if (typeof sid !== "string" || !Array.isArray(v)) continue;
    const arr: QueueItem[] = [];
    for (const x of v) {
      const item = toQueueItem(x);
      if (item) arr.push(item);
    }
    if (arr.length) out[sid] = arr;
  }
  return out;
}

/** Sessions whose LAST turn ended in an interruption — the sidebar shows a
 *  yellow status dot instead of the green "ready" dot. Persisted so the dot
 *  survives a restart; it is set on interrupt and cleared when a fresh turn
 *  starts (and re-derived from history when a session is opened). */
const INTERRUPTED_KEY = "ai4s.sessions.interrupted.v1";

function loadInterrupted(): Record<string, true> {
  const raw = loadRecord<unknown>(INTERRUPTED_KEY);
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === true) out[k] = true;
  }
  return out;
}

function saveInterrupted(rec: Record<string, true>): void {
  saveRecord(INTERRUPTED_KEY, rec);
}

/** Mark `sid` (and its subagent descendants) as interrupted in the store. */
function markInterrupted(sid: string, descendants: string[]): void {
  useRuntimeStore.setState((s) => {
    const interruptedSessions = { ...s.interruptedSessions };
    for (const id of [sid, ...descendants]) interruptedSessions[id] = true;
    saveInterrupted(interruptedSessions);
    return { interruptedSessions };
  });
}

/** Clear the interrupted mark for `sid` in the store. */
function unmarkInterrupted(sid: string): void {
  useRuntimeStore.setState((s) => {
    if (!s.interruptedSessions[sid]) return {};
    const interruptedSessions = { ...s.interruptedSessions };
    delete interruptedSessions[sid];
    saveInterrupted(interruptedSessions);
    return { interruptedSessions };
  });
}

/** The persisted image-understanding model id ("provider/model"), or null. */
function initialVisionModel(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(VISION_MODEL_KEY) || null;
}

/** The persisted image-GENERATION model id ("provider/model"), or null. */
function initialImageGenModel(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(IMAGE_GEN_MODEL_KEY) || null;
}

export interface Thread {
  blocks: ThreadBlock[];
  index: Record<string, number>;
  loaded: boolean;
}

/** Outcome of installSkill: the skill is already installed, or an agent session
 *  is doing it and the caller should open that session to watch. */
export type InstallSkillResult =
  | { kind: "installed"; name: string }
  | { kind: "session"; id: string };

/** What a session's right pane shows: an artifact inspector, the Files
 *  browser, the Runs ledger, or nothing. Mutually exclusive — one pane. */
export interface PaneState {
  artifact: ArtifactBlock | null;
  showFiles: boolean;
  showRuns: boolean;
  /** The subagent panel: what this conversation's subagents are doing (#63). */
  showAgents: boolean;
  /** One-shot "reveal" target for the session's files pane: a workspace-relative
   *  path the pane should navigate to and select+flash. Consumed by the pane. */
  revealPath?: string;
}

interface RuntimeState {
  status: RuntimeStatus;
  serverUrl: string;
  sessions: SessionMeta[];
  currentId: string | null;
  threads: Record<string, Thread>;
  skills: SkillInfo[];
  agents: AgentInfo[];
  /** Per-agent model / reasoning effort from OpenCode's config (Settings →
   *  Models → per agent). Consulted when a pane has no explicit pick, so a
   *  configured agent model is what actually runs the turn (#96). */
  agentModels: Record<string, string>;
  agentVariants: Record<string, string>;
  /** Re-read the per-agent config after Settings writes it. */
  refreshAgentModels: () => Promise<void>;
  /** Apply a change that makes the sidecar reload its config (per-agent model or
   *  effort, an installed skill), keeping the Settings surfaces on screen while
   *  it restarts. Without this the catalog is briefly unreachable and the page
   *  collapses to its connect prompt — every tweak looked like a lost runtime. */
  reloadRuntimeConfig: (apply: () => Promise<void>) => Promise<void>;
  /** Slash commands the runtime can run ("/" palette): config commands,
   *  skills and MCP prompts, one merged list from GET /command. */
  commands: CommandInfo[];
  /** Configured default model ("provider/model"), or null when unset. */
  defaultModel: string | null;
  /** Apply a new default model and transparently reconnect (see impl). */
  setDefaultModel: (model: string) => Promise<void>;
  /** Connected providers and their models (from GET /config/providers, fetched
   *  in loadCatalog). Drives the composer's inline model picker; empty until the
   *  first catalog load. Kept here so the picker and Settings share one source. */
  providers: ProviderInfo[];
  /** Selected per-turn reasoning-effort variant name (e.g. "high"), or null for
   *  the model's default. Sent with the next prompt only if the current model
   *  actually exposes it — variant vocabularies differ across models. */
  reasoningVariant: string | null;
  setReasoningVariant: (variant: string | null) => void;
  /** Run the reviewer agent for one read-only turn whenever a turn changed
   *  workspace files (#72). Off by default: it is a second model turn, so the
   *  user opts in. Persisted locally (it is app behaviour, not sidecar config),
   *  which also makes it work in the gateway web client. */
  autoReview: boolean;
  setAutoReview: (enabled: boolean) => void;
  /** Non-blocking reviewer activity keyed by the foreground parent session. */
  backgroundReviews: Record<string, "queued" | "running">;
  cancelAutoReview: (sessionId: string) => void;
  /** The last failed model switch's error, or null. While set, the Settings
   *  page keeps the model browser on screen (instead of the connect prompt)
   *  so the user can retry. Cleared by any successful reconnect, a successful
   *  switch, a server-URL change, or an explicit disconnect. */
  modelSwitchError: string | null;
  /** The composer's approval switch: "approve" (dangerous commands prompt)
   *  or "full" (everything in-workspace runs). Loaded from OpenCode config. */
  approvalMode: ApprovalMode;
  /** Persist a new approval mode (restarts the sidecar) and reconnect. */
  setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  /** Persist the network-proxy setting (restarts the sidecar) and reconnect. */
  setProxySetting: (mode: ProxyMode, url: string) => Promise<void>;
  tools: ToolStatus[];
  hiddenExamples: string[];
  error: string | null;
  /** Pending interactive requests the agent is blocked on, newest last. */
  questions: QuestionAskedEvent[];
  permissions: PermissionAskedEvent[];
  /** Subagent session → the session whose task tool spawned it, learned from
   *  task tool events (live) and the session list (recovery after reload). */
  sessionParents: Record<string, string>;
  /** Right-pane state per session (DRAFT_KEY for a draft) — each session keeps
   *  its own open artifact / Files browser and gets it back when reopened.
   *  In-memory only: an app restart returns every session to a closed pane. */
  panes: Record<string, PaneState>;
  /** Composer agent switch per session (DRAFT_KEY for a draft); absent = build.
   *  In-memory, but reconciled from the message stream and history: OpenCode's
   *  plan_exit "Yes" continues the session as build — the pill must follow. */
  sessionAgents: Record<string, AgentMode>;
  /** Per-session model override (key = sid or DRAFT_KEY); absent = the global
   *  `defaultModel`. Lets each split pane run a different model without a global
   *  config switch (the model is sent per-turn), so switching one pane's model
   *  never changes the others. In-memory. */
  sessionModels: Record<string, string>;
  /** Per-session reasoning-effort override; absent = the global
   *  `reasoningVariant`. */
  sessionVariants: Record<string, string | null>;
  /** Set a session's model (per-pane); no sidecar config PATCH / reconnect. */
  setSessionModel: (sessionId: string, model: string) => void;
  /** Drop a pane's explicit pick so the turn follows the agent config / default
   *  again — without this a session model could be changed but never undone. */
  clearSessionModel: (sessionId: string) => void;
  /** Set a session's reasoning effort (per-pane). */
  setSessionVariant: (sessionId: string, variant: string | null) => void;
  /** The "解读图片" model ("provider/model"), or null. Turns that attach an
   *  image route to it instead of the session's model. */
  visionModel: string | null;
  setVisionModel: (model: string | null) => void;
  /** Image-GENERATION model ("provider/model"); used by the image-tools skill. */
  imageGenModel: string | null;
  setImageGenModel: (model: string | null) => void;
  // The pane/agent setters and turn actions below take an optional `sessionId`
  // so a split pane acts on its OWN session; omitted, they fall back to the
  // focused session (`currentId ?? DRAFT_KEY`) — the single-pane behavior.
  setAgentMode: (mode: AgentMode, sessionId?: string) => void;
  openArtifact: (a: ArtifactBlock, sessionId?: string) => void;
  closeArtifact: (sessionId?: string) => void;
  setShowFiles: (show: boolean, sessionId?: string) => void;
  setShowRuns: (show: boolean, sessionId?: string) => void;
  setShowAgents: (show: boolean, sessionId?: string) => void;
  /** Open the session's files pane and reveal `path` (workspace-relative) in it. */
  revealFile: (sessionId: string, path: string) => void;
  /** Drop a pane's pending reveal target (called once the pane consumed it). */
  clearReveal: (sessionId?: string) => void;
  answerQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestId: string) => Promise<void>;
  replyPermission: (requestId: string, reply: PermissionReply) => Promise<void>;
  setServerUrl: (url: string) => void;
  loadCatalog: () => Promise<void>;
  detectTools: () => Promise<void>;
  connect: () => Promise<void>;
  /** Resolves true once connected, false when the retry window is exhausted. */
  connectRetry: (tries?: number) => Promise<boolean>;
  bootstrap: () => Promise<void>;
  disconnect: () => void;
  refreshSessions: () => Promise<void>;
  startDraft: () => void;
  /** Blank the draft view WITHOUT unpinning the folder the next session
   *  will be created in — only an explicit New may do that (#69). */
  resetDraftView: () => void;
  startDraftInCurrentWorkspace: (key?: string) => void;
  /** Projects: named shared workspaces under `<base>/projects`. Sessions group
   *  under a project by `directory`; multiple sessions share the folder. */
  projects: ProjectInfo[];
  refreshProjects: () => Promise<void>;
  /** Create a project folder and move into it with a fresh pinned draft. */
  createProject: (name: string) => Promise<ProjectInfo | null>;
  importProject: (path: string, mode: ProjectImportMode) => Promise<ProjectInfo | null>;
  setProjectPinned: (id: string, pinned: boolean) => Promise<void>;
  /** Set (or clear) a project's sidebar accent color. */
  setProjectColor: (id: string, color: string | null) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Fresh draft aimed at `path` (a project folder), so the session it creates
   *  lands there. `key` is the draft slot the composer sends under — a pane's
   *  own `draft:<leafId>` when the caller opened one. Skips the reconnect when
   *  the folder is already active. */
  startDraftInWorkspace: (path: string, key?: string) => Promise<void>;
  /** Active workspace folder (absolute path); null in the browser. */
  workspace: string | null;
  /** Web client only: the gateway token is read-only (GET-only) — every write
   *  (new session, prompt, approval) would 403, so the UI hides/disables them. */
  webReadOnly: boolean;
  /** Folder a pending draft's session must be created in, keyed by draft slot
   *  (`DRAFT_KEY`, or a pane's `draft:<leafId>`). Set when the user picks one —
   *  "+ new session in project X", or the folder picker. A draft with no entry
   *  gets its own fresh dated folder.
   *
   *  Per draft and holding the PATH, not a global boolean (#69): the active
   *  folder follows whatever session was last opened, so a bare "pinned" flag
   *  neither survived a glance at another session (the send landed in that
   *  session's folder) nor stayed out of the way of an unrelated new screen. */
  draftWorkspaces: Record<string, string>;
  /** A deliberate workspace move is in flight (event-stream reconnect into the
   *  new folder). The UI must not present it as a disconnection — no status
   *  flip, no Connect button, no help card. Real failures surface after the
   *  retry window is exhausted, once this clears. */
  switching: boolean;
  /** A sendPrompt is in flight for SOME session (click → POST accepted). Kept as
   *  the OR of `sendingSessions` for single-pane call sites; per-pane composers
   *  read `sendingSessions[sessionId]` instead. */
  sending: boolean;
  /** Sessions with a send in flight (POST not yet settled), keyed by id
   *  (DRAFT_KEY for a draft). Lets split panes send concurrently while still
   *  blocking a double-send to the SAME session. */
  sendingSessions: Record<string, true>;
  /** Sessions with an active turn (send accepted, session.idle not yet seen).
   *  Drives the composer lock and the "Working…" indicator. */
  runningSessions: Record<string, true>;
  /** Current model-step number per running session (from `step.updated`), so the
   *  working indicator can show "step N" — proof the turn is progressing, not
   *  hung. Reset when a turn starts and cleared on idle. */
  stepCounts: Record<string, number>;
  /** Sessions whose current turn is a user-typed "!" shell command. Their bash
   *  output shows inline in the thread — the output IS the result the user
   *  asked for. Agent bash steps stay quiet single-line log entries. */
  shellTurns: Record<string, true>;
  /** Sessions whose model call failed and is being retried server-side —
   *  OpenCode backs off with no attempt cap, so this is what keeps a broken
   *  provider from looking like a silent "Working…" forever. Cleared by the
   *  session's next sign of life (stream events, idle, error). */
  retryNotices: Record<string, { attempt: number; message: string }>;
  /** Per-session prompt queues: instructions submitted via the composer's  /** Per-session prompt queues: instructions submitted via the composer's
   *  "add to queue" run one after another — each queued turn starts when the
   *  previous one completes (session.idle), FIFO, execute-one-remove-one. Every
   *  item carries its own run plan (delay before it starts) and repeat count.
   *  Keyed by real session id (a draft has no queue yet). Auto-persisted. */
  queues: Record<string, QueueItem[]>;
  /** Sessions whose last turn ended in an interruption — the sidebar shows a
   *  yellow status dot instead of the green "ready" dot. Set on interrupt and
   *  when a session reopens to an interrupted history; cleared when a fresh
   *  turn starts. Persisted across restarts. */
  interruptedSessions: Record<string, true>;
  /** Per-session "纯净的交流环境" flag: a clean session sends no preset system
   *  template (artifact-presentation), just the plain chat. Keyed by draft key
   *  or real session id. */
  cleanSessions: Record<string, boolean>;
  /** Mark `key` (a draft key or session id) as a clean session. */
  markClean: (key: string) => void;
  /** Append `text` to `sessionId`'s queue (default plan: immediately, once),
   *  then start draining it if the session is idle (a queue added while
   *  nothing runs begins immediately). */
  enqueuePrompt: (sessionId: string, text: string, plan?: Partial<QueueItem>) => void;
  /** Remove the queue entry at `index` (0-based) from `sessionId`'s queue. */
  removeQueuedPrompt: (sessionId: string, index: number) => void;
  /** Append a queue entry verbatim (no trimming) — the queue editor's Add row. */
  appendQueuedPrompt: (sessionId: string, text: string) => void;
  /** Update one queue entry in place (the queue editor's per-item editing). */
  updateQueuedPrompt: (sessionId: string, index: number, text: string) => void;
  /** Patch one queue entry's run plan / repeat count (the queue editor's
   *  per-item schedule controls). Re-plans a delay change from now. */
  updateQueueItem: (sessionId: string, index: number, patch: Partial<QueueItem>) => void;
  /** Replace `sessionId`'s whole queue (the queue editor's edit path). */
  setQueue: (sessionId: string, items: (string | QueueItem)[]) => void;
  /** Drop every queued prompt for `sessionId`. */
  clearQueue: (sessionId: string) => void;
  /** Send the next queued prompt for `sessionId` if it is idle, unblocked and
   *  past its run plan's start time, removing it from the queue first (execute
   *  one, delete one; a repeat >1 is kept at the front with repeats-1). No-op
   *  when the queue is empty, a turn is in flight, or the agent is blocked on
   *  an ask. */
  drainQueue: (sessionId: string) => void;
  /** Switch to an existing folder, or (with `dated`) create a new dated one.
   *  `key` is the draft slot the switch was made for — the folder becomes that
   *  draft's destination. Defaults to the global slot. */
  switchWorkspace: (
    target: ({ path: string } | { dated: string }) & { key?: string },
  ) => Promise<void>;
  /** Ensure a brand-new draft already has its own (pinned) dated folder before
   *  composer files are written into it — otherwise a file added to a draft
   *  lands in the pre-send folder while send would create a different dated one,
   *  orphaning it. No-op once a session exists or the folder is already pinned. */
  ensureDraftWorkspace: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  /** Load a session's history into its thread WITHOUT switching the foreground
   *  folder/stream — for background split panes so they show their conversation
   *  on launch instead of a skeleton until focused. No-op if already loaded. */
  loadHistory: (id: string) => Promise<void>;
  /** `draftKey` (a `draft:<leafId>` slot) is the per-pane draft this send may
   *  lazily create a session from — passed by tiled panes so each unbound pane
   *  keeps its own draft/thread and creates its own session on first send. */
  /** `attachments` are workspace file names from the composer's chips; the image
   *  ones are also sent as multimodal parts so a vision model sees them (#88). */
  sendPrompt: (
    text: string,
    sessionId?: string,
    draftKey?: string,
    attachments?: string[],
  ) => Promise<string | null>;
  /** Run a "!" shell command directly in the session's workspace folder —
   *  no model turn; the output folds into the thread as a bash tool row. */
  runShell: (command: string, sessionId?: string, draftKey?: string) => Promise<string | null>;
  /** Run a "/" slash command (config command / skill / MCP prompt). */
  runCommand: (name: string, args?: string, sessionId?: string, draftKey?: string) => Promise<string | null>;
  /** Interrupt a session's running turn (Stop button / Esc); the focused
   *  session when `sessionId` is omitted. */
  interrupt: (sessionId?: string) => Promise<void>;
  /** Edit a past user message: revert the session to (and including) that
   *  message — dropping it and everything after, rolling back the files those
   *  turns changed — then resend the corrected text as a new turn. Destructive:
   *  callers must confirm first. `messageID` is the id on the user block. */
  editMessage: (messageID: string, newText: string, sessionId?: string) => Promise<void>;
  /** Revert the session to (and including) a past user message WITHOUT
   *  resending — drops it and everything after and rolls back those turns'
   *  files, leaving the session idle at that point. Returns whether it
   *  succeeded (the caller prefills the composer with the message on success).
   *  Destructive: callers must confirm first. */
  revertMessage: (messageID: string, sessionId?: string) => Promise<boolean>;
  /** Check every session holding a running lock against the server: if its
   *  turn is actually over (idle was missed — SSE reconnect windows, the
   *  directory-scoped event stream), reload the missed history and unlock. */
  reconcileRunning: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** Retitle a session. Resolves false when the runtime rejected the rename
   *  (the old title stays); the caller shows nothing else. */
  renameSession: (id: string, title: string) => Promise<boolean>;
  /** File an existing conversation under a project folder (#62): the session
   *  moves, its workspace files stay put. Resolves false on failure. */
  moveSessionToWorkspace: (id: string, directory: string) => Promise<boolean>;
  /** Archive a conversation (or restore it). Nothing is deleted — archiving
   *  only takes it out of the sidebar and the default history view. */
  setSessionArchived: (id: string, archived: boolean) => Promise<boolean>;
  hideExample: (id: string) => void;
  /** Install a skill. A pasted SKILL.md is written straight into the profile's
   *  user skills dir (`installed`); anything else (a URL, a description) hands
   *  the job to an agent session (`session`, whose id the caller opens) and is
   *  adopted into that same dir when the session finishes. null on failure. */
  installSkill: (text: string) => Promise<InstallSkillResult | null>;
  /** Ensure a live background event stream for every workspace folder shown in
   *  a split pane (besides the foreground folder), and drop streams for folders
   *  no longer tiled — so sessions across DIFFERENT projects stream live at once.
   *  Desktop only (single-pane on web). */
  syncPaneStreams: (directories: string[]) => void;
}

// The internal store depends only on the runtime-agnostic AgentRuntime contract
// (see docs/rfc/agent-runtime.md). The concrete reference (dshClient) is
// kept separately so getClient() can hand Settings/setup the full dsh
// provider/MCP surface that lives outside the AgentRuntime contract.
let client: AgentRuntime | null = null;
let opencodeClient: DshRuntime | null = null;
let openSessionSeq = 0;
/** The model the user last DELIBERATELY switched to, and when. A switch does a
 *  masked reconnect, and connect() fires loadCatalog() un-awaited — so the
 *  self-heal there can run just after `switching` clears, read the reconnecting
 *  instance's not-yet-complete provider list, judge the just-picked model
 *  "dangling", and revert it to an old one (a switch then "doesn't take"; #37).
 *  Remember the choice briefly so the self-heal won't fight it during that
 *  window; a model that is GENUINELY gone still heals once the window lapses,
 *  and the send-time "model not found" error covers the gap meanwhile. */
let lastSwitchModel: string | null = null;
let lastSwitchAt = 0;
const SWITCH_HEAL_GRACE_MS = 15_000;
/** React StrictMode mounts effects twice in development. Share the same boot
 *  promise so duplicate AppShell effects cannot start dueling connect loops. */
let bootstrapInFlight: Promise<void> | null = null;
/** Registered once: the remote-access gateway tells us when a LAN/CLI client
 *  created or deleted a session so the sidebar re-lists (no OpenCode event for
 *  session create/delete). See docs/rfc/remote-access-gateway.md. */
let gatewayListenerBound = false;
/** Custom-model context-limit cleanup (#52) runs once per app run — every
 *  reconnect re-enters connect(), and the check is a config round-trip. */
let contextLimitsCleaned = false;
/** Unhook the current client's status listener BEFORE closing it — teardown
 *  emits "offline", and a reconnect attempt must not flash that at the user. */
let clientStatusUnsub: (() => void) | null = null;
/** An agent skill install in flight: the session doing it, and the workspace's
 *  skills as they were before it started. When that session goes idle whatever
 *  it added is adopted into the profile's user skills dir (#61). One at a time —
 *  the Skills page starts one install per click. */
let pendingSkillInstall: { sessionId: string | null; known: string[] } | null = null;

/** Does this text look like a SKILL.md the app can install itself (YAML
 *  frontmatter with a name)? The Rust command owns the strict rules — this only
 *  decides whether to skip the agent. */
function looksLikeSkillFile(text: string): boolean {
  const body = text.replace(/^\uFEFF/, "").trimStart();
  if (!body.startsWith("---")) return false;
  const end = body.indexOf("\n---", 3);
  return end > 0 && /^\s*name:\s*\S/m.test(body.slice(3, end));
}

/** The SDK recovers a dropped stream in ~250ms (OpenCode closes /event ~1s
 *  after a config PATCH while rebuilding its instance). Surfacing that blip
 *  repaints every status consumer, so a ready→connecting flip is held this
 *  long and only shown if the stream does not come back. */
const STATUS_BLIP_GRACE_MS = 2000;
let statusBlipTimer: ReturnType<typeof setTimeout> | null = null;
function clearStatusBlip() {
  if (statusBlipTimer !== null) clearTimeout(statusBlipTimer);
  statusBlipTimer = null;
}
/** Drop the current connection. */
function teardownClient() {
  clientStatusUnsub?.();
  clientStatusUnsub = null;
  clearStatusBlip();
  if (client) {
    client.close();
  }
  client = null;
  opencodeClient = null;
}

// ---- Cross-folder streaming (split panes) ----
// The foreground `client` streams the ACTIVE folder. Split panes showing
// sessions from OTHER folders each get a background stream here, keyed by
// directory, so they update live concurrently. All streams fold through the one
// `sharedEventHandler` — events carry `sessionId` and the store is sid-keyed, so
// N streams need no per-stream demux. Same sidecar → same baseUrl/password.
const streamClients = new Map<string, DshRuntime>();
let streamBaseUrl = "";
/** Gateway token for background streams (desktop/gateway auth), or "". */
let streamAuth = "";
/** The store's event handler, captured once (set/get are stable) so foreground
 *  and every background stream share one folding path. */
let sharedEventHandler: ((event: OpenCodeEvent) => void) | null = null;
function removeStreamClient(dir: string) {
  const c = streamClients.get(dir);
  if (c) {
    c.close();
    streamClients.delete(dir);
  }
}
function teardownStreamClients() {
  for (const c of streamClients.values()) c.close();
  streamClients.clear();
}
/** The connected client whose stream owns `sid` — its folder's background
 *  stream, else the foreground client. Session-scoped calls (send/abort/history)
 *  work through any client, but the directory-scoped interactive replies
 *  (question/permission) must go to the matching per-directory instance. */
function clientForSession(get: StoreGet, sid: string): AgentRuntime | null {
  // Subagent asks carry the CHILD sid (which may not be listed in `sessions`
  // yet); resolve to the root session to find the owning folder, mirroring how
  // belongsHere surfaces the ask in the parent's pane.
  const root = rootSessionOf(get().sessionParents, sid);
  const dir = get().sessions.find((x) => x.id === root)?.directory;
  if (dir && dir !== get().workspace) {
    const bg = streamClients.get(dir);
    if (bg) return bg;
  }
  return client;
}
const emptyThread = (): Thread => ({ blocks: [], index: {}, loaded: false });

/** Forget a draft's chosen folder — its session was created, or the user asked
 *  for a plain New. Absent means "give the next session a fresh dated folder". */
function forgetDraftFolder(s: RuntimeState, key: string) {
  if (!(key in s.draftWorkspaces)) return {};
  const draftWorkspaces = { ...s.draftWorkspaces };
  delete draftWorkspaces[key];
  return { draftWorkspaces };
}

/** Drop the global draft slot's leftovers: an aborted first message, its pane
 *  and its Build/Plan mode. Deliberately says nothing about the draft's folder —
 *  see `startDraft` vs `resetDraftView` (#69). */
function blankDraft(s: RuntimeState, key: string = DRAFT_KEY) {
  const threads = { ...s.threads };
  delete threads[key];
  const panes = { ...s.panes };
  delete panes[key];
  const sessionAgents = { ...s.sessionAgents };
  delete sessionAgents[key];
  return { currentId: null, threads, panes, sessionAgents };
}
/** Threads key for the draft conversation — its blocks move to the real
 *  session id once the session exists, so the page never visibly resets. */
export const DRAFT_KEY = "draft";

/** A tiled pane's own draft slot, keyed by its leaf id, so multiple unbound
 *  panes each hold an independent draft (thread/composer/model/agent) and each
 *  create their own session on first send — instead of sharing DRAFT_KEY. */
export const draftKeyFor = (leafId: string): string => `draft:${leafId}`;

/** The composer's agent switch: "build" edits and runs; "plan" is OpenCode's
 *  read-only planning agent (edits denied except its plan .md file). */
export type AgentMode = "build" | "plan";
/** One bounded retry for the first POSTs after a sidecar restart — the old
 *  connection occasionally dies mid-handshake ("Load failed"). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await sleep(600);
    return await fn();
  }
}
/** Dedup Sets below hold completed callIds/requestIds that never recur, but a
 *  long, tool-heavy session keeps adding to them forever (issue #34: unbounded
 *  frontend state → multi-GB WebContent). Cap each with FIFO eviction of the
 *  oldest — safe, since an evicted id belongs to a finished call. */
const DEDUP_CAP = 4000;
function remember(set: Set<string>, key: string, cap = DEDUP_CAP) {
  set.add(key);
  while (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** The app's own record of "session → workspace" association, keyed by session
 *  id. It is the source of truth for the sidebar's project grouping and is
 *  PERSISTED because the sidecar cannot always honour the move: opencode's
 *  move-session refuses to move a session into a directory owned by ANOTHER
 *  project (`current.projectID !== destination.id` — e.g. a loose "global"
 *  session added to an existing project), so the app still applies the
 *  association itself rather than silently dropping the user's request.
 *  `refreshSessions` overlays these onto the fetched list; an entry is cleared
 *  when the user moves the session elsewhere or deletes it. */
const SESSION_DIRS_KEY = "ai4s.session.dirs.v1";
function loadSessionDirs(): Record<string, string> {
  const raw = loadRecord<unknown>(SESSION_DIRS_KEY);
  const out: Record<string, string> = {};
  for (const [sid, v] of Object.entries(raw)) {
    if (typeof sid === "string" && typeof v === "string" && v) out[sid] = v;
  }
  return out;
}
const sessionDirOverrides: Record<string, string> = loadSessionDirs();
function saveSessionDirs(): void {
  saveRecord(SESSION_DIRS_KEY, sessionDirOverrides);
}

/** Tool calls already written to provenance — success events can repeat per callId. */
const recordedProvenance = new Set<string>();
/** Bash calls already written to the run store — terminal events can repeat per callId. */
const recordedRuns = new Set<string>();
const notifiedPermissions = new Set<string>();
/** A completed presentation tool can be repeated by SSE reconciliation. Layout
 *  mutations are not idempotent, so handle each call exactly once. */
const handledPresentations = new Set<string>();
/** `ssh_connect` calls already relayed to the sign-in dialog (#73). One tool call
 *  emits several `tool.updated` events — the SDK re-emits per part update, so
 *  "pending" then "running" at least — and starting a sign-in is anything but
 *  idempotent: each repeat raced another ssh master for the same ControlPath. */
const relayedSignIns = new Set<string>();

/** Sessions the user just interrupted: the thread already shows "Interrupted",
 *  so the abort's own trailing events (an "aborted" error and one or more
 *  session.idle events) must not add a second line. Armed before the abort POST
 *  and held across every trailing event; the next turn clears it (`turn → sid`). */
const interruptGuard = new Set<string>();

// ---- Auto-review (#72) ----
// Per-token review state stays outside Zustand so a background reviewer never
// repaints the foreground pane. The store only receives queued/running
// transitions and the final structured result.
/** Sessions whose CURRENT turn has written or edited a workspace file. */
const dirtyTurns = new Set<string>();
/** Exact paths observed on mutating tool events, scoped to the parent turn. */
const dirtyTurnPaths = new Map<string, Set<string>>();
/** Sessions waiting for the single review slot, oldest first. */
const reviewQueue: string[] = [];
/** Paths coalesced while a parent waits for the single review slot. */
const queuedReviewPaths = new Map<string, Set<string>>();
interface BackgroundReviewJob {
  parentId: string;
  checkpointMessageId: string;
  checkpointUserMessageId?: string;
  runtime: AgentRuntime;
  paths: string[];
}
/** Hidden fork id → the foreground checkpoint it reviews. */
const backgroundReviewJobs = new Map<string, BackgroundReviewJob>();
/** Reviews explicitly stopped by the user produce no fallback finding. */
const cancelledBackgroundReviews = new Set<string>();
/** Ignore abort/error trailing events after a hidden review has been folded
 *  back and removed; otherwise they recreate an unreachable child thread. */
const retiredBackgroundReviews = new Set<string>();
/** Synthetic result parts must not make a quiet parent look like it started a
 *  new model turn when their SSE update arrives. */
const backgroundReviewResultParts = new Set<string>();
/** Parent session holding the one global review slot. */
let reviewInFlight: string | null = null;

function mergePaths(target: Map<string, Set<string>>, sid: string, paths: Iterable<string>): void {
  const merged = target.get(sid) ?? new Set<string>();
  for (const path of paths) if (path) merged.add(path);
  if (merged.size > 0) target.set(sid, merged);
}

function takePaths(target: Map<string, Set<string>>, sid: string): string[] {
  const paths = [...(target.get(sid) ?? [])];
  target.delete(sid);
  return paths;
}

/** Forget every trace of a session's review state (session deleted, runtime
 *  torn down) so a queued id can't resurrect a review for a gone session. */
function forgetAutoReview(sid: string) {
  dirtyTurns.delete(sid);
  dirtyTurnPaths.delete(sid);
  queuedReviewPaths.delete(sid);
  const at = reviewQueue.indexOf(sid);
  if (at >= 0) reviewQueue.splice(at, 1);
  if (reviewInFlight === sid) reviewInFlight = null;
  for (const [child, job] of backgroundReviewJobs) {
    if (job.parentId !== sid && child !== sid) continue;
    backgroundReviewJobs.delete(child);
    remember(retiredBackgroundReviews, child);
    void job.runtime.abortSession(child).catch(() => {});
  }
}

/** Longest error text written to debug.log. The diagnostic value is in the first
 *  sentence; some providers append an entire response body. */
const LOG_ERROR_MAX = 300;

/**
 * An error message made safe to persist in debug.log. Provider errors are echoed
 * verbatim from an HTTP response, so one could quote back the credential that
 * failed — and debug.log is a plain file users attach to bug reports, where a key
 * must never appear (AGENTS.md). Known key shapes go first, then any long
 * secret-looking run, then a length cap.
 */
export function redactForLog(message: string): string {
  const redacted = message
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xoxb|xoxp|xapp|glpat|hf)[-_][A-Za-z0-9_-]{6,}/g, "$1-***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 ***")
    .replace(/[A-Za-z0-9_-]{40,}/g, "***");
  return redacted.length > LOG_ERROR_MAX ? `${redacted.slice(0, LOG_ERROR_MAX)}…` : redacted;
}

/**
 * A runtime error with the one thing the user cannot work out alone appended.
 * Only for failures whose text is accurate but leaves no way forward — the
 * provider's own wording is always kept, never replaced.
 */
export function explainRuntimeError(message: string): string {
  // A dangling default model (its provider removed or renamed) fails every send
  // the same way — point at where the fix lives.
  if (/model not found/i.test(message)) {
    return `${message} Pick an available model in Settings → Models.`;
  }
  // OpenAI answers `invalid_prompt` / "Request blocked." when its content filter
  // rejects the PROMPT — and a prompt is the whole conversation, resent on every
  // turn. So "try again" reproduces it exactly (observed: three identical
  // failures in a row), which reads as the app being broken. The way out is to
  // stop resending the offending history, or to ask a provider that will take it.
  if (/^request blocked\.?$/i.test(message.trim())) {
    return (
      `${message} The provider's content filter rejected this conversation, not just your last message — ` +
      `every retry resends the same history, so it will keep failing. Edit or delete the recent messages, ` +
      `start a new session, or switch to another model or provider.`
    );
  }
  return message;
}

/** Server-side truth for "is this session's turn over": the last message is an
 *  assistant message that has finished streaming (time.completed set). A last
 *  USER message means a turn was accepted but not yet answered — still running. */
export function turnIsOver(messages: HistoryMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && !!last.completed;
}

/** Server truth that a session is mid-answer RIGHT NOW: its last message is an
 *  assistant message that has not finished streaming. Deliberately narrower
 *  than `!turnIsOver` — that also reads a trailing USER message as running, a
 *  shape a crashed or never-answered turn leaves behind for good, which would
 *  strand a permanent "Working…" on any session that reloads it (#59). */
export function turnStillStreaming(messages: HistoryMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === "assistant" && !last.completed && !last.error;
}

/** True when the session's LAST message ended without finishing — its final
 *  tool step is still frozen "running"/"pending" (the turn was interrupted or
 *  the sidecar died mid-tool). Mirrors the "Interrupted" line historyToThread
 *  appends, so the sidebar's status dot agrees with the thread. */
export function lastTurnInterrupted(messages: HistoryMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  return last.parts.some(
    (p) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending"),
  );
}

/** Streamed events that prove a session's turn is still in flight. Any of them
 *  re-locks a session whose local running flag is missing — see the handler.
 *
 *  Every member is ASSISTANT progress. `message.agent` is deliberately absent
 *  even though it arrives mid-turn: the SDK emits it only for USER messages, so
 *  it cannot witness the assistant working — and OpenCode re-emits the turn's
 *  user message once the turn ENDS, about 40 ms after `session.idle`. Treating
 *  that as activity re-locked the session the instant it finished, leaving a
 *  spinner under a completed answer until `reconcileRunning` polled the server
 *  ~15 s later and rebuilt the whole thread to clear it (observed 62 times in one
 *  user's log). A turn started by ANOTHER client is still caught: by the events
 *  below once the assistant does anything, and by `turnStillStreaming` from
 *  server truth whenever the session is opened. */
const ACTIVITY_EVENTS: ReadonlySet<OpenCodeEvent["type"]> = new Set([
  "text.updated",
  "reasoning.updated",
  "step.updated",
  "tool.updated",
  "session.retry",
  "question.asked",
  "permission.asked",
]);

/** How long a history-seeded "running" flag may go without a live stream event
 *  before it is treated as an orphaned turn. A turn genuinely in flight
 *  produces an event within this window; a turn orphaned by an app restart
 *  (the sidecar was SIGKILLed mid-answer) never does. The check is
 *  self-correcting: a live-but-silent turn re-locks the moment its first event
 *  arrives, so a wrongly cleared flag heals instead of staying stuck. */
const RUN_PROOF_GRACE_MS = 4000;

/** Sessions whose "running" flag came from history (`turnStillStreaming`) and
 *  is waiting for live proof. Armed by openSession/loadHistory, cancelled by
 *  the first ACTIVITY_EVENTS for the session, fired into a stop when nothing
 *  arrives — a restart leaves an incomplete last message with no live stream,
 *  which would otherwise show a permanent "Working…" on a dead turn. */
const pendingRunProof = new Map<string, ReturnType<typeof setTimeout>>();

/** A live event for `sessionId` arrived — the turn is really streaming, so the
 *  history-seeded proof timer is no longer needed. */
function proveSessionRunning(sessionId: string): void {
  const t = pendingRunProof.get(sessionId);
  if (t !== undefined) {
    clearTimeout(t);
    pendingRunProof.delete(sessionId);
  }
}

/** Arm the run-proof timer for a session seeded as running from history. */
function armRunProof(sessionId: string): void {
  const t = pendingRunProof.get(sessionId);
  if (t !== undefined) clearTimeout(t);
  pendingRunProof.set(
    sessionId,
    setTimeout(() => {
      pendingRunProof.delete(sessionId);
      const s = useRuntimeStore.getState();
      if (!s.runningSessions[sessionId]) return; // already stopped meanwhile
      // No stream event arrived in the grace window — the turn is an orphan
      // from a killed sidecar, not a live stream. Drop it back to stopped.
      setRunningStopped(sessionId);
    }, RUN_PROOF_GRACE_MS),
  );
}

/** Clear a session's running/shell locks (the "turn is over" bookkeeping that
 *  the session.idle handler performs). */
function setRunningStopped(sessionId: string): void {
  useRuntimeStore.setState((s) => {
    const runningSessions = { ...s.runningSessions };
    const shellTurns = { ...s.shellTurns };
    if (runningSessions[sessionId] === undefined && shellTurns[sessionId] === undefined) {
      return {};
    }
    delete runningSessions[sessionId];
    delete shellTurns[sessionId];
    return { runningSessions, shellTurns };
  });
}

/** Last SSE arrival per session (monotonic sequence, not wall time). Lets a
 *  failed sync POST tell "the connection died but the turn is alive" (events
 *  kept arriving after the POST began) from "the send never took" — WKWebView
 *  kills any fetch at ~60 s, long before a long agent turn finishes. */
let sseSeq = 0;
const sseLast = new Map<string, number>();
/** When each session's async prompt POST returned, so the event handler can log
 *  first-token latency (see the multi-pane slow-first-token investigation). */
const turnPostAt = new Map<string, number>();

/** Coalescing for live bash output: a running tool emits an event per stdout
 *  write (a progress bar redraws dozens of times a second) — fold at most one
 *  partial-output update per interval per call, latest event wins. */
const LIVE_FOLD_MS = 250;
const liveFoldLast = new Map<string, number>();
const liveFoldPending = new Map<
  string,
  { sessionId: string; timer: number; event: Extract<OpenCodeEvent, { type: "tool.updated" }> }
>();

/** Streamed text/reasoning tokens fold at most once per TEXT_FOLD_MS (latest
 *  wins). Every token currently triggers a zustand set that re-runs the whole
 *  BlockList over a (possibly huge) thread; batching to ~20 folds/sec cuts the
 *  per-token JS work dramatically while still reading as smooth text. */
const TEXT_FOLD_MS = 50;
const textFoldLast = new Map<string, number>();
const textFoldPending = new Map<
  string,
  {
    timer: number;
    event: Extract<OpenCodeEvent, { type: "text.updated" | "reasoning.updated" }>;
  }
>();

/** Drop a session's queued partial TOOL folds — when its turn ends (idle,
 *  error, interrupt) a late timer must not fold a stale "running" event into a
 *  thread the history reload may have rebuilt. Streamed TEXT folds are NOT
 *  cleared here: the final tokens are only ever applied via folding (idle does
 *  not reload history), so they are flushed at idle instead (see applyFold). */
function clearLiveFolds(sessionId: string) {
  for (const [callId, p] of liveFoldPending) {
    if (p.sessionId !== sessionId) continue;
    window.clearTimeout(p.timer);
    liveFoldPending.delete(callId);
    liveFoldLast.delete(callId);
  }
}

/** Resolve a (possibly nested) subagent session to its top-level session —
 *  a subagent's question/permission belongs to the conversation the user sees. */
/** Turn exactly one right-pane view on (and every other one off) for a pane.
 *  Turning a view off leaves the rest as they were. An open artifact is closed
 *  whenever a view opens — the pane shows one thing at a time. */
function showOnly(
  s: { panes: Record<string, PaneState>; currentId: string | null },
  sessionId: string | undefined,
  view: "showFiles" | "showRuns" | "showAgents",
  show: boolean,
): { panes: Record<string, PaneState> } {
  const key = sessionId ?? s.currentId ?? DRAFT_KEY;
  const p = s.panes[key];
  const base: PaneState = {
    artifact: show ? null : (p?.artifact ?? null),
    showFiles: false,
    showRuns: false,
    showAgents: false,
  };
  const next: PaneState = show
    ? { ...base, [view]: true }
    : {
        ...base,
        showFiles: p?.showFiles ?? false,
        showRuns: p?.showRuns ?? false,
        showAgents: p?.showAgents ?? false,
        [view]: false,
      };
  return { panes: { ...s.panes, [key]: next } };
}

export function rootSessionOf(parents: Record<string, string>, sessionId: string): string {
  let cur = sessionId;
  for (let hop = 0; parents[cur] && hop < 10; hop++) cur = parents[cur];
  return cur;
}

/** Does an interactive ask belong to the subtree an interrupt just stopped?
 *  Aborting a session takes its subagent sessions down with it — OpenCode's
 *  cancel walks the subtree — so their asks die with the parent's. */
function stoppedAsk(parents: Record<string, string>, stopped: string, askSession: string): boolean {
  return askSession === stopped || rootSessionOf(parents, askSession) === stopped;
}

type StoreSet = {
  (partial: Partial<RuntimeState>): void;
  (fn: (s: RuntimeState) => Partial<RuntimeState>): void;
};
type StoreGet = () => RuntimeState;

/**
 * The one send lifecycle (new → input → send → response), shared by plain
 * prompts, "!" shell commands and "/" slash commands:
 *   1. `echo` lands in the thread IMMEDIATELY — on a draft under DRAFT_KEY,
 *      grafted onto the real session id later, so the page never resets.
 *   2. `sending` is true from click until the POST is accepted (locks the
 *      composer); the session sits in `runningSessions` while the turn runs.
 *   3. Failures land as a red status line inside the conversation.
 * `syncTurn` marks endpoints whose POST resolves only when the turn is OVER
 * (shell/command, unlike prompt_async) — their running lock is set BEFORE the
 * POST and cleared when it settles, because session.idle arrives before the
 * POST resolves and a lock set afterwards would never clear.
 * `shell` additionally marks the turn in `shellTurns` for its duration, so
 * the event fold shows the bash output inline.
 */
async function performTurn(
  set: StoreSet,
  get: StoreGet,
  echo: string,
  post: (sid: string) => Promise<void>,
  syncTurn: boolean,
  shell = false,
  // Explicit target session. When omitted, the turn targets the focused session
  // (`currentId`) and may lazily CREATE it from the draft; when a real id is
  // given (a split pane sending to its own session), creation is skipped.
  target?: string,
  // The per-pane draft slot (`draft:<leafId>`) this send owns. When set, the
  // echo/lock/thread live under it and — if no target — the lazily-created
  // session is grafted FROM it, so each unbound tiled pane is fully independent
  // (its own draft, its own new session on first send) rather than sharing the
  // one global DRAFT_KEY. Legacy single-pane sends omit it → fall back to
  // currentId/DRAFT_KEY exactly as before.
  draftKey?: string,
): Promise<string | null> {
  if (!client) {
    set({ error: "Not connected to the OpenCode runtime." });
    return null;
  }
  // Where the draft's state is grafted from on lazy-create (this pane's own slot,
  // or the legacy global slot for a single-pane send).
  const draftSrc = draftKey ?? DRAFT_KEY;
  const echoKey = target ?? draftKey ?? get().currentId ?? DRAFT_KEY;
  if (get().sendingSessions[echoKey]) return null; // one send at a time per session
  // The lock is held under `echoKey`, but a draft's first send grafts DRAFT_KEY
  // onto the real id mid-turn — track the current key so the lock moves with it
  // (and the finally clears the right one).
  let lockKey = echoKey;
  set((s) => {
    const cur = s.threads[echoKey] ?? emptyThread();
    return {
      sending: true,
      sendingSessions: { ...s.sendingSessions, [echoKey]: true },
      threads: {
        ...s.threads,
        [echoKey]: { ...cur, loaded: true, blocks: [...cur.blocks, { kind: "user", text: echo }] },
      },
    };
  });
  // A failed turn must not auto-continue the session's prompt queue — the
  // user needs to see the error first. Only a turn that actually ran clears
  // the way for the next queued prompt (see the finally below).
  let failed = false;
  try {
    // A draft-pane send (draftKey set) always creates its OWN session — never
    // borrow currentId, which may point at a different focused pane and would
    // race the focus effect. Only a legacy (no-draftKey) send reuses currentId.
    let id = target ?? (draftKey ? null : get().currentId);
    if (!id) {
      // Lazy-create the session on the first message (#3), in THIS draft's own
      // folder. A draft the user aimed at a project carries that folder; one
      // that does not gets its own fresh dated folder
      // (~/Documents/DeepLab/sessions/<date-time>) so its files never pile
      // up in the bare base folder.
      const chosen = isTauri ? get().draftWorkspaces[draftSrc] : undefined;
      if (isTauri) {
        set({ switching: true });
        try {
          if (!chosen) {
            await newDatedWorkspace(datedWorkspaceName());
            await kernelReset().catch(() => {});
          } else if (chosen !== get().workspace) {
            // The active folder wandered off — opening any session follows it
            // into that session's folder. Go back to the one this draft was
            // aimed at, or the session lands wherever the user last looked (#69).
            await setWorkspace(chosen);
            await kernelReset().catch(() => {});
          }
          // Always rebuild the scoped client: /new and /clear keep the folder,
          // but the old session route may have just torn down directory-scoped
          // SSE, and a first send must not hang on a stale workspace instance.
          await get().connectRetry();
        } finally {
          set({ switching: false });
        }
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect before creating the session.");
        }
      }
      id = await withRetry(() => client!.createSession());
      set((s) => {
        // Graft this pane's draft conversation (and its pane state) from its own
        // slot (`draftSrc`) onto the real session id.
        const threads = { ...s.threads, [id!]: s.threads[draftSrc] ?? emptyThread() };
        delete threads[draftSrc];
        const panes = { ...s.panes };
        if (panes[draftSrc]) {
          panes[id!] = panes[draftSrc];
          delete panes[draftSrc];
        }
        const sessionAgents = { ...s.sessionAgents };
        if (sessionAgents[draftSrc]) {
          sessionAgents[id!] = sessionAgents[draftSrc];
          delete sessionAgents[draftSrc];
        }
        // The destination has done its job: the session now carries its own
        // folder. Leaving the entry would silently aim this pane's NEXT draft
        // at the same project long after the user moved on.
        const { draftWorkspaces = s.draftWorkspaces } = forgetDraftFolder(s, draftSrc);
        // Move the in-flight send lock too, so a pane keyed on the new id (the
        // draft pane follows currentId onto the real session) still reads itself
        // as sending across the graft — no flicker to an unlocked composer.
        const sendingSessions = { ...s.sendingSessions };
        if (sendingSessions[draftSrc]) {
          sendingSessions[id!] = sendingSessions[draftSrc];
          delete sendingSessions[draftSrc];
        }
        // Carry the draft's per-pane model/effort override onto the real session.
        const sessionModels = { ...s.sessionModels };
        if (sessionModels[draftSrc]) {
          sessionModels[id!] = sessionModels[draftSrc];
          delete sessionModels[draftSrc];
        }
        const sessionVariants = { ...s.sessionVariants };
        if (sessionVariants[draftSrc] !== undefined) {
          sessionVariants[id!] = sessionVariants[draftSrc];
          delete sessionVariants[draftSrc];
        }
        // Carry the persisted queues onto the real session too.
        const queues = { ...s.queues };
        if (queues[draftSrc] !== undefined) {
          queues[id!] = queues[draftSrc];
          delete queues[draftSrc];
        }
        // Carry the "clean" (no preset template) flag onto the real session.
        const cleanSessions = { ...s.cleanSessions };
        if (cleanSessions[draftSrc]) {
          cleanSessions[id!] = true;
          delete cleanSessions[draftSrc];
        }
        return {
          currentId: id,
          threads,
          panes,
          sessionAgents,
          sendingSessions,
          sessionModels,
          sessionVariants,
          draftWorkspaces,
          queues,
          cleanSessions,
        };
      });
      lockKey = id;
      // The draft's model/effort override moved onto the real id — repersist so
      // a relaunch restores this pane's model, not the global default.
      saveRecord(SESSION_MODELS_KEY, get().sessionModels);
      saveRecord(SESSION_VARIANTS_KEY, get().sessionVariants);
      moveScrollMemory(`chat:${draftSrc}`, `chat:${id}`);
      void get().refreshSessions();
    }
    const sid = id;
    interruptGuard.delete(sid); // a fresh turn folds its events normally
    unmarkInterrupted(sid); // the previous turn's interruption is over
    void logDebug(`turn → ${sid}`);
    // A fresh turn restarts step counting (the SDK resets its own counter on idle).
    if (get().stepCounts[sid])
      set((s) => {
        const stepCounts = { ...s.stepCounts };
        delete stepCounts[sid];
        return { stepCounts };
      });
    if (syncTurn) {
      set((s) => ({
        runningSessions: { ...s.runningSessions, [sid]: true },
        ...(shell ? { shellTurns: { ...s.shellTurns, [sid]: true as const } } : {}),
      }));
      const mark = sseSeq;
      try {
        await post(sid);
      } catch (err) {
        // The POST rejected — but shell/command POSTs are held open for the
        // WHOLE turn, and WKWebView kills any fetch at ~60 s. If SSE kept
        // streaming this session since the POST began, the turn is alive
        // server-side: keep the running lock (session.idle or a session error
        // will clear it) and don't report a failure that didn't happen.
        if ((sseLast.get(sid) ?? 0) > mark) {
          void logDebug(`turn POST dropped mid-turn, still running → ${sid}`);
          return sid;
        }
        // A genuinely failed POST produces no events — drop both flags here.
        // (On success the session.idle event clears the shell flag, never the
        // POST settling: SSE frames and the POST response race on separate
        // connections, and the bash-output event may land after the POST
        // resolves.)
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return { runningSessions, shellTurns };
        });
        throw err;
      }
      set((s) => {
        const runningSessions = { ...s.runningSessions };
        delete runningSessions[sid];
        return { runningSessions };
      });
    } else {
      // Timing probe (concurrent multi-pane first-token investigation): how long
      // the server takes to ACCEPT the async prompt, and — via turnPostAt, read
      // in the event handler — how long until the first streamed token. A slow
      // POST points at a cold/locked directory instance; a fast POST but slow
      // first token points at model/provider or server turn processing.
      const t0 = performance.now();
      void logDebug(`send POST → ${sid} (streams=${streamClients.size})`);
      await post(sid);
      void logDebug(`send POST ok ${sid} ${Math.round(performance.now() - t0)}ms`);
      turnPostAt.set(sid, performance.now());
      set((s) => ({ runningSessions: { ...s.runningSessions, [sid]: true } }));
      // A fresh turn starts — any previous interruption of this session is over.
      unmarkInterrupted(sid);
      // This session now runs a turn WE started — any history-seeded run-proof
      // timer from an earlier ghost is meaningless; disarm it so it can never
      // stop the live turn we just posted.
      proveSessionRunning(sid);
    }
    void logDebug("turn OK");
    return sid;
  } catch (err) {
    failed = true;
    const msg = err instanceof Error ? err.message : String(err);
    void logDebug(`turn FAILED: ${msg}`);
    // The failure belongs next to the message that caused it.
    const key = target ?? draftKey ?? get().currentId ?? DRAFT_KEY;
    set((s) => {
      const cur = s.threads[key] ?? emptyThread();
      return {
        error: msg,
        threads: {
          ...s.threads,
          [key]: {
            ...cur,
            loaded: true,
            blocks: [...cur.blocks, { kind: "status-line", text: `Send failed: ${msg}`, tone: "error" }],
          },
        },
      };
    });
    return target ?? get().currentId;
  } finally {
    // Clear the lock under its CURRENT key (`lockKey` follows the draft→session
    // graft, so this never leaks a stale DRAFT_KEY lock).
    set((s) => {
      const sendingSessions = { ...s.sendingSessions };
      delete sendingSessions[lockKey];
      return { sendingSessions, sending: Object.keys(sendingSessions).length > 0 };
    });
    // Now that the send lock is clear, let a waiting prompt queue continue. For
    // a SYNC turn (shell / command) the session.idle arrives while this lock is
    // still held, so the idle handler's drainQueue skipped — this is the second
    // chance, after the turn fully settles. Idempotent: for an async prompt the
    // running lock is still set here, so drainQueue waits for that turn's idle.
    if (!failed) get().drainQueue(lockKey);
  }
}

/** Take `sid` and its coalesced changed-file scope out of the review queue. */
function dequeueReview(sid: string): string[] | null {
  const at = reviewQueue.indexOf(sid);
  if (at < 0) return null;
  reviewQueue.splice(at, 1);
  return takePaths(queuedReviewPaths, sid);
}

function reviewFence(review: ReviewerBlock): string {
  return `\`\`\`review\n${JSON.stringify({ findings: review.findings, note: review.note })}\n\`\`\``;
}

function backgroundReviewPartId(reviewSid: string): string {
  const time = (BigInt(Date.now()) * 0x1000n).toString(16).padStart(12, "0").slice(-12);
  const suffix = reviewSid.replace(/[^A-Za-z0-9]/g, "").slice(-14).padStart(14, "0");
  return `prt_${time}${suffix}`;
}

/** Move one hidden review's structured result onto its parent checkpoint. The
 *  synthetic part persists with the parent but starts no model turn, so it is
 *  visible after reload and becomes context for the parent's next turn. */
function finishAutoReview(
  set: StoreSet,
  get: StoreGet,
  reviewSid: string,
  completed: boolean,
): boolean {
  const job = backgroundReviewJobs.get(reviewSid);
  if (!job) return false;
  backgroundReviewJobs.delete(reviewSid);
  remember(retiredBackgroundReviews, reviewSid);
  if (reviewInFlight === job.parentId) reviewInFlight = null;

  const cancelled = cancelledBackgroundReviews.delete(reviewSid);
  const blocks = get().threads[reviewSid]?.blocks ?? [];
  const emitted = [...blocks].reverse().find((block): block is ReviewerBlock => block.kind === "reviewer");
  const result = cancelled
    ? null
    : emitted ?? {
        kind: "reviewer" as const,
        findings: [],
        note: completed
          ? "Background review finished without a structured result."
          : "Background review could not complete; no findings were recorded.",
      };
  const partId = backgroundReviewPartId(reviewSid);
  if (result) remember(backgroundReviewResultParts, `${job.parentId}:${partId}`);

  set((s) => {
    const backgroundReviews = { ...s.backgroundReviews };
    delete backgroundReviews[job.parentId];
    const sessionParents = { ...s.sessionParents };
    delete sessionParents[reviewSid];
    const threads = { ...s.threads };
    delete threads[reviewSid];
    const runningSessions = { ...s.runningSessions };
    const stepCounts = { ...s.stepCounts };
    const retryNotices = { ...s.retryNotices };
    const shellTurns = { ...s.shellTurns };
    delete runningSessions[reviewSid];
    delete stepCounts[reviewSid];
    delete retryNotices[reviewSid];
    delete shellTurns[reviewSid];
    if (result) {
      const parent = threads[job.parentId] ?? emptyThread();
      const blocks = [...parent.blocks];
      let insertAt = blocks.length;
      if (job.checkpointUserMessageId) {
        const checkpointUserAt = blocks.findIndex(
          (block) =>
            block.kind === "user" && block.messageID === job.checkpointUserMessageId,
        );
        if (checkpointUserAt >= 0) {
          const nextUserAt = blocks.findIndex(
            (block, index) => index > checkpointUserAt && block.kind === "user",
          );
          if (nextUserAt >= 0) insertAt = nextUserAt;
        }
      }
      blocks.splice(insertAt, 0, result);
      const index = Object.fromEntries(
        Object.entries(parent.index).map(([key, value]) => [
          key,
          value >= insertAt ? value + 1 : value,
        ]),
      );
      index[`review:${partId}`] = insertAt;
      threads[job.parentId] = {
        ...parent,
        blocks,
        index,
        loaded: true,
      };
    }
    return {
      backgroundReviews,
      sessionParents,
      threads,
      runningSessions,
      stepCounts,
      retryNotices,
      shellTurns,
      questions: s.questions.filter((question) => question.sessionId !== reviewSid),
      permissions: s.permissions.filter((permission) => permission.sessionId !== reviewSid),
      sessions: s.sessions.filter((session) => session.id !== reviewSid),
    };
  });

  if (result) {
    void job.runtime
      .appendTextPart(job.parentId, job.checkpointMessageId, reviewFence(result), partId)
      .catch((err) =>
        logDebug(
          `auto-review result not persisted: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }
  drainReviewQueue(set, get);
  return true;
}

/** Release a review that was cancelled while its hidden fork was still being
 * prepared. A later queued review may start only if auto-review is still on. */
function releaseAutoReviewReservation(set: StoreSet, get: StoreGet, sid: string): void {
  if (reviewInFlight === sid) reviewInFlight = null;
  set((s) => {
    const backgroundReviews = { ...s.backgroundReviews };
    delete backgroundReviews[sid];
    return { backgroundReviews };
  });
  drainReviewQueue(set, get);
}

/** Run the reviewer in a hidden fork of the completed parent checkpoint. The
 *  parent remains idle and usable while this independent session streams. */
async function startAutoReview(
  set: StoreSet,
  get: StoreGet,
  sid: string,
  paths: string[],
): Promise<void> {
  const runtime = clientForSession(get, sid);
  if (!runtime) {
    drainReviewQueue(set, get);
    return;
  }
  reviewInFlight = sid;
  set((s) => ({
    backgroundReviews: { ...s.backgroundReviews, [sid]: "running" },
  }));
  let reviewSid: string | null = null;
  try {
    const messages = await runtime.getMessages(sid);
    let checkpointAt = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant" && messages[i]?.id) {
        checkpointAt = i;
        break;
      }
    }
    const checkpoint = checkpointAt >= 0 ? messages[checkpointAt]?.id : undefined;
    if (!checkpoint) throw new Error("The completed checkpoint has no assistant message id");
    // Fork's boundary is exclusive. A newer user message may already exist if
    // the foreground continued immediately; stop before it so the completed
    // assistant checkpoint is included and the newer turn is not.
    const boundary = messages.slice(checkpointAt + 1).find((message) => !!message.id)?.id;
    let checkpointUserMessageId: string | undefined;
    for (let i = checkpointAt - 1; i >= 0; i--) {
      if (messages[i]?.role === "user" && messages[i]?.id) {
        checkpointUserMessageId = messages[i]!.id;
        break;
      }
    }
    if (!get().autoReview || reviewInFlight !== sid) {
      releaseAutoReviewReservation(set, get, sid);
      return;
    }

    // Forking gives the reviewer the completed plan, prompts and response while
    // keeping its reasoning/tools out of the foreground transcript.
    reviewSid = await runtime.forkSession(sid, boundary);
    if (!get().autoReview || reviewInFlight !== sid) {
      void runtime.abortSession(reviewSid).catch(() => {});
      releaseAutoReviewReservation(set, get, sid);
      return;
    }
    backgroundReviewJobs.set(reviewSid, {
      parentId: sid,
      checkpointMessageId: checkpoint,
      checkpointUserMessageId,
      runtime,
      paths,
    });
    const parent = get().sessions.find((session) => session.id === sid);
    set((s) => ({
      sessionParents: { ...s.sessionParents, [reviewSid!]: sid },
      sessions: s.sessions.some((session) => session.id === reviewSid)
        ? s.sessions
        : [
            ...s.sessions,
            {
              id: reviewSid!,
              title: "Background review",
              parentId: sid,
              directory: parent?.directory,
              created: Date.now(),
              updated: Date.now(),
            },
          ],
    }));
    void runtime.renameSession(reviewSid, "Background review").catch(() => {});
    await runtime.setSessionArchived(reviewSid, true).catch((err) =>
      logDebug(
        `auto-review child not archived: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    // No model or effort is passed on purpose: the reviewer's own model and
    // reasoning effort come from its per-agent config (#71), and an explicit
    // per-turn model would override exactly that setting.
    await runtime.sendPrompt(reviewSid, autoReviewPrompt(paths), REVIEWER_AGENT);
    void logDebug(`auto-review ${reviewSid} → ${sid}`);
  } catch (err) {
    void logDebug(`auto-review failed: ${err instanceof Error ? err.message : String(err)}`);
    if (reviewSid && finishAutoReview(set, get, reviewSid, false)) return;
    if (reviewInFlight === sid) reviewInFlight = null;
    set((s) => {
      const backgroundReviews = { ...s.backgroundReviews };
      delete backgroundReviews[sid];
      return { backgroundReviews };
    });
    drainReviewQueue(set, get);
  }
}

/** Start the next waiting review, if the single slot is free. */
function drainReviewQueue(set: StoreSet, get: StoreGet): void {
  if (!get().autoReview) {
    const queued = reviewQueue.splice(0);
    queuedReviewPaths.clear();
    if (queued.length > 0) {
      set((s) => {
        const backgroundReviews = { ...s.backgroundReviews };
        for (const sid of queued) delete backgroundReviews[sid];
        return { backgroundReviews };
      });
    }
    return;
  }
  if (reviewInFlight) return;
  const next = reviewQueue.shift();
  if (next) void startAutoReview(set, get, next, takePaths(queuedReviewPaths, next));
}

/**
 * Auto-review bookkeeping for one `session.idle`. `reviewable` is false when the
 * turn ended in a user interrupt: there is nothing to review, but the slot still
 * has to be released if the interrupted turn WAS the review.
 */
function onTurnIdle(set: StoreSet, get: StoreGet, sid: string, reviewable: boolean): void {
  if (finishAutoReview(set, get, sid, reviewable)) return;
  // This turn's own changes are settled either way, so clear them. A review the
  // session was already OWED is different: the files that earned it are on disk
  // whether or not this turn touched anything, so its queue entry is consumed
  // only on an idle that can actually act on it — otherwise an interrupted or
  // errored turn silently cancels a review earned by an earlier one.
  const dirty = dirtyTurns.delete(sid);
  const paths = takePaths(dirtyTurnPaths, sid);
  // Both are consumed, never one or the other: `dirty || dequeueReview(sid)`
  // short-circuits, so a session that was dirty AND already owed a review kept
  // its queue entry — and the moment that review ended early (interrupted, or
  // dead server-side) the drain turned the leftover into a second paid review of
  // the same state.
  const owed = reviewable ? dequeueReview(sid) : null;
  const changedFiles = reviewable && (dirty || owed !== null);
  const scope = [...new Set([...paths, ...(owed ?? [])])];
  const s = get();
  if (
    reviewable &&
    shouldAutoReview({
      enabled: s.autoReview,
      changedFiles,
      wasReview: false,
      isSubagent: !!s.sessionParents[sid],
      hasReviewer: s.agents.some((a) => a.name === REVIEWER_AGENT),
    })
  ) {
    // The queue is the SET of sessions owed a review, so an id already waiting
    // must not be added twice: each duplicate survives the drain that started
    // its review and becomes a second, redundant paid review of the same state.
    if (reviewInFlight) {
      if (!reviewQueue.includes(sid)) reviewQueue.push(sid);
      mergePaths(queuedReviewPaths, sid, scope);
      set((state) => ({
        backgroundReviews: state.backgroundReviews[sid]
          ? state.backgroundReviews
          : { ...state.backgroundReviews, [sid]: "queued" },
      }));
    } else void startAutoReview(set, get, sid, scope);
    return;
  }
}

/** Shared core of the two destructive "go back to a past message" actions
 *  (edit-and-resend, and plain revert): stop any running turn, revert the
 *  session to `messageID` — OpenCode drops it and every later message and rolls
 *  back the files those turns changed — then mirror that truncation in the
 *  local thread. Returns whether the revert succeeded. OpenCode rejects a
 *  revert on a busy session, so the abort's trailing session.idle is given a
 *  few short retries to land first. */
async function revertToMessage(
  set: StoreSet,
  get: StoreGet,
  messageID: string,
  sessionId?: string,
): Promise<boolean> {
  const sid = sessionId ?? get().currentId;
  if (!sid || !client) return false;
  const c = client;
  if (get().runningSessions[sid]) await get().interrupt(sid);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await c.revert(sid, messageID);
      break;
    } catch (e) {
      if (attempt === 4) {
        set({ error: e instanceof Error ? e.message : "Failed to revert the message." });
        return false;
      }
      await sleep(200);
    }
  }
  set((s) => {
    const cur = s.threads[sid];
    if (!cur) return {};
    const idx = cur.blocks.findIndex((b) => b.kind === "user" && b.messageID === messageID);
    if (idx < 0) return {};
    return { threads: { ...s.threads, [sid]: { ...cur, blocks: cur.blocks.slice(0, idx) } } };
  });
  return true;
}

/** The live OpenCode client (Settings talks to the runtime's config API directly). */
export function getClient(): DshRuntime | null {
  return opencodeClient;
}

/** The reasoning variant to send with a turn: the user's pick, but only when the
 *  current default model actually exposes it. Variant vocabularies differ per
 *  model (OpenAI has "minimal", Anthropic has "max", many models have none), so
 *  switching to a model without the chosen level cleanly sends nothing and lets
 *  OpenCode apply that model's default effort. */
function variantExposed(
  providers: RuntimeState["providers"],
  model: string | null,
  variant: string | null | undefined,
): string | undefined {
  if (!variant || !model) return undefined;
  const i = model.indexOf("/");
  if (i <= 0) return undefined;
  const m = providers
    .find((p) => p.id === model.slice(0, i))
    ?.models.find((mm) => mm.id === model.slice(i + 1));
  return m?.variants?.includes(variant) ? variant : undefined;
}
/** OpenCode's primary agent when the composer is not in plan mode. */
export const PRIMARY_AGENT = "build";

/**
 * Which agent will actually run this pane's next turn, or null when the catalog
 * has no such agent (an older or custom sidecar). Null means nothing may be
 * inferred from a per-agent setting, so the caller keeps sending the model.
 */
export function agentForTurn(
  state: Pick<RuntimeState, "sessionAgents" | "agents">,
  key: string,
): string | null {
  const name = state.sessionAgents[key] === "plan" ? "plan" : PRIMARY_AGENT;
  return state.agents.some((a) => a.name === name) ? name : null;
}

/** The model + reasoning effort for a session's turn: its own per-pane override
 *  if set, else a configured agent model (#96), else the global default. */
function modelForSession(state: RuntimeState, key: string): { model: string | null; variant: string | undefined } {
  // An agent carrying its own configured model OWNS the turn: sending an
  // explicit per-turn model would override exactly that setting, which is why
  // the `build` row used to do nothing and Plan mode ignored its own model
  // (#96). Only a model picked in THIS conversation outranks it — the same rule
  // the background reviewer already relied on by passing no model at all.
  if (!state.sessionModels[key]) {
    const agent = agentForTurn(state, key);
    if (agent && state.agentModels[agent]) return { model: null, variant: undefined };
  }
  const model = state.sessionModels[key] ?? state.defaultModel;
  const variant = variantExposed(
    state.providers,
    model,
    state.sessionVariants[key] !== undefined ? state.sessionVariants[key] : state.reasoningVariant,
  );
  return { model, variant };
}

/** An image file referenced in the prompt — an attached/pasted/dropped image
 *  (or a workspace image the user points the agent at). */
const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic)\b/i;

/** Curated fallback for the image-understanding model: when the user has not
 *  picked a "解读图片" model, route image turns to the free Zhipu vision model if
 *  that provider is configured. A user-set choice in Settings always wins. */
function freeVisionModel(state: RuntimeState): string | null {
  const z = state.providers.find((p) => p.id === "zhipu");
  if (!z) return null;
  return z.models.some((m) => m.id === "glm-4v-flash") ? "zhipu/glm-4v-flash" : null;
}

/** The model for a turn: an attached image routes to the image-understanding
 *  model (a vision chat model — this works), otherwise the session/global model.
 *  Image GENERATION is handled by the `image-tools` SKILL (image models are not
 *  streaming chat models and would fail with an SSE error), so it is never
 *  routed here. */
function modelForTurn(
  state: RuntimeState,
  key: string,
  text: string,
): { model: string | null; variant: string | undefined } {
  const chosen = modelForSession(state, key);
  if (!text) return chosen;
  if (IMAGE_FILE_RE.test(text)) {
    const vision = state.visionModel ?? freeVisionModel(state);
    if (vision) return { model: vision, variant: undefined };
  }
  return chosen;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  status: "offline",
  serverUrl: initialUrl(),
  sessions: [],
  currentId: null,
  threads: {},
  skills: [],
  agents: [],
  agentModels: {},
  agentVariants: {},
  commands: [],
  defaultModel: null,
  providers: [],
  reasoningVariant: initialReasoningVariant(),
  setReasoningVariant: (variant) => {
    if (typeof window !== "undefined") {
      if (variant) window.localStorage.setItem(REASONING_KEY, variant);
      else window.localStorage.removeItem(REASONING_KEY);
    }
    set({ reasoningVariant: variant });
  },
  autoReview: initialAutoReview(),
  setAutoReview: (enabled) => {
    if (typeof window !== "undefined") {
      if (enabled) window.localStorage.setItem(AUTO_REVIEW_KEY, "1");
      else window.localStorage.removeItem(AUTO_REVIEW_KEY);
    }
    set({ autoReview: enabled });
    if (!enabled) {
      // "Off" is immediate: discard work that has not started and abort the
      // one hidden reviewer that may currently hold the global slot.
      const pending = new Set([...reviewQueue, ...Object.keys(get().backgroundReviews)]);
      for (const sid of pending) get().cancelAutoReview(sid);
      drainReviewQueue(set, get);
    }
  },
  backgroundReviews: {},
  cancelAutoReview: (sessionId) => {
    const queuedAt = reviewQueue.indexOf(sessionId);
    if (queuedAt >= 0) reviewQueue.splice(queuedAt, 1);
    queuedReviewPaths.delete(sessionId);
    const active = [...backgroundReviewJobs.entries()].find(
      ([, job]) => job.parentId === sessionId,
    );
    if (active) {
      const [reviewSid, job] = active;
      cancelledBackgroundReviews.add(reviewSid);
      void job.runtime.abortSession(reviewSid).then(
        () => finishAutoReview(set, get, reviewSid, false),
        () => finishAutoReview(set, get, reviewSid, false),
      );
    } else if (reviewInFlight === sessionId) {
      // The fork is still being created. Clearing the reservation makes
      // startAutoReview abort it as soon as the id arrives.
      reviewInFlight = null;
      drainReviewQueue(set, get);
    }
    set((s) => {
      const backgroundReviews = { ...s.backgroundReviews };
      delete backgroundReviews[sessionId];
      return { backgroundReviews };
    });
  },
  modelSwitchError: null,
  approvalMode: "approve",
  tools: [],
  hiddenExamples: initialHidden(),
  error: null,
  questions: [],
  permissions: [],
  sessionParents: {},
  panes: {},
  sessionAgents: {},
  sessionModels: loadRecord<string>(SESSION_MODELS_KEY),
  sessionVariants: loadRecord<string | null>(SESSION_VARIANTS_KEY),
  setSessionModel: (sessionId, model) =>
    set((s) => {
      const sessionModels = { ...s.sessionModels, [sessionId]: model };
      saveRecord(SESSION_MODELS_KEY, sessionModels);
      return { sessionModels };
    }),
  clearSessionModel: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.sessionModels)) return {};
      const sessionModels = { ...s.sessionModels };
      delete sessionModels[sessionId];
      saveRecord(SESSION_MODELS_KEY, sessionModels);
      // The effort was picked FOR that model, so it goes with it.
      const sessionVariants = { ...s.sessionVariants };
      delete sessionVariants[sessionId];
      saveRecord(SESSION_VARIANTS_KEY, sessionVariants);
      return { sessionModels, sessionVariants };
    }),
  setSessionVariant: (sessionId, variant) =>
    set((s) => {
      const sessionVariants = { ...s.sessionVariants, [sessionId]: variant };
      saveRecord(SESSION_VARIANTS_KEY, sessionVariants);
      return { sessionVariants };
    }),
  visionModel: initialVisionModel(),
  setVisionModel: (model) => {
    if (typeof window !== "undefined") {
      if (model) window.localStorage.setItem(VISION_MODEL_KEY, model);
      else window.localStorage.removeItem(VISION_MODEL_KEY);
    }
    set({ visionModel: model });
    // Hand the choice to the image-tools skill so it can read images for a
    // non-vision main model; the sidecar picks the file up on each skill call.
    void setMultimodalModels(model, get().imageGenModel ?? null);
  },
  imageGenModel: initialImageGenModel(),
  setImageGenModel: (model) => {
    if (typeof window !== "undefined") {
      if (model) window.localStorage.setItem(IMAGE_GEN_MODEL_KEY, model);
      else window.localStorage.removeItem(IMAGE_GEN_MODEL_KEY);
    }
    set({ imageGenModel: model });
    void setMultimodalModels(get().visionModel ?? null, model);
  },
  setAgentMode: (mode, sessionId) =>
    set((s) => ({ sessionAgents: { ...s.sessionAgents, [sessionId ?? s.currentId ?? DRAFT_KEY]: mode } })),
  projects: [],
  workspace: null,
  webReadOnly: false,
  draftWorkspaces: {},
  switching: false,
  sending: false,
  sendingSessions: {},
  runningSessions: {},
  stepCounts: {},
  shellTurns: {},
  retryNotices: {},
  queues: loadQueues(),
  interruptedSessions: loadInterrupted(),
  cleanSessions: {},
  markClean: (key) =>
    set((s) => (s.cleanSessions[key] ? {} : { cleanSessions: { ...s.cleanSessions, [key]: true } })),

  // These write the CURRENT session's pane (DRAFT_KEY on a draft), keeping the
  // artifact inspector, the Files browser, and the Runs pane mutually exclusive
  // — one pane at a time.
  openArtifact: (artifact, sessionId) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [sessionId ?? s.currentId ?? DRAFT_KEY]: {
          artifact,
          showFiles: false,
          showRuns: false,
          showAgents: false,
        },
      },
    })),
  closeArtifact: (sessionId) =>
    set((s) => {
      const key = sessionId ?? s.currentId ?? DRAFT_KEY;
      const p = s.panes[key];
      return {
        panes: {
          ...s.panes,
          [key]: {
            artifact: null,
            showFiles: p?.showFiles ?? false,
            showRuns: p?.showRuns ?? false,
            showAgents: p?.showAgents ?? false,
          },
        },
      };
    }),
  // The right pane holds ONE thing: opening any view closes the others.
  setShowFiles: (show, sessionId) => set((s) => showOnly(s, sessionId, "showFiles", show)),
  setShowRuns: (show, sessionId) => set((s) => showOnly(s, sessionId, "showRuns", show)),
  setShowAgents: (show, sessionId) => set((s) => showOnly(s, sessionId, "showAgents", show)),
  revealFile: (sessionId, path) =>
    set((s) => {
      const key = sessionId ?? s.currentId ?? DRAFT_KEY;
      return {
        panes: {
          ...s.panes,
          [key]: {
            artifact: null,
            showFiles: true,
            showRuns: false,
            showAgents: false,
            revealPath: path,
          },
        },
      };
    }),
  clearReveal: (sessionId) =>
    set((s) => {
      const key = sessionId ?? s.currentId ?? DRAFT_KEY;
      const p = s.panes[key];
      if (!p?.revealPath) return {};
      return { panes: { ...s.panes, [key]: { ...p, revealPath: undefined } } };
    }),

  answerQuestion: async (requestId, answers) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q) return;
    // Route to the client whose folder owns the asking session (a split pane in
    // another project has its own directory-scoped instance).
    const c = clientForSession(get, q.sessionId);
    if (!c) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await c.answerQuestion(requestId, answers);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  rejectQuestion: async (requestId) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q) return;
    const c = clientForSession(get, q.sessionId);
    if (!c) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await c.rejectQuestion(requestId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  replyPermission: async (requestId, reply) => {
    const p = get().permissions.find((x) => x.requestId === requestId);
    if (!p) return;
    const c = clientForSession(get, p.sessionId);
    if (!c) return;
    // Identical pending asks (same session, action and resources — e.g. three
    // parallel reads into one folder) are ONE question to the user: answer
    // them all with one click instead of re-asking for each tool call.
    const sig = (x: PermissionAskedEvent) =>
      `${x.sessionId}|${x.action}|${x.resources.join("|")}`;
    const batch = get().permissions.filter((x) => sig(x) === sig(p));
    set((s) => ({ permissions: s.permissions.filter((x) => sig(x) !== sig(p)) }));
    const results = await Promise.allSettled(
      batch.map((x) => c.replyPermission(x.requestId, reply)),
    );
    // A 404 means that request is already resolved — the turn moved on, or a
    // duplicate in this batch was answered by the same click. The user's answer
    // landed; reporting it as a failure just alarms them about nothing. Only a
    // real failure, and only if it is not merely a stale sibling, surfaces.
    const failed = results.find(
      (r) => r.status === "rejected" && !isApiStatus(r.reason, 404),
    ) as PromiseRejectedResult | undefined;
    if (failed) {
      const err = failed.reason;
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setServerUrl: (serverUrl) => {
    if (typeof window !== "undefined") window.localStorage.setItem(URL_KEY, serverUrl);
    set({ serverUrl, modelSwitchError: null });
  },

  reloadRuntimeConfig: async (apply) => {
    set({ switching: true });
    try {
      await apply();
      await get().connectRetry();
      await get().loadCatalog();
    } finally {
      set({ switching: false });
    }
  },

  refreshAgentModels: async () => {
    // Desktop-only config (the helpers answer {} in the browser). Never worth
    // failing a connect over: an unreadable config just means "no overrides",
    // and the send then keeps passing an explicit model, which is the old
    // behavior rather than a broken one.
    try {
      const [agentModels, agentVariants] = await Promise.all([
        getAgentModels(),
        getAgentVariants(),
      ]);
      set({ agentModels, agentVariants });
    } catch {
      /* leave whatever we already had */
    }
  },

  loadCatalog: async () => {
    if (!client) return;
    void get().refreshAgentModels();
    try {
      const [firstSkills, agents, defaultModel, commands, providers] = await Promise.all([
        client.listSkills(),
        client.listAgents(),
        client.getDefaultModel().catch(() => null),
        client.listCommands().catch(() => []),
        // listProviders is OpenCodeClient-only (not on the AgentRuntime port);
        // opencodeClient is the same instance as `client`, set together.
        opencodeClient ? opencodeClient.listProviders().catch(() => []) : Promise.resolve([]),
      ]);
      // A model switch in flight owns `defaultModel`: this read may predate
      // the switch's config write, and applying it would visibly revert the
      // just-selected model.
      set(
        get().switching
          ? { agents, commands, providers }
          : { agents, defaultModel, commands, providers },
      );
      // Make the configured multimodal models visible to the image-tools skill
      // even if the user never re-picks them after this feature landed.
      void setMultimodalModels(get().visionModel ?? null, get().imageGenModel ?? null);
      // Self-heal a dangling default model. It can go stale out-of-band — its
      // provider removed, its id renamed, or the config edited outside the app
      // — and then every send fails with "model not found". Settings only
      // re-points it after a provider action, which never runs while the user
      // is just chatting, so heal it here (loadCatalog runs on every connect).
      // Skip while switching (a switch owns the model); an empty providers list
      // (transient read failure) yields no fallback, so it stays untouched. Also
      // skip a model the user just deliberately switched to (within the grace
      // window): right after a switch the reconnecting instance's provider list
      // can be incomplete, and reverting on that transient reads the user's own
      // switch as "dangling" and points it back at an old model (#37).
      const justSwitched =
        defaultModel === lastSwitchModel && Date.now() - lastSwitchAt < SWITCH_HEAL_GRACE_MS;
      if (!get().switching && !justSwitched && defaultModel) {
        const next = fallbackDefaultModel(providers, defaultModel);
        if (next) {
          try {
            await get().setDefaultModel(next);
            toast.success(
              i18n.t("settings:toast.defaultModelReset", { old: defaultModel, model: next }),
            );
          } catch {
            // Leave it stale — the send-time error still guides to Settings.
          }
        }
      }
      let skills = firstSkills;
      // The first workspace-scoped /api/skill call triggers OpenCode's lazy
      // instance init and can answer before the scan finishes — poll briefly.
      for (let i = 0; skills.length === 0 && i < 4; i++) {
        await sleep(400);
        skills = await client.listSkills();
      }
      set({ skills });
    } catch {
      /* ignore transient failures */
    }
  },

  detectTools: async () => {
    try {
      set({ tools: await probeTools() });
    } catch {
      /* ignore */
    }
  },

  setApprovalMode: async (mode) => {
    // A deliberate restart, like switchWorkspace: `switching` keeps the UI
    // rendering as connected — no status flip, no page flash.
    set({ switching: true });
    try {
      await persistApprovalMode(mode); // writes the config; restarts the sidecar
      set({ approvalMode: mode });
      await get().connectRetry();
    } finally {
      set({ switching: false });
    }
  },

  setProxySetting: async (mode, url) => {
    // Same masked restart as setApprovalMode: the proxy env applies at spawn.
    set({ switching: true });
    try {
      await persistProxySetting(mode, url); // persists; restarts the sidecar
      await get().connectRetry();
    } finally {
      set({ switching: false });
    }
  },

  setDefaultModel: async (model) => {
    if (!client) throw new Error("Not connected to the OpenCode runtime.");
    // #37 diagnostics: record what we ask for so a repro (e.g. switching after a
    // plan's quota runs out) shows the exact target model.
    void logDebug(`[provider] setDefaultModel → ${model}`);
    // Mark this as a deliberate switch so the reconnect's self-heal (loadCatalog)
    // won't revert it against a still-warming provider list (#37).
    lastSwitchModel = model;
    lastSwitchAt = Date.now();
    // Applying the model PATCHes OpenCode's global config, which closes the
    // event stream server-side. EventSource's own reconnect does not reliably
    // recover from that — it strands the app in "connecting"/disconnected until
    // a manual Connect. So do a deliberate masked reconnect (a fresh stream,
    // exactly what the manual Connect did): `switching` keeps the UI connected,
    // so switching models never flips the status or blocks the composer.
    set({ switching: true });
    try {
      await client.setDefaultModel(model);
      set({ defaultModel: model });
      if (!(await get().connectRetry())) {
        throw new Error(
          get().error ?? "Runtime did not reconnect after setting the default model.",
        );
      }
      set({ modelSwitchError: null });
      // #37 diagnostics: confirm the switch actually persisted and which providers
      // the runtime now recognizes — pinpoints "switch doesn't take" / "provider
      // not recognized" vs. a stale config-vs-auth mismatch. Best-effort, never
      // fails the switch.
      try {
        const oc = opencodeClient;
        if (oc) {
          const [applied, provs] = await Promise.all([oc.getDefaultModel(), oc.listProviders()]);
          void logDebug(
            `[provider] applied=${applied ?? "null"} providers=[${provs.map((p) => p.id).join(",")}]`,
          );
        }
      } catch (e) {
        void logDebug(`[provider] post-switch probe failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (err) {
      void logDebug(`[provider] setDefaultModel FAILED (${model}): ${err instanceof Error ? err.message : String(err)}`);
      set({ modelSwitchError: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      set({ switching: false });
    }
  },

  connect: async () => {
    // DeepLab drives exactly one runtime: the bundled DeepSeek Harness (dsh)
    // sidecar. No runtime switching exists — a connect is always a (re)connect
    // to the same sidecar, so the session view is never reset by a switch.
    // Quiet teardown of any previous connection: within a (re)connect the
    // status must never pass through "offline" — on first boot the retry loop
    // runs for minutes (macOS TCC) and each flip repaints the whole page.
    teardownClient();
    let directory: string | null;
    let password: string | null;
    let baseUrl = get().serverUrl;
    // Artifact path resolutions are relative to the workspace folder, so a
    // connect that lands somewhere else must not reuse them (#92).
    const previousWorkspace = get().workspace;
    if (isGatewayWeb) {
      // Web client: same-origin gateway; the pasted token is the gateway's
      // auth, and the workspace directory comes from /v1/whoami.
      baseUrl = gatewayOrigin();
      password = gatewayToken();
    } else if (isTauri) {
      // Desktop shell: the runtime is a bundled sidecar reached through the
      // internal same-origin gateway (the WebView origin tauri://localhost
      // cannot reach the loopback sidecar cross-origin — dsh's browser-trust
      // fence demands Origin === Host). Bootstrap already stored the gateway
      // URL in serverUrl; grab the token from IPC.
      password = await runtimePassword();
    } else {
      // Plain-browser dev (`pnpm dev`): vite proxies the same-origin /api to a
      // user-run sidecar, no token.
      password = null;
    }
    if (isGatewayWeb) {
      // Web client: the workspace directory comes from /v1/whoami.
      directory = null;
      let readOnly = false;
      try {
        const r = await fetch(`${baseUrl}/v1/whoami`, {
          headers: password ? { Authorization: `Bearer ${password}` } : {},
        });
        if (r.ok) {
          const who = (await r.json()) as { directory?: string; mode?: string };
          directory = who.directory ?? null;
          // A read-only token 403s every write — surface that in the UI
          // instead of letting "New session" / the composer fail opaquely.
          readOnly = who.mode === "read-only";
        }
      } catch {
        /* whoami is best-effort; the client still connects */
      }
      set({ serverUrl: baseUrl, workspace: directory, webReadOnly: readOnly });
    } else {
      // Scope skill discovery to the workspace folder. Desktop resolves it
      // locally (reliable IPC); browser dev keeps it null.
      directory = await workspacePath();
      set({ workspace: directory, approvalMode: await getApprovalMode() });
      if (!samePath(previousWorkspace, directory)) clearResolvedPaths();
    }
    const oc = new DshRuntime({
      baseUrl,
      directory: directory ?? undefined,
      ...(password ? { authHeader: `Bearer ${password}`, wsQueryToken: password } : {}),
    });
    opencodeClient = oc;
    client = oc;
    const c: AgentRuntime = oc;
    // Background streams reuse the same sidecar; the foreground now streams
    // this folder, so drop any background stream that was covering it (avoid a
    // double fold of the same events).
    streamBaseUrl = baseUrl;
    streamAuth = password ?? "";
    if (directory) removeStreamClient(directory);
    clientStatusUnsub = c.onStatus((status) => {
      void logDebug(`status → ${status}`);
      if (status === "connecting" && get().status === "ready") {
        // Hold the flip for STATUS_BLIP_GRACE_MS: if the SDK's own reconnect
        // lands first ("ready" clears the timer), the UI never sees the blip.
        if (statusBlipTimer === null)
          statusBlipTimer = setTimeout(() => {
            statusBlipTimer = null;
            set({ status: "connecting" });
          }, STATUS_BLIP_GRACE_MS);
        return;
      }
      clearStatusBlip();
      set({ status });
    });
    if (!sharedEventHandler)
      sharedEventHandler = (event) => {
      // text.updated fires per streamed token, and a running bash tool fires
      // per stdout write (tqdm redraws dozens of times a second) — logging
      // each one would flood debug.log with an IPC call per event.
      if (
        event.type !== "text.updated" &&
        event.type !== "reasoning.updated" &&
        !(event.type === "tool.updated" && event.status === "running")
      )
        void logDebug(
          `event ← ${event.type}${"sessionId" in event ? " " + event.sessionId : ""}` +
            // An error's TEXT is the whole diagnostic value; logging only "error"
            // meant a real report ("Request blocked." on every retry) could not be
            // explained without reading the runtime's SQLite by hand. Redacted and
            // capped: a provider echoing a credential back must not land on disk.
            (event.type === "error" ? `: ${redactForLog(event.message)}` : ""),
        );
      if (
        "sessionId" in event &&
        event.sessionId &&
        retiredBackgroundReviews.has(event.sessionId)
      )
        return;
      const backgroundReviewParent =
        "sessionId" in event && event.sessionId
          ? backgroundReviewJobs.get(event.sessionId)?.parentId
          : undefined;
      const isBackgroundReviewResult =
        event.type === "text.updated" &&
        backgroundReviewResultParts.has(`${event.sessionId}:${event.partId}`);
      if ("sessionId" in event && event.sessionId) {
        sseLast.set(event.sessionId, ++sseSeq);
        while (sseLast.size > 500) {
          const oldest = sseLast.keys().next().value;
          if (oldest === undefined) break;
          sseLast.delete(oldest);
        }
        // First streamed token after a send → log latency (multi-pane probe).
        const posted = turnPostAt.get(event.sessionId);
        if (posted !== undefined && (event.type === "text.updated" || event.type === "reasoning.updated")) {
          turnPostAt.delete(event.sessionId);
          void logDebug(`first token ← ${event.sessionId} ${Math.round(performance.now() - posted)}ms`);
        }
        // A streamed sign of life re-locks the session even when THIS app never
        // started its turn — after a reload the locks are gone (in-memory only)
        // while the server keeps working. Without this the Stop affordance never
        // comes back and a live turn can no longer be interrupted (#59). A
        // session the user just interrupted is exempt: the abort's own trailing
        // events must not resurrect its lock.
        // A stale re-lock (an SSE replay of a finished turn) is self-healing —
        // reconcileRunning checks the server and unlocks within one poll.
        const active = event.sessionId;
        if (
          ACTIVITY_EVENTS.has(event.type) &&
          !interruptGuard.has(active) &&
          !backgroundReviewParent &&
          !isBackgroundReviewResult &&
          !get().interruptedSessions[active] &&
          !get().runningSessions[active]
        ) {
          set((s) => ({ runningSessions: { ...s.runningSessions, [active]: true } }));
        }
        // A live event is the proof a history-seeded "running" flag was waiting
        // for — the turn really is streaming, so disarm its stop timer.
        if (ACTIVITY_EVENTS.has(event.type)) proveSessionRunning(active);
      }
      if (event.type === "error") {
        // A session-scoped error belongs IN the conversation (a red status
        // line where the user is looking), and it ends that session's turn so
        // the composer unlocks. Errors without a session keep the banner.
        const sid = event.sessionId;
        // After a user interrupt the abort's own "aborted" error is expected —
        // the thread already says "Interrupted"; don't add a second red line.
        if (sid) clearLiveFolds(sid);
        if (sid && interruptGuard.has(sid)) return;
        if (sid && backgroundReviewParent) {
          finishAutoReview(set, get, sid, false);
          set((s) => {
            const runningSessions = { ...s.runningSessions };
            const retryNotices = { ...s.retryNotices };
            delete runningSessions[sid];
            delete retryNotices[sid];
            return { runningSessions, retryNotices };
          });
          return;
        }
        if (sid && get().interruptedSessions[sid]) return;
        const message = explainRuntimeError(event.message);
        if (sid) {
          // This path ends the turn instead of session.idle (and returns before
          // the fold), so it owes the same auto-review bookkeeping: a turn that
          // died is not reviewed — the work is half-finished — but a REVIEW that
          // died must hand its slot back, or no session is ever reviewed again.
          onTurnIdle(set, get, sid, false);
          set((s) => {
            const cur = s.threads[sid] ?? emptyThread();
            const runningSessions = { ...s.runningSessions };
            delete runningSessions[sid];
            const retryNotices = { ...s.retryNotices };
            delete retryNotices[sid];
            return {
              runningSessions,
              retryNotices,
              threads: {
                ...s.threads,
                [sid]: {
                  ...cur,
                  loaded: true,
                  blocks: [...cur.blocks, { kind: "status-line", text: message, tone: "error" }],
                },
              },
            };
          });
        } else {
          set({ error: message });
        }
        return;
      }
      // Interactive requests live outside the thread blocks (transient UI).
      switch (event.type) {
        case "question.asked":
          set((s) => ({
            questions: [...s.questions.filter((q) => q.requestId !== event.requestId), event],
          }));
          return;
        case "question.resolved":
          set((s) => ({ questions: s.questions.filter((q) => q.requestId !== event.requestId) }));
          return;
        case "permission.asked":
          if (!notifiedPermissions.has(event.requestId)) {
            remember(notifiedPermissions, event.requestId);
            void notifyPermissionRequest({ action: event.action, resources: event.resources });
          }
          set((s) => {
            const permissions = [
              ...s.permissions.filter((p) => p.requestId !== event.requestId),
              event,
            ];
            // Mark the tool the agent is blocked on — the newest running/pending
            // step in this session — as waiting-approval, right in the transcript
            // (not just the separate permission card). The permission event has
            // no callID to match on, but the blocked tool is always the latest
            // active one. The next tool.updated restores its real status.
            const sid = event.sessionId;
            const cur = sid ? s.threads[sid] : undefined;
            if (!cur) return { permissions };
            const blocks = [...cur.blocks];
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (b.kind === "tool-call" && (b.status === "running" || b.status === "pending")) {
                blocks[i] = { ...b, status: "waiting-approval" };
                return { permissions, threads: { ...s.threads, [sid]: { ...cur, blocks } } };
              }
            }
            return { permissions };
          });
          return;
        case "permission.resolved":
          set((s) => {
            const permissions = s.permissions.filter((p) => p.requestId !== event.requestId);
            const sid = event.sessionId;
            const cur = sid ? s.threads[sid] : undefined;
            if (!cur) return { permissions };
            let changed = false;
            const blocks = cur.blocks.map((b) => {
              if (b.kind === "tool-call" && b.status === "waiting-approval") {
                changed = true;
                return { ...b, status: "running" as const };
              }
              return b;
            });
            return changed
              ? { permissions, threads: { ...s.threads, [sid]: { ...cur, blocks } } }
              : { permissions };
          });
          return;
        case "step.updated":
          set((s) => ({ stepCounts: { ...s.stepCounts, [event.sessionId]: event.step } }));
          return;
        case "session.retry":
          set((s) => ({
            retryNotices: {
              ...s.retryNotices,
              [event.sessionId]: { attempt: event.attempt, message: event.message },
            },
          }));
          return;
        case "message.agent": {
          // A user message landed. Tag the newest still-untagged user block in
          // this thread with its server id — the optimistic echo from a send
          // starts id-less, and the id is what makes the row editable later.
          // Sends are serialized, so the last untagged block is this message.
          if (event.messageID) {
            const mid = event.messageID;
            set((s) => {
              const cur = s.threads[event.sessionId];
              if (!cur) return {};
              const blocks = [...cur.blocks];
              for (let i = blocks.length - 1; i >= 0; i--) {
                const b = blocks[i];
                if (b.kind === "user" && !b.messageID) {
                  blocks[i] = { ...b, messageID: mid };
                  return { threads: { ...s.threads, [event.sessionId]: { ...cur, blocks } } };
                }
              }
              return {};
            });
          }
          // A user message names its agent. This is how the pill follows
          // OpenCode's own plan_exit "Yes" (it injects a build user message)
          // — and it self-confirms our own sends. Any OTHER agent (the auto-review
          // turn's `reviewer`, or a custom primary) is left alone: the pill only
          // speaks for the two modes it can actually show, and must not claim
          // "Build" because a turn the user did not send ran on something else.
          if (event.agent === "plan" || event.agent === "build") {
            const mode: AgentMode = event.agent;
            if (get().sessionAgents[event.sessionId] !== mode)
              set((s) => ({
                sessionAgents: { ...s.sessionAgents, [event.sessionId]: mode },
              }));
          }
          return;
        }
      }
      const sid = event.sessionId;
      if (!sid) return;
      // Any other sign of life from the session supersedes its retry notice:
      // an attempt is streaming again (text/tool events) or the turn is over.
      if (get().retryNotices[sid]) {
        set((s) => {
          const retryNotices = { ...s.retryNotices };
          delete retryNotices[sid];
          return { retryNotices };
        });
      }
      if (event.type === "session.idle") clearLiveFolds(sid);
      // Idle after a user interrupt: the thread already ends with "Interrupted"
      // — keep the locks clear and skip the fold. An abort can emit MORE than
      // one idle, so the guard must survive every trailing idle (`.has`, not
      // `.delete`); it is cleared when the next turn starts (see `turn → sid`).
      if (event.type === "session.idle" && interruptGuard.has(sid)) {
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return { runningSessions, shellTurns };
        });
        // A turn the user stopped is not reviewed — half-finished work is not
        // what a review is for — but a stopped REVIEW still has to hand back
        // its slot.
        onTurnIdle(set, get, sid, false);
        void get().refreshSessions();
        return;
      }
      // Only a file the agent actually wrote earns a review; a read-only turn
      // (questions, searches, plain analysis) has nothing to audit.
      if (
        event.type === "tool.updated" &&
        !backgroundReviewParent &&
        isMutatingTool(event.tool, event.status)
      ) {
        // Credited to the session at the top of the subagent chain, not to the one
        // that ran the tool. A subagent's own session is never reviewed (see the
        // `isSubagent` gate) because its parent's turn is what gets reviewed — so
        // attributing the write to the child meant a turn that delegated ALL of
        // its file work was reviewed by nobody.
        const root = rootSessionOf(get().sessionParents, sid);
        dirtyTurns.add(root);
        const directPath = str(event.input?.filePath) || str(event.input?.path);
        mergePaths(
          dirtyTurnPaths,
          root,
          directPath
            ? [directPath, ...provenanceInputsFromEvent(event).map((input) => input.path)]
            : provenanceInputsFromEvent(event).map((input) => input.path),
        );
      }
      // The agent reached a compute host that authenticates interactively and
      // asked us to sign in (#73). The dialog opens here, in the conversation the
      // user is already watching, and the tool waits for the shared connection —
      // so the run continues instead of dying on "Permission denied".
      if (
        event.type === "tool.updated" &&
        event.tool === "ssh_connect" &&
        (event.status === "running" || event.status === "pending")
      ) {
        const host = str(event.input?.host);
        if (host && !relayedSignIns.has(event.callId)) {
          remember(relayedSignIns, event.callId);
          void useSshStore.getState().connect(host);
        }
      }
      // A task tool names the subagent session it spawned — remember the
      // parent link so the child's permission/question asks surface in THIS
      // conversation, and refresh the list so the child's title is known.
      if (
        event.type === "tool.updated" &&
        event.childSessionId &&
        get().sessionParents[event.childSessionId] !== sid
      ) {
        const child = event.childSessionId;
        set((s) => ({ sessionParents: { ...s.sessionParents, [child]: sid } }));
        void get().refreshSessions();
      }
      const applyFold = (ev: typeof event) =>
        set((s) => {
          const cur = s.threads[sid] ?? emptyThread();
          const folded = foldEvent(
            { blocks: cur.blocks, index: cur.index },
            ev,
            { shellTurn: !!s.shellTurns[sid] },
          );
          const threads = { ...s.threads, [sid]: { ...cur, ...folded, loaded: true } };
          // The turn is over — unlock the composer and drop the "Working…" row.
          // The shell flag clears HERE (not when the POST settles): within the
          // SSE stream the bash-output event always precedes session.idle.
          //
          // ONLY session.idle may touch these three maps. Cloning them on every
          // folded event handed a NEW identity to every whole-map subscriber on
          // every streamed token — repainting every pane and the sidebar for a
          // BACKGROUND session's stream, which is exactly what #34's per-field
          // selectors exist to prevent. With concurrent subagents that fan-out
          // multiplied per live child and starved the main thread (#50).
          if (ev.type !== "session.idle") return { threads };
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          const stepCounts = { ...s.stepCounts };
          delete runningSessions[sid];
          delete shellTurns[sid];
          delete stepCounts[sid];
          return { runningSessions, shellTurns, stepCounts, threads };
        });
      // The turn is over — any history-seeded run-proof timer is moot.
      proveSessionRunning(sid);
      // A running bash tool streams its stdout tail on every write — dozens
      // of events per second under a progress bar. Fold at most one partial
      // update per LIVE_FOLD_MS per call (latest wins); everything else
      // (status changes, completion) folds immediately and supersedes.
      if (event.type === "tool.updated" && !backgroundReviewParent) {
        if (event.status === "running" && event.partialOutput !== undefined) {
          const now = Date.now();
          const last = liveFoldLast.get(event.callId) ?? 0;
          if (now - last < LIVE_FOLD_MS) {
            const pending = liveFoldPending.get(event.callId);
            if (pending) pending.event = event;
            else {
              const callId = event.callId;
              const timer = window.setTimeout(() => {
                const p = liveFoldPending.get(callId);
                liveFoldPending.delete(callId);
                if (!p) return;
                liveFoldLast.set(callId, Date.now());
                applyFold(p.event);
              }, LIVE_FOLD_MS - (now - last));
              liveFoldPending.set(event.callId, { sessionId: sid, timer, event });
            }
            return;
          }
          liveFoldLast.set(event.callId, now);
        } else {
          const pending = liveFoldPending.get(event.callId);
          if (pending) {
            window.clearTimeout(pending.timer);
            liveFoldPending.delete(event.callId);
          }
          liveFoldLast.delete(event.callId);
        }
      }
      // Streamed text/reasoning tokens are batched: at most one fold per
      // TEXT_FOLD_MS per session (latest wins). Status/idle events and the
      // first-token latency log below are unaffected (they don't hit this branch).
      if (event.type === "text.updated" || event.type === "reasoning.updated") {
        const now = Date.now();
        const last = textFoldLast.get(sid) ?? 0;
        if (now - last < TEXT_FOLD_MS) {
          const pending = textFoldPending.get(sid);
          if (pending) {
            pending.event = event;
          } else {
            const timer = window.setTimeout(() => {
              const p = textFoldPending.get(sid);
              textFoldPending.delete(sid);
              if (!p) return;
              textFoldLast.set(sid, Date.now());
              applyFold(p.event);
            }, TEXT_FOLD_MS - (now - last));
            textFoldPending.set(sid, { timer, event });
          }
          return;
        }
        textFoldLast.set(sid, now);
      }
      // A throttled final text may still be pending when the turn ends — flush
      // it now so the last streamed tokens are not lost (idle does not reload
      // history; folding is the only way they reach the thread), then fold idle.
      if (event.type === "session.idle") {
        const pending = textFoldPending.get(sid);
        if (pending) {
          window.clearTimeout(pending.timer);
          textFoldPending.delete(sid);
          textFoldLast.delete(sid);
          applyFold(pending.event);
        }
      }
      applyFold(event);
      // After the fold, which is what clears this session's running lock — the
      // review claims it again for its own turn.
      if (event.type === "session.idle") onTurnIdle(set, get, sid, true);
      const presentationEventKey =
        event.type === "tool.updated" ? `${sid}:${event.callId}` : null;      if (
        event.type === "tool.updated" &&
        presentationEventKey &&
        !handledPresentations.has(presentationEventKey)
      ) {
        const presentation = deriveArtifactPresentation(event);
        if (presentation?.display === "panel") {
          remember(handledPresentations, presentationEventKey);
          if (presentation.target === "new-session") {
            void (async () => {
              const sourceDirectory =
                get().sessions.find((session) => session.id === sid)?.directory ?? get().workspace;
              let presentationClient: AgentRuntime | null = client;
              let temporaryClient: DshRuntime | null = null;
              try {
                if (sourceDirectory && sourceDirectory !== get().workspace) {
                  presentationClient = streamClients.get(sourceDirectory) ?? null;
                  if (!presentationClient && streamBaseUrl) {
                    temporaryClient = new DshRuntime({
                      baseUrl: streamBaseUrl,
                      directory: sourceDirectory,
                      ...(streamAuth
                        ? { authHeader: `Bearer ${streamAuth}`, wsQueryToken: streamAuth }
                        : {}),
                    });
                    await temporaryClient.connect();
                    presentationClient = temporaryClient;
                  }
                }
                if (!presentationClient) throw new Error("The source workspace is not connected.");
                const title =
                  presentation.artifact.presentation?.title ?? presentation.artifact.filename;
                const dedicatedSessionId = await presentationClient.createSession(title);
                await get().refreshSessions();
                set((state) => ({
                  sessions: state.sessions.some((session) => session.id === dedicatedSessionId)
                    ? state.sessions
                    : [
                        {
                          id: dedicatedSessionId,
                          title,
                          ...(sourceDirectory ? { directory: sourceDirectory } : {}),
                          created: Date.now(),
                          updated: Date.now(),
                        },
                        ...state.sessions,
                      ],
                  threads: {
                    ...state.threads,
                    [dedicatedSessionId]: {
                      ...(state.threads[dedicatedSessionId] ?? emptyThread()),
                      loaded: true,
                    },
                  },
                }));
                useLayoutStore
                  .getState()
                  .presentArtifact(
                    dedicatedSessionId,
                    presentation.artifact,
                    presentation.placement,
                    "new-screen",
                  );
              } finally {
                temporaryClient?.close();
              }
            })().catch((error) =>
              set({ error: error instanceof Error ? error.message : String(error) }),
            );
          } else {
            useLayoutStore
              .getState()
              .presentArtifact(
                sid,
                presentation.artifact,
                presentation.placement,
                presentation.target,
              );
          }
          // A presented file is ALSO a real file in the conversation — surface it
          // as a compact, locatable card (the "定位" action) so a produced
          // artifact is revealable from the thread like any written file, even
          // when it was created outside the write tool (e.g. a docx packed by a
          // script). Deduped by path so repeated presentations don't stack.
          const art = presentation.artifact;
          set((s) => {
            const cur = s.threads[sid] ?? emptyThread();
            if (cur.blocks.some((b) => b.kind === "artifact" && b.path === art.path)) {
              return {};
            }
            return { threads: { ...s.threads, [sid]: { ...cur, blocks: [...cur.blocks, art] } } };
          });
        }
      }
      // A completed live write becomes a provenance version. One apply_patch call
      // can touch many files, so dedupe per (call, path) rather than per call.
      if (event.type === "tool.updated") {
        for (const input of provenanceInputsFromEvent(event)) {
          const key = `${event.callId}:${input.path}`;
          if (recordedProvenance.has(key)) continue;
          remember(recordedProvenance, key);
          void recordProvenance(input, sid, get().defaultModel);
        }
      }
      // A completed experiment execution (bash running code) becomes a run —
      // its reproducibility recipe (once per call).
      if (
        event.type === "tool.updated" &&
        !backgroundReviewParent &&
        !recordedRuns.has(event.callId)
      ) {
        const run = runInputFromEvent(event);
        if (run) {
          remember(recordedRuns, event.callId);
          void recordRun(run, sid, get().defaultModel);
        }
      }
      if (event.type === "session.idle" && !backgroundReviewParent) {
        void get().refreshSessions();
        // Name the session in the snapshot: a project folder is shared by many
        // sessions, and its git history must say which one made each change.
        const sessionName = get().sessions.find((s) => s.id === sid)?.title || sid;
        void commitWorkspaceSnapshot(`Snapshot session changes (${sessionName})`)
          .then((committed) => {
            if (committed) void logDebug(`git snapshot ✓ ${sid}`);
          })
          .catch((err) =>
            logDebug(`git snapshot skipped for ${sid}: ${err instanceof Error ? err.message : String(err)}`),
          );
        // The turn finished — start the next queued prompt, if any (FIFO,
        // execute-one-remove-one). Interrupts return above before this, so a
        // stopped session never auto-continues its queue.
        get().drainQueue(sid);
      }
      // The agent finished a skill install: it wrote the skill into THIS
      // session's workspace, which the next dated session folder would leave
      // behind — copy it into the profile's user skills dir, where OpenCode
      // finds it from every workspace (#61).
      if (event.type === "session.idle" && pendingSkillInstall?.sessionId === sid) {
        const pending = pendingSkillInstall;
        // Disarmed while the copy runs, so a second idle cannot adopt twice.
        pendingSkillInstall = null;
        void get()
          .reloadRuntimeConfig(async () => {
            const adopted = await adoptWorkspaceSkills(pending.known);
            if (!adopted.length) {
              // The turn may have stopped to ask a question or wait for an
              // approval — stay armed for the turn that finishes the install
              // (unless another install has started meanwhile).
              pendingSkillInstall ??= pending;
              return;
            }
            toast.success(
              i18n.t("pages:skills.install.installed", { name: adopted.join(", ") }),
            );
          })
          .catch((err) => {
            // This used to go only to the debug log, so a skill that never made
            // it out of the session folder simply vanished when the next one was
            // created and the user had nothing to go on (#103).
            const detail = err instanceof Error ? err.message : String(err);
            void logDebug(`skill adoption failed: ${detail}`);
            toast.error(i18n.t("pages:skills.install.adoptFailed", { detail }));
          });
      }
      };
    c.onEvent(sharedEventHandler);
    try {
      void logDebug(`connect → ${get().serverUrl}`);
      await c.connect();
      void logDebug("connect OK");
      // Take the status from the runtime rather than waiting for a transition:
      // a REUSED ACP agent is already "ready", so its idempotent connect emits
      // nothing and the store would sit on the "connecting" this attempt set.
      set({ error: null, status: c.getStatus() });
      await get().refreshSessions();
      void get().refreshProjects();
      // Catalog (skills/agents/commands) fills in behind the page — a session
      // switch must not wait on it to show the conversation.
      void get().loadCatalog();
      // Every reconnect is a window where session.idle can have been missed
      // (the event stream is directory-scoped and torn down on purpose) —
      // check any session still holding a running lock against the server.
      void get().reconcileRunning();
      // Older versions wrote a blind 128k context limit for custom-endpoint
      // models with an unknown window; on models whose real window is larger
      // that guess made OpenCode manufacture a context-overflow and abort (#52).
      // Reset those once per run. Desktop only: a gateway web client may hold a
      // read-only token, and the host app does this anyway.
      // (OpenCode config; an ACP agent has no such config to clean.)
      const oc = opencodeClient;
      if (!isGatewayWeb && !contextLimitsCleaned && oc) {
        contextLimitsCleaned = true;
        // Best-effort: deferred into a promise chain so no failure — even a
        // synchronous throw — can flip an otherwise successful connect.
        void Promise.resolve()
          .then(() => oc.clearDefaultCustomModelContextLimits())
          .catch((err) =>
            logDebug(`context-limit cleanup skipped: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logDebug(`connect FAILED: ${msg}`);
      set({ error: msg, status: "error" });
    }
  },

  // First boot can be slow far beyond the process spawn: on a fresh install
  // macOS TCC ("access Documents") blocks the sidecar until the user answers,
  // so the window must cover minutes, not seconds — giving up early strands
  // the user on an error screen that a single manual Connect would fix.
  // Failed attempts are masked (status AND error): workspace switches
  // reconnect the event stream on purpose, and flashing "could not open the
  // event stream" at the user mid-switch reads as breakage. The last error is
  // surfaced only if the whole retry window is exhausted.
  connectRetry: async (tries = 120) => {
    set({ status: "connecting" });
    let lastError: string | null = null;
    for (let i = 0; i < tries; i++) {
      await get().connect();
      if (get().status === "ready") {
        set({ modelSwitchError: null });
        return true;
      }
      lastError = get().error ?? lastError;
      set({ status: "connecting", error: null });
      // Quick retries first — the server is usually up within a second (a
      // reconnect finds it already listening); back off to 1 s for the long
      // tail (first boot blocked on macOS TCC can take minutes).
      await sleep(i < 8 ? 250 : 1000);
    }
    set({ status: "error", error: lastError });
    return false;
  },

  bootstrap: () => {
    if (bootstrapInFlight) return bootstrapInFlight;
    const run = (async () => {
      void get().detectTools();
      // Web client (served by the gateway): the sidecar already runs on the host
      // — just connect to the gateway (same origin), no Tauri runtime to start.
      if (isGatewayWeb) {
        set({ serverUrl: gatewayOrigin() });
        await get().connectRetry();
        return;
      }
      if (!isTauri) return;
      void logDebug("bootstrap: starting bundled runtime");
      try {
        const url = await startRuntime();
        void logDebug(`bootstrap: runtime at ${url}`);
        if (url) set({ serverUrl: url });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void logDebug(`bootstrap FAILED: ${msg}`);
        set({ error: msg });
        return;
      }
      await get().connectRetry();
      // A remote client (LAN web / CLI) that creates or deletes a session emits
      // no OpenCode session event, so the gateway pings us to re-list — its
      // sessions then show up in the sidebar exactly like locally-made ones.
      if (!gatewayListenerBound) {
        gatewayListenerBound = true;
        try {
          const { listen } = await import("@tauri-apps/api/event");
          await listen("gateway:sessions-changed", () => void get().refreshSessions());
        } catch {
          /* event API unavailable — nothing to sync */
        }
      }
    })();
    bootstrapInFlight = run;
    const clear = () => {
      if (bootstrapInFlight === run) bootstrapInFlight = null;
    };
    void run.then(clear, clear);
    return run;
  },

  disconnect: () => {
    // Closing the event stream does not stop server-side turns. Explicitly
    // abort hidden reviewers first so reconnecting cannot leave paid work
    // running with no UI or completion handler attached.
    for (const [reviewSid, job] of backgroundReviewJobs) {
      remember(retiredBackgroundReviews, reviewSid);
      void job.runtime.abortSession(reviewSid).catch(() => {});
    }
    teardownClient();
    teardownStreamClients();
    // Nothing can be reviewed without a runtime; a stale queue would fire into
    // the next connection.
    dirtyTurns.clear();
    dirtyTurnPaths.clear();
    reviewQueue.length = 0;
    queuedReviewPaths.clear();
    backgroundReviewJobs.clear();
    cancelledBackgroundReviews.clear();
    retiredBackgroundReviews.clear();
    backgroundReviewResultParts.clear();
    reviewInFlight = null;
    set({ status: "offline", modelSwitchError: null, backgroundReviews: {} });
  },

  refreshSessions: async () => {
    if (!client) return;
    try {
      const sessions = await client.listSessions();
      set((s) => {
        // The list also names each subagent session's parent — the recovery
        // path for parent links after a reload (no live task event to learn from).
        const sessionParents = { ...s.sessionParents };
        for (const m of sessions) if (m.parentId) sessionParents[m.id] = m.parentId;
        // Overlay in-flight/persistent moves: a refresh that resolves before the
        // sidecar committed a moveSession — or that can NEVER be committed (a
        // cross-project move the sidecar refuses) — must not revert the session
        // out of its project row ("project sometimes doesn't update").
        const out = sessions.map((m) => {
          const override = sessionDirOverrides[m.id];
          if (!override || override === m.directory) return m;
          return { ...m, directory: override };
        });
        return { sessions: out, sessionParents };
      });
    } catch {
      /* ignore transient list failures */
    }
  },

  // "New" opens a blank draft — no session is created until the first message (#3).
  // A fresh draft also drops any pinned folder: back to the dated-folder default.
  startDraft: () => set((s) => ({ ...blankDraft(s), ...forgetDraftFolder(s, DRAFT_KEY) })),

  // Re-blank the draft VIEW without touching where the next session will live.
  // The folder is chosen at send time from the draft's own entry, but the user picks
  // it much earlier ("+ new session in project X"). Anything between the two
  // that merely resets the view — the focus effect when a pane loses its
  // session — must not reroute the session to a dated folder (#69); only an
  // explicit New may unpin.
  resetDraftView: () => set((s) => blankDraft(s)),

  // Local /new and /clear: clear the visible chat context, but keep the active
  // folder. The first next message creates a new OpenCode session in that same
  // folder; no session, database row, or file is deleted here. `key` is the
  // draft slot to reset — the pane's own `draft:<leafId>` for a tiled pane,
  // the global DRAFT_KEY for the single-pane fallback.
  startDraftInCurrentWorkspace: (key = DRAFT_KEY) =>
    set((s) => {
      const threads = { ...s.threads };
      threads[key] = {
        ...emptyThread(),
        loaded: true,
        blocks: [
          {
            kind: "status-line",
            text: i18n.t("session:localCommand.cleared"),
            tone: "review",
            divider: true,
          },
        ],
      };
      const panes = { ...s.panes };
      delete panes[key];
      const sessionAgents = { ...s.sessionAgents };
      delete sessionAgents[key];
      // /new and /clear deliberately stay put: aim this draft at the folder
      // it is already in, so the next session lands there and not in a dated one.
      const draftWorkspaces = s.workspace
        ? { ...s.draftWorkspaces, [key]: s.workspace }
        : s.draftWorkspaces;
      return { currentId: null, draftWorkspaces, threads, panes, sessionAgents };
    }),

  refreshProjects: async () => {
    if (!isTauri && !isGatewayWeb) return;
    try {
      set({ projects: await listProjects() });
    } catch {
      /* ignore transient scan failures */
    }
  },

  createProject: async (name) => {
    try {
      const project = await createProjectFolder(name);
      void get().refreshProjects();
      await get().switchWorkspace({ path: project.path });
      return project;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  importProject: async (path, mode) => {
    try {
      const project = await importProjectFolder(path, mode);
      void get().refreshProjects();
      await get().switchWorkspace({ path: project.path });
      return project;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  setProjectPinned: async (id, pinned) => {
    // Optimistic: flip locally so the sidebar reacts immediately, then persist.
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, pinned } : p)) }));
    try {
      await setProjectPinnedCmd(id, pinned);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    void get().refreshProjects();
  },

  setProjectColor: async (id, color) => {
    // Optimistic, mirroring setProjectPinned. `color` maps back to undefined so
    // the field disappears when cleared (matching ProjectInfo's optional field).
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, color: color ?? undefined } : p,
      ),
    }));
    try {
      await setProjectColorCmd(id, color);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    void get().refreshProjects();
  },

  deleteProject: async (id) => {
    try {
      await deleteProjectCmd(id);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
    void get().refreshProjects();
  },

  startDraftInWorkspace: async (path, key = DRAFT_KEY) => {
    // Aim the draft slot the composer will actually send under. "+ new session
    // in project X" opens its own pane, so that is `draft:<leafId>`, not the
    // global slot — aiming the wrong one sent the session to a dated folder.
    const aim = (s: RuntimeState) => ({
      draftWorkspaces: { ...s.draftWorkspaces, [key]: path },
    });
    if (samePath(get().workspace, path)) {
      // Already inside the project — a clean draft, no reconnect.
      set((s) => ({ ...blankDraft(s, key), ...aim(s) }));
      return;
    }
    await get().switchWorkspace({ path, key });
  },

  ensureDraftWorkspace: async () => {
    const s = get();
    // A session already has its folder; a draft aimed at one reuses it on send.
    // Only a draft with no folder of its own needs its dated folder materialized
    // now, so composer files and the eventual session share one workspace.
    if (!isTauri || s.currentId || s.draftWorkspaces[DRAFT_KEY]) return;
    await get().switchWorkspace({ dated: datedWorkspaceName() });
  },

  switchWorkspace: async (target) => {
    set({ switching: true });
    try {
      // Either way the draft ends up aimed at a real folder: the one the user
      // picked, or the dated one just materialized (so a file pasted into the
      // draft and the eventual session share it, rather than the send creating
      // a second dated folder and orphaning the file).
      // Both commands answer with the canonical path the runtime resolved —
      // which is exactly what the session's own `directory` will report, so aim
      // the draft at that, not at the raw string the caller passed.
      const landed =
        "dated" in target ? await newDatedWorkspace(target.dated) : await setWorkspace(target.path);
      // Reset the local kernel so it respawns in the new folder, then reconnect
      // the event stream scoped to it (connect() re-reads the active folder —
      // the sidecar itself keeps running). The switch aims the draft at that
      // folder, so the next new session lands exactly there.
      await kernelReset().catch(() => {});
      set((s) => {
        // Back to a draft in the new folder — the draft pane must not carry
        // files from the previous folder. Session panes keep their memory.
        const panes = { ...s.panes };
        delete panes[DRAFT_KEY];
        const sessionAgents = { ...s.sessionAgents };
        delete sessionAgents[DRAFT_KEY];
        const draftWorkspaces = { ...s.draftWorkspaces, [target.key ?? DRAFT_KEY]: landed };
        return { currentId: null, panes, draftWorkspaces, sessionAgents };
      });
      await get().connectRetry();
      await Promise.all([get().refreshSessions(), get().loadCatalog()]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ switching: false });
    }
  },

  openSession: async (id) => {
    const seq = ++openSessionSeq;
    set({ currentId: id });
    if (!client) return;
    // Follow the session into its own workspace folder: record it as active and
    // reconnect the event stream scoped to it, so the agent, kernel and Files
    // all operate where the session's files live. Sessions with no recorded
    // folder, or that already match the active folder, skip this.
    const dir = get().sessions.find((s) => s.id === id)?.directory;
    if (dir && dir !== get().workspace) {
      set({ switching: true });
      try {
        await setWorkspace(dir).catch(() => {});
        // A newer openSession has superseded this one — stop before starting a
        // second, dueling connectRetry. Two reconnect loops tear down each
        // other's in-flight EventSource, leaking half-open sockets until the
        // webview's per-host connection pool is exhausted and every later
        // session hangs on load. The winner (latest seq) does the reconnect.
        if (seq !== openSessionSeq) return;
        await kernelReset().catch(() => {});
        if (seq !== openSessionSeq) return;
        await get().connectRetry();
      } finally {
        // Only the still-current open clears `switching`; a superseded one must
        // not flip it off while the winner is mid-reconnect.
        if (seq === openSessionSeq) set({ switching: false });
      }
    }
    // Stamp the (now-active) workspace with this session's id so skill-recorded
    // remote runs attach to the session, not just the global Runs view.
    if (dir) void markSession(id).catch(() => {});
    if (!client) return;
    // Recover any request the agent is blocked on (asked before connect/reload).
    void (async () => {
      try {
        const [qs, ps] = await Promise.all([
          client!.listQuestions(id),
          client!.listPermissions(id),
        ]);
        // Both lists are workspace-scoped (they include subagent sessions'
        // asks) — replace by requestId so live SSE copies don't duplicate.
        set((s) => {
          const qIds = new Set(qs.map((q) => q.requestId));
          const pIds = new Set(ps.map((p) => p.requestId));
          return {
            questions: [...s.questions.filter((q) => !qIds.has(q.requestId)), ...qs],
            permissions: [...s.permissions.filter((p) => !pIds.has(p.requestId)), ...ps],
          };
        });
      } catch {
        /* pending-request recovery is best-effort */
      }
    })();
    // A session reopened while "Working…" may have finished behind our back.
    void get().reconcileRunning();
    if (get().threads[id]?.loaded) return;
    try {
      const messages = await client.getMessages(id);
      if (seq !== openSessionSeq || get().currentId !== id) return;
      const stillStreaming = turnStillStreaming(messages);
      // Re-derive the sidebar's interrupted dot from the server truth: a final
      // frozen tool step in a turn that is OVER (not still streaming) means the
      // last turn did not finish. A still-streaming turn is live (or a ghost the
      // run-proof resolves) and must not read as interrupted.
      if (lastTurnInterrupted(messages) && !stillStreaming) markInterrupted(id, []);
      else unmarkInterrupted(id);
      set((s) => ({
        threads: {
          ...s.threads,
          [id]: { ...historyToThread(messages, s.commands), loaded: true },
        },
        // Seed the agent pill from history: a session that was planning when
        // the app closed (or whose plan_exit flip fell into an SSE gap) must
        // reopen in the mode the server is actually in.
        sessionAgents: { ...s.sessionAgents, [id]: lastAgentMode(messages) },
        // …and seed the running lock the same way. The locks are in-memory, so
        // a session still mid-answer would otherwise reopen with no "Working…"
        // and no way to stop it — a silent long tool call streams no event to
        // re-lock it either (#59). The proof timer below then drops a turn that
        // was orphaned by an app restart (its last message is incomplete but no
        // stream will ever resume it) back to stopped.
        ...(stillStreaming
          ? { runningSessions: { ...s.runningSessions, [id]: true as const } }
          : {}),
      }));
      if (stillStreaming) armRunProof(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (seq !== openSessionSeq || get().currentId !== id) return;
      set((s) => ({
        error: msg,
        threads: {
          ...s.threads,
          [id]: {
            ...emptyThread(),
            loaded: true,
            blocks: [{ kind: "status-line", text: `Failed to load messages: ${msg}`, tone: "error" }],
          },
        },
      }));
    }
  },

  loadHistory: async (id) => {
    const c = client;
    if (!c || get().threads[id]?.loaded) return;
    try {
      // getMessages is session-scoped (server routes by the session's folder),
      // so any connected client works — no folder switch, unlike openSession.
      const messages = await c.getMessages(id);
      if (get().threads[id]?.loaded) return; // a live fold beat us to it
      const stillStreaming = turnStillStreaming(messages);
      if (lastTurnInterrupted(messages) && !stillStreaming) markInterrupted(id, []);
      else unmarkInterrupted(id);
      set((s) => ({
        threads: { ...s.threads, [id]: { ...historyToThread(messages, s.commands), loaded: true } },
        sessionAgents: { ...s.sessionAgents, [id]: lastAgentMode(messages) },
        // Same server-truth seeding as openSession — a background pane must not
        // adopt a still-running session as idle (#59). The proof timer drops a
        // turn orphaned by an app restart back to stopped.
        ...(stillStreaming
          ? { runningSessions: { ...s.runningSessions, [id]: true as const } }
          : {}),
      }));
      if (stillStreaming) armRunProof(id);
    } catch {
      /* best-effort; the pane keeps its skeleton and loads on focus */
    }
  },

  // ---- Prompt queues: queued prompts run one after another, each starting
  // when the previous turn completes (see drainQueue in the session.idle
  // handler). The queue is per-session, FIFO, execute-one-remove-one.
  enqueuePrompt: (sessionId, text, plan) => {
    const trimmed = text.trim();
    if (!trimmed || !sessionId) return;
    const delayMin = clampDelay(plan?.delayMin);
    const item: QueueItem = {
      text: trimmed,
      delayMin,
      repeats: clampRepeats(plan?.repeats),
      readyAt: Date.now() + delayMin * 60_000,
    };
    set((s) => {
      const queues = {
        ...s.queues,
        [sessionId]: [...(s.queues[sessionId] ?? []), item],
      };
      saveRecord(QUEUES_KEY, queues);
      return { queues };
    });
    // If the session is idle, start draining immediately so a queue added
    // while nothing runs begins right away instead of sitting forever.
    get().drainQueue(sessionId);
  },
  removeQueuedPrompt: (sessionId, index) =>
    set((s) => {
      const queue = s.queues[sessionId];
      if (!queue || index < 0 || index >= queue.length) return {};
      const next = queue.filter((_, i) => i !== index);
      const queues = { ...s.queues };
      if (next.length === 0) delete queues[sessionId];
      else queues[sessionId] = next;
      saveRecord(QUEUES_KEY, queues);
      clearQueueTimer(sessionId);
      return { queues };
    }),
  setQueue: (sessionId, items) =>
    set((s) => {
      const clean: QueueItem[] = [];
      for (const x of items) {
        const item = toQueueItem(x);
        if (item && item.text.trim()) clean.push(item);
      }
      const queues = { ...s.queues };
      if (clean.length === 0) delete queues[sessionId];
      else queues[sessionId] = clean;
      saveRecord(QUEUES_KEY, queues);
      clearQueueTimer(sessionId);
      return { queues };
    }),
  clearQueue: (sessionId) =>
    set((s) => {
      if (!s.queues[sessionId]) return {};
      const queues = { ...s.queues };
      delete queues[sessionId];
      saveRecord(QUEUES_KEY, queues);
      clearQueueTimer(sessionId);
      return { queues };
    }),
  /** Append a queue entry verbatim (no trimming) — the queue editor's Add row,
   *  which may be blank until the user types into it. Default plan: immediately,
   *  once. */
  appendQueuedPrompt: (sessionId, text) =>
    set((s) => {
      const queues = {
        ...s.queues,
        [sessionId]: [
          ...(s.queues[sessionId] ?? []),
          { text, delayMin: 0, repeats: 1, readyAt: Date.now() },
        ],
      };
      saveRecord(QUEUES_KEY, queues);
      return { queues };
    }),
  /** Update one queue entry's text in place (the queue editor's per-item
   *  editing); run plan and repeat count are left untouched. */
  updateQueuedPrompt: (sessionId, index, text) =>
    set((s) => {
      const queue = s.queues[sessionId];
      if (!queue || index < 0 || index >= queue.length) return {};
      const next = [...queue];
      next[index] = { ...next[index], text };
      const queues = { ...s.queues, [sessionId]: next };
      saveRecord(QUEUES_KEY, queues);
      return { queues };
    }),
  /** Patch one queue entry's run plan / repeat count. A changed delay re-plans
   *  the start time from now; changing either field re-wakes the queue so a
   *  "now" item fires immediately and a delayed item reschedules. */
  updateQueueItem: (sessionId, index, patch) => {
    set((s) => {
      const queue = s.queues[sessionId];
      if (!queue || index < 0 || index >= queue.length) return {};
      const current = queue[index];
      const delayMin = patch.delayMin !== undefined ? clampDelay(patch.delayMin) : current.delayMin;
      const repeats = patch.repeats !== undefined ? clampRepeats(patch.repeats) : current.repeats;
      const next = [...queue];
      next[index] = {
        ...current,
        text: patch.text ?? current.text,
        delayMin,
        repeats,
        readyAt: delayMin !== current.delayMin ? Date.now() + delayMin * 60_000 : current.readyAt,
      };
      const queues = { ...s.queues, [sessionId]: next };
      saveRecord(QUEUES_KEY, queues);
      return { queues };
    });
    // Re-wake AFTER the update is committed so drainQueue sees the new plan.
    get().drainQueue(sessionId);
  },
  drainQueue: (sid) => {
    const s = get();
    const queue = s.queues[sid];
    if (!queue || queue.length === 0) return;
    // A turn is already running or a send is in flight — the queue waits.
    if (s.runningSessions[sid] || s.sendingSessions[sid]) return;
    // The agent is blocked on a question/approval — let the user answer first.
    const blocked = (ask: { sessionId: string }) =>
      ask.sessionId === sid || rootSessionOf(s.sessionParents, ask.sessionId) === sid;
    if (s.questions.some(blocked) || s.permissions.some(blocked)) return;
    // Send through the client whose stream owns the session (a background
    // split-pane session has its own directory-scoped instance).
    const c = clientForSession(get, sid);
    if (!c) return;
    // Skip and drop any blank placeholder rows (the editor's empty Add rows).
    let skip = 0;
    while (skip < queue.length && !queue[skip].text.trim()) skip++;
    const item = queue[skip];
    if (!item) {
      // Everything was blank — drop the whole queue.
      set((st) => {
        const queues = { ...st.queues };
        delete queues[sid];
        saveRecord(QUEUES_KEY, queues);
        return { queues };
      });
      return;
    }
    // Run plan: a delayed item waits until its readyAt before starting. The
    // wake timer re-runs drainQueue at that moment (and is re-armed on every
    // drain call, so an edited plan takes effect immediately).
    const readyAt = item.readyAt ?? 0;
    if (readyAt > Date.now()) {
      wakeQueue(sid, readyAt - Date.now());
      return;
    }
    const text = item.text.trim();
    // Execute one, remove one — take it off the queue BEFORE sending so a
    // trailing duplicate idle can never re-send it. A repeat >1 stays at the
    // front with repeats-1, so the next idle re-sends the same instruction.
    const rest = queue.slice(skip + 1);
    const next = item.repeats > 1 ? [{ ...item, repeats: item.repeats - 1 }, ...rest] : rest;
    set((st) => {
      const queues = { ...st.queues };
      if (next.length === 0) delete queues[sid];
      else queues[sid] = next;
      saveRecord(QUEUES_KEY, queues);
      return { queues };
    });
    const mode = s.sessionAgents[sid];
    const agent =
      mode === "plan" && s.agents.some((a) => a.name === "plan") ? "plan" : undefined;
    // performTurn echoes the prompt into the thread, locks the composer and
    // folds the queued turn exactly like a manual send — target pins the
    // session so no new session is ever created for a queue item.
    // Image turns route to the image-understanding model when one is configured.
    const { model, variant } = modelForTurn(s, sid, text);
    // A clean session sends no preset system template.
    const clean = s.cleanSessions[sid] ? true : undefined;
    void performTurn(
      set,
      get,
      text,
      (target) => c.sendPrompt(target, text, agent, model, variant, clean),
      false,
      false,
      sid,
    );
  },

  // The send lifecycle (new → input → send → response) is shared by plain
  // prompts, "!" shell commands and "/" slash commands — see performTurn.
  sendPrompt: (text, sessionId, draftKey, attachments) => {
    // Capture the mode BEFORE performTurn: on a draft, currentId is still null
    // here (the session is created inside), so this reads the pane's draft slot
    // correctly. Pin "plan" only when the catalog actually has it — a stale mode
    // against an older/custom sidecar must not fail every send with "Agent not
    // found".
    const s = get();
    const key = sessionId ?? draftKey ?? s.currentId ?? DRAFT_KEY;
    const mode = s.sessionAgents[key];
    const agent =
      mode === "plan" && s.agents.some((a) => a.name === "plan") ? "plan" : undefined;
    // This pane's own model + effort (falling back to the global default),
    // captured now so a draft's later graft still sends the pane's choice.
    // Image turns route to the image-understanding model when one is configured.
    const { model, variant } = modelForTurn(s, key, text);
    // A clean session sends no preset system template.
    const clean = s.cleanSessions[key] ? true : undefined;
    return performTurn(
      set,
      get,
      text,
      // Attachment bytes are read INSIDE the send, not before performTurn: the
      // echo and the spinner must appear on click, not after a multi-MB read.
      (sid) =>
        withRetry(async () => {
          const files = await imageAttachmentParts(attachments ?? []);
          await client!.sendPrompt(sid, text, agent, model, variant, clean, files);
        }),
      false,
      false,
      sessionId,
      draftKey,
    );
  },

  // No retry for shell/command: re-POSTing would run the command twice.
  runShell: (command, sessionId, draftKey) => {
    const agent = get().agents.find((a) => a.mode === "primary")?.name ?? "build";
    return performTurn(
      set,
      get,
      `! ${command}`,
      (sid) => client!.runShell(sid, command, agent),
      true,
      true,
      sessionId,
      draftKey,
    );
  },

  runCommand: async (name, args, sessionId, draftKey) => {
    if (name === "new" || name === "clear") {
      get().startDraftInCurrentWorkspace(draftKey);
      return null;
    }
    return performTurn(
      set,
      get,
      args ? `/${name} ${args}` : `/${name}`,
      (sid) => client!.runCommand(sid, name, args),
      true,
      false,
      sessionId,
      draftKey,
    );
  },

  interrupt: async (sessionId) => {
    const sid = sessionId ?? get().currentId;
    // Deliberately NOT gated on the local running lock: that lock is this app's
    // guess, and a turn the app has lost track of — after a reload, or after an
    // earlier Stop cleared the lock without the turn actually dying — is exactly
    // the one the user is trying to stop (#59). Aborting an idle session is a
    // no-op server-side: the handler cancels whatever it finds (nothing) and
    // answers true, so there is nothing to protect against here.
    if (!sid || !client) return;
    // Arm the guard BEFORE the abort POST: the server answers an abort with its
    // own SSE burst (an "aborted" error and one or more session.idle events)
    // that streams back WHILE this POST is still awaited. If we armed it after
    // the await, those events would race in ahead and litter the thread with
    // "Aborted" / "done" lines before "Interrupted".
    remember(interruptGuard, sid);
    // Descendant subagent sessions stream their own events; the abort takes the
    // whole subtree down server-side, so their trailing events need the same
    // guard — otherwise they re-lock the pane the user just stopped.
    const descendants = Object.keys(get().sessionParents).filter(
      (id) => rootSessionOf(get().sessionParents, id) === sid,
    );
    for (const id of descendants) remember(interruptGuard, id);
    try {
      await client.abortSession(sid);
    } catch (err) {
      // The abort did NOT land. Saying "Interrupted" here would be a lie that
      // also hides the Stop button (the lock is what renders it), leaving a
      // live turn with no way to stop it. Keep the lock, un-arm the guard so
      // the session's events fold normally again, and surface the failure.
      interruptGuard.delete(sid);
      for (const id of descendants) interruptGuard.delete(id);
      for (const id of [sid, ...descendants]) unmarkInterrupted(id);
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    markInterrupted(sid, descendants);
    set((s) => {
      const runningSessions = { ...s.runningSessions };
      const shellTurns = { ...s.shellTurns };
      for (const id of [sid, ...descendants]) {
        delete runningSessions[id];
        delete shellTurns[id];
      }
      const cur = s.threads[sid] ?? emptyThread();
      // A step that was mid-flight when the turn was stopped never finished, so
      // it must stop looking active — its spinner otherwise turns forever on a
      // turn that is over. Reloading the session already renders exactly this
      // ("pending", see historyToThread), so the live path just has to agree.
      // Subagent threads settle too: the abort took that whole subtree down.
      const settled: Record<string, Thread> = {};
      for (const id of [sid, ...descendants]) {
        const t = id === sid ? cur : s.threads[id];
        if (!t) continue;
        settled[id] = {
          ...t,
          blocks: t.blocks.map((b) =>
            b.kind === "tool-call" && (b.status === "running" || b.status === "waiting-approval")
              ? { ...b, status: "pending" as const }
              : b,
          ),
        };
      }
      return {
        runningSessions,
        shellTurns,
        // Drop the asks the stopped turn was blocked on. The server deletes its
        // pending permission/question on interrupt but publishes NO resolved
        // event for it (Permission.ask only clears its own map in `ensuring`),
        // so nothing else would ever retire the card — it would sit there
        // forever, still clickable, answering into a request that no longer
        // exists (#59). Subagent asks go too: the abort took that subtree down.
        questions: s.questions.filter((q) => !stoppedAsk(s.sessionParents, sid, q.sessionId)),
        permissions: s.permissions.filter((p) => !stoppedAsk(s.sessionParents, sid, p.sessionId)),
        threads: {
          ...s.threads,
          ...settled,
          [sid]: {
            ...(settled[sid] ?? cur),
            loaded: true,
            blocks: [
              ...(settled[sid] ?? cur).blocks,
              { kind: "status-line", text: "Interrupted", tone: "error" },
            ],
          },
        },
      };
    });
  },

  editMessage: async (messageID, newText, sessionId) => {
    if (await revertToMessage(set, get, messageID, sessionId))
      await get().sendPrompt(newText, sessionId);
  },

  revertMessage: async (messageID, sessionId) => revertToMessage(set, get, messageID, sessionId),

  reconcileRunning: async () => {
    const c = client;
    const running = Object.keys(get().runningSessions);
    if (!c || running.length === 0) return;
    for (const sid of running) {
      try {
        const messages = await c.getMessages(sid);
        // Still ours to answer for? The lock may have cleared while we fetched.
        if (!turnIsOver(messages) || !get().runningSessions[sid]) continue;
        void logDebug(`reconcile: missed idle for ${sid} — unlocking`);
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return {
            runningSessions,
            shellTurns,
            // The idle was missed, so the tail of the turn was too — replace
            // the thread with the full history rather than leave it stale.
            threads: {
              ...s.threads,
              [sid]: { ...historyToThread(messages, s.commands), loaded: true },
            },
            // Same for the agent pill (a plan_exit flip may have been missed).
            sessionAgents: { ...s.sessionAgents, [sid]: lastAgentMode(messages) },
          };
        });
        // The turn is over (its idle was missed) — let a waiting prompt queue
        // continue where the missed idle would have.
        get().drainQueue(sid);
      } catch {
        /* best-effort — the next reconnect or poll tries again */
      }
    }
  },

  deleteSession: async (id) => {
    delete sessionDirOverrides[id];
    saveSessionDirs();
    if (client) {
      try {
        await client.deleteSession(id);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    // A queued review for a session that no longer exists would send into a
    // deleted conversation, and one in flight holds the slot forever.
    forgetAutoReview(id);
    drainReviewQueue(set, get);
    set((s) => {
      const threads = { ...s.threads };
      delete threads[id];
      const runningSessions = { ...s.runningSessions };
      delete runningSessions[id];
      const panes = { ...s.panes };
      delete panes[id];
      const sessionAgents = { ...s.sessionAgents };
      delete sessionAgents[id];
      const queues = { ...s.queues };
      if (queues[id] !== undefined) {
        delete queues[id];
        saveRecord(QUEUES_KEY, queues);
      }
      const interruptedSessions = { ...s.interruptedSessions };
      if (interruptedSessions[id] !== undefined) {
        delete interruptedSessions[id];
        saveInterrupted(interruptedSessions);
      }
      const backgroundReviews = { ...s.backgroundReviews };
      delete backgroundReviews[id];
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        threads,
        runningSessions,
        panes,
        sessionAgents,
        queues,
        interruptedSessions,
        backgroundReviews,
        currentId: s.currentId === id ? null : s.currentId,
      };
    });
  },

  renameSession: async (id, title) => {
    const trimmed = title.trim();
    const current = get().sessions.find((s) => s.id === id);
    if (!client || !trimmed || !current || trimmed === current.title) return false;
    try {
      await client.renameSession(id, trimmed);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    // Rename locally rather than re-listing: the sidebar row must change under
    // the pointer, and a full refresh would also reorder the list.
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: trimmed } : x)),
    }));
    return true;
  },

  moveSessionToWorkspace: async (id, directory) => {
    const oc = getClient();
    // Re-homing a session is OpenCode control-plane surface, not part of the
    // runtime-agnostic port — go through the concrete client.
    if (!oc) return false;
    let serverMoved = true;
    try {
      await oc.moveSession(id, directory);
    } catch (err) {
      // The sidecar refuses to move a session into a directory owned by another
      // project (`current.projectID !== destination.id`), so adding a loose
      // session to an existing project throws. That is not a reason to drop the
      // request: the app keeps its OWN session→project association below and
      // the sidebar reflects it. Surface the reason as a quiet note.
      serverMoved = false;
      const reason = err instanceof Error ? err.message : String(err);
      if (/another project|MoveSessionError/i.test(reason)) {
        void logDebug(`move-session refused by sidecar: ${reason}`);
      } else {
        set({ error: reason });
      }
    }
    // The app-level association is authoritative for the sidebar grouping and
    // persists across restarts (the sidecar may never be able to reflect a
    // cross-project move).
    sessionDirOverrides[id] = directory;
    saveSessionDirs();
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, directory } : x)),
    }));
    // The move also re-parents the session's own children; re-list so their
    // grouping follows instead of pointing at the old folder.
    void get().refreshSessions();
    return serverMoved;
  },

  setSessionArchived: async (id, archived) => {
    if (!client) return false;
    try {
      await client.setSessionArchived(id, archived);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    // The sidebar's window holds only ACTIVE conversations, so an archived one
    // leaves it at once; a restored one comes back with the next refresh.
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }));
    if (!archived) void get().refreshSessions();
    return true;
  },

  hideExample: (id) => {
    const next = Array.from(new Set([...get().hiddenExamples, id]));
    if (typeof window !== "undefined") window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    set({ hiddenExamples: next });
  },

  // Install a skill (#1). Installed skills land in the app profile's user
  // skills dir, which OpenCode scans for every workspace — writing them into
  // the session's own .opencode/skills/ loses them with that dated folder (#61).
  installSkill: async (text) => {
    // A pasted SKILL.md needs no model: the app writes it itself. This also
    // works before any provider is configured.
    if (isTauri && looksLikeSkillFile(text)) {
      try {
        const name = await installSkillMarkdown(text);
        // The sidecar restarted to rediscover it — pick the new list up.
        await get().connectRetry();
        await get().loadCatalog();
        toast.success(i18n.t("pages:skills.install.installed", { name }));
        return { kind: "installed", name };
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }
    if (!client) {
      set({ error: "Connect the runtime first to install skills." });
      return null;
    }
    try {
      // Installing a skill is not part of whatever project happens to be open:
      // give it its own plain dated folder (what any new session gets) so the
      // session does not end up filed under that project. Nobody pinned this
      // folder, so the user's next new session goes back to the default.
      if (isTauri) {
        await get().switchWorkspace({ dated: datedWorkspaceName() });
        set((s) => forgetDraftFolder(s, DRAFT_KEY));
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect after creating the install folder.");
        }
      }
      // Snapshot: whatever the agent adds on top of this is what gets adopted.
      // Only the desktop can adopt (the profile lives on the host) — over the
      // web the skill stays workspace-scoped, which is all a web client can do.
      if (isTauri) {
        pendingSkillInstall = {
          sessionId: null,
          known: await workspaceSkillNames().catch(() => []),
        };
      }
      const title = i18n.t("pages:skills.install.sectionTitle");
      const id = await client.createSession(title);
      if (pendingSkillInstall) pendingSkillInstall.sessionId = id;
      await get().refreshSessions();
      // Its OWN Screen with its own pane. Binding the install onto whatever pane
      // happened to be focused took over a conversation the user was in the
      // middle of — an install is a new piece of work, not a hijack.
      useLayoutStore.getState().openInNewGroup(id, title);
      // The turn goes through the normal send path (echo, running lock, error
      // line, stream folding) — hand-rolling the POST left the pane with no
      // message, no spinner and no way to tell a failure from a slow model.
      // Both texts are localized: the thread shows one short ask around what the
      // user typed, the model gets the full install instructions.
      const echo = i18n.t("pages:skills.install.echo", { input: text });
      const prompt = i18n.t("pages:skills.install.agentPrompt", { input: text });
      const model = modelForSession(get(), id).model;
      // Deliberately not awaited: the caller opens the new pane immediately and
      // watches the turn there (performTurn reports failures into the thread).
      void performTurn(
        set,
        get,
        echo,
        (sid) => withRetry(() => client!.sendPrompt(sid, prompt, undefined, model)),
        false,
        false,
        id,
      );
      return { kind: "session", id };
    } catch (err) {
      pendingSkillInstall = null;
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  syncPaneStreams: (directories) => {
    // The foreground `client` already streams the active folder; web is
    // single-pane. Open one background stream per OTHER folder shown, and close
    // streams for folders no longer tiled.
    if (isGatewayWeb || !opencodeClient) return;
    const foreground = get().workspace;
    const wanted = new Set(directories.filter((d): d is string => !!d && d !== foreground));
    for (const dir of [...streamClients.keys()]) {
      if (!wanted.has(dir)) removeStreamClient(dir);
    }
    for (const dir of wanted) {
      if (streamClients.has(dir)) continue;
      const c = new DshRuntime({
        baseUrl: streamBaseUrl,
        directory: dir,
        ...(streamAuth
          ? { authHeader: `Bearer ${streamAuth}`, wsQueryToken: streamAuth }
          : {}),
      });
      if (sharedEventHandler) c.onEvent(sharedEventHandler);
      streamClients.set(dir, c);
      // Best-effort: a background stream that can't open just leaves that pane
      // non-live until it's focused (foreground reconnect covers it).
      void c.connect().catch(() => {});
    }
  },
}));

/** Dated folder name like `2026-07-04-1615` for a fresh per-session workspace. */
export function datedWorkspaceName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export interface FoldState {
  blocks: ThreadBlock[];
  index: Record<string, number>;
}

/** Pure reducer: fold one normalized OpenCode event into a thread's blocks. */
/**
 * Tidy a tool-call title for the conversation: show workspace files by their
 * relative path (`demo/analyze.py`), not the full `/Users/.../OpenLab/...`
 * absolute path, so the thread reads like a researcher's log, not a shell trace.
 * The workspace path never contains spaces (by design), so a space-free run
 * ending in `DeepLab/` matches it whether or not it has a leading slash
 * (OpenCode's write-tool titles drop it).
 */
export function tidyToolTitle(title: string): string {
  return title.replace(/[^\s]*(?:DeepLab|OpenLab|OpenScience)\//g, "").trim() || title;
}

/**
 * De-noise a bash command for the one-line title: collapse whitespace and
 * strip leading `cd <dir> &&` / `cd <dir>;` hops (repeatedly), so the step
 * reads `python train.py --mode teacher`, not `cd output/very/long/path && …`.
 * The full command stays available in the expanded detail.
 */
export function humanizeCommand(command: string): string {
  let c = command.replace(/\s+/g, " ").trim();
  for (;;) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(c);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  return c || command.trim();
}

/**
 * Progress bars (tqdm, pip, curl) redraw lines with `\r` — keep only what
 * each line last drew so live output shows one updating line, not hundreds.
 */
export function foldCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** Live-tail cap: enough for a handful of lines, tiny in the store. */
const LIVE_TAIL_MAX = 4_000;
/** Expanded-detail cap: plenty to read inline, never megabytes in the store. */
const DETAIL_MAX = 64_000;
const capTail = (t: string, max: number) => (t.length > max ? "…" + t.slice(-max) : t);
const capHead = (t: string, max: number) => (t.length > max ? t.slice(0, max) + "\n…" : t);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const EDIT_TOOLS = new Set(["edit", "str_replace_editor", "apply_patch"]);

/**
 * Verb + subject for a tool step ("Ran" + `python train.py …`, "Created" +
 * `demo/analyze.py`) — recognizable at a glance, Codex-style. Tools without
 * a natural verb keep the old title fallback chain (server title → command →
 * file path → tool name).
 */
export function toolPresentation(
  tool: string,
  title: string | undefined,
  input?: Record<string, unknown>,
): { verb?: ToolVerb; title: string } {
  const command = str(input?.command);
  const filePath = str(input?.filePath) || str(input?.path);
  const fallback = tidyToolTitle(title?.trim() || command || filePath || tool || "tool");
  const file = filePath ? tidyToolTitle(filePath) : "";
  switch (tool) {
    case "bash":
      return { verb: "Ran", title: command ? humanizeCommand(tidyToolTitle(command)) : fallback };
    case "write":
    case "create":
      return { verb: "Created", title: file || fallback };
    case "edit":
    case "str_replace_editor":
    case "apply_patch":
      return { verb: "Edited", title: file || fallback };
    case "read":
      return { verb: "Read", title: file || fallback };
    case "grep":
    case "glob":
      return { verb: "Searched", title: str(input?.pattern) || fallback };
    case "list":
      return { verb: "Listed", title: file || fallback };
    case "webfetch":
      return { verb: "Fetched", title: str(input?.url) || fallback };
    default:
      return { title: fallback };
  }
}

export function foldEvent(
  state: FoldState,
  event: OpenCodeEvent,
  opts?: { shellTurn?: boolean },
): FoldState {
  const blocks = [...state.blocks];
  const index = { ...state.index };
  switch (event.type) {
    case "text.updated": {
      // A ```review fence in the agent's text becomes a structured reviewer card.
      const { clean, review } = splitReview(event.text);
      const key = `text:${event.partId}`;
      if (key in index) blocks[index[key]] = { kind: "agent", markdown: clean };
      else if (clean) {
        blocks.push({ kind: "agent", markdown: clean });
        index[key] = blocks.length - 1;
      }
      if (review) {
        const rkey = `review:${event.partId}`;
        if (rkey in index) blocks[index[rkey]] = review;
        else {
          blocks.push(review);
          index[rkey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "tool.updated": {
      // The interactive `question`/`permission` tools render as their own
      // answerable card (InteractionPrompt), not as a blank thread row. `todo*`
      // tools only report an opaque "N todos" count with no useful content —
      // pure noise in the conversation, so drop them.
      if (/question|permission|^ask$|todo/i.test(event.tool)) return { blocks, index };
      const key = `tool:${event.callId}`;
      const command = str(event.input?.command);
      const filePath = str(event.input?.filePath) || str(event.input?.path);
      const content = str(event.input?.content);
      // Some updates omit fields earlier ones carried (a task tool names its
      // subagent session once; time.start only rides the first events) —
      // carry them over from the previous version of the block.
      const prev = key in index ? blocks[index[key]] : undefined;
      const prevTool = prev?.kind === "tool-call" ? prev : undefined;
      const childSessionId = event.childSessionId ?? prevTool?.childSessionId;
      const startedAt = event.startedAt ?? prevTool?.startedAt;
      const endedAt = event.endedAt ?? prevTool?.endedAt;
      // Edit tools report a proper unified diff in metadata on completion;
      // until (or without) that, synthesize a minimal old→new view.
      const diff =
        event.diff ??
        prevTool?.diff ??
        (EDIT_TOOLS.has(event.tool) && (str(event.input?.oldString) || str(event.input?.newString))
          ? [
              ...str(event.input?.oldString).split("\n").map((l) => `- ${l}`),
              ...str(event.input?.newString).split("\n").map((l) => `+ ${l}`),
            ].join("\n")
          : undefined);
      const { verb, title } = toolPresentation(event.tool, event.title, event.input);
      const block: ThreadBlock = {
        kind: "tool-call",
        title,
        status: event.status,
        tool: event.tool,
        ...(verb ? { verb } : {}),
        ...(command ? { command } : {}),
        ...(filePath ? { filePath: tidyToolTitle(filePath) } : {}),
        ...(content ? { content: capHead(content, DETAIL_MAX) } : {}),
        ...(diff ? { diff: capHead(diff, DETAIL_MAX) } : {}),
        // Live stdout tail while running — the "is it alive?" signal.
        ...(event.status === "running" && event.partialOutput
          ? { partialOutput: capTail(foldCarriageReturns(event.partialOutput), LIVE_TAIL_MAX) }
          : {}),
        ...(event.output?.trim()
          ? { output: capTail(foldCarriageReturns(event.output), DETAIL_MAX).replace(/\s+$/, "") }
          : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(childSessionId ? { childSessionId } : {}),
        // A user-typed "!" command ran for its output — its detail opens by
        // default. Agent bash steps stay quiet one-liners until expanded.
        ...(opts?.shellTurn && event.tool === "bash" && event.output?.trim()
          ? { outputSummary: event.output.replace(/\s+$/, "") }
          : {}),
      };
      if (key in index) blocks[index[key]] = block;
      else {
        blocks.push(block);
        index[key] = blocks.length - 1;
      }
      // Surface a file the agent wrote as a traceable artifact (deduped by path).
      const artifact = deriveArtifact(event);
      if (artifact) {
        const akey = `artifact:${artifact.path}`;
        if (akey in index) blocks[index[akey]] = artifact;
        else {
          blocks.push(artifact);
          index[akey] = blocks.length - 1;
        }
      }
      const presentation = deriveArtifactPresentation(event);
      if (presentation?.display === "inline") {
        const pkey = `presentation:${event.callId}`;
        if (pkey in index) blocks[index[pkey]] = presentation.artifact;
        else {
          blocks.push(presentation.artifact);
          index[pkey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "reasoning.updated": {
      const key = `reasoning:${event.partId}`;
      const block: ThreadBlock = { kind: "reasoning", text: event.text };
      if (key in index) blocks[index[key]] = block;
      else {
        blocks.push(block);
        index[key] = blocks.length - 1;
      }
      return { blocks, index };
    }
    case "session.compacted": {
      // One marker per compaction, appended where it happened so the reader
      // can see which stretch of the conversation was summarized away.
      blocks.push({
        kind: "compaction",
        auto: event.auto,
        ...(event.overflow ? { overflow: true } : {}),
        at: Date.now(),
      });
      return { blocks, index };
    }
    case "session.idle": {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "status-line" && last.tone === "done") {
        return { blocks, index };
      }
      blocks.push({ kind: "status-line", text: "done", tone: "done" });
      return { blocks, index };
    }
    default:
      return state;
  }
}

/**
 * One-line live activity of a subagent, derived from its folded thread:
 * the latest tool step's title, "Writing…" while it streams text, and
 * "Working…" before anything is known (e.g. right after an app reload).
 */
export function subagentActivity(blocks?: ThreadBlock[]): string {
  for (let i = (blocks?.length ?? 0) - 1; i >= 0; i--) {
    const b = blocks![i];
    if (b.kind === "tool-call") return b.title;
    if (b.kind === "agent") return "Writing…";
  }
  return "Working…";
}

function mapToolStatus(status?: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

/** Convert loaded message history into thread blocks. */
/** The agent mode a session's history says it is in: the last user message's
 *  agent (upstream stamps every user message; unknown agents read as build). */
export function lastAgentMode(messages: HistoryMessage[]): AgentMode {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Only the two modes the pill can show count. A turn on any other agent —
    // the auto-review's `reviewer`, a custom primary — says nothing about which
    // mode the user left the composer in, so it is skipped rather than read as
    // Build (which would silently drop a session out of Plan mode on reload).
    if (m.role === "user" && (m.agent === "plan" || m.agent === "build")) return m.agent;
  }
  return "build";
}

export function historyToThread(messages: HistoryMessage[], commands?: CommandInfo[]): FoldState {
  const blocks: ThreadBlock[] = [];
  // OpenCode stores a slash command's EXPANDED template as the user message —
  // show the "/name args" the user actually typed instead. Templates either
  // embed a $ARGUMENTS placeholder anywhere (match prefix + suffix around it,
  // e.g. the goal plugin's <goal_command_arguments> block) or carry no
  // placeholder (typed args are appended after the template, no marker).
  // Longest template first, so one template being a prefix of another's
  // expansion can't mis-attribute.
  const templates = (commands ?? [])
    .filter((c) => c.template?.trim())
    .map((c) => ({ name: c.name, template: c.template!.trim() }))
    .sort((a, b) => b.template.length - a.template.length);
  const asTypedCommand = (text: string): string | undefined => {
    for (const t of templates) {
      const at = t.template.indexOf("$ARGUMENTS");
      if (at < 0) {
        if (!text.startsWith(t.template)) continue;
        const args = text.slice(t.template.length).trim();
        return args ? `/${t.name} ${args}` : `/${t.name}`;
      }
      const prefix = t.template.slice(0, at);
      const suffix = t.template.slice(at + "$ARGUMENTS".length).trimEnd();
      if (!text.startsWith(prefix)) continue;
      const rest = text.trimEnd();
      if (suffix && !rest.endsWith(suffix)) continue;
      const args = rest.slice(prefix.length, suffix ? rest.length - suffix.length : undefined).trim();
      return args ? `/${t.name} ${args}` : `/${t.name}`;
    }
    return undefined;
  };
  // A step frozen mid-run (the runtime restarted or the turn was killed before
  // it finished) must not spin forever in history — render it quietly and say
  // once, at the end, that the turn was interrupted. Only the FINAL message's
  // frozen steps mean the last turn did not finish: a stale "running"/"pending"
  // step from an EARLIER aborted/closed turn must not mislabel a session whose
  // last turn actually completed (it would show "Interrupted" on every reopen).
  // A turn that is STILL STREAMING (no `completed`) is not interrupted either —
  // it may be running live right now (e.g. the desktop app is mid-tool) or be
  // an orphaned ghost; the live run-proof handles the ghost, so an in-progress
  // turn must never read as "Interrupted".
  const interrupted = lastTurnInterrupted(messages) && !turnStillStreaming(messages);
  // A user-typed "!" command is recorded as a synthetic user text plus a bash
  // tool part on the next assistant message. Render it like the live path:
  // the "! cmd" echo and the output inline — never the synthetic marker text.
  let shellTurn = false;
  for (const m of messages) {
    if (m.role === "user") {
      shellTurn = m.parts.some((p) => p.type === "text" && p.synthetic);
      if (shellTurn) continue;
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      // The app's own auto-review turn (#72): the user never wrote it, so it is
      // not shown as their message — on reload as well as live. The reviewer's
      // answer and its findings card stay.
      if (text === AUTO_REVIEW_PROMPT) continue;
      const command = asTypedCommand(text);
      // Tag with the message id so the row can be edited (revert + resend).
      // A "/command" echo keeps the id too — editing re-runs the command.
      const id = m.id ? { messageID: m.id } : {};
      if (command) blocks.push({ kind: "user", text: command, ...id });
      else if (text) blocks.push({ kind: "user", text, ...id });
    } else {
      for (const p of m.parts) {
        if (p.type === "text" && p.text?.trim()) {
          const { clean, review } = splitReview(p.text);
          if (clean) blocks.push({ kind: "agent", markdown: clean });
          if (review) blocks.push(review);
        }
        else if (p.type === "reasoning" && p.text?.trim()) {
          blocks.push({ kind: "reasoning", text: p.text });
        }
        else if (p.type === "compaction") {
          // Reloading a compacted conversation must show the same marker the
          // live stream did — otherwise history looks like turns went missing.
          const c = p as unknown as { auto?: boolean; overflow?: boolean };
          blocks.push({
            kind: "compaction",
            auto: c.auto !== false,
            ...(c.overflow ? { overflow: true } : {}),
          });
        }
        else if (p.type === "tool") {
          // Interactive tools are surfaced by InteractionPrompt, not the thread;
          // `todo*` tools are opaque "N todos" noise — skip both.
          if (/question|permission|^ask$|todo/i.test(p.tool ?? "")) continue;
          const status = mapToolStatus(p.state?.status);
          const frozen = status === "running" || status === "pending";
          const command = str(p.state?.input?.command);
          const filePath = str(p.state?.input?.filePath) || str(p.state?.input?.path);
          const content = str(p.state?.input?.content);
          const diff =
            str(p.state?.metadata?.diff) ||
            (EDIT_TOOLS.has(p.tool ?? "") &&
            (str(p.state?.input?.oldString) || str(p.state?.input?.newString))
              ? [
                  ...str(p.state?.input?.oldString).split("\n").map((l) => `- ${l}`),
                  ...str(p.state?.input?.newString).split("\n").map((l) => `+ ${l}`),
                ].join("\n")
              : "");
          const userShell = shellTurn && p.tool === "bash";
          if (userShell) blocks.push({ kind: "user", text: `! ${command}` });
          const { verb, title } = toolPresentation(p.tool ?? "", p.state?.title, p.state?.input);
          blocks.push({
            kind: "tool-call",
            title,
            status: frozen ? "pending" : status,
            tool: p.tool,
            ...(verb ? { verb } : {}),
            ...(command ? { command } : {}),
            ...(filePath ? { filePath: tidyToolTitle(filePath) } : {}),
            ...(content ? { content: capHead(content, DETAIL_MAX) } : {}),
            ...(diff ? { diff: capHead(diff, DETAIL_MAX) } : {}),
            ...(p.state?.output?.trim()
              ? { output: capTail(foldCarriageReturns(p.state.output), DETAIL_MAX).replace(/\s+$/, "") }
              : {}),
            ...(typeof p.state?.time?.start === "number" ? { startedAt: p.state.time.start } : {}),
            ...(typeof p.state?.time?.end === "number" ? { endedAt: p.state.time.end } : {}),
            // The subagent session this task spawned. The live fold keeps it
            // from the event; rebuilding history dropped it, so every subagent
            // in a reloaded conversation became unopenable.
            ...(p.state?.metadata?.sessionId
              ? { childSessionId: p.state.metadata.sessionId }
              : {}),
            ...(userShell && p.state?.output?.trim()
              ? { outputSummary: p.state.output.replace(/\s+$/, "") }
              : {}),
          });
          const artifact = deriveArtifact({
            type: "tool.updated",
            sessionId: "",
            callId: "",
            tool: p.tool ?? "",
            status,
            input: p.state?.input,
            output: p.state?.output,
          });
          if (artifact) blocks.push(artifact);
          const presentation = deriveArtifactPresentation({
            type: "tool.updated",
            sessionId: "",
            callId: "",
            tool: p.tool ?? "",
            status,
            input: p.state?.input,
            output: p.state?.output,
          });
          // A presented file is also a real file in the conversation: inline
          // mode shows the preview, panel mode shows the compact card (with the
          // "定位" reveal action) — so a produced artifact is always locatable
          // from the thread on reload, like any written file.
          if (presentation?.display === "inline" || presentation?.display === "panel") {
            blocks.push(presentation.artifact);
          }
        }
      }
      // A turn that ended in a provider/runtime error must say so on reload —
      // its live session.error is gone (SSE reconnect, app restart) and an
      // empty reply followed by "done" explains nothing. User-interrupted
      // turns are not errors; the trailing "Interrupted" line covers those.
      if (m.error && !/abort/i.test(m.error)) {
        blocks.push({ kind: "status-line", text: m.error, tone: "error" });
      }
      shellTurn = false;
    }
  }
  if (interrupted) {
    blocks.push({
      kind: "status-line",
      text: "Interrupted — this turn did not finish. Send a new message to continue.",
      tone: "error",
    });
  }
  return { blocks, index: {} };
}
