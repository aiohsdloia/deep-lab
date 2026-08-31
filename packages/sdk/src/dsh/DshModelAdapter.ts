import type { ProviderInfo } from "../types";
import type { DshRpcCaller } from "./rpc-contract";

/** dsh-native model catalog and default-selection semantics. */
export class DshModelAdapter {
  constructor(
    private readonly api: DshRpcCaller,
    private readonly anySessionId: () => Promise<string>,
  ) {}

  async listProviders(): Promise<ProviderInfo[]> {
    const result = await this.api.call("llm.models", {});
    return result.groups.map((group) => ({
      id: group.id,
      name: group.name,
      models: group.models.map((model) => ({ id: model.id, name: model.name })),
    }));
  }

  async getDefaultModel(): Promise<string | null> {
    try {
      const sessionId = await this.anySessionId();
      const result = await this.api.call("session.models", { sessionId });
      return `${result.current.provider}/${result.current.model}`;
    } catch {
      return null;
    }
  }

  async setDefaultModel(modelKey: string): Promise<void> {
    const sessionId = await this.anySessionId();
    await this.selectForSession(sessionId, modelKey);
  }

  /** Apply the UI's per-session choice before the next dsh turn. */
  async selectForSession(
    sessionId: string,
    modelKey: string,
    reasoningEffort?: string | null,
  ): Promise<void> {
    const [provider, ...modelParts] = modelKey.split("/");
    const model = modelParts.join("/");
    if (!provider || !model) throw new Error(`invalid model key: ${modelKey}`);

    await this.api.call("session.selectModel", {
      sessionId,
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }
}
