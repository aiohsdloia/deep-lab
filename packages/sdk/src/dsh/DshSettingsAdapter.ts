import type { PermissionPreset } from "../types";
import type { ConfigurableProvider, DshRpcCaller } from "./rpc-contract";

const PI_AI_SETTINGS_NS = "llm-pi-ai";
const OPENAI_COMPATIBLE_API = "openai-completions";

export interface CustomProviderOptions {
  name: string;
  baseURL: string;
  apiKey?: string;
  models: string[];
  contexts?: Record<string, number>;
}

export interface ProviderModelCandidate {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** dsh-owned settings and write-only credential operations. */
export class DshSettingsAdapter {
  constructor(private readonly api: DshRpcCaller) {}

  async getDefaultPermissionPreset(): Promise<PermissionPreset | null> {
    const result = await this.api.call("settings.describe", {});
    const permission = result.namespaces.find((namespace) => namespace.ns === "permission");
    const value = permission?.value;
    if (!value || typeof value !== "object") return null;
    const preset = (value as { defaultPreset?: unknown }).defaultPreset;
    return preset === "workspace-write" || preset === "danger-full-access" ? preset : null;
  }

  async setDefaultPermissionPreset(preset: PermissionPreset): Promise<void> {
    await this.api.call("settings.update", {
      ns: "permission",
      patch: { defaultPreset: preset },
    });
  }

  async setProviderApiKey(providerId: string, key: string): Promise<void> {
    await this.setCredential(credentialRef(providerId), key);
  }

  async removeProviderAuth(providerId: string): Promise<void> {
    await this.removeCredential(credentialRef(providerId));
  }

  async listConfigurableProviders(): Promise<ConfigurableProvider[]> {
    return (await this.api.call("llm.providers", {})).providers;
  }

  async discoverProviderModels(input: {
    provider: string;
    baseURL: string;
    apiKey?: string;
  }): Promise<ProviderModelCandidate[]> {
    const result = await this.api.call("llm.discoverModels", {
      settingsNs: PI_AI_SETTINGS_NS,
      provider: input.provider,
      baseURL: input.baseURL,
      api: OPENAI_COMPATIBLE_API,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    });
    return result.models;
  }

  async upsertCustomProvider(id: string, options: CustomProviderOptions): Promise<void> {
    const ref = credentialRef(id);
    const models = options.models.map((model) => ({
      id: model,
      name: model,
      ...(options.contexts?.[model] ? { contextWindow: options.contexts[model] } : {}),
    }));
    await this.api.call("settings.mutate", {
      ns: PI_AI_SETTINGS_NS,
      ops: [
        {
          op: "set",
          path: ["providers", id],
          value: {
            displayName: options.name,
            apiKeyEnv: ref,
            api: OPENAI_COMPATIBLE_API,
            baseURL: options.baseURL,
            models,
          },
        },
      ],
    });
    // pi-ai requires a credential value even for a keyless OpenAI-compatible
    // endpoint. Local servers ignore this harmless placeholder bearer token.
    await this.setCredential(ref, options.apiKey?.trim() || "deeplab-local");
  }

  async removeCustomProvider(id: string): Promise<void> {
    await this.api.call("settings.mutate", {
      ns: PI_AI_SETTINGS_NS,
      ops: [{ op: "unset", path: ["providers", id] }],
    });
    await this.removeCredential(credentialRef(id)).catch(() => undefined);
  }

  async setCredential(ref: string, value: string): Promise<void> {
    await this.api.call("credentials.set", { ref, value });
  }

  async removeCredential(ref: string): Promise<void> {
    await this.api.call("credentials.unset", { ref });
  }
}

export function credentialRef(providerId: string): string {
  if (providerId === "deepseek-official" || providerId === "deepseek") {
    return "DEEPSEEK_API_KEY";
  }
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
