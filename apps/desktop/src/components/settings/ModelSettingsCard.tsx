import { useState } from "react";
import { Check, KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";
import { inputCls } from "./inputCls";
import { Section } from "./Section";

/** The two DeepSeek models dsh exposes by default. */
const DEEPSEEK_PROVIDER = "deepseek-official";
export const DEEPSEEK_MODELS = [
  { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", label: "Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", label: "Pro" },
] as const;

/** Key the app stores the DeepSeek API key under (dsh's credential ref). */
export const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

/**
 * The whole model surface for DeepLab: one API key for the DeepSeek provider
 * plus a Flash/Pro model choice. dsh exposes exactly these two models, so a
 * full catalog browser would only ever show them — keep it a form instead.
 */
export function ModelSettingsCard() {
  const { t } = useTranslation(["settings", "common"]);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [savingModel, setSavingModel] = useState<string | null>(null);

  const currentModelId = DEEPSEEK_MODELS.find((m) => defaultModel?.endsWith(`/${m.id}`))?.id;

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

  const selectModel = async (modelId: string) => {
    if (savingModel) return;
    setSavingModel(modelId);
    try {
      await useRuntimeStore.getState().setDefaultModel(`${DEEPSEEK_PROVIDER}/${modelId}`);
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

        {/* Flash / Pro model choice */}
        <div className="px-4 py-3">
          <div className="mb-2 text-[13px] font-medium text-text">{t("model.selectModel")}</div>
          <div className="grid grid-cols-2 gap-2">
            {DEEPSEEK_MODELS.map((m) => {
              const active = currentModelId === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => void selectModel(m.id)}
                  disabled={savingModel !== null}
                  aria-pressed={active}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-input border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-accent bg-surface-2"
                      : "border-border hover:border-faint hover:bg-surface-2/60",
                  )}
                >
                  <span className="text-[13px] font-medium text-text">{m.label}</span>
                  <span className="font-mono text-[11px] text-muted">{m.id}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Section>
  );
}
