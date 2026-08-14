import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderInfo } from "@deeplab/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { flattenModelOptions, type ModelOption } from "./modelCatalog";
import { Section } from "./Section";

/** Ids of image-GENERATION models: they are not streaming chat models, so the
 *  `image-tools` skill calls their images API directly instead of chatting. */
const IMAGE_GEN_RE = /cogview|dall[-_ ]?e|flux|imagen|sdxl|stable[- ]?diffusion|midjourney|t2i|imagegen/i;

function isImageGen(o: ModelOption): boolean {
  return IMAGE_GEN_RE.test(o.modelID);
}

/**
 * The multimodal model pickers (设置 → 模型):
 *  - Image understanding (解读图片): a turn that attaches an image is routed to
 *    this model instead of the session's, so a non-vision main model can still
 *    see images.
 *  - Image generation (生图): not a chat model — the `image-tools` skill calls
 *    its images API directly. Falls back to zhipu/cogview-3-flash when unset.
 * Both choices are persisted to the sidecar's multimodal.json so the skill can
 * reach them without the app UI.
 */
export function VisionModelCard({ providers }: { providers: ProviderInfo[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const visionModel = useRuntimeStore((s) => s.visionModel);
  const setVisionModel = useRuntimeStore((s) => s.setVisionModel);
  const imageGenModel = useRuntimeStore((s) => s.imageGenModel);
  const setImageGenModel = useRuntimeStore((s) => s.setImageGenModel);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);

  const options = useMemo(() => flattenModelOptions(providers), [providers]);
  const genOptions = useMemo(() => {
    const matches = options.filter(isImageGen);
    const curated = providers.some((p) => p.id === "zhipu")
      ? { key: "zhipu/cogview-3-flash", providerID: "zhipu", providerName: "Zhipu", modelID: "cogview-3-flash", modelName: "cogview-3-flash" }
      : null;
    if (curated && !matches.some((m) => m.key === curated.key)) matches.unshift(curated);
    return matches;
  }, [options, providers]);

  return (
    <Section title={t("visionModel.title")} hint={t("visionModel.hint")}>
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-[13px] text-text">
            {t("visionModel.understandLabel")}
          </span>
          <select
            value={visionModel ?? ""}
            onChange={(e) => setVisionModel(e.target.value || null)}
            aria-label={t("visionModel.understandLabel")}
            className="max-w-[16rem] shrink-0 rounded-input border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent"
          >
            <option value="">
              {defaultModel
                ? t("visionModel.noneNamed", { model: defaultModel })
                : t("visionModel.none")}
            </option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.key}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-[13px] text-text">
            {t("visionModel.generateLabel")}
          </span>
          {genOptions.length === 0 ? (
            <span className="shrink-0 text-xs text-muted">{t("visionModel.noGenModels")}</span>
          ) : (
            <select
              value={imageGenModel ?? ""}
              onChange={(e) => setImageGenModel(e.target.value || null)}
              aria-label={t("visionModel.generateLabel")}
              className="max-w-[16rem] shrink-0 rounded-input border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent"
            >
              <option value="">{t("visionModel.genDefault")}</option>
              {genOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.key}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </Section>
  );
}
