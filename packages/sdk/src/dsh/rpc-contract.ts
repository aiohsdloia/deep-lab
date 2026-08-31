import type { SessionEvent, SessionSummary } from "./types";

/**
 * DeepLab's checked-in view of the dsh HTTP RPC contract.
 *
 * Keep this deliberately narrower than upstream's complete RpcMethodMap: every
 * method here is exercised by DeepLab, and contract tests pin the payloads most
 * likely to break while dsh is in developer preview.
 */
export interface DshRpcContract {
  "session.list": Rpc<{ cursor?: string }, { items: SessionSummary[] }>;
  "session.search": Rpc<
    { query: string },
    { items: Array<SessionSummary & { snippet: string }>; hasMore: boolean }
  >;
  "session.create": Rpc<
    { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string },
    { sessionId: string; agentPreset?: string }
  >;
  "session.history": Rpc<
    { sessionId: string; beforeSeq?: number; maxMessages?: number },
    {
      events: Array<{ event: SessionEvent; view?: unknown }>;
      hasMore: boolean;
      projections?: SessionProjections;
    }
  >;
  "session.models": Rpc<{ sessionId: string }, SessionModelsValue>;
  "session.selectModel": Rpc<
    { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    { selected: ModelSelection }
  >;
  "session.rename": Rpc<{ sessionId: string; title: string }, { title: string; seq: number }>;
  "session.fork": Rpc<{ sessionId: string; atSeq?: number }, { sessionId: string }>;
  "session.prompt": Rpc<
    {
      sessionId: string;
      mode: "queue" | "steer";
      content: PromptContentPart[];
      clientTimeZone?: string;
    },
    { accepted: true; command?: { kind: "success"; text?: string } }
  >;
  "session.cancel": Rpc<{ sessionId: string }, { accepted: true }>;
  "workspace.list": Rpc<{}, { items: unknown[]; archivedSessionIds: string[] }>;
  "workspace.archiveSession": Rpc<{ sessionId: string }, { archivedSessionIds: string[] }>;
  "skill.list": Rpc<
    { sessionId: string },
    { skills: Array<{ name: string; description: string; whenToUse?: string; modelInvocable: boolean }> }
  >;
  "agentPreset.list": Rpc<
    {},
    {
      presets: Array<{
        id: string;
        trust: "system" | "user";
        isDefault: boolean;
        name?: string;
        description?: string;
        broken?: string;
      }>;
      authorable: boolean;
      hasDocument: boolean;
    }
  >;
  "goal.create": Rpc<
    { sessionId: string; objective: string; maxGoalRounds?: number },
    { ref: GoalRef }
  >;
  "goal.edit": Rpc<
    { sessionId: string; ref: GoalRef; objective?: string; maxGoalRounds?: number },
    { ref: GoalRef }
  >;
  "goal.pause": Rpc<{ sessionId: string; ref: GoalRef }, { ref: GoalRef }>;
  "goal.resume": Rpc<{ sessionId: string; ref: GoalRef }, { ref: GoalRef }>;
  "goal.complete": Rpc<{ sessionId: string; ref: GoalRef }, { ref: GoalRef }>;
  "goal.clear": Rpc<{ sessionId: string; ref: GoalRef }, { cleared: true }>;
  "settings.describe": Rpc<{}, SettingsDescribeValue>;
  "settings.update": Rpc<
    { ns: string; patch: Record<string, unknown>; expectedRevision?: number },
    SettingsNamespaceView
  >;
  "settings.mutate": Rpc<
    {
      ns: string;
      ops: Array<
        | { op: "set"; path: string[]; value: unknown }
        | { op: "unset"; path: string[] }
      >;
      expectedRevision?: number;
    },
    SettingsNamespaceView
  >;
  "credentials.set": Rpc<{ ref: string; value: string }, {}>;
  "credentials.unset": Rpc<{ ref: string }, {}>;
  "llm.providers": Rpc<{}, { providers: ConfigurableProvider[] }>;
  "llm.models": Rpc<{}, ModelCatalogValue>;
  "llm.discoverModels": Rpc<
    { settingsNs: string; provider?: string; baseURL?: string; api?: string; apiKey?: string },
    { models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }> }
  >;
}

interface Rpc<P, V> {
  payload: P;
  value: V;
}

export type DshRpcMethod = keyof DshRpcContract;
export type DshRpcPayload<K extends DshRpcMethod> = DshRpcContract[K]["payload"];
export type DshRpcValue<K extends DshRpcMethod> = DshRpcContract[K]["value"];

export interface DshRpcCaller {
  call<K extends DshRpcMethod>(
    method: K,
    payload: DshRpcPayload<K>,
    signal?: AbortSignal,
  ): Promise<DshRpcValue<K>>;
}

export interface GoalRef {
  id: string;
  revision: number;
}

export interface GoalSnapshot extends GoalRef {
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason?: { code: string; message: string };
  maxGoalRounds: number;
}

export interface GoalProjection {
  goal: GoalSnapshot;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionProjections {
  asOfSeq: number;
  values: Record<string, unknown>;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>;
    defaultEffort?: string;
  };
}

export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}

export interface ModelCatalogValue {
  groups: ModelProviderGroup[];
  failures: Array<{ id: string; name: string; message: string }>;
}

export interface SessionModelsValue extends ModelCatalogValue {
  current: ModelSelection;
  routable: boolean;
}

export interface ConfigurableProvider {
  provider: string;
  displayName: string;
  settingsNs: string;
  settingsPath: string[];
  active: boolean;
  declared?: boolean;
}

export interface SettingsNamespaceView {
  ns: string;
  schema: unknown;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets: Array<{ path: string[]; set: boolean }>;
  revision: number;
}

export interface SettingsDescribeValue {
  writable: boolean;
  hasDocument: boolean;
  namespaces: SettingsNamespaceView[];
}

export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string };
