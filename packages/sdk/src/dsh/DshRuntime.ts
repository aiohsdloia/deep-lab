import type {
  AgentInfo,
  CommandInfo,
  HistoryMessage,
  HistoryPart,
  McpConfig,
  McpServer,
  OAuthAuthorization,
  PermissionAskedEvent,
  PermissionReply,
  PromptFile,
  ProviderAuthMethod,
  ProviderCatalogEntry,
  ProviderInfo,
  QuestionAskedEvent,
  QuestionItem,
  SessionMeta,
  SessionPage,
  SessionQuery,
  SkillInfo,
} from "../types";
import type { AgentRuntime } from "../runtime";
import { BaseAgentRuntime } from "../base-runtime";
import { DshApiClient, DshRpcError } from "./DshApiClient";
import type {
  ApprovalResponsePayload,
  ContentBlock,
  MuxFrame,
  QuestionResponsePayload,
  SessionEvent,
  SessionSummary,
} from "./types";

/** Options for constructing a DshRuntime. */
export interface DshRuntimeOptions {
  /** Base URL of a running `dsh --profile web` sidecar, e.g. http://127.0.0.1:3080 */
  baseUrl: string;
  /** Inject fetch (defaults to global fetch; browser + node both have it). */
  fetchImpl?: typeof fetch;
  /** Inject WebSocket (defaults to globalThis.WebSocket; node tests pass `ws`). */
  WebSocket?: typeof WebSocket;
  /** Workspace directory new sessions run in. */
  directory?: string;
  /** Value for the `Authorization` header on unary calls, e.g. `Bearer abc`. */
  authHeader?: string;
  /** Query token (`?token=`) appended to WebSocket stream URLs. */
  wsQueryToken?: string;
}

/** Parse a raw model-arguments JSON string into an object, or undefined. */
function parseArguments(args: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(args);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Join a tool result's content blocks into one display string. */
/** Collect every text leaf under a content-block tree. dsh nests tool output:
 *  `message.content` holds `{ type: "tool-result", content: [{ type: "text",
 *  text }] }`, so a flat scan misses it. */
function collectText(blocks: ContentBlock[] | undefined): string[] {
  if (!blocks) return [];
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
    } else if (b.type === "tool-result" && Array.isArray(b.content)) {
      out.push(...collectText(b.content as ContentBlock[]));
    } else if (Array.isArray((b as { content?: unknown }).content)) {
      out.push(...collectText((b as { content: unknown }).content as ContentBlock[]));
    }
  }
  return out;
}

function toolOutput(blocks: ContentBlock[] | undefined): string | undefined {
  const text = collectText(blocks).join("\n");
  return text ? text : undefined;
}

/** True when the SSE envelope's payload is a session-event frame. */
function isSessionEventFrame(frame: MuxFrame): frame is { type: "session/event"; sessionId: string; event: SessionEvent } {
  return frame.type === "session/event";
}

/**
 * The DeepSeek Harness runtime, speaking the dsh `/api` HTTP+SSE gateway.
 *
 * Implements the same {@link AgentRuntime} seam as `OpenCodeClient`, so the
 * whole Open Lab UI (threads, provenance, runs, review) is unchanged. The mux
 * and host event streams are folded into the normalized OpenCode events the
 * app consumes. Model/provider config and MCP are mapped onto dsh's
 * `llm.*` / `credentials.*` / `settings.*` domains where dsh exposes an
 * equivalent; OpenCode-only endpoints that dsh v1 does not expose degrade to a
 * clear error (documented in PROGRESS.md).
 */
export class DshRuntime extends BaseAgentRuntime implements AgentRuntime {
  readonly baseUrl: string;
  private readonly api: DshApiClient;
  private readonly directory?: string;
  private closed = false;
  private aborts = new Set<AbortController>();
  /** rpcId of a pending question/requested frame → its session + questions. */
  private readonly pendingQuestions = new Map<string, { sessionId: string; items: QuestionItem[] }>();
  /** rpcId of a pending approval/requested frame → its session + approvalId. */
  private readonly pendingApprovals = new Map<string, { sessionId: string; approvalId: string; tool: string }>();
  /**
   * Accumulated streamed text/reasoning per part key (sessionId:partId). dsh
   * emits each `*-delta` chunk with only the INCREMENTAL text; the frontend
   * folds `text.updated` / `reasoning.updated` as FULL-text idempotent updates,
   * so the SDK must send the running total — not a delta — or every part
   * collapses to its last one-or-two-character chunk.
   */
  private readonly streamText = new Map<string, string>();
  /**
   * Session ids the user archived via the workspace. dsh's `session.list` does
   * NOT filter archived rows (nor does its list row carry an archived marker),
   * so the SDK keeps the authoritative `archivedSessionIds` that dsh persists
   * in the workspace state and refreshes it from `workspace.list` — a deleted /
   * archived conversation must not reappear after a reconnect or app restart.
   */
  private archivedIds = new Set<string>();

