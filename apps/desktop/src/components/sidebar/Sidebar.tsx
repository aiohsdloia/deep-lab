import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Files,
  FlaskConical,
  Folder,
  FolderInput,
  FolderOpen,
  FolderTree,
  Loader2,
  Monitor,
  NotebookPen,
  Pencil,
  Pin,
  Palette,
  PanelLeft,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { draftKeyFor, rootSessionOf, useRuntimeStore } from "@/lib/runtime";
import {
  openProjectFolder,
  pickFolder,
  renameProject,
  workspaceBase,
  type ProjectImportMode,
  type ProjectInfo,
} from "@/lib/tauri";
import {
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  useOverlayTitlebar,
  useUiStore,
} from "@/lib/store";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { visibleSections, resolveSection } from "@/components/settings/sections";
import { useIsMobile } from "@/lib/useIsMobile";
import { useDragDivider } from "@/lib/useDragDivider";
import { useLayoutStore } from "@/lib/layout";
import { startPaneDrag } from "@/lib/dragPane";
import { isGatewayWeb } from "@/lib/webMode";
import { pathKey, samePath } from "@/lib/workspacePath";
import { StatusPills } from "./StatusPills";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ContextMenu,
  ContextMenuEmpty,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
} from "@/components/ui/ContextMenu";
import logo from "@/assets/logo.webp";

interface Row {
  id: string;
  title: string;
  to: string;
}

/** Dragging the divider below this pointer x collapses the sidebar; dragging
 *  back past it re-expands. Sits below SIDEBAR_MIN so there is a clear "snap". */
const COLLAPSE_BELOW = 140;

/** Whether `path` is the same folder as `base`, or sits inside it. Compared as
 *  path SEGMENTS, so "/w/DeepLab-old" is not treated as inside "/w/DeepLab".
 *  Both sides are normalized for separator and trailing slash only — this is a
 *  UI shortcut; the runtime canonicalizes and decides for real. */
export function isInside(path: string, base: string): boolean {
  const parts = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  const b = parts(base);
  const p = parts(path);
  return b.length > 0 && b.length <= p.length && b.every((seg, i) => seg === p[i]);
}

/** Session rows shown per group in the rail. The runtime now hands the app its
 *  WHOLE history (it used to stop at 100 — #65), which would otherwise turn the
 *  sidebar into an endless list; the overflow is one click away on /history. */
const ROW_LIMIT = 12;

/** Projects the user folded shut (ids). Projects default to open — a
 *  researcher has a handful, and their sessions ARE the sidebar's content. */
const COLLAPSED_KEY = "ai4s.collapsedProjects";
function initialCollapsedProjects(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Whether the secondary nav rows (Notebooks / Files / Runs / Skills) show
 *  under the New row. Defaults to hidden; the toggle lives on the New row. */
const TOOLS_KEY = "ai4s.toolsOpen";
function initialToolsOpen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(TOOLS_KEY) === "1";
}

