import { useState, type ReactElement, type ReactNode } from "react";
import { cx } from "../util/classnames.js";

interface LayoutProps {
  header: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
  chatSurface?: ReactNode;
}

export function AppLayout({ header, sidebar, main, chatSurface }: LayoutProps): ReactElement {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <div className="flex-shrink-0 h-12 border-b border-border flex items-center">
        <button
          onClick={() => setSidebarOpen(v => !v)}
          className="w-12 h-12 flex items-center justify-center text-zinc-500 hover:text-zinc-100 transition-colors flex-shrink-0"
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
        <aside
          className={cx(
            "flex-shrink-0 border-r border-border bg-bg-soft transition-all duration-200 overflow-hidden",
            sidebarOpen ? "w-56" : "w-0",
          )}
        >
          <div className="w-56 h-full overflow-y-auto">{sidebar}</div>
        </aside>

        <main className="flex-1 min-w-0 overflow-hidden flex flex-col md:flex-row">
          <div className="flex-1 min-w-0 overflow-y-auto">{main}</div>

          {chatSurface && (
            <>
              <div className="hidden md:block w-px bg-border flex-shrink-0" />
              <div className="hidden md:flex flex-col w-80 flex-shrink-0 overflow-hidden">
                {chatSurface}
              </div>
              <div className="md:hidden border-t border-border max-h-60 overflow-y-auto">
                {chatSurface}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