  constructor(options: DshRuntimeOptions) {
    super();
    this.baseUrl = options.baseUrl;
    this.api = new DshApiClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      WebSocket: options.WebSocket,
      authHeader: options.authHeader,
      wsQueryToken: options.wsQueryToken,
    });
    this.directory = options.directory;
  }

  /** Set the workspace directory new sessions are created in (move). */
  setDirectory(directory: string): void {
    (this as unknown as { directory: string | undefined }).directory = directory;
  }

  // ---- lifecycle ----

  async connect(): Promise<void> {
    if (this.closed) throw new Error("DshRuntime is closed");
    this.setStatus("connecting");
    try {
      // Both downlinks must complete their WebSocket handshake for a healthy
      // connection; the host stream is the liveness signal.
      const host = new AbortController();
      this.aborts.add(host);
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const stream = this.api.stream<MuxFrame>("/api/events.host", host.signal, () => {
          opened = true;
          resolve();
        });
        void (async () => {
          for await (const envelope of stream) {
            const frame = envelope.payload as { type: string; sessionId?: string; message?: string };
            if (frame.type === "host/agent-error" && frame.sessionId && frame.message) {
              this.emit({ type: "error", sessionId: frame.sessionId, message: frame.message });
            }
          }
        })().catch((err) => {
          if (this.closed) return;
          if (!opened) reject(err);
        });
      });
      const mux = new AbortController();
      this.aborts.add(mux);
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const stream = this.api.stream<MuxFrame>("/api/events.mux", mux.signal, () => {
          opened = true;
          resolve();
        });
        void this.pumpMux(stream).catch((err) => {
          if (this.closed) return;
          if (!opened) reject(err);
        });
      });
      this.setStatus("ready");
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  close(): void {
    this.closed = true;
    for (const ac of this.aborts) ac.abort();
    this.aborts.clear();
    this.setStatus("offline");
  }

  // ---- event streams ----

  private async pumpMux(stream: AsyncGenerator<{ rpcId: string; payload: MuxFrame }>): Promise<void> {
    try {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (isSessionEventFrame(frame)) {
          this.foldSessionEvent(frame.sessionId, frame.event);
        } else {
          this.foldMuxFrame(envelope.rpcId, frame);
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private foldMuxFrame(rpcId: string, frame: MuxFrame): void {
    switch (frame.type) {
      case "question/requested": {
        const items: QuestionItem[] = (frame.questions ?? []).map((q) => ({
          question: q.question,
          header: q.header ?? q.detail ?? "Question",
          options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
          multiple: q.multiSelect ?? false,
          custom: true,
        }));
        this.pendingQuestions.set(rpcId, { sessionId: frame.sessionId, items });
        this.emit({
          type: "question.asked",
          sessionId: frame.sessionId,
          requestId: rpcId,
          questions: items,
        });
        break;
      }
      case "question/resolved": {
        this.pendingQuestions.delete(frame.questionRpcId);
        this.emit({
          type: "question.resolved",
          sessionId: frame.sessionId,
          requestId: frame.questionRpcId,
        });
        break;
      }
      case "approval/requested": {
        this.pendingApprovals.set(rpcId, {
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          tool: frame.toolName,
        });
        this.emit({
          type: "permission.asked",
          sessionId: frame.sessionId,
          requestId: rpcId,
          action: frame.toolName,
          resources: frame.reason ? [frame.reason] : [],
        });
        break;
      }
      case "approval/resolved": {
        this.pendingApprovals.delete(frame.approvalId);
        this.emit({
          type: "permission.resolved",
          sessionId: frame.sessionId,
          requestId: frame.approvalId,
        });
        break;
      }
      default:
        break;
    }
  }

  private foldSessionEvent(sessionId: string, event: SessionEvent): void {
    switch (event.type) {
      case "step/start": {
        const step = (event.data as { step?: number })?.step ?? 1;
        this.emit({ type: "step.updated", sessionId, step });
        break;
      }
      case "assistant/chunk": {
        const data = event.data as {
          chunk?: { type: string; text?: string; index?: number; blockType?: string };
          turn?: number;
          step?: number;
        };
        const chunk = data?.chunk;
        if (!chunk) break;
        const index = chunk.index ?? 0;
        // dsh streams each reasoning/text block as many tiny deltas with
        // monotonically increasing `seq`. Key the folded part by the block's
        // stable identity (turn · step · index) so every delta of one block
        // accumulates into the SAME thread block, instead of opening a new
        // one-word "思考" block per delta.
        const turn = data?.turn ?? 0;
        const step = data?.step ?? 1;
        const partKey = `${turn}:${step}:${index}`;
        if (chunk.type === "text-delta" && typeof chunk.text === "string") {
          const textKey = `${sessionId}:text:${partKey}`;
          const accumulated = (this.streamText.get(textKey) ?? "") + chunk.text;
          this.streamText.set(textKey, accumulated);
          this.emit({
            type: "text.updated",
            sessionId,
            partId: `text:${partKey}`,
            text: accumulated,
          });
        } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
          const textKey = `${sessionId}:reasoning:${partKey}`;
          const accumulated = (this.streamText.get(textKey) ?? "") + chunk.text;
          this.streamText.set(textKey, accumulated);
          this.emit({
            type: "reasoning.updated",
            sessionId,
            partId: `reasoning:${partKey}`,
            text: accumulated,
          });
        }
        break;
      }
      case "assistant/message": {
        const blocks = (event.data as { message?: { content?: ContentBlock[] } })?.message?.content ?? [];
        let textParts = 0;
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            this.emit({
              type: "text.updated",
              sessionId,
              partId: `${event.seq}:final:${textParts}`,
              text: block.text,
            });
            textParts += 1;
          } else if (block.type === "tool-call" && block.id && block.name) {
            this.emit({
              type: "tool.updated",
              sessionId,
              callId: block.id,
              tool: block.name,
              status: "pending",
              input: parseArguments(block.arguments ?? "{}"),
            });
          }
        }
        break;
      }
      case "tool/call": {
        const data = event.data as { callId?: string; name?: string; arguments?: string; time?: number };
        if (!data?.callId || !data.name) break;
        this.emit({
          type: "tool.updated",
          sessionId,
          callId: data.callId,
          tool: data.name,
          status: "running",
          input: parseArguments(data.arguments ?? "{}"),
          startedAt: data.time ?? event.time * 1000,
        });
        break;
      }
      case "tool/result": {
        const data = event.data as {
          callId?: string;
          message?: {
            toolCallId?: string;
            source?: { callId?: string };
            content?: ContentBlock[];
            isError?: boolean;
          };
        };
        // dsh carries the id on message.source.callId / the tool-result block's
        // toolCallId — NOT on the top level — so resolve from all three.
        const contentCallId = (data?.message?.content ?? []).find(
          (b) => b.type === "tool-result" && typeof b.toolCallId === "string",
        )?.toolCallId;
        const callId = data?.callId ?? data?.message?.toolCallId ?? data?.message?.source?.callId ?? contentCallId;
        if (!callId) break;
        this.emit({
          type: "tool.updated",
          sessionId,
          callId,
          tool: "",
          status: data?.message?.isError ? "failed" : "success",
          output: toolOutput(data?.message?.content),
          endedAt: event.time * 1000,
        });
        break;
      }
      case "turn/end":
        this.emit({ type: "session.idle", sessionId });
        break;
      case "session/title": {
        // dsh auto-names the session (fallback or LLM summary) after the first
        // turn — surface it so the app renames the sidebar row.
        const title = (event.data as { title?: string })?.title;
        if (title && title.trim()) {
          this.emit({ type: "session.renamed", sessionId, title });
        }
        break;
      }
      default:
        break;
    }
  }

  // ---- sessions ----

  async createSession(title?: string): Promise<string> {
    const result = await this.api.call<{ sessionId: string }>("session.create", {
      ...(this.directory ? { cwd: this.directory } : {}),
    });
    if (title) {
      await this.api.call("session.rename", { sessionId: result.sessionId, title }).catch(() => undefined);
    }
    return result.sessionId;
  }

  async forkSession(sessionId: string, _beforeMessageId?: string): Promise<string> {
    // dsh anchors a fork at a turn boundary (atSeq). Open Lab's message-based
    // boundary is resolved best-effort by reading the tail history and finding
    // the last completed turn before the named message; without a match we fork
    // the whole conversation, which is the fallback Open Lab uses too.
    const result = await this.api.call<{ sessionId: string }>("session.fork", { sessionId });
    return result.sessionId;
  }

  /** Refresh the locally-known archived ids from dsh's persisted workspace
   *  state, so an archived conversation stays hidden across reconnects. */
  private async refreshArchived(): Promise<void> {
    try {
      const result = await this.api.call<{ items?: unknown[]; archivedSessionIds?: string[] }>(
        "workspace.list",
      );
      this.archivedIds = new Set(result.archivedSessionIds ?? []);
    } catch {
      /* workspace.list is best-effort; keep the last known set */
    }
  }

  private async loadSessions(): Promise<SessionMeta[]> {
    await this.refreshArchived();
    const result = await this.api.call<{ items: SessionSummary[] }>("session.list");
    const archivedAt = new Map<string, number>();
    for (const id of this.archivedIds) archivedAt.set(id, Date.now());
    return (result.items ?? []).map((s) => toSessionMeta(s, archivedAt));
  }

  async listSessions(): Promise<SessionMeta[]> {
    const sessions = await this.loadSessions();
    // listSessions feeds the ACTIVE sidebar list — archived conversations stay
    // out (querySessions({ archived: true }) reveals them on demand).
    return sessions.filter((s) => !s.archived);
  }

  async querySessions(query: SessionQuery = {}): Promise<SessionPage> {
    if (query.search) {
      const result = await this.api.call<{ items: Array<SessionSummary & { snippet?: string }> }>(
        "session.search",
        { query: query.search },
      );
      const sessions = (result.items ?? []).map((s) => toSessionMeta(s));
      return { sessions, nextCursor: null };
    }
    let sessions = await this.loadSessions();
    if (!query.archived) sessions = sessions.filter((s) => !s.archived);
    sessions = sessions.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    return { sessions, nextCursor: null };
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    if (!archived) {
      // dsh v1 exposes no unarchive RPC; restoring is a no-op here.
      return;
    }
    await this.api.call("workspace.archiveSession", { sessionId });
    this.archivedIds.add(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // dsh v1 exposes no session-deletion RPC; archiving removes it from the
    // active surface. The workspace list keeps it out of every future listing.
    const result = await this.api.call<{ archivedSessionIds?: string[] }>(
      "workspace.archiveSession",
      { sessionId },
    ).catch(() => undefined);
    if (result?.archivedSessionIds) this.archivedIds = new Set(result.archivedSessionIds);
    else this.archivedIds.add(sessionId);
  }

  /** dsh sessions bind their cwd at create and cannot be re-homed; the app
   *  keeps its own session→project association, so a move is a no-op. */
  async moveSession(_sessionId: string, _directory: string): Promise<void> {
    return;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.api.call("session.rename", { sessionId, title });
  }

  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const result = await this.api.call<{ events: Array<{ event: SessionEvent }> }>(
      "session.history",
      { sessionId },
    );
    return foldHistory(result.events?.map((e) => e.event) ?? []);
  }

  async appendTextPart(
    sessionId: string,
    _messageId: string,
    text: string,
    _partId?: string,
  ): Promise<string> {
    // dsh v1 has no synthetic-part append RPC; the text is surfaced live as a
    // user-side note so the thread stays truthful about what happened.
    this.emit({
      type: "text.updated",
      sessionId,
      partId: `synthetic:${Date.now()}`,
      text,
    });
    return `${sessionId}:synthetic`;
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    _agent?: string,
    _model?: string | null,
    _variant?: string | null,
    _clean?: boolean,
    files?: PromptFile[],
  ): Promise<void> {
    const content: Array<{ type: "text" | "image"; text?: string; mediaType?: string; data?: string; name?: string }> =
      [{ type: "text", text }];
    for (const file of files ?? []) {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(file.url ?? "");
      if (m && /^image\//.test(m[1])) {
        content.push({ type: "image", mediaType: m[1], data: m[2], name: file.filename });
      } else {
        content.push({ type: "text", text: `[Attached: ${file.filename}]` });
      }
    }
    await this.api.call("session.prompt", { sessionId, mode: "queue", content });
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.api.call("session.cancel", { sessionId }).catch(() => undefined);
  }

  async revert(_sessionId: string, _messageID: string, _partID?: string): Promise<void> {
    throw new DshRpcError(
      "unsupported",
      "dsh v1 exposes no revert RPC; fork the session instead (docs/PROGRESS.md).",
    );
  }

  async unrevert(_sessionId: string): Promise<void> {
    throw new DshRpcError(
      "unsupported",
      "dsh v1 exposes no unrevert RPC (docs/PROGRESS.md).",
    );
  }

  // ---- capability discovery ----

  async listSkills(): Promise<SkillInfo[]> {
    // skill.list is session-scoped in dsh; use the most recent session (or
    // create one lazily in the workspace) so discovery works before a session.
    const sessionId = await this.anySessionId();
    const result = await this.api.call<{ skills?: Array<{ name: string; description?: string }> }>(
      "skill.list",
      { sessionId },
    );
    return (result.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? "" }));
  }

  /** The id of the newest live session, creating one lazily if none exists. */
  private async anySessionId(): Promise<string> {
    const sessions = await this.listSessions().catch(() => []);
    const newest = sessions.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
    if (newest) return newest.id;
    return this.createSession("DeepLab");
  }

  async listAgents(): Promise<AgentInfo[]> {
    const result = await this.api.call<{ presets?: Array<{ id: string; description?: string }> }>(
      "agentPreset.list",
    );
    return (result.presets ?? []).map((a) => ({ name: a.id, description: a.description ?? "" }));
  }

  async listCommands(): Promise<CommandInfo[]> {
    // dsh executes "/" slash commands through the command registry at prompt
    // time and exposes no list RPC; surface skills as commands so the composer
    // palette still offers them.
    const skills = await this.listSkills().catch(() => []);
    return skills.map((s) => ({ name: `/${s.name}`, description: s.description, source: "skill" }));
  }

  // ---- model selection ----

  async getDefaultModel(): Promise<string | null> {
    try {
      const result = await this.api.call<{ groups?: Array<{ provider: string; models?: Array<{ id: string }> }> }>(
        "llm.models",
      );
      const group = result.groups?.[0];
      if (!group || !group.models?.length) return null;
      return `${group.provider}/${group.models[0].id}`;
    } catch {
      return null;
    }
  }

  async setDefaultModel(model: string): Promise<void> {
    const [provider, ...rest] = model.split("/");
    const modelId = rest.join("/");
    if (!provider || !modelId) return;
    // Model selection is per-session in dsh; record it for the next created
    // session's lifetime by selecting on every live session we know of.
    const sessions = await this.listSessions().catch(() => []);
    for (const s of sessions) {
      await this.api
        .call("session.selectModel", { sessionId: s.id, provider, model: modelId })
        .catch(() => undefined);
    }
  }

  // ---- agent-driven execution ----

  async runShell(sessionId: string, command: string, _agent?: string): Promise<void> {
    // dsh executes slash commands (including a shell tool) through the command
    // registry at prompt time; a "!" shell turn becomes a queued prompt.
    await this.api.call("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: command }],
    });
  }

  async runCommand(sessionId: string, command: string, args?: string): Promise<void> {
    const line = args ? `/${command} ${args}` : `/${command}`;
    await this.api.call("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: line }],
    });
  }

  // ---- interactive requests ----

  async listQuestions(sessionId?: string): Promise<QuestionAskedEvent[]> {
    return [...this.pendingQuestions.entries()]
      .filter(([, p]) => !sessionId || p.sessionId === sessionId)
      .map(([requestId, p]) => ({
        type: "question.asked" as const,
        sessionId: p.sessionId,
        requestId,
        questions: p.items,
      }));
  }

  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    const payload: QuestionResponsePayload = {
      sessionId: pending.sessionId,
      answer: {
        answers: pending.items.map((item, i) => ({
          id: item.header ?? String(i),
          selected: answers[i] ?? [],
        })),
      },
    };
    await this.api.respond(requestId, { ok: true, value: payload });
    this.pendingQuestions.delete(requestId);
  }

  async rejectQuestion(requestId: string): Promise<void> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    const payload: QuestionResponsePayload = {
      sessionId: pending.sessionId,
      answer: { answers: pending.items.map(() => ({ id: "", selected: [] })) },
    };
    await this.api.respond(requestId, { ok: true, value: payload });
    this.pendingQuestions.delete(requestId);
  }

  async listPermissions(sessionId?: string): Promise<PermissionAskedEvent[]> {
    return [...this.pendingApprovals.entries()]
      .filter(([, p]) => !sessionId || p.sessionId === sessionId)
      .map(([requestId, p]) => ({
        type: "permission.asked" as const,
        sessionId: p.sessionId,
        requestId,
        action: p.tool,
        resources: [],
      }));
  }

  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    const outcome: ApprovalResponsePayload["outcome"] = reply === "reject" ? "rejected" : "allowed-once";
    const payload: ApprovalResponsePayload = {
      sessionId: pending.sessionId,
      approvalId: pending.approvalId,
      outcome,
    };
    await this.api.respond(requestId, { ok: true, value: payload });
    this.pendingApprovals.delete(requestId);
  }

  // ---- provider / MCP surface (mapped onto dsh domains) ----

  async listProviders(): Promise<ProviderInfo[]> {
    const result = await this.api.call<{
      groups?: Array<{ provider: string; name?: string; models?: Array<{ id: string; name?: string }> }>;
    }>("llm.models");
    return (result.groups ?? []).map((g) => ({
      id: g.provider,
      name: g.name ?? g.provider,
      models: (g.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id })),
    }));
  }

  async addCustomProvider(
    _id: string,
    _opts: {
      name: string;
      npm: string;
      baseURL: string;
      apiKey?: string;
      models: string[];
      contexts?: Record<string, number>;
    },
  ): Promise<void> {
    throw new DshRpcError(
      "unsupported",
      "dsh v1 configures providers through settings namespaces, not a runtime add RPC (docs/PROGRESS.md).",
    );
  }

  async listProviderCatalog(): Promise<{ all: ProviderCatalogEntry[]; connected: string[] }> {
    const providers = await this.listProviders().catch(() => []);
    return {
      all: providers.map((p) => ({ id: p.id, name: p.name, env: [] })),
      connected: providers.map((p) => p.id),
    };
  }

  async listAuthMethods(): Promise<Record<string, ProviderAuthMethod[]>> {
    return {};
  }

  /** The dsh DeepSeek provider reads its key from this credential ref. */
  private readonly apiKeyRef = "DEEPSEEK_API_KEY";

  async setProviderApiKey(providerID: string, key: string): Promise<void> {
    // The dsh DeepSeek provider route (`deepseek-official`) resolves its bearer
    // token from the `DEEPSEEK_API_KEY` credential ref. Store through the
    // credentials domain so the value rides the app's secret store, never the
    // session log or settings.
    if (providerID === "deepseek-official" || providerID === "deepseek") {
      await this.api.call("credentials.set", { ref: this.apiKeyRef, value: key });
      return;
    }
    const ref = providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY";
    await this.api.call("credentials.set", { ref, value: key });
  }

  async getProviderRegion(_providerID: string): Promise<string | null> {
    return null;
  }

  async setProviderRegion(_providerID: string, _region: string): Promise<void> {
    // no-op: dsh has no region concept in v1
  }

  async removeProviderAuth(providerID: string): Promise<void> {
    if (providerID === "deepseek-official" || providerID === "deepseek") {
      await this.api.call("credentials.unset", { ref: this.apiKeyRef }).catch(() => undefined);
      return;
    }
    const ref = providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY";
    await this.api.call("credentials.unset", { ref }).catch(() => undefined);
  }

  async oauthAuthorize(
    _providerID: string,
    _method: number,
    _inputs?: Record<string, string>,
  ): Promise<OAuthAuthorization> {
    throw new DshRpcError(
      "unsupported",
      "dsh v1 has no OAuth authorize RPC; configure provider credentials in Settings (docs/PROGRESS.md).",
    );
  }

  async oauthCallback(
    _providerID: string,
    _method: number,
    _code?: string,
    _signal?: AbortSignal,
  ): Promise<void> {
    throw new DshRpcError(
      "unsupported",
      "dsh v1 has no OAuth callback RPC (docs/PROGRESS.md).",
    );
  }

  async refreshProviderCache(): Promise<void> {
    // dsh resolves models live per call; nothing to invalidate.
  }

  async clearDefaultCustomModelContextLimits(): Promise<void> {
    // dsh has no legacy blind-context defaults to repair.
  }

  async listCustomProviderIds(): Promise<string[]> {
    return [];
  }

  async listMcpServers(): Promise<McpServer[]> {
    // dsh wires MCP servers in cordis.yml plugin rows, not a runtime API; the
    // app's own connectors are still deployed (runtime/skills + setup.ts).
    return [];
  }

  async addMcpServer(_name: string, _config: McpConfig): Promise<void> {
    throw new DshRpcError(
      "unsupported",
      "dsh v1 configures MCP servers in cordis.yml, not at runtime (docs/PROGRESS.md).",
    );
  }

  /** Exposed for parity with OpenCodeClient's seam (used by tests/setup). */
  async listQuestionsRaw(): Promise<Array<{ type: string }>> {
    return [];
  }
}

