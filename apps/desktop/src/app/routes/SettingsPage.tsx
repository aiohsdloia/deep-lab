import { useCallback, useEffect, useState } from "react";
import {
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Minus,
  NotebookPen,
  Plus,
  Search,
} from "lucide-react";
import type {
  McpServer,
  ProviderInfo,
} from "@deeplab/sdk";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useUiStore, ZOOM_MAX, ZOOM_MIN } from "@/lib/store";
import { shippedLocales } from "@/i18n/config";
import { getClient, useRuntimeStore } from "@/lib/runtime";import {
  agentBrowserProfiles,
  closeAgentBrowser,
  detectChrome,
  setupBrowserChrome,
  type BrowserProfile,
  type ChromeInfo,
  isMacUA,
  isTauri,
  jupyterStatus,
  openWorkspaceBase,
  pickFolder,
  pythonInterpreter,
  removeConfigEntry,
  setPythonPath,
  setWorkspaceBase,
  workspaceBase,
  type JupyterStatus,
  type PythonInterpreter,
} from "@/lib/tauri";
import { useSetupStore } from "@/lib/setup";
import { RemoteComputeCard } from "@/components/settings/RemoteComputeCard";
import { RemoteAccessCard } from "@/components/settings/RemoteAccessCard";
import { ModalCard } from "@/components/settings/ModalCard";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { fallbackDefaultModel } from "@/components/settings/modelCatalog";
import { VisionModelCard } from "@/components/settings/VisionModelCard";
import { ModelSettingsCard } from "@/components/settings/ModelSettingsCard";
import { MemoryCard } from "@/components/settings/MemoryCard";
import { Row, Section, Switch } from "@/components/settings/Section";
import { resolveSection } from "@/components/settings/sections";
import { chipCls, inputCls, selectCls } from "@/components/settings/inputCls";
import { SCIENCE_CONNECTORS } from "@/lib/scienceConnectors";
import {
  BROWSER_MCP_ID,
  BROWSER_DISPLAY_NAMES,
  PRIVATE_BROWSER,
} from "@/lib/browser";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Settings. ONE configuration surface: everything talks to the bundled
 * dsh's own config/auth API — no separate "model key" concept.
 */
