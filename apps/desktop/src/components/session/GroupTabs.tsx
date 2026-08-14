import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Pencil, Plus, X, PanelLeft } from "lucide-react";
import { groupLabel, isDetachedScreen, leaves, useLayoutStore, type PaneNode } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { useOverlayTitlebar, useUiStore } from "@/lib/store";
import { isTauri } from "@/lib/tauri";
import { overlayTitlebarStyle } from "@/lib/titlebar";
import { cn } from "@/lib/cn";
import { ContextMenu, ContextMenuItem } from "@/components/ui/ContextMenu";

/** How far a screen tab must move before a detach-drag is considered real. */
const TAB_DETACH_THRESHOLD = 6;
/** A drag at least this far (even inside the window) reads as "take this tab
 *  out" — the reliable fallback when no leave signal is delivered. */
const TAB_DETACH_DISTANCE = 90;

/**
 * Arm a "drag the screen tab OUT of the window" detach gesture from a
 * pointer-down on a tab. The drag becomes real past a small threshold (so a
 * plain click still switches screens); it then detaches the screen into its
 * own window when any of these fire:
 *   - pointer capture reports the pointer OUTSIDE the window bounds (the
 *     reliable signal — capture keeps delivering moves past the window edge),
 *   - the window blurs or the document hides (belt-and-suspenders), or
 *   - the drag travels TAB_DETACH_DISTANCE (a big in-window drag still reads
 *     as "take it out"; releasing inside a short drag is a no-op).
 * Pointer-based with window-level listeners (see dragPane.ts).
 */
