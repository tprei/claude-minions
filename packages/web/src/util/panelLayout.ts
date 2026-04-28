import { useCallback, useEffect, useState } from "react";

export interface PanelLayout {
  size: number;
  collapsed: boolean;
}

export type Breakpoint = "desktop" | "mobile";

export const PANEL_TRANSCRIPT = "transcript";
export const PANEL_DAG_CANVAS = "dag-canvas";
export const PANEL_RESOURCE = "resource";

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

export interface UsePanelLayoutOptions {
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
}

export interface UsePanelLayoutResult {
  size: number;
  collapsed: boolean;
  breakpoint: Breakpoint;
  setSize: (next: number | ((prev: number) => number)) => void;
  setCollapsed: (next: boolean | ((prev: boolean) => boolean)) => void;
  toggleCollapsed: () => void;
}

function clampSize(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function usePanelLayout(panel: string, opts: UsePanelLayoutOptions): UsePanelLayoutResult {
  const min = opts.minSize ?? 120;
  const max = opts.maxSize ?? 1200;

  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() => getBreakpoint());
  const [size, setSizeState] = useState<number>(() => {
    const stored = getLayout(panel);
    return clampSize(stored?.size ?? opts.defaultSize, min, max);
  });
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    const stored = getLayout(panel);
    return stored?.collapsed ?? false;
  });

  useEffect(() => {
    return subscribe((bp) => {
      setBreakpoint(bp);
      const stored = getLayout(panel);
      setSizeState(clampSize(stored?.size ?? opts.defaultSize, min, max));
      setCollapsedState(stored?.collapsed ?? false);
    });
  }, [panel, opts.defaultSize, min, max]);

  const setSize = useCallback(
    (next: number | ((prev: number) => number)) => {
      setSizeState((prev) => {
        const raw = typeof next === "function" ? next(prev) : next;
        const value = clampSize(raw, min, max);
        setLayout(panel, { size: value, collapsed: getLayout(panel)?.collapsed ?? false });
        return value;
      });
    },
    [panel, min, max],
  );

  const setCollapsed = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setCollapsedState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        const stored = getLayout(panel);
        setLayout(panel, {
          size: stored?.size ?? opts.defaultSize,
          collapsed: value,
        });
        return value;
      });
    },
    [panel, opts.defaultSize],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, [setCollapsed]);

  return { size, collapsed, breakpoint, setSize, setCollapsed, toggleCollapsed };
}
