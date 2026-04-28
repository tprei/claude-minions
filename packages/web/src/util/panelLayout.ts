// TODO(T33): add unit tests once a web-side test runner is wired up.

export interface PanelLayout {
  size: number;
  collapsed: boolean;
}

export type Breakpoint = "desktop" | "mobile";

const DESKTOP_QUERY = "(min-width: 768px)";

let cachedBreakpoint: Breakpoint | null = null;
let mediaQueryList: MediaQueryList | null = null;
const listeners = new Set<(bp: Breakpoint) => void>();

function detect(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  if (!mediaQueryList) {
    mediaQueryList = window.matchMedia(DESKTOP_QUERY);
    mediaQueryList.addEventListener("change", onMediaChange);
  }
  return mediaQueryList.matches ? "desktop" : "mobile";
}

function onMediaChange(e: MediaQueryListEvent): void {
  const next: Breakpoint = e.matches ? "desktop" : "mobile";
  if (next === cachedBreakpoint) return;
  cachedBreakpoint = next;
  for (const listener of listeners) listener(next);
}

export function getBreakpoint(): Breakpoint {
  if (cachedBreakpoint) return cachedBreakpoint;
  cachedBreakpoint = detect();
  return cachedBreakpoint;
}

function storageKey(panel: string, bp: Breakpoint): string {
  return `panel:${panel}:${bp}`;
}

export function getLayout(panel: string): PanelLayout | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(panel, getBreakpoint()));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { size?: unknown }).size === "number" &&
      typeof (parsed as { collapsed?: unknown }).collapsed === "boolean"
    ) {
      const { size, collapsed } = parsed as PanelLayout;
      return { size, collapsed };
    }
    return null;
  } catch {
    return null;
  }
}

export function setLayout(panel: string, layout: PanelLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(panel, getBreakpoint()),
      JSON.stringify({ size: layout.size, collapsed: layout.collapsed }),
    );
  } catch {
    /* localStorage unavailable / quota — ignore */
  }
}

export function subscribe(listener: (bp: Breakpoint) => void): () => void {
  if (typeof window !== "undefined") {
    detect();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
