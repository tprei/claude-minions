export type ViewKind = "list" | "dag" | "new";

export interface ParsedUrl {
  connectionId: string | null;
  view: ViewKind;
  sessionSlug: string | undefined;
  query: Record<string, string>;
}

const VALID_VIEWS = new Set<ViewKind>(["list", "dag", "new"]);

function isViewKind(v: string): v is ViewKind {
  return VALID_VIEWS.has(v as ViewKind);
}

function decodePathSegment(value: string): string {
  return decodeURIComponent(value);
}

export function parseUrl(): ParsedUrl {
  const { pathname, search } = globalThis.location;
  const params = new URLSearchParams(search);
  const query: Record<string, string> = {};
  params.forEach((v, k) => { query[k] = v; });

  const segments = pathname.replace(/^\//, "").split("/").filter(Boolean).map(decodePathSegment);

  if (segments[0] === "c" && segments[1]) {
    const connectionId = segments[1];
    const rawView = segments[2] ?? "list";
    const view: ViewKind = isViewKind(rawView) ? rawView : "list";
    const sessionSlug = segments[3] ?? undefined;
    return { connectionId, view, sessionSlug, query };
  }

  const rawView = segments[0] ?? "list";
  const view: ViewKind = isViewKind(rawView) ? rawView : "list";
  const sessionSlug = isViewKind(rawView) ? segments[1] : segments[0];
  return { connectionId: null, view, sessionSlug, query };
}
