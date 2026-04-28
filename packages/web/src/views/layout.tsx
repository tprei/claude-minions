import { useState, useEffect, useCallback, type ReactElement, type ReactNode } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { Sheet } from "../components/Sheet.js";
import { ResizeHandle } from "../components/ResizeHandle.js";
import { getLayout, setLayout, subscribe, type PanelLayout } from "../util/panelLayout.js";

const MOBILE_QUERY = "(max-width: 767px)";
const SIDEBAR_PANEL = "sidebar";
const SIDEBAR_DEFAULT_SIZE = 224;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 360;
const SIDEBAR_COLLAPSED_W = 36;

const DESKTOP_DEFAULT: PanelLayout = { size: SIDEBAR_DEFAULT_SIZE, collapsed: false };
const MOBILE_DEFAULT: PanelLayout = { size: SIDEBAR_DEFAULT_SIZE, collapsed: true };

interface SidebarApi {
  closeMobile: () => void;
}

interface LayoutProps {
  header: ReactNode;
  sidebar: (api: SidebarApi) => ReactNode;
  main: ReactNode;
  chatSurface?: ReactNode;
}

function readSidebar(isMobile: boolean): PanelLayout {
  return getLayout(SIDEBAR_PANEL) ?? (isMobile ? MOBILE_DEFAULT : DESKTOP_DEFAULT);
}

export function AppLayout({ header, sidebar, main, chatSurface }: LayoutProps): ReactElement {
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const [layout, setLayoutState] = useState<PanelLayout>(() => readSidebar(isMobile));

  useEffect(() => {
    setLayoutState(readSidebar(isMobile));
    return subscribe(() => {
      setLayoutState(readSidebar(isMobile));
    });
  }, [isMobile]);

  const update = useCallback((next: PanelLayout) => {
    setLayoutState(next);
    setLayout(SIDEBAR_PANEL, next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    update({ size: layout.size, collapsed: !layout.collapsed });
  }, [layout, update]);

  const handleResize = useCallback((delta: number) => {
    const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, layout.size + delta));
    if (next === layout.size) return;
    update({ size: next, collapsed: layout.collapsed });
  }, [layout, update]);

  const closeMobile = useCallback(() => {
    if (isMobile) update({ size: layout.size, collapsed: true });
  }, [isMobile, layout, update]);

  const sidebarNode = sidebar({ closeMobile });
  const collapsed = layout.collapsed;
  const sheetOpen = isMobile && !collapsed;

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <div className="flex-shrink-0 h-12 border-b border-border flex items-center relative z-50 bg-bg">
        <button
          onClick={toggleCollapsed}
          className="w-12 h-12 flex items-center justify-center text-fg-subtle hover:text-fg transition-colors flex-shrink-0"
          aria-label={collapsed ? "Open sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">{header}</div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {isMobile ? (
          <Sheet open={sheetOpen} onClose={closeMobile} side="left">
            <div className="h-full overflow-y-auto">{sidebarNode}</div>
          </Sheet>
        ) : collapsed ? (
          <aside
            className="flex-shrink-0 border-r border-border bg-bg-soft overflow-hidden flex flex-col items-center"
            style={{ width: SIDEBAR_COLLAPSED_W }}
            aria-label="Sidebar (collapsed)"
          >
            <button
              type="button"
              onClick={toggleCollapsed}
              className="w-full h-10 flex items-center justify-center text-fg-subtle hover:text-fg transition-colors"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <span
              className="mt-2 text-[10px] uppercase tracking-widest text-fg-subtle select-none"
              style={{ writingMode: "vertical-rl" }}
            >
              Sidebar
            </span>
          </aside>
        ) : (
          <aside
            className="flex-shrink-0 border-r border-border bg-bg-soft flex min-h-0"
            style={{ width: layout.size }}
          >
            <div className="flex-1 min-w-0 overflow-y-auto relative">
              <div className="flex items-center justify-end px-1 pt-1">
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  className="p-1 text-fg-subtle hover:text-fg transition-colors rounded"
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              </div>
              {sidebarNode}
            </div>
            <ResizeHandle onDrag={handleResize} />
          </aside>
        )}

        <main className="flex-1 min-w-0 overflow-hidden flex flex-row min-h-0">
          <div className="flex-1 min-w-0 overflow-y-auto">{main}</div>
          {chatSurface}
        </main>
      </div>
    </div>
  );
}