export function Sidebar() {
  const { t } = useTranslation(["nav", "settings"]);
  const navigate = useNavigate();
  const location = useLocation();
  // In settings the sidebar becomes the settings navigation: "Back to app" on
  // top, one row per section, and NO collapse affordance — a collapsed sidebar
  // would strand the user with no way back.
  const inSettings = location.pathname.startsWith("/settings");
  const activeSection = resolveSection(location.pathname.split("/")[2]);
  // Select each field individually: a bare `useRuntimeStore()` subscribes to the
  // whole store, re-rendering the sidebar on every SSE fold during a session (#34).
  const sessions = useRuntimeStore((s) => s.sessions);
  const projects = useRuntimeStore((s) => s.projects);
  const workspace = useRuntimeStore((s) => s.workspace);
  const startDraft = useRuntimeStore((s) => s.startDraft);
  const startDraftInWorkspace = useRuntimeStore((s) => s.startDraftInWorkspace);
  const createProject = useRuntimeStore((s) => s.createProject);
  const importProject = useRuntimeStore((s) => s.importProject);
  const refreshProjects = useRuntimeStore((s) => s.refreshProjects);
  const deleteSession = useRuntimeStore((s) => s.deleteSession);
  const renameSession = useRuntimeStore((s) => s.renameSession);
  const moveSessionToWorkspace = useRuntimeStore((s) => s.moveSessionToWorkspace);
  const setSessionArchived = useRuntimeStore((s) => s.setSessionArchived);
  const setProjectPinned = useRuntimeStore((s) => s.setProjectPinned);
  const deleteProject = useRuntimeStore((s) => s.deleteProject);
  // Which sessions are working right now — so a background session (or its
  // subagent) shows it's busy without opening it. A running subagent surfaces
  // on the top-level session at the root of its parent chain.
  const runningSessions = useRuntimeStore((s) => s.runningSessions);
  const sessionParents = useRuntimeStore((s) => s.sessionParents);
  const interruptedSessions = useRuntimeStore((s) => s.interruptedSessions);
  const webReadOnly = useRuntimeStore((s) => s.webReadOnly);
  const capabilities = useRuntimeStore((s) => s.capabilities);
  const activeRoots = new Set(
    Object.keys(runningSessions).map((sid) => rootSessionOf(sessionParents, sid)),
  );
  const {
    sidebarCollapsed,
    sidebarWidth,
    setSidebarCollapsed,
    setSidebarWidth,
    toggleSidebar,
  } = useUiStore();
  // The sidebar starts at the window's left edge, so clientX is the width;
  // dragging left of COLLAPSE_BELOW snaps it collapsed but keeps the drag alive
  // (unless in Settings, which never collapses) so dragging back out re-opens it.
  const { dragging, dragValue: dragWidth, handleProps } = useDragDivider({
    value: sidebarWidth,
    compute: ({ x }) => {
      if (x < COLLAPSE_BELOW && !inSettings) return null;
      return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, x));
    },
    onCommit: setSidebarWidth,
    onCollapse: () => {
      if (!sidebarCollapsed) setSidebarCollapsed(true);
    },
    onExpand: () => {
      if (sidebarCollapsed) setSidebarCollapsed(false);
    },
  });

  const startNew = () => {
    // Desktop: "New" is new work — it gets its own Screen with its own draft
    // pane, never the focused pane (which is a conversation in progress).
    if (!isMobile && !isGatewayWeb) useLayoutStore.getState().openInNewGroup(null);
    startDraft();
    navigate("/live");
  };

  // Secondary nav rows (Notebooks/Files/Runs/Skills) collapse under the New row.
  const [toolsOpen, setToolsOpen] = useState(initialToolsOpen);
  const toggleTools = () => {
    setToolsOpen((open) => {
      const next = !open;
      try {
        window.localStorage.setItem(TOOLS_KEY, next ? "1" : "0");
      } catch {
        /* localStorage unavailable — the preference just won't persist */
      }
      return next;
    });
  };

  // ---- Projects: sessions group under a project by workspace folder ----
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>(
    initialCollapsedProjects,
  );
  // Web client: projects start collapsed (a phone shouldn't open with every
  // session expanded). Applied once, and only when the user has no saved
  // preference yet — a manual toggle then persists and wins on later visits.
  const didWebCollapse = useRef(false);
  useEffect(() => {
    if (didWebCollapse.current || !isGatewayWeb) return;
    if (typeof window !== "undefined" && window.localStorage.getItem(COLLAPSED_KEY)) {
      didWebCollapse.current = true;
      return;
    }
    if (projects.length === 0) return; // wait for the project list to load
    didWebCollapse.current = true;
    setCollapsedProjects(projects.map((p) => p.id));
  }, [projects]);
  const [namingProject, setNamingProject] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);

  const toggleProject = (id: string) =>
    setCollapsedProjects((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      if (typeof window !== "undefined")
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });

  const submitNewProject = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || createBusy) {
      setNamingProject(false);
      return;
    }
    setCreateBusy(true);
    const created = await createProject(trimmed);
    setCreateBusy(false);
    setNamingProject(false);
    if (created) {
      // The workspace switch left the focused pane bound to the PREVIOUS
      // session; clearing it to a draft before navigating is what keeps the
      // fresh project's session on screen — otherwise /live's focus→URL effect
      // re-binds the old session and the new view vanishes on first open.
      const layout = useLayoutStore.getState();
      if (layout.tree && layout.focusedLeafId) layout.bindSession(layout.focusedLeafId, null);
      navigate("/live");
    }
  };

  // Pick first, then make the copy-vs-in-place tradeoff explicit. In-place is
  // primary: users choose their project location, and the signed macOS app asks
  // for access there. Copy remains an explicit storage/isolation alternative.
  const handleImport = async () => {
    if (importBusy) return;
    const path = await pickFolder();
    if (!path) return;
    // A folder that already lives in the workspace is ADOPTED in place — the
    // copy-vs-in-place question does not apply to it, and asking would promise
    // a copy the runtime is not going to make.
    const base = await workspaceBase();
    if (base && isInside(path, base)) {
      setImportBusy(true);
      const adopted = await importProject(path, "in-place");
      setImportBusy(false);
      if (adopted) {
        const layout = useLayoutStore.getState();
        if (layout.tree && layout.focusedLeafId) layout.bindSession(layout.focusedLeafId, null);
        navigate("/live");
      }
      return;
    }
    setPendingImportPath(path);
  };

  const submitImport = async (mode: ProjectImportMode) => {
    if (importBusy || !pendingImportPath) return;
    setImportBusy(true);
    const imported = await importProject(pendingImportPath, mode);
    setImportBusy(false);
    setPendingImportPath(null);
    if (imported) {
      // Same as new-project: clear the focused pane to a draft so the imported
      // project's session isn't replaced by the old one on first open.
      const layout = useLayoutStore.getState();
      if (layout.tree && layout.focusedLeafId) layout.bindSession(layout.focusedLeafId, null);
      navigate("/live");
    }
  };

  const newSessionIn = async (p: ProjectInfo) => {
    // Same rule as "New": its own Screen, so starting work in a project does not
    // replace the pane the user is reading. Open it FIRST — the new pane's own
    // draft slot is what the composer sends under, and that is the slot the
    // project folder has to be aimed at (#69).
    const leafId =
      !isMobile && !isGatewayWeb
        ? useLayoutStore.getState().openInNewGroup(null, p.name)
        : null;
    await startDraftInWorkspace(p.path, leafId ? draftKeyFor(leafId) : undefined);
    navigate("/live");
  };

  const submitRename = async (p: ProjectInfo, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === p.name) return;
    try {
      await renameProject(p.id, trimmed);
      await refreshProjects();
    } catch {
      /* the sidebar keeps showing the old name */
    }
  };

  // Subagent child sessions are internals of their parent conversation —
  // their asks and progress surface there, so they get no row of their own.
  const topSessions = sessions.filter((s) => !s.parentId);
  // Keyed by comparison key, not the raw string: a project's path comes from Rust
  // and a session's `directory` from the sidecar, and on Windows those spell the
  // same folder differently (#76).
  const projectByPath = new Map(projects.map((p) => [pathKey(p.path), p]));
  const sessionsByProject = new Map<string, Row[]>(
    projects.map((p) => [p.id, []]),
  );
  const looseRows: Row[] = [];
  for (const s of topSessions) {
    const row: Row = {
      id: s.id,
      title: s.title,
      to: `/live/${s.id}`,
    };
    const owner = s.directory ? projectByPath.get(pathKey(s.directory)) : undefined;
    if (owner) sessionsByProject.get(owner.id)!.push(row);
    else looseRows.push(row);
  }
  // Recency per project = its newest session's update time (else its creation).
  const updatedByProject = new Map<string, number>();
  for (const s of topSessions) {
    if (!s.directory || s.updated == null) continue;
    const owner = projectByPath.get(pathKey(s.directory));
    if (owner)
      updatedByProject.set(owner.id, Math.max(updatedByProject.get(owner.id) ?? 0, s.updated));
  }
  const recencyOf = (p: ProjectInfo) => updatedByProject.get(p.id) ?? p.createdAt;
  // The sidebar shows every pinned project plus the few most-recent others; the
  // full list (search, delete, …) lives on the Projects page.
  const RECENT_LIMIT = 5;
  const byRecency = [...projects].sort((a, b) => recencyOf(b) - recencyOf(a));
  const visibleProjects = [
    ...byRecency.filter((p) => p.pinned),
    ...byRecency.filter((p) => !p.pinned).slice(0, RECENT_LIMIT),
  ];
  const hiddenProjectCount = projects.length - visibleProjects.length;

  // Project accent colors (folder tint + context-menu swatches).
  const PROJECT_COLORS: Record<string, string> = {
    red: "#e05252",
    orange: "#e8933a",
    yellow: "#dfbd35",
    green: "#4fa35a",
    blue: "#4a86e8",
    purple: "#9b6ad4",
    gray: "#8e8e93",
  };
  const projectColor = (p: { color?: string }) =>
    p.color ? PROJECT_COLORS[p.color] : undefined;
  const setProjectColor = useRuntimeStore((s) => s.setProjectColor);
  // Literal-keyed map: i18next's generated key type rejects a dynamic
  // `colorName.${key}` template, so each swatch's name is looked up by key.
  const colorName = (key: string) =>
    ({
      red: t("projects.colorName.red"),
      orange: t("projects.colorName.orange"),
      yellow: t("projects.colorName.yellow"),
      green: t("projects.colorName.green"),
      blue: t("projects.colorName.blue"),
      purple: t("projects.colorName.purple"),
      gray: t("projects.colorName.gray"),
    })[key] ?? key;

  const [pendingDelete, setPendingDelete] = useState<Row | null>(null);
  const [pendingRemoveProject, setPendingRemoveProject] = useState<ProjectInfo | null>(null);

  const confirmDelete = () => {
    const row = pendingDelete;
    setPendingDelete(null);
    if (!row) return;
    void deleteSession(row.id);
    if (location.pathname === row.to) navigate("/live");
  };

  // With the overlay titlebar (macOS), reserve a draggable strip at the top so
  // the traffic lights don't overlap the logo and the window stays movable.
  const isMac = navigator.userAgent.includes("Mac");
  const overlayTitlebar = useOverlayTitlebar();

  const width = dragWidth ?? sidebarWidth;
  const isMobile = useIsMobile();
  // On mobile the sidebar is an off-canvas overlay drawer (both app AND settings,
  // opened via the hamburger in AppShell), never sharing horizontal space; on
  // desktop it stays an inline column (settings can't collapse). Capped width so
  // it never covers the whole phone screen.
  const railWidth = isMobile ? Math.min(width, 300) : width;
  const drawerOpen = isMobile ? !sidebarCollapsed : !(sidebarCollapsed && !inSettings);

  /** The folder a session row already lives in, for the "add to project" list. */
  const sessionDirOf = (id: string) => sessions.find((x) => x.id === id)?.directory;

  const sessionRow = (row: Row) => {
    const running = activeRoots.has(row.id);
    // A session whose LAST turn was interrupted shows a yellow dot instead of
    // the green "ready" dot — the conversation is sitting on an unfinished turn.
    const wasInterrupted = !!interruptedSessions[row.id];
    // A session the runtime never auto-titled stays "New session - <stamp>"
    // (#63); double-clicking the row is the way out, matching project rename.
    if (renamingSession === row.id)
      return (
        <div key={row.to} className="py-0.5 pl-2 pr-1">
          <InlineNameInput
            defaultValue={row.title}
            onSubmit={(v) => {
              setRenamingSession(null);
              void renameSession(row.id, v);
            }}
            onCancel={() => setRenamingSession(null)}
          />
        </div>
      );
    return (
    <ContextMenu
      key={row.to}
      label={t("rowMenu.sessionLabel")}
      items={
        <>
          <ContextMenuItem
            icon={<Pencil size={14} />}
            disabled={webReadOnly}
            // Mount the editor after the menu hands focus back, or the
            // restore blurs the fresh input and a blur commits it.
            onSelect={() => requestAnimationFrame(() => setRenamingSession(row.id))}
          >
            {t("history.rename")}
          </ContextMenuItem>
          {capabilities.sessionMove && (
            <ContextMenuSub icon={<FolderInput size={14} />} label={t("history.moveTo")}>
              {projects.length === 0 && (
                <ContextMenuEmpty>{t("history.moveToNone")}</ContextMenuEmpty>
              )}
              {projects.map((p) => (
                <ContextMenuItem
                  key={p.id}
                  disabled={samePath(p.path, sessionDirOf(row.id))}
                  onSelect={() => void moveSessionToWorkspace(row.id, p.path)}
                >
                  {p.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSub>
          )}
          {capabilities.sessionArchive && (
            <ContextMenuItem
              icon={<Archive size={14} />}
              disabled={webReadOnly}
              onSelect={() => void setSessionArchived(row.id, true)}
            >
              {t("history.archive")}
            </ContextMenuItem>
          )}
          {capabilities.sessionDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={<Trash2 size={14} />}
                danger
                disabled={webReadOnly}
                onSelect={() => setPendingDelete(row)}
              >
                {t("confirmDelete.deleteAction")}
              </ContextMenuItem>
            </>
          )}
        </>
      }
    >
    <div className="group relative">
      <NavLink
        to={row.to}
        // An <a> is natively draggable; that native drag hijacks the pointer
        // stream (selecting text instead) and defeats our pointer-based dock
        // drag. Disable it so startPaneDrag's window listeners see the moves.
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          // Drag a session row into the pane area to dock it (desktop only).
          if (!isMobile && !isGatewayWeb) {
            // eslint-disable-next-line i18next/no-literal-string -- DragSource kind, not UI copy
            startPaneDrag(e, { kind: "session", sessionId: row.id }, row.title);
          }
        }}
        onClick={(e) => {
          // A trailing click right after a drag is swallowed by the drag
          // controller's one-shot capture listener, so it never reaches here.
          // Desktop tiling: a plain click SWITCHES the current screen's focused
          // pane to the session (openSessionEphemeral — never a new Screen); a
          // modifier-click opens the session in a NEW split pane beside it.
          // Web/phone (single-pane) fall through to the NavLink as before.
          if (!isMobile && !isGatewayWeb) {
            e.preventDefault();
            const layout = useLayoutStore.getState();
            if (e.metaKey || e.ctrlKey || e.altKey) {
              // eslint-disable-next-line i18next/no-literal-string -- SplitDir enum, not UI copy
              layout.split("row", row.id);
            } else {
              layout.openSessionEphemeral(row.id);
            }
            // The layout change alone is invisible from Skills/Runs/Files/…:
            // those routes render instead of the panes, so the click looked
            // dead. Navigate so the session is actually shown.
            navigate(row.to);
          }
        }}
        className={cn(
          // The selected row was only a shade of the hover background, which
          // several themes made near-invisible (#63): give it the accent tint,
          // an inset accent ring and medium weight so it reads at a glance.
          "flex items-center gap-2 rounded-input py-1 pl-2 pr-8 text-[13px] hover:bg-surface-2",
          location.pathname === row.to
            ? "bg-accent/15 font-medium text-text ring-1 ring-inset ring-accent/40"
            : "text-text/90",
        )}
      >
        {running ? (
          <Loader2
            size={12}
            className="shrink-0 animate-spin text-accent"
            aria-label={t("history.running")}
          />
        ) : wasInterrupted ? (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
            title={t("history.interrupted")}
            aria-label={t("history.interrupted")}
          />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" />
        )}
        <span
          className="flex-1 truncate"
          title={t("history.renameHint")}
          onDoubleClick={(e) => {
            if (webReadOnly) return;
            e.preventDefault();
            e.stopPropagation();
            setRenamingSession(row.id);
          }}
        >
          {row.title}
        </span>
      </NavLink>
      {capabilities.sessionDelete && (
        <button
          onClick={() => setPendingDelete(row)}
          aria-label={t("history.deleteAria", { title: row.title })}
          className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-1 text-muted hover:bg-border hover:text-error group-hover:block"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
    </ContextMenu>
    );
  };

  return (
    <div
      className={cn(
        "relative h-full overflow-hidden",
        isMobile ? "fixed inset-y-0 left-0 z-40 shadow-2xl" : "shrink-0",
        !dragging && "transition-[width,transform] duration-200 ease-out",
      )}
      style={
        isMobile
          ? { width: railWidth, transform: drawerOpen ? "none" : "translateX(-100%)" }
          : { width: sidebarCollapsed && !inSettings ? 0 : width }
      }
    >
      <aside
        // `select-none`: the rail is chrome, so a right-click (or a sloppy drag)
        // must not leave its labels highlighted. Inline rename inputs opt back
        // in via the global rule in index.css.
        className="sidebar-surface flex h-full select-none flex-col border-r border-border"
        style={{ width: railWidth }}
      >
        {/* The strip clears the traffic lights and keeps the window draggable.
            The collapse button lives on the right of the brand row, aligned
            with the "+" actions below it. */}
        {overlayTitlebar && (
          <div
            data-tauri-drag-region
            style={overlayTitlebarStyle(true)}
            className="flex shrink-0 items-center"
          />
        )}
        {inSettings && (
          <>
            <div className={cn("px-3 pb-2", overlayTitlebar ? "pt-0" : "pt-3")}>
              <button
                onClick={() => navigate("/live")}
                className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                <ArrowLeft size={15} />
                {t("settings:nav.back")}
              </button>
            </div>
            <nav className="flex flex-col gap-0.5 px-3">
              {visibleSections(isGatewayWeb, capabilities).map(({ key, icon: Icon }) => (
                <NavLink
                  key={key}
                  to={`/settings/${key}`}
                  className={cn(
                    "flex items-center gap-2 rounded-input px-2 py-1.5 text-[13px]",
                    activeSection === key
                      ? "bg-surface-2 text-text"
                      : "text-text/90 hover:bg-surface-2",
                  )}
                >
                  <Icon size={15} className={activeSection === key ? "text-text" : "text-muted"} />
                  {t(`settings:nav.${key}`)}
                </NavLink>
              ))}
            </nav>
          </>
        )}
        {!inSettings && (
        <>
        <div className={cn("px-3 pb-3", overlayTitlebar ? "pt-1" : "pt-4")}>
          <div className="flex min-w-0 items-baseline gap-1.5">
            {/* Brand = home: clicking the logo/name returns to the main page. */}
            <button
              onClick={() => navigate("/live")}
              aria-label={t("sidebar.home")}
              title={t("sidebar.home")}
              className="flex min-w-0 items-baseline gap-1.5 outline-none"
            >
              <img src={logo} alt="" className="h-[18px] w-auto shrink-0 self-center" />
              {/* eslint-disable-next-line i18next/no-literal-string -- product brand name, not translated across locales (see AGENTS.md) */}
              <div className="truncate font-serif text-[17px] font-semibold leading-none tracking-tight text-text">
                DeepLab
              </div>
            </button>
            <button
              onClick={toggleSidebar}
              aria-label={t("sidebar.collapse")}
              title={t("sidebar.collapseTitle", {
                shortcut: isMac ? "⌘B" : "Ctrl+B",
              })}
              className="ml-auto self-center rounded p-0.5 text-text hover:bg-surface-2"
            >
              <PanelLeft size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <nav className="flex flex-col px-3">
          <div className="flex items-center gap-1">
            {/* A read-only web token can't create sessions — hide the entry. */}
            {!webReadOnly && (
              <NavRow
                icon={<Monitor size={16} strokeWidth={1.5} />}
                label={t("items.new")}
                onClick={startNew}
                className="flex-1"
              />
            )}
            <button
              onClick={toggleTools}
              aria-label={toolsOpen ? t("items.collapseTools") : t("items.expandTools")}
              title={toolsOpen ? t("items.collapseTools") : t("items.expandTools")}
              className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              {toolsOpen ? (
                <ChevronUp size={14} strokeWidth={1.5} />
              ) : (
                <ChevronDown size={14} strokeWidth={1.5} />
              )}
            </button>
          </div>
          {toolsOpen && (
            <>
              {/* Notebook execution needs a local kernel — hidden in the web client. */}
              {!isGatewayWeb && (
                <NavRow
                  icon={<NotebookPen size={16} strokeWidth={1.5} />}
                  label={t("items.notebooks")}
                  onClick={() => navigate("/notebooks")}
                />
              )}
              <NavRow
                icon={<FolderTree size={16} strokeWidth={1.5} />}
                label={t("items.files")}
                onClick={() => navigate("/files")}
              />
              <NavRow
                icon={<FlaskConical size={16} strokeWidth={1.5} />}
                label={t("items.runs")}
                onClick={() => navigate("/runs")}
              />
              <NavRow
                icon={<Files size={16} strokeWidth={1.5} />}
                label={t("items.skills")}
                onClick={() => navigate("/skills")}
              />
            </>
          )}
        </nav>

        <div className="mt-2 flex-1 overflow-y-auto px-3 pb-2">
          <>
          <div className="flex items-center gap-1 px-0.5 py-1">
            <button
              onClick={() => navigate("/projects")}
              title={t("projects.seeAll")}
              className={cn(
                "group/head flex min-w-0 flex-1 items-center gap-1.5 rounded-input px-1.5 py-1 text-[13px] font-semibold outline-none hover:bg-surface-2",
                location.pathname === "/projects" ? "text-text" : "text-muted hover:text-text",
              )}
            >
              <span className="flex-1 truncate text-left">{t("projects.heading")}</span>
              <ChevronRight size={13} strokeWidth={1.5} className="shrink-0 opacity-60 transition-transform group-hover/head:translate-x-0.5" />
            </button>
            {/* Creating/importing a project needs local FS access — hidden in web. */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  aria-label={t("projects.new")}
                  title={t("projects.new")}
                  className={cn(
                    "rounded p-0.5 text-muted outline-none hover:bg-surface-2 hover:text-text",
                    isGatewayWeb && "hidden",
                  )}
                >
                  <Plus size={13} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="z-50 min-w-[210px] rounded-card border border-border bg-surface p-1 text-[13px] text-text shadow-pop"
                >
                  <DropdownMenu.Item
                    onSelect={() => setNamingProject(true)}
                    className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
                  >
                    <Plus size={14} className="shrink-0 text-muted" />
                    <span className="truncate">{t("projects.menuScratch")}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onSelect={() => void handleImport()}
                    className="flex cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
                  >
                    <FolderInput size={14} className="shrink-0 text-muted" />
                    <span className="truncate">{t("projects.menuExisting")}</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          {namingProject && (
            <NameProjectDialog
              defaultName={t("projects.new")}
              title={t("projects.nameTitle")}
              subtitle={t("projects.nameSubtitle")}
              placeholder={t("projects.namePlaceholder")}
              busy={createBusy}
              onSave={(v) => void submitNewProject(v)}
              onCancel={() => {
                if (!createBusy) setNamingProject(false);
              }}
            />
          )}
          {pendingImportPath && (
            <ImportProjectDialog
              path={pendingImportPath}
              busy={importBusy}
              onImport={(mode) => void submitImport(mode)}
              onCancel={() => {
                if (!importBusy) setPendingImportPath(null);
              }}
            />
          )}
          {projects.length === 0 && !namingProject && (
            <button
              onClick={() => setNamingProject(true)}
              className="flex w-full items-center gap-2 rounded-input px-2 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-text"
            >
              <Folder size={14} className="shrink-0" />
              <span className="truncate">{t("projects.new")}</span>
            </button>
          )}
          {visibleProjects.map((p) => {
            const open = !collapsedProjects.includes(p.id);
            const active = samePath(p.path, workspace);
            const rows = sessionsByProject.get(p.id) ?? [];
            const color = projectColor(p);
            return (
              <div key={p.id}>
                {renamingId === p.id ? (
                  <div className="py-0.5 pl-5 pr-1">
                    <InlineNameInput
                      defaultValue={p.name}
                      placeholder={t("projects.namePlaceholder")}
                      onSubmit={(v) => void submitRename(p, v)}
                      onCancel={() => setRenamingId(null)}
                    />
                  </div>
                ) : (
                  <ContextMenu
                    label={t("rowMenu.projectLabel")}
                    items={
                      <>
                        <ContextMenuItem
                          icon={<Plus size={14} />}
                          disabled={webReadOnly}
                          onSelect={() => void newSessionIn(p)}
                        >
                          {t("projects.newSession")}
                        </ContextMenuItem>
                        <ContextMenuItem
                          icon={<Pencil size={14} />}
                          onSelect={() => requestAnimationFrame(() => setRenamingId(p.id))}
                        >
                          {t("projects.rename")}
                        </ContextMenuItem>
                        <ContextMenuItem
                          icon={<FolderOpen size={14} />}
                          disabled={isGatewayWeb}
                          onSelect={() => void openProjectFolder(p.id)}
                        >
                          {t("projects.openFolderLabel")}
                        </ContextMenuItem>
                        <ContextMenuItem
                          icon={<Pin size={14} />}
                          onSelect={() => void setProjectPinned(p.id, !p.pinned)}
                        >
                          {p.pinned ? t("projects.unpin") : t("projects.pin")}
                        </ContextMenuItem>
                        <ContextMenuSub icon={<Palette size={14} />} label={t("projects.color")}>
                          {Object.entries(PROJECT_COLORS).map(([key, hex]) => (
                            <ContextMenuItem key={key} onSelect={() => void setProjectColor(p.id, key)}>
                              <span className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 rounded-full" style={{ background: hex }} />
                                {colorName(key)}
                              </span>
                            </ContextMenuItem>
                          ))}
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => void setProjectColor(p.id, null)}>
                            {t("projects.colorNone")}
                          </ContextMenuItem>
                        </ContextMenuSub>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          icon={<Trash2 size={14} />}
                          danger
                          onSelect={() => setPendingRemoveProject(p)}
                        >
                          {t("projects.remove")}
                        </ContextMenuItem>
                      </>
                    }
                  >
                  <div className="group/project relative">
                    <button
                      onClick={() => toggleProject(p.id)}
                      aria-expanded={open}
                      className="flex w-full items-center gap-1.5 rounded-input py-1 pl-1 pr-10 text-[13px] text-text hover:bg-surface-2"
                    >
                      <ChevronRight
                        size={11}
                        className={cn(
                          "shrink-0 text-muted transition-transform duration-150",
                          open && "rotate-90",
                        )}
                      />
                      {open ? (
                        <FolderOpen
                          size={14}
                          style={color ? { color } : undefined}
                          className={cn(
                            "shrink-0",
                            !color && (active ? "text-accent" : "text-muted"),
                          )}
                        />
                      ) : (
                        <Folder
                          size={14}
                          style={color ? { color } : undefined}
                          className={cn(
                            "shrink-0",
                            !color && (active ? "text-accent" : "text-muted"),
                          )}
                        />
                      )}
                      <span
                        className="min-w-0 flex-1 truncate text-left font-medium"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenamingId(p.id);
                        }}
                        title={p.imported ? (p.importedFrom ?? p.path) : t("projects.renameHint")}
                      >
                        {p.name}
                      </span>
                      {p.imported && (
                        <span
                          className="shrink-0 rounded bg-surface-2 px-1 text-[9px] uppercase tracking-wide text-muted"
                          title={p.importedFrom ?? p.path}
                        >
                          {t("projects.importedBadge")}
                        </span>
                      )}
                    </button>
                    <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
                      {rows.length > 0 && (
                        <span className="px-1 text-[10px] tabular-nums text-muted group-hover/project:hidden">
                          {rows.length}
                        </span>
                      )}
                      {!webReadOnly && (
                        <button
                          onClick={() => void newSessionIn(p)}
                          aria-label={t("projects.newSessionAria", {
                            name: p.name,
                          })}
                          title={t("projects.newSessionAria", { name: p.name })}
                          className="hidden rounded p-1 text-muted hover:bg-border hover:text-text group-hover/project:block"
                        >
                          <Plus size={13} />
                        </button>
                      )}
                      {!webReadOnly && (
                        <button
                          onClick={() => void setProjectPinned(p.id, !p.pinned)}
                          aria-label={p.pinned ? t("projects.unpin") : t("projects.pin")}
                          title={p.pinned ? t("projects.unpin") : t("projects.pin")}
                          className={cn(
                            "rounded p-1 hover:bg-border hover:text-text",
                            p.pinned
                              ? "text-accent"
                              : "hidden text-muted group-hover/project:block",
                          )}
                        >
                          <Pin size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  </ContextMenu>
                )}
                <div
                  className={cn(
                    "grid transition-[grid-template-rows] duration-200 ease-out",
                    open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                  )}
                >
                  <div className="overflow-hidden">
                    <div className="mb-0.5 ml-[15px] border-l border-border-faint pl-1.5">
                      {rows.length === 0 && (
                        <div className="px-2 py-1 text-xs text-muted">
                          {t("projects.noSessions")}
                        </div>
                      )}
                      {rows.slice(0, ROW_LIMIT).map(sessionRow)}
                      {rows.length > ROW_LIMIT && (
                        <MoreRow
                          count={rows.length - ROW_LIMIT}
                          label={t("history.seeAll")}
                          onClick={() => navigate("/history")}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {hiddenProjectCount > 0 && (
            <button
              onClick={() => navigate("/projects")}
              className="flex w-full items-center gap-2 rounded-input px-2 py-1 pl-6 text-[13px] text-muted hover:bg-surface-2 hover:text-text"
            >
              <span className="truncate">{t("projects.seeAll")}</span>
              <span className="text-[10px] tabular-nums text-muted">+{hiddenProjectCount}</span>
            </button>
          )}
          </>
          <div className="mt-3 flex items-center gap-1 px-0.5 py-1">
            {/* Every conversation ever, searchable — clicking "会话 >" opens the
                full history (#65), matching how the Projects heading works. */}
            <button
              onClick={() => navigate("/history")}
              title={t("history.seeAll")}
              className={cn(
                "group/head flex min-w-0 flex-1 items-center gap-1.5 rounded-input px-1.5 py-1 text-[13px] font-semibold outline-none hover:bg-surface-2",
                location.pathname === "/history" ? "text-text" : "text-muted hover:text-text",
              )}
            >
              <span className="flex-1 truncate text-left">{t("history.heading")}</span>
              <ChevronRight size={13} strokeWidth={1.5} className="shrink-0 opacity-60 transition-transform group-hover/head:translate-x-0.5" />
            </button>
            {/* Same footprint as the Projects row's "+" so the ">" chevron sits in
                the exact same column as the Projects ">". */}
            <span aria-hidden className="w-[17px] shrink-0" />
          </div>
          {looseRows.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted">
              {t("history.empty")}
            </div>
          )}
          {looseRows.slice(0, ROW_LIMIT).map(sessionRow)}
          {looseRows.length > ROW_LIMIT && (
            <MoreRow
              count={looseRows.length - ROW_LIMIT}
              label={t("history.seeAll")}
              onClick={() => navigate("/history")}
            />
          )}
        </div>

        <div className="flex items-center gap-1 border-t border-border px-2 py-2">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 rounded-input px-2 py-1 text-[13px] text-muted hover:bg-surface-2 hover:text-text"
            onClick={() => navigate("/settings")}
            aria-label={t("sidebar.settings")}
          >
            <Settings size={15} strokeWidth={1.5} />
            <span className="truncate">{t("sidebar.settings")}</span>
          </button>
          <StatusPills />
        </div>
        </>
        )}

        {pendingRemoveProject && (
          <ConfirmDialog
            title={t("projects.removeTitle", { name: pendingRemoveProject.name })}
            body={t(
              pendingRemoveProject.importMode === "copy"
                ? "projects.removeCopyBody"
                : "projects.removeBody",
            )}
            confirmLabel={t("projects.remove")}
            onConfirm={() => {
              void deleteProject(pendingRemoveProject.id);
              setPendingRemoveProject(null);
            }}
            onCancel={() => setPendingRemoveProject(null)}
          />
        )}

        {pendingDelete && (
          <ConfirmDialog
            title={t("confirmDelete.sessionTitle")}
            body={t("confirmDelete.sessionBody", { title: pendingDelete.title })}
            confirmLabel={t("confirmDelete.deleteAction")}
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />
        )}
      </aside>

      {/* Drag divider: resize within [SIDEBAR_MIN, SIDEBAR_MAX]; dragging far
          left snaps the sidebar closed. Kept mounted while collapsed so an
          in-flight drag (pointer capture) can re-open it. */}
      <div
        {...handleProps}
        className={cn(
          "group absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize",
          sidebarCollapsed && !dragging && "pointer-events-none",
        )}
      >
        <div
          className={cn(
            "absolute inset-y-0 right-0 w-[2px] transition-colors",
            dragging
              ? "bg-accent/60"
              : "bg-transparent group-hover:bg-accent/40",
          )}
        />
      </div>
    </div>
  );
}

function ImportProjectDialog({
  path,
  busy,
  onImport,
  onCancel,
}: {
  path: string;
  busy: boolean;
  onImport: (mode: ProjectImportMode) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["nav", "common"]);
  const pathParts = path.split(/[\\/]/).filter(Boolean);
  const name = pathParts[pathParts.length - 1] ?? path;
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={() => !busy && onCancel()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={t("nav:projects.importTitle")}
        className="w-[520px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-text">{t("nav:projects.importTitle")}</div>
        <p className="mt-1 text-sm text-muted">
          {t("nav:projects.importSubtitle", { name })}
        </p>
        <div className="mt-4 grid gap-2">
          <button
            autoFocus
            disabled={busy}
            onClick={() => onImport("in-place")}
            className="rounded-card border border-accent bg-surface-2 p-3 text-left hover:bg-surface disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-text">
              {t("nav:projects.importInPlace")}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">
              {t("nav:projects.importInPlaceHint")}
            </span>
          </button>
          <button
            disabled={busy}
            onClick={() => onImport("copy")}
            className="rounded-card border border-border p-3 text-left hover:bg-surface-2 disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-text">
              {t("nav:projects.importCopy")}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">
              {t("nav:projects.importCopyHint")}
            </span>
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            disabled={busy}
            onClick={onCancel}
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:opacity-50"
          >
            {t("common:actions.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "+N · All sessions" tail of a truncated session list. */
function MoreRow({
  count,
  label,
  onClick,
}: {
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-input py-1 pl-2 pr-2 text-[13px] text-muted hover:bg-surface-2 hover:text-text"
    >
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 text-[10px] tabular-nums">+{count}</span>
    </button>
  );
}

function NavRow({
  icon,
  label,
  onClick,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex items-center gap-2 rounded-input px-2 py-1 text-[13px] font-semibold text-text hover:bg-surface-2",
        className,
      )}
    >
      <span className="text-muted transition-colors group-hover:text-accent">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/** One-line name editor used for "new project" and rename: Enter submits,
 *  Escape or clicking away cancels — no dialog, the row edits in place. */
function InlineNameInput({
  defaultValue = "",
  placeholder,
  busy = false,
  onSubmit,
  onCancel,
}: {
  defaultValue?: string;
  placeholder?: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={busy}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(e.currentTarget.value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={() => {
        if (!busy) onCancel();
      }}
      className={cn(
        "w-full min-w-0 rounded-input border border-accent/50 bg-surface px-2 py-[3px] text-[13px] text-text outline-none placeholder:text-muted focus:border-accent",
        busy && "animate-pulse opacity-60",
      )}
    />
  );
}

/** Modal for naming a new (from-scratch) project: a focused, pre-selected input
 *  with Save/Cancel. Used instead of an inline row so "New project" reads as a
 *  deliberate step (matching the from-scratch / existing-folder menu split). */
function NameProjectDialog({
  defaultName,
  title,
  subtitle,
  placeholder,
  busy,
  onSave,
  onCancel,
}: {
  defaultName: string;
  title: string;
  subtitle: string;
  placeholder?: string;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = () => {
    const v = ref.current?.value ?? "";
    if (v.trim() && !busy) onSave(v);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={() => !busy && onCancel()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-[420px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-text">{title}</div>
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
        <input
          ref={ref}
          defaultValue={defaultName}
          placeholder={placeholder}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape") onCancel();
          }}
          className={cn(
            "mt-4 w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent",
            busy && "animate-pulse opacity-60",
          )}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-input border border-border px-3 py-1.5 text-sm text-text hover:bg-surface-2 disabled:opacity-50"
            onClick={onCancel}
            disabled={busy}
          >
            {t("actions.cancel")}
          </button>
          <button
            className="rounded-input bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            onClick={save}
            disabled={busy}
          >
            {t("actions.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
