import type { PermissionPreset } from "../types";
import type { DshRpcCaller } from "./rpc-contract";

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
