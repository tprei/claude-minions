import { forwardRef, useEffect, useMemo, useRef } from "react";
import type { Session, SessionMode, SessionStatus } from "@minions/shared";
import { useSessionStore } from "../store/sessionStore.js";
import { useConnectionStore } from "../connections/store.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";

const MAX_SESSIONS = 30;
const TITLE_MAX = 18;

const STATUS_DOT: Record<SessionStatus, string> = {
  pending: "bg-fg-subtle",
  running: "bg-ok animate-pulse",
  waiting_input: "bg-warn animate-pulse",
  completed: "bg-accent",
  failed: "bg-err",
  cancelled: "bg-fg-subtle/60",
};

const MODE_COLOR: Record<SessionMode, string> = {
  task: "bg-accent-muted text-accent",
  "dag-task": "bg-accent-muted text-accent",
  plan: "bg-accent-muted text-accent",
  think: "bg-accent-muted text-accent",
  review: "bg-bg-elev text-fg-muted",
  ship: "bg-bg-elev text-fg-muted",
  "rebase-resolver": "bg-bg-elev text-fg-muted",
  loop: "bg-bg-elev text-fg-muted",
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

interface Props {
  activeSlug: string;
  onClose?: () => void;
}

export function SessionNav({ activeSlug, onClose }: Props) {
  const sessionsMap = useSessionStore((s) => s.sessions);
  const activeId = useConnectionStore((s) => s.activeId);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const sessions = useMemo(() => {
    return Array.from(sessionsMap.values())
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, MAX_SESSIONS);
  }, [sessionsMap]);

  useEffect(() => {
    if (!activeRef.current) return;
    activeRef.current.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
  }, [activeSlug]);

  const navigate = (slug: string) => {
    if (!activeId) return;
    const { view, query } = parseUrl();
    setUrlState({ connectionId: activeId, view, sessionSlug: slug, query });
  };

  return (
    <div className="flex items-start gap-2 border-b border-border bg-bg-soft px-2 py-1.5">
      <div className="flex flex-nowrap gap-1.5 overflow-x-auto snap-x snap-mandatory min-w-0 flex-1">
        {sessions.map((s) => (
          <SessionPill
            key={s.slug}
            session={s}
            active={s.slug === activeSlug}
            onClick={() => navigate(s.slug)}
            ref={s.slug === activeSlug ? activeRef : undefined}
          />
        ))}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-fg-subtle hover:text-fg-muted text-lg leading-none px-1.5 py-0.5 rounded hover:bg-bg-elev"
          title="Close (press ?)"
          aria-label="Close chat"
        >
          ×
        </button>
      )}
    </div>
  );
}

interface PillProps {
  session: Session;
  active: boolean;
  onClick: () => void;
}

const SessionPill = forwardRef<HTMLButtonElement, PillProps>(function SessionPill(
  { session, active, onClick },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cx(
        "snap-start shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-colors",
        active
          ? "bg-accent/20 text-fg border-accent/40"
          : "bg-bg-soft text-fg-muted hover:text-fg border-border",
      )}
      aria-current={active ? "true" : undefined}
      title={session.title}
    >
      <span className={cx("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[session.status])} />
      <span className={cx("pill text-[10px] px-1.5 py-0 shrink-0", MODE_COLOR[session.mode])}>
        {session.mode}
      </span>
      <span
        className={cx(
          "leading-tight text-left",
          active ? "max-w-[10rem] sm:max-w-[14rem] sm:truncate line-clamp-2" : "truncate max-w-[8rem]",
        )}
      >
        {active ? session.title : truncate(session.title, TITLE_MAX)}
      </span>
      <span className="text-[10px] text-fg-subtle shrink-0">{relTime(session.updatedAt)}</span>
    </button>
  );
});
