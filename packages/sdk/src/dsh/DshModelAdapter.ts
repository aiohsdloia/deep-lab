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
    const [provider, ...modelParts] = modelKey.split("/");
    const model = modelParts.join("/");
    if (!provider || !model) throw new Error(`invalid model key: ${modelKey}`);

    // dsh persists every successful session selection as the default for new
    // sessions. One selected session is sufficient and avoids rewriting the
    // durable model choice of unrelated existing conversations.
    const sessionId = await this.anySessionId();
    await this.api.call("session.selectModel", { sessionId, provider, model });
  }
}