export function SettingsPage() {
  // Which settings section is on screen — the sidebar is the navigation.
  const section = resolveSection(useParams().section);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const locale = useUiStore((s) => s.locale);
  const setLocale = useUiStore((s) => s.setLocale);
  const zoom = useUiStore((s) => s.zoom);
  const zoomBy = useUiStore((s) => s.zoomBy);
  const resetZoom = useUiStore((s) => s.resetZoom);
  const { t } = useTranslation(["settings", "common"]);
  // Select each field individually. A bare `useRuntimeStore()` subscribed to the
  // WHOLE store, so every unrelated mutation (session events, streaming, idle
  // checks) re-rendered this page — in the packaged WKWebView that repaint storm
  // made the native <select>/<input>/<button> controls flicker and blank out on
  // scroll. These are the only fields the page actually reads.
  const status = useRuntimeStore((s) => s.status);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const loadCatalog = useRuntimeStore((s) => s.loadCatalog);
  const autoReview = useRuntimeStore((s) => s.autoReview);
  const setAutoReview = useRuntimeStore((s) => s.setAutoReview);
  const connected = status === "ready";

  // Long-running uv provisioning lives in a store, not here: navigating away
  // must not discard the "setting up…" state or sever the progress stream.
  const jupyterBusy = useSetupStore((s) => s.jupyterBusy);
  const enablingConnector = useSetupStore((s) => s.connectorId);
  const browserBusy = useSetupStore((s) => s.browserBusy);
  const setupLine = useSetupStore((s) => s.line);
  const setupGeneration = useSetupStore((s) => s.generation);

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  // The Models card's own lifecycle. "ready" is sticky across later refresh
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [jupyter, setJupyter] = useState<JupyterStatus | null>(null);
  // Browser control (agent-browser): detected Chrome + profiles, and the choices
  // the card collects before enabling.
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfile[]>([]);
  const [chrome, setChrome] = useState<ChromeInfo | null>(null);
  const [browserProfile, setBrowserProfile] = useState(""); // "" ⇒ isolated
  const [browserHeaded, setBrowserHeaded] = useState(false);
  const [browserTools, setBrowserTools] = useState("core");
  const [browserDomains, setBrowserDomains] = useState(""); // one pattern per line
  // The interpreter local Python kernels resolve to + the manual override input.
  const [pyInfo, setPyInfo] = useState<PythonInterpreter | null>(null);
  const [pyPath, setPyPath] = useState("");
  const [savingPy, setSavingPy] = useState(false);
  // API keys typed for key-requiring connectors, keyed by connector id.
  const [connectorKeys, setConnectorKeys] = useState<Record<string, string>>({});

  // Add-MCP-server form.
  const [mName, setMName] = useState("");
  const [mType, setMType] = useState<"local" | "remote">("local");
  const [mTarget, setMTarget] = useState("");
  const [wsPath, setWsPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (): Promise<ProviderInfo[] | null> => {
    const client = getClient();
    if (!client) return null;
    // The model catalog (listProviders) is what the Models card renders — only
    // its failure means "catalog unavailable", and only when there is no last
    // good list to keep showing. The rest is auxiliary settings data.
    let fresh: ProviderInfo[] | null = null;
    try {
      fresh = await client.listProviders();
      setProviders(fresh);
    } catch {
      /* catalog is advisory; the page still renders */
    }
    try {
      const mcp = await client.listMcpServers().catch(() => []);
      setMcpServers(mcp);
      setJupyter(await jupyterStatus());
    } catch {
      /* runtime not ready yet */
    }
    return fresh;
  }, []);

  // Re-refresh when a provisioning run finishes (setupGeneration bumps) so a
  // newly-enabled MCP shows up even if setup completed while this page was
  // closed — the flow itself lives in the setup store.
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh, setupGeneration]);
  useEffect(() => {
    // The BASE folder — contains projects/ and sessions/. (The per-session
    // active folder shows in the conversation header.)
    void workspaceBase().then(setWsPath);
  }, []);
  const refreshPython = useCallback(() => {
    void pythonInterpreter().then(setPyInfo);
  }, []);
  // Also on setupGeneration: a fresh jupyter-env may now back the local kernel.
  useEffect(refreshPython, [refreshPython, setupGeneration]);

  // Detect Chrome + profiles once connected, and re-detect after a provisioning
  // run (a Chrome download can appear between renders).
  useEffect(() => {
    if (!isTauri || !connected) return;
    void agentBrowserProfiles().then(setBrowserProfiles);
    void detectChrome().then((c) => {
      setChrome(c);
      // With no system Chrome, the only workable choice is the private browser.
      if (!c) setBrowserProfile((p) => (p === PRIVATE_BROWSER ? p : PRIVATE_BROWSER));
    });
  }, [connected, setupGeneration]);

  // The registered MCP entry is the source of truth for browser settings.
  const browserServer = mcpServers.find((s) => s.name === BROWSER_MCP_ID) ?? null;
  const browserEnabled = browserServer !== null;
  const browserConfigSig = JSON.stringify(browserServer?.config ?? null);
  // When enabled, mirror the live config into the form so the page shows the
  // current settings and edits start from them (not stale defaults).
  useEffect(() => {
    const cfg = browserServer?.config;
    if (!cfg || cfg.type !== "local") return;
    const env = cfg.environment ?? {};
    // No executable path pinned ⇒ it's the private (downloaded) browser.
    setBrowserProfile(
      env.AGENT_BROWSER_EXECUTABLE_PATH ? (env.AGENT_BROWSER_PROFILE ?? "") : PRIVATE_BROWSER,
    );
    setBrowserHeaded(env.AGENT_BROWSER_HEADED === "true");
    setBrowserDomains(
      (env.AGENT_BROWSER_ALLOWED_DOMAINS ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean)
        .join("\n"),
    );
    const ti = cfg.command.indexOf("--tools");
    setBrowserTools(ti >= 0 && cfg.command[ti + 1] ? cfg.command[ti + 1] : "core");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserConfigSig]);

  const savePythonPath = async (path: string) => {
    setSavingPy(true);
    try {
      await setPythonPath(path);
      setPyPath("");
      toast.success(path ? t("toast.interpreterSet") : t("toast.overrideCleared"));
      refreshPython();
    } catch (e) {
      toast.error(`${t("toast.couldNotSetInterpreter")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingPy(false);
    }
  };

  const changeWorkspaceBase = async () => {
    const picked = await pickFolder();
    if (!picked) return;
    try {
      setWsPath(await setWorkspaceBase(picked));
      toast.success(t("toast.folderSet"));
    } catch (err) {
      toast.error(`${t("toast.couldNotSetFolder")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // The one post-change sequence — run() and the background OAuth wait must
  // stay in lockstep, so they share it instead of each keeping a copy.
  const refreshAll = async () => {
    const fresh = await refresh();
    await loadCatalog();
    // A provider change can strand the configured default model (provider
    // removed, or its models renamed): every later send then fails with
    // "model not found" (#18). Re-point it at the closest surviving model
    // while the change that broke it is still on screen.
    const { defaultModel: current, setDefaultModel } = useRuntimeStore.getState();
    const next = fresh && current ? fallbackDefaultModel(fresh, current) : null;
    if (!next) return;
    try {
      await setDefaultModel(next);
      toast.success(t("toast.defaultModelReset", { old: current, model: next }));
    } catch (e) {
      toast.error(`${t("toast.couldNotSetModel")}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refreshAll();
    } catch (e) {
      toast.error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const addMcp = () =>
    run(t("toast.couldNotAddMcp"), async () => {
      const name = mName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const target = mTarget.trim();
      if (!name || !target) {
        toast.error(t("toast.mcpFieldsRequired"));
        return;
      }
      await getClient()!.addMcpServer(
        name,
        mType === "local"
          ? { type: "local", command: target.split(/\s+/), enabled: true }
          : { type: "remote", url: target, enabled: true },
      );
      toast.success(t("toast.mcpAdded", { name }));
      setMName("");
      setMTarget("");
    });

  // The provisioning flows themselves live in the setup store so they outlive
  // this page. The connector's API key is dropped from UI state up front — the
  // store already holds the value it needs, so it never lingers here.
  const enableConnector = (id: string) => {
    const key = connectorKeys[id];
    setConnectorKeys((k) => ({ ...k, [id]: "" }));
    void useSetupStore.getState().enableConnector(id, key);
  };

  const enableBrowserControl = () => {
    const useSystemChrome = browserProfile !== PRIVATE_BROWSER;
    void useSetupStore.getState().enableBrowser({
      profileDir: useSystemChrome && browserProfile ? browserProfile : undefined,
      headed: browserHeaded,
      tools: browserTools,
      useSystemChrome,
      allowedDomains: browserDomains
        .split(/[\n,]/)
        .map((d) => d.trim())
        .filter(Boolean),
    });
  };

  const disableBrowser = () =>
    run(t("toast.couldNotRemoveMcp"), async () => {
      await closeAgentBrowser();
      await removeConfigEntry("mcp", BROWSER_MCP_ID);
      await useRuntimeStore.getState().connectRetry();
      toast.success(t("toast.mcpRemoved", { name: t("browser.label") }));
    });

  // Pre-download a private browser when no system Chrome exists (agent-browser
  // would otherwise fetch one silently on first use). Streams via setup-progress.
  const downloadBrowser = () =>
    run(t("browser.couldNotDownload"), async () => {
      await setupBrowserChrome();
      setChrome(await detectChrome());
      toast.success(t("browser.downloaded"));
    });

  const removeMcp = (name: string) =>
    run(t("toast.couldNotRemoveMcp"), async () => {
      await removeConfigEntry("mcp", name);
      await useRuntimeStore.getState().connectRetry();
      toast.success(t("toast.mcpRemoved", { name }));
    });

  return (
    // `select-none`: Settings is chrome, not a document. Right-clicking or
    // dragging across a label used to leave stray highlight behind; the inputs
    // opt back in globally (see index.css).
    <div className="h-full select-none overflow-y-auto">
      {/* Modest top padding: the AppShell titlebar strip already clears 48px. */}
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-4 sm:px-8">
        <h1 className="text-2xl text-text">{t(`nav.${section}`)}</h1>

        {/* ---- Models: one API key + Flash/Pro choice ---- */}
        {section === "models" && <ModelSettingsCard />}

        {/* ---- Image-understanding model: image turns route here ---- */}
        {section === "models" && <VisionModelCard providers={providers} />}

        {/* ---- Persistent memory layers ---- */}
        {section === "memory" && <MemoryCard />}

        {/* ---- MCP servers ---- */}
        {section === "connectors" && (
        <Section title={t("mcp.title")} hint={t("mcp.hint")} flush>
          {!connected ? (
            <p className="px-4 py-3 text-[13px] text-muted">{t("mcp.connectPrompt")}</p>
          ) : (
            <div>
              {/* Curated open-source science connectors — one-click enable. */}
              {isTauri &&
                SCIENCE_CONNECTORS.filter((c) => !mcpServers.some((s) => s.name === c.id)).map(
                  (c) => {
                    const keyMissing = Boolean(c.apiKeyEnv) && !connectorKeys[c.id]?.trim();
                    return (
                      <div
                        key={c.id}
                        className="border-b border-faint bg-surface px-3 py-2.5 text-[13px]"
                      >
                        <div className="flex items-center gap-2.5">
                          <Search size={14} className="shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <span className="font-medium text-text">{c.label}</span>
                            <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                              {c.discipline}
                            </span>
                            <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                              {t("mcp.openSource")}
                            </span>
                            <div className="truncate text-xs text-muted">{c.description}</div>
                            <div className="truncate font-mono text-[11px] text-muted/70">
                              {c.source}
                              {c.installNote ? ` · ${c.installNote}` : ""}
                            </div>
                          </div>
                          <button
                            className={btnAccent("h-8")}
                            onClick={() => void enableConnector(c.id)}
                            disabled={enablingConnector !== null || busy || keyMissing}
                            title={keyMissing ? t("mcp.enterKeyFirstTitle") : undefined}
                          >
                            {enablingConnector === c.id ? (
                              <>
                                <Loader2 size={12} className="animate-spin" /> {t("mcp.settingUp")}
                              </>
                            ) : (
                              t("mcp.enable")
                            )}
                          </button>
                        </div>
                        {c.apiKeyEnv && (
                          <div className="mt-2 flex items-center gap-2 pl-6">
                            <input
                              type="password"
                              value={connectorKeys[c.id] ?? ""}
                              onChange={(e) =>
                                setConnectorKeys((k) => ({ ...k, [c.id]: e.target.value }))
                              }
                              placeholder={`${c.apiKeyEnv} ${t("mcp.freeKeySuffix")}`}
                              className="h-8 min-w-0 flex-1 rounded-input border border-transparent bg-surface-2 px-2 font-mono text-[12px] text-text outline-none placeholder:text-muted/60 focus:border-accent/55 focus:bg-surface"
                            />
                            {c.apiKeyUrl && (
                              <a
                                href={c.apiKeyUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-accent hover:underline"
                              >
                                <ExternalLink size={11} /> {t("mcp.getFreeKey")}
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  },
                )}
              {/* Featured: one-click Jupyter (shown until its MCP entry exists). */}
              {isTauri && !mcpServers.some((s) => s.name === "jupyter") && (
                <div className="flex items-center gap-2.5 border-b border-faint bg-surface px-3 py-2.5 text-[13px]">
                  <NotebookPen size={14} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-text">{t("mcp.jupyterLabel")}</span>
                    <span className="ml-2 text-xs text-muted">
                      {t("mcp.jupyterDescription")}
                    </span>
                  </div>
                  <button
                    className={btnAccent("h-8")}
                    onClick={() => void useSetupStore.getState().enableJupyter()}
                    disabled={jupyterBusy || busy}
                  >
                    {jupyterBusy ? (
                      <>
                        <Loader2 size={12} className="animate-spin" /> {t("mcp.settingUp")}
                      </>
                    ) : jupyter?.installed ? (
                      t("mcp.enable")
                    ) : (
                      t("mcp.setUpAndEnable")
                    )}
                  </button>
                </div>
              )}
              {/* Live uv output while a provisioning run is in flight — a
                  300 MB download must never look like a frozen spinner. */}
              {(jupyterBusy || enablingConnector !== null) && (
                <div className="flex items-center gap-2 border-b border-faint bg-surface-2/50 px-3 py-1.5">
                  <Loader2 size={11} className="shrink-0 animate-spin text-muted" />
                  <span className="truncate font-mono text-[11px] text-muted">
                    {setupLine ?? t("mcp.startingDownload")}
                  </span>
                </div>
              )}
              {mcpServers.map((s, i) => (
                <div
                  key={s.name}
                  className={cn(
                    "flex h-10 items-center gap-2.5 bg-surface px-3 text-[13px]",
                    i > 0 && "border-t border-faint",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      s.status === "connected"
                        ? "bg-ok"
                        : s.status === "failed"
                          ? "bg-error"
                          : "bg-muted",
                    )}
                  />
                  <span className="font-medium text-text">{s.name}</span>
                  <span className="text-xs text-muted">
                    {s.config?.type ?? "?"} · {s.status}
                  </span>
                  <span className="max-w-[260px] flex-1 truncate text-right font-mono text-[11px] text-muted/70">
                    {s.config?.type === "local"
                      ? s.config.command.join(" ")
                      : s.config?.type === "remote"
                        ? s.config.url
                        : ""}
                  </span>
                  <button
                    className="shrink-0 text-xs text-muted transition-colors hover:text-error"
                    onClick={() => void removeMcp(s.name)}
                    disabled={busy}
                  >
                    {t("common:actions.remove")}
                  </button>
                </div>
              ))}

              <div
                className={cn(
                  "space-y-2 p-3",
                  mcpServers.length > 0 && "border-t border-faint",
                )}
              >
                <div className="flex gap-2">
                  <input
                    value={mName}
                    onChange={(e) => setMName(e.target.value)}
                    placeholder={t("mcp.namePlaceholder")}
                    className={inputCls("flex-1")}
                  />
                  <select
                    value={mType}
                    onChange={(e) => setMType(e.target.value as "local" | "remote")}
                    className={selectCls("w-[110px]")}
                  >
                    <option value="local">{t("mcp.typeLocal")}</option>
                    <option value="remote">{t("mcp.typeRemote")}</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    value={mTarget}
                    onChange={(e) => setMTarget(e.target.value)}
                    placeholder={
                      mType === "local"
                        ? t("mcp.commandPlaceholder")
                        : t("mcp.urlPlaceholder")
                    }
                    className={inputCls("flex-1 font-mono")}
                  />
                  <button className={btnAccent()} onClick={() => void addMcp()} disabled={busy}>
                    {t("mcp.addServer")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </Section>
        )}

        {/* ---- Browser control (agent-browser) — its own page, reconfigurable ---- */}
        {section === "browser" && (
        <Section title={t("browser.title")} hint={t("browser.hint")} flush>
          {!connected ? (
            <p className="px-4 py-3 text-[13px] text-muted">{t("mcp.connectPrompt")}</p>
          ) : (
            <div className="divide-y divide-faint">
              {/* Browse as — reuse a Chrome login, run isolated, or a separate
                  private (downloaded) browser that never touches Chrome. */}
              <Row
                title={t("browser.browseAs")}
                hint={
                  <>
                    {browserProfile === PRIVATE_BROWSER
                      ? t("browser.privateNote")
                      : browserProfile
                        ? t("browser.reuseNote", {
                            name:
                              browserProfiles.find((p) => p.directory === browserProfile)?.name ??
                              browserProfile,
                          })
                        : t("browser.isolatedNote")}
                    {chrome ? (
                      <span className="mt-1 block">
                        {t("browser.detected")}:{" "}
                        <span className="text-text">
                          {BROWSER_DISPLAY_NAMES[chrome.kind] ?? chrome.kind}
                        </span>
                      </span>
                    ) : (
                      <span className="mt-1 block">{t("browser.noChromeWillDownload")}</span>
                    )}
                  </>
                }
              >
                <div className="mt-2.5 flex items-center gap-2">
                  <select
                    value={browserProfile}
                    onChange={(e) => setBrowserProfile(e.target.value)}
                    aria-label={t("browser.browseAs")}
                    className={selectCls("min-w-0 flex-1")}
                  >
                    {chrome && <option value="">{t("browser.isolated")}</option>}
                    {chrome &&
                      browserProfiles.map((p) => (
                        <option key={p.directory} value={p.directory}>
                          {p.name} · {p.directory}
                        </option>
                      ))}
                    <option value={PRIVATE_BROWSER}>{t("browser.privateBrowser")}</option>
                  </select>
                  {browserProfile === PRIVATE_BROWSER && (
                    <button
                      className={btnGhost("gap-1.5")}
                      onClick={() => void downloadBrowser()}
                      disabled={browserBusy || busy}
                    >
                      <Download size={13} /> {t("browser.download")}
                    </button>
                  )}
                </div>
              </Row>

              {/* Capabilities (tool profile) */}
              <Row title={t("browser.capabilities")}>
                <select
                  value={browserTools}
                  onChange={(e) => setBrowserTools(e.target.value)}
                  aria-label={t("browser.capabilities")}
                  className={selectCls("mt-2.5 w-full")}
                >
                  <option value="core">{t("browser.capCore")}</option>
                  <option value="core,network">{t("browser.capNetwork")}</option>
                  <option value="all">{t("browser.capAll")}</option>
                </select>
              </Row>

              {/* Allowed domains — the safety guardrail */}
              <Row title={t("browser.allowedDomains")} hint={t("browser.allowedDomainsHint")}>
                <textarea
                  value={browserDomains}
                  onChange={(e) => setBrowserDomains(e.target.value)}
                  rows={3}
                  placeholder={t("browser.allowedDomainsPlaceholder")}
                  aria-label={t("browser.allowedDomains")}
                  className="mt-2.5 w-full rounded-input border border-transparent bg-surface-2 px-2.5 py-2 font-mono text-[12px] text-text outline-none placeholder:text-muted/50 focus:border-accent/55 focus:bg-surface"
                />
              </Row>

              {/* Show the window */}
              <Row
                title={t("browser.showWindow")}
                control={
                  <Switch
                    checked={browserHeaded}
                    onChange={setBrowserHeaded}
                    label={t("browser.showWindow")}
                  />
                }
              />

              {/* Status + actions */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs",
                    browserEnabled ? "text-ok" : "text-muted",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      browserEnabled ? "bg-ok" : "bg-muted",
                    )}
                  />
                  {browserEnabled ? t("browser.enabledStatus") : t("browser.disabledStatus")}
                </span>
                {(browserBusy || busy) && setupLine && (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
                    <Loader2 size={11} className="shrink-0 animate-spin" />
                    <span className="truncate font-mono text-[11px]">{setupLine}</span>
                  </span>
                )}
                <div className="flex-1" />
                {browserEnabled && (
                  <button
                    className={btnGhost("hover:text-error")}
                    onClick={() => void disableBrowser()}
                    disabled={busy || browserBusy}
                  >
                    {t("browser.disable")}
                  </button>
                )}
                <button
                  className={btnAccent()}
                  onClick={enableBrowserControl}
                  disabled={browserBusy || busy}
                >
                  {browserBusy ? (
                    <>
                      <Loader2 size={12} className="animate-spin" /> {t("mcp.settingUp")}
                    </>
                  ) : browserEnabled ? (
                    t("browser.apply")
                  ) : (
                    t("mcp.enable")
                  )}
                </button>
              </div>
            </div>
          )}
        </Section>
        )}

        {/* ---- Workspace ---- */}
        {section === "general" && (
        <Section title={t("workspace.title")} hint={t("workspace.hint")}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 select-all truncate font-mono text-[13px] leading-9 text-muted">
              {wsPath ?? t("workspace.unavailable")}
            </span>
            {wsPath && (
              <>
                <button className={btnGhost("gap-1.5")} onClick={() => void changeWorkspaceBase()}>
                  {t("workspace.change")}
                </button>
                <button className={btnGhost("gap-1.5")} onClick={() => void openWorkspaceBase()}>
                  <FolderOpen size={13} /> {t("workspace.reveal")}
                </button>
              </>
            )}
          </div>
        </Section>
        )}

        {/* ---- Review ---- */}
        {section === "general" && (
        <Section title={t("review.title")} hint={t("review.hint")} flush>
          <div className="divide-y divide-faint">
            <Row
              title={t("review.autoTitle")}
              hint={t("review.autoHint")}
              control={
                <Switch
                  checked={autoReview}
                  onChange={setAutoReview}
                  label={t("review.autoTitle")}
                />
              }
            />
          </div>
        </Section>
        )}

        {/* ---- Local Python kernel ---- */}
        {section === "general" && isTauri && (
          <Section title={t("python.title")} hint={t("python.hint")}>
            <div className="flex items-center gap-2 text-[13px]">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  pyInfo?.resolved ? "bg-ok" : "bg-error",
                )}
              />
              {pyInfo?.resolved ? (
                <>
                  <span className="min-w-0 flex-1 select-all truncate font-mono text-[12px] text-text">
                    {pyInfo.resolved}
                  </span>
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted ring-1 ring-border">
                    {pyInfo.source === "manual"
                      ? t("python.sourceManual")
                      : pyInfo.source === "jupyter-env"
                        ? t("python.sourceAppManaged")
                        : t("python.sourceAutoDetected")}
                  </span>
                </>
              ) : (
                <span className="min-w-0 flex-1 text-error">
                  {pyInfo?.error ?? t("python.checking")}
                </span>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                value={pyPath}
                onChange={(e) => setPyPath(e.target.value)}
                placeholder={pyInfo?.configured ?? t("python.pathPlaceholder")}
                className={inputCls("flex-1 font-mono")}
                spellCheck={false}
              />
              <button
                className={btnAccent()}
                onClick={() => void savePythonPath(pyPath.trim())}
                disabled={savingPy || !pyPath.trim()}
              >
                {savingPy ? <Loader2 size={12} className="animate-spin" /> : t("python.useThisPython")}
              </button>
              {pyInfo?.configured && (
                <button
                  className={btnGhost()}
                  onClick={() => void savePythonPath("")}
                  disabled={savingPy}
                >
                  {t("python.clearOverride")}
                </button>
              )}
            </div>
          </Section>
        )}

        {section === "compute" && (
          <>
            <RemoteComputeCard />
            <ModalCard />
          </>
        )}

        {/* ---- Remote access (API gateway: CLI / LAN web / tunnel) ---- */}
        {section === "remote" && <RemoteAccessCard />}

        {/* ---- Privacy & data flow ---- */}
        {section === "privacy" && <DataFlowCard model={defaultModel} workspace={wsPath} />}

        {/* ---- Appearance ---- */}
        {section === "appearance" && (
        <Section title={t("appearance.title")} flush>
          <div className="divide-y divide-faint">
            <Row title={t("appearance.themeLabel")}
              control={
                <div className="inline-flex shrink-0 gap-0.5">
                  {/* eslint-disable-next-line i18next/no-literal-string -- internal theme-mode keys, not display text (the visible label is t(`appearance.theme.${mode}`)) */}
                  {(["light", "warm", "dark", "eink"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setTheme(mode)}
                      className={cn(
                        "rounded-[7px] px-4 py-1.5 text-[13px] transition-colors",
                        theme === mode ? "bg-surface-2 text-text" : "text-muted hover:text-text",
                      )}
                    >
                      {t(`appearance.theme.${mode}`)}
                    </button>
                  ))}
                </div>
              }
            />
            <Row title={t("language.label")}
              control={
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  aria-label={t("language.label")}
                  className={chipCls()}
                >
                  {shippedLocales().map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.nativeName}
                    </option>
                  ))}
                </select>
              }
            />
            {/* Zoom is desktop-only: in a browser the browser's own zoom rules. */}
            {isTauri && (
              <Row
                title={t("appearance.zoom.label")}
                hint={t("appearance.zoom.hint", { mod: isMacUA() ? "⌘" : "Ctrl" })}
                control={
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      className={btnGhost("h-8 w-8 justify-center px-0")}
                      onClick={() => zoomBy(-1)}
                      disabled={zoom <= ZOOM_MIN}
                      aria-label={t("appearance.zoom.out")}
                    >
                      <Minus size={13} />
                    </button>
                    <span className="w-11 text-center text-[13px] tabular-nums text-text">
                      {/* eslint-disable-next-line i18next/no-literal-string -- "%" unit glue, not prose */}
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      className={btnGhost("h-8 w-8 justify-center px-0")}
                      onClick={() => zoomBy(1)}
                      disabled={zoom >= ZOOM_MAX}
                      aria-label={t("appearance.zoom.in")}
                    >
                      <Plus size={13} />
                    </button>
                    {zoom !== 1 && (
                      <button className={btnGhost("h-8")} onClick={resetZoom}>
                        {t("appearance.zoom.reset")}
                      </button>
                    )}
                  </div>
                }
              />
            )}
          </div>
        </Section>
        )}

      </div>
    </div>
  );
}

/* ---- Shared bits: one look for every control on this page ---- */


// Hover/disabled states use background + text COLOR, never `opacity`. The CSS
// `opacity` property promotes an element to its own GPU compositing layer; in
// the packaged macOS WKWebView, hovering one such button (an opacity
// transition) forced a recomposite that mis-repainted the neighbouring
// disabled (`opacity-50`) buttons — they visibly flickered. Alpha backgrounds
// (`bg-accent/90`) are a plain paint, so no layer is promoted and nothing
// flickers.
const btnGhost = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1 rounded-input border border-transparent bg-surface-2 px-3.5",
    "text-[13px] text-text transition-colors hover:bg-border/50 disabled:text-muted",
    extra,
  );

const btnAccent = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3.5 text-[13px] font-medium",
    "text-accent-fg transition-colors hover:bg-accent/90 disabled:bg-accent/50",
    extra,
  );
