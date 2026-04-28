export type ViewKind = "list" | "kanban" | "dag" | "ship" | "memory" | "loops" | "new";

export interface ParsedUrl {
  connectionId: string | null;
  view: ViewKind;
  sessionSlug: string | undefined;
  query: Record<string, string>;
}

const VALID_VIEWS = new Set<ViewKind>(["list", "kanban", "dag", "ship", "memory", "loops", "new"]);

function isViewKind(v: string): v is ViewKind {
  return VALID_VIEWS.has(v as ViewKind);
}

export function parseUrl(): ParsedUrl {
  const { pathname, search } = globalThis.location;
  const params = new URLSearchParams(search);
  const query: Record<string, string> = {};
  params.forEach((v, k) => { query[k] = v; });

  const segments = pathname.replace(/^\//, "").split("/").filter(Boolean);

  if (segments[0] === "c" && segments[1]) {
    const connectionId = segments[1];
    const rawView = segments[2] ?? "list";
    const view: ViewKind = isViewKind(rawView) ? rawView : "list";
    const sessionSlug = segments[3] ?? undefined;
    return { connectionId, view, sessionSlug, query };
  }

  return { connectionId: null, view: "list", sessionSlug: undefined, query };
}