function startTabDetachDrag(
  e: React.PointerEvent,
  el: HTMLElement,
  onDetach: () => void,
): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let outside = false;
  let pointerId: number | null = null;
  try {
    el.setPointerCapture(e.pointerId);
    pointerId = e.pointerId;
  } catch {
    /* capture unavailable — coordinate detection just won't run */
  }
  const teardown = () => {
    if (pointerId !== null) {
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    document.documentElement.removeEventListener("mouseleave", onLeave);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  const detach = () => {
    teardown();
    onDetach();
  };
  const onMove = (ev: PointerEvent) => {
    const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
    if (!dragging) {
      if (dist < TAB_DETACH_THRESHOLD) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }
    // Pointer capture keeps delivering moves even past the window edge —
    // coordinates outside the window bounds mean the tab was dragged OUT.
    if (
      ev.clientX < 0 ||
      ev.clientY < 0 ||
      ev.clientX > window.innerWidth ||
      ev.clientY > window.innerHeight
    ) {
      outside = true;
      detach();
      return;
    }
    if (dist >= TAB_DETACH_DISTANCE) outside = true;
  };
  const onUp = () => {
    teardown();
    if (dragging && outside) onDetach();
  };
  const onCancel = () => teardown();
  const onBlur = () => {
    if (dragging) detach();
  };
  const onVisibility = () => {
    if (document.hidden && dragging) detach();
  };
  const onLeave = () => {
    if (dragging) detach();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);
  document.documentElement.addEventListener("mouseleave", onLeave);
}

/**
 * Horizontal group/"screen" tab strip at the very top of the live surface —
 * each tab is one independent pane layout (browser/iTerm style). As the
 * top-most element it owns the macOS overlay-titlebar clearance (traffic-light
 * inset + window-drag region), so no pane below needs to.
 */
export function GroupTabs() {
  const { t } = useTranslation(["session", "nav"]);
  const groups = useLayoutStore((s) => s.groups);
  const activeGroupId = useLayoutStore((s) => s.activeGroupId);
  const ephemeralGroupId = useLayoutStore((s) => s.ephemeralGroupId);
  const setActiveGroup = useLayoutStore((s) => s.setActiveGroup);
  const addGroup = useLayoutStore((s) => s.addGroup);
  const closeGroup = useLayoutStore((s) => s.closeGroup);
  const detachGroup = useLayoutStore((s) => s.detachGroup);
  const renameGroup = useLayoutStore((s) => s.renameGroup);

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const overlayTitlebar = useOverlayTitlebar();
  const isMac = navigator.userAgent.includes("Mac");

  // Dragging the tab strip's empty space (between/around tabs) moves the
  // window. Under the macOS overlay titlebar this strip IS the titlebar, but
  // tabs are detach handles (not window-drag surfaces) and the two spacers are
  // the only native drag regions — so the leftover gaps need JS-started
  // dragging or the row reads as un-draggable chrome.
  const onStripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !overlayTitlebar || !isTauri) return;
    const target = e.target as HTMLElement;
    if (
      target.closest("[data-group-tab]") ||
      target.closest("button") ||
      target.closest("[data-tauri-drag-region]")
    )
      return;
    e.preventDefault();
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().startDragging();
      } catch {
        /* a drag failure is non-fatal */
      }
    })();
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const fallback = (n: number) => t("group.defaultName", { n });

  return (
    <>
      <div
        onPointerDown={onStripPointerDown}
        data-tauri-drag-region={overlayTitlebar || undefined}
        className={cn(
          // `select-none`: right-clicking a tab used to select its name.
          "flex shrink-0 select-none items-center gap-1 border-b border-faint px-1",
          !overlayTitlebar && "h-9",
        )}
      >
        {/* Left titlebar drag area (macOS traffic-light clearance). Tabs are their
            own drag surface — drag one OUT to detach it into its own window — so
            window moving lives here and in the right spacer, not over the tabs. */}
        <div
          data-tauri-drag-region={overlayTitlebar || undefined}
          style={overlayTitlebar ? overlayTitlebarStyle(sidebarCollapsed) : undefined}
          aria-hidden
          className={cn("shrink-0 self-stretch", !overlayTitlebar && "hidden")}
        />
        {/* Sidebar expand button: only when collapsed, and it lives here since this
            strip has taken over the top row (traffic-light clearance included). */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            aria-label={t("nav:sidebar.expand")}
            title={t("nav:sidebar.expandTitle", { shortcut: isMac ? "⌘B" : "Ctrl+B" })}
            className="fade-in mr-0.5 rounded p-1 text-text hover:bg-surface-2"
          >
            <PanelLeft size={14} strokeWidth={1.5} />
          </button>
        )}
        {/* This row is `flex-1`, so it covers the whole width left of the edge —
            the empty space beside the tabs included. A bare drag region applies
            to DIRECT clicks only (Tauri walks the composed path and requires
            `el === target`), so without the attribute here the only draggable
            part of the header was the hairline above and below this row. Tabs
            and the + button stay undraggable: a tab is never the drag element
            itself, and Tauri treats <button> as clickable, which blocks drag. */}
        <div
          data-tauri-drag-region={overlayTitlebar || undefined}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {groups.map((g, i) => {
            const active = g.id === activeGroupId;
            const ephemeral = g.id === ephemeralGroupId;
            return (
              <ContextMenu
                key={g.id}
                label={t("group.tabMenu")}
                items={
                  <>
                    <ContextMenuItem
                      icon={<Pencil size={14} />}
                      onSelect={() => requestAnimationFrame(() => setEditingId(g.id))}
                    >
                      {t("group.rename")}
                    </ContextMenuItem>
                    {/* Detach into its own window — the guaranteed path if the
                        drag-out gesture is inconvenient (e.g. touch). */}
                    {!isDetachedScreen && (
                      <ContextMenuItem
                        icon={<ExternalLink size={14} />}
                        onSelect={() => void detachGroup(g.id, detachScreenTitle(g))}
                      >
                        {t("group.moveToWindow")}
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem
                      icon={<X size={14} />}
                      danger
                      onSelect={() => closeGroup(g.id)}
                    >
                      {t("group.close")}
                    </ContextMenuItem>
                  </>
                }
              >
              <div
                // Dock-drag target: hovering this tab mid-drag switches screens (#4).
                data-group-tab={g.id}
                onClick={() => setActiveGroup(g.id)}
                onDoubleClick={() => setEditingId(g.id)}
                onPointerDown={(e) => {
                  // Drag the tab OUT of the window to detach it into its own
                  // window (disabled in an already-detached window). Renaming
                  // and the close button don't arm the gesture.
                  if (isDetachedScreen || editingId === g.id) return;
                  if ((e.target as HTMLElement).closest("button")) return;
                  startTabDetachDrag(e, e.currentTarget, () => {
                    void detachGroup(g.id, detachScreenTitle(g));
                  });
                }}
                className={cn(
                  "group/tab flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors",
                  active ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60",
                  // A tentative (preview) screen reads italic, like a browser preview tab.
                  ephemeral && "italic",
                )}
                title={t("group.renameHint")}
              >
                {editingId === g.id ? (
                  <TabNameInput
                    initial={g.name}
                    placeholder={fallback(i + 1)}
                    onCommit={(name) => {
                      renameGroup(g.id, name);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <span className="max-w-[160px] truncate font-semibold">{groupLabel(g, i, fallback)}</span>
                )}
                {/* Close is always available — closing the last group empties it. */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeGroup(g.id);
                  }}
                  aria-label={t("group.close")}
                  className={cn(
                    "-mr-1 rounded p-0.5 text-muted hover:bg-border hover:text-text",
                    active ? "opacity-70" : "opacity-0 group-hover/tab:opacity-70",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
              </ContextMenu>
            );
          })}
          <button
            onClick={() => addGroup()}
            aria-label={t("group.newTab")}
            title={t("group.newTab")}
            className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"
          >
            <Plus size={14} strokeWidth={1.5} />
          </button>
        </div>
        {/* Right titlebar drag area — keeps the window movable even when the
            strip holds a single (detached) tab and most of it is empty. */}
        <div
          data-tauri-drag-region={overlayTitlebar || undefined}
          aria-hidden
          className="w-8 shrink-0 self-stretch"
        />
      </div>
    </>
  );
}

/** The window title for a detached screen: the focused session's title, else
 *  the screen's name, else the generic label. */
function detachScreenTitle(g: { name: string; tree: PaneNode | null }): string {
  const leaf = g.tree ? leaves(g.tree).find((l) => l.sessionId) : undefined;
  const sid = leaf?.sessionId;
  const title = sid ? useRuntimeStore.getState().sessions.find((s) => s.id === sid)?.title : undefined;
  return title || g.name || "Screen";
}

/** Inline rename field for a group tab; commits on Enter/blur, cancels on Esc. */
function TabNameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      className="h-5 w-28 rounded border border-border bg-surface px-1 text-[12px] text-text outline-none"
    />
  );
}
