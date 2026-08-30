import { useTranslation } from "react-i18next";
import {
  BrainCircuit,
  ChevronRight,
  Dna,
  GitFork,
  Globe,
  Sparkles,
} from "lucide-react";

export interface WorkflowStarter {
  id: string;
  icon: React.ReactNode;
  /** Sent to the agent as-is — content, not UI copy, so it is never translated.
   *  The card's display title/description live in `session:starters.<id>.*`. */
  prompt: string;
  /** A "clean" starter is NOT a prompt: clicking it opens a truly blank session
   *  (nothing loaded, no instruction sent) instead of sending `prompt`. */
  clean?: boolean;
  /** Bundled example workspace to install and switch into before sending. */
  example?: string;
}

/** One-click full-workflow prompts (P0-1): a single request that carries the
 *  agent through data → code → figure → report, all inside the app. */
export const WORKFLOW_STARTERS: WorkflowStarter[] = [
  {
    id: "bci-trends",
    icon: <BrainCircuit size={17} strokeWidth={1.75} />,
    example: "bci-trends",
    prompt:
      "Complete the built-in bci-trends workflow using only this workspace. Read README.md, " +
      "demo-contract.json, and data/raw/bci_literature_seed.csv first. Write plan.md and " +
      "scripts/analyze.py, then generate the contracted summary, three PNG figures, and " +
      "reports/report.md. Every numeric claim must come from the script's actual results. " +
      "Run `python scripts/analyze.py` as its own command so DeepLab records its outputs. " +
      "After that command finishes, run `python verify.py` and fix the work until it passes. " +
      "Do not access the network, invent papers, or create/edit anything under .deeplab; " +
      "DeepLab owns run history and provenance for the dsh tool events.",
  },
  {
    id: "build-bio-tool",
    icon: <Dna size={17} strokeWidth={1.75} />,
    prompt:
      "在本工作区中端到端地构建一个小型、自包含的生物信息学软件：先根据工作区内的文献提出 2–3 个具体的" +
      "工具方案，并询问我选择哪一个；然后设计并用 Python 实现一个带简单 CLI 的工具，生成一份真实感的" +
      "合成数据来验证它，编写可通过的自动化测试，并写出 README.md（用法 + 示例命令）和 report.md（总结" +
      "设计、测试结果和一次示例运行）——报告中的每一个数字都必须来自你实际运行的代码。",
  },
  {
    id: "browser",
    icon: <Globe size={17} strokeWidth={1.75} />,
    prompt:
      "使用 browser-control 工具端到端地处理来自网页的数据：打开浏览器并待命，我操作完会提问，届时再响应。" +
      "每一个数值都必须追溯到实际读取的页面。",
  },
  {
    id: "phylo-tree",
    icon: <GitFork size={17} strokeWidth={1.75} />,
    prompt:
      "在本工作区中构建一棵系统发育树：请先询问我要使用哪个序列文件（工作区没有内置示例序列，必须由我" +
      "指定）。然后用 MAFFT 比对、用 IQ-TREE 做模型选择和树推断，计算 UFBoot 分支支持，用 toytree 画一张" +
      "出版级树图，并写出 report.md 说明方法、模型和支持值——树上的每一个分支长度与支持值都必须来自你" +
      "实际运行的代码。",
  },
  {
    id: "clean",
    icon: <Sparkles size={17} strokeWidth={1.75} />,
    prompt: "",
    clean: true,
  },
];

/**
 * Empty-session welcome: a quiet, centered composition in the app's paper
 * aesthetic. The conversation is the point, so the copy invites a message
 * first; the starters below are an optional on-ramp, not a dashboard.
 */
export function WorkflowStarters({
  onPick,
  onBlank,
  examplesEnabled = true,
}: {
  onPick: (prompt: string, starter?: WorkflowStarter) => void;
  /** Fired for the "clean" card — open a truly blank session, send nothing. */
  onBlank?: () => void;
  /** Bundled examples need desktop filesystem access; hide them in web mode. */
  examplesEnabled?: boolean;
}) {
  const { t } = useTranslation(["session", "common"]);
  // Display copy per starter id — t()'s generated key type rejects a dynamic
  // `starters.${id}.title` template, so each card's copy is looked up by id
  // from this literal-keyed map instead.
  const starterCopy: Record<string, { title: string; description: string }> = {
    "bci-trends": {
      title: t("starters.bci-trends.title"),
      description: t("starters.bci-trends.description"),
    },
    "build-bio-tool": {
      title: t("starters.build-bio-tool.title"),
      description: t("starters.build-bio-tool.description"),
    },
    browser: { title: t("starters.browser.title"), description: t("starters.browser.description") },
    "phylo-tree": {
      title: t("starters.phylo-tree.title"),
      description: t("starters.phylo-tree.description"),
    },
    clean: { title: t("starters.clean.title"), description: t("starters.clean.description") },
  };
  const starters = examplesEnabled
    ? WORKFLOW_STARTERS
    : WORKFLOW_STARTERS.filter((s) => !s.example);

  return (
    <div className="flex min-h-[62vh] flex-col items-center justify-center">
      <div className="w-full max-w-[500px]">
        <div className="text-center">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-muted">
            {t("starters.newSession")}
          </div>
          <h2 className="mt-2.5 text-[26px] font-semibold leading-tight text-text">
            {t("starters.heading")}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("starters.subheading")}</p>
        </div>

        <div className="mt-7 overflow-hidden rounded-card border border-border bg-surface shadow-card">
          {starters.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                if (s.clean) {
                  onBlank?.();
                  return;
                }
                onPick(s.prompt, s);
              }}
              className="group flex w-full items-center gap-3.5 border-t border-border px-4 py-3.5 text-left transition-colors first:border-t-0 hover:bg-surface-2"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-accent ring-1 ring-border transition-colors group-hover:bg-surface">
                {s.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium text-text">
                  {starterCopy[s.id]?.title}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted">
                  {starterCopy[s.id]?.description}
                </span>
              </span>
              <ChevronRight
                size={16}
                className="shrink-0 text-muted/60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-muted"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
