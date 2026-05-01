import type { ReactElement } from "react";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";

interface Props {
  activeId: string;
}

export function MobileNewSessionFab({ activeId }: Props): ReactElement {
  function openNew(): void {
    const { sessionSlug, query } = parseUrl();
    setUrlState({ connectionId: activeId, view: "new", sessionSlug, query });
  }
  return (
    <div
      className="sm:hidden fixed bottom-4 right-4 z-40"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <button
        type="button"
        data-testid="mobile-new-session-fab"
        onClick={openNew}
        aria-label="New session"
        title="New session"
        className="w-14 h-14 rounded-full bg-accent text-white shadow-2xl hover:bg-accent-soft transition-colors flex items-center justify-center"
      >
        <span className="text-2xl leading-none">+</span>
      </button>
    </div>
  );
}
