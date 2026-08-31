import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, Loader2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { inputCls } from "./inputCls";
import { Section } from "./Section";
import { flattenModelOptions } from "./modelCatalog";
import { loadModelPreferences, recordRecent, saveModelPreferences } from "./modelPreferences";

/** The two DeepSeek models dsh exposes by default. */
const DEEPSEEK_PROVIDER = "deepseek-official";
export const DEEPSEEK_MODELS = [
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", label: "Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", label: "Pro" },
] as const;

/** Key the app stores the DeepSeek API key under (dsh's credential ref). */
export const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

export function providerId(name: string, baseURL = ""): string {
  const fromName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  let stem = fromName;
  if (!stem) {
    try {
      stem = new URL(baseURL).hostname.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
    } catch {
      return "";
    }
  }
  return stem ? `custom-${stem}` : "";
}

/**
 * The primary model surface. The DeepSeek key remains first-class, but the
 * selectable models come from dsh's live catalog so local OpenAI-compatible
 * gateways and future dsh providers are not hidden behind a hardcoded list.
 */
export function ModelSettingsCard() {
  const { t } = useTranslation(["settings", "common"]);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const providers = useRuntimeStore((s) => s.providers);
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customBaseURL, setCustomBaseURL] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customModels, setCustomModels] = useState("");
  const [customContext, setCustomContext] = useState("");
  const [customProviderIds, setCustomProviderIds] = useState<string[]>([]);
  const [customBusy, setCustomBusy] = useState<"discover" | "save" | string | null>(null);

  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  const byProvider = useMemo(
    () =>
      providers.map((provider) => ({
        provider,
        models: options.filter((model) => model.providerID === provider.id),
      })),
    [options, providers],
  );
  const customId = providerId(customName, customBaseURL);
  const customModelIds = customModels
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  useEffect(() => {
    const client = getClient();
    if (!client) return;
    void client.listCustomProviderIds().then(setCustomProviderIds).catch(() => undefined);
  }, [providers]);

  const saveKey = async () => {
    const client = getClient();
    if (!client || !key.trim()) return;
    setSavingKey(true);
    try {
      await client.setProviderApiKey(DEEPSEEK_PROVIDER, key.trim());
      setKey("");
      await useRuntimeStore.getState().loadCatalog();
    } finally {
      setSavingKey(false);
    }
  };

  const selectModel = async (modelKey: string) => {
    if (savingModel) return;
    setSavingModel(modelKey);
    try {
      await useRuntimeStore.getState().setDefaultModel(modelKey);
      saveModelPreferences(recordRecent(loadModelPreferences(), modelKey));
    } finally {
      setSavingModel(null);
    }
  };

  const discoverModels = async () => {
    const client = getClient();
    if (!client || !customId || !customBaseURL.trim()) return;
    setCustomBusy("discover");
    try {
      const discovered = await client.discoverProviderModels({
        provider: customId,
        baseURL: customBaseURL.trim(),
        apiKey: customKey.trim() || undefined,
      });
      if (discovered.length === 0) {
        toast.error(t("providers.noModelsFound"));
        return;
      }
      setCustomModels(discovered.map((model) => model.id).join(", "));
      const contexts = discovered
        .map((model) => model.contextWindow)
        .filter((value): value is number => typeof value === "number");
      if (contexts.length > 0 && contexts.every((value) => value === contexts[0])) {
        setCustomContext(String(contexts[0]));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomBusy(null);
    }
  };

  const saveCustomProvider = async () => {
    const client = getClient();
    if (!client || !customId || !customBaseURL.trim() || customModelIds.length === 0) return;
    setCustomBusy("save");
    try {
      const context = Number(customContext);
      await client.addCustomProvider(customId, {
        name: customName.trim(),
        npm: "",
        baseURL: customBaseURL.trim(),
        apiKey: customKey.trim() || undefined,
        models: customModelIds,
        ...(Number.isFinite(context) && context > 0
          ? { contexts: Object.fromEntries(customModelIds.map((model) => [model, context])) }
          : {}),
      });
      setCustomName("");
      setCustomBaseURL("");
      setCustomKey("");
      setCustomModels("");
      setCustomContext("");
      await useRuntimeStore.getState().loadCatalog();
      setCustomProviderIds(await client.listCustomProviderIds());
      toast.success(t("toast.providerConnected", { providerID: customId }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomBusy(null);
    }
  };

  const removeCustomProvider = async (id: string) => {
    const client = getClient();
    if (!client) return;
    setCustomBusy(id);
    try {
      await client.removeCustomProvider(id);
      await useRuntimeStore.getState().loadCatalog();
      setCustomProviderIds(await client.listCustomProviderIds());
      toast.success(t("toast.providerRemoved", { providerID: id }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCustomBusy(null);
    }
  };

  return (
    <Section title={t("model.title")} hint={t("model.hint")} flush>
      <div className="divide-y divide-faint">
        {/* API key */}
        <div className="px-4 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-text">
            <KeyRound size={13} />
            <span>{t("model.apiKeyLabel")}</span>
          </div>
          <p className="mb-2 text-xs text-muted">{t("model.apiKeyHint")}</p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && key.trim()) void saveKey();
              }}
              placeholder={t("model.apiKeyPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className={inputCls("flex-1 font-mono")}
            />
            <button
              onClick={() => void saveKey()}
              disabled={savingKey || !key.trim()}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1 rounded-input bg-accent px-3 text-[13px] text-white transition-opacity hover:opacity-90 disabled:opacity-50",
              )}
            >
              {savingKey ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
              {t("common:actions.save")}
            </button>
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-text">
            <Server size={13} />
            <span>{t("providers.customEndpoint")}</span>
          </div>
          <p className="mb-2 text-xs text-muted">{t("providers.customEndpointHint")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder={t("providers.customNamePlaceholder")}
              aria-label={t("providers.customNamePlaceholder")}
              className={inputCls()}
            />
            <input
              value={customBaseURL}
              onChange={(event) => setCustomBaseURL(event.target.value)}
              placeholder={t("providers.customUrlPlaceholder")}
              aria-label={t("providers.customUrlPlaceholder")}
              spellCheck={false}
              className={inputCls("font-mono")}
            />
            <input
              type="password"
              value={customKey}
              onChange={(event) => setCustomKey(event.target.value)}
              placeholder={t("providers.customKeyPlaceholder")}
              aria-label={t("providers.customKeyPlaceholder")}
              autoComplete="new-password"
              spellCheck={false}
              className={inputCls("font-mono")}
            />
            <input
              value={customModels}
              onChange={(event) => setCustomModels(event.target.value)}
              placeholder={t("providers.customModelsPlaceholder")}
              aria-label={t("providers.customModelsPlaceholder")}
              spellCheck={false}
              className={inputCls("font-mono")}
            />
            <input
              type="number"
              min={1}
              value={customContext}
              onChange={(event) => setCustomContext(event.target.value)}
              placeholder={t("providers.customContextPlaceholder")}
              aria-label={t("providers.customContextPlaceholder")}
              className={inputCls("font-mono")}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void discoverModels()}
                disabled={customBusy !== null || !customId || !customBaseURL.trim()}
                className="flex h-8 items-center gap-1 rounded-input bg-surface-2 px-3 text-[13px] text-text transition-colors hover:bg-border/50 disabled:text-muted"
              >
                {customBusy === "discover" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                {customBusy === "discover"
                  ? t("providers.fetchingModels")
                  : t("providers.fetchModels")}
              </button>
              <button
                type="button"
                onClick={() => void saveCustomProvider()}
                disabled={
                  customBusy !== null ||
                  !customId ||
                  !customBaseURL.trim() ||
                  customModelIds.length === 0
                }
                className="flex h-8 items-center gap-1 rounded-input bg-accent px-3 text-[13px] text-white transition-colors hover:bg-accent/90 disabled:bg-accent/50"
              >
                {customBusy === "save" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Plus size={13} />
                )}
                {t("providers.addEndpoint")}
              </button>
            </div>
          </div>
          {customProviderIds.length > 0 && (
            <div className="mt-3 divide-y divide-faint border-t border-faint">
              {customProviderIds.map((id) => (
                <div key={id} className="flex h-9 items-center gap-2">
                  <Server size={12} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text">{id}</span>
                  <button
                    type="button"
                    onClick={() => void removeCustomProvider(id)}
                    disabled={customBusy !== null}
                    title={t("providers.removeTitle")}
                    aria-label={`${t("common:actions.remove")} ${id}`}
                    className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-error disabled:text-muted/50"
                  >
                    {customBusy === id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Live dsh catalog: official, custom, and local providers all land here. */}
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-text">
            <Server size={13} />
            <span>{t("model.selectModel")}</span>
          </div>
          {options.length === 0 ? (
            <p className="rounded-input bg-surface-2 px-3 py-2 text-[13px] text-muted">
              {t("model.noModels")}
            </p>
          ) : (
            <div className="space-y-3">
              {byProvider.map(({ provider, models }) => (
                <div key={provider.id}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-muted">
                      {provider.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted/70">
                      {provider.id}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {models.map((m) => {
                      const active = defaultModel === m.key;
                      return (
                        <button
                          key={m.key}
                          onClick={() => void selectModel(m.key)}
                          disabled={savingModel !== null}
                          aria-pressed={active}
                          className={cn(
                            "flex min-h-16 flex-col items-start gap-0.5 rounded-input border px-3 py-2.5 text-left transition-colors",
                            active
                              ? "border-accent bg-surface-2"
                              : "border-border hover:border-faint hover:bg-surface-2/60",
                          )}
                        >
                          <span className="line-clamp-2 text-[13px] font-medium text-text">
                            {m.modelName}
                          </span>
                          <span className="max-w-full truncate font-mono text-[11px] text-muted">
                            {m.modelID}
                          </span>
                          {savingModel === m.key && (
                            <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted">
                              <Loader2 size={10} className="animate-spin" />
                              {t("model.switching")}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
