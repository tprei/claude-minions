import { setUrlState } from "../routing/urlState.js";
import { parseUrl, type ViewKind } from "../routing/parseUrl.js";
import { sseStatusStore } from "../transport/sseStatus.js";

export interface PaletteAction {
  id: string;
  label: string;
  group?: string;
  hint?: string;
  run: () => void;
}

export interface PaletteSessionRef {
  slug: string;
  title: string;
  status: string;
}

export interface BuildActionsOptions {
  activeId: string | null;
  openMemory: () => void;
  openRuntime: () => void;
  openLoops: () => void;
  openAudit: () => void;
  sessions: Iterable<PaletteSessionRef>;
}

const SESSION_LIMIT = 30;

function navigateTo(activeId: string | null, view: ViewKind): void {
  if (!activeId) return;
  setUrlState({ connectionId: activeId, view, sessionSlug: null });
}

export function buildActions(opts: BuildActionsOptions): PaletteAction[] {
  const { activeId, openMemory, openRuntime, openLoops, openAudit, sessions } = opts;
  const actions: PaletteAction[] = [];

  actions.push(
    { id: "nav:list", label: "Go to List", group: "Navigate", hint: "List view", run: () => navigateTo(activeId, "list") },
    { id: "nav:kanban", label: "Go to Kanban", group: "Navigate", hint: "Kanban view", run: () => navigateTo(activeId, "kanban") },
    { id: "nav:dag", label: "Go to DAG", group: "Navigate", hint: "DAG view", run: () => navigateTo(activeId, "dag") },
    { id: "nav:ship", label: "Go to Ship", group: "Navigate", hint: "Ship view", run: () => navigateTo(activeId, "ship") },
    { id: "nav:doctor", label: "Go to Doctor", group: "Navigate", hint: "Doctor view", run: () => navigateTo(activeId, "doctor") },
    { id: "nav:new", label: "New session", group: "Navigate", hint: "Start a new session", run: () => navigateTo(activeId, "new") },
  );

  actions.push(
    { id: "drawer:memory", label: "Open Memory drawer", group: "Drawers", run: openMemory },
    { id: "drawer:runtime", label: "Open Runtime drawer", group: "Drawers", run: openRuntime },
    { id: "drawer:loops", label: "Open Loops sheet", group: "Drawers", run: openLoops },
    { id: "drawer:audit", label: "Open Audit sheet", group: "Drawers", run: openAudit },
  );

  actions.push({
    id: "sys:reconnect",
    label: "Force reconnect SSE",
    group: "System",
    hint: "Reopen the live event stream",
    run: () => {
      if (!activeId) return;
      sseStatusStore.forceReconnect(activeId);
    },
  });

  let count = 0;
  for (const sess of sessions) {
    if (count >= SESSION_LIMIT) break;
    const slug = sess.slug;
    actions.push({
      id: `session:${slug}`,
      label: sess.title || slug,
      group: "Sessions",
      hint: sess.status,
      run: () => {
        if (!activeId) return;
        const { view } = parseUrl();
        setUrlState({ connectionId: activeId, view, sessionSlug: slug });
      },
    });
    count++;
  }

  return actions;
}
