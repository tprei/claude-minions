import type { RepoBinding } from "@minions/shared";
import { useConnectionStore } from "../connections/store.js";
import { useVersionStore } from "../store/version.js";
import { cx } from "../util/classnames.js";

interface Props {
  filterRepo: string | null;
  onFilterRepo: (repoId: string | null) => void;
}

export function RepoTabs({ filterRepo, onFilterRepo }: Props) {
  const activeId = useConnectionStore((s) => s.activeId);
  const repos = useVersionStore((s) => (activeId ? s.byConnection.get(activeId)?.repos : undefined));

  if (!repos || repos.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Repository"
      className="flex flex-wrap gap-1 px-4 py-2 border-b border-border bg-bg"
    >
      <TabButton active={filterRepo === null} onClick={() => onFilterRepo(null)}>
        All
      </TabButton>
      {repos.map((r: RepoBinding) => (
        <TabButton
          key={r.id}
          active={filterRepo === r.id}
          onClick={() => onFilterRepo(r.id)}
        >
          {r.label}
        </TabButton>
      ))}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        "pill text-xs cursor-pointer border",
        active
          ? "bg-accent text-white border-accent"
          : "bg-bg-elev text-fg-muted border-border hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
