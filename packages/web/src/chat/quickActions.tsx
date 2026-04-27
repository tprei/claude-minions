import type { Session } from "@minions/shared";
import { useRootStore } from "../store/root.js";
import { postCommand } from "../transport/rest.js";
import { cx } from "../util/classnames.js";

interface Props {
  session: Session;
}

export function QuickActions({ session }: Props) {
  const conn = useRootStore((s) => s.getActiveConnection());

  if (session.quickActions.length === 0) return null;

  const handleAction = async (command: string) => {
    if (!conn) return;
    await postCommand(conn, { kind: command as "reply", sessionSlug: session.slug } as Parameters<typeof postCommand>[1]);
  };

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-1.5">
      {session.quickActions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => handleAction(action.command)}
          className={cx("pill bg-bg-elev hover:bg-bg-elev text-fg-muted text-xs cursor-pointer border border-border transition-colors")}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