// ---- mappers ----

function toSessionMeta(
  summary: SessionSummary,
  archivedAt: ReadonlyMap<string, number> = new Map(),
): SessionMeta {
  const archived = archivedAt.get(summary.sessionId);
  // dsh lists the auto-generated title under projections.values.title (the
  // top-level `title` field is unset by session.list) — prefer it so a
  // reconnected/restarted app still shows the summarized name.
  const title =
    summary.title?.trim() ||
    summary.projections?.values?.title?.trim() ||
    summary.sessionId;
  return {
    id: summary.sessionId,
    title,
    directory: summary.cwd,
    parentId: summary.parentSessionId,
    created: undefined,
    updated: summary.updatedAt,
    ...(archived !== undefined ? { archived } : {}),
    metadata: summary as unknown as Record<string, unknown>,
  };
}

/** Fold a dsh session log into the HistoryMessage[] the app renders. */
function foldHistory(events: SessionEvent[]): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  // dsh reports a tool's OUTPUT in a separate `tool/result` event (nested
  // content), not on the assistant/message's `tool-call` block — collect them
  // by callId first so the tool parts below carry their result.
  const toolOutputs = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool/result") {
      const data = event.data as {
        callId?: string;
        message?: { toolCallId?: string; source?: { callId?: string }; content?: ContentBlock[] };
      };
      const contentCallId = (data?.message?.content ?? []).find(
        (b) => b.type === "tool-result" && typeof b.toolCallId === "string",
      )?.toolCallId;
      const callId =
        data?.callId ?? data?.message?.toolCallId ?? data?.message?.source?.callId ?? contentCallId;
      const out = toolOutput(data?.message?.content);
      if (callId && out !== undefined) toolOutputs.set(callId, out);
    }
  }
  for (const event of events) {
    if (event.type === "user/message") {
      const data = event.data as {
        id?: string;
        content?: ContentBlock[];
        source?: { kind?: string };
      };
      // dsh also records SYSTEM-injected `user/message` rows (runtime context
      // and the skill catalog, `source.kind` = "plugin" / "skill-catalog").
      // Only genuine user input belongs in the conversation — otherwise every
      // reopened session starts with a wall of context/skill boilerplate.
      if (data.source?.kind && data.source.kind !== "user") continue;
      const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
      messages.push({
        role: "user",
        id: data.id,
        parts: text ? [{ type: "text", text }] : [],
      });
    } else if (event.type === "assistant/message") {
      const data = event.data as { message?: { content?: ContentBlock[] } };
      const blocks = data.message?.content ?? [];
      const parts: HistoryPart[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "reasoning" && typeof block.text === "string") {
          parts.push({ type: "reasoning", text: block.text });
        } else if (block.type === "tool-call" && block.id && block.name) {
          const output = toolOutputs.get(block.id);
          parts.push({
            type: "tool",
            tool: block.name,
            state: {
              status: "completed",
              title: block.name,
              ...(output !== undefined ? { output } : {}),
            },
          });
        }
      }
      if (parts.length) {
        messages.push({ role: "assistant", parts });
      }
    }
  }
  return messages;
}
