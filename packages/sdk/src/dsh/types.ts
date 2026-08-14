// Wire shapes for the dsh /api HTTP+SSE gateway (DeepSeek Harness client
// protocol). Only the subset DeepLab consumes is declared; see
// packages/host/apiproxy in deepseek-harness for the authoritative contract.

// ---- Four-quadrant RPC envelopes ----

export interface ClientRequest<P = unknown> {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: P;
}

export interface ServerResponse<V = unknown> {
  type: "server-response";
  rpcId: string;
  result: RpcResult<V>;
}

export interface ServerRequest<P = unknown> {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: P;
}

export interface ClientResponse {
  type: "client-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export type RpcResult<V> =
  | { ok: true; value: V }
  | { ok: false; error: RpcError };

export interface RpcError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

// ---- Session domain ----

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  title?: string;
  /** Projected per-session facts; the auto-generated title lives here. */
  projections?: { values?: { title?: string } };
}

export interface HistoryEntry {
  event: SessionEvent;
  view?: unknown;
}

export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  sourceEventSeqs?: number[];
  surfaceOp?: unknown;
  ignorable?: true;
}

export interface UserMessage {
  id: string;
  role: "user";
  source?: string;
  content: ContentBlock[];
  clientTimeZone?: string;
}

export interface StreamChunk {
  type:
    | "block-start"
    | "text-delta"
    | "reasoning-delta"
    | "tool-call-delta"
    | "block-end"
    | "usage"
    | "finish";
  index?: number;
  blockType?: string;
  text?: string;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  block?: ContentBlock;
  usage?: unknown;
  reason?: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: string;
  content?: ContentBlock[];
  isError?: boolean;
}

export interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  id?: string;
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: ContentBlock[];
  isError?: boolean;
}

// ---- Mux / host stream frames ----

export type MuxFrame =
  | { type: "session/event"; sessionId: string; event: SessionEvent; view?: unknown }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | { type: "approval/requested"; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: "approval/resolved"; sessionId: string; approvalId: string; outcome: string }
  | { type: "question/requested"; sessionId: string; questions: AskUserQuestionItem[] }
  | { type: "question/resolved"; sessionId: string; questionRpcId: string; outcome: string }
  | { type: "session/queue"; sessionId: string; items: unknown[] }
  | { type: "session/jobs"; sessionId: string; jobs: unknown[] }
  | { type: "session/projection"; sessionId: string; key: string; value: unknown; seq: number }
  | { type: "stream/error"; error: RpcError };

export interface AskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { type: string };
}

export type HostFrame =
  | { type: "host/session-added"; sessionId: string }
  | { type: "host/session-removed"; sessionId: string }
  | { type: "host/session-status"; sessionId: string; running: boolean }
  | { type: "host/agent-error"; sessionId: string; message: string }
  | { type: "host/workspace-changed"; items: unknown[] }
  | { type: "host/workspace-removed"; workspaceId: string }
  | { type: "host/archived-sessions-changed"; archivedSessionIds: string[] }
  | { type: "stream/error"; error: RpcError };

// ---- Skills / agent presets / models ----

export interface SkillSummary {
  name: string;
  description: string;
  source?: string;
  enabled?: boolean;
}

export interface AgentPresetSummary {
  name: string;
  description?: string;
}

export interface ModelProviderGroup {
  provider: string;
  name: string;
  models: ModelCatalogModel[];
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  reasoning?: {
    efforts: Array<{ id: string; name: string }>;
    defaultEffort?: string;
  };
}

export interface SessionModels {
  groups: ModelProviderGroup[];
  selected?: { provider: string; model: string; reasoningEffort?: string };
  failures: unknown[];
}

// ---- Answer payloads for /api/respond ----

export interface QuestionResponsePayload {
  sessionId: string;
  answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> };
}

export interface ApprovalResponsePayload {
  sessionId: string;
  approvalId: string;
  outcome: "allowed-once" | "rejected";
}
