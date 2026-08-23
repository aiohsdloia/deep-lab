import type { DshRpcCaller } from "./rpc-contract";

/** dsh-owned settings and write-only credential operations. */
export class DshSettingsAdapter {
  constructor(private readonly api: DshRpcCaller) {}

  async setPermissionPreset(preset: "unlimited" | "restricted"): Promise<void> {
    await this.api.call("settings.update", {
      ns: "permission",
      patch: {
        defaultPreset: preset === "unlimited" ? "danger-full-access" : "workspace-write",
      },
    });
  }

  async setProviderApiKey(providerId: string, key: string): Promise<void> {
    await this.api.call("credentials.set", { ref: credentialRef(providerId), value: key });
  }

  async removeProviderAuth(providerId: string): Promise<void> {
    await this.api.call("credentials.unset", { ref: credentialRef(providerId) });
  }
}

export function credentialRef(providerId: string): string {
  if (providerId === "deepseek-official" || providerId === "deepseek") {
    return "DEEPSEEK_API_KEY";
  }
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
