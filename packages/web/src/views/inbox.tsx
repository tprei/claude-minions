import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { AttentionFlag, AttentionInboxItem, Session } from "@minions/shared";
import { useConnectionStore } from "../connections/store.js";
import { useSessionStore, EMPTY_SESSIONS } from "../store/sessionStore.js";
import { getAttentionItems, dismissAttention } from "../transport/rest.js";
import { setUrlState } from "../routing/urlState.js";
import { relTime } from "../util/time.js";
import { Button } from "../components/Button.js";

interface ApiClient {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  patch: (path: string, body: unknown) => Promise<unknown>;
  del: (path: string) => Promise<unknown>;
}

interface Props {
  api: ApiClient;
}

const GROUP_ORDER: AttentionFlag["kind"][] = [
  "needs_input",
  "ci_failed",
  "ci_self_heal_exhausted",
  "rebase_conflict",
  "budget_exceeded",
  "judge_review",
  "manual_intervention",
  "quota_exhausted",
  "ci_pending",
  "ci_passed",
];

const GROUP_LABEL: Record<AttentionFlag["kind"], string> = {
  needs_input: "Needs input",
  ci_failed: "CI failed",
  ci_self_heal_exhausted: "CI self-heal exhausted",
  rebase_conflict: "Rebase conflict",
  budget_exceeded: "Budget exceeded",
  judge_review: "Judge review",
  manual_intervention: "Manual intervention",
  quota_exhausted: "Quota exhausted",
  ci_pending: "CI pending",
  ci_passed: "CI passed",
};

function itemKey(item: AttentionInboxItem): string {
  return `${item.sessionSlug}/${item.attention.kind}`;
}

function deriveItems(sessions: Map<string, Session>): AttentionInboxItem[] {
  const out: AttentionInboxItem[] = [];
  for (const s of sessions.values()) {
    for (const flag of s.attention) {
      out.push({
        sessionSlug: s.slug,
        sessionTitle: s.title,
        mode: s.mode,
        status: s.status,
        attention: flag,
      });
    }
  }
  return out;
}

export function InboxView(_props: Props): ReactElement {
  const activeId = useConnectionStore((s) => s.activeId);
  const conn = useConnectionStore((s) =>
    activeId ? s.connections.find((c) => c.id === activeId) ?? null : null,
  );
  const sessionsMap = useSessionStore((s) =>
    activeId ? s.byConnection.get(activeId)?.sessions ?? EMPTY_SESSIONS : EMPTY_SESSIONS,
  );

  const [seed, setSeed] = useState<AttentionInboxItem[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conn) return;
    let cancelled = false;
    void (async () => {
      try {
        const env = await getAttentionItems(conn);
        if (!cancelled) setSeed(env.items);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load inbox");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn]);

  const items = useMemo(() => {
    const base = sessionsMap.size > 0 ? deriveItems(sessionsMap) : seed ?? [];
    return base.filter((i) => !dismissed.has(itemKey(i)));
  }, [sessionsMap, seed, dismissed]);

  const groups = useMemo(() => {
    const map = new Map<AttentionFlag["kind"], AttentionInboxItem[]>();
    for (const i of items) {
      const arr = map.get(i.attention.kind);
      if (arr) arr.push(i);
      else map.set(i.attention.kind, [i]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => b.attention.raisedAt.localeCompare(a.attention.raisedAt));
    }
    return GROUP_ORDER.flatMap((kind) => {
      const arr = map.get(kind);
      return arr ? [{ kind, items: arr }] : [];
    });
  }, [items]);

  const navigate = useCallback(
    (slug: string) => {
      if (!activeId) return;
      setUrlState({ connectionId: activeId, view: "list", sessionSlug: slug });
    },
    [activeId],
  );

  const onDismiss = useCallback(
    async (item: AttentionInboxItem) => {
      if (!conn) return;
      const k = itemKey(item);
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(k);
        return next;
      });
      try {
        await dismissAttention(conn, item.sessionSlug, item.attention.kind);
      } catch (err) {
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
        setError(err instanceof Error ? err.message : "Failed to dismiss");
      }
    },
    [conn],
  );

  return (
    <div className="h-full overflow-y-auto" data-testid="inbox-view">
      <div className="p-4 flex flex-col gap-4">
        <h1 className="text-lg font-semibold text-fg">Inbox</h1>
        {error && (
          <div className="card p-3 text-xs text-err border border-err/30 bg-err/10" role="alert">
            {error}
          </div>
        )}
        {groups.length === 0 ? (
          <div className="flex items-center justify-center text-sm text-fg-subtle py-16">
            Nothing needs your attention.
          </div>
        ) : (
          groups.map((group) => (
            <section
              key={group.kind}
              className="flex flex-col gap-2"
              data-testid={`inbox-group-${group.kind}`}
            >
              <h2 className="text-xs uppercase tracking-wider text-fg-subtle">
                {GROUP_LABEL[group.kind]}
              </h2>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <li
                    key={itemKey(item)}
                    className="card p-3 flex items-center gap-3"
                    data-testid={`inbox-row-${item.sessionSlug}-${item.attention.kind}`}
                  >
                    <button
                      type="button"
                      onClick={() => navigate(item.sessionSlug)}
                      className="text-sm text-fg hover:text-accent text-left truncate min-w-0 max-w-[16rem]"
                      data-testid={`inbox-title-${item.sessionSlug}-${item.attention.kind}`}
                    >
                      {item.sessionTitle}
                    </button>
                    <span className="text-xs text-fg-muted truncate flex-1 min-w-0">
                      {item.attention.message}
                    </span>
                    <span className="text-[11px] text-fg-subtle whitespace-nowrap">
                      {relTime(item.attention.raisedAt)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void onDismiss(item)}
                      data-testid={`inbox-dismiss-${item.sessionSlug}-${item.attention.kind}`}
                    >
                      Dismiss
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
