import { useState, useCallback, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { cx } from "../util/classnames.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { Sheet } from "../components/Sheet.js";
import { parseUrl } from "../routing/parseUrl.js";

const MOBILE_QUERY = "(max-width: 767px)";

const CHAT_RAIL_PANEL = "chat-rail";
const RAIL_STORAGE_KEY = `panelLayout:${CHAT_RAIL_PANEL}`;
const RAIL_DEFAULT_WIDTH = 240;
const RAIL_MIN_WIDTH = 60;
const CHAT_MIN_WIDTH = 160;

function loadRailWidth(): number {
  if (typeof window === "undefined") return RAIL_DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(RAIL_STORAGE_KEY);
  if (!raw) return RAIL_DEFAULT_WIDTH;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return RAIL_DEFAULT_WIDTH;
  return Math.max(RAIL_MIN_WIDTH, n);
}

function saveRailWidth(width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RAIL_STORAGE_KEY, String(width));
  } catch {
    /* storage unavailable */
  }
}

interface SidebarApi {
  closeMobile: () => void;
}

interface LayoutProps {
  header: ReactNode;
  sidebar: (api: SidebarApi) => ReactNode;
  main: ReactNode;
  chatSurface?: ReactNode;
  isSessionOpen?: boolean;
}

export function AppLayout({ header, sidebar, main, chatSurface, isSessionOpen = false }: LayoutProps): ReactElement {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    return !window.matchMedia(MOBILE_QUERY).matches;
  });
  const [railWidth, setRailWidth] = useState<number>(() => loadRailWidth());
  const mainRef = useRef<HTMLElement | null>(null);
  const [mainWidth, setMainWidth] = useState<number>(0);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setMainWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const railMax =
    mainWidth > 0
      ? Math.max(RAIL_MIN_WIDTH, mainWidth - CHAT_MIN_WIDTH)
      : Number.POSITIVE_INFINITY;
  const displayedRailWidth = Math.max(RAIL_MIN_WIDTH, Math.min(railMax, railWidth));

  const closeMobile = (): void => {
    if (isMobile) setSidebarOpen(false);
  };

  const handleRailDrag = useCallback((delta: number) => {
    setRailWidth((w) => {
      const next = Math.max(RAIL_MIN_WIDTH, Math.min(railMax, w + delta));
      saveRailWidth(next);
      return next;
    });
  }, [railMax]);

  const sidebarNode = sidebar({ closeMobile });
  const view = parseUrl().view;
  const chatPrimary = Boolean(chatSurface) && isSessionOpen && view !== "dag";

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <div className="flex-shrink-0 h-12 border-b border-border flex items-center relative z-50 bg-bg">
        <button
          onClick={() => setSidebarOpen(v => !v)}
          className="w-12 h-12 flex items-center justify-center text-fg-subtle hover:text-fg transition-colors flex-shrink-0"
          aria-label="Toggle sidebar"
          aria-expanded={sidebarOpen}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">{header}</div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && (
          <aside
            className={cx(
              "flex-shrink-0 border-r border-border bg-bg-soft transition-all duration-200 overflow-hidden",
              sidebarOpen ? "w-56" : "w-0",
            )}
          >
            <div className="w-56 h-full overflow-y-auto">{sidebarNode}</div>
          </aside>
        )}

        <main ref={mainRef} className="flex-1 min-w-0 overflow-hidden flex flex-row">
          {chatPrimary ? (
            isMobile ? (
              <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
                {chatSurface}
              </div>
            ) : (
              <>
                <div
                  data-testid="chat-rail"
                  className="flex-shrink-0 overflow-y-auto bg-bg"
                  style={{ width: displayedRailWidth }}
                >
                  {main}
                </div>
                <ResizeHandle onDrag={handleRailDrag} />
                <div data-testid="chat-primary" className="flex-1 min-w-0 overflow-hidden flex flex-col">
                  {chatSurface}
                </div>
              </>
            )
          ) : (
            <div className="flex-1 min-w-0 overflow-y-auto">{main}</div>
          )}
        </main>
      </div>

      {isMobile && (
        <Sheet
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          side="left"
        >
          <div data-testid="mobile-sidebar" className="-m-4">
            {sidebarNode}
          </div>
        </Sheet>
      )}
    </div>
  );
}
