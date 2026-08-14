import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type UIEvent } from "react";

/** Scroll offsets by pane key, kept for the app's lifetime — switching
 *  sessions or files comes back to where the user left off. Lives outside the
 *  store so scroll events never trigger React renders. */
const offsets = new Map<string, number>();

/** Chat keys the reader LEFT at the latest messages (they jumped to the bottom
 *  or read to the end). On reopen such a session re-snaps to the CURRENT
 *  bottom — the remembered number can go stale when the conversation grows
 *  while the user is away. */
const atBottomKeys = new Set<string>();

/** Re-key a stored offset (a draft's chat scroll follows the session id it
 *  becomes — the page must not jump on the first message). */
export function moveScrollMemory(from: string, to: string): void {
  const v = offsets.get(from);
  if (v !== undefined) {
    offsets.set(to, v);
    offsets.delete(from);
  }
  if (atBottomKeys.has(from)) {
    atBottomKeys.add(to);
    atBottomKeys.delete(from);
  }
}

/** Test seam / explicit reset. */
export function clearScrollMemory(): void {
  offsets.clear();
  atBottomKeys.clear();
}

/**
 * Remember and restore a container's scrollTop under `key`. Attach the
 * returned handler as `onScroll`; pass `ready=false` until the content is
 * loaded (restoring against an empty container would clamp to 0). Restores
 * once per key+ready settle, so live content updates never yank the scroll.
 * While not ready nothing is recorded either — swapping in a loading
 * placeholder shrinks the container, and the browser's clamped scroll event
 * would overwrite the real offset with a bogus one.
 */
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string,
  ready = true,
  initial: "top" | "bottom" = "top",
): (e: UIEvent<HTMLElement>) => void {
  useLayoutEffect(() => {
    if (!ready || !ref.current) return;
    ref.current.scrollTop = offsets.get(key) ?? (initial === "bottom" ? ref.current.scrollHeight : 0);
  }, [ref, key, ready, initial]);
  return (e) => {
    if (ready) offsets.set(key, e.currentTarget.scrollTop);
  };
}

/** A small tolerance avoids flashing the control for sub-pixel layout changes
 * or a final short streaming update while the user is already at the bottom. */
export const CHAT_BOTTOM_THRESHOLD = 80;

export function isNearBottom(el: HTMLElement, threshold = CHAT_BOTTOM_THRESHOLD): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * Chat-specific scroll behavior:
 * - a session with no remembered offset opens at the latest messages;
 * - content growth follows only while the reader is already near the bottom;
 * - scrolling up disables following until they explicitly jump back.
 */
export function useChatScroll(
  ref: RefObject<HTMLElement | null>,
  key: string,
  ready = true,
): {
  contentRef: RefObject<HTMLDivElement>;
  onScroll: (e: UIEvent<HTMLElement>) => void;
  atLatest: boolean;
  jumpToLatest: () => void;
} {
  const contentRef = useRef<HTMLDivElement>(null);
  const remember = useScrollMemory(ref, key, ready, "bottom");
  const following = useRef(true);
  const [atLatest, setAtLatest] = useState(true);

  const update = (el: HTMLElement) => {
    const latest = isNearBottom(el);
    following.current = latest;
    if (latest) atBottomKeys.add(key);
    else atBottomKeys.delete(key);
    setAtLatest((current) => (current === latest ? current : latest));
  };

  const onScroll = (e: UIEvent<HTMLElement>) => {
    remember(e);
    update(e.currentTarget);
  };

  // Runs after useScrollMemory's layout effect restored the saved/default
  // position, so the control starts in the correct visible state. A chat the
  // reader left at the latest re-snaps to the CURRENT bottom instead of a
  // stale remembered number (the conversation may have grown meanwhile).
  useLayoutEffect(() => {
    if (ready && ref.current) {
      if (atBottomKeys.has(key)) {
        const el = ref.current;
        el.scrollTop = el.scrollHeight;
        offsets.set(key, el.scrollTop);
        following.current = true;
        setAtLatest(true);
      } else {
        update(ref.current);
      }
    }
    // `update` intentionally stays local: key/ready are the restore boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, key, ready]);

  // Markdown and tool output can grow without a parent scroll event. Keep a
  // bottom-pinned reader pinned, but never move somebody reading older turns.
  useEffect(() => {
    const scroller = ref.current;
    const content = contentRef.current;
    if (!ready || !scroller || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!following.current) return;
      scroller.scrollTop = scroller.scrollHeight;
      offsets.set(key, scroller.scrollTop);
      atBottomKeys.add(key);
      setAtLatest(true);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [ref, key, ready]);

  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    following.current = true;
    atBottomKeys.add(key);
    el.scrollTop = el.scrollHeight;
    offsets.set(key, el.scrollTop);
    setAtLatest(true);
  };

  return { contentRef, onScroll, atLatest, jumpToLatest };
}
