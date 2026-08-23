import { useMemo, useState } from "react";
import { Check, KeyRound, Loader2, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
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

  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  const byProvider = useMemo(
    () =>
      providers.map((provider) => ({
        provider,
        models: options.filter((model) => model.providerID === provider.id),
      })),
    [options, providers],
  );

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
              type="text"
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
