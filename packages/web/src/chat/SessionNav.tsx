import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Session, SessionMode, SessionStatus } from "@minions/shared";
import { useSessionStore, EMPTY_SESSIONS } from "../store/sessionStore.js";
import { useConnectionStore } from "../connections/store.js";
import { useRootStore } from "../store/root.js";
import { postCommand } from "../transport/rest.js";
import { setUrlState } from "../routing/urlState.js";
import { parseUrl } from "../routing/parseUrl.js";
import { relTime } from "../util/time.js";
import { cx } from "../util/classnames.js";
import { CancelSessionDialog } from "./cancelSession.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";

const CANCELLABLE_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "pending",
  "running",
  "waiting_input",
]);

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
  "verify-child": "bg-bg-elev text-fg-muted",
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
  const activeId = useConnectionStore((s) => s.activeId);
  const sessionsMap = useSessionStore(
    (s) => (activeId ? s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS : EMPTY_SESSIONS),
  );
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
  const conn = useRootStore((s) => s.getActiveConnection());
  const [cancelOpen, setCancelOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  const isCancellable = CANCELLABLE_STATUSES.has(session.status);
  const canCancel = !!conn && isCancellable;
  const canCloseTerminal = !!conn && !isCancellable && !!session.worktreePath;
  const showClose = canCancel || canCloseTerminal;

  const handleCloseClick = (e: ReactMouseEvent | ReactKeyboardEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    if (canCancel) setCancelOpen(true);
    else if (canCloseTerminal) setCloseOpen(true);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={cx(
          "group relative snap-start shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-colors",
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
        {showClose && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Close session"
            onClick={handleCloseClick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") handleCloseClick(e);
            }}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity absolute top-0.5 right-0.5 inline-flex items-center justify-center w-3.5 h-3.5 rounded text-[11px] leading-none text-fg-subtle hover:text-fg hover:bg-bg-elev"
          >
            ×
          </span>
        )}
      </button>
      {conn && canCancel && (
        <CancelSessionDialog
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          sessions={[{ slug: session.slug, title: session.title }]}
          conn={conn}
        />
      )}
      {conn && canCloseTerminal && (
        <ConfirmDialog
          open={closeOpen}
          onClose={() => setCloseOpen(false)}
          onConfirm={async () => {
            await postCommand(conn, {
              kind: "close",
              sessionSlug: session.slug,
              removeWorktree: true,
            });
          }}
          title="Close session"
          body={`Remove the worktree for ${session.title} on disk? Transcript and history are preserved.`}
          confirmLabel="Close session"
          variant="danger"
        />
      )}
    </>
  );
});
